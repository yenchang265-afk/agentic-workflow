import { useState } from "react"
import type { GateResult, ShipPublish, TaskCard, TaskStatus } from "../../shared/api.js"
import { postAction } from "../api.js"
import { useFeedback } from "../feedback.js"
import { repoPath, useRepo } from "../repo.js"
import { Button } from "../ui/Button.js"
import { Confirm } from "../ui/Confirm.js"
import { StatusMessage } from "../ui/StatusMessage.js"
import { gateTone } from "../ui/tone.js"
import { PUBLISH_CHOICES, cancellationMoves, forwardMoves, type Move } from "./gatemoves.js"

/**
 * The action buttons on a task card. Most perform a human gate move through
 * core's `workflow/gate.ts` — the same entry point both hosts call — and commit
 * to git; `ship` also opens a pull request. The queued column's Plan button is
 * the exception: it writes an ordering marker and nothing else.
 *
 * All of them go through <Confirm> with copy that names the real effect. The
 * button knows its own column, so it names its move explicitly rather than
 * letting the server infer one from wherever the task sits.
 *
 * Which button appears where lives in `gatemoves.ts`, where a test can reach it.
 */

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
  const { report } = useFeedback()
  const [reason, setReason] = useState("")
  /**
   * The ship dialog's publish choice. `""` is not "no answer yet" — it is the
   * DEFAULT and a real answer: "whatever this repo's `shipPublish` says", sent
   * as an omitted field so core's `shipPublishFor` resolves it.
   *
   * Preselecting a concrete mode instead would be a live hazard rather than a
   * convenience: the monitor does not load the config (that is the Config tab's
   * fetch), so the only value it could preselect is a guess — and guessing `pr`
   * on a repo configured `local` pushes work the human deliberately kept off the
   * network, with the dialog showing their own "choice" back to them.
   */
  const [publish, setPublish] = useState<ShipPublish | "">("")
  /**
   * The ship dialog's PR base. Blank is the default and the right one: the
   * gate already knows the ref the run was cut from and the diff REVIEW
   * graded against it, so typing a branch here deliberately retargets the PR
   * away from the change that was reviewed. Nothing sensible could be
   * prefilled — the monitor does not resolve the recorded base.
   */
  const [base, setBase] = useState("")
  const [result, setResult] = useState<GateResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const context = `${move.action} · ${task.shortId}`

  const run = async (): Promise<void> => {
    try {
      // The route comes off the move, not off its action name: the plan request
      // is not a gate move and does not live under /api/gate/.
      const res = await postAction<GateResult>(repoPath(move.endpoint, repoId), {
        id: task.id,
        expectStatus: status,
        kind,
        ...(move.withReason && reason.trim() ? { reason: reason.trim() } : {}),
        ...(move.withPublish && publish ? { publish } : {}),
        ...(move.withBase && base.trim() ? { base: base.trim() } : {}),
      })
      setResult(res)
      setError(null)
      // A successful move relocates the task, so this card is about to unmount
      // and take its own confirmation with it. The toast and the log outlive it
      // — that is the only place a landed move is ever acknowledged.
      report({ tone: gateTone(res), message: res.message, context, repo: repoId })
    } catch (e) {
      const message = (e as Error).message
      setResult(null)
      setError(message)
      report({ tone: "error", message, context, repo: repoId })
    }
  }

  // A claimed task is being driven right now; core refuses the move anyway, but
  // saying so up front beats a confirm dialog that leads to a refusal.
  // Moves core explicitly honours under claim (`allowClaimed` — withdrawing a
  // plan request) skip this: pre-disabling them made the withdrawal
  // unreachable in exactly the state it was built for.
  //
  // `aria-disabled` rather than `disabled`: a disabled button is not focusable,
  // so the reason — which used to live only in a `title` — was unreachable by
  // keyboard, screen reader and touch alike. It stays focusable, announces
  // itself as unavailable, and says why in text.
  if (claimed && !move.allowClaimed) {
    return (
      <Button
        aria-disabled
        onClick={() =>
          report({
            tone: "info",
            message: "A loop is driving this task — stop it, or wait for it to park at a gate.",
            context,
            repo: repoId,
          })
        }
      >
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
        {move.withPublish && (
          <label className="form-field">
            <span>publish</span>
            <select value={publish} onChange={(e) => setPublish(e.target.value as ShipPublish | "")}>
              <option value="">Use this repo's setting (shipPublish)</option>
              {PUBLISH_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {/* The consequence, spelled out under the control rather than left
                to the option label: "push" and "local" differ by whether the
                work leaves the machine, which is the whole reason to choose. */}
            <small>{PUBLISH_CHOICES.find((c) => c.value === publish)?.detail ?? "Whatever .agentic-workflow.json configures; the default is to open a draft PR."}</small>
          </label>
        )}
        {move.withBase && (
          <label className="form-field">
            <span>base branch (optional)</span>
            <input type="text" value={base} onChange={(e) => setBase(e.target.value)} placeholder="the branch this run was cut from" />
            {/* Spelled out because blank is NOT "the repo default" here: the
                recorded run base outranks the configured prBase, and both
                outrank the platform's default branch. */}
            <small>Leave blank to target the branch this task was cut from, then this repo&apos;s prBase, then the platform default. A branch that isn&apos;t on origin refuses the PR rather than opening it elsewhere.</small>
          </label>
        )}
      </Confirm>
      {/* In place as well as in the toast: a refusal is data, not an error —
          core explains why and the board is unchanged, so the explanation
          belongs next to the button that earned it. Dismissable, because
          nothing else clears it: this card does not unmount on a refusal, and
          the message used to sit there for the rest of the session. */}
      {result && (
        <StatusMessage tone={gateTone(result)} onDismiss={() => setResult(null)}>
          {result.message}
        </StatusMessage>
      )}
      {error && (
        <StatusMessage tone="error" onRetry={run} onDismiss={() => setError(null)}>
          {error}
        </StatusMessage>
      )}
    </>
  )
}

/**
 * The cancellations, behind a disclosure.
 *
 * Children are rendered only while it is open, and that is load-bearing rather
 * than an optimisation: every move carries a <Confirm>, which carries a
 * <dialog>. Offering Abandon and Remove inline on every card meant a backlog
 * with 300 completed tasks mounted 300 hidden dialogs that nobody could ever
 * have wanted to open.
 */
const OverflowMoves = ({
  moves,
  task,
  status,
  kind,
  claimed,
}: {
  moves: readonly Move[]
  task: TaskCard
  status: TaskStatus
  kind: string
  claimed: boolean
}) => {
  const [open, setOpen] = useState(false)
  return (
    <details className="gate-overflow" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary aria-label={`More actions for ${task.title}`}>More…</summary>
      {open && (
        <div className="gate-overflow__menu">
          {moves.map((m) => (
            <GateButton key={m.action} move={m} task={task} status={status} kind={kind} claimed={claimed} />
          ))}
        </div>
      )}
    </details>
  )
}

export const GateActions = ({
  task,
  status,
  kind,
  claimed,
  planRequested,
}: {
  task: TaskCard
  status: string
  kind: string
  claimed: boolean
  /** queued only: whether this task already carries a plan request, which swaps Plan for its withdrawal. */
  planRequested?: boolean
}) => {
  // The cancellations are available on every column; the forward moves are
  // column-specific, and on `queued` also state-specific.
  const forward = forwardMoves(status, { ...(planRequested === undefined ? {} : { planRequested }) })
  const cancellations = cancellationMoves(status)

  // The forward move gets the weight; the cancellations go behind a disclosure.
  // Flat, they were three buttons of near-equal emphasis — and because
  // ABANDON_MOVE carries no `danger` flag it rendered `primary`, identical to
  // Approve, while on the ship gate the action you wanted was the red one and
  // the cancellation was blue. The hierarchy was not just flat, it was inverted.
  return (
    <div className="gate-actions">
      {forward.map((m) => (
        <GateButton key={m.action} move={m} task={task} status={status as TaskStatus} kind={kind} claimed={claimed} />
      ))}
      {cancellations.length > 0 && (
        <OverflowMoves
          moves={cancellations}
          task={task}
          status={status as TaskStatus}
          kind={kind}
          claimed={claimed}
        />
      )}
    </div>
  )
}
