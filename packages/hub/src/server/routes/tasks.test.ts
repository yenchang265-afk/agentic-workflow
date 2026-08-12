import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { KindBoardInfo, SaveTaskRequest, SaveTaskResponse, TaskDetailResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import type { JsonResponse } from "../http.js"
import { postGate } from "./gate.js"
import { getTaskDetail, postTaskSave } from "./tasks.js"

/**
 * The in-place task editor, against a real git repo and real task files. The
 * route rewrites files and commits, so a fixture that faked the shell would
 * prove nothing about the part most worth proving: that an edit lands, that the
 * audit trail survives it, and that a refusal leaves the file untouched.
 */

const BOARDS: readonly KindBoardInfo[] = [
  {
    kind: "engineering",
    description: "",
    sourceType: "backlog",
    statuses: ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"],
    gateStatuses: ["plan-review", "in-review"],
    pools: ["queued", "in-progress"],
  },
]

/** A task file with only schema-known frontmatter, so the editor can rewrite it. */
const TASK = (title: string, opts: { plan?: boolean; notes?: readonly string[]; body?: string } = {}): string =>
  [
    "---",
    `title: ${title}`,
    "type: feature",
    "priority: 2",
    "acceptance:",
    "  - it works",
    "---",
    "",
    opts.body ?? "Some body.",
    ...(opts.plan ? ["", "## Implementation Plan", "", "1. Do the thing."] : []),
    ...(opts.notes ?? []),
    "",
  ].join("\n")

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" })
}

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-tasks-"))
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
  for (const s of ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"]) {
    fs.mkdirSync(path.join(dir, "docs", "tasks", s), { recursive: true })
  }
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "init")
  return dir
}

const place = (dir: string, status: string, id: string, content: string): void => {
  fs.writeFileSync(path.join(dir, "docs", "tasks", status, `${id}.md`), content)
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", `add ${id}`)
}

const filePath = (dir: string, status: string, id: string): string =>
  path.join(dir, "docs", "tasks", status, `${id}.md`)

const at = (dir: string, status: string, id: string): boolean => fs.existsSync(filePath(dir, status, id))

const read = (dir: string, status: string, id: string): string => fs.readFileSync(filePath(dir, status, id), "utf8")

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: BOARDS,
  // ignoreBacklog defaults to true; these tests assert the commit, so opt in.
  config: { ...DEFAULT_CONFIG, ignoreBacklog: false },
  workflowsDir: path.join(directory, "workflows-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true })

const headMessage = (dir: string): string =>
  execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir }).toString().trim()

const countCommits = (dir: string): number =>
  Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir }).toString().trim())

const detail = async (deps: HubDeps, status: string, id: string): Promise<TaskDetailResponse> => {
  const res = await getTaskDetail(deps, { params: { status, id }, query: new URLSearchParams() })
  return res.body as TaskDetailResponse
}

const save = async (deps: HubDeps, status: string, id: string, body: unknown): Promise<JsonResponse> =>
  postTaskSave(deps, { params: { status, id }, query: new URLSearchParams(), body })

/** A well-formed save body seeded from the task's current detail. */
const bodyFrom = (d: TaskDetailResponse, over: Partial<SaveTaskRequest> = {}): SaveTaskRequest => ({
  expectStatus: d.status as SaveTaskRequest["expectStatus"],
  baseHash: d.editable?.hash ?? "",
  title: d.card.title,
  type: d.card.type,
  priority: d.card.priority,
  labels: [...d.card.labels],
  acceptance: [...d.card.acceptance],
  body: d.editable?.prose ?? "",
  ...over,
})

// --- detail: the editable split is the server's call, not the browser's ---

test("getTaskDetail carries an editable split for a planless draft and queued task", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("a draft", { notes: ["", "> Task drafted [2026-01-01T00:00:00.000Z by A]"] }))
  place(dir, "queued", "bbb2-thing", TASK("queued"))
  const deps = depsFor(dir)

  const draft = await detail(deps, "draft", "aaa1-thing")
  assert.ok(draft.editable, "a planless draft is editable")
  assert.equal(draft.editable?.prose, "Some body.", "the audit run is kept out of the editor")
  assert.equal(draft.editable?.tail, "> Task drafted [2026-01-01T00:00:00.000Z by A]")
  assert.ok(draft.editable?.hash)

  assert.ok((await detail(deps, "queued", "bbb2-thing")).editable, "a planless queued task is editable")
  cleanup(dir)
})

test("getTaskDetail omits editable once a plan exists or the task moved on", async () => {
  const dir = makeRepo()
  place(dir, "queued", "ccc3-thing", TASK("planned early", { plan: true }))
  place(dir, "plan-review", "ddd4-thing", TASK("parked", { plan: true }))
  place(dir, "completed", "eee5-thing", TASK("done"))
  const deps = depsFor(dir)

  // A live PLAN stage can write a plan into queued/ — the folder alone is not enough.
  assert.equal((await detail(deps, "queued", "ccc3-thing")).editable, undefined)
  assert.equal((await detail(deps, "plan-review", "ddd4-thing")).editable, undefined)
  assert.equal((await detail(deps, "completed", "eee5-thing")).editable, undefined)
  cleanup(dir)
})

// --- saving a draft: rewrite in place, commit, never move ---

test("saving a draft rewrites it in place, commits, and does not move it", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("wrong goal"))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")

  const res = await save(
    deps,
    "draft",
    "aaa1-thing",
    bodyFrom(d, { title: "right goal", acceptance: ["it really works"], body: "Reshaped." }),
  )
  assert.equal(res.status, 200)
  const out = res.body as SaveTaskResponse
  assert.equal(out.ok, true)
  assert.ok(out.ok && out.changed.includes("title") && out.changed.includes("acceptance") && out.changed.includes("body"))

  const file = read(dir, "draft", "aaa1-thing")
  assert.match(file, /title: right goal/)
  assert.match(file, /it really works/)
  assert.match(file, /Reshaped\./)
  assert.ok(at(dir, "draft", "aaa1-thing") && !at(dir, "queued", "aaa1-thing"), "an edit is not a move")
  assert.match(headMessage(dir), /task edited in the hub/)
  assert.match(file, /Task edited in the hub \(title, acceptance, body\)/, "the change is audited")
  cleanup(dir)
})

test("the audit tail survives an edit whose request never contained it", async () => {
  const dir = makeRepo()
  const note = "> Task approved — queued for planning [2026-07-01T10:00:00.000Z by alice]"
  place(dir, "draft", "aaa1-thing", TASK("a draft", { notes: ["", note] }))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")
  assert.ok(!d.editable?.prose.includes(note), "the note never reaches the editor")

  await save(deps, "draft", "aaa1-thing", bodyFrom(d, { body: "Totally new prose." }))
  const file = read(dir, "draft", "aaa1-thing")
  assert.match(file, /Totally new prose\./)
  assert.ok(file.includes(note), "the server rejoins its own tail — the browser could not have sent it")
  cleanup(dir)
})

test("a no-op save writes nothing and commits nothing", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("unchanged"))
  const deps = depsFor(dir)
  const before = countCommits(dir)
  const d = await detail(deps, "draft", "aaa1-thing")

  const res = await save(deps, "draft", "aaa1-thing", bodyFrom(d))
  const out = res.body as SaveTaskResponse
  assert.equal(out.ok, true)
  assert.deepEqual(out.ok && out.changed, [])
  assert.equal(countCommits(dir), before, "no commit for a save that changed nothing")
  assert.ok(!read(dir, "draft", "aaa1-thing").includes("edited in the hub"), "and no audit note")
  cleanup(dir)
})

// --- saving a queued task also retasks it back to draft ---

test("saving a queued task rewrites it AND sends it back to draft with the reason", async () => {
  const dir = makeRepo()
  place(dir, "queued", "bbb2-thing", TASK("approved under a wrong goal"))
  const deps = depsFor(dir)
  const before = countCommits(dir)
  const d = await detail(deps, "queued", "bbb2-thing")

  const res = await save(
    deps,
    "queued",
    "bbb2-thing",
    bodyFrom(d, { title: "the real goal", reason: "acceptance described the wrong screen" }),
  )
  assert.equal(res.status, 200)
  const out = res.body as SaveTaskResponse
  assert.equal(out.ok, true)
  assert.equal(out.ok && out.retask?.ok, true)

  assert.ok(at(dir, "draft", "bbb2-thing") && !at(dir, "queued", "bbb2-thing"), "the approval is withdrawn")
  const file = read(dir, "draft", "bbb2-thing")
  assert.match(file, /title: the real goal/)
  assert.match(file, /Task edited in the hub .*acceptance described the wrong screen/)
  assert.match(file, /approval withdrawn — acceptance described the wrong screen/)
  assert.equal(countCommits(dir), before + 1, "the edit and the move land in one commit")
  cleanup(dir)
})

test("a multi-line reason still yields single-line audit notes", async () => {
  // The reason field is a <textarea> and the route schema is `z.string().trim()`,
  // which leaves interior newlines alone. An audit note is one `> …` line closed
  // by a bracketed stamp: a raw paragraph put line 2 in the file with no `> `
  // prefix and the stamp detached, so the note stopped matching core's
  // AUDIT_NOTE_LINE_RE — the orphaned lines then read as PROSE (they ride into
  // every later {{goal}}) and the "last note" parsers went blind.
  const dir = makeRepo()
  place(dir, "queued", "ccc3-thing", TASK("approved under a wrong goal"))
  const deps = depsFor(dir)
  const d = await detail(deps, "queued", "ccc3-thing")

  const res = await save(deps, "queued", "ccc3-thing", bodyFrom(d, { title: "the real goal", reason: "wrong screen\n\nsee the mock in #12" }))
  assert.equal(res.status, 200)
  const file = read(dir, "draft", "ccc3-thing")
  const stamped = /^> .*\[[^\]\n]+\]\s*$/ // core's AUDIT_NOTE_LINE_RE
  const notes = file.split("\n").filter((l) => l.startsWith("> "))
  assert.equal(notes.length, 2, "the edit note and the retask note, one line each")
  for (const note of notes) assert.match(note, stamped, `note keeps its stamp on its own line: ${note}`)
  assert.ok(
    notes.every((n) => n.includes("wrong screen see the mock in #12")),
    "and both carry the whole reason, flattened",
  )
  assert.ok(
    !file.split("\n").some((l) => l.includes("see the mock in #12") && !l.startsWith("> ")),
    "no fragment of the reason escaped into the prose",
  )
  cleanup(dir)
})

// --- refusals: the file must be untouched every time ---

test("a claimed task is refused and its file is left exactly as it was", async () => {
  const dir = makeRepo()
  place(dir, "queued", "bbb2-thing", TASK("claimed"))
  const deps = depsFor(dir)
  const d = await detail(deps, "queued", "bbb2-thing")
  const before = read(dir, "queued", "bbb2-thing")
  // A claim marker in a pool status: something is driving this task right now.
  fs.mkdirSync(path.join(dir, "docs", "tasks", "queued", ".claims", "bbb2-thing"), { recursive: true })

  const res = await save(deps, "queued", "bbb2-thing", bodyFrom(d, { title: "nope" }))
  assert.equal(res.status, 200, "a refusal is a domain outcome, not a transport error")
  const out = res.body as SaveTaskResponse
  assert.equal(out.ok, false)
  assert.match(!out.ok ? out.message : "", /live loop/i)
  assert.equal(read(dir, "queued", "bbb2-thing"), before, "the pre-check runs before the rewrite")
  cleanup(dir)
})

test("a stale board 409s and names nothing it did not do", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("moved on"))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")
  // The loop approved it out from under the open drawer.
  await postGate(deps, {
    params: { action: "approve-task" },
    query: new URLSearchParams(),
    body: { id: "aaa1-thing", expectStatus: "draft" },
  })

  const res = await save(deps, "draft", "aaa1-thing", bodyFrom(d, { title: "too late" }))
  assert.equal(res.status, 409)
  assert.ok(!read(dir, "queued", "aaa1-thing").includes("too late"))
  cleanup(dir)
})

test("a plan that appeared under the editor 409s rather than being overwritten", async () => {
  const dir = makeRepo()
  place(dir, "queued", "bbb2-thing", TASK("planless for now"))
  const deps = depsFor(dir)
  const d = await detail(deps, "queued", "bbb2-thing")
  // A live PLAN stage writes its plan into the queued file mid-edit.
  fs.appendFileSync(filePath(dir, "queued", "bbb2-thing"), "\n## Implementation Plan\n\n1. Step.\n")
  const before = read(dir, "queued", "bbb2-thing")

  const res = await save(deps, "queued", "bbb2-thing", bodyFrom(d, { title: "clobber" }))
  assert.equal(res.status, 409)
  assert.match((res.body as { error: string }).error, /plan/i)
  assert.equal(read(dir, "queued", "bbb2-thing"), before, "the loop's artifact is intact")
  cleanup(dir)
})

test("prose that drifted on disk 409s — the lost-update guard", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("original"))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")
  // Something else rewrote the body while the human was typing.
  place(dir, "draft", "aaa1-thing", TASK("original", { body: "Rewritten by someone else." }))

  const res = await save(deps, "draft", "aaa1-thing", bodyFrom(d, { body: "my version" }))
  assert.equal(res.status, 409)
  assert.match((res.body as { error: string }).error, /changed on disk/)
  assert.match(read(dir, "draft", "aaa1-thing"), /Rewritten by someone else\./)
  cleanup(dir)
})

test("an edit that would delete an interleaved audit note 409s and names it", async () => {
  const dir = makeRepo()
  // A note ABOVE later prose is not in the trailing run, so it does reach the editor.
  const note = "> BUILD started [2026-07-01T10:00:00.000Z by alice]"
  place(dir, "draft", "aaa1-thing", TASK("interleaved", { body: `Intro.\n${note}\nMore prose.` }))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")
  assert.ok(d.editable?.prose.includes(note), "it is editable, hence deletable")

  const res = await save(deps, "draft", "aaa1-thing", bodyFrom(d, { body: "Intro.\nMore prose." }))
  assert.equal(res.status, 409)
  assert.match((res.body as { error: string }).error, /audit note/)
  assert.ok(read(dir, "draft", "aaa1-thing").includes(note), "the trail is intact")
  cleanup(dir)
})

test("frontmatter the editor cannot preserve 409s instead of being silently stripped", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("has extras").replace("type: feature", "type: feature\nsprint: 42"))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")

  const res = await save(deps, "draft", "aaa1-thing", bodyFrom(d, { title: "renamed" }))
  assert.equal(res.status, 409)
  assert.match((res.body as { error: string }).error, /sprint/)
  assert.match(read(dir, "draft", "aaa1-thing"), /sprint: 42/, "the unknown key is still there")
  cleanup(dir)
})

test("a secret in the body is refused rather than committed", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("clean"))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")

  const res = await save(deps, "draft", "aaa1-thing", {
    ...bodyFrom(d),
    body: "use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-AAAAAA to run it",
  })
  assert.equal(res.status, 200)
  const out = res.body as SaveTaskResponse
  assert.equal(out.ok, false)
  assert.match(!out.ok ? out.message : "", /secret/i)
  assert.ok(!read(dir, "draft", "aaa1-thing").includes("sk-ant-api03"), "nothing written")
  cleanup(dir)
})

// --- validation: nothing may reach the filesystem ---

test("a non-editable status is a 400, not a refusal to be retried", async () => {
  const dir = makeRepo()
  place(dir, "plan-review", "ddd4-thing", TASK("parked", { plan: true }))
  const deps = depsFor(dir)

  const res = await save(deps, "plan-review", "ddd4-thing", {
    expectStatus: "plan-review",
    baseHash: "x",
    title: "nope",
    priority: 1,
    labels: [],
    acceptance: [],
    body: "",
  })
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /not editable/)
  cleanup(dir)
})

test("malformed save requests are rejected with nothing written", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("guarded"))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")
  const before = read(dir, "draft", "aaa1-thing")

  const cases: Array<[string, unknown, string]> = [
    ["missing title", { ...bodyFrom(d), title: "" }, "draft"],
    ["acceptance is not an array", { ...bodyFrom(d), acceptance: "it works" }, "draft"],
    ["a newline in an acceptance item", { ...bodyFrom(d), acceptance: ["line one\nline two"] }, "draft"],
    ["an oversized body", { ...bodyFrom(d), body: "x".repeat(100_001) }, "draft"],
    ["expectStatus disagreeing with the path", { ...bodyFrom(d), expectStatus: "queued" }, "draft"],
  ]
  for (const [name, body, status] of cases) {
    const res = await save(deps, status, "aaa1-thing", body)
    assert.equal(res.status, 400, `${name} should be a 400`)
  }
  // A traversal id must not even reach findByIdIn.
  assert.equal((await save(deps, "draft", "../../etc/passwd", bodyFrom(d))).status, 400)
  assert.equal(read(dir, "draft", "aaa1-thing"), before, "no malformed request touched the file")
  cleanup(dir)
})

// --- concurrency: the save shares the gate's lock ---

test("a save and a gate move on the same task are serialized, and the loser 409s", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing", TASK("contended"))
  const deps = depsFor(dir)
  const d = await detail(deps, "draft", "aaa1-thing")

  const [saved, gated] = await Promise.all([
    save(deps, "draft", "aaa1-thing", bodyFrom(d, { title: "edited" })),
    postGate(deps, {
      params: { action: "approve-task" },
      query: new URLSearchParams(),
      body: { id: "aaa1-thing", expectStatus: "draft" },
    }),
  ])
  // Whichever ran second saw the other's result; both succeeding would mean the
  // edit landed on a task that had already been approved out of draft/.
  const statuses = [saved.status, gated.status].sort()
  assert.ok(
    statuses[0] === 200 && (statuses[1] === 200 || statuses[1] === 409),
    `expected a serialized pair, got ${saved.status}/${gated.status}`,
  )
  if (saved.status === 409) assert.ok(at(dir, "queued", "aaa1-thing"), "the gate won and the edit stood down")
  cleanup(dir)
})
