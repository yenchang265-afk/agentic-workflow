import assert from "node:assert/strict"
import { test } from "node:test"
import { gateTone, isAssertive, saveTaskTone } from "./tone.js"

const ok = { ok: true as const, message: "m", path: "p", data: {} }

test("gateTone: a clean move is ok, a refusal warns", () => {
  assert.equal(gateTone(ok), "ok")
  assert.equal(gateTone({ ok: false, message: "it's in queued, not draft" }), "warn")
})

test("gateTone: a shipped task whose PR did not open must not read as a clean ship", () => {
  // The regression this file exists for: `ok: true` with `variant: "warning"`.
  assert.equal(gateTone({ ...ok, variant: "warning" }), "warn")
  assert.equal(gateTone({ ...ok, variant: "info" }), "info")
})

test("gateTone: a refusal can soften to info but never to ok", () => {
  assert.equal(gateTone({ ok: false, message: "m", variant: "info" }), "info")
  assert.equal(gateTone({ ok: false, message: "m", variant: "warning" }), "warn")
})

test("saveTaskTone: a landed edit whose retask failed is not a clean success", () => {
  assert.equal(saveTaskTone({ ok: true, message: "m", path: "p", changed: ["title"] }), "ok")
  assert.equal(
    saveTaskTone({
      ok: true,
      message: "m",
      path: "p",
      changed: ["title"],
      retask: { ok: false, message: "stayed in queued/" },
    }),
    "warn",
  )
  assert.equal(saveTaskTone({ ok: true, message: "m", path: "p", changed: [], retask: ok }), "ok")
})

test("saveTaskTone: a refusal warns", () => {
  assert.equal(saveTaskTone({ ok: false, message: "a loop is driving this" }), "warn")
})

test("isAssertive marks exactly the tones worth interrupting for", () => {
  assert.deepEqual(
    (["info", "ok", "warn", "error"] as const).map(isAssertive),
    [false, false, true, true],
  )
})
