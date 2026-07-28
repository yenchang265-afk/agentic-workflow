import { useState } from "react"
import type { SaveTaskRequest, SaveTaskResponse, TaskCard, TaskEditable, TaskStatus } from "../../shared/api.js"
import { postAction } from "../api.js"
import { repoPath, useRepo } from "../repo.js"
import { Button } from "../ui/Button.js"
import { Confirm } from "../ui/Confirm.js"

/**
 * The in-place editor for a planless task.
 *
 * On the CLI, `retask` reshapes a task through an `interview-me` pass and a
 * subagent that rewrites the draft. The hub has no agent, so the human types the
 * reshape here instead — and a `queued/` save performs the same
 * approval-withdrawing move, because a goal the loop was approved to plan is not
 * a goal you may change quietly.
 *
 * State is seeded once from `initial` and never re-synced: the parent remounts
 * this component (keyed on the task's content hash) rather than pushing new
 * props into a form someone is typing in. The audit tail is not here at all —
 * the server holds it and rejoins its own copy at save time.
 */

interface TaskEditorProps {
  card: TaskCard
  status: TaskStatus
  editable: TaskEditable
  /** Called once the save lands, so the drawer can stop offering a stale form. */
  onSaved: (result: SaveTaskResponse) => void
}

/** One item per line — matches the server's rule that a list item cannot contain a newline. */
const toLines = (list: readonly string[]): string => list.join("\n")
const fromLines = (text: string): string[] =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="form-field">
    <span>{label}</span>
    {children}
  </label>
)

export const TaskEditor = ({ card, status, editable, onSaved }: TaskEditorProps) => {
  const { repoId } = useRepo()
  const [title, setTitle] = useState(card.title)
  const [type, setType] = useState(card.type ?? "")
  const [priority, setPriority] = useState(String(card.priority))
  const [labels, setLabels] = useState(toLines(card.labels))
  const [acceptance, setAcceptance] = useState(toLines(card.acceptance))
  const [body, setBody] = useState(editable.prose)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const retasks = status === "queued"

  const save = async (): Promise<void> => {
    const payload: SaveTaskRequest = {
      expectStatus: status,
      baseHash: editable.hash,
      title: title.trim(),
      ...(type.trim() ? { type: type.trim() } : {}),
      // An unparseable number would fail the server's schema; keep the old value
      // rather than sending NaN.
      priority: Number.isFinite(Number(priority)) ? Math.trunc(Number(priority)) : card.priority,
      labels: fromLines(labels),
      acceptance: fromLines(acceptance),
      body,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }
    try {
      const result = await postAction<SaveTaskResponse>(
        repoPath(`/api/tasks/${status}/${encodeURIComponent(card.id)}`, repoId),
        payload,
      )
      // A refusal is a 200 with `ok: false` (postAction keeps it intact rather
      // than collapsing it into an Error). It is NOT a landed save: a live loop
      // is driving the task, or the body scanned as a secret. Keep the form —
      // and everything typed into it — exactly as the 409 path below does, and
      // render the reason. Only a real save retires the editor, because only
      // then are the form's baseHash and folder actually stale.
      if (!result.ok) {
        setError(result.message)
        return
      }
      setError(null)
      onSaved(result)
    } catch (e) {
      // A 409 lands here: the board, the file, or the plan moved under the form.
      setError((e as Error).message)
    }
  }

  return (
    <div className="task-editor">
      <Field label="title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </Field>
      <div className="task-editor__row">
        <Field label="type">
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="feature" maxLength={40} />
        </Field>
        <Field label="priority (lower runs first)">
          <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
      </div>
      <Field label="acceptance — one testable criterion per line">
        <textarea rows={4} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
      </Field>
      <Field label="labels — one per line">
        <textarea rows={2} value={labels} onChange={(e) => setLabels(e.target.value)} />
      </Field>
      <Field label="body">
        <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {editable.tail && (
        <div className="task-editor__tail">
          <span>audit trail — kept by the server, not editable here</span>
          <pre>{editable.tail}</pre>
        </div>
      )}
      <Confirm
        title={retasks ? "Save and send this task back to draft?" : "Save this task?"}
        detail={
          retasks
            ? "Rewrites the task file, moves it back to draft/, and commits both. Its task-gate approval is withdrawn — the reshaped goal has to be approved again before the loop will plan it."
            : "Rewrites the task file in place and commits the change. The task stays in draft/."
        }
        confirmLabel={retasks ? "Save & retask" : "Save"}
        onConfirm={save}
        trigger={<Button variant="primary">{retasks ? "Save & retask" : "Save"}</Button>}
      >
        <label className="form-field">
          <span>comment (recorded on the task's audit note)</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
      </Confirm>
      {error && <p className="gate-msg gate-msg--warning">{error}</p>}
    </div>
  )
}
