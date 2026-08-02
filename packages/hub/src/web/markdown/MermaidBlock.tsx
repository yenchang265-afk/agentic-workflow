import { useEffect, useState } from "react"
import { svgDoc } from "./mermaid-embed.js"

/**
 * Render a ```mermaid fence as a diagram, inside an `<iframe sandbox="">`.
 *
 * The iframe is the security boundary, not mermaid's sanitizer — see
 * mermaid-embed.ts. `securityLevel: "strict"` is still set (labels encoded,
 * click bindings off) as defense in depth.
 *
 * mermaid is a dynamic import so its multi-megabyte chunk is fetched only when
 * a document actually contains a diagram (build-web.mjs turns the import into
 * a split chunk). A diagram that fails to parse falls back to the plain
 * `<pre>` the block would have rendered as before this component existed —
 * a broken diagram must never cost the reviewer the plan text.
 */

let renderSeq = 0
let mermaidLoad: Promise<typeof import("mermaid").default> | null = null

const loadMermaid = (): Promise<typeof import("mermaid").default> => {
  mermaidLoad ??= import("mermaid").then((mod) => {
    mod.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" })
    return mod.default
  })
  return mermaidLoad
}

export interface MermaidBlockProps {
  /** The fence's body — mermaid source text. */
  readonly text: string
}

export const MermaidBlock = ({ text }: MermaidBlockProps) => {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    loadMermaid()
      .then((mermaid) => mermaid.render(`aw-mermaid-${renderSeq++}`, text))
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [text])

  if (error !== null) {
    return (
      <div className="md-mermaid">
        <pre className="md-code">{text}</pre>
        <p className="md-mermaid__error">Diagram failed to render: {error}</p>
      </div>
    )
  }
  if (svg === null) return <pre className="md-code">{text}</pre>
  return (
    <div className="md-mermaid">
      {showSource ? (
        <pre className="md-code">{text}</pre>
      ) : (
        <iframe className="md-mermaid__frame" sandbox="" srcDoc={svgDoc(svg)} title="Plan diagram" />
      )}
      <button type="button" className="md-mermaid__toggle" onClick={() => setShowSource(!showSource)}>
        {showSource ? "View diagram" : "View source"}
      </button>
    </div>
  )
}
