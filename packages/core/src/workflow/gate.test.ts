import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { PLAN_HEADING } from "../task/store.js"
import { serializeTask } from "../task/schema.js"
import { abandonTask, approveAny, approvePlan, approveTask, oneLineReason, rejectAny, removeTask, replanTask, retaskTask, shipTask, type GateCtx, type GateResult } from "./gate.js"

/**
 * The shared gate moves, driven against a tiny in-memory backlog. A fake shell
 * models `cat`/`mv` over a file map (the id-based ops need only those); git
 * commands report "no branch/actor" so ship attempts no PR. The fake client's
 * directory listing is backed by the SAME map, so the no-id `resolveGateTask`
 * path — tier priority, the draft fallback, the epic skip and the candidate
 * payload — is exercised here too; the OpenCode driver tests cover it again
 * end-to-end through the host seam.
 */
const makeCtx = (
  files: Record<string, string>,
  opts: {
    driving?: string
    ignoreBacklog?: boolean
    git?: (cmd: string) => { exitCode: number; stdout: string } | undefined
    /** Make every `mv` fail — the read-only-FS / DrvFS-hiccup half of what moveTask throws on. */
    failMv?: boolean
  } = {},
) => {
  const fs: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) fs[`/repo/docs/tasks/${k}`] = v
  const log: string[] = []
  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += Array.isArray(exprs[i]) ? (exprs[i] as unknown[]).join(" ") : String(exprs[i])
    })
    const norm = cmd.trim().replace(/\s+/g, " ")
    log.push(norm)
    const parts = norm.split(" ")
    let out = { exitCode: 0, stdout: "" }
    if (parts[0] === "cat") out = parts[1]! in fs ? { exitCode: 0, stdout: fs[parts[1]!]! } : { exitCode: 1, stdout: "" }
    else if (parts[0] === "test") out = parts[2]! in fs ? { exitCode: 0, stdout: "" } : { exitCode: 1, stdout: "" }
    else if (parts[0] === "mv") {
      // `-n` is modelled, not skipped: production relies on it to make the kernel
      // arbitrate a concurrent create, so a fake that clobbered anyway would make
      // that race untestable.
      const noClobber = parts.includes("-n")
      const [src, dest] = parts.slice(1).filter((p) => !p.startsWith("-"))
      if (opts.failMv) out = { exitCode: 1, stdout: "" }
      else if (noClobber && dest! in fs) out = { exitCode: 0, stdout: "" } // successful no-op; source survives
      else if (src! in fs) {
        fs[dest!] = fs[src!]!
        delete fs[src!]
      } else out = { exitCode: 1, stdout: "" }
    } else if (parts[0] === "rm") {
      // rm [-f] <path…> — drop any listed paths (missing is fine under -f).
      for (const p of parts.slice(1)) if (p !== "-f" && p in fs) delete fs[p]
    } else if (parts[0] === "ls") {
      const dir = parts.slice(1).find((p) => !p.startsWith("-"))! // skip flags like `-1`
      const names = Object.keys(fs)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1))
      out = { exitCode: 0, stdout: names.join("\n") }
    } else if (parts[0] === "git") out = opts.git?.(norm) ?? { exitCode: 1, stdout: "" } // default: no actor, no branch → no PR
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode: out.exitCode, stdout: { toString: () => out.stdout }, stderr: { toString: () => "" } }).then(resolve),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  // Directory listing over the same map `$` mutates, so a task moved by an
  // earlier gate op is immediately absent from the folder it left — which is
  // what makes "the slice just approved is not its own successor" testable.
  const listDir = (dir: string) =>
    Object.keys(fs)
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
      .map((p) => ({ type: "file", name: p.slice(dir.length + 1), path: p, absolute: p }))
  const ctx: GateCtx = {
    $,
    client: {
      file: {
        list: async ({ query }: { query: { path: string; directory: string } }) => ({ data: listDir(`${query.directory}/${query.path}`) }),
        read: async ({ query }: { query: { path: string } }) => ({ data: query.path in fs ? { content: fs[query.path] } : null }),
      },
      app: { log: async () => undefined },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    log: () => {},
    directory: "/repo",
    config: opts.ignoreBacklog === undefined ? DEFAULT_CONFIG : { ...DEFAULT_CONFIG, ignoreBacklog: opts.ignoreBacklog },
    isDriving: (id) => id === opts.driving,
  }
  return { ctx, fs, log }
}

const task = (title: string, body = "context") => serializeTask({ title, body })

// --- retaskTask: place a planless task where the authoring interview can reshape it ---

test("retaskTask on a draft is an idempotent no-op — it is already in place", async () => {
  const { ctx, fs, log } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.alreadyDone === true)
  assert.ok("/repo/docs/tasks/draft/t.md" in fs)
  assert.ok(!log.some((c) => c.startsWith("mv ")), "nothing to move")
})

test("retaskTask sends an approved queued task back to draft, audited and committed", async () => {
  const { ctx, fs, log } = makeCtx({ "queued/t.md": task("Do it") })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.retask === true && r.data.alreadyDone === undefined)
  assert.match(r.message, /draft/)
  assert.ok("/repo/docs/tasks/draft/t.md" in fs, "the file lands in draft/")
  assert.ok(!("/repo/docs/tasks/queued/t.md" in fs), "and leaves queued/")
  // The audit note records WHY it went back; the commit itself is out of reach
  // here (the harness's git stub reports no actor), same as approveTask's test.
  assert.ok(log.some((c) => c.includes("approval withdrawn")), "an audit note is appended")
})

test("retaskTask refuses a parked plan and names replan", async () => {
  const { ctx, fs, log } = makeCtx({ "plan-review/t.md": task("Planned", `${PLAN_HEADING}\n\n1. Step.`) })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /replan/)
  assert.ok("/repo/docs/tasks/plan-review/t.md" in fs, "untouched")
  assert.ok(!log.some((c) => c.startsWith("mv ")))
})

test("retaskTask refuses an in-progress task — its plan is already being built", async () => {
  const { ctx, fs } = makeCtx({ "in-progress/t.md": task("Building", `${PLAN_HEADING}\n\n1. Step.`) })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /replan/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in fs)
})

test("retaskTask refuses a task a live loop is driving", async () => {
  const { ctx, fs } = makeCtx({ "queued/t.md": task("Do it") }, { driving: "t" })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /live loop/)
  assert.ok("/repo/docs/tasks/queued/t.md" in fs, "never yanked out from under a running PLAN")
})

test("retaskTask reports a missing id rather than inventing one", async () => {
  const { ctx } = makeCtx({})
  const r = await retaskTask(ctx, "nope")
  assert.equal(r.ok, false)
})

test("retaskTask records the reason on its audit note", async () => {
  // The task file is the only place the next authoring pass looks for WHY the
  // goal was wrong — same contract as replan's reason.
  const { ctx, log } = makeCtx({ "queued/t.md": task("Do it") })
  const r = await retaskTask(ctx, "t", "acceptance described the wrong screen")
  assert.equal(r.ok, true)
  assert.ok(
    log.some((c) => c.includes("approval withdrawn — acceptance described the wrong screen")),
    "the reason is appended to the note",
  )
})

test("retaskTask with a reason still writes nothing for a draft", async () => {
  // The draft branch is an idempotent no-op; a reason must not turn it into a write.
  const { ctx, log } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await retaskTask(ctx, "t", "why")
  assert.equal(r.ok, true)
  assert.ok(!log.some((c) => c.startsWith("mv ")), "nothing moved")
  assert.ok(!log.some((c) => c.includes("approval withdrawn")), "and no note appended")
})

// --- removeTask: hard-delete a task from the backlog entirely ---

test("removeTask deletes a draft outright — the file is gone, not moved", async () => {
  const { ctx, fs, log } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await removeTask(ctx, "t", true)
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.removed === true && r.data.from === "draft")
  assert.ok(!("/repo/docs/tasks/draft/t.md" in fs), "the file is removed")
  assert.ok(!Object.keys(fs).some((p) => p.includes("/t.md")), "and NOT relocated to another folder")
  assert.ok(log.some((c) => c.startsWith("rm ")), "the delete goes through rm")
})

test("removeTask works from any folder — a finished in-review task deletes too", async () => {
  const { ctx, fs } = makeCtx({ "in-review/t.md": task("Built", `${PLAN_HEADING}\n\n1. Step.`) })
  const r = await removeTask(ctx, "t", true)
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.from === "in-review")
  assert.ok(!("/repo/docs/tasks/in-review/t.md" in fs))
})

test("removeTask refuses a task a live loop is driving — the file survives", async () => {
  const { ctx, fs } = makeCtx({ "in-progress/t.md": task("Building", `${PLAN_HEADING}\n\n1. Step.`) }, { driving: "t" })
  const r = await removeTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /live loop/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in fs, "never deleted out from under a running loop")
})

test("removeTask refuses a claim-held task and names doctor fix", async () => {
  const { ctx, fs } = makeCtx({ "in-progress/t.md": task("Claimed"), "in-progress/.claims/t": "" })
  const r = await removeTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /claim marker/)
  assert.match(r.message, /doctor fix/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in fs, "untouched while a claim is held")
})

test("removeTask on a missing id is an idempotent success (rm -f semantics)", async () => {
  const { ctx } = makeCtx({})
  const r = await removeTask(ctx, "gone")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.alreadyDone === true)
})

test("removeTask without force deletes NOTHING and reports what it would delete", async () => {
  // The CLI hosts have no confirmation step of their own — Claude blocks the turn
  // before the model runs, opencode deletes inside the command hook — so the
  // dry run IS the confirmation.
  const { ctx, fs, log } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await removeTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /--force/, "names the way to confirm")
  assert.match(r.message, /Do it/, "names the task it resolved, so a typo'd handle is visible")
  assert.ok("/repo/docs/tasks/draft/t.md" in fs, "the file survives a bare remove")
  assert.ok(!log.some((c) => c.startsWith("rm ")), "and no delete was attempted")
})

test("removeTask's dry run leads with the real recovery story for this config", async () => {
  // ignoreBacklog defaults to TRUE, so "git history keeps it" is false for most
  // installs — the copy must not reassure a user whose backlog is untracked.
  const untracked = makeCtx({ "draft/t.md": task("Do it") }, { ignoreBacklog: true })
  assert.match((await removeTask(untracked.ctx, "t")).message, /CANNOT be undone/)
  const tracked = makeCtx({ "draft/t.md": task("Do it") }, { ignoreBacklog: false })
  assert.match((await removeTask(tracked.ctx, "t")).message, /git history/)
})

test("removeTask runs its guards before the confirm — a claim-held task is refused, not offered", async () => {
  const { ctx } = makeCtx({ "in-progress/t.md": task("Claimed"), "in-progress/.claims/t": "" })
  const r = await removeTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /claim marker/)
  assert.ok(!/--force/.test(r.message), "never invites a force that would still be refused")
})

// --- abandonTask: the reversible cancellation `abandoned/` always modelled ---

test("abandonTask moves a task to abandoned/ instead of deleting it", async () => {
  const { ctx, fs } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await abandonTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.abandoned === true && r.data.from === "draft")
  assert.ok(!("/repo/docs/tasks/draft/t.md" in fs), "left its old folder")
  assert.ok("/repo/docs/tasks/abandoned/t.md" in fs, "and the file still exists")
})

test("abandonTask works from every non-terminal folder", async () => {
  for (const from of ["draft", "queued", "plan-review", "in-progress", "in-review"]) {
    const { ctx, fs } = makeCtx({ [`${from}/t.md`]: task("Do it", `${PLAN_HEADING}\n\n1. Step.`) })
    const r = await abandonTask(ctx, "t")
    assert.equal(r.ok, true, `${from} → abandoned`)
    assert.ok(`/repo/docs/tasks/abandoned/t.md` in fs, `${from} landed in abandoned/`)
  }
})

test("abandonTask refuses a completed task — shipped work isn't cancellable", async () => {
  const { ctx, fs } = makeCtx({ "completed/t.md": task("Shipped") })
  const r = await abandonTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /completed/)
  assert.ok("/repo/docs/tasks/completed/t.md" in fs)
})

test("abandonTask is idempotent on an already-abandoned task", async () => {
  const { ctx } = makeCtx({ "abandoned/t.md": task("Gone") })
  const r = await abandonTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.alreadyDone === true)
})

test("abandonTask carries the same live-loop and claim guards remove has", async () => {
  const driving = makeCtx({ "in-progress/t.md": task("Building") }, { driving: "t" })
  const a = await abandonTask(driving.ctx, "t")
  assert.equal(a.ok, false)
  assert.match(a.message, /live loop/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in driving.fs)

  const claimed = makeCtx({ "in-progress/t.md": task("Claimed"), "in-progress/.claims/t": "" })
  const b = await abandonTask(claimed.ctx, "t")
  assert.equal(b.ok, false)
  assert.match(b.message, /claim marker/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in claimed.fs)
})

test("abandonTask records the reason on the audit note", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": task("Do it") })
  const r = await abandonTask(ctx, "t", "superseded by the new epic")
  assert.equal(r.ok, true)
  assert.ok(log.some((c) => c.includes("superseded by the new epic")))
})

test("replanTask refuses a claim-held task — isDriving is per-process and misses other hosts", async () => {
  // A replan from the hub or the Claude MCP server while an opencode loop is
  // mid-BUILD used to sail past isDriving and release that run's marker.
  const { ctx, fs } = makeCtx({ "in-progress/t.md": task("Building", `${PLAN_HEADING}\n\n1. Step.`), "in-progress/.claims/t": "" })
  const r = await replanTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /claim marker/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in fs, "the live run keeps its task")
})

test("approveTask moves a draft to queued and returns a structured result", async () => {
  const { ctx, log } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await approveTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.approved === true)
  assert.match(r.message, /queued/)
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("queued")))
})

test("approveTask on an already-queued task is an idempotent success", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": task("Do it") })
  const r = await approveTask(ctx, "t")
  assert.ok(r.ok && r.data.alreadyDone === true)
  assert.ok(!log.some((c) => c.startsWith("mv ")), "no move on a retry")
})

test("approveTask on a missing task fails", async () => {
  const { ctx } = makeCtx({})
  const r = await approveTask(ctx, "nope")
  assert.equal(r.ok, false)
})

test("approveTask refuses a tracking epic — it stays in draft/, untouched", async () => {
  const { ctx, fs, log } = makeCtx({ "draft/epic.md": serializeTask({ title: "Big feature", type: "epic", body: "children in order…" }) })
  const r = await approveTask(ctx, "epic")
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.variant === "warning")
  assert.match(r.message, /tracking epic/)
  assert.ok("/repo/docs/tasks/draft/epic.md" in fs, "the epic must stay in draft/")
  assert.ok(!log.some((c) => c.startsWith("mv ") || c.startsWith("printf")), "no move, no audit note on a refusal")
})

test("approveAny with an explicit epic id still reaches the tracking-epic refusal", async () => {
  // The epic skip is scoped to id-less resolution: naming an epic outright must
  // reach approveTask and get its specific refusal, not a generic "not found".
  const { ctx, fs } = makeCtx({ "draft/epic.md": serializeTask({ title: "Big feature", type: "epic", body: "children…" }) })
  const r = await approveAny(ctx, "epic")
  assert.equal(r.ok, false)
  assert.match(r.message, /tracking epic/)
  assert.ok("/repo/docs/tasks/draft/epic.md" in fs, "the epic must stay in draft/")
})

// --- The id-less ambiguity: a choice the host can offer, not a dead end ---

/** A slice set: N children carrying `epic`, plus the tracking epic itself. */
const sliceSet = (epicId: string, children: { id: string; title: string; priority: number }[], status = "draft") =>
  Object.fromEntries([
    ...children.map((c) => [`${status}/${c.id}.md`, serializeTask({ title: c.title, epic: epicId, priority: c.priority, body: `Part of epic: ${epicId}` })]),
    [`${status}/${epicId}.md`, serializeTask({ title: "The whole feature", type: "epic", body: "children in order…" })],
  ])

/**
 * The refusal a slice set produces is what used to dead-end the human: the
 * message is right, but with nothing machine-readable on it a host can only
 * reprint it. `candidates` is what lets the hosts ask WHICH — and the invariant
 * the hosts' continue-the-turn arms rest on is that this refusal MOVED NOTHING.
 */
test("an ambiguous id-less approve reports its candidates, in approval order, having moved nothing", async () => {
  const { ctx, fs, log } = makeCtx(
    sliceSet("k2p9-epic", [
      { id: "c3d4-ui", title: "Wire the UI", priority: 1 },
      { id: "a1b2-api", title: "Add the API layer", priority: 0 },
    ]),
  )
  const r = await approveAny(ctx, "")
  assert.equal(r.ok, false)
  assert.match(r.message, /Multiple tasks awaiting/, "the human-facing sentence is unchanged")
  const candidates = (!r.ok && r.data?.candidates) as { id: string; title: string; from: string; priority: number; epic?: string }[]
  assert.ok(!r.ok && r.data?.ambiguous === true && r.data?.verb === "approve")
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["a1b2-api", "c3d4-ui"],
    "lowest priority first — the order a stacked set must be approved in, not readdir order",
  )
  assert.deepEqual(candidates[0], { id: "a1b2-api", from: "draft", title: "Add the API layer", priority: 0, epic: "k2p9-epic" })
  assert.ok(!r.ok && r.data?.gate === undefined, "no gate was crossed, so no `gate` key may claim one")
  // The whole basis for continuing the turn on this one refusal.
  assert.ok(!log.some((c) => c.startsWith("mv ") || c.startsWith("printf")), "an ambiguity must not move or annotate anything")
  assert.ok("/repo/docs/tasks/draft/a1b2-api.md" in fs && "/repo/docs/tasks/draft/c3d4-ui.md" in fs)
})

test("the tracking epic is not a candidate, so a two-child set is ambiguous rather than three-way", async () => {
  const { ctx } = makeCtx(
    sliceSet("k2p9-epic", [
      { id: "a1b2-api", title: "Add the API layer", priority: 0 },
      { id: "c3d4-ui", title: "Wire the UI", priority: 1 },
    ]),
  )
  const r = await approveAny(ctx, "")
  const ids = ((!r.ok && r.data?.candidates) as { id: string }[]).map((c) => c.id)
  assert.deepEqual(ids, ["a1b2-api", "c3d4-ui"])
})

test("a lone draft still resolves outright — one candidate is not an ambiguity", async () => {
  const { ctx } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await approveAny(ctx, "")
  assert.ok(r.ok && r.data.gate === "task" && r.data.id === "t")
  assert.equal(r.data.candidates, undefined)
})

// --- The slice walk: what a task gate leaves behind ---

/**
 * `siblings` is what lets a task gate's follow-up name the next slice, so the
 * human can walk a set without typing an id per child. It is computed AFTER the
 * move, which is what keeps the just-approved slice out of its own successor
 * list, and it is scoped by `epic` — never "every draft on the board", because
 * naming a stranger's draft as the next slice would be a guess.
 */
test("a task gate on a slice reports the remaining slices, in order, excluding itself and the epic", async () => {
  const { ctx } = makeCtx(
    sliceSet("k2p9-epic", [
      { id: "a1b2-api", title: "Add the API layer", priority: 0 },
      { id: "c3d4-ui", title: "Wire the UI", priority: 1 },
      { id: "e5f6-docs", title: "Document it", priority: 2 },
    ]),
  )
  const r = await approveTask(ctx, "a1b2-api")
  assert.ok(r.ok && r.data.epic === "k2p9-epic")
  const siblings = r.ok ? (r.data.siblings as { id: string; title: string }[]) : []
  assert.deepEqual(
    siblings.map((s) => s.id),
    ["c3d4-ui", "e5f6-docs"],
  )
  assert.equal(siblings[0]?.title, "Wire the UI", "the title is what makes the next question answerable")
})

test("a standalone task carries no epic and no siblings — the follow-up renders exactly as it always did", async () => {
  const { ctx } = makeCtx({ "draft/t.md": task("Do it"), "draft/other.md": task("Unrelated work") })
  const r = await approveTask(ctx, "t")
  assert.ok(r.ok && r.data.gate === "task")
  assert.equal(r.data.epic, undefined)
  assert.equal(r.data.siblings, undefined, "an unrelated draft is not a slice of anything")
})

test("the last slice of a set reports its epic but no siblings", async () => {
  const { ctx } = makeCtx(sliceSet("k2p9-epic", [{ id: "a1b2-api", title: "Add the API layer", priority: 0 }]))
  const r = await approveTask(ctx, "a1b2-api")
  assert.ok(r.ok && r.data.epic === "k2p9-epic")
  assert.equal(r.data.siblings, undefined)
})

/** The retry arm carries the same contract, or a repeated approve truncates the walk mid-set. */
test("an alreadyDone retry still reports the epic and the remaining slices", async () => {
  const { ctx } = makeCtx({
    ...sliceSet("k2p9-epic", [{ id: "c3d4-ui", title: "Wire the UI", priority: 1 }]),
    "queued/a1b2-api.md": serializeTask({ title: "Add the API layer", epic: "k2p9-epic", priority: 0, body: "already queued" }),
  })
  const r = await approveTask(ctx, "a1b2-api")
  assert.ok(r.ok && r.data.alreadyDone === true && r.data.gate === "task")
  assert.deepEqual((r.data.siblings as { id: string }[]).map((s) => s.id), ["c3d4-ui"])
})

/**
 * The listing runs after the move is committed, so its failure must cost the
 * next-slice line and nothing else. An approval that reported failure for work
 * already on disk would be far worse than a follow-up with no walk in it.
 */
test("a failed sibling listing leaves the approval intact, just without its walk", async () => {
  const { ctx } = makeCtx(sliceSet("k2p9-epic", [{ id: "a1b2-api", title: "Add the API layer", priority: 0 }]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ctx.client as any).file.list = async () => {
    throw new Error("EIO")
  }
  const r = await approveTask(ctx, "a1b2-api")
  assert.ok(r.ok, "the move already happened — it cannot be undone by a failed listing")
  assert.equal(r.data.siblings, undefined)
})

test("approvePlan advances a planned plan-review task to in-progress", async () => {
  const { ctx, log } = makeCtx({ "plan-review/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) })
  const r = await approvePlan(ctx, "t")
  assert.ok(r.ok && r.data.approved === true)
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("in-progress")))
})

test("approvePlan refuses a planless plan-review task with a warning, no move", async () => {
  const { ctx, log } = makeCtx({ "plan-review/t.md": task("Do it", "no plan here") })
  const r = await approvePlan(ctx, "t")
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.variant === "warning")
  assert.match(!r.ok ? r.message : "", /no Implementation Plan/)
  assert.ok(!log.some((c) => c.startsWith("mv ")))
})

test("approvePlan on an already-in-progress task is idempotent", async () => {
  const { ctx } = makeCtx({ "in-progress/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) })
  const r = await approvePlan(ctx, "t")
  assert.ok(r.ok && r.data.alreadyDone === true)
})

/**
 * `data.gate` is the machine-readable discriminator for WHICH gate a move
 * crossed, and `data.id` names the task it crossed for. Hosts branch on these:
 * the Claude/Qwen gate hook hands the turn back — instead of blocking it — only
 * on a task gate, so it can ask "plan it now?", and it names the task in that
 * question. Both halves are required, and both must survive the `alreadyDone`
 * retry arms: a retry re-asking is harmless, a retry that goes silent is not.
 *
 * They must never be re-derived from `message` text: the messages are prose
 * that changes, and a host guessing from them is a host that guesses wrong.
 */
const GATE_DISCRIMINATOR: ReadonlyArray<[string, Record<string, string>, (ctx: GateCtx) => Promise<GateResult>, string]> = [
  ["approveTask", { "draft/t.md": task("Do it") }, (ctx) => approveTask(ctx, "t"), "task"],
  ["approveTask (already queued)", { "queued/t.md": task("Do it") }, (ctx) => approveTask(ctx, "t"), "task"],
  ["approvePlan", { "plan-review/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) }, (ctx) => approvePlan(ctx, "t"), "plan"],
  ["approvePlan (already in-progress)", { "in-progress/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) }, (ctx) => approvePlan(ctx, "t"), "plan"],
  ["shipTask", { "in-review/t.md": task("Do it") }, (ctx) => shipTask(ctx, "t"), "ship"],
  ["shipTask (already completed)", { "completed/t.md": task("Do it") }, (ctx) => shipTask(ctx, "t"), "ship"],
]

for (const [label, files, run, gate] of GATE_DISCRIMINATOR) {
  test(`${label} reports gate "${gate}" and the task id in its result data`, async () => {
    const { ctx } = makeCtx(files)
    const r = await run(ctx)
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.data.gate, gate)
    assert.equal(r.ok && r.data.id, "t")
  })
}

// approveAny is a pure dispatcher, so the gate it reports is decided entirely by
// the folder the task sits in. This is the assertion the whole follow-up-question
// feature rests on: the hook reads `data.gate` off THIS call.
const APPROVE_ANY_DISPATCH: ReadonlyArray<[string, Record<string, string>, string]> = [
  ["draft", { "draft/t.md": task("Do it") }, "task"],
  ["plan-review", { "plan-review/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) }, "plan"],
  ["in-review", { "in-review/t.md": task("Do it") }, "ship"],
]

for (const [folder, files, gate] of APPROVE_ANY_DISPATCH) {
  test(`approveAny on a ${folder}/ task reports gate "${gate}"`, async () => {
    const { ctx } = makeCtx(files)
    const r = await approveAny(ctx, "t")
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.data.gate, gate)
    assert.equal(r.ok && r.data.id, "t")
  })
}

test("replanTask refuses a task a live loop is driving", async () => {
  const { ctx, log } = makeCtx({ "plan-review/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) }, { driving: "t" })
  const r = await replanTask(ctx, "t", "changed my mind")
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.message : "", /live loop/)
  assert.ok(!log.some((c) => c.startsWith("mv ")))
})

test("replanTask sends a parked plan back to queued, stamped plan-next", async () => {
  const { ctx, log } = makeCtx({ "plan-review/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) })
  const r = await replanTask(ctx, "t", "missed the cache")
  assert.ok(r.ok && r.data.requeued === true)
  assert.ok(r.ok && r.data.id === "t", "hosts chain the re-plan from data.id")
  // The id must ride in the MESSAGE too — the Claude host's model chains its
  // PLAN pass from this text alone (gate-command surfaces only the message).
  assert.match(r.ok ? r.message : "", /\(t\)/)
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("queued")))
  // The marker write is best-effort, so the attempt is what's pinned here.
  assert.ok(
    log.some((c) => c.startsWith("mkdir -p /repo/docs/tasks/queued/.requests")),
    "the plan-next request marker is stamped",
  )
})

test("replanTask on an already-queued task records the fresh reason and restamps plan-next", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) })
  const r = await replanTask(ctx, "t", "still misses the cache")
  assert.ok(r.ok && r.data.alreadyDone === true && r.data.requeued === true && r.data.id === "t")
  assert.match(r.ok ? r.message : "", /\(t\)/, "the id rides in the message for the model-driven chain")
  // The only `mv` allowed is the marker's atomic rename — the task file stays put.
  assert.ok(!log.some((c) => c.startsWith("mv ") && c.includes("t.md")), "the task file does not move")
  assert.ok(
    log.some((c) => c.includes("Plan rejected") && c.includes("still misses the cache")),
    "the fresh reason lands as the canonical rejection note",
  )
  assert.ok(log.some((c) => c.startsWith("mkdir -p /repo/docs/tasks/queued/.requests")))
})

test("replanTask on a queued task being planned right now refuses instead of racing the planner", async () => {
  // Appending a note to a file the plan author is actively rewriting is a lost
  // update — and the run holding the claim is already doing what replan asks.
  const { ctx, log } = makeCtx({ "queued/t.md": task("Do it"), "queued/.claims/t": "" })
  const r = await replanTask(ctx, "t", "another thought")
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.message : "", /being planned right now/)
  assert.ok(!log.some((c) => c.includes("Plan rejected")), "no note lands under the planner")
  assert.ok(!log.some((c) => c.startsWith("mkdir -p /repo/docs/tasks/queued/.requests")), "no restamp either")
})

test("oneLineReason flattens a multi-line reason to the single audit-note line shape", () => {
  // The hub's per-line plan comments arrive pre-flattened; a CLI/MCP reason may
  // not, and a raw newline detaches the note's closing stamp — unparseable by
  // `extractReplanReason` from then on.
  assert.equal(oneLineReason("step 2 is wrong\n  key on size too"), "step 2 is wrong key on size too")
  assert.equal(oneLineReason("  already flat  "), "already flat")
  assert.equal(oneLineReason("   "), undefined)
  assert.equal(oneLineReason(undefined), undefined)
})

// `replan <id> <reason>` used to detect the leading id with an exact filename match,
// so a short-hash handle (`f7k3`) fell through into the reason and the SOLE plan-review
// task was replanned instead of the one the human named. rejectAny now resolves the
// short hash like `approve` does.
test("rejectAny replans the short-hash-named task, not the sole plan-review task", async () => {
  const { ctx, fs } = makeCtx({
    "in-progress/a1b2-do-thing.md": task("Do thing", `${PLAN_HEADING}\n\n1. step`),
    "plan-review/f7k3-fix-bar.md": task("Fix bar", `${PLAN_HEADING}\n\n1. step`),
  })
  const r = await rejectAny(ctx, "a1b2 wrong approach")
  assert.ok(r.ok && r.data.requeued === true)
  assert.ok("/repo/docs/tasks/queued/a1b2-do-thing.md" in fs, "the task addressed by its short hash moved to queued")
  assert.ok("/repo/docs/tasks/plan-review/f7k3-fix-bar.md" in fs, "the unrelated parked plan is untouched")
})

test("rejectAny surfaces an ambiguous short hash instead of folding it into the reason", async () => {
  const { ctx, fs } = makeCtx({
    "plan-review/f7k3-fix-bar.md": task("Fix bar", `${PLAN_HEADING}\n\n1. step`),
    "plan-review/f7k3-add-foo.md": task("Add foo", `${PLAN_HEADING}\n\n1. step`),
  })
  const r = await rejectAny(ctx, "f7k3 bad plan")
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.variant === "warning")
  assert.match(!r.ok ? r.message : "", /Ambiguous id "f7k3"/)
  assert.ok(!("/repo/docs/tasks/queued/f7k3-fix-bar.md" in fs), "nothing moved on ambiguity")
})

test("shipTask moves an in-review task to completed (no branch → no PR)", async () => {
  const { ctx, fs } = makeCtx({ "in-review/t.md": task("Do it") })
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok && typeof r.data.completed === "string")
  assert.ok(!("pr" in (r.ok ? r.data : {})), "no PR attempted without a feature branch")
  assert.ok("/repo/docs/tasks/completed/t.md" in fs)
})

// Ship is the ONLY point that removes a task's worktree: it is kept across every
// earlier run so retries and recoveries build on prior iterations.
test("shipTask releases the task's worktree once the task is completed", async () => {
  const wt = "/repo/.workflow-worktrees/t"
  const { ctx, log } = makeCtx(
    { "in-review/t.md": task("Do it") },
    {
      git: (cmd) => {
        if (cmd.includes("worktree list")) return { exitCode: 0, stdout: `worktree ${wt}\nHEAD abc\nbranch refs/heads/feature/t\n` }
        if (cmd.includes("is-inside-work-tree")) return { exitCode: 0, stdout: "true" }
        if (cmd.includes("worktree remove")) return { exitCode: 0, stdout: "" }
        return undefined // everything else keeps the default "no actor, no branch"
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok)
  assert.ok(log.some((c) => c.includes(`worktree remove ${wt}`)), log.join(" | "))
})

// --- id resolution: approve by short-hash prefix, ambiguity, legacy back-compat ---

test("approveTask resolves a draft by its short-hash prefix", async () => {
  const { ctx, fs } = makeCtx({ "draft/f7k3-flight-map.md": task("Flight Map") })
  const r = await approveTask(ctx, "f7k3")
  assert.ok(r.ok && r.data.approved === true)
  assert.ok("/repo/docs/tasks/queued/f7k3-flight-map.md" in fs, "moved by the resolved full id")
})

test("approveTask on an ambiguous prefix refuses with a warning (never guesses)", async () => {
  const { ctx, fs } = makeCtx({ "draft/f7k3-flight-map.md": task("Flight Map"), "draft/fa2b-fee-calc.md": task("Fee Calc") })
  const r = await approveTask(ctx, "f")
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.variant === "warning")
  assert.match(r.message, /[Aa]mbiguous/)
  assert.match(r.message, /f7k3-flight-map/)
  assert.ok(!("/repo/docs/tasks/queued/f7k3-flight-map.md" in fs), "nothing moved on ambiguity")
})

test("approveTask still resolves a legacy slug id exactly (back-compat)", async () => {
  const { ctx, fs } = makeCtx({ "draft/add-rate-limiting.md": task("Add rate limiting") })
  const r = await approveTask(ctx, "add-rate-limiting")
  assert.ok(r.ok && r.data.approved === true)
  assert.ok("/repo/docs/tasks/queued/add-rate-limiting.md" in fs)
})

test("approvePlan resolves a plan-review task by its short-hash prefix", async () => {
  const { ctx, fs } = makeCtx({ "plan-review/a1b2-do-bar.md": `${task("Do bar")}\n\n${PLAN_HEADING}\n\nStep 1.` })
  const r = await approvePlan(ctx, "a1b2")
  assert.ok(r.ok && r.data.approved === true)
  assert.ok("/repo/docs/tasks/in-progress/a1b2-do-bar.md" in fs)
})

// A task file whose frontmatter can't be parsed (schema failure, unrescuable
// YAML) used to surface as "no task found" — findByIdIn swallows the parse
// error — sending the human hunting for a file that is right there. The gates
// now diagnose the unparseable file instead.
test("approveTask on an unparseable draft reports the parse problem, not 'no task found'", async () => {
  // Valid YAML, invalid schema (no title) — the parse-repair retry can't rescue this.
  const broken = "---\npriority: 1\n---\nSome body."
  const { ctx, fs } = makeCtx({ "draft/x9y8-broken-task.md": broken })
  const r = await approveTask(ctx, "x9y8-broken-task")
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.message : "", /exists but can't be parsed/)
  assert.match(!r.ok ? r.message : "", /draft\/x9y8-broken-task\.md/)
  assert.match(!r.ok ? r.message : "", /title/)
  assert.ok("/repo/docs/tasks/draft/x9y8-broken-task.md" in fs, "nothing moved")
})

// --- ship retry after a crash between the completed/ move and shipPr ---
// A crash in that window leaves the task completed with the branch unpushed and
// no PR; the retry must re-attempt the (idempotent) shipPr, not report success
// and delete the worktree with the PR silently absent.

test("shipTask retry on an already-completed task re-attempts the PR when none was recorded", async () => {
  const { ctx, fs, log } = makeCtx(
    { "completed/t.md": task("Do it") },
    {
      git: (cmd) => {
        if (cmd.includes("rev-parse --verify")) return { exitCode: 0, stdout: "" } // feature/t exists
        if (cmd.includes("push")) return { exitCode: 0, stdout: "" } // push succeeds
        return undefined
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok)
  assert.ok(
    log.some((c) => c.includes("push -u origin feature/t")),
    "the retry must push the unshipped branch",
  )
  // gh is stubbed to no-op here, so the PR isn't actually opened — the point is
  // the attempt is recorded (a "PR not opened" note appended), not silently skipped.
  assert.ok(log.some((c) => c.includes("PR not opened")), "the PR attempt must be audited on the completed task")
  assert.ok("/repo/docs/tasks/completed/t.md" in fs, "the task stays completed")
})

test("an unopened PR is a WARNING on a successful ship, not a failure", async () => {
  // Opening a PR is not a requirement of shipping — shipPr never throws, no-ops
  // for a hand-authored task with no branch, and some of its reasons are plain
  // config states. By the time it runs the task is already moved and committed.
  // So the ship succeeds; the caveat rides along as a variant. What it must NOT
  // do is go silent: the reason used to land only in an audit note, which the
  // default ignoreBacklog: true never commits.
  const { ctx } = makeCtx(
    { "in-review/t.md": task("Do it") },
    {
      git: (cmd) => {
        if (cmd.includes("rev-parse --verify")) return { exitCode: 0, stdout: "" } // feature/t exists
        if (cmd.includes("push")) return { exitCode: 0, stdout: "" } // pushes fine; gh is what fails
        return undefined
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.equal(r.ok, true, "the ship succeeded — the task IS completed")
  assert.equal(r.variant, "warning", "and it is surfaced as a warning, which is the whole point")
  assert.match(r.message, /no PR was opened/, "the message says so rather than reading as an unqualified success")
  // The embedded reason may legitimately contain "failed" — `gh pr create failed`
  // is the diagnostic. What must not come back is the FRAMING that read as a
  // failed ship.
  assert.doesNotMatch(r.message, /But the PR|NOT opened/, "the framing must not read as a failure")
  assert.match(r.message, /completed/, "and it still leads with the ship having succeeded")
  assert.ok(r.ok && (r.data.pr as { opened?: boolean }).opened === false, "machine-readable too — the only channel the Claude host shows")
  assert.ok(r.ok && !("failed" in (r.data.pr as object)), "and nothing claims the ship failed")
})

test("a caveated ship never claims the branch was pushed — that is unknowable here", async () => {
  // `attempted` covers two worlds: `git push failed` (not pushed) and a gh/ADO
  // create failure (pushed). ShipPrResult does not distinguish them, so any
  // claim either way is wrong half the time.
  const { ctx } = makeCtx(
    { "in-review/t.md": task("Do it") },
    {
      git: (cmd) => {
        if (cmd.includes("rev-parse --verify")) return { exitCode: 0, stdout: "" }
        if (cmd.includes("push")) return { exitCode: 1, stdout: "" } // the PUSH is what fails here
        return undefined
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.equal(r.ok, true, "a failed push still does not fail the ship")
  assert.equal(r.variant, "warning")
  assert.doesNotMatch(r.message, /branch is pushed/, "the old wording asserted this and was wrong in exactly this case")
})

test("a clean ship carries no variant, so ordinary ships stay green", async () => {
  // The regression this change is most likely to cause.
  const { ctx } = makeCtx({ "in-review/t.md": task("Do it") })
  const r = await shipTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.equal(r.variant, undefined, "no branch to ship → no PR attempt → nothing to warn about")
  assert.doesNotMatch(r.message, /no PR was opened/)
})

test("shipTask's already-completed retry reports a still-failing PR rather than 'nothing to do'", async () => {
  const { ctx } = makeCtx(
    { "completed/t.md": task("Do it") },
    {
      git: (cmd) => {
        if (cmd.includes("rev-parse --verify")) return { exitCode: 0, stdout: "" }
        if (cmd.includes("push")) return { exitCode: 0, stdout: "" }
        return undefined
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok)
  assert.equal(r.variant, "warning", "the retry warns for the same reason the main path does")
  assert.match(r.message, /no PR was opened/)
  assert.doesNotMatch(r.message, /Nothing to do/, "a PR that still did not open is not 'nothing to do'")
})

test("shipTask retry does nothing when the completed task already recorded a PR", async () => {
  const withPr = `${task("Do it")}\n\n> PR opened — https://example.com/pr/1 _(2026-01-01)_`
  const { ctx, log } = makeCtx(
    { "completed/t.md": withPr },
    {
      git: (cmd) => {
        if (cmd.includes("rev-parse --verify")) return { exitCode: 0, stdout: "" }
        if (cmd.includes("push")) return { exitCode: 0, stdout: "" }
        return undefined
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok)
  assert.ok(!log.some((c) => c.includes("push -u origin")), "no re-push once a PR is on record")
})

// --- a move that throws must not leave a note asserting it happened ---

/**
 * `moveTask` THROWS on a duplicate destination, a failed `mv`, or a move that
 * didn't land. Every gate verb appends its audit note FIRST — it belongs to the
 * file, and after a successful move the file is elsewhere — so an unguarded
 * throw escapes a function whose contract is `GateResult` and leaves the task
 * claiming a transition it never made, while the commit, the PR and the
 * worktree release below it never run. Only `abandonTask` guarded this, and
 * even it left the false note standing.
 *
 * The collision cases use a pre-existing file at the destination: the exact
 * duplicate state `auditBacklog` reports, and a real throw rather than a stub.
 */
const collidingMoves: ReadonlyArray<{
  verb: string
  from: string
  to: string
  run: (ctx: GateCtx) => Promise<GateResult>
  body?: string
}> = [
  { verb: "approveTask", from: "draft", to: "queued", run: (ctx) => approveTask(ctx, "t") },
  { verb: "approvePlan", from: "plan-review", to: "in-progress", run: (ctx) => approvePlan(ctx, "t"), body: `${PLAN_HEADING}\n\n1. Step.` },
  { verb: "replanTask", from: "plan-review", to: "queued", run: (ctx) => replanTask(ctx, "t", "wrong layer"), body: `${PLAN_HEADING}\n\n1. Step.` },
  { verb: "shipTask", from: "in-review", to: "completed", run: (ctx) => shipTask(ctx, "t") },
  { verb: "abandonTask", from: "draft", to: "abandoned", run: (ctx) => abandonTask(ctx, "t") },
]

for (const { verb, from, to, run, body } of collidingMoves) {
  test(`${verb} reports a colliding move instead of throwing out of its GateResult`, async () => {
    const other = task("A different task with the same id")
    const { ctx, fs, log } = makeCtx({ [`${from}/t.md`]: task("Do it", body), [`${to}/t.md`]: other })
    const r = await run(ctx)
    assert.equal(r.ok, false, `${verb} must return a refusal, not throw`)
    assert.match(r.message, /already exists/, "the message must say what went wrong")
    assert.ok(`/repo/docs/tasks/${from}/t.md` in fs, "the task stays where it was")
    assert.equal(fs[`/repo/docs/tasks/${to}/t.md`], other, "the file it collided with is untouched")
    // The note is on disk before the move is attempted and cannot be unwritten,
    // so the correction has to follow it or the file's own history lies.
    assert.ok(
      log.some((c) => c.includes("did not move")),
      `${verb} must append a correction after its audit note`,
    )
    assert.ok(!log.some((c) => c.startsWith("git commit")), "a move that did not happen is not committed")
    assert.ok(!log.some((c) => c.includes("/.requests")), "no plan-next marker for a move that did not happen")
  })
}

test("retaskTask reports a failed mv instead of throwing out of its GateResult", async () => {
  // retask cannot collide — an existing draft/<id>.md makes it an idempotent
  // no-op before any move — so its throwing path is the failed `mv` itself.
  const { ctx, fs, log } = makeCtx({ "queued/t.md": task("Do it") }, { failMv: true })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /could not move|did not land/)
  assert.ok("/repo/docs/tasks/queued/t.md" in fs, "the task stays in queued/")
  assert.ok(log.some((c) => c.includes("did not move")), "the audit note is corrected")
})

test("a failed mv is reported by every gate verb that moves a task", async () => {
  const runs: ReadonlyArray<[string, string, (ctx: GateCtx) => Promise<GateResult>, string?]> = [
    ["approveTask", "draft", (ctx) => approveTask(ctx, "t"), undefined],
    ["approvePlan", "plan-review", (ctx) => approvePlan(ctx, "t"), `${PLAN_HEADING}\n\n1. Step.`],
    ["replanTask", "plan-review", (ctx) => replanTask(ctx, "t", "why"), `${PLAN_HEADING}\n\n1. Step.`],
    ["shipTask", "in-review", (ctx) => shipTask(ctx, "t"), undefined],
    ["abandonTask", "draft", (ctx) => abandonTask(ctx, "t"), undefined],
  ]
  for (const [verb, from, run, body] of runs) {
    const { ctx, fs } = makeCtx({ [`${from}/t.md`]: task("Do it", body) }, { failMv: true })
    const r = await run(ctx)
    assert.equal(r.ok, false, `${verb} must refuse when the mv fails`)
    assert.ok(`/repo/docs/tasks/${from}/t.md` in fs, `${verb}: the task stays put`)
  }
})

// --- an unsafe id must never reach the filesystem ---

test("a gate verb given a traversing id never reads outside the backlog", async () => {
  // `resolveGateId` returns null for an id the store refuses, and every caller
  // then carries the RAW id on to its "no task found" messaging. `unparseableAt`
  // was the one id-taking helper with no safety gate, so it `cat`ed
  // <tasksDir>/<status>/../../../../etc/shadow.md — a filesystem existence
  // oracle, plus whatever a YAML lexer error quotes back from the file.
  const evil = "../../../../etc/shadow"
  for (const [verb, run] of [
    ["removeTask", (ctx: GateCtx) => removeTask(ctx, evil, true)],
    ["abandonTask", (ctx: GateCtx) => abandonTask(ctx, evil)],
    ["approveTask", (ctx: GateCtx) => approveTask(ctx, evil)],
    ["shipTask", (ctx: GateCtx) => shipTask(ctx, evil)],
  ] as const) {
    const { ctx, log } = makeCtx({})
    const r = await run(ctx)
    // Not asserted: ok/!ok. `removeTask` reports an absent id as an idempotent
    // success by design, and that stays true whatever the id looks like. What
    // must hold for every verb is that nothing outside the backlog was read.
    assert.doesNotMatch(r.message, /etc\/shadow\.md exists/, `${verb} must not report on a file outside the backlog`)
    const escaped = log.filter((c) => c.includes("..") || c.includes("/etc/"))
    assert.deepEqual(escaped, [], `${verb} touched a path outside the backlog: ${escaped.join(", ")}`)
  }
})
