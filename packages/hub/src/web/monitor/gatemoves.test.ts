import assert from "node:assert/strict"
import { test } from "node:test"
import { cancellationMoves, forwardMoves, type Move } from "./gatemoves.js"

/**
 * The rules about which button appears where. They live in a plain module for
 * exactly this reason: there is no DOM harness in this package, so a rule
 * expressed only inside JSX could not be tested at all.
 */

const labels = (moves: readonly Move[]): string[] => moves.map((m) => m.label)

test("a queued task offers Plan, and a requested one offers its withdrawal instead", () => {
  // One control in two states, not two buttons: a task either carries a request
  // or it doesn't, and offering both would ask the user to pick between them.
  const fresh = forwardMoves("queued", {})
  assert.deepEqual(labels(fresh), ["Plan"])
  assert.equal(fresh[0]?.endpoint, "/api/plan-request")

  const asked = forwardMoves("queued", { planRequested: true })
  assert.deepEqual(labels(asked), ["Cancel plan request"])
  assert.equal(asked[0]?.endpoint, "/api/plan-request/cancel")
})

test("the Plan button's copy promises no execution — the hub starts nothing itself", () => {
  const plan = forwardMoves("queued", {})[0]
  assert.match(plan?.detail ?? "", /No file moves, no git commit/)
  assert.match(plan?.detail ?? "", /Nothing runs until a watcher or a claim picks the task up/)
  assert.match(plan?.detail ?? "", /build-ready work in in-progress\/ is still claimed first/)
  assert.equal(plan?.danger, undefined, "asking for a plan is not a destructive act")
})

test("every other column's forward moves are unchanged", () => {
  // A regression snapshot: adding `endpoint` to Move touched the one component
  // all three call sites share, so the rest of the board has to be pinned.
  assert.deepEqual(labels(forwardMoves("draft")), ["Approve"])
  assert.deepEqual(labels(forwardMoves("plan-review")), ["Approve plan", "Replan"])
  assert.deepEqual(labels(forwardMoves("in-progress")), ["Replan"])
  assert.deepEqual(labels(forwardMoves("in-review")), ["Ship"])
  assert.deepEqual(labels(forwardMoves("completed")), [], "a status with no entry gets no buttons")
  assert.deepEqual(labels(forwardMoves("abandoned")), [])
})

test("gate moves still post under /api/gate/<action>", () => {
  for (const status of ["draft", "plan-review", "in-progress", "in-review"]) {
    for (const move of forwardMoves(status)) {
      assert.equal(move.endpoint, `/api/gate/${move.action}`, `${status}/${move.action} must stay a gate move`)
    }
  }
})

test("terminal columns offer Remove but not Abandon — core refuses it there", () => {
  assert.deepEqual(labels(cancellationMoves("queued")), ["Abandon", "Remove"])
  assert.deepEqual(labels(cancellationMoves("in-review")), ["Abandon", "Remove"])
  assert.deepEqual(labels(cancellationMoves("completed")), ["Remove"])
  assert.deepEqual(labels(cancellationMoves("abandoned")), ["Remove"])
})

test("every move carries confirm copy — the <Confirm> contract, as a rule a test can enforce", () => {
  const every = [
    ...["draft", "queued", "plan-review", "in-progress", "in-review", "completed", "abandoned"].flatMap((s) => [
      ...forwardMoves(s),
      ...cancellationMoves(s),
    ]),
    ...forwardMoves("queued", { planRequested: true }),
  ]
  for (const move of every) {
    assert.ok(move.detail.trim().length > 0, `${move.action} has no detail`)
    assert.ok(move.title.trim().length > 0, `${move.action} has no title`)
    assert.ok(move.endpoint.startsWith("/api/"), `${move.action} has no endpoint`)
  }
})
