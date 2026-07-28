import type { ReactNode } from "react"
import { Button } from "./Button.js"
import { isAssertive, type Tone } from "./tone.js"

/**
 * One inline message component for every "the server said something" case.
 *
 * It replaces five structurally identical treatments that had drifted apart —
 * `.error-banner`, `.gate-msg--warning`, `.cfg-error`, `.doctor-error`,
 * `.asset-scaffold__error` — plus their success twins. Consolidating them is
 * not tidiness: each copy had its own answer to whether the message could be
 * dismissed, whether it offered a retry, and whether a screen reader was told
 * about it at all, and the answer was usually "no" to all three.
 *
 * `role="alert"` on warn/error, because these appear *after* an action the user
 * took and are otherwise silent — a failed ship was previously as loud as a
 * label chip.
 */
export const StatusMessage = ({
  tone,
  children,
  onRetry,
  onDismiss,
}: {
  tone: Tone
  children: ReactNode
  /** Renders a Retry button — pass a resource's `refetch`. */
  onRetry?: () => void
  /** Renders a dismiss button. Omit for messages that describe a live state. */
  onDismiss?: () => void
}) => (
  <div
    className={`status status--${tone}`}
    {...(isAssertive(tone) ? { role: "alert" as const } : { role: "status" as const, "aria-live": "polite" as const })}
  >
    <div className="status__body">{children}</div>
    {onRetry && (
      <Button onClick={onRetry} title="Try the request again">
        Retry
      </Button>
    )}
    {onDismiss && (
      <Button variant="ghost" icon onClick={onDismiss} aria-label="Dismiss this message" title="Dismiss">
        ×
      </Button>
    )}
  </div>
)
