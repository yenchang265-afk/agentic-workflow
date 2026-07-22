/**
 * Out-of-order `workflow_stage` detector. The orchestration protocol is
 * `workflow_stage → spawn → workflow_advance` per stage, and `advance()` is the only
 * thing that moves `active.stage` — so a `workflow_stage` call for any stage other
 * than the one the machine is at means the orchestrator skipped `workflow_advance`.
 * Left unchecked, the drift only surfaces much later as a rejected
 * `workflow_verdict` ("The loop is at build, not verify — verdict ignored"): the
 * check subagent completes real work, its verdict is dropped, and the
 * no-verdict retry burns a re-run before ERROR-stopping the loop.
 *
 * Returns null when the requested stage matches, else the error message the
 * `workflow_stage` tool should fail with.
 */
export const stageOrderError = (activeStage: string, requested: string): string | null =>
  requested === activeStage
    ? null
    : `Stage "${requested}" requested but the loop is at "${activeStage}" — ` +
      `call workflow_advance with the finished ${activeStage} stage's output first, then fire the stage its action names.`
