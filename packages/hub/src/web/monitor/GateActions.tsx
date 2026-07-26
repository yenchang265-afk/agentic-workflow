import { useState } from "react"
import type { GateAction, GateResult, TaskCard, TaskStatus } from "../../shared/api.js"
import { postAction } from "../api.js"
import { repoPath, useRepo } from "../repo.js"
import { Button } from "../ui/Button.js"
import { Confirm } from "../ui/Confirm.js"

/**
 * The gate buttons on a task card. Each performs a human gate move through
 * core's `workflow/gate.ts` — the same entry point both hosts call.
 *
 * Every one of these commits to git, and `ship` opens a pull request, so all of
 * them go through <Confirm> with copy that names the effect. The button knows
 * its own column, so it names its gate explicitly rather than letting the server
 * infer one from wherever the task sits.
 */

interface Move {
  readonly action: GateAction
  readonly label: string
  readonly title: string
  /** Prose naming what actually happens, in the world, on confirm. */
  readonly detail: string
  readonly danger?: boolean
  readonly withReason?: boolean
}

/** Which moves a task's column offers. A status with no entry gets no buttons. */
const MOVES: Partial<Record<TaskStatus, readonly Move[]>> = {
  draft: [
    {
      action: "approve-task",
      label: "Approve",
      title: "Approve this task?",
      detail: "Moves it to queued/ so the loop can plan it, and commits the move to git.",
    },
  ],
  "plan-review": [
    {
      action: "approve-plan",
      label: "Approve plan",
      title: "Approve this plan?",
      detail: "Moves the task to in-progress/ so the loop can build it, and commits the move to git.",
    },
    {
      action: "replan",
      label: "Replan",
      title: "Send this plan back?",
      detail: "Moves the task back to queued/ for a fresh PLAN pass, and commits the move to git.",
      withReason: true,
    },
  ],
  "in-progress": [
    {
      action: "replan",
      label: "Replan",
      title: "Send this task back to planning?",
      detail: "Moves the task back to queued/ for a fresh PLAN pass, and commits the move to git.",
      withReason: true,
    },
  ],
  "in-review": [
    {
      action: "ship",
      label: "Ship",
      title: "Ship this task?",
      detail:
        "Moves it to completed/, commits to git, AND opens a pull request. This is visible outside your machine.",
      danger: true,
    },
  ],
}

/**
 * The two cancellations are offered on every column, so they live outside MOVES.
 * They are deliberately a pair: `abandon` is the reversible one (the task file
 * moves to `abandoned/` and can be moved back), `remove` deletes.
 *
 * `abandoned` was a first-class status with no way to reach it until this button
 * existed — the docs told people to move files by hand — so it is listed FIRST,
 * as the cancellation to reach for.
 */
const ABANDON_MOVE: Move = {
  action: "abandon",
  label: "Abandon",
  title: "Abandon this task?",
  detail: "Moves the task to abandoned/ and commits the move. The file is kept, so this can be undone by moving it back.",
  withReason: true,
}

/**
 * Remove hard-deletes the task file rather than moving it, and commits the
 * delete. Danger copy names the irreversibility; core still refuses a
 * live-driven or claim-held task.
 *
 * The copy leads with the DEFAULT: `ignoreBacklog` defaults to true, which keeps
 * the backlog out of git entirely, so for most installs there is no history to
 * recover from and "git keeps it" would be a false reassurance.
 */
const REMOVE_MOVE: Move = {
  action: "remove",
  label: "Remove",
  title: "Remove this task?",
  detail:
    "Deletes the task file from the backlog and commits the removal. Unless you set ignoreBacklog: false, the backlog is not tracked by git — so this is permanent. Abandon keeps the file.",
  danger: true,
}

const GateButton = ({
  move,
  task,
  status,
  kind,
  claimed,
}: {
  move: Move
  task: TaskCard
  status: TaskStatus
  kind: string
  claimed: boolean
}) => {
  const { repoId } = useRepo()
  const [reason, setReason] = useState("")
  const [result, setResult] = useState<GateResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    try {
      setResult(
        await postAction<GateResult>(repoPath(`/api/gate/${move.action}`, repoId), {
          id: task.id,
          expectStatus: status,
          kind,
          ...(move.withReason && reason.trim() ? { reason: reason.trim() } : {}),
        }),
      )
      setError(null)
    } catch (e) {
      setResult(null)
      setError((e as Error).message)
    }
  }

  // A claimed task is being driven right now; core refuses the move anyway, but
  // saying so up front beats a confirm dialog that leads to a refusal.
  if (claimed) {
    return (
      <Button disabled title="A loop is driving this task — stop it, or wait for it to park.">
        {move.label}
      </Button>
    )
  }

  return (
    <>
      <Confirm
        title={move.title}
        detail={move.detail}
        confirmLabel={move.label}
        {...(move.danger ? { danger: true } : {})}
        onConfirm={run}
        trigger={<Button variant={move.danger ? "danger" : "primary"}>{move.label}</Button>}
      >
        {move.withReason && (
          <label className="form-field">
            <span>reason (threaded into the next PLAN pass)</span>
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
      </Confirm>
      {/* A refusal is data, not an error: core explains why, and the board is unchanged. */}
      {result && !result.ok && <p className={`gate-msg gate-msg--${result.variant ?? "warning"}`}>{result.message}</p>}
      {result?.ok && <p className="gate-msg gate-msg--ok">{result.message}</p>}
      {error && <p className="gate-msg gate-msg--warning">{error}</p>}
    </>
  )
}

export const GateActions = ({
  task,
  status,
  kind,
  claimed,
}: {
  task: TaskCard
  status: string
  kind: string
  claimed: boolean
}) => {
  // The cancellations are available on every column; the forward moves are
  // column-specific. Abandon is offered only where it can work — core refuses a
  // completed or already-abandoned task, so no button should promise otherwise.
  const cancellable = status !== "completed" && status !== "abandoned"
  const moves = [...(MOVES[status as TaskStatus] ?? []), ...(cancellable ? [ABANDON_MOVE] : []), REMOVE_MOVE]
  return (
    <div className="gate-actions">
      {moves.map((m) => (
        <GateButton key={m.action} move={m} task={task} status={status as TaskStatus} kind={kind} claimed={claimed} />
      ))}
    </div>
  )
}
