import { type ReactNode } from "react"
import { parseInline, type Block, type BlockBody } from "./parse.js"
import { isMermaidLang } from "./mermaid-embed.js"
import { MermaidBlock } from "./MermaidBlock.js"

/**
 * Render parsed Markdown as React elements — never `dangerouslySetInnerHTML`.
 * A task file is repo content that may have arrived on someone else's branch;
 * building elements means it can carry no markup and no script into the hub.
 * The one block that must become markup — a ```mermaid fence — renders inside
 * a scriptless, origin-less `<iframe sandbox="">` (MermaidBlock), so the
 * invariant holds for the hub document itself even there.
 *
 * Every block is wrapped in a hover target that offers "comment". That wrapper
 * is why this renders blocks instead of a string: a review comment belongs to a
 * specific line of the plan, and the reader has to be able to point at it
 * without leaving the preview.
 */

const Inlines = ({ text }: { text: string }): ReactNode =>
  parseInline(text).map((run, i) => {
    switch (run.kind) {
      case "code":
        return <code key={i}>{run.text}</code>
      case "strong":
        return <strong key={i}>{run.text}</strong>
      case "em":
        return <em key={i}>{run.text}</em>
      case "link":
        return (
          <a key={i} href={run.href} target="_blank" rel="noreferrer noopener">
            {run.text}
          </a>
        )
      case "text":
        return <span key={i}>{run.text}</span>
    }
  })

const Body = ({ body }: { body: BlockBody }): ReactNode => {
  switch (body.kind) {
    case "heading": {
      const Tag = `h${Math.min(body.level + 1, 6)}` as "h2"
      return (
        <Tag className={`md-h md-h${body.level}`}>
          <Inlines text={body.text} />
        </Tag>
      )
    }
    case "paragraph":
      return (
        <p className="md-p">
          <Inlines text={body.text} />
        </p>
      )
    case "code":
      return isMermaidLang(body.lang) ? <MermaidBlock text={body.text} /> : <pre className="md-code">{body.text}</pre>
    case "quote":
      return (
        <blockquote className="md-quote">
          {body.text.split("\n").map((line, i) => (
            <div key={i}>
              <Inlines text={line} />
            </div>
          ))}
        </blockquote>
      )
    case "list": {
      const items = body.items.map((item, i) => (
        <li key={i}>
          <Inlines text={item} />
        </li>
      ))
      return body.ordered ? <ol className="md-list">{items}</ol> : <ul className="md-list">{items}</ul>
    }
    case "rule":
      return <hr className="md-rule" />
  }
}

export interface MarkdownProps {
  readonly blocks: readonly Block[]
  /** Saved comments, keyed by block id — a commented block stays highlighted. */
  readonly comments: Readonly<Record<string, string>>
  /** The block whose composer is open, if any. */
  readonly composing: string | null
  readonly onCompose: (id: string | null) => void
  /** Rendered inside the open composer (the textarea + its buttons). */
  readonly composer: (block: Block) => ReactNode
  /** Preview only — no comment affordance, for a column whose moves carry none. */
  readonly readOnly?: boolean
}

export const Markdown = ({ blocks, comments, composing, onCompose, composer, readOnly = false }: MarkdownProps) => {
  if (blocks.length === 0) return <div className="placeholder">This file has no content yet.</div>
  return (
    <div className="md">
      {blocks.map((block) => {
        const note = comments[block.id]
        return (
          <div key={block.id} className={`md-block${note ? " commented" : ""}${composing === block.id ? " composing" : ""}`}>
            {!readOnly && (
              <button
                type="button"
                className="md-block__comment"
                title={note ? "Edit this comment" : "Comment on this"}
                aria-label={note ? `Edit comment on "${block.anchor}"` : `Comment on "${block.anchor}"`}
                onClick={() => onCompose(composing === block.id ? null : block.id)}
              >
                {note ? "✎" : "+"}
              </button>
            )}
            <Body body={block.body} />
            {note && composing !== block.id && <p className="md-block__note">{note}</p>}
            {composing === block.id && composer(block)}
          </div>
        )
      })}
    </div>
  )
}
