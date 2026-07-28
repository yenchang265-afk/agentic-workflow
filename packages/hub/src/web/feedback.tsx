import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react"
import { StatusMessage } from "./ui/StatusMessage.js"
import type { Tone } from "./ui/tone.js"

/**
 * Where every mutation reports its outcome: a transient toast, and a permanent
 * session activity log.
 *
 * Two problems this exists for.
 *
 * A **success used to vanish**: approving a task moves it to another column, so
 * the card unmounts and the confirmation it was carrying goes with it. The user
 * performed an audited git commit and the UI's only acknowledgement flashed for
 * one frame. A toast outlives the card.
 *
 * A **refusal used to be silent and permanent at once**: it rendered as the
 * smallest type in the app, below a button, inside a card that might be
 * off-screen, with no `role="alert"`, and it then stayed there forever because
 * nothing cleared it. Now it is announced, dismissable, and recorded.
 *
 * The log is deliberately in-memory and session-scoped. The durable record is
 * the git history the moves themselves write; this is only "what did I just
 * click", which is precisely what the hub could not answer.
 */

export interface ActivityEntry {
  readonly id: number
  /** ISO timestamp — the log is a record, so it carries when, not "just now". */
  readonly at: string
  readonly tone: Tone
  readonly message: string
  /** What produced it, e.g. `approve-plan · fix-pagination`. */
  readonly context?: string
  readonly repo?: string | null
}

export interface ReportInput {
  readonly tone: Tone
  readonly message: string
  readonly context?: string
  readonly repo?: string | null
  /** Skip the toast and only record it — for outcomes already shown in place. */
  readonly quiet?: boolean
}

interface FeedbackValue {
  readonly report: (input: ReportInput) => void
  readonly log: readonly ActivityEntry[]
  readonly clearLog: () => void
}

const FeedbackContext = createContext<FeedbackValue>({
  report: () => {},
  log: [],
  clearLog: () => {},
})

/** How long a toast stays up. Long enough to read a refusal, not a modal. */
const TOAST_MS = 6_000
/** Cap the log so a long-lived tab can't grow without bound. */
const LOG_MAX = 200

export const FeedbackProvider = ({ children }: { children: ReactNode }) => {
  const [log, setLog] = useState<readonly ActivityEntry[]>([])
  const [toasts, setToasts] = useState<readonly ActivityEntry[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((e) => e.id !== id)), [])

  const report = useCallback(
    (input: ReportInput) => {
      const entry: ActivityEntry = {
        id: nextId.current++,
        at: new Date().toISOString(),
        tone: input.tone,
        message: input.message,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.repo !== undefined ? { repo: input.repo } : {}),
      }
      setLog((l) => [entry, ...l].slice(0, LOG_MAX))
      if (input.quiet) return
      setToasts((t) => [...t, entry])
      window.setTimeout(() => dismiss(entry.id), TOAST_MS)
    },
    [dismiss],
  )

  const clearLog = useCallback(() => setLog([]), [])
  const value = useMemo(() => ({ report, log, clearLog }), [report, log, clearLog])

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {/* Outside the scroll container, so a toast is visible wherever the user
          has scrolled to — the card that triggered it often is not. */}
      <div className="toaster">
        {toasts.map((t) => (
          <StatusMessage key={t.id} tone={t.tone} onDismiss={() => dismiss(t.id)}>
            {t.context && <span className="toast__context">{t.context}</span>}
            {t.message}
          </StatusMessage>
        ))}
      </div>
    </FeedbackContext.Provider>
  )
}

export const useFeedback = (): FeedbackValue => useContext(FeedbackContext)
