import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultWorkflowsDir } from "../manifest/dir.js"
import { loadManifest } from "../manifest/load.js"
import { emptyLedger, type PrSnapshot } from "./ledger.js"
import { makeClaimMarkers, prWorkItem, terminalLedgerUpdate, triggerSummary } from "./pr-shared.js"

/**
 * The platform-neutral PR-source pieces: the terminal ledger decision (THE
 * dedup rule both github-pr and ado-pr trust) and the WorkItem builder over
 * the real pr-sitter / review-sitter manifests.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const NOW = "2026-07-05T00:00:00Z"

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 7,
  title: "Fix the flux capacitor",
  headRefName: "feature/flux",
  baseRefName: "main",
  headRefOid: "aaa111",
  mergeable: "MERGEABLE",
  reviewDecision: "",
  failingChecks: ["CI"],
  newComments: [],
  ...over,
})

test("terminalLedgerUpdate(done) advances the handled head and comment watermark", () => {
  const ledger = emptyLedger(7, NOW)
  const updated = terminalLedgerUpdate(ledger, { kind: "done", message: "pushed" }, ["failing-checks"], "aaa111", "bbb222", "2026-07-05T01:00:00Z", NOW)
  assert.equal(updated.headShaHandled, "bbb222") // the re-read head — the sitter's own push
  assert.equal(updated.lastCommentAtHandled, "2026-07-05T01:00:00Z")
  assert.equal(updated.conflictAttempt, undefined)
})

test("terminalLedgerUpdate(done) on a merge-conflict trigger records the conflict attempt", () => {
  const updated = terminalLedgerUpdate(emptyLedger(7, NOW), { kind: "done", message: "resolved" }, ["merge-conflict"], "aaa111", "bbb222", "", NOW)
  assert.deepEqual(updated.conflictAttempt, { headSha: "bbb222", baseSha: "" })
  // An empty re-read watermark must not clobber an existing one with "".
  assert.equal(updated.lastCommentAtHandled, undefined)
})

test("a genuine stop records a failed attempt against the SNAPSHOT head; a retryable stop changes nothing (C2)", () => {
  const ledger = emptyLedger(7, NOW)
  const capped = terminalLedgerUpdate(ledger, { kind: "stop", message: "capped" }, ["failing-checks", "new-comments"], "aaa111", "bbb222", "", NOW)
  assert.deepEqual(capped.failedAttempts, [{ headSha: "aaa111", trigger: "failing-checks+new-comments", at: NOW }])
  assert.equal(capped.headShaHandled, undefined, "a failed run never advances the handled head")

  const retryable = terminalLedgerUpdate(ledger, { kind: "stop", message: "gh blip", retryable: true }, ["failing-checks"], "aaa111", "bbb222", "", NOW)
  assert.equal(retryable, ledger, "same object — the caller skips the save and the head stays claimable")
})

test("prWorkItem enters the pr-sitter's first stage with an author-role goal and reusable git refs", () => {
  const loaded = loadManifest(WORKFLOWS_DIR, "pr-sitter")
  const item = prWorkItem(loaded, "github", snapshot(), ["failing-checks"])
  assert.equal(item.id, "pr-7")
  assert.equal(item.workflowKind, "pr-sitter")
  assert.equal(item.entryStage, loaded.manifest.stages[0]?.name)
  assert.deepEqual(item.state.git, { base: "main", branch: "feature/flux" })
  assert.match(item.state.goal, /Never merge the PR/)
  assert.match(item.claimMessage, /failing checks: CI/)
})

test("prWorkItem gives a reviewer-role kind a comment-only goal", () => {
  const loaded = loadManifest(WORKFLOWS_DIR, "review-sitter")
  const item = prWorkItem(loaded, "github", snapshot(), ["review-requested"])
  assert.match(item.state.goal, /Never approve, request changes, or merge/)
  assert.equal(item.workflowKind, "review-sitter")
})

test("triggerSummary names every trigger in a human line", () => {
  const s = triggerSummary(["failing-checks", "changes-requested", "new-comments", "merge-conflict", "review-requested"], snapshot({ newComments: [{ author: "alice", at: NOW }] }))
  assert.match(s, /failing checks: CI/)
  assert.match(s, /review requested changes/)
  assert.match(s, /1 unanswered comment/)
  assert.match(s, /merge conflict/)
  assert.match(s, /your review is requested/)
})

test("triggerSummary falls back to a manual-claim line for an empty trigger set (a forced `claim <pr>`)", () => {
  const s = triggerSummary([], snapshot())
  assert.match(s, /manually claimed/)
})

test("prWorkItem builds a well-formed goal when a forced claim carries no triggers", () => {
  const loaded = loadManifest(WORKFLOWS_DIR, "pr-sitter")
  const item = prWorkItem(loaded, "github", snapshot(), [])
  // No empty "()" — the summary reads as a manual claim.
  assert.doesNotMatch(item.state.goal, /\(\)/)
  assert.match(item.state.goal, /manually claimed/)
})

// --- makeClaimMarkers: the staleness recovery sitter markers never had ---

/**
 * A fake filesystem for the mkdir-marker protocol. `mkdir` on an existing
 * directory fails (that IS the claim), `rmdir` removes it, and `cat` reads the
 * stamp — enough to observe the acquire/sweep/re-acquire sequence.
 */
const markerShell = (dirs: Set<string> = new Set(), files: Record<string, string> = {}) => {
  const cmds: string[] = []
  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    cmds.push(cmd)
    let exitCode = 0
    let stdout = ""
    const [verb] = cmd.split(/\s+/)
    if (cmd.startsWith("mkdir -p ")) dirs.add(cmd.slice("mkdir -p ".length))
    else if (verb === "mkdir") {
      const d = cmd.slice("mkdir ".length)
      if (dirs.has(d)) exitCode = 1
      else dirs.add(d)
    } else if (verb === "rmdir") dirs.delete(cmd.slice("rmdir ".length))
    else if (cmd.startsWith("rm -f ")) delete files[cmd.slice("rm -f ".length)]
    else if (cmd.startsWith("rm -rf ")) {
      const target = cmd.slice("rm -rf ".length)
      dirs.delete(target)
      for (const f of Object.keys(files)) if (f.startsWith(`${target}/`)) delete files[f]
    } else if (verb === "mv") {
      // The stale-marker takeover renames the marker aside — atomically, so only
      // one of two sweepers can proceed. Modelled here because that rename IS
      // the exclusion; a no-op `mv` would make the race untestable.
      const [, src, dest] = cmd.split(/\s+/) as [string, string, string]
      if (!dirs.has(src)) exitCode = 1
      else {
        dirs.delete(src)
        dirs.add(dest)
        for (const f of Object.keys(files)) {
          if (f.startsWith(`${src}/`)) {
            files[dest + f.slice(src.length)] = files[f]!
            delete files[f]
          }
        }
      }
    } else if (verb === "cat") {
      const f = cmd.slice("cat ".length)
      if (f in files) stdout = files[f]!
      else exitCode = 1
    } else if (cmd.startsWith("printf ")) {
      const m = /^printf '%s' ([\s\S]*) > (\S+)$/.exec(cmd)
      if (m) files[m[2]!] = m[1]!
    } else if (verb === "find") exitCode = 1 // no mtime fallback in these cases
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode, stdout: { toString: () => stdout }, stderr: { toString: () => "" } }).then(resolve),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  return { $, dirs, files, cmds }
}

const MARKER = "/repo/docs/tasks/runs/pr-sitter/.claims/pr-7"
const NOW_DATE = new Date("2026-07-05T12:00:00Z")

test("a first claim wins the marker and stamps it", async () => {
  const { $, dirs, files } = markerShell()
  const markers = makeClaimMarkers($, "/repo", "docs/tasks", "pr-sitter")
  assert.equal(await markers.claim(7, NOW_DATE), true)
  assert.ok(dirs.has(MARKER))
  // The stamp is what makes recovery possible at all — mtime is unreliable on
  // DrvFS/WSL, the same reason scheduler/lease.ts stamps its lease.
  assert.match(files[`${MARKER}/claim.json`] ?? "", /claimedAt/)
})

test("a fresh marker held by a live run is NOT stolen", async () => {
  const { $, files } = markerShell()
  const markers = makeClaimMarkers($, "/repo", "docs/tasks", "pr-sitter")
  await markers.claim(7, NOW_DATE)
  const oneMinuteLater = new Date(NOW_DATE.getTime() + 60_000)
  assert.equal(await markers.claim(7, oneMinuteLater), false, "the running sitter keeps its PR")
  assert.match(files[`${MARKER}/claim.json`] ?? "", /12:00:00/, "and its stamp is untouched")
})

test("a marker left by a dead run is swept and re-claimed", async () => {
  // THE regression test. There was no staleness check at all: a SIGKILL, a host
  // restart, or a throw that never reached onTerminal left this directory on
  // disk forever, and every later poll reported "claim marker held for pr-7".
  // Nothing swept it — the hub doctor only sweeps backlog pools — so the PR was
  // never sitted again until a human ran rm -rf.
  const { $, dirs } = markerShell()
  const markers = makeClaimMarkers($, "/repo", "docs/tasks", "pr-sitter")
  await markers.claim(7, NOW_DATE)
  const wellPastStale = new Date(NOW_DATE.getTime() + 60 * 60_000)
  assert.equal(await markers.claim(7, wellPastStale), true, "the dead run's marker is reclaimable")
  assert.ok(dirs.has(MARKER), "and the marker is held again by the new claimer")
})

test("release drops the stamp before the marker, so rmdir sees an empty dir", async () => {
  const { $, dirs, cmds } = markerShell()
  const markers = makeClaimMarkers($, "/repo", "docs/tasks", "pr-sitter")
  await markers.claim(7, NOW_DATE)
  await markers.release(7)
  assert.ok(!dirs.has(MARKER))
  assert.ok(cmds.indexOf(`rm -f ${MARKER}/claim.json`) < cmds.indexOf(`rmdir ${MARKER}`))
})

test("markers are keyed by kind, so two PR-shaped kinds cannot clash", async () => {
  const shared = markerShell()
  const pr = makeClaimMarkers(shared.$, "/repo", "docs/tasks", "pr-sitter")
  const review = makeClaimMarkers(shared.$, "/repo", "docs/tasks", "review-sitter")
  assert.equal(await pr.claim(7, NOW_DATE), true)
  assert.equal(await review.claim(7, NOW_DATE), true, "the same PR number in another kind is independent")
})
