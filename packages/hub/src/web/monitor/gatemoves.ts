import type { GateAction, TaskStatus } from "../../shared/api.js"

/**
 * Which action buttons a task's column offers, as data.
 *
 * Split out of `GateActions.tsx` so `node --test` can reach it: there is no DOM
 * harness in this package (see `web/ui/tone.ts`), so any rule about which button
 * appears where has to live where a test can call it. The component renders this
 * table and nothing else decides.
 */

export interface Move {
  /** Stable key and toast context. Not a route — see `endpoint`. */
  readonly action: GateAction | "plan-request" | "plan-request-cancel"
  /**
   * Where the button POSTs. Most moves go to `/api/gate/<action>`, but the plan
   * request is not a gate move — it moves no file and writes no commit — so the
   * route cannot be derived from the action name.
   */
  readonly endpoint: string
  readonly label: string
  readonly title: string
  /** Prose naming what actually happens, in the world, on confirm. */
  readonly detail: string
  readonly danger?: boolean
  readonly withReason?: boolean
  /**
   * Offered even while a loop drives the task. Gate moves are refused on a
   * held claim so their buttons pre-disable; a move that core explicitly
   * honours under claim (withdrawing a plan request) must not — the withdrawal
   * was built precisely for "a loop has since started acting on it".
   */
  readonly allowClaimed?: boolean
}

/** Which moves a task's column offers. A status with no entry gets no buttons. */
const MOVES: Partial<Record<TaskStatus, readonly Move[]>> = {
  draft: [
    {
      action: "approve-task",
      endpoint: "/api/gate/approve-task",
      label: "Approve",
      title: "Approve this task?",
      detail: "Moves it to queued/ so the loop can plan it, and commits the move to git.",
    },
  ],
  "plan-review": [
    {
      action: "approve-plan",
      endpoint: "/api/gate/approve-plan",
      label: "Approve plan",
      title: "Approve this plan?",
      detail: "Moves the task to in-progress/ so the loop can build it, and commits the move to git.",
    },
    {
      action: "replan",
      endpoint: "/api/gate/replan",
      label: "Replan",
      title: "Send this plan back?",
      detail: "Moves the task back to queued/ marked plan-next — the next claim/watch re-plans it first — and commits the move to git.",
      withReason: true,
    },
  ],
  "in-progress": [
    {
      action: "replan",
      endpoint: "/api/gate/replan",
      label: "Replan",
      title: "Send this task back to planning?",
      detail: "Moves the task back to queued/ marked plan-next — the next claim/watch re-plans it first — and commits the move to git.",
      withReason: true,
    },
  ],
  "in-review": [
    {
      action: "ship",
      endpoint: "/api/gate/ship",
      label: "Ship",
      title: "Ship this task?",
      detail:
        "Moves it to completed/, commits to git, AND opens a pull request. This is visible outside your machine. (The PR is best-effort — if it can't be opened the task still ships, and the reason is reported.)",
      danger: true,
    },
  ],
}

/**
 * The queued column's pair. They are one control in two states, not two buttons:
 * a task either carries a request or it doesn't.
 *
 * The copy has to be honest that nothing starts. The hub writes a marker and
 * stops there — it never claims work and never runs a stage — so a button that
 * read "Plan now" would promise something no hub click can deliver.
 */
const PLAN_MOVE: Move = {
  action: "plan-request",
  endpoint: "/api/plan-request",
  label: "Plan",
  title: "Plan this task next?",
  detail:
    "Writes a plan-request marker in the backlog — that is all. No file moves, no git commit, and the hub starts nothing itself. " +
    "Nothing runs until a watcher or a claim picks the task up; when one does, this task is planned before other queued tasks " +
    "(build-ready work in in-progress/ is still claimed first). You can withdraw the request until then.",
}

const CANCEL_PLAN_MOVE: Move = {
  action: "plan-request-cancel",
  endpoint: "/api/plan-request/cancel",
  label: "Cancel plan request",
  title: "Withdraw the plan request?",
  detail:
    "Deletes the plan-request marker. The task stays in queued/ and is still planned in the normal order on some later tick — " +
    "this only removes the “plan this one next” hint. Nothing is moved and nothing is committed.",
  allowClaimed: true,
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
  endpoint: "/api/gate/abandon",
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
  endpoint: "/api/gate/remove",
  label: "Remove",
  title: "Remove this task?",
  detail:
    "Deletes the task file from the backlog and commits the removal. Unless you set ignoreBacklog: false, the backlog is not tracked by git — so this is permanent. Abandon keeps the file.",
  danger: true,
}

/**
 * The forward moves a column offers. `queued` is the only one whose answer
 * depends on task state rather than column alone.
 */
export const forwardMoves = (status: string, opts: { readonly planRequested?: boolean } = {}): readonly Move[] => {
  if (status === "queued") return [opts.planRequested ? CANCEL_PLAN_MOVE : PLAN_MOVE]
  return MOVES[status as TaskStatus] ?? []
}

/**
 * The cancellations, offered on every column where they can work — core refuses
 * a completed or already-abandoned task, so no button should promise otherwise.
 */
export const cancellationMoves = (status: string): readonly Move[] =>
  status === "completed" || status === "abandoned" ? [REMOVE_MOVE] : [ABANDON_MOVE, REMOVE_MOVE]
