import { useState } from "react"
import type { CreateTaskRequest, CreateTaskResponse } from "../../shared/api.js"
import { postAction } from "../api.js"
import { useFeedback } from "../feedback.js"
import { repoPath, useRepo } from "../repo.js"
import { Button } from "../ui/Button.js"
import { Confirm } from "../ui/Confirm.js"
import { StatusMessage } from "../ui/StatusMessage.js"
import { Field, fromLines } from "./TaskEditor.js"

/**
 * Create a planless draft from the board (design 59).
 *
 * The board could gate, edit, plan, abandon, restore and remove a task and had
 * no way to CREATE one: the first column's only entrances were the CLI's `new`
 * interview and a hand-written file. This is the interview's form, filled by
 * the human: the same fields the editor edits, posted to `POST /api/tasks/draft`,
 * which mints the id through core's `writeTask` and commits like every other
 * backlog write. On success the new task opens in the drawer.
 */
export const NewDraft = ({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) => {
  const { repoId } = useRepo()
  const { report } = useFeedback()
  const [title, setTitle] = useState("")
  const [type, setType] = useState("")
  const [priority, setPriority] = useState("0")
  const [labels, setLabels] = useState("")
  const [acceptance, setAcceptance] = useState("")
  const [body, setBody] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const create = async (): Promise<void> => {
    const payload: CreateTaskRequest = {
      title: title.trim(),
      ...(type.trim() ? { type: type.trim() } : {}),
      priority: Number.isFinite(Number(priority)) ? Math.trunc(Number(priority)) : 0,
      labels: fromLines(labels),
      acceptance: fromLines(acceptance),
      body,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }
    try {
      const result = await postAction<CreateTaskResponse>(repoPath("/api/tasks/draft", repoId), payload)
      report({ tone: result.ok ? "ok" : "warn", message: result.message, context: "new draft", repo: repoId })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setError(null)
      onCreated(result.id)
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      report({ tone: "error", message, context: "new draft", repo: repoId })
    }
  }

  return (
    <div className="task-editor new-draft">
      <Field label="title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="What should be done" />
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
      <Field label="body — the goal, context, and anything the planner must know">
        <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="new-draft__actions">
        <Confirm
          title="Create this draft?"
          detail="Writes a new task file in draft/ and commits it. It waits at the task gate until you approve it."
          confirmLabel="Create draft"
          onConfirm={create}
          trigger={
            <Button variant="primary" disabled={!title.trim()}>
              Create draft
            </Button>
          }
        >
          <label className="form-field">
            <span>comment (recorded on the task's first audit note)</span>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </label>
        </Confirm>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
      {error && (
        <StatusMessage tone="warn" onDismiss={() => setError(null)}>
          {error}
        </StatusMessage>
      )}
    </div>
  )
}
