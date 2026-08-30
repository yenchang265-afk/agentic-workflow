import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

/**
 * AGENTS.md loads on every session of every host, so the engineering invariants
 * live in two halves: a one-line constraint in its index, and the reasoning in
 * `docs/invariants/<file>.md`. Either half alone fails silently — an index line
 * with no section behind it is a rule nobody can check the reasoning of before
 * "fixing" it back, and a section no index line points at is a rule no session
 * ever sees.
 *
 * The halves are joined by the section TITLE, which is also how the design
 * records under `docs/design/` cite these rules ("AGENTS.md 'A stale window is a
 * proxy'"). So the title is a contract: these tests hold every section title
 * present verbatim in the index, and every file reachable from it.
 */

const ROOT = path.join(import.meta.dirname, "..")
const INVARIANTS = path.join(ROOT, "docs", "invariants")
/** Markdown wraps a long title across lines, so both sides compare whitespace-flat. */
const flat = (s) => s.replace(/\s+/g, " ").trim()
const agents = flat(fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"))

/** Every invariant file, README excluded — that one is the directory's own index. */
const invariantFiles = () =>
  fs
    .readdirSync(INVARIANTS)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()

const sectionTitles = (file) =>
  fs
    .readFileSync(path.join(INVARIANTS, file), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim())

test("every invariant section carries a one-line constraint in the AGENTS.md index", () => {
  const offences = []
  for (const file of invariantFiles()) {
    for (const title of sectionTitles(file)) {
      if (!agents.includes(flat(title)))
        offences.push(`docs/invariants/${file} → "${title}" has no line in the AGENTS.md index`)
    }
  }
  assert.deepEqual(offences, [], `index lines missing:\n${offences.join("\n")}`)
})

test("the AGENTS.md index points at every invariant file, and every file it points at exists", () => {
  const linked = new Set([...agents.matchAll(/docs\/invariants\/([a-z0-9-]+\.md)/g)].map((m) => m[1]))
  const onDisk = new Set(invariantFiles())
  const unlinked = [...onDisk].filter((f) => !linked.has(f))
  const dangling = [...linked].filter((f) => !fs.existsSync(path.join(INVARIANTS, f)))
  assert.deepEqual(unlinked, [], `invariant files no index line reaches: ${unlinked.join(", ")}`)
  assert.deepEqual(dangling, [], `index points at missing files: ${dangling.join(", ")}`)
})

test("the invariants stay out of AGENTS.md itself", () => {
  // A section moved back inline is the split undone: it reintroduces the
  // per-session cost the index exists to remove, and leaves two copies to drift.
  const inlined = invariantFiles()
    .flatMap((file) => sectionTitles(file).map((title) => ({ file, title })))
    .filter(({ title }) => agents.includes(flat(`### ${title}`)))
    .map(({ file, title }) => `"${title}" is inline in AGENTS.md as well as in docs/invariants/${file}`)
  assert.deepEqual(inlined, [], `duplicated sections:\n${inlined.join("\n")}`)
})
