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
  const moves = MOVES[status as TaskStatus]
  if (!moves) return null
  return (
    <div className="gate-actions">
      {moves.map((m) => (
        <GateButton key={m.action} move={m} task={task} status={status as TaskStatus} kind={kind} claimed={claimed} />
      ))}
    </div>
  )
}
