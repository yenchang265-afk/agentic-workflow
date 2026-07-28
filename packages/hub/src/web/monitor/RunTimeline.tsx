import type { TimelineSpan } from "../../shared/api.js"
import { Badge } from "../ui/Badge.js"

/**
 * Gantt of one run's stage executions, from the sidecar samples that recorded a
 * start. Hand-rolled SVG like every other chart here. Rows keep sidecar order
 * (already sorted by start), the x-axis spans first start → last end, and a
 * span from a still-`open` entry renders in the live style.
 */

const WIDTH = 520
const ROW_H = 18
const LABEL_W = 180

const fmtMs = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`)

export const RunTimeline = ({ spans, excluded }: { spans: readonly TimelineSpan[]; excluded?: number }) => {
  if (spans.length === 0) return null

  const starts = spans.map((s) => Date.parse(s.startedAt))
  const ends = spans.map((s, i) => (starts[i] ?? 0) + s.ms)
  const min = Math.min(...starts)
  const max = Math.max(...ends)
  const range = Math.max(1, max - min)
  const x = (t: number): number => ((t - min) / range) * WIDTH

  return (
    <div className="run-timeline">
      <h3>
        Timeline{" "}
        {spans.some((s) => s.live) && (
          <Badge tone="gate" title="from a sidecar entry still open — the span may still be growing">
            live
          </Badge>
        )}
      </h3>
      <svg
        width={LABEL_W + WIDTH}
        height={spans.length * ROW_H}
        role="img"
        aria-label={`timeline of ${spans.length} stage executions`}
      >
        {spans.map((s, i) => {
          const start = starts[i] ?? min
          const w = Math.max(2, x(start + s.ms) - x(start))
          const label = `${s.lens ? `${s.stage} (${s.lens})` : s.stage} #${s.iteration}`
          return (
            <g key={i}>
              <text x={LABEL_W - 8} y={i * ROW_H + 12} textAnchor="end" className="timeline-label">
                {label}
              </text>
              <rect
                x={LABEL_W + x(start)}
                y={i * ROW_H + 3}
                width={w}
                height={ROW_H - 6}
                rx={2}
                className={s.live ? "bar-out" : "bar-in"}
              >
                <title>
                  {label} · {fmtMs(s.ms)}
                  {s.model ? ` · ${s.model}` : ""}
                </title>
              </rect>
            </g>
          )
        })}
      </svg>
      {excluded !== undefined && excluded > 0 && (
        <div className="muted">{excluded} stage execution(s) recorded no start time and are not drawn</div>
      )}
    </div>
  )
}
