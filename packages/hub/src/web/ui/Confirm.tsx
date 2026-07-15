/**
 * The confirm primitive for every hub action with a real-world side effect.
 *
 * The hub was read-only until gate/doctor/config landed; now a click can move a
 * task file, write a git commit, or open a pull request. `detail` exists to name
 * that effect in plain prose — "commits to git and opens a pull request against
 * main", not "Are you sure?". A dialog that only asks for a second click buys
 * nothing; one that tells you what is about to happen outside your machine is
 * the whole point.
 *
 * Behaviour is a native <dialog>: Esc closes, focus is trapped, backdrop is the
 * platform's. No focus-management code of our own to get wrong.
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "./Button.js"

interface ConfirmProps {
  /** Short imperative title — the action, e.g. "Ship this task?". */
  title: string
  /** Prose naming the real-world side effect. Required: the reason this component exists. */
  detail: ReactNode
  /** Label for the confirming button. Defaults to the title, minus its question mark. */
  confirmLabel?: string
  /** Irreversible or outward-facing (opens a PR, pushes a branch) → red. */
  danger?: boolean
  /** Extra input (e.g. a replan reason) rendered above the buttons. */
  children?: ReactNode
  /** Runs only on an explicit confirm click. May be async; the dialog shows a pending state. */
  onConfirm: () => void | Promise<void>
  /** The element that opens the dialog — rendered as-is, wrapped in a click target. */
  trigger: ReactNode
}

export function Confirm({ title, detail, confirmLabel, danger = false, children, onConfirm, trigger }: ConfirmProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  // showModal() must be called imperatively — the `open` attribute alone renders
  // a non-modal dialog with no backdrop and no focus trap.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  const confirm = async (): Promise<void> => {
    setPending(true)
    try {
      await onConfirm()
      setOpen(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <span className="confirm-trigger" onClick={() => setOpen(true)}>
        {trigger}
      </span>
      <dialog
        ref={ref}
        className="confirm"
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      >
        <h2 className="confirm__title">{title}</h2>
        <div className="confirm__detail">{detail}</div>
        {children && <div className="confirm__body">{children}</div>}
        <div className="confirm__actions">
          <Button onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={confirm} disabled={pending}>
            {pending ? "Working…" : (confirmLabel ?? title.replace(/\?$/, ""))}
          </Button>
        </div>
      </dialog>
    </>
  )
}
