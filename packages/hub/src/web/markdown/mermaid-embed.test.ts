import assert from "node:assert/strict"
import { test } from "node:test"
import { isMermaidLang, svgDoc } from "./mermaid-embed.js"

/**
 * The pure half of mermaid rendering. The component itself needs a DOM (and
 * mermaid), so what the node runner pins is the routing predicate and the
 * srcdoc document the sandboxed iframe renders.
 */

test("isMermaidLang matches the mermaid fence tag, case- and space-insensitively", () => {
  assert.equal(isMermaidLang("mermaid"), true)
  assert.equal(isMermaidLang("Mermaid"), true)
  assert.equal(isMermaidLang(" mermaid "), true)
  assert.equal(isMermaidLang(""), false)
  assert.equal(isMermaidLang("ts"), false)
  assert.equal(isMermaidLang("mermaidjs"), false)
})

test("svgDoc wraps the SVG in a standalone page that scales the diagram to the frame", () => {
  const doc = svgDoc("<svg><g>diagram</g></svg>")
  assert.ok(doc.startsWith("<!doctype html>"))
  assert.match(doc, /<svg><g>diagram<\/g><\/svg>/)
  assert.match(doc, /max-width:100%/)
  // White canvas regardless of hub theme: mermaid's palettes assume light.
  assert.match(doc, /background:#fff/)
})
