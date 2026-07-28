import { useEffect, useRef, useState } from "react"
import { useFeedback } from "./feedback.js"
import { Badge } from "./ui/Badge.js"
import { Button } from "./ui/Button.js"

/**
 * "What did I just do?" — the session's mutations, newest first.
 *
 * The hub performs audited, committed moves through the same core entry points
 * the CLI calls, and until now showed no record of any of them: a success
 * unmounted the card that reported it, and a refusal was a line of the smallest
 * type in the app. The durable record is git; this answers the question git
 * can't, which is what happened in *this* tab, including the moves that were
 * refused and therefore left no commit at all.
 *
 * A native <dialog> via showModal() for the same reason Confirm is one: Esc,
 * focus trapping and a platform backdrop, with no focus-management code of our
 * own to get wrong.
 */

const TONE_LABEL = { ok: "ok", warn: "refused", error: "failed", info: "info" } as const

export const ActivityLog = () => {
  const { log, clearLog } = useFeedback()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => setOpen(true)}
        title="What this tab has done — gate moves, saves, doctor fixes"
        aria-label={`Activity log, ${log.length} entries`}
      >
        Activity{log.length > 0 ? ` (${log.length})` : ""}
      </Button>
      <dialog ref={ref} className="drawer activity" onClose={() => setOpen(false)} onCancel={() => setOpen(false)}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">Activity</h2>
            <p className="muted">
              This tab only — the durable record is the git history these moves wrote. Refused moves are listed too;
              those wrote nothing.
            </p>
          </div>
          <div className="gate-actions">
            {log.length > 0 && <Button onClick={clearLog}>Clear</Button>}
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
        </div>
        <div className="drawer__body">
          {log.length === 0 ? (
            <div className="placeholder">Nothing yet this session.</div>
          ) : (
            <ul className="activity__list">
              {log.map((e) => (
                <li key={e.id} className={`activity__item activity__item--${e.tone}`}>
                  <div className="activity__row">
                    <Badge tone={e.tone === "ok" ? "ok" : e.tone === "info" ? "neutral" : "gate"}>
                      {TONE_LABEL[e.tone]}
                    </Badge>
                    {e.context && <code>{e.context}</code>}
                    {e.repo && <span className="muted">{e.repo}</span>}
                    <span className="muted activity__at">{new Date(e.at).toLocaleTimeString()}</span>
                  </div>
                  <div className="activity__message">{e.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </dialog>
    </>
  )
}
