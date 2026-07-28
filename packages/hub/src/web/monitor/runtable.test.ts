import assert from "node:assert/strict"
import { test } from "node:test"
import { alignRow, extraHeaders } from "./runtable.js"

test("extraHeaders unions every row's keys in first-seen order", () => {
  assert.deepEqual(extraHeaders([{ extra: { tokens: "10", cost: "$1" } }, { extra: { tokens: "20" } }]), [
    "tokens",
    "cost",
  ])
  // A column only a later row wrote is still a column — dropping it would hide data.
  assert.deepEqual(extraHeaders([{ extra: { tokens: "10" } }, { extra: { cost: "$1" } }]), ["tokens", "cost"])
  assert.deepEqual(extraHeaders([]), [])
  assert.deepEqual(extraHeaders([{ extra: {} }]), [])
})

test("alignRow places each value under its own header, not by position", () => {
  const headers = ["tokens", "cost", "cache"]
  assert.deepEqual(alignRow(headers, { cost: "$1", cache: "80%", tokens: "10" }), ["10", "$1", "80%"])
})

test("alignRow renders a missing column as the unmeasured dash, never a neighbour's value", () => {
  // The regression: row 0 had {tokens, cost}; this row has only {cost}. Reading
  // it positionally would print the cost under the tokens header.
  assert.deepEqual(alignRow(["tokens", "cost"], { cost: "$1" }), ["—", "$1"])
  assert.deepEqual(alignRow(["tokens"], {}), ["—"])
  assert.deepEqual(alignRow([], { tokens: "10" }), [])
})
