import assert from "node:assert/strict"
import os from "node:os"
import { test } from "node:test"
import { parseTask, serializeTask, taskToInput, unknownFrontmatterKeys, type Task } from "./schema.js"
import {
  appendNote,
  appendPlan,
  appendRunLog,
  auditNote,
  canTransition,
  claimFirst,
  claimOlderThan,
  claimTask,
  claimWriterDead,
  releaseClaim,
  epicSiblings,
  extractPlan,
  extractRunBase,
  extractRunBranch,
  extractRunDiffstat,
  nextActions,
  extractReplanReason,
  extractStopContext,
  NO_REASON_FALLBACK,
  pendingPlanRejection,
  TASK_RESHAPED_MARKER,
  replanFor,
  unaddressedRejectionCount,
  findByIdIn,
  hasPlan,
  isClaimable,
  isOrphanedClaim,
  isOrphanedStartedClaim,
  isRecoverable,
  joinTaskBody,
  listClaimIds,
  markClaimed,
  moveTask,
  pairingCoverage,
  planHeadingCount,
  PLAN_HEADING,
  releaseOrphanedClaims,
  removeTaskFile,
  resolveTaskIdAnywhere,
  resolveTaskIdIn,
  rewriteTask,
  selectNext,
  selectOrder,
  splitTaskBody,
  statusOf,
  STATUSES,
  writeTask,
  summarizeBacklog,
  type TaskStatus,
  wasInterrupted,
} from "./store.js"

/**
 * store.ts shells out via Bun's `$` for moveTask (mkdir/mv), which the
 * node+tsx test runner can't execute. Mirrors the fake shell in
 * `../workflow/git.test.ts`.
 */
type FakeResult = { exitCode?: number; stdout?: string; stderr?: string }

const makeShell = (handler: (cmd: string) => FakeResult, log?: string[]) => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) {
        const e = exprs[i]
        cmd += Array.isArray(e) ? e.join(" ") : String(e)
      }
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log?.push(cmd)
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = handler(cmd)
        return Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => r.stderr ?? "" },
        }).then(resolve, reject)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

const task = (id: string, priority: number, body = ""): Task => ({
  id,
  title: id,
  priority,
  acceptance: [],
  labels: [],
  body,
  path: `/r/docs/tasks/in-progress/${id}.md`,
})

test("selectNext returns null for an empty backlog", () => {
  assert.equal(selectNext([]), null)
})

test("selectNext picks the lowest priority number first", () => {
  const picked = selectNext([task("b", 5), task("a", 2), task("c", 9)])
  assert.equal(picked?.id, "a")
})

test("selectNext breaks priority ties by id", () => {
  const picked = selectNext([task("zebra", 1), task("apple", 1)])
  assert.equal(picked?.id, "apple")
})

test("selectNext does not mutate the input array", () => {
  const tasks = [task("b", 5), task("a", 2)]
  selectNext(tasks)
  assert.equal(tasks[0]?.id, "b")
})

test("hasPlan is false when the body has no plan heading", () => {
  assert.equal(hasPlan(task("a", 0, "Some description.")), false)
})

test("hasPlan is true once the plan heading is present", () => {
  const body = `Some description.\n\n${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(hasPlan(task("a", 0, body)), true)
})

/**
 * `hasPlan` gates the PLAN park validator, the plan-approval gate and
 * `isClaimable`; `extractPlan` is what actually fills `artifacts.plan` for BUILD.
 * When the two could disagree, a task sailed through all three gates and then
 * fired BUILD with the whole `{{#artifacts.plan}}` section dropped — the
 * plan-less build the park validator exists to prevent, reported by nothing.
 */
test("hasPlan ignores a heading quoted mid-line, exactly as extractPlan does", () => {
  // A task ABOUT this system: the heading appears, but not as a heading.
  const body = "Teach the loop to write a `## Implementation Plan` section."
  assert.equal(extractPlan(task("a", 0, body)), undefined)
  assert.equal(hasPlan(task("a", 0, body)), false)
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("hasPlan is false for a heading with nothing under it", () => {
  // extractPlan returns "" here, which is falsy at `entryState`'s
  // `plan ? { plan } : {}` — so "planned" must be false too.
  const body = `Some description.\n\n${PLAN_HEADING}\n`
  assert.equal(extractPlan(task("a", 0, body)), "")
  assert.equal(hasPlan(task("a", 0, body)), false)
})

test("hasPlan agrees with extractPlan on a plan followed only by audit notes", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> CLAIMED — loop starting [2026-01-01T00:00:00Z by t]\n`
  assert.equal(extractPlan(task("a", 0, body)), "1. Do the thing.")
  assert.equal(hasPlan(task("a", 0, body)), true)
})

test("extractPlan returns undefined when there is no plan heading", () => {
  assert.equal(extractPlan(task("a", 0, "Some description.")), undefined)
})

test("extractPlan returns the text after the heading, trimmed", () => {
  const body = `Some description.\n\n${PLAN_HEADING}\n\n1. Do the thing.\n2. Test it.`
  assert.equal(extractPlan(task("a", 0, body)), "1. Do the thing.\n2. Test it.")
})

test("extractPlan stops at the audit tail — a plan does not accrete CLAIMED/BUILD/VERDICT notes", () => {
  // `appendNote` writes `\n> %s\n` at EOF and `appendPlan` puts the plan there too,
  // so every lifecycle note lands after the heading and used to read as plan text.
  const body =
    `Some description.\n\n${PLAN_HEADING}\n\n1. Do the thing.\n2. Test it.\n` +
    `\n> CLAIMED — loop starting [2026-01-01T00:00:00.000Z by dev]\n` +
    `\n> BUILD started (iteration 1) [2026-01-01T00:05:00.000Z by dev]\n` +
    `\n> VERIFY verdict: FAIL — two tests red [2026-01-01T00:09:00.000Z by dev]\n`
  assert.equal(extractPlan(task("a", 0, body)), "1. Do the thing.\n2. Test it.")
})

test("extractPlan returns the NEWEST plan when a task was replanned", () => {
  // `rejectPlan` only appends a note; `appendPlan` appends a SECOND heading at EOF.
  const body =
    `Some description.\n\n${PLAN_HEADING}\n\nStale approach.\n` +
    `\n> Plan rejected — wrong layer [2026-01-01T00:00:00.000Z by dev]\n` +
    `\n${PLAN_HEADING}\n\nCorrect approach.\n`
  assert.equal(extractPlan(task("a", 0, body)), "Correct approach.")
})

test("planHeadingCount counts line-anchored headings only — what runPark warns on", () => {
  // The PLAN stage is told to REPLACE an existing plan, not stack one. Nothing
  // enforces that but this count, so it has to agree with `extractPlan` about
  // what a heading is: line-anchored, never mid-line.
  assert.equal(planHeadingCount("Some description.\n"), 0)
  assert.equal(planHeadingCount(`Some description.\n\n${PLAN_HEADING}\n\n1. Do the thing.\n`), 1)
  assert.equal(
    planHeadingCount(
      `Some description.\n\n${PLAN_HEADING}\n\nStale approach.\n` +
        `\n> Plan rejected — wrong layer [2026-01-01T00:00:00.000Z by dev]\n` +
        `\n${PLAN_HEADING}\n\nCorrect approach.\n`,
    ),
    2,
    "the stacked shape a replanned task invites",
  )
  // A task ABOUT the loop quoting the heading mid-line is not a second plan —
  // this repo's own backlog is full of those.
  assert.equal(planHeadingCount(`${PLAN_HEADING}\n\n1. Write the ${PLAN_HEADING} onto the file.\n`), 1)
})

test("extractPlan keeps a legitimate blockquote inside a plan", () => {
  // No `[…]` stamp ⇒ not an audit note, so a quoted requirement stays in the plan.
  const body = `${PLAN_HEADING}\n\n1. Honor the ticket:\n> the export must stay idempotent\n2. Test it.`
  assert.equal(extractPlan(task("a", 0, body)), "1. Honor the ticket:\n> the export must stay idempotent\n2. Test it.")
})

// The exact note shape `replanTask` writes: marker, fixed prose, reason, stamp.
const rejectionNote = (reason?: string, stamp = "2026-01-02T00:00:00.000Z by dev"): string =>
  `\n> Plan rejected — sent back to queued for re-planning${reason ? ` — ${reason}` : ""} [${stamp}]\n`

// The exact note shape `runDone` writes. The branch is recorded here because
// nothing else survives to the ship gate — the state snapshot is cleared by
// `runDone` itself, and `shipTask` runs later from a fresh process.
const doneNote = (branch?: string, stamp = "2026-01-02T00:00:00.000Z by dev", base?: string, diff?: string): string =>
  `\n> Loop done — review passed${branch ? ` on branch ${branch}` : ""}${base ? `, base ${base}` : ""}, awaiting human diff review${diff ? `; diff: ${diff}` : ""} [${stamp}]\n`

test("extractRunBranch reads the branch the completed run built on", () => {
  assert.equal(extractRunBranch(task("a", 0, `Body.\n${doneNote("claude/my-feature")}`)), "claude/my-feature")
})

test("extractRunBranch lets the newest run win", () => {
  // A replanned-and-rebuilt task carries one note per run; only the last names
  // the branch that actually holds the work.
  const body = doneNote("feature/first", "2026-01-02T00:00:00.000Z by dev") + doneNote("feature/second", "2026-01-03T00:00:00.000Z by dev")
  assert.equal(extractRunBranch(task("a", 0, body)), "feature/second")
})

test("extractRunBranch returns undefined for a note without a branch, or no note at all", () => {
  assert.equal(extractRunBranch(task("a", 0, doneNote())), undefined)
  assert.equal(extractRunBranch(task("a", 0, "Just a description.")), undefined)
})

test("extractRunBranch ignores an unstamped line and rejects a non-ref branch", () => {
  // This value reaches `git push`, so a plan or comment merely QUOTING the note
  // must not be able to inject one.
  const quoted = "\n> Loop done — review passed on branch attacker/branch, awaiting human diff review\n"
  assert.equal(extractRunBranch(task("a", 0, quoted)), undefined)
  assert.equal(extractRunBranch(task("a", 0, doneNote("--upload-pack=evil"))), undefined)
})

test("extractRunBranch is unchanged by the base clause the note now also carries", () => {
  // The regression that matters most here. Both fields terminate at the first
  // comma, so a base written BETWEEN the branch and its comma would make the
  // branch read "claude/my-feature base release/2.4", fail the ref check, and
  // silently strand every ship with no branch at all.
  const body = doneNote("claude/my-feature", "2026-01-02T00:00:00.000Z by dev", "release/2.4")
  assert.equal(extractRunBranch(task("a", 0, body)), "claude/my-feature")
})

test("extractRunBase reads the ref the completed run was cut from", () => {
  const body = doneNote("claude/my-feature", "2026-01-02T00:00:00.000Z by dev", "release/2.4")
  assert.equal(extractRunBase(task("a", 0, body)), "release/2.4")
})

test("extractRunBase lets the newest run win, like the branch beside it", () => {
  const body =
    doneNote("feature/first", "2026-01-02T00:00:00.000Z by dev", "main") + doneNote("feature/second", "2026-01-03T00:00:00.000Z by dev", "release/2.4")
  assert.equal(extractRunBase(task("a", 0, body)), "release/2.4")
})

test("extractRunBase returns undefined for a note written before the clause existed", () => {
  // Backward compat is the whole story for tasks completed before this shipped:
  // no clause, no base, and the ship gate falls back to the platform default —
  // exactly what it did before.
  assert.equal(extractRunBase(task("a", 0, doneNote("claude/my-feature"))), undefined)
  assert.equal(extractRunBase(task("a", 0, doneNote())), undefined)
  assert.equal(extractRunBase(task("a", 0, "Just a description.")), undefined)
})

test("extractRunBase ignores an unstamped line and rejects a non-ref base", () => {
  // This value reaches `gh pr create --base`, so the same injection rule the
  // branch has applies: a plan or comment merely QUOTING the note proves nothing.
  const quoted = "\n> Loop done — review passed on branch feature/x, base attacker/branch, awaiting human diff review\n"
  assert.equal(extractRunBase(task("a", 0, quoted)), undefined)
  assert.equal(extractRunBase(task("a", 0, doneNote("feature/x", "2026-01-02T00:00:00.000Z by dev", "--upload-pack=evil"))), undefined)
  assert.equal(extractRunBase(task("a", 0, doneNote("feature/x", "2026-01-02T00:00:00.000Z by dev", "$(whoami)"))), undefined)
})

const STAT = "3 files changed, 40 insertions(+), 2 deletions(-)"

test("extractRunDiffstat reads the shortstat off the done note, and the branch/base beside it are unmoved", () => {
  // The regression that matters: the stat's own commas must not shift what the
  // comma-terminated fields ahead of it read.
  const t = task("a", 0, doneNote("claude/my-feature", "2026-01-02T00:00:00.000Z by dev", "release/2.4", STAT))
  assert.equal(extractRunDiffstat(t), STAT)
  assert.equal(extractRunBranch(t), "claude/my-feature")
  assert.equal(extractRunBase(t), "release/2.4")
})

test("extractRunDiffstat returns undefined pre-clause, unstamped, or off-shape", () => {
  assert.equal(extractRunDiffstat(task("a", 0, doneNote("feature/x"))), undefined)
  assert.equal(extractRunDiffstat(task("a", 0, "Just a description.")), undefined)
  // Unstamped quoting proves nothing, same rule as the refs beside it.
  const quoted = `\n> Loop done — review passed on branch x, awaiting human diff review; diff: ${STAT}\n`
  assert.equal(extractRunDiffstat(task("a", 0, quoted)), undefined)
  // A hand-edited note carrying prose where the stat was reads as "no stat".
  assert.equal(extractRunDiffstat(task("a", 0, doneNote("feature/x", undefined, undefined, "see the PR for details"))), undefined)
})

test("extractRunDiffstat lets the newest run win, like the fields beside it", () => {
  const body =
    doneNote("feature/first", "2026-01-02T00:00:00.000Z by dev", "main", "1 file changed, 1 insertion(+)") +
    doneNote("feature/second", "2026-01-03T00:00:00.000Z by dev", "main", STAT)
  assert.equal(extractRunDiffstat(task("a", 0, body)), STAT)
})

test("extractReplanReason reads the reason off a pending rejection note", () => {
  // A reason may itself contain ` — `; only the FIRST fixed-prose prefix splits.
  const body =
    `Some description.\n\n${PLAN_HEADING}\n\nOld approach.\n` +
    `\n> Plan approved [2026-01-01T00:00:00.000Z by dev]\n` +
    rejectionNote("mtime is not enough on DrvFs — key on size too")
  assert.equal(extractReplanReason(task("a", 0, body)), "mtime is not enough on DrvFs — key on size too")
})

test("extractReplanReason returns undefined when the rejection carried no reason", () => {
  const body = `${PLAN_HEADING}\n\nOld approach.\n` + rejectionNote()
  assert.equal(extractReplanReason(task("a", 0, body)), undefined)
})

test("pendingPlanRejection distinguishes no-rejection / reasonless / reasoned", () => {
  // The three-state answer the entry builders need: a reasonless rejection is
  // still PENDING (it must render {{#replan}} with a fallback), which the
  // reason-only extractor cannot express.
  const none = `${PLAN_HEADING}\n\nApproach.\n`
  assert.equal(pendingPlanRejection(task("a", 0, none)), undefined)
  const bare = `${PLAN_HEADING}\n\nApproach.\n` + rejectionNote()
  assert.deepEqual(pendingPlanRejection(task("a", 0, bare)), {})
  const reasoned = `${PLAN_HEADING}\n\nApproach.\n` + rejectionNote("wrong layer")
  assert.deepEqual(pendingPlanRejection(task("a", 0, reasoned)), { reason: "wrong layer" })
})

test("pendingPlanRejection retires with the same anchors as the reason extractor", () => {
  const retired = `${PLAN_HEADING}\n\nOld.\n` + rejectionNote() + `\n> Plan written — parked for plan review [2026-01-03T00:00:00.000Z by dev]\n`
  assert.equal(pendingPlanRejection(task("a", 0, retired)), undefined)
  // A quoted, stamp-less rejection line is not lifecycle state.
  const unstamped = `${PLAN_HEADING}\n\nOld.\n> Plan rejected — sent back to queued for re-planning\n`
  assert.equal(pendingPlanRejection(task("a", 0, unstamped)), undefined)
})

test("a re-shape retires the rejection — the plan it critiqued and its goal are both gone", () => {
  // The retask path: plan rejected → task re-queued → human re-shapes the GOAL.
  // `retaskTask` also strips the plan section, so the PLAN_HEADING anchor is not
  // there to retire the rejection; without TASK_RESHAPED_MARKER the next PLAN
  // pass would be handed a critique of a plan that no longer exists, written
  // against a goal that has since changed.
  const body =
    "Reshaped goal.\n" +
    rejectionNote("the plan indexed the wrong table") +
    `\n> ${TASK_RESHAPED_MARKER.slice(2)} for re-shaping — approval withdrawn; superseded plan removed — wrong screen [2026-01-04T00:00:00.000Z by dev]\n`
  assert.equal(pendingPlanRejection(task("a", 0, body)), undefined)
  assert.equal(extractReplanReason(task("a", 0, body)), undefined)
})

test("a re-shape does NOT retire a rejection recorded after it", () => {
  // Order is the whole rule: re-shape, re-approve, re-plan, reject again — that
  // newest rejection is pending and must reach the next PLAN pass.
  const body =
    "Reshaped goal.\n" +
    `\n> ${TASK_RESHAPED_MARKER.slice(2)} for re-shaping — approval withdrawn [2026-01-04T00:00:00.000Z by dev]\n` +
    rejectionNote("still the wrong table")
  assert.deepEqual(pendingPlanRejection(task("a", 0, body)), { reason: "still the wrong table" })
})

// The exact note shape `runStop` writes for a non-transient stop with attempts
// (see `stopContextNote`) — the digest `replanTask` fuses into the rejection
// reason so a cap-tripped replan does not re-plan blind.
const stopNote = (digest: string, stamp = "2026-01-02T00:00:00.000Z by dev"): string => `\n> Run stopped — attempts: ${digest} [${stamp}]\n`

test("extractStopContext reads the last stopped run's attempts digest", () => {
  const digest = "iteration 1 VERIFY FAIL: 2 criteria unmet; iteration 2 REVIEW FAIL: unhandled error path"
  const body = `${PLAN_HEADING}\n\nApproach.\n` + stopNote(digest)
  assert.equal(extractStopContext(task("a", 0, body)), digest)
})

test("extractStopContext retires the digest once a newer plan addressed it", () => {
  // Same anchors as pendingPlanRejection: a new heading or a `Plan written`
  // park after the stop means the digest was planned against already.
  const replaced = `${PLAN_HEADING}\n\nNew approach.\n` + stopNote("iteration 1 VERIFY FAIL: x", "2026-01-01T00:00:00.000Z by dev") + `\n> Plan written — parked for plan review [2026-01-02T00:00:00.000Z by dev]\n`
  assert.equal(extractStopContext(task("a", 0, replaced)), undefined)
})

test("extractStopContext ignores an unstamped or digestless stop line", () => {
  const unstamped = `${PLAN_HEADING}\n\nOld.\n> Run stopped — attempts: iteration 1 VERIFY FAIL: fake\n`
  assert.equal(extractStopContext(task("a", 0, unstamped)), undefined)
  const digestless = `${PLAN_HEADING}\n\nOld.\n\n> Run stopped for another reason [2026-01-02T00:00:00.000Z by dev]\n`
  assert.equal(extractStopContext(task("a", 0, digestless)), undefined)
})

test("replanFor threads the reason, and falls back on a reasonless rejection", () => {
  const reasoned = `${PLAN_HEADING}\n\nOld.\n` + rejectionNote("wrong layer")
  assert.deepEqual(replanFor(task("a", 0, reasoned)), { reason: "wrong layer" })
  // A bare `replan <id>` must still render the {{#replan}} section — the
  // template has no inverted section, so the fallback must be a value.
  const bare = `${PLAN_HEADING}\n\nOld.\n` + rejectionNote()
  assert.deepEqual(replanFor(task("a", 0, bare)), { reason: NO_REASON_FALLBACK })
  assert.equal(replanFor(task("a", 0, `${PLAN_HEADING}\n\nOld.\n`)), undefined)
})

test("extractReplanReason retires a reason once a newer plan heading follows it", () => {
  // A re-plan appends its new heading at EOF — after the note — so the
  // rejection is addressed and must not resurface on the NEXT replan cycle.
  const body =
    `${PLAN_HEADING}\n\nStale approach.\n` +
    rejectionNote("wrong layer") +
    `\n${PLAN_HEADING}\n\nCorrect approach.\n`
  assert.equal(extractReplanReason(task("a", 0, body)), undefined)
})

test("extractReplanReason lets the latest of successive rejections win", () => {
  const body =
    `${PLAN_HEADING}\n\nStale approach.\n` +
    rejectionNote("wrong layer", "2026-01-02T00:00:00.000Z by dev") +
    `\n${PLAN_HEADING}\n\nSecond approach.\n` +
    rejectionNote("still wrong — cache must be size-keyed", "2026-01-03T00:00:00.000Z by dev")
  assert.equal(extractReplanReason(task("a", 0, body)), "still wrong — cache must be size-keyed")
})

test("extractReplanReason retires a reason via the Plan-written note when PLAN replaces in place", () => {
  // The stage prompt demands REPLACE-in-place, so the heading's byte offset
  // never moves past the rejection note — the heading anchor alone left the
  // reason pending forever and re-injected it into unrelated later PLAN
  // passes. The park gate's `Plan written` note is the retirement anchor that
  // survives in-place replacement.
  const body =
    `${PLAN_HEADING}\n\nReplaced-in-place approach.\n` +
    rejectionNote("wrong layer") +
    `\n> Plan written — parked for plan review [2026-01-03T00:00:00.000Z by dev]\n`
  assert.equal(extractReplanReason(task("a", 0, body)), undefined)
})

test("a rejection AFTER the last successful park is pending again", () => {
  const body =
    `${PLAN_HEADING}\n\nApproach.\n` +
    `\n> Plan written — parked for plan review [2026-01-03T00:00:00.000Z by dev]\n` +
    rejectionNote("verification section is vague", "2026-01-04T00:00:00.000Z by dev")
  assert.equal(extractReplanReason(task("a", 0, body)), "verification section is vague")
})

const contractRejectionNote = (reason?: string, stamp = "2026-01-02T00:00:00.000Z by dev"): string =>
  `\n> Plan rejected [contract] — sent back to queued for re-planning${reason ? ` — ${reason}` : ""} [${stamp}]\n`

test("unaddressedRejectionCount counts only stamped, tagged CONTRACT rejections since the last successful park", () => {
  const planWritten = `\n> Plan written — parked for plan review [2026-01-05T00:00:00.000Z by dev]\n`
  const body =
    `${PLAN_HEADING}\n\nApproach.\n` +
    contractRejectionNote("one") +
    contractRejectionNote("two") +
    planWritten +
    contractRejectionNote("three") +
    contractRejectionNote("four") +
    // Quoted, stamp-less line — must not inflate the tally.
    `\n> Plan rejected [contract] — sent back to queued for re-planning — fake\n`
  assert.equal(unaddressedRejectionCount(body), 2, "one/two were addressed by the park; the quote doesn't count")
  assert.equal(unaddressedRejectionCount(`${PLAN_HEADING}\n\nplan\n`), 0)
})

test("unaddressedRejectionCount excludes a human's untagged replan — only the park gate's own mistake repeats", () => {
  const body =
    `${PLAN_HEADING}\n\nApproach.\n` +
    rejectionNote("a human's reason, deliberate feedback") +
    rejectionNote("another human reason") +
    contractRejectionNote("the mechanical contract miss")
  assert.equal(unaddressedRejectionCount(body), 1, "the two human replans must not count toward the contract strike limit")
})

test("a reshape retires the contract strikes — the tally is about the task text that failed", () => {
  // The strikes count how often the park gate refused THIS task's plan. A
  // `retask` rewrites the text they were earned against, so carrying them over
  // meant a reshaped task got one attempt instead of three before being bounced
  // back to draft/. `pendingPlanRejection` already treats the reshape as an
  // anchor; these two parsers read the same trail and must agree about it.
  const reshaped = `\n> Sent back to draft for reshaping [2026-01-06T00:00:00.000Z by dev]\n`
  const body =
    `${PLAN_HEADING}\n\nApproach.\n` +
    contractRejectionNote("one") +
    contractRejectionNote("two") +
    reshaped +
    contractRejectionNote("three")
  assert.equal(unaddressedRejectionCount(body), 1, "only the strike earned after the reshape still stands")
})

test("a task-gate approval retires the contract strikes — the park gate's own draft return earns a fresh three", () => {
  // The park gate's 3-strike arm returns the task to draft/ under a note of its
  // OWN wording, and `retaskTask` on a task already in draft/ writes nothing —
  // so neither existing anchor lands on the path back. Without the task-gate
  // anchor the strikes survived the triage, the next contract miss counted 3+1,
  // and the task was dumped straight back to draft/ having had ONE attempt,
  // under a message claiming "PLAN failed 4 times". One higher every round.
  const triaged = `\n> Plan contract unmet after 3 attempts — returned to draft for human triage [2026-01-06T00:00:00.000Z by dev]\n`
  const approved = `\n> Task approved — queued for planning [2026-01-07T00:00:00.000Z by dev]\n`
  const body =
    `${PLAN_HEADING}\n\nApproach.\n` +
    contractRejectionNote("one") +
    contractRejectionNote("two") +
    contractRejectionNote("three") +
    triaged +
    approved +
    contractRejectionNote("the first miss of a fresh cycle")
  assert.equal(unaddressedRejectionCount(body), 1, "the human re-took the task gate — the tally starts over")
})

test("a plan rejection stays PENDING across the task gate — only the strike tally resets", () => {
  // The two parsers deliberately disagree here: the planner must still be told
  // what it kept getting wrong, so `pendingPlanRejection` does not treat the
  // approval as an anchor. Retiring the reason too would send the next PLAN
  // pass back in blind — the failure `extractReplanReason` exists to prevent.
  const approved = `\n> Task approved — queued for planning [2026-01-07T00:00:00.000Z by dev]\n`
  const body = `${PLAN_HEADING}\n\nApproach.\n` + contractRejectionNote("no ### Verification subsection") + approved
  assert.equal(unaddressedRejectionCount(body), 0, "the strikes are retired")
  assert.equal(extractReplanReason(task("a", 0, body)), "no ### Verification subsection", "the reason is not")
})

test("a replan re-queues WITHOUT a task gate, so its strikes survive", () => {
  // `replanTask` moves plan-review/ → queued/ directly. Anchoring the tally on
  // the task gate must not accidentally retire a counter on that path — the
  // planner really is still looping on the same contract mistake there.
  const approved = `\n> Task approved — queued for planning [2026-01-01T00:00:00.000Z by dev]\n`
  const body = `Goal.\n${approved}${PLAN_HEADING}\n\nApproach.\n` + contractRejectionNote("one") + contractRejectionNote("two")
  assert.equal(unaddressedRejectionCount(body), 2, "the approval predates the strikes; it retires nothing")
})

test("extractReplanReason ignores the marker quoted mid-line or without the audit stamp", () => {
  // Mid-line: prose about the system. Line-anchored but stamp-less: a plan's own
  // blockquote. Neither is lifecycle state.
  const midline = `${PLAN_HEADING}\n\nHandle the > Plan rejected — sent back to queued for re-planning — x [note] case.\n`
  assert.equal(extractReplanReason(task("a", 0, midline)), undefined)
  const unstamped = `${PLAN_HEADING}\n\n1. Cover this shape:\n> Plan rejected — sent back to queued for re-planning — fake reason\n`
  assert.equal(extractReplanReason(task("a", 0, unstamped)), undefined)
})

test("extractReplanReason strips only the closing stamp — brackets inside a reason survive", () => {
  const body = `${PLAN_HEADING}\n\nOld.\n` + rejectionNote("step [2] is wrong")
  assert.equal(extractReplanReason(task("a", 0, body)), "step [2] is wrong")
})

test("extractPlan on an actorless audit note still stops", () => {
  // Some gate notes are written with no actor ⇒ `[<ISO>]`, no ` by `.
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> Plan approved [2026-01-01T00:00:00.000Z]\n`
  assert.equal(extractPlan(task("a", 0, body)), "1. Do the thing.")
})

test("extractPlan ignores a heading quoted mid-line — the marker must own its line", () => {
  const body = `A task about the loop that mentions ${PLAN_HEADING} inline.\n\n${PLAN_HEADING}\n\nReal plan.`
  assert.equal(extractPlan(task("a", 0, body)), "Real plan.")
})

test("wasInterrupted is false when there is no build marker", () => {
  assert.equal(wasInterrupted(task("a", 0, "Some description.")), false)
})

test("wasInterrupted is false when the last start has a matching finish", () => {
  const body = "> BUILD started (iteration 1)\n> BUILD finished (iteration 1)"
  assert.equal(wasInterrupted(task("a", 0, body)), false)
})

test("wasInterrupted is true when a start has no matching finish", () => {
  const body = "> BUILD started (iteration 1)"
  assert.equal(wasInterrupted(task("a", 0, body)), true)
})

test("wasInterrupted is true when only the latest pair is unmatched", () => {
  const body = [
    "> BUILD started (iteration 1)",
    "> BUILD finished (iteration 1)",
    "> BUILD started (iteration 2)",
  ].join("\n")
  assert.equal(wasInterrupted(task("a", 0, body)), true)
})

test("isClaimable is false when there is no plan", () => {
  assert.equal(isClaimable(task("a", 0, "Some description.")), false)
})

test("isClaimable is false when a plan exists but a build already started and finished", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)\n> BUILD finished (iteration 1)`
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("isClaimable is false when a plan exists and the last build start is unmatched (interrupted)", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)`
  // Distinct from wasInterrupted, which is also true here — isClaimable cares
  // about ANY build marker, not just whether the last pair is unmatched.
  assert.equal(wasInterrupted(task("a", 0, body)), true)
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("isClaimable is true when a plan exists and there are zero build markers", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(isClaimable(task("a", 0, body)), true)
})

test("isRecoverable is false when there is no plan", () => {
  assert.equal(isRecoverable(task("a", 0, "> BUILD started (iteration 1)")), false)
})

test("isRecoverable is false when a planned task was never started", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(isRecoverable(task("a", 0, body)), false)
})

test("isRecoverable is true once a planned task has any build marker", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)`
  assert.equal(isRecoverable(task("a", 0, body)), true)
})

test("isRecoverable stays true after a matched finish (recover is for any stuck started task)", () => {
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> BUILD started (iteration 1)\n> BUILD finished (iteration 1)`
  assert.equal(isRecoverable(task("a", 0, body)), true)
})

// --- CLAIMED marker: durable claim evidence on the human-visible branch ---
// Isolation commits BUILD notes onto feature/<id>; without this marker the
// human branch's task file looks untouched after a full run and the watcher
// re-claims a task whose work already ran (the theater-booking-0 bug).

test("isClaimable is false once a CLAIMED note is on the body, even with zero build markers", () => {
  const at = new Date("2026-07-13T08:31:53.000Z")
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> ${auditNote("CLAIMED — loop starting", at, "w")}`
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("isRecoverable is true for a planned task with only a CLAIMED note (crashed before BUILD)", () => {
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> CLAIMED — loop starting [2026-07-13T08:31:53.000Z]`
  assert.equal(isRecoverable(task("a", 0, body)), true)
})

test("isOrphanedClaim is false once CLAIMED landed — the sweep must not release a run's marker", () => {
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> CLAIMED — loop starting [2026-07-13T08:31:53.000Z]`
  assert.equal(isOrphanedClaim(task("a", 0, body), { drivenByLiveWorkflow: false, markerStale: true }), false)
})

test("markClaimed appends the CLAIMED audit note to the task file", async () => {
  const cmds: string[] = []
  const $ = makeShell(() => ({}), cmds)
  await markClaimed($, task("a", 0), "Alice <alice@acme.com>")
  assert.ok(
    cmds.some((c) => c.includes("CLAIMED — loop starting") && c.includes("by Alice")),
    `no CLAIMED append in: ${cmds.join(" | ")}`,
  )
})

// --- lifecycle window: only markers after the LAST plan approval are state ---
// Audit notes survive a replan, so a task that built once (cap-trip/crash →
// replan → re-plan → re-approve) must become claimable again once its new plan
// is approved — the old attempt's CLAIMED/BUILD notes are history.

const replannedBody = [
  `${PLAN_HEADING}\n\n1. Old plan.`,
  "> Plan approved — parked for execution [2026-07-12T08:00:00.000Z by w]",
  "> CLAIMED — loop starting [2026-07-12T08:01:00.000Z by w]",
  "> BUILD started (iteration 1) [2026-07-12T08:02:00.000Z by w]",
  "> Plan rejected — sent back to queued for re-planning [2026-07-12T09:00:00.000Z by w]",
  `${PLAN_HEADING}\n\n1. New plan.`,
].join("\n\n")

test("isClaimable becomes true again after a replanned task's NEW plan is approved", () => {
  const reApproved = `${replannedBody}\n\n> Plan approved — parked for execution [2026-07-13T10:00:00.000Z by w]`
  assert.equal(isClaimable(task("a", 0, reApproved)), true)
  assert.equal(isRecoverable(task("a", 0, reApproved)), false)
  assert.equal(wasInterrupted(task("a", 0, reApproved)), false, "the old unmatched BUILD start is history, not an interruption")
})

test("a replanned task awaiting re-approval still reads the old markers (whole-body fallback)", () => {
  // No new "Plan approved" yet — the window anchors at the FIRST approval, so the
  // old attempt's markers still count and nothing claims it early.
  assert.equal(isClaimable(task("a", 0, replannedBody)), false)
})

test("markers appended after the latest approval make the task un-claimable and recoverable again", () => {
  const reclaimed = [
    replannedBody,
    "> Plan approved — parked for execution [2026-07-13T10:00:00.000Z by w]",
    "> CLAIMED — loop starting [2026-07-13T10:05:00.000Z by w]",
    "> BUILD started (iteration 1) [2026-07-13T10:06:00.000Z by w]",
  ].join("\n\n")
  assert.equal(isClaimable(task("a", 0, reclaimed)), false)
  assert.equal(isRecoverable(task("a", 0, reclaimed)), true)
  assert.equal(wasInterrupted(task("a", 0, reclaimed)), true, "an unmatched BUILD start in the current window IS an interruption")
})

test("auditNote suffixes the timestamp and actor", () => {
  const at = new Date("2026-07-03T05:00:00.000Z")
  assert.equal(
    auditNote("BUILD started (iteration 1)", at, "Alice <alice@acme.com>"),
    "BUILD started (iteration 1) [2026-07-03T05:00:00.000Z by Alice <alice@acme.com>]",
  )
})

test("auditNote omits the actor when unknown", () => {
  const at = new Date("2026-07-03T05:00:00.000Z")
  assert.equal(auditNote("Loop stopped", at, null), "Loop stopped [2026-07-03T05:00:00.000Z]")
})

test("audit-suffixed build markers still satisfy the claim/interrupt greps", () => {
  const at = new Date("2026-07-03T05:00:00.000Z")
  const started = `> ${auditNote("BUILD started (iteration 1)", at, "w")}`
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n${started}`
  assert.equal(isClaimable(task("a", 0, body)), false)
  assert.equal(wasInterrupted(task("a", 0, body)), true)
})

// --- summarizeBacklog (the /agentic-workflow:engineering status roll-up) ---

const empty = () =>
  Object.fromEntries(STATUSES.map((s) => [s, []])) as unknown as Record<TaskStatus, ReturnType<typeof task>[]>

test("summarizeBacklog counts every status and empty flag lists", () => {
  const s = summarizeBacklog(empty())
  assert.deepEqual(s.counts, {
    draft: 0,
    queued: 0,
    "plan-review": 0,
    "in-progress": 0,
    "in-review": 0,
    completed: 0,
    abandoned: 0,
  })
  assert.deepEqual(s.awaitingTask, [])
  assert.deepEqual(s.awaitingPlan, [])
  assert.deepEqual(s.gated, [])
  assert.deepEqual(s.claimable, [])
  assert.deepEqual(s.interrupted, [])
  assert.deepEqual(s.awaitingReview, [])
})

test("summarizeBacklog flags queued, gated plan-review, and in-progress/in-review states", () => {
  const byStatus = empty()
  byStatus["queued"] = [task("planme", 0, "just an idea")]
  byStatus["plan-review"] = [task("gated", 0, `${PLAN_HEADING}\n\n1. Go.`)]
  byStatus["in-progress"] = [
    task("ready", 0, `${PLAN_HEADING}\n\n1. Go.`),
    task("crashed", 0, `${PLAN_HEADING}\n\n1. Go.\n\n> BUILD started (iteration 1)`),
  ]
  byStatus["in-review"] = [task("shipme", 0, "")]
  const s = summarizeBacklog(byStatus)
  assert.equal(s.counts["queued"], 1)
  assert.equal(s.counts["plan-review"], 1)
  assert.deepEqual(s.awaitingPlan, ["planme"])
  assert.deepEqual(s.gated, ["gated"])
  assert.deepEqual(s.claimable, ["ready"])
  assert.deepEqual(s.interrupted, ["crashed"])
  assert.deepEqual(s.awaitingReview, ["shipme"])
})

test("nextActions renders one verb-bearing line per non-empty list, human gates first", () => {
  const byStatus = empty()
  byStatus["queued"] = [task("planme", 0, "just an idea")]
  byStatus["plan-review"] = [task("gated", 0, `${PLAN_HEADING}\n\n1. Go.`)]
  byStatus["in-progress"] = [
    task("ready", 0, `${PLAN_HEADING}\n\n1. Go.`),
    task("held", 0, `${PLAN_HEADING}\n\n1. Go.`),
    task("crashed", 0, `${PLAN_HEADING}\n\n1. Go.\n\n> BUILD started (iteration 1)`),
  ]
  byStatus["in-review"] = [task("shipme", 0, "")]
  byStatus["draft"] = [task("draftee", 0, "an idea")]
  const lines = nextActions(summarizeBacklog(byStatus, ["held"]), "/agentic-workflow:engineering")
  assert.equal(lines.length, 7)
  // The two human wait-gates lead — they are what the loop is blocked on.
  assert.match(lines[0]!, /^plan awaiting review: gated — \/agentic-workflow:engineering approve <id>/)
  assert.match(lines[1]!, /^awaiting diff review: shipme — .*approve <id> ships$/)
  assert.match(lines[2]!, /^drafts awaiting approval: draftee/)
  assert.match(lines[3]!, /^queued, not yet planned: planme — .*plan <id>/)
  assert.match(lines[4]!, /^build-ready: ready — .*claim \[id\]$/)
  assert.match(lines[5]!, /^interrupted: crashed — .*recover <id>$/)
  assert.match(lines[6]!, /^claim held .*: held — .*doctor/)
})

test("summarizeBacklog reports per-epic slice progress, and omits the key when no set is live", () => {
  const byStatus = empty()
  byStatus["draft"] = [
    { ...task("epic-1", 0, "tracker"), type: "epic" },
    { ...task("emptied", 0, "tracker with no live children"), type: "epic" },
    { ...task("c", 2, "slice"), epic: "epic-1" },
  ]
  byStatus["in-progress"] = [{ ...task("b", 1, "slice"), epic: "epic-1" }]
  byStatus["completed"] = [{ ...task("a", 0, "slice"), epic: "epic-1" }]
  byStatus["abandoned"] = [{ ...task("d", 3, "slice"), epic: "epic-1" }, { ...task("e", 0, "slice"), epic: "emptied" }]
  const s = summarizeBacklog(byStatus)
  // Abandoned slices shrink the set; the emptied tracker yields no row at all.
  assert.deepEqual(s.epics, [{ id: "epic-1", shipped: 1, open: ["b", "c"], total: 3 }])

  assert.equal(summarizeBacklog(empty()).epics, undefined, "no epics → the key is omitted, not empty")
})

test("nextActions names a fully-shipped epic's close-out, and stays quiet while slices are open", () => {
  const byStatus = empty()
  byStatus["draft"] = [{ ...task("epic-1", 0, "tracker"), type: "epic" }]
  byStatus["completed"] = [{ ...task("a", 0, "slice"), epic: "epic-1" }]
  const done = nextActions(summarizeBacklog(byStatus), "cmd")
  assert.equal(done.length, 1)
  assert.equal(done[0], "epic epic-1: all 1 slice shipped — cmd abandon epic-1 closes the tracker")

  byStatus["queued"] = [{ ...task("b", 1, "slice"), epic: "epic-1" }]
  const open = nextActions(summarizeBacklog(byStatus), "cmd")
  assert.ok(!open.some((l) => l.includes("abandon epic-1")), "an open slice means the set is not closable")
})

test("nextActions renders nothing for an empty backlog, and elides a long id list", () => {
  assert.deepEqual(nextActions(summarizeBacklog(empty()), "cmd"), [])
  const byStatus = empty()
  byStatus["in-review"] = Array.from({ length: 7 }, (_, i) => task(`t${i}`, 0, ""))
  const lines = nextActions(summarizeBacklog(byStatus), "cmd")
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /t0, t1, t2, t3, t4 \+2 more/)
})

test("summarizeBacklog flags approvable drafts and excludes the never-approve tracking epic", () => {
  const byStatus = empty()
  byStatus["draft"] = [task("real", 0, "an idea"), { ...task("tracker", 0, "slices"), type: "epic" }]
  const s = summarizeBacklog(byStatus)
  assert.equal(s.counts["draft"], 2)
  assert.deepEqual(s.awaitingTask, ["real"])
})

// --- pairingCoverage (the workflow_status pairing view) ---

const paired = (id: string): Task => ({ ...task(id, 0), tracker: { system: "jira", key: `PROJ-${id}` } })

test("pairingCoverage counts paired active tasks and lists the unpaired, sorted", () => {
  const byStatus = empty()
  byStatus["draft"] = [task("zed", 0), paired("d1")]
  byStatus["queued"] = [task("alpha", 0)]
  byStatus["in-progress"] = [paired("p1")]
  const cov = pairingCoverage(byStatus)
  assert.equal(cov.paired, 2)
  assert.deepEqual(cov.unpaired, ["alpha", "zed"])
})

test("pairingCoverage ignores completed and abandoned tasks", () => {
  const byStatus = empty()
  byStatus["completed"] = [task("done", 0)]
  byStatus["abandoned"] = [task("dropped", 0)]
  const cov = pairingCoverage(byStatus)
  assert.equal(cov.paired, 0)
  assert.deepEqual(cov.unpaired, [])
})

// --- canTransition / statusOf / moveTask (stage-order enforcement) ---

test("canTransition allows each adjacent forward hop", () => {
  assert.equal(canTransition("draft", "queued"), true)
  assert.equal(canTransition("queued", "plan-review"), true)
  assert.equal(canTransition("plan-review", "in-progress"), true)
  assert.equal(canTransition("in-progress", "in-review"), true)
  assert.equal(canTransition("in-review", "completed"), true)
})

test("canTransition rejects any forward skip", () => {
  assert.equal(canTransition("draft", "in-progress"), false)
  assert.equal(canTransition("draft", "in-review"), false)
  assert.equal(canTransition("draft", "completed"), false)
  assert.equal(canTransition("queued", "in-progress"), false)
  assert.equal(canTransition("plan-review", "completed"), false)
  assert.equal(canTransition("in-progress", "completed"), false)
})

test("canTransition rejects backward moves except the replan and retask escapes", () => {
  assert.equal(canTransition("in-progress", "draft"), false)
  assert.equal(canTransition("plan-review", "draft"), false)
  assert.equal(canTransition("in-review", "plan-review"), false)
  assert.equal(canTransition("in-review", "queued"), false)
  assert.equal(canTransition("completed", "in-review"), false)
})

test("canTransition allows the replan escape back to queued", () => {
  assert.equal(canTransition("plan-review", "queued"), true)
  assert.equal(canTransition("in-progress", "queued"), true)
})

// Only queued/ may go back — it is the one approved status with no plan yet, so
// reshaping it costs nothing downstream. From plan-review on, replan is the verb.
test("canTransition allows the retask escape from queued back to draft", () => {
  assert.equal(canTransition("queued", "draft"), true)
  assert.equal(canTransition("draft", "queued"), true, "the forward hop still works")
})

test("canTransition allows abandoning any active stage", () => {
  assert.equal(canTransition("draft", "abandoned"), true)
  assert.equal(canTransition("queued", "abandoned"), true)
  assert.equal(canTransition("plan-review", "abandoned"), true)
  assert.equal(canTransition("in-progress", "abandoned"), true)
  assert.equal(canTransition("in-review", "abandoned"), true)
})

test("canTransition treats completed and abandoned as terminal", () => {
  assert.equal(canTransition("completed", "abandoned"), false)
  assert.equal(canTransition("abandoned", "in-progress"), false)
  assert.equal(canTransition("abandoned", "abandoned"), false)
})

test("statusOf derives the status from the task's containing folder", () => {
  assert.equal(statusOf({ id: "a", path: "/r/docs/tasks/draft/a.md" }), "draft")
  assert.equal(statusOf({ id: "a", path: "/r/docs/tasks/in-review/a.md" }), "in-review")
})

test("statusOf throws for a path outside a known status folder", () => {
  assert.throws(() => statusOf({ id: "a", path: "/r/docs/tasks/wherever/a.md" }))
})

test("moveTask succeeds on a valid adjacent hop and records the mv", async () => {
  const log: string[] = []
  // `test -e dest` fails (no duplicate); everything else succeeds.
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 1 } : { exitCode: 0 }), log)
  const dest = await moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "queued")
  assert.equal(dest, "/r/docs/tasks/queued/a.md")
  assert.ok(log.some((cmd) => cmd.startsWith("mv ")))
  assert.ok(
    log.some((cmd) => cmd === "rm -f /r/docs/tasks/draft/.requests/a"),
    `the source folder's plan request is withdrawn with the move: ${log.join(" | ")}`,
  )
})

test("moveTask refuses to clobber an existing duplicate id at the destination", async () => {
  // `test -e dest` succeeds — a same-id file already lives in the destination
  // folder. The mv would silently destroy it, so moveTask must throw first.
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await assert.rejects(
    () => moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "queued"),
    /queued\/a\.md already exists/,
  )
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no mv was attempted")
})

test("moveTask refuses when the destination was created concurrently", async () => {
  // The `test -e dest` guard above and the mv are a TOCTOU pair: two gate verbs
  // racing (the hub and a host, or two hosts) both find the destination absent.
  // `mv -n` makes the kernel arbitrate, but its no-op is a SUCCESS (exit 0) and
  // the post-move `test -f dest` then passes on the OTHER task's file — so the
  // surviving source is the only signal, and without it moveTask reports a move
  // it did not make and `releaseClaim` drops a marker it still needs.
  const log: string[] = []
  const $ = makeShell((cmd) => {
    if (cmd.startsWith("test -e /r/docs/tasks/queued/")) return { exitCode: 1 } // absent at the check…
    if (cmd.startsWith("test -e /r/docs/tasks/draft/")) return { exitCode: 0 } // …source still here after the mv
    return { exitCode: 0 }
  }, log)
  await assert.rejects(
    () => moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "queued"),
    /was created concurrently/,
  )
  assert.ok(log.some((cmd) => cmd.startsWith("mv -n ")), `the move is no-clobber: ${log.join(" | ")}`)
  assert.ok(!log.some((cmd) => cmd.startsWith("rmdir ")), "and the claim marker is NOT released on a move that lost")
})

test("moveTask throws on a stage-skip attempt without touching the shell", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await assert.rejects(
    () => moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "in-progress"),
    /cannot move a from draft to in-progress/,
  )
  assert.deepEqual(log, [])
})

test("moveTask throws when mv reports success but the file did not land", async () => {
  // mv exits 0, but the post-move `test -f dest` fails — a false success must throw.
  // (`test -e` also fails: no pre-existing duplicate at the destination.)
  const $ = makeShell((cmd) => (cmd.startsWith("test -") ? { exitCode: 1 } : { exitCode: 0 }))
  await assert.rejects(
    () => moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "queued"),
    /did not land at .*queued\/a\.md/,
  )
})

// --- removeTaskFile (hard-delete) ---

test("removeTaskFile deletes the file and confirms it is gone", async () => {
  const log: string[] = []
  // rm succeeds; the post-delete `test -e path` fails (it's gone).
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 1 } : { exitCode: 0 }), log)
  const removed = await removeTaskFile($, { id: "a", path: "/r/docs/tasks/draft/a.md" })
  assert.equal(removed, "/r/docs/tasks/draft/a.md")
  assert.ok(log.some((cmd) => cmd.startsWith("rm -f ")), "the file is rm'd")
})

test("removeTaskFile throws when rm reports success but the file is still there", async () => {
  // rm exits 0, but the post-delete `test -e path` succeeds — a false removal must throw.
  const $ = makeShell(() => ({ exitCode: 0 }))
  await assert.rejects(
    () => removeTaskFile($, { id: "a", path: "/r/docs/tasks/draft/a.md" }),
    /removal of a did not take effect/,
  )
})

test("removeTaskFile refuses an unsafe id before any filesystem work", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await assert.rejects(
    () => removeTaskFile($, { id: "../evil", path: "/repo/docs/tasks/in-review/x.md" }),
    /unsafe id/,
  )
  assert.deepEqual(log, [], "nothing touched the shell")
})

// --- findByIdIn: shell-authoritative resolution (reads the real FS via `cat`) ---

test("findByIdIn resolves a task by cat-ing its absolute path", async () => {
  const content = serializeTask({ title: "Do it", body: "context" })
  const $ = makeShell((cmd) => (cmd === "cat /r/docs/tasks/queued/a.md" ? { exitCode: 0, stdout: content } : { exitCode: 1 }))
  const found = await findByIdIn($, "/r", "docs/tasks", "queued", "a")
  assert.equal(found?.id, "a")
  assert.equal(found?.path, "/r/docs/tasks/queued/a.md")
  assert.equal(found?.title, "Do it")
})

test("findByIdIn returns null when cat exits non-zero (file absent)", async () => {
  const $ = makeShell(() => ({ exitCode: 1 }))
  assert.equal(await findByIdIn($, "/r", "docs/tasks", "queued", "missing"), null)
})

test("findByIdIn returns null and warns on unparseable content", async () => {
  const warnings: string[] = []
  const $ = makeShell(() => ({ exitCode: 0, stdout: "not a task file" }))
  const found = await findByIdIn($, "/r", "docs/tasks", "queued", "a", (level, msg) => {
    if (level === "warn") warnings.push(msg)
  })
  assert.equal(found, null)
  assert.equal(warnings.length, 1)
})

// --- resolveTaskIdIn: exact hit, short-hash prefix, ambiguity, legacy back-compat ---

/** A fake shell for `cat <dir>/<name>.md` (present in `files`) and `ls <dir>`. */
const idResolverShell = (dir: string, files: string[]) =>
  makeShell((cmd) => {
    if (cmd.startsWith("cat ")) {
      const name = cmd.slice(`cat ${dir}/`.length).replace(/\.md$/, "")
      return files.includes(name) ? { exitCode: 0, stdout: "x" } : { exitCode: 1 }
    }
    if (cmd === `ls ${dir}`) return { exitCode: 0, stdout: files.map((f) => `${f}.md`).join("\n") }
    return { exitCode: 1 }
  })

const QDIR = "/r/docs/tasks/queued"

test("resolveTaskIdIn resolves an exact full id", async () => {
  const $ = idResolverShell(QDIR, ["f7k3-add-foo", "a1b2-do-bar"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k3-add-foo"), { id: "f7k3-add-foo" })
})

test("resolveTaskIdIn resolves a legacy slug id by exact filename (back-compat)", async () => {
  const $ = idResolverShell(QDIR, ["add-rate-limiting"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "add-rate-limiting"), { id: "add-rate-limiting" })
})

test("resolveTaskIdIn resolves a unique short-hash prefix", async () => {
  const $ = idResolverShell(QDIR, ["f7k3-add-foo", "a1b2-do-bar"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k"), { id: "f7k3-add-foo" })
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k3"), { id: "f7k3-add-foo" })
})

test("resolveTaskIdIn reports ambiguity when a prefix matches several", async () => {
  const $ = idResolverShell(QDIR, ["f7k3-add-foo", "fa2b-do-bar"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f"), { ambiguous: ["f7k3-add-foo", "fa2b-do-bar"] })
})

test("resolveTaskIdIn disambiguates a colliding hash by a longer full-id prefix", async () => {
  // Two tasks share the 4-char hash f7k3: the bare hash is ambiguous, but a longer
  // prefix of the full id resolves the one — so "Use more characters" actually works.
  const $ = idResolverShell(QDIR, ["f7k3-add-foo", "f7k3-fix-bar"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k3"), {
    ambiguous: ["f7k3-add-foo", "f7k3-fix-bar"],
  })
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k3-add"), { id: "f7k3-add-foo" })
})

test("resolveTaskIdIn never treats a legacy slug as a hash prefix", async () => {
  // "add-rate-limiting" is not a modern <hash>- id, so a bare "add" prefix must not match it.
  const $ = idResolverShell(QDIR, ["add-rate-limiting"])
  assert.equal(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "add"), null)
})

test("resolveTaskIdIn returns null when nothing matches", async () => {
  const $ = idResolverShell(QDIR, ["f7k3-add-foo"])
  assert.equal(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "zzzz"), null)
})

// --- resolveTaskIdAnywhere (cross-status: what plan/recover/workflow_start accept) ---

/** A fake shell over several status folders at once: `dirs` maps folder path → filenames. */
const multiDirShell = (dirs: Record<string, string[]>) =>
  makeShell((cmd) => {
    if (cmd.startsWith("cat ")) {
      const file = cmd.slice("cat ".length)
      const dir = file.slice(0, file.lastIndexOf("/"))
      const name = file.slice(dir.length + 1).replace(/\.md$/, "")
      return dirs[dir]?.includes(name) ? { exitCode: 0, stdout: "x" } : { exitCode: 1 }
    }
    if (cmd.startsWith("ls ")) {
      const dir = cmd.slice("ls ".length)
      const files = dirs[dir]
      return files ? { exitCode: 0, stdout: files.map((f) => `${f}.md`).join("\n") } : { exitCode: 1 }
    }
    return { exitCode: 1 }
  })

test("resolveTaskIdAnywhere resolves a short-hash handle whichever folder the task is in", async () => {
  const $ = multiDirShell({ "/r/docs/tasks/queued": ["f7k3-add-foo"], "/r/docs/tasks/in-progress": ["a1b2-do-bar"] })
  assert.deepEqual(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "f7k3"), { id: "f7k3-add-foo" })
  assert.deepEqual(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "a1b2"), { id: "a1b2-do-bar" })
})

test("resolveTaskIdAnywhere: an exact full id wins immediately", async () => {
  const $ = multiDirShell({ "/r/docs/tasks/queued": ["f7k3-add-foo"] })
  assert.deepEqual(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "f7k3-add-foo"), { id: "f7k3-add-foo" })
})

test("resolveTaskIdAnywhere merges prefix hits across folders into an ambiguity", async () => {
  const $ = multiDirShell({ "/r/docs/tasks/queued": ["f7k3-add-foo"], "/r/docs/tasks/draft": ["fa2b-do-bar"] })
  assert.deepEqual(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "f"), { ambiguous: ["f7k3-add-foo", "fa2b-do-bar"] })
})

test("resolveTaskIdAnywhere returns null for an unknown id and an empty query", async () => {
  const $ = multiDirShell({ "/r/docs/tasks/queued": ["f7k3-add-foo"] })
  assert.equal(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "zzzz"), null)
  assert.equal(await resolveTaskIdAnywhere($, "/r", "docs/tasks", ""), null)
})

// --- selectOrder (the claim walk's candidate ordering) ---

test("selectOrder sorts by priority then id and does not mutate the input", () => {
  const tasks = [task("zebra", 1), task("b", 5), task("apple", 1)]
  const ordered = selectOrder(tasks)
  assert.deepEqual(
    ordered.map((t) => t.id),
    ["apple", "zebra", "b"],
  )
  assert.equal(tasks[0]?.id, "zebra")
})

test("selectNext equals the head of selectOrder", () => {
  const tasks = [task("b", 5), task("a", 2)]
  assert.equal(selectNext(tasks)?.id, selectOrder(tasks)[0]?.id)
})

// --- epicSiblings (the slice walk's "what's left") ---

/** A child slice of `epic`, at the given order. */
const slice = (id: string, epic: string, priority: number): Task => ({ ...task(id, priority), epic })

test("epicSiblings returns the other slices in approval order, minus the tracker", () => {
  const tasks = [
    slice("c-ui", "k2p9", 1),
    slice("a-api", "k2p9", 0),
    slice("b-docs", "k2p9", 2),
    { ...task("k2p9", 0), type: "epic" },
    slice("x-other", "z8y7", 0), // a different set entirely
    task("loose", 0), // no epic at all
  ]
  assert.deepEqual(
    epicSiblings(tasks, "k2p9", "a-api").map((t) => t.id),
    ["c-ui", "b-docs"],
  )
})

/**
 * The guard against the walk naming a stranger's draft as "the next slice". A
 * task with no epic has no siblings — never "every other draft", which is the
 * fallback that would turn a helpful question into a guess.
 */
test("epicSiblings with no epic is empty, not a fallback to everything", () => {
  const tasks = [task("a", 0), task("b", 1), slice("c", "k2p9", 0)]
  assert.deepEqual(epicSiblings(tasks, undefined, "a"), [])
  assert.deepEqual(epicSiblings(tasks, "", "a"), [])
  assert.deepEqual(epicSiblings(tasks, "nonexistent-epic", "a"), [])
})

// --- claim markers: staleness, orphan detection, and the claim walk ---

const planned = (id: string, priority = 0) => task(id, priority, `${PLAN_HEADING}\n\n1. Go.`)
const started = (id: string, priority = 0) => task(id, priority, `${PLAN_HEADING}\n\n1. Go.\n\n> BUILD started (iteration 1)`)

test("appendNote/appendPlan/appendRunLog warn when the append never landed", async () => {
  // The CLAIMED/BUILD notes are the durable evidence the claim protocol
  // depends on — a silently lost append re-claims already-done work.
  const warns: string[] = []
  const failing = makeShell((cmd) => (cmd.startsWith("printf") ? { exitCode: 1, stderr: "read-only fs" } : { exitCode: 0 }))
  const log = async (level: string, message: string) => void (level === "warn" && warns.push(message))
  await appendNote(failing, task("a", 0), "CLAIMED — loop starting", log)
  await appendPlan(failing, task("a", 0), "1. step", log)
  await appendRunLog(failing, "/r", "docs/tasks", "a", "hdr", "text", log)
  assert.equal(warns.filter((m) => m.includes("append")).length, 3, `got: ${JSON.stringify(warns)}`)
})

test("appendNote refuses to recreate a task file that is no longer there", async () => {
  // `>>` CREATES its target, and callers legitimately hold a stale path — a task
  // can move out from under a live run. The resurrected file is a frontmatterless
  // ghost: `parseTask` throws so `listByStatus` skips it and it counts for
  // nothing, while `test -e` still sees it, so `moveTask`'s duplicate guard then
  // refuses the REAL task's move back into that folder forever.
  const cmds: string[] = []
  const warns: string[] = []
  const gone = makeShell((cmd) => {
    cmds.push(cmd)
    return cmd.startsWith("test ") ? { exitCode: 1 } : { exitCode: 0 }
  })
  const log = async (level: string, message: string) => void (level === "warn" && warns.push(message))
  await appendNote(gone, task("a", 0), "CLAIMED — loop starting", log)
  assert.ok(!cmds.some((c) => c.includes(">>")), `no append attempted: ${cmds.join(" | ")}`)
  assert.equal(warns.length, 1, `the lost note must be loud: ${JSON.stringify(warns)}`)
  assert.match(warns[0] ?? "", /no longer exists/)
})

test("appendNote still appends when the task file is there", async () => {
  const cmds: string[] = []
  const present = makeShell((cmd) => {
    cmds.push(cmd)
    return { exitCode: 0 }
  })
  await appendNote(present, task("a", 0), "CLAIMED — loop starting")
  assert.ok(cmds.some((c) => c.includes(">>")), `the append still runs: ${cmds.join(" | ")}`)
})

test("a marker quoted mid-line in the body is not lifecycle state", () => {
  // A task ABOUT this system (or a pasted log) can quote the literal note
  // text; only whole audit-note lines appended by appendNote count.
  const quoted = task("a", 0, `${PLAN_HEADING}\n\n1. Grep for "> BUILD started" and "> CLAIMED" in store.ts.`)
  assert.equal(isClaimable(quoted), true)
  assert.equal(isRecoverable(quoted), false)
  assert.equal(wasInterrupted(quoted), false)
})

test("a quoted plan-approval phrase does not reset the lifecycle window", () => {
  const body = `${PLAN_HEADING}\n\n1. Go.\n\n> BUILD started (iteration 1)\n\nNote: docs mention "> Plan approved" inline here.`
  assert.equal(isClaimable(task("a", 0, body)), false, "the real BUILD note must stay visible to the window")
  assert.equal(isRecoverable(task("a", 0, body)), true)
})

test("isOrphanedClaim requires claimable body, no live loop, and a stale marker", () => {
  const ok = { drivenByLiveWorkflow: false, markerStale: true }
  assert.equal(isOrphanedClaim(planned("a"), ok), true)
  assert.equal(isOrphanedClaim(started("a"), ok), false)
  assert.equal(isOrphanedClaim(planned("a"), { ...ok, drivenByLiveWorkflow: true }), false)
  assert.equal(isOrphanedClaim(planned("a"), { ...ok, markerStale: false }), false)
})

test("claimOlderThan is true only when find exits 0 and prints the marker path", async () => {
  const stale = makeShell(() => ({ exitCode: 0, stdout: "/r/docs/tasks/in-progress/.claims/a\n" }))
  assert.equal(await claimOlderThan(stale, task("a", 0), 15), true)
  const absent = makeShell(() => ({ exitCode: 1 }))
  assert.equal(await claimOlderThan(absent, task("a", 0), 15), false)
  const fresh = makeShell(() => ({ exitCode: 0, stdout: "" }))
  assert.equal(await claimOlderThan(fresh, task("a", 0), 15), false)
})

test("claimOlderThan trusts a fresh claim stamp over a stale-looking mtime", async () => {
  // DrvFS/WSL mtime is untrustworthy (scheduler/lease.ts): find claims the
  // marker is old, but the stamp says the claim is 5 minutes young — held.
  const now = new Date("2026-01-01T12:00:00Z")
  const stamp = JSON.stringify({ claimedAt: "2026-01-01T11:55:00Z" })
  const $ = makeShell((cmd) =>
    cmd.startsWith("cat ") ? { exitCode: 0, stdout: stamp } : { exitCode: 0, stdout: "/r/docs/tasks/in-progress/.claims/a\n" },
  )
  assert.equal(await claimOlderThan($, task("a", 0), 15, now), false)
})

test("claimOlderThan reads staleness from an old claim stamp even when find says fresh", async () => {
  const now = new Date("2026-01-01T12:00:00Z")
  const stamp = JSON.stringify({ claimedAt: "2026-01-01T11:00:00Z" })
  const $ = makeShell((cmd) => (cmd.startsWith("cat ") ? { exitCode: 0, stdout: stamp } : { exitCode: 0, stdout: "" }))
  assert.equal(await claimOlderThan($, task("a", 0), 15, now), true)
})

test("claimOlderThan falls back to find -mmin when the stamp is absent or garbled", async () => {
  const noStamp = makeShell((cmd) => (cmd.startsWith("cat ") ? { exitCode: 1 } : { exitCode: 0, stdout: ".claims/a\n" }))
  assert.equal(await claimOlderThan(noStamp, task("a", 0), 15), true)
  const garbled = makeShell((cmd) => (cmd.startsWith("cat ") ? { exitCode: 0, stdout: "not json" } : { exitCode: 0, stdout: "" }))
  assert.equal(await claimOlderThan(garbled, task("a", 0), 15), false)
})

test("claimTask stamps claimedAt inside a won marker and skips the stamp on a lost race", async () => {
  const wonLog: string[] = []
  const win = makeShell(() => ({ exitCode: 0 }), wonLog)
  assert.equal(await claimTask(win, task("a", 0)), true)
  assert.ok(wonLog.some((c) => c.startsWith("printf") && c.includes("claim.json") && c.includes("claimedAt")))
  const lostLog: string[] = []
  const lose = makeShell((cmd) => ({ exitCode: cmd.startsWith("mkdir -p") ? 0 : cmd.startsWith("mkdir ") ? 1 : 0 }), lostLog)
  assert.equal(await claimTask(lose, task("a", 0)), false)
  assert.ok(!lostLog.some((c) => c.includes("claim.json")))
})

test("releaseClaim removes the stamp before rmdir so the marker dir can fall", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await releaseClaim($, task("a", 0))
  const rmIdx = log.findIndex((c) => c.startsWith("rm -f") && c.includes("claim.json"))
  const rmdirIdx = log.findIndex((c) => c.startsWith("rmdir"))
  assert.ok(rmIdx !== -1, "expected an rm -f of the claim stamp")
  assert.ok(rmdirIdx !== -1, "expected an rmdir of the marker")
  assert.ok(rmIdx < rmdirIdx, "stamp must be removed before the rmdir")
})

test("listClaimIds parses ls output and returns [] when the folder is absent", async () => {
  const some = makeShell((cmd) => (cmd.startsWith("ls -1") ? { exitCode: 0, stdout: "a\nb\n\n" } : { exitCode: 0 }))
  assert.deepEqual(await listClaimIds(some, "/r", "docs/tasks"), ["a", "b"])
  const none = makeShell(() => ({ exitCode: 1 }))
  assert.deepEqual(await listClaimIds(none, "/r", "docs/tasks"), [])
})

test("listClaimIds screens out sweep graveyard debris and other non-id entries", async () => {
  // A SIGKILL between acquireOrSweepMarker's rename-aside and its rm strands a
  // `<id>.dead-<pid>-<ts>` sibling inside .claims/ forever (nothing sweeps it).
  // Listing it as a held claim puts a garbage row in doctor/hub that no verb can
  // ever release. Same screened-on-the-way-out rule as listPlanRequestIds: the
  // folder is a plain directory anything can drop a file into.
  const $ = makeShell((cmd) =>
    cmd.startsWith("ls -1") ? { exitCode: 0, stdout: "a\nb.dead-1234-99\n.DS_Store\nok-task\n" } : { exitCode: 0 },
  )
  assert.deepEqual(await listClaimIds($, "/r", "docs/tasks"), ["a", "ok-task"])
})

/**
 * Shell for claim walks: per-id mkdir failures (held markers), per-id find
 * staleness, and stateful release — after an `rmdir` of a marker, the next
 * `mkdir` of it succeeds, like the real filesystem.
 */
/** A pid this fake never reports as running — the crashed claimer's. */
const DEAD_PID = 999_101

const claimShell = (held: Set<string>, stale: Set<string>, log?: string[], deadWriters: Set<string> = new Set()) =>
  makeShell((cmd) => {
    const id = cmd.split("/").pop() ?? ""
    // Writer-liveness probes. Only markers named in `deadWriters` carry a stamp
    // at all; every other marker reads "unknown" and keeps the wall-clock rule,
    // which is what pins the default behaviour as unchanged.
    if (cmd.startsWith("cat ") && cmd.endsWith("/claim.json")) {
      const markerId = cmd.split("/").slice(-2)[0] ?? ""
      return deadWriters.has(markerId)
        ? { exitCode: 0, stdout: JSON.stringify({ claimedAt: new Date().toISOString(), pid: DEAD_PID, host: os.hostname() }) }
        : { exitCode: 1 }
    }
    if (cmd.startsWith("kill -0 ")) return { exitCode: Number(cmd.split(" ")[2]) === process.pid ? 0 : 1 }
    if (cmd.startsWith("test -d /proc/")) return { exitCode: cmd.endsWith(`/proc/${String(process.pid)}`) ? 0 : 1 }
    if (cmd.startsWith("mkdir -p")) return { exitCode: 0 }
    if (cmd.startsWith("mkdir ")) return { exitCode: held.has(id) ? 1 : 0 }
    if (cmd.startsWith("rmdir ")) {
      held.delete(id)
      return { exitCode: 0 }
    }
    // The atomic sweep (releaseMarkerIfStale) renames the marker aside; model the
    // move by transferring held/stale membership to the destination name, and
    // fail when the source is already gone — the rename race's loser.
    if (cmd.startsWith("mv ")) {
      const [, src, dest] = cmd.split(" ")
      const srcId = src?.split("/").pop() ?? ""
      const destId = dest?.split("/").pop() ?? ""
      if (!held.has(srcId)) return { exitCode: 1 }
      held.delete(srcId)
      held.add(destId)
      if (stale.has(srcId)) {
        stale.delete(srcId)
        stale.add(destId)
      }
      // The stamp travels INSIDE the marker directory, so the moved-aside copy
      // still names its writer — which is exactly what lets the dead-writer
      // release re-judge what it caught instead of deleting a rival's claim.
      if (deadWriters.has(srcId)) {
        deadWriters.delete(srcId)
        deadWriters.add(destId)
      }
      return { exitCode: 0 }
    }
    if (cmd.startsWith("rm -rf ")) {
      held.delete(id)
      stale.delete(id)
      deadWriters.delete(id)
      return { exitCode: 0 }
    }
    if (cmd.startsWith("find ")) {
      const markerId = cmd.split(" ")[1]?.split("/").pop() ?? ""
      return stale.has(markerId) ? { exitCode: 0, stdout: `.claims/${markerId}\n` } : { exitCode: 0, stdout: "" }
    }
    return { exitCode: 0 }
  }, log)

const notDriving = { isDriving: () => false }

test("claimFirst claims the first candidate when its marker is free", async () => {
  const $ = claimShell(new Set(), new Set())
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], notDriving)
  assert.equal(claimed?.id, "a")
  assert.deepEqual(heldIds, [])
})

test("claimFirst skips a held (fresh) marker and claims the next candidate", async () => {
  const $ = claimShell(new Set(["a"]), new Set())
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], notDriving)
  assert.equal(claimed?.id, "b")
  assert.deepEqual(heldIds, ["a"])
})

test("claimFirst releases a stale orphaned marker and claims that task on retry", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(["a"]), new Set(["a"]), log)
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], notDriving)
  assert.equal(claimed?.id, "a")
  assert.deepEqual(heldIds, [])
  // The takeover is the atomic rename-aside, not a blind rmdir.
  assert.ok(log.some((cmd) => cmd.startsWith("mv ") && cmd.includes("/a ")))
})

test("claimFirst never releases a stale marker whose task a live loop drives", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(["a"]), new Set(["a"]), log)
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1)], { isDriving: (id) => id === "a" })
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, ["a"])
  assert.ok(!log.some((cmd) => cmd.startsWith("rmdir ")))
})

test("claimFirst returns every held id in order when all claims fail", async () => {
  const $ = claimShell(new Set(["a", "b"]), new Set())
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], notDriving)
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, ["a", "b"])
})

test("claimFirst hands out the fresh task from reverify, not the stale listing", async () => {
  const $ = claimShell(new Set(), new Set())
  const fresh = task("a", 1, `${PLAN_HEADING}\n\n1. Go — updated.`)
  const { claimed } = await claimFirst($, [planned("a", 1)], {
    ...notDriving,
    reverify: async () => fresh,
  })
  assert.equal(claimed, fresh)
})

test("claimFirst releases a stale claim when reverify says the task is gone, and moves on", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(), new Set(), log)
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], {
    ...notDriving,
    reverify: async (t) => (t.id === "a" ? null : t),
  })
  assert.equal(claimed?.id, "b")
  // a's marker was created and then released; a is NOT held — nothing owns it.
  assert.ok(log.some((cmd) => cmd.startsWith("rmdir ") && cmd.endsWith("/a")))
  assert.deepEqual(heldIds, [])
})

test("claimFirst returns nothing when reverify drops every candidate", async () => {
  const $ = claimShell(new Set(), new Set())
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], {
    ...notDriving,
    reverify: async () => null,
  })
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, [])
})

test("claimFirst reverifies the orphan-release retry win too", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(["a"]), new Set(["a"]), log)
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1)], {
    ...notDriving,
    reverify: async () => null,
  })
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, [])
  // The orphan takeover is a rename-aside; the reverify drop of the retry win
  // then releases the fresh marker with a plain rmdir.
  assert.equal(log.filter((cmd) => cmd.startsWith("mv ") && cmd.includes("/a ")).length, 1)
  assert.equal(log.filter((cmd) => cmd.startsWith("rmdir ") && cmd.endsWith("/a")).length, 1)
})

test("claimFirst treats a lost release-retry race as held", async () => {
  // rmdir "succeeds" but another instance re-claims instantly: mkdir keeps failing.
  const $ = makeShell((cmd) => {
    if (cmd.startsWith("mkdir -p")) return { exitCode: 0 }
    if (cmd.startsWith("mkdir ")) return { exitCode: 1 }
    if (cmd.startsWith("find ")) return { exitCode: 0, stdout: ".claims/a\n" }
    return { exitCode: 0 }
  })
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1)], notDriving)
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, ["a"])
})

test("releaseOrphanedClaims releases stale orphans and taskless markers, keeps the rest", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(["orphan", "fresh", "crashed", "ghost"]), new Set(["orphan", "ghost", "crashed"]), log)
  const inProgress = [planned("orphan"), planned("fresh"), started("crashed")]
  const released = await releaseOrphanedClaims(
    $,
    inProgress,
    ["orphan", "fresh", "crashed", "ghost"],
    "/r/docs/tasks/in-progress",
    { isDriving: () => false },
  )
  // orphan: claimable + stale → released. fresh: not stale → kept.
  // crashed: BUILD started → recover territory, kept. ghost: no task file, stale → released.
  assert.deepEqual(released, ["orphan", "ghost"])
  // Releases are the atomic rename-aside, exactly one per released marker.
  const sweeps = log.filter((cmd) => cmd.startsWith("mv ") && (cmd.includes("/orphan ") || cmd.includes("/ghost ")))
  assert.equal(sweeps.length, 2)
})

test("releaseOrphanedClaims frees a FRESH claim whose writer is provably dead", async () => {
  // The user-visible fix: doctor's window is stage-timeout-derived (75 minutes by
  // default), so a wedged marker used to survive that long even when the process
  // that took it was demonstrably gone. Nothing here is stale by age.
  const log: string[] = []
  const $ = claimShell(new Set(["crashed"]), new Set(), log, new Set(["crashed"]))
  const released = await releaseOrphanedClaims($, [started("crashed")], ["crashed"], "/r/docs/tasks/in-progress", {
    isDriving: () => false,
    staleMinutes: 75,
    isOrphaned: isOrphanedStartedClaim,
    writerDead: (ref) => claimWriterDead($, ref),
  })
  assert.deepEqual(released, ["crashed"])
  // Still the atomic rename-aside, never a blind rmdir.
  assert.ok(
    log.some((cmd) => cmd.startsWith("mv ") && cmd.includes("/crashed ")),
    "released through the rename-aside",
  )
})

test("releaseOrphanedClaims keeps a fresh claim whose writer is alive or unprovable", async () => {
  // `deadWriters` empty ⇒ no stamp ⇒ "unknown". Uncertainty must never release.
  const $ = claimShell(new Set(["setting-up"]), new Set(), undefined, new Set())
  const released = await releaseOrphanedClaims($, [started("setting-up")], ["setting-up"], "/r/docs/tasks/in-progress", {
    isDriving: () => false,
    staleMinutes: 75,
    isOrphaned: isOrphanedStartedClaim,
    writerDead: (ref) => claimWriterDead($, ref),
  })
  assert.deepEqual(released, [], "an unidentifiable holder keeps the wall-clock rule")
})

test("releaseOrphanedClaims never releases a dead writer's claim that a live loop drives", async () => {
  // The stage-marker witness outranks the stamp: a dead pid can coexist with a
  // live drive (a restamp not yet due, a pid recycled), and a running stage wins.
  const $ = claimShell(new Set(["driven"]), new Set(["driven"]), undefined, new Set(["driven"]))
  const released = await releaseOrphanedClaims($, [started("driven")], ["driven"], "/r/docs/tasks/in-progress", {
    isDriving: () => true,
    staleMinutes: 75,
    isOrphaned: isOrphanedStartedClaim,
    writerDead: (ref) => claimWriterDead($, ref),
  })
  assert.deepEqual(released, [])
})

test("releaseOrphanedClaims without the opt is exactly today's age-only behaviour", async () => {
  // Pins that the unattended sweeps (claimFirst, the startup sweep) are untouched
  // — they never pass `writerDead`, so a dead writer alone releases nothing.
  const $ = claimShell(new Set(["crashed"]), new Set(), undefined, new Set(["crashed"]))
  const released = await releaseOrphanedClaims($, [started("crashed")], ["crashed"], "/r/docs/tasks/in-progress", {
    isDriving: () => false,
    staleMinutes: 75,
    isOrphaned: isOrphanedStartedClaim,
  })
  assert.deepEqual(released, [])
})

test("summarizeBacklog splits body-claimable tasks into ready vs claim-held", () => {
  const byStatus = empty()
  byStatus["in-progress"] = [planned("free"), planned("blocked")]
  const s = summarizeBacklog(byStatus, ["blocked"])
  assert.deepEqual(s.claimable, ["free"])
  assert.deepEqual(s.claimHeld, ["blocked"])
})

test("summarizeBacklog without claimedIds reports every body-claimable task as ready", () => {
  const byStatus = empty()
  byStatus["in-progress"] = [planned("free")]
  const s = summarizeBacklog(byStatus)
  assert.deepEqual(s.claimable, ["free"])
  assert.deepEqual(s.claimHeld, [])
})

// --- writeTask must never clobber an existing task file ---

/** A client whose file.list reports `ids` for every status folder. */
const idsClient = (ids: string[]) =>
  ({
    file: {
      list: async () => ({ data: ids.map((id) => ({ name: `${id}.md`, type: "file" })) }),
    },
  }) as unknown as Parameters<typeof writeTask>[1]

test("writeTask refuses to overwrite a file already at the destination", async () => {
  // Uniqueness comes only from `taken`, gathered via the client index — which
  // findByIdIn's own doc comment says can lag the real FS. When it does,
  // buildTaskFile re-mints the same id and writeFileAtomic's `mv` clobbers the
  // other task's file and audit trail with no error. Every sibling write path
  // (moveTask, rescueStray) guards first; this one did not.
  const cmds: string[] = []
  // Index reports nothing taken, but the destination exists on the real FS.
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 0 } : {}), cmds)
  await assert.rejects(
    () => writeTask($, idsClient([]), { directory: "/r" }, { title: "Add rate limiting", priority: 2 }),
    /already exists/,
  )
  assert.ok(!cmds.some((c) => c.startsWith("mv ")), "no write attempted after the collision check")
})

test("writeTask writes when the destination is free", async () => {
  const cmds: string[] = []
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 1 } : {}), cmds)
  const out = await writeTask($, idsClient([]), { directory: "/r" }, { title: "Add rate limiting", priority: 2 })
  assert.match(out.path, /\/r\/docs\/tasks\/draft\/.*\.md$/)
  assert.ok(out.id)
})

// --- unsafe-id rails: ids/queries reach path.join(...) → the filesystem, so a
// `../`-bearing value from an untrusted caller (MCP client, tampered snapshot)
// must be rejected BEFORE any fs use, not resolved into a traversal read/move.

test("findByIdIn rejects a traversal id without touching the filesystem", async () => {
  const cmds: string[] = []
  const $ = makeShell(() => ({ exitCode: 0, stdout: "" }), cmds)
  const found = await findByIdIn($, "/repo", "docs/tasks", "queued", "../../../etc/hosts")
  assert.equal(found, null)
  assert.deepEqual(cmds, [], "no shell command may run for an unsafe id")
})

test("resolveTaskIdIn rejects a traversal query instead of blessing it as an id", async () => {
  const cmds: string[] = []
  // The exact-match branch would `cat` the traversed path (exit 0 here) and
  // return `{ id: query }` — feeding the raw traversal string to every
  // downstream path builder. It must bail before the shell instead.
  const $ = makeShell(() => ({ exitCode: 0, stdout: "task file" }), cmds)
  const resolved = await resolveTaskIdIn($, "/repo", "docs/tasks", "queued", "../../secrets")
  assert.equal(resolved, null)
  assert.deepEqual(cmds, [], "no shell command may run for an unsafe query")
})

test("moveTask refuses an unsafe id before any filesystem work", async () => {
  const cmds: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), cmds)
  await assert.rejects(
    () => moveTask($, { id: "../evil", path: "/repo/docs/tasks/in-review/x.md" }, "completed"),
    /unsafe id/,
  )
  assert.deepEqual(cmds, [], "no mv/mkdir may run for an unsafe id")
})

test("findByIdIn still resolves ordinary modern and legacy ids", async () => {
  const file = serializeTask({ title: "Add rate limit", priority: 2 })
  const $ = makeShell((cmd) => (cmd.startsWith("cat ") ? { exitCode: 0, stdout: file } : { exitCode: 1 }))
  const found = await findByIdIn($, "/repo", "docs/tasks", "queued", "f7k3-add-rate-limit")
  assert.ok(found, "safe ids must keep resolving")
  assert.equal(found?.id, "f7k3-add-rate-limit")
})

// --- rewriteTask: update an existing task file in place, and nothing else ---

/** A shell whose `test -f` reports the task file present, tracking every command. */
const rewriteShell = (cmds: string[], present = true) =>
  makeShell((cmd) => (cmd.startsWith("test -f") ? { exitCode: present ? 0 : 1 } : {}), cmds)

test("rewriteTask writes the serialized task back to the same path", async () => {
  const cmds: string[] = []
  const $ = rewriteShell(cmds)
  const ref = { id: "f7k3-add-rate-limit", path: "/repo/docs/tasks/draft/f7k3-add-rate-limit.md" }
  const out = await rewriteTask($, ref, { title: "Add rate limiting", priority: 2, body: "reshaped" })
  assert.equal(out, ref.path, "the path is unchanged — a rewrite never relocates")
  const printed = cmds.find((c) => c.startsWith("printf"))
  assert.ok(printed?.includes("Add rate limiting"), "the new content is written")
  // writeFileAtomic renames its temp onto the target; nothing else may move.
  const moves = cmds.filter((c) => c.startsWith("mv "))
  assert.equal(moves.length, 1)
  assert.ok(moves[0]!.endsWith(ref.path), "the only mv lands on the task's own path")
})

test("rewriteTask refuses a file that does not exist — it never creates one", async () => {
  const cmds: string[] = []
  const $ = rewriteShell(cmds, false)
  await assert.rejects(
    () => rewriteTask($, { id: "gone", path: "/repo/docs/tasks/draft/gone.md" }, { title: "Ghost" }),
    /does not exist/,
  )
  assert.ok(!cmds.some((c) => c.startsWith("printf")), "no write attempted after the existence check")
})

test("rewriteTask refuses a path whose filename is not <id>.md — it never renames", async () => {
  const cmds: string[] = []
  const $ = rewriteShell(cmds)
  await assert.rejects(
    () => rewriteTask($, { id: "renamed", path: "/repo/docs/tasks/draft/original.md" }, { title: "T" }),
    /never renames or moves/,
  )
  assert.ok(!cmds.some((c) => c.startsWith("printf")), "nothing written for a mismatched path")
})

test("rewriteTask refuses a file outside a status folder", async () => {
  const $ = rewriteShell([])
  await assert.rejects(
    () => rewriteTask($, { id: "stray", path: "/repo/docs/tasks/run/stray.md" }, { title: "T" }),
    /not inside a known status folder/,
  )
})

test("rewriteTask refuses an unsafe id before any filesystem work", async () => {
  const cmds: string[] = []
  const $ = rewriteShell(cmds)
  await assert.rejects(
    () => rewriteTask($, { id: "../evil", path: "/repo/docs/tasks/draft/../evil.md" }, { title: "T" }),
    /unsafe id/,
  )
  assert.deepEqual(cmds, [], "no shell command may run for an unsafe id")
})

test("rewriteTask validates before writing, so a bad task leaves the file untouched", async () => {
  const cmds: string[] = []
  const $ = rewriteShell(cmds)
  await assert.rejects(
    () => rewriteTask($, { id: "t", path: "/repo/docs/tasks/draft/t.md" }, { title: "" }),
    /title is required/,
  )
  assert.ok(!cmds.some((c) => c.startsWith("printf")), "serialization failed before any write")
})

test("rewriteTask drops frontmatter keys the schema does not know", async () => {
  // Pinned deliberately: zod strips unknown keys, so this loss is real and a
  // caller must screen with `unknownFrontmatterKeys` first (the hub does).
  const cmds: string[] = []
  const $ = rewriteShell(cmds)
  const parsed = parseTask("t.md", "---\ntitle: T\nsprint: 42\n---\nbody", "/repo/docs/tasks/draft/t.md")
  await rewriteTask($, { id: "t", path: parsed.path }, taskToInput(parsed))
  assert.ok(!cmds.find((c) => c.startsWith("printf"))?.includes("sprint"), "the unknown key is gone")
})

// --- splitTaskBody / joinTaskBody: the audit trail survives a human edit ---

test("splitTaskBody separates prose from the trailing audit run", () => {
  const parts = splitTaskBody("Context line.\n\n> Task approved [2026-01-01 by A]\n> CLAIMED [2026-01-02 by B]")
  assert.equal(parts.prose, "Context line.")
  assert.equal(parts.tail, "> Task approved [2026-01-01 by A]\n> CLAIMED [2026-01-02 by B]")
})

test("splitTaskBody keeps a mid-body blockquote in the editable prose", () => {
  // Only the SUFFIX is the audit trail — a quote the author wrote inside the
  // description stays theirs to edit.
  const parts = splitTaskBody("Intro.\n\n> a quoted requirement\n\nMore prose.\n\n> Task approved [x by y]")
  assert.equal(parts.prose, "Intro.\n\n> a quoted requirement\n\nMore prose.")
  assert.equal(parts.tail, "> Task approved [x by y]")
})

test("splitTaskBody handles a notes-only body and an empty one", () => {
  assert.deepEqual(splitTaskBody("> only a note [x by y]"), { prose: "", tail: "> only a note [x by y]" })
  assert.deepEqual(splitTaskBody(""), { prose: "", tail: "" })
  assert.deepEqual(splitTaskBody("Just prose."), { prose: "Just prose.", tail: "" })
})

test("joinTaskBody round-trips a split body", () => {
  const body = "Context.\n\n> Task approved [x by y]"
  const { prose, tail } = splitTaskBody(body)
  assert.equal(joinTaskBody(prose, tail), body)
  assert.equal(joinTaskBody("", "> n"), "> n")
  assert.equal(joinTaskBody("p", ""), "p")
  assert.equal(joinTaskBody("", ""), "")
})

test("joinTaskBody preserves the tail when the prose is replaced wholesale", () => {
  const { tail } = splitTaskBody("Old goal.\n\n> Task approved [x by y]")
  assert.equal(joinTaskBody("Brand new goal.", tail), "Brand new goal.\n\n> Task approved [x by y]")
})

// --- taskToInput / unknownFrontmatterKeys ---

test("taskToInput round-trips a parsed task through serializeTask", () => {
  const original = serializeTask({
    title: "Add rate limiting",
    type: "feature",
    priority: 2,
    labels: ["api"],
    acceptance: ["429 after 100 rps"],
    body: "Context.",
  })
  const parsed = parseTask("f7k3-add-rate-limit.md", original, "/repo/docs/tasks/draft/f7k3-add-rate-limit.md")
  const again = parseTask("f7k3-add-rate-limit.md", serializeTask(taskToInput(parsed)), parsed.path)
  assert.deepEqual(again, parsed)
})

/**
 * `epic` has to be a REAL schema field, not a key written into frontmatter: zod
 * strips what the schema doesn't know, and `unknownFrontmatterKeys` is what the
 * hub screens an in-place edit with. Off-schema, every child of a slice set would
 * report as data an edit is about to delete — and `retask` would delete it.
 */
test("epic round-trips through the schema and is not reported as an unknown key", () => {
  const content = serializeTask({ title: "Wire the UI", epic: "k2p9-search-rewrite", priority: 1, body: "Part of epic: k2p9-search-rewrite (slice 2 of 3)" })
  assert.match(content, /^epic: k2p9-search-rewrite$/m)
  const parsed = parseTask("c3d4-ui.md", content, "/repo/docs/tasks/draft/c3d4-ui.md")
  assert.equal(parsed.epic, "k2p9-search-rewrite")
  assert.deepEqual(unknownFrontmatterKeys(content), [])
  assert.equal(serializeTask(taskToInput(parsed)), content, "an edit must not drop it")
})

test("a task without an epic serializes exactly as before — no empty key", () => {
  const content = serializeTask({ title: "Standalone", priority: 0, body: "Context." })
  assert.ok(!content.includes("epic"), content)
  assert.equal(parseTask("t.md", content, "/r/t.md").epic, undefined)
})

test("unknownFrontmatterKeys names what serializeTask would drop", () => {
  assert.deepEqual(unknownFrontmatterKeys("---\ntitle: T\nsprint: 42\nowner: me\n---\nbody"), ["sprint", "owner"])
  assert.deepEqual(unknownFrontmatterKeys("---\ntitle: T\npriority: 1\n---\nbody"), [])
  // Nothing this can prove would be lost: the caller's own parse refuses these.
  assert.deepEqual(unknownFrontmatterKeys("no frontmatter at all"), [])
  assert.deepEqual(unknownFrontmatterKeys("---\n[: :[ broken\n---\nbody"), [])
})

/**
 * zod strips at EVERY depth, so the screen has to look at every depth. `tracker`
 * is the field this actually bites on: it is the one a tracker sync writes, and
 * an ADO pairing routinely carries fields the schema never modelled. Screening
 * only the top level reported "safe to rewrite" and every rewrite deleted them.
 */
test("unknownFrontmatterKeys names nested tracker keys serializeTask would drop", () => {
  const content = ["---", "title: T", "tracker:", "  system: azure-devops", '  key: "1234"', "  areaPath: TeamWeb", "  rev: 7", "---", "body"].join("\n")
  assert.deepEqual(unknownFrontmatterKeys(content), ["tracker.areaPath", "tracker.rev"])
  // …and they really would be dropped — this is the loss the screen exists to catch.
  const rewritten = serializeTask(taskToInput(parseTask("t.md", content, "/r/t.md")))
  assert.ok(!rewritten.includes("areaPath"), rewritten)
  assert.ok(!rewritten.includes("rev:"), rewritten)
})

test("a fully-populated tracker is not reported, and a malformed one is not descended into", () => {
  const clean = serializeTask({ title: "T", tracker: { system: "jira", key: "P-1", url: "https://x.example/1", parent: "P-0" }, body: "b" })
  assert.deepEqual(unknownFrontmatterKeys(clean), [])
  // A scalar/list/null `tracker` has no children to lose; the caller's own parse
  // is what refuses it. Never throw here — this runs on files that are broken.
  for (const bad of ["tracker: nonsense", "tracker:\n  - a", "tracker:"]) {
    assert.deepEqual(unknownFrontmatterKeys(`---\ntitle: T\n${bad}\n---\nbody`), [], bad)
  }
  // An UNKNOWN top-level object is reported whole, not child by child: the file
  // is already refused, and listing its children only makes the refusal noisier.
  assert.deepEqual(unknownFrontmatterKeys("---\ntitle: T\ncustom:\n  a: 1\n  b: 2\n---\nbody"), ["custom"])
})
