/**
 * Parse the durable run log (`<tasksDir>/runs/<id>.md`) back into structure.
 * The writers live beside this module: stage sections are appended by the
 * hosts via `appendRunLog` with `## <stage>[ (lens: <l>)] · iteration N · <ISO>`
 * headers, and terminal events append `## run · <outcome>` followed by the
 * `## Run summary · …` block from `renderRunSummary` (metrics.ts). Keeping
 * parser and writers in one package lets the round-trip be tested in one
 * place. Pure; tolerant of unknown sections (forward compatibility).
 */

export interface RunLogStageSection {
  readonly stage: string
  readonly lens?: string
  /** 1-based, as written in the header. */
  readonly iteration: number
  readonly at: string
  /** The stage's captured output (trimmed). */
  readonly body: string
}

export interface RunSummaryRow {
  readonly stage: string
  readonly lens?: string
  /** 1-based, as rendered in the table. */
  readonly iteration: number
  /** `PASS` / `FAIL` / `ERROR` / `none`; undefined when rendered as `—`. */
  readonly verdict?: string
  /** Wall-clock as rendered (`2m 41s`); `seconds` is its parsed value. */
  readonly duration: string
  readonly seconds: number
  /** Raw cell text of any extra columns (e.g. tokens/cost added later), keyed by header. */
  readonly extra: Readonly<Record<string, string>>
}

export interface RunLogSummary {
  readonly outcome: string
  readonly detail?: string
  readonly at: string
  readonly rows: readonly RunSummaryRow[]
  readonly iterationsUsed?: number
  readonly cap?: number
  readonly total?: string
  /** Total run cost in dollars, when the footer carries a `cost: $…` segment. */
  readonly cost?: number
  /** The workflow kind, when the footer carries a leading `kind: …` segment (newer logs). */
  readonly kind?: string
}

export interface ParsedRunLog {
  readonly sections: readonly RunLogStageSection[]
  readonly summaries: readonly RunLogSummary[]
}

/** Inverse of metrics.ts `formatDuration` (`1h 03m` / `2m 41s` / `45s`) → seconds. Pure. */
export const parseDuration = (text: string): number => {
  let seconds = 0
  const h = /(\d+)h/.exec(text)
  const m = /(\d+)m(?!s)/.exec(text)
  const s = /(\d+)s/.exec(text)
  if (h) seconds += Number(h[1]) * 3600
  if (m) seconds += Number(m[1]) * 60
  if (s) seconds += Number(s[1])
  return seconds
}

const STAGE_HEADER = /^(?<stage>[a-z][a-z0-9-]*)(?:\s+\(lens:\s*(?<lens>[^)]+)\))?\s+·\s+iteration\s+(?<iter>\d+)\s+·\s+(?<at>\S+)$/
const SUMMARY_HEADER = /^Run summary\s+·\s+(?<outcome>[a-z]+)(?::\s+(?<detail>.*?))?\s+·\s+(?<at>\S+)$/
const RUN_MARKER = /^run\s+·\s+/
// All groups named: the optional leading `kind:` segment (added later) would
// silently shift numbered groups and mis-parse every footer.
const FOOTER =
  /^(?:kind:\s*(?<kind>\S+)\s+·\s+)?iterations used:\s*(?<used>\d+)\/(?<cap>\d+)\s+·\s+total:\s*(?<total>[^·]+?)\s+·\s+(?:cost:\s*\$(?<cost>[\d.]+)\s+·\s+)?outcome:/
const ROW_STAGE = /^(?<stage>.+?)(?:\s+\((?<lens>[^)]+)\))?$/

interface Block {
  readonly header: string
  readonly lines: readonly string[]
}

const splitBlocks = (markdown: string): Block[] => {
  const blocks: Block[] = []
  let current: { header: string; lines: string[] } | null = null
  for (const line of markdown.split("\n")) {
    const h2 = /^##\s+(.*)$/.exec(line)
    if (h2) {
      if (current) blocks.push(current)
      current = { header: (h2[1] as string).trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) blocks.push(current)
  return blocks
}

const parseTable = (lines: readonly string[]): RunSummaryRow[] => {
  const tableLines = lines.filter((l) => l.trim().startsWith("|"))
  if (tableLines.length < 2) return []
  const cells = (l: string): string[] =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim())
  const headers = cells(tableLines[0] as string).map((h) => h.toLowerCase())
  const rows: RunSummaryRow[] = []
  for (const line of tableLines.slice(1)) {
    const row = cells(line)
    if (row.every((c) => /^-+$/.test(c))) continue // separator
    const byHeader: Record<string, string> = {}
    headers.forEach((h, i) => (byHeader[h] = row[i] ?? ""))
    const stageCell = byHeader["stage"] ?? ""
    const stageMatch = ROW_STAGE.exec(stageCell)
    const known = new Set(["#", "stage", "iter", "verdict", "wall-clock"])
    const extra: Record<string, string> = {}
    for (const h of headers) if (!known.has(h)) extra[h] = byHeader[h] ?? ""
    const verdictCell = byHeader["verdict"] ?? "—"
    const duration = byHeader["wall-clock"] ?? ""
    rows.push({
      stage: stageMatch?.groups?.["stage"] ?? stageCell,
      ...(stageMatch?.groups?.["lens"] ? { lens: stageMatch.groups["lens"] } : {}),
      iteration: Number(byHeader["iter"] ?? "0") || 0,
      ...(verdictCell && verdictCell !== "—" ? { verdict: verdictCell } : {}),
      duration,
      seconds: parseDuration(duration),
      extra,
    })
  }
  return rows
}

/** Parse a run log's markdown. Unknown `##` sections are skipped. Pure. */
export const parseRunLog = (markdown: string): ParsedRunLog => {
  const sections: RunLogStageSection[] = []
  const summaries: RunLogSummary[] = []
  for (const block of splitBlocks(markdown)) {
    if (RUN_MARKER.test(block.header)) continue // terminal marker; the summary follows as its own block
    const summary = SUMMARY_HEADER.exec(block.header)
    if (summary?.groups) {
      const footerLine = block.lines.map((l) => FOOTER.exec(l)).find(Boolean)
      const footer = footerLine?.groups
      summaries.push({
        outcome: summary.groups["outcome"] as string,
        ...(summary.groups["detail"] ? { detail: summary.groups["detail"] } : {}),
        at: summary.groups["at"] as string,
        rows: parseTable(block.lines),
        ...(footer
          ? {
              iterationsUsed: Number(footer["used"]),
              cap: Number(footer["cap"]),
              total: footer["total"] as string,
              ...(footer["cost"] !== undefined ? { cost: Number(footer["cost"]) } : {}),
              ...(footer["kind"] !== undefined ? { kind: footer["kind"] } : {}),
            }
          : {}),
      })
      continue
    }
    const stage = STAGE_HEADER.exec(block.header)
    if (stage?.groups) {
      sections.push({
        stage: stage.groups["stage"] as string,
        ...(stage.groups["lens"] ? { lens: stage.groups["lens"] } : {}),
        iteration: Number(stage.groups["iter"]),
        at: stage.groups["at"] as string,
        body: block.lines.join("\n").trim(),
      })
    }
    // anything else: unknown section — ignore
  }
  return { sections, summaries }
}
