import { useEffect, useState } from "react"
import type { ManualFreshnessResponse } from "../shared/api.js"
import { fetchJson } from "./api.js"

/**
 * The user-manual tab: docs/manual.html served verbatim in an iframe (it's a
 * self-contained SPA with its own nav and theming), with a drift banner from
 * the freshness diff above it.
 */

export const Manual = () => {
  const [freshness, setFreshness] = useState<ManualFreshnessResponse | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    fetchJson<ManualFreshnessResponse>("/api/manual/freshness")
      .then(setFreshness)
      .catch(() => setFreshness(null))
  }, [])

  if (freshness && !freshness.available) {
    return <div className="placeholder">This repo has no docs/manual.html.</div>
  }

  const warnings = freshness?.warnings ?? []
  const visible = showAll ? warnings : warnings.slice(0, 3)

  return (
    <div className="manual">
      {warnings.length > 0 && (
        <div className="freshness-banner">
          <strong>
            Manual drift — {warnings.length} finding{warnings.length > 1 ? "s" : ""} vs the current command surface:
          </strong>
          <ul>
            {visible.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          {warnings.length > 3 && (
            <button className="chip chip-button" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "show fewer" : `show all ${warnings.length}`}
            </button>
          )}
        </div>
      )}
      <iframe className="manual-frame" src="/manual" title="agentic-loop user manual" />
    </div>
  )
}
