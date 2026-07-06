import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, FileNode } from "../host.js"
import { auditBacklog, formatAnomalies, hasAnomalies } from "./audit.js"

/** Fake client over an in-memory tree: rel dir path -> entries. */
const makeClient = (tree: Record<string, { name: string; type: "file" | "directory" }[]>): Client => ({
  file: {
    list: async ({ query }) => {
      const entries = tree[query.path]
      if (!entries) throw new Error(`no such dir: ${query.path}`)
      const nodes: FileNode[] = entries.map((e) => ({
        ...e,
        path: `${query.path}/${e.name}`,
        absolute: `/r/${query.path}/${e.name}`,
      }))
      return { data: nodes }
    },
    read: async () => ({ data: null }),
  },
  app: { log: async () => ({}) },
})

const f = (name: string) => ({ name, type: "file" as const })
const d = (name: string) => ({ name, type: "directory" as const })

test("auditBacklog reports a clean backlog as anomaly-free", async () => {
  const client = makeClient({
    "docs/tasks": [d("draft"), d("queued"), d("in-progress"), d("runs"), f("README.txt")],
    "docs/tasks/draft": [f("a.md")],
    "docs/tasks/queued": [f("b.md")],
    "docs/tasks/in-progress": [f("c.md"), d(".claims")],
  })
  const a = await auditBacklog(client, "/r", "docs/tasks")
  assert.deepEqual(a, { unknownDirs: [], strayFiles: [], duplicates: [] })
  assert.equal(hasAnomalies(a), false)
})

test("auditBacklog flags unknown dirs and the stray .md files inside them", async () => {
  const client = makeClient({
    "docs/tasks": [d("draft"), d("run"), d("wip")],
    "docs/tasks/draft": [],
    "docs/tasks/run": [f("lost.md"), f("notes.txt")],
    "docs/tasks/wip": [],
  })
  const a = await auditBacklog(client, "/r", "docs/tasks")
  assert.deepEqual(a.unknownDirs, ["run", "wip"])
  assert.deepEqual(a.strayFiles, ["docs/tasks/run/lost.md"])
})

test("auditBacklog flags .md files at the backlog root and ignores hidden root dirs", async () => {
  const client = makeClient({
    "docs/tasks": [d("draft"), d(".claims"), f("orphan.md")],
    "docs/tasks/draft": [],
  })
  const a = await auditBacklog(client, "/r", "docs/tasks")
  assert.deepEqual(a.unknownDirs, [])
  assert.deepEqual(a.strayFiles, ["docs/tasks/orphan.md"])
})

test("auditBacklog flags one id living in several status folders", async () => {
  const client = makeClient({
    "docs/tasks": [d("draft"), d("completed")],
    "docs/tasks/draft": [f("dup.md"), f("only-here.md")],
    "docs/tasks/completed": [f("dup.md")],
  })
  const a = await auditBacklog(client, "/r", "docs/tasks")
  assert.deepEqual(a.duplicates, [{ id: "dup", statuses: ["draft", "completed"] }])
  assert.equal(hasAnomalies(a), true)
})

test("auditBacklog tolerates a missing backlog dir entirely", async () => {
  const a = await auditBacklog(makeClient({}), "/r", "docs/tasks")
  assert.equal(hasAnomalies(a), false)
})

test("formatAnomalies renders one line per finding", () => {
  const lines = formatAnomalies(
    {
      unknownDirs: ["run"],
      strayFiles: ["docs/tasks/run/lost.md"],
      duplicates: [{ id: "dup", statuses: ["draft", "completed"] }],
    },
    "docs/tasks",
  )
  assert.equal(lines.length, 3)
  assert.match(lines[0]!, /unknown folder docs\/tasks\/run\//)
  assert.match(lines[1]!, /stray task file docs\/tasks\/run\/lost\.md/)
  assert.match(lines[2]!, /duplicate task "dup" in draft, completed/)
})
