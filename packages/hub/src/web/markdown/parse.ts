/**
 * A small block-level Markdown parser for previewing task and plan files.
 *
 * Two reasons this is hand-rolled rather than a dependency. First, blocks are
 * the feature, not a side effect: a review comment is anchored to one — the
 * parser's job is to hand back an addressable list, which a
 * markdown-string-to-HTML library does not. Second, nothing here ever becomes
 * `dangerouslySetInnerHTML`: the renderer builds React elements from this tree,
 * so a task file authored on some PR branch cannot inject markup or a
 * `javascript:` href (see `isSafeHref`) into the hub.
 *
 * The dialect is deliberately the subset task files actually use — headings,
 * paragraphs, fenced code, blockquotes, lists, rules, and inline
 * code/strong/em/link. Anything unrecognised survives as paragraph text rather
 * than vanishing, so a preview is never *less* than the raw file.
 *
 * Pure — no DOM, no React. Tested in parse.test.ts.
 */

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "em"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string }

export type BlockBody =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "code"; readonly lang: string; readonly text: string }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "rule" }

export interface Block {
  /**
   * Stable within one document render: the 1-based source line the block starts
   * at. Comments key off this, so re-parsing the same text re-attaches them;
   * editing the file above a block moves its id, which is correct — the comment
   * was about the text that was there.
   */
  readonly id: string
  /** The block's leading text, quoted back when a comment on it is composed. */
  readonly anchor: string
  readonly body: BlockBody
}

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^(?:```|~~~)\s*([\w+-]*)\s*$/
const FENCE_END = /^(?:```|~~~)\s*$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^>\s?(.*)$/
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/
const BLANK = /^\s*$/

/** Does this line open a block other than a paragraph? Ends paragraph accumulation. */
const startsBlock = (line: string): boolean =>
  HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)

const anchorOf = (body: BlockBody): string => {
  switch (body.kind) {
    case "heading":
    case "paragraph":
    case "quote":
      return body.text.split("\n")[0] ?? ""
    case "code":
      return body.text.split("\n").find((l) => l.trim() !== "") ?? body.lang
    case "list":
      return body.items[0] ?? ""
    case "rule":
      return "———"
  }
}

export const parseBlocks = (markdown: string): readonly Block[] => {
  const lines = markdown.split("\n")
  const blocks: Block[] = []
  const push = (line: number, body: BlockBody): void => {
    blocks.push({ id: `L${line + 1}`, anchor: anchorOf(body), body })
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const at = i

    if (BLANK.test(line)) {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const code: string[] = []
      i += 1
      // An unterminated fence runs to the end of the file — the same thing every
      // Markdown renderer does, and better than dropping the rest of the plan.
      while (i < lines.length && !FENCE_END.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "")
        i += 1
      }
      // Unterminated: the file's own trailing newline is not part of the code.
      if (i >= lines.length) while (code.length > 0 && BLANK.test(code[code.length - 1] ?? "")) code.pop()
      i += 1
      push(at, { kind: "code", lang: fence[1] ?? "", text: code.join("\n") })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      push(at, { kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      push(at, { kind: "rule" })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i] ?? "")
        if (!m) break
        quoted.push(m[1] ?? "")
        i += 1
      }
      push(at, { kind: "quote", text: quoted.join("\n") })
      continue
    }

    const first = LIST_ITEM.exec(line)
    if (first) {
      const ordered = first[2] !== undefined
      const items: string[] = []
      while (i < lines.length) {
        const cur = lines[i] ?? ""
        const m = LIST_ITEM.exec(cur)
        if (m) {
          // A switch between bullet and number starts a new list block.
          if ((m[2] !== undefined) !== ordered) break
          items.push(m[3] ?? "")
          i += 1
          continue
        }
        // An indented, non-blank line continues the item above it.
        if (items.length > 0 && !BLANK.test(cur) && /^\s+/.test(cur)) {
          items[items.length - 1] = `${items[items.length - 1]} ${cur.trim()}`
          i += 1
          continue
        }
        break
      }
      push(at, { kind: "list", ordered, items })
      continue
    }

    const para: string[] = []
    while (i < lines.length && !BLANK.test(lines[i] ?? "") && (i === at || !startsBlock(lines[i] ?? ""))) {
      para.push((lines[i] ?? "").trim())
      i += 1
    }
    push(at, { kind: "paragraph", text: para.join(" ") })
  }

  return blocks
}

/**
 * Which link targets may become an `<a href>`. Everything else renders as plain
 * text: a task file is just a file in the repo, and one carrying
 * `[click](javascript:…)` must not hand the hub's origin to it.
 */
export const isSafeHref = (href: string): boolean => /^(?:https?:\/\/|mailto:|[./#])/i.test(href)

const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]*)\]\(([^)\s]*)\)/

/** Split one line of Markdown into inline runs. Unmatched syntax stays literal text. */
export const parseInline = (text: string): readonly Inline[] => {
  const out: Inline[] = []
  const add = (t: string): void => {
    if (t !== "") out.push({ kind: "text", text: t })
  }
  let rest = text
  for (let m = INLINE.exec(rest); m; m = INLINE.exec(rest)) {
    add(rest.slice(0, m.index))
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] })
    else if (m[2] !== undefined) out.push({ kind: "strong", text: m[2] })
    else if (m[3] !== undefined) out.push({ kind: "strong", text: m[3] })
    else if (m[4] !== undefined) out.push({ kind: "em", text: m[4] })
    else if (m[5] !== undefined) out.push({ kind: "em", text: m[5] })
    else if (m[6] !== undefined && m[7] !== undefined) {
      const href = m[7]
      if (isSafeHref(href)) out.push({ kind: "link", text: m[6] || href, href })
      else add(m[0])
    }
    rest = rest.slice(m.index + m[0].length)
  }
  add(rest)
  return out
}
