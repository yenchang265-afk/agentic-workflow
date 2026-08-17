import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DEPS_FENCE,
  MAX_DECLARED_DEPS,
  dependencyContractBlock,
  depsSummaryLine,
  hasDepsFence,
  parseDeclaredDeps,
  previewDeclaredDeps,
  unverifiedDepsCaveat,
} from "./declared-deps.js"

/** A plan carrying `json` in an agentic-deps fence, with the usual prose around it. */
const planWith = (json: string): string =>
  ["## Implementation Plan", "", "### Dependencies", "- prose a human reads", "", "```agentic-deps", json, "```", ""].join("\n")

const existing = { name: "zod", ecosystem: "npm", version: "3.23.8", status: "existing", evidence: "pnpm-lock.yaml:1204" }
const unproven = { name: "p-retry", ecosystem: "npm", status: "unverified", evidence: "not in the lockfile; mirror unreachable" }

test("parseDeclaredDeps returns nothing for a plan with no fence, and says nothing about it", () => {
  const plan = "## Implementation Plan\n\n### Steps\n1. do the thing\n"
  assert.deepEqual(parseDeclaredDeps(plan), { deps: [], issues: [] })
  assert.equal(hasDepsFence(plan), false)
  // `null`, not an empty preview: most tasks add no dependency, and a line on
  // every one of them would train the reader to skip the whole park suffix.
  assert.equal(previewDeclaredDeps(plan), null)
  assert.equal(depsSummaryLine(previewDeclaredDeps(plan)), "")
})

test("an empty fence is NOT the same as an absent one", () => {
  const plan = planWith("[]")
  assert.equal(hasDepsFence(plan), true)
  const preview = previewDeclaredDeps(plan)
  assert.equal(preview?.fencePresent, true)
  // The distinction the whole `hasDepsFence` helper exists for: "considered and
  // adds none" must be legible as such, where an absent fence renders nothing.
  assert.match(depsSummaryLine(preview), /none declared/)
})

test("parseDeclaredDeps reads a well-formed block and counts by status", () => {
  const plan = planWith(JSON.stringify([existing, { ...unproven, status: "new", registry: "nexus.corp/npm-group" }]))
  const { deps, issues } = parseDeclaredDeps(plan)
  assert.equal(issues.length, 0)
  assert.equal(deps.length, 2)
  const preview = previewDeclaredDeps(plan)
  assert.equal(preview?.existing, 1)
  assert.equal(preview?.added, 1)
  assert.equal(preview?.unverified.length, 0)
  assert.equal(preview?.registryCited, true)
})

test("an unverified entry is named in the summary, not merely counted", () => {
  const line = depsSummaryLine(previewDeclaredDeps(planWith(JSON.stringify([existing, unproven]))))
  assert.match(line, /1 existing/)
  assert.match(line, /1 UNVERIFIED/)
  // Naming it is the entire point: a count sends the human back to the file.
  assert.match(line, /p-retry/)
  assert.match(line, /mirror unreachable/)
})

test("a new dependency with no registry cited is reported even when nothing is unverified", () => {
  const line = depsSummaryLine(previewDeclaredDeps(planWith(JSON.stringify([{ ...existing, status: "new" }]))))
  // A plan that added a package without reading where this repo resolves from
  // reasoned about the public registry — undetectable at the gate otherwise.
  assert.match(line, /no registry cited/)
})

test("malformed JSON degrades to zero deps plus an issue, never a throw", () => {
  const { deps, issues } = parseDeclaredDeps(planWith("[{ not json"))
  assert.deepEqual(deps, [])
  assert.equal(issues.length, 1)
  assert.match(issues[0] ?? "", new RegExp(`${DEPS_FENCE} block is not valid JSON`))
  assert.match(depsSummaryLine(previewDeclaredDeps(planWith("[{ not json"))), /1 malformed/)
})

test("a block that does not match the shape is refused whole", () => {
  const { deps, issues } = parseDeclaredDeps(planWith(JSON.stringify([{ name: "x" }])))
  assert.deepEqual(deps, [])
  assert.match(issues[0] ?? "", /does not match the dependency shape/)
})

test("an unknown status is refused rather than coerced", () => {
  const { deps, issues } = parseDeclaredDeps(planWith(JSON.stringify([{ ...existing, status: "probably-fine" }])))
  assert.deepEqual(deps, [])
  assert.equal(issues.length, 1)
})

test("a hostile name is refused by the character class, not sanitized", () => {
  // Rejected rather than rewritten: a silently altered package name in a gate
  // line is a worse artifact than an absent one.
  for (const name of ["pkg\nmalicious", "pkg`whoami`", "pkg $(id)", ""]) {
    const { deps } = parseDeclaredDeps(planWith(JSON.stringify([{ ...existing, name }])))
    assert.deepEqual(deps, [], `"${name}" must not survive the parse`)
  }
})

test("evidence and registry are flattened at the parse, so the audit note stays one line", () => {
  const plan = planWith(
    JSON.stringify([{ ...unproven, evidence: "line one\nline two\r\nline three", registry: "nexus\n.corp" }]),
  )
  const { deps } = parseDeclaredDeps(plan)
  // A newline here detaches the audit note's bracketed stamp, after which
  // AUDIT_NOTE_LINE_RE stops matching and every last-note parser goes blind.
  assert.doesNotMatch(deps[0]?.evidence ?? "x", /[\r\n]/)
  assert.doesNotMatch(deps[0]?.registry ?? "x", /[\r\n]/)
  assert.doesNotMatch(depsSummaryLine(previewDeclaredDeps(plan)), /[\r\n]/)
})

test("a backtick in evidence cannot break the message's own delimiters", () => {
  const { deps } = parseDeclaredDeps(planWith(JSON.stringify([{ ...unproven, evidence: "see `x` and `y`" }])))
  assert.doesNotMatch(deps[0]?.evidence ?? "x", /`/)
})

test("duplicates are dropped per ecosystem, not per bare name", () => {
  const plan = planWith(
    JSON.stringify([
      existing,
      existing,
      { ...existing, ecosystem: "pypi" },
    ]),
  )
  const { deps, issues } = parseDeclaredDeps(plan)
  // Same name on two ecosystems is two different packages; collapsing them
  // would hide one behind the other in the very line this block produces.
  assert.equal(deps.length, 2)
  assert.equal(issues.length, 1)
  assert.match(issues[0] ?? "", /duplicate name for ecosystem/)
})

test("more than MAX_DECLARED_DEPS entries drop with a reason each", () => {
  const many = Array.from({ length: MAX_DECLARED_DEPS + 2 }, (_, i) => ({ ...existing, name: `pkg-${i}` }))
  const { deps, issues } = parseDeclaredDeps(planWith(JSON.stringify(many)))
  assert.equal(deps.length, MAX_DECLARED_DEPS)
  assert.equal(issues.length, 2)
})

test("the summary names at most three unverified packages, then counts the rest", () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ ...unproven, name: `pkg-${i}`, evidence: "" }))
  const line = depsSummaryLine(previewDeclaredDeps(planWith(JSON.stringify(five))))
  assert.match(line, /5 UNVERIFIED/)
  assert.match(line, /\+2 more/)
  // The suffix shares one `> …` line with the checks forecast.
  assert.ok(line.length < 400, `summary should stay short, got ${line.length}`)
})

test("the LAST fence wins, matching the stacked-plan-heading rule", () => {
  const plan = `${planWith(JSON.stringify([existing]))}\n${planWith(JSON.stringify([unproven]))}`
  const { deps } = parseDeclaredDeps(plan)
  assert.equal(deps.length, 1)
  assert.equal(deps[0]?.name, "p-retry")
})

test("the fence parses wherever it sits, not only under a ### Dependencies heading", () => {
  // The section is a human-readability convention; the fence is the artifact.
  const plan = `## Implementation Plan\n\n### Steps\n1. x\n\n\`\`\`agentic-deps\n${JSON.stringify([existing])}\n\`\`\`\n`
  assert.equal(parseDeclaredDeps(plan).deps.length, 1)
})

test("unverifiedDepsCaveat speaks only when the plan could not establish something", () => {
  assert.equal(unverifiedDepsCaveat("## Implementation Plan\n"), undefined)
  assert.equal(unverifiedDepsCaveat(planWith(JSON.stringify([existing]))), undefined)
  const caveat = unverifiedDepsCaveat(planWith(JSON.stringify([unproven])))
  assert.match(caveat ?? "", /1 dependency it could not establish/)
  assert.match(caveat ?? "", /p-retry/)
  // Never the word "verified" about a self-report — the plan is an account, not
  // a probe, and the gate line must not launder one into the other.
  assert.doesNotMatch(caveat ?? "", /\bverified\b/)
})

test("the caveat pluralizes rather than emitting dependency/dependencies", () => {
  const two = unverifiedDepsCaveat(planWith(JSON.stringify([unproven, { ...unproven, name: "left-pad" }])))
  assert.match(two ?? "", /2 dependencies it could not establish/)
})

test("the contract block asks for the fence by name, spelled out, never rendered", () => {
  const block = dependencyContractBlock("plan")
  assert.match(block, /DEPENDENCY CONTRACT/)
  assert.match(block, /### Dependencies/)
  assert.match(block, new RegExp(`info string is exactly ${DEPS_FENCE}`))
  // A rendered fence inside the instruction either opens a fence in the prompt
  // or leaves a stray backtick beside the name; a model copying the stray one
  // produces an info string FENCE_RE never matches — zero deps, no warning.
  assert.doesNotMatch(block, /```/)
  // Names the sources to READ, never a table of what to expect to find.
  assert.match(block, /\.npmrc/)
  assert.match(block, /lockfile/)
  // The rule the whole design exists for.
  assert.match(block, /CITE, NEVER REMEMBER/)
})

test("the contract tells the author to declare what it could not prove, not to ask", () => {
  const block = dependencyContractBlock("plan")
  // A stage subagent cannot ask: `question` is denied on every host, and a
  // drive is unattended between the plan gate and the ship gate.
  assert.doesNotMatch(block, /ask the (user|human)/i)
  assert.match(block, /unverified/)
})
