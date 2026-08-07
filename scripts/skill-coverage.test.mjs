import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

/**
 * Feature-coverage parity between the two workflow-orchestration skills.
 *
 * The OpenCode copy (skills/workflow-orchestration/SKILL.md) is hand-authored;
 * the Claude/Qwen copies are generated from
 * prompts/skills/workflow-orchestration/SKILL.md. They deliberately differ in
 * wording and dispatch mechanics, but every LOOP-PROTOCOL feature must appear
 * in BOTH — commits #232/#234 updated only the OpenCode copy, so the Claude
 * and Qwen orchestrators had no branch for the plan-contract park refusal and
 * improvised. Wording may drift; coverage may not.
 *
 * Each entry names a feature and a regex both documents must match. Add a row
 * when a protocol feature lands; a row failing on one side means that side's
 * document was forgotten.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencodeSkill = fs.readFileSync(path.join(ROOT, "skills", "workflow-orchestration", "SKILL.md"), "utf8")
const promptsSkill = fs.readFileSync(path.join(ROOT, "prompts", "skills", "workflow-orchestration", "SKILL.md"), "utf8")

const FEATURES = [
  { name: "replan reason threaded into the next PLAN pass (#232)", re: /Rejection reason from the plan gate/ },
  { name: "plan contract: ### Verification park refusal (#234)", re: /### Verification/ },
  { name: "plan-contract refusal recorded as a rejection the retry reads", re: /refus\w+[\s\S]{0,600}?(rejection note|reason)/i },
  { name: "three consecutive refusals return the task to draft/", re: /three consecutive refusals[\s\S]{0,200}?draft\// },
  { name: "the plan gate parks in plan-review/", re: /plan-review\// },
  { name: "verdicts ride workflow_verdict, never prose", re: /workflow_verdict/ },
]

for (const feature of FEATURES) {
  test(`both skills cover: ${feature.name}`, () => {
    assert.match(opencodeSkill, feature.re, "missing from skills/workflow-orchestration/SKILL.md (OpenCode copy)")
    assert.match(promptsSkill, feature.re, "missing from prompts/skills/workflow-orchestration/SKILL.md (Claude/Qwen source)")
  })
}
