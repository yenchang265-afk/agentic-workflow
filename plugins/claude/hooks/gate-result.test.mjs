import assert from "node:assert/strict"
import { test } from "node:test"
import { decideGateOutcome, missingDistMessage } from "./gate-result.mjs"

/**
 * The gate hook's outcome decision. The regression this pins: a missing
 * mcp-server/dist (plugin never built) used to fall into the "gate ran and
 * refused" branch — node exits 1 with MODULE_NOT_FOUND on stderr and an empty
 * stdout — producing the useless "Gate … failed — see the backlog" block
 * while the documented fail-open never triggered and the MCP fallback was
 * equally dead. Now: missing dist blocks with the actionable diagnosis, and a
 * crash without a GateResult fails open.
 */

const LABEL = "approve-any f7k3"

test("missing dist blocks with the not-built diagnosis, never the vague failure", () => {
  const o = decideGateOutcome({ distExists: false }, LABEL)
  assert.equal(o.action, "block")
  assert.equal(o.ok, false)
  assert.ok(o.message.includes("install.sh"), o.message)
  assert.ok(o.message.includes(LABEL), o.message)
  assert.equal(o.message, missingDistMessage(LABEL))
})

test("a spawn error (node itself could not run) fails open", () => {
  assert.deepEqual(decideGateOutcome({ distExists: true, spawnError: new Error("ENOENT"), status: null, stdout: "" }, LABEL), {
    action: "pass",
  })
  assert.deepEqual(decideGateOutcome({ distExists: true, status: undefined, stdout: "" }, LABEL), { action: "pass" })
})

test("a crash without a GateResult (exit 1, empty stdout) fails open", () => {
  assert.deepEqual(decideGateOutcome({ distExists: true, status: 1, stdout: "" }, LABEL), { action: "pass" })
  assert.deepEqual(decideGateOutcome({ distExists: true, status: 1, stdout: "some stack trace\nnot json" }, LABEL), {
    action: "pass",
  })
})

test("a parsed GateResult blocks with its verdict — success and refusal alike", () => {
  const okLine = JSON.stringify({ ok: true, message: "Task approved — queued." })
  assert.deepEqual(decideGateOutcome({ distExists: true, status: 0, stdout: `noise\n${okLine}\n` }, LABEL), {
    action: "block",
    message: "Task approved — queued.",
    ok: true,
  })
  const refusal = JSON.stringify({ ok: false, message: "No task found." })
  assert.deepEqual(decideGateOutcome({ distExists: true, status: 1, stdout: refusal }, LABEL), {
    action: "block",
    message: "No task found.",
    ok: false,
  })
})

test("a silent clean exit blocks with the generic done message", () => {
  assert.deepEqual(decideGateOutcome({ distExists: true, status: 0, stdout: "" }, LABEL), {
    action: "block",
    message: `Gate ${LABEL} done.`,
    ok: true,
  })
})
