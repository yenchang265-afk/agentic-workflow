import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

/**
 * Every host parses a skill's frontmatter as YAML before the body is ever
 * read, so a description carrying an unquoted ": " is not a style problem —
 * the block fails to parse ("mapping values are not allowed here") and the
 * skill silently drops out of the library. It has happened twice
 * (`plan-router`, `doubt-driven-development`), both times from natural prose
 * ("Use when X: a, b, c"). No YAML parser lives in this repo's dependency
 * tree, so these tests hold the frontmatter to the one shape every host
 * accepts — single-line plain scalars — and reject the constructs that break
 * it, rather than round-tripping through a real parser.
 */

const ROOT = path.join(import.meta.dirname, "..")
const SKILLS = path.join(ROOT, "skills")

const skillFiles = () =>
  fs
    .readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, file: path.join(SKILLS, e.name, "SKILL.md") }))
    .filter((s) => fs.existsSync(s.file))

/** The frontmatter block, or null when the file doesn't open with one. */
const frontmatter = (raw) => {
  const m = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  return m ? m[1].split("\n") : null
}

test("every skill opens with a frontmatter block carrying name and description", () => {
  const offences = []
  for (const skill of skillFiles()) {
    const lines = frontmatter(fs.readFileSync(skill.file, "utf8"))
    if (!lines) {
      offences.push(`skills/${skill.name}/SKILL.md does not open with a ----fenced frontmatter block`)
      continue
    }
    const entries = new Map()
    lines.forEach((line) => {
      const m = line.match(/^([A-Za-z][\w-]*):(?: |$)/)
      if (m) entries.set(m[1], line.slice(m[0].length))
    })
    if (!entries.has("name")) offences.push(`skills/${skill.name}/SKILL.md frontmatter has no name entry`)
    else if (entries.get("name") !== skill.name)
      offences.push(`skills/${skill.name}/SKILL.md frontmatter name "${entries.get("name")}" does not match its directory`)
    if (!entries.get("description")) offences.push(`skills/${skill.name}/SKILL.md frontmatter has no description entry`)
  }
  assert.deepEqual(offences, [], `frontmatter structure:\n${offences.join("\n")}`)
})

test("no unquoted frontmatter value contains the constructs YAML rejects in a plain scalar", () => {
  const offences = []
  for (const skill of skillFiles()) {
    const lines = frontmatter(fs.readFileSync(skill.file, "utf8")) ?? []
    lines.forEach((line, i) => {
      const m = line.match(/^[A-Za-z][\w-]*: (.*)$/)
      if (!m) {
        // Anything but a single-line `key: value` entry — a bare key, a list
        // item, a block-scalar header — is a shape no host is known to accept.
        offences.push(`skills/${skill.name}/SKILL.md frontmatter line ${i + 1} is not a single-line \`key: value\` entry: "${line}"`)
        return
      }
      const value = m[1]
      if (/^["']/.test(value)) return // quoted scalars may carry anything
      const where = `skills/${skill.name}/SKILL.md frontmatter line ${i + 1}`
      if (value.includes(": ") || value.endsWith(":"))
        offences.push(`${where} has an unquoted ":" in its value — YAML reads it as a nested mapping; use an em dash or quote the value`)
    })
  }
  assert.deepEqual(offences, [], `frontmatter plain-scalar violations:\n${offences.join("\n")}`)
})
