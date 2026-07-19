import { useState } from "react"
import type { DeletePreview, GateResult, TaskCard, TaskStatus } from "../../shared/api.js"
import { fetchJson, postAction } from "../api.js"
import { repoPath, useRepo } from "../repo.js"
import { Button } from "../ui/Button.js"
import { Confirm } from "../ui/Confirm.js"

/**
 * The delete button on a task card — the hub's only irreversible action.
 *
 * Unlike a gate move, this cannot be undone from the board, so the dialog is
 * built around a **preview**: before confirming, the human sees the worktree,
 * the branch, how many commits would be lost, and (for a tracking epic) every
 * child slice that goes with it. `force` is offered only once the preview
 * reports something that actually blocks — an always-visible force checkbox
 * trains people to tick it.
 */

const Blockers = ({ preview }: { preview: DeletePreview }) => (
  <ul className="delete-blockers">
    {preview.blockers.map((b) => (
      <li key={b}>{b}</li>
    ))}
  </ul>
)

const Summary = ({ preview }: { preview: DeletePreview }) => (
  <>
    <p>
      Permanently deletes <code>{preview.id}</code>
      {preview.worktree ? ", its worktree" : ""}
      {preview.branchExists ? `, and the branch ${preview.branch}` : ""}. The removal is committed to git.
      {preview.branchExists ? " A pushed origin/ branch is left alone." : ""}
    </p>
    {preview.isEpic && (
      <p>
        This is a <strong>tracking epic</strong>: {preview.children.length} child slice(s) are deleted with it
        {preview.children.length > 0 && (
          <>
            {" — "}
            {preview.children.map((c) => c.id).join(", ")}
          </>
        )}
        .
      </p>
    )}
  </>
)

export const DeleteAction = ({ task, status, claimed }: { task: TaskCard; status: TaskStatus; claimed: boolean }) => {
  const { repoId } = useRepo()
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  const [result, setResult] = useState<GateResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Lazily fetched when the trigger is clicked: the click bubbles to Confirm's
  // opener, so one click both loads the preview and opens the dialog. Fetching
  // eagerly would mean one request per card on every board render.
  const load = async (): Promise<void> => {
    setPreview(null)
    setLoadError(null)
    setForce(false)
    setResult(null)
    setError(null)
    try {
      setPreview(await fetchJson<DeletePreview>(repoPath(`/api/tasks/${encodeURIComponent(task.id)}/delete-preview`, repoId)))
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }

  const run = async (): Promise<void> => {
    try {
      setResult(
        await postAction<GateResult>(repoPath(`/api/tasks/${encodeURIComponent(task.id)}/delete`, repoId), {
          id: task.id,
          expectStatus: status,
          ...(force ? { force: true } : {}),
        }),
      )
      setError(null)
    } catch (e) {
      setResult(null)
      setError((e as Error).message)
    }
  }

  // Core refuses a task a live loop is driving regardless of force — say so here
  // rather than leading someone through a dialog to a guaranteed refusal.
  if (claimed) {
    return (
      <Button disabled title="A loop is driving this task — stop it before deleting.">
        Delete
      </Button>
    )
  }

  // An epic needs force even with no blockers (the cascade itself is the risk).
  const needsForce = preview ? preview.blockers.length > 0 || preview.isEpic : false

  return (
    <>
      <Confirm
        title="Delete this task?"
        danger
        confirmLabel="Delete"
        detail={
          loadError ? (
            <p>Could not read what this would delete: {loadError}</p>
          ) : !preview ? (
            <p>Checking what this would delete…</p>
          ) : (
            <>
              <Summary preview={preview} />
              {preview.blockers.length > 0 && (
                <>
                  <p>
                    <strong>This would discard work:</strong>
                  </p>
                  <Blockers preview={preview} />
                </>
              )}
            </>
          )
        }
        onConfirm={run}
        trigger={
          <Button variant="danger" onClick={load}>
            Delete
          </Button>
        }
      >
        {needsForce && (
          <label className="form-field form-field--inline">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>
              {preview?.isEpic && preview.blockers.length === 0
                ? `Yes — delete this epic and its ${preview.children.length} child slice(s)`
                : "Yes — discard the work listed above"}
            </span>
          </label>
        )}
      </Confirm>
      {result && !result.ok && <p className={`gate-msg gate-msg--${result.variant ?? "warning"}`}>{result.message}</p>}
      {result?.ok && <p className="gate-msg gate-msg--ok">{result.message}</p>}
      {error && <p className="gate-msg gate-msg--warning">{error}</p>}
    </>
  )
}
