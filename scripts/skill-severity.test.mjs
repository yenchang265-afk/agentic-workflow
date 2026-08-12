import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

/**
 * The REVIEW persona's severity ladder is distilled from
 * `skills/code-review-and-quality/SKILL.md` (its `## Severity` table is the
 * SSOT), and the specialist skills it still invokes conditionally
 * (`security-and-hardening`, `performance-optimization`) can each teach a
 * severity of their own — which the agent then feeds to `workflow_verdict`.
 * The tool accepts exactly three (`Severity` in
 * packages/core/src/workflow/verdict.ts), and a call carrying a fourth is
 * rejected whole — which the loop records as a FAIL on a diff that may be
 * clean.
 *
 * So a skill naming its own severity scale is not a style question, it is a
 * live break. These tests hold the vocabulary to one word list and keep its
 * definitions in one file.
 */

const ROOT = path.join(import.meta.dirname, "..")
const SKILLS = path.join(ROOT, "skills")

/** The only severities `workflow_verdict` accepts. Mirrors verdict.ts `Severity`. */
const ALLOWED = ["critical", "important", "suggestion"]

/** The file that owns what each severity *means* — every other skill points here. */
const SSOT = "code-review-and-quality"

/**
 * Scales retired in favour of ALLOWED. Matched case-sensitively and as whole
 * words: the retired security scale was written in caps (`**HIGH**`), and
 * lower-case "high"/"low" are ordinary English that appears all over the
 * library ("high cohesion", "low coupling").
 */
const RETIRED = [
  { token: "Nit", pattern: /\bNits?\b/g, use: "suggestion" },
  { token: "FYI", pattern: /\bFYI\b/g, use: "nothing — an informational comment requiring no action should not be written" },
  { token: "CRITICAL", pattern: /\bCRITICAL\b/g, use: "critical" },
  { token: "HIGH", pattern: /\bHIGH\b/g, use: "critical" },
  { token: "MEDIUM", pattern: /\bMEDIUM\b/g, use: "important" },
  { token: "LOW", pattern: /\bLOW\b/g, use: "suggestion" },
]

const skillFiles = () =>
  fs
    .readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, file: path.join(SKILLS, e.name, "SKILL.md") }))
    .filter((s) => fs.existsSync(s.file))

test("no skill teaches a severity outside the three workflow_verdict accepts", () => {
  const offences = []
  for (const skill of skillFiles()) {
    const lines = fs.readFileSync(skill.file, "utf8").split("\n")
    lines.forEach((line, i) => {
      for (const { token, pattern, use } of RETIRED) {
        pattern.lastIndex = 0
        if (pattern.test(line)) offences.push(`skills/${skill.name}/SKILL.md:${i + 1} says "${token}" — use "${use}"`)
      }
    })
  }
  assert.deepEqual(offences, [], `retired severity vocabulary found:\n${offences.join("\n")}`)
})

test("the severity scale is defined in exactly one skill", () => {
  const definers = skillFiles().filter((s) => /^##+ Severity\b/m.test(fs.readFileSync(s.file, "utf8")) && s.name !== SSOT)
  for (const skill of definers) {
    const body = fs.readFileSync(skill.file, "utf8")
    assert.match(
      body,
      new RegExp(SSOT),
      `skills/${skill.name}/SKILL.md has a Severity section but never points at \`${SSOT}\` — the definitions must live in one place`,
    )
  }
})

test("the owning skill names all three severities", () => {
  const body = fs.readFileSync(path.join(SKILLS, SSOT, "SKILL.md"), "utf8")
  assert.match(body, /^##+ Severity\b/m, `skills/${SSOT}/SKILL.md must carry the \`## Severity\` section other skills point at`)
  for (const severity of ALLOWED) {
    assert.match(body, new RegExp(`\\b${severity}\\b`), `skills/${SSOT}/SKILL.md must define \`${severity}\``)
  }
})

test("the review persona's inlined ladder cites its SSOT and names all three severities", () => {
  // The REVIEW persona no longer loads the skill per pass — it carries a
  // distilled ladder inline. That copy must keep citing the owning skill (so a
  // future edit knows where the definitions live) and must never drift off the
  // three severities workflow_verdict accepts.
  const persona = fs.readFileSync(path.join(ROOT, "prompts", "agents", "workflow-review", "body.md"), "utf8")
  assert.match(persona, new RegExp(SSOT), `the persona must cite skills/${SSOT}/SKILL.md as the severity SSOT`)
  for (const severity of ALLOWED) {
    assert.match(persona, new RegExp(`\\b${severity}\\b`), `the persona's inlined ladder must name \`${severity}\``)
  }
  for (const { token, pattern, use } of RETIRED) {
    pattern.lastIndex = 0
    assert.equal(pattern.test(persona), false, `the persona says "${token}" — use "${use}"`)
  }
})
