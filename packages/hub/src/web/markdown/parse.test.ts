import assert from "node:assert/strict"
import { test } from "node:test"
import { isSafeHref, parseBlocks, parseInline, type Block } from "./parse.js"

/**
 * The preview parser. What matters here is not Markdown conformance — it is
 * that every line of a task file lands in exactly one addressable block (a
 * comment anchors to one), and that nothing in a file can turn into an unsafe
 * link.
 */

const kinds = (blocks: readonly Block[]): string[] => blocks.map((b) => b.body.kind)

test("parseBlocks splits a task file into headings, paragraphs, lists, code and quotes", () => {
  const blocks = parseBlocks(
    [
      "# Title",
      "",
      "Some context that",
      "wraps across lines.",
      "",
      "- first",
      "- second",
      "",
      "```ts",
      "const x = 1",
      "```",
      "",
      "> CLAIMED — loop starting [2026-01-01 by me]",
    ].join("\n"),
  )
  assert.deepEqual(kinds(blocks), ["heading", "paragraph", "list", "code", "quote"])
  assert.deepEqual(blocks[0]?.body, { kind: "heading", level: 1, text: "Title" })
  // A soft-wrapped paragraph is one block, so a comment on it covers the thought.
  assert.deepEqual(blocks[1]?.body, { kind: "paragraph", text: "Some context that wraps across lines." })
  assert.deepEqual(blocks[2]?.body, { kind: "list", ordered: false, items: ["first", "second"] })
  assert.deepEqual(blocks[3]?.body, { kind: "code", lang: "ts", text: "const x = 1" })
  assert.equal(blocks[4]?.body.kind === "quote" && blocks[4].body.text.startsWith("CLAIMED"), true)
})

test("parseBlocks keeps a mermaid fence's lang — the renderer routes on it", () => {
  const blocks = parseBlocks("```mermaid\nstateDiagram-v2\n  a --> b\n```\n")
  assert.deepEqual(blocks[0]?.body, { kind: "code", lang: "mermaid", text: "stateDiagram-v2\n  a --> b" })
})

test("parseBlocks ids blocks by their source line, so a re-parse re-attaches comments", () => {
  const md = "# Title\n\npara one\n\npara two\n"
  assert.deepEqual(
    parseBlocks(md).map((b) => b.id),
    ["L1", "L3", "L5"],
  )
  assert.deepEqual(
    parseBlocks(md).map((b) => b.id),
    parseBlocks(md).map((b) => b.id),
  )
})

test("parseBlocks anchors each block to its leading text — what a comment quotes back", () => {
  const blocks = parseBlocks("## Implementation Plan\n\n1. Move the store\n2. Delete the shim\n")
  assert.equal(blocks[0]?.anchor, "Implementation Plan")
  assert.equal(blocks[1]?.anchor, "Move the store")
})

test("parseBlocks keeps ordered and unordered lists apart and folds indented continuations", () => {
  const blocks = parseBlocks("- bullet\n  continued here\n\n1. step\n2. step two\n")
  assert.deepEqual(kinds(blocks), ["list", "list"])
  assert.deepEqual(blocks[0]?.body, { kind: "list", ordered: false, items: ["bullet continued here"] })
  assert.equal(blocks[1]?.body.kind === "list" && blocks[1].body.ordered, true)
})

test("parseBlocks runs an unterminated fence to end of file rather than dropping it", () => {
  const blocks = parseBlocks("```\nstill code\nand more\n")
  assert.deepEqual(blocks.map((b) => b.body), [{ kind: "code", lang: "", text: "still code\nand more" }])
})

test("parseBlocks loses no non-blank line", () => {
  const md = "# H\ntext right under a heading\n\n---\n\n> note\ntrailing paragraph\n"
  const blocks = parseBlocks(md)
  assert.deepEqual(kinds(blocks), ["heading", "paragraph", "rule", "quote", "paragraph"])
})

test("parseInline splits code, emphasis and links, leaving unmatched syntax literal", () => {
  assert.deepEqual(parseInline("run `npm test` first"), [
    { kind: "text", text: "run " },
    { kind: "code", text: "npm test" },
    { kind: "text", text: " first" },
  ])
  assert.deepEqual(parseInline("**bold** and *soft*"), [
    { kind: "strong", text: "bold" },
    { kind: "text", text: " and " },
    { kind: "em", text: "soft" },
  ])
  assert.deepEqual(parseInline("see [docs](https://example.com)"), [
    { kind: "text", text: "see " },
    { kind: "link", text: "docs", href: "https://example.com" },
  ])
  assert.deepEqual(parseInline("a * b * c is not emphasis?"), [
    { kind: "text", text: "a " },
    { kind: "em", text: " b " },
    { kind: "text", text: " c is not emphasis?" },
  ])
})

test("an unsafe href never becomes a link — it stays literal text", () => {
  assert.equal(isSafeHref("javascript:alert(1)"), false)
  assert.equal(isSafeHref("https://example.com"), true)
  assert.equal(isSafeHref("./docs/tasks/draft/t.md"), true)
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [
    { kind: "text", text: "[click](javascript:alert(1)" },
    { kind: "text", text: ")" },
  ])
})
