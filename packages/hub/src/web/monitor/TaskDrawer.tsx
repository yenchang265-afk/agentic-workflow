import { useEffect, useRef, useState } from "react"
import type { SaveTaskResponse, TaskDetailResponse, TaskStatus } from "../../shared/api.js"
import { repoPath, useRepo } from "../repo.js"
import { useJson } from "../useJson.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { TaskEditor } from "./TaskEditor.js"
import { TaskReview } from "./TaskReview.js"

/**
 * The task detail drawer: everything about one task, and — for a planless task
 * in draft/ or queued/ — the editor that reshapes it. Everything else (a task
 * with a plan, or one a loop is driving) gets the review view: the same files
 * rendered as Markdown, commentable line by line.
 *
 * A native <dialog> for the same reason `Confirm` is one: Esc, focus trapping,
 * and a platform backdrop, with no focus-management code of our own to get
 * wrong. It is styled as a full-height right-hand panel rather than a centred
 * box, because a body textarea wants the height.
 *
 * The fetch is keyed on the task alone — deliberately NOT on `versions.backlog`.
 * A save bumps that version, and a refetch mid-typing would swap the form's
 * seed out from under whoever is typing. The drawer reads the task once, and a
 * completed save closes the form rather than re-syncing it.
 */

interface TaskDrawerProps {
  id: string
  status: TaskStatus
  claimed: boolean
  onClose: () => void
}

export const TaskDrawer = ({ id, status, claimed, onClose }: TaskDrawerProps) => {
  const { repoId } = useRepo()
  const ref = useRef<HTMLDialogElement>(null)
  const [saved, setSaved] = useState<SaveTaskResponse | null>(null)
  const { data, error } = useJson<TaskDetailResponse>(
    repoPath(`/api/tasks/${status}/${encodeURIComponent(id)}`, repoId),
    [status, id, repoId],
  )

  // showModal() must be called imperatively — the `open` attribute alone renders
  // a non-modal dialog with no backdrop and no focus trap.
  useEffect(() => {
    const el = ref.current
    if (el && !el.open) el.showModal()
  }, [])

  const onSaved = (result: SaveTaskResponse): void => setSaved(result)

  return (
    <dialog ref={ref} className="drawer" onClose={onClose} onCancel={onClose}>
      <div className="drawer__head">
        <div>
          <h2 className="drawer__title">{data?.card.title ?? id}</h2>
          <div className="card-meta">
            <Badge title={id}>{data?.card.shortId ?? id}</Badge>
            <Badge>{status}</Badge>
            {data?.card.type && <Badge>{data.card.type}</Badge>}
            {data?.card.hasPlan && <Badge tone="ok">plan</Badge>}
            {claimed && <Badge tone="gate">claimed</Badge>}
          </div>
        </div>
        <Button onClick={onClose}>Close</Button>
      </div>

      {error && <div className="error-banner">Could not load task: {error}</div>}
      {!data && !error && <div className="placeholder">Loading task…</div>}

      {data && (
        <div className="drawer__body">
          {/* A landed save leaves the form's baseHash and folder stale, so the
              editor is retired rather than re-seeded — reopen to edit again. */}
          {saved ? (
            <>
              <p className={`gate-msg gate-msg--${saved.ok ? "ok" : (saved.variant ?? "warning")}`}>{saved.message}</p>
              {saved.ok && saved.retask && !saved.retask.ok && (
                <p className="gate-msg gate-msg--warning">{saved.retask.message}</p>
              )}
            </>
          ) : data.editable && !claimed ? (
            <TaskEditor
              // Seed the form exactly once: a new task, or a file that changed
              // under a closed drawer, gets a fresh mount instead of a prop push.
              key={`${id}@${data.editable.hash}`}
              card={data.card}
              status={status}
              editable={data.editable}
              onSaved={onSaved}
            />
          ) : (
            <TaskReview
              id={id}
              status={status}
              claimed={claimed}
              card={data.card}
              body={data.body}
              {...(data.plan !== undefined ? { plan: data.plan } : {})}
            />
          )}

          {data.notes.length > 0 && (
            <section className="task-view__notes">
              <h3>audit trail</h3>
              <ul>
                {data.notes.map((n, i) => (
                  <li key={`${n.at}-${i}`}>
                    <span>{n.event}</span>
                    {n.at && (
                      <span className="task-view__stamp">
                        {n.at}
                        {n.by ? ` · ${n.by}` : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </dialog>
  )
}
