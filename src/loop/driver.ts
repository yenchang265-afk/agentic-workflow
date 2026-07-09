import type { PluginInput } from "@opencode-ai/plugin"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type Task } from "@agentic-loop/core/task/schema"
import { advance, composePrompt, firstStep } from "@agentic-loop/core/loop/engine"
import { registerEngineeringHooks } from "@agentic-loop/core/kinds/engineering"
import { loadManifest } from "@agentic-loop/core/manifest/load"
import { resolveValidateHook } from "@agentic-loop/core/manifest/registry"
import { stageDef, type LoadedManifest } from "@agentic-loop/core/manifest/schema"
import { combineSkips, pollOnce } from "@agentic-loop/core/scheduler/scheduler"
import { platformFor } from "@agentic-loop/core/config"
import { makeAdoPrSource } from "@agentic-loop/core/source/ado-pr"
import {
  makeAdoMcpPrSource,
  AdoDataBundleSchema,
  describeAdoDataRequest,
  type AdoDataBundle,
  type AdoDataProvider,
} from "@agentic-loop/core/source/ado-mcp-pr"
import { makeBacklogSource } from "@agentic-loop/core/source/backlog"
import { makeGithubPrSource } from "@agentic-loop/core/source/github-pr"
import type { TerminalOutcome, WorkSource } from "@agentic-loop/core/source/types"
import {
  ensureIsolation as coreEnsureIsolation,
  loopId,
  teardownIsolation as coreTeardownIsolation,
} from "@agentic-loop/core/loop/isolate"
import {
  appendNote,
  appendRunLog,
  auditNote,
  claimFirst,
  claimTask,
  extractPlan,
  findByIdIn,
  hasPlan,
  isClaimable,
  isOrphanedPlanClaim,
  isRecoverable,
  listByStatus,
  listClaimIds,
  listInProgress,
  listQueued,
  moveTask,
  releaseClaim,
  releaseOrphanedClaims,
  rescueStray,
  selectOrder,
  STALE_CLAIM_MINUTES,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
} from "@agentic-loop/core/task/store"
import { auditBacklog, formatAnomalies } from "@agentic-loop/core/task/audit"
import { acquireLease, heartbeatLease, releaseLease } from "@agentic-loop/core/scheduler/lease"
import {
  addWorktree,
  checkoutBranch,
  commitAll,
  commitPaths,
  currentBranch,
  ensureExcluded,
  gitActor,
  isDirty,
  isGitRepo,
  pruneWorktrees,
  removeWorktree,
  worktreeForBranch,
} from "@agentic-loop/core/loop/git"
import { clearState, loadState, saveState } from "@agentic-loop/core/loop/persist"
import { type Outcome, renderRunSummary, type StageSample } from "@agentic-loop/core/loop/metrics"
import {
  failedCriteriaBlock,
  LOOP_REVIEW_TAG,
  LOOP_VERIFY_TAG,
  parseVerdict,
  type Verdict,
  type VerdictRecord,
  worstOf,
} from "@agentic-loop/core/loop/verdict"
import { enabledLoopKinds } from "@agentic-loop/core/config"
import type { Config } from "../config.ts"
import type { Action, LoopState, Stage, TaskRef } from "@agentic-loop/core/loop/state"
import {
  clearLoop,
  findSessionDriving,
  getLoop,
  resumeAtBuild,
  setLoop,
  startAtPlan,
} from "@agentic-loop/core/loop/state"

/**
 * Impure orchestration for the agentic loop. Thin glue over the pure helpers in
 * `state.ts`.
 *
 * Stepping is **sequential**: `client.session.command` resolves with the
 * completed stage's assistant message, so the driver fires a stage, captures its
 * output, feeds it back into the pure `advanceOnIdle` decision, and repeats until
 * a non-`fire` action (gate / done / stop). `session.idle` is used only as the
 * trigger to begin a drive once the `/agent-loop` command's own turn settles; a pending
 * marker selects what to run and a driving lock prevents re-entrancy from the
 * idle events the driver's own commands generate.
 *
 * Task authoring happens **before** the loop, in the `/agent-loop-task` command:
 * `new <idea>` interviews the user into a planless draft, and the deterministic
 * `approve <id>` subcommand (in `handleTaskCommand`) parks it planless in
 * `queued/`. Planning happens **inside** the loop, right before execution, so
 * plans don't rot while a task sits parked: a claimed `queued/` task enters at
 * the PLAN stage (`startAtPlan`), which writes the `## Implementation Plan`
 * onto the task file and terminates with a `park` action — the driver moves
 * the task to `plan-review/` and the loop exits without blocking on a human.
 * `/agent-loop-task approve-plan <id>` is the human plan gate: it moves the task to
 * `in-progress/` — the build-ready queue — and the next claim enters at
 * `build` via `resumeAtBuild` with the approved plan threaded in as an artifact.
 *
 * PLAN, or BUILD → VERIFY → REVIEW, runs either on demand (`/agent-loop task <id>`
 * claims one task) or via **watch mode** (the `watching` set + `tryClaim`): a
 * watching session scans `in-progress/` for one claimable task (`isClaimable`:
 * has a persisted plan, never started) — build work first — and falls back to
 * `queued/` for a task to plan. Watch is triggered two ways — every
 * `session.idle` event, plus a per-session interval timer (`/agent-loop watch
 * [interval]`) whose ticks call `onIdle` only when the session is actually
 * idle (queried via `client.session.status()`), so a task approved while the
 * session sat quiet still gets picked up. A VERIFY or REVIEW FAIL loops back
 * to `build` **inside this same session**, with the failure threaded into the
 * build prompt. Two watch sessions racing the same tick could both see a task
 * as claimable before either claims it; the atomic `claimTask` marker
 * resolves the race (in `queued/` and `in-progress/` alike).
 *
 * Task lifecycle: `/agent-loop-task new` authors into `draft/`; `approve <id>`
 * moves it to `queued/`; the loop's PLAN stage parks it in `plan-review/`;
 * `approve-plan <id>` moves it to `in-progress/`; a stop/failure while
 * building appends a note and leaves it in `in-progress/`; the loop finishing
 * (review PASS) moves it to `in-review/`, the human diff gate — a human runs
 * `/agent-loop ship <id>` to move it to `completed/`. If the plan itself turns out
 * wrong (rejected at the gate, or the iteration cap stops the loop), a human
 * sends it back to `queued/` with `/agent-loop-task replan <id>` and the PLAN
 * stage runs again with the failure context threaded in.
 */

/** The loop-kind manifests shipped with this repo (loops/<kind>/). */
const LOOPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "loops")
const eng = loadManifest(LOOPS_DIR, "engineering")
registerEngineeringHooks()

/** Loaded manifests by kind — engineering eagerly, other enabled kinds on first poll. */
const manifests = new Map<string, LoadedManifest>([["engineering", eng]])
export const manifestFor = (kind: string): LoadedManifest => {
  let loaded = manifests.get(kind)
  if (!loaded) {
    loaded = loadManifest(LOOPS_DIR, kind)
    manifests.set(kind, loaded)
  }
  return loaded
}

/** The work sources the scheduler polls, in claim-priority order (config order).
 *  `sessionID` is needed only for the ado-mcp source, whose poll fires an agent
 *  command in this session to gather ADO data (see `adoMcpProvider`). */
const sourcesFor = (deps: Deps, config: Config, sessionID: string): WorkSource[] =>
  enabledLoopKinds(config).flatMap((kind): WorkSource[] => {
    // A typo'd or unavailable `loops.<kind>` (the config schema is an open record)
    // must not throw here — that would abort the whole flatMap and take every OTHER
    // enabled source (engineering included) down with it, so no work ever gets
    // claimed. Skip-and-warn the bad kind instead.
    let loaded: LoadedManifest
    try {
      loaded = manifestFor(kind)
    } catch (err) {
      void deps.log(
        "warn",
        `loop kind "${kind}" is enabled in config but its loops/${kind}/ manifest could not be loaded — skipping it. ${(err as Error).message}`,
      )
      return []
    }
    if (loaded.manifest.workSource.type === "github-pr") {
      const platform = platformFor(config, kind)
      if (platform === "ado") {
        return [
          makeAdoPrSource({
            $: deps.$,
            client: deps.client,
            directory: deps.directory,
            tasksDir: config.tasksDir,
            log: deps.log,
            loaded,
            // Config parse fails fast when platform "ado" lacks the ado section.
            ado: config.ado!,
          }),
        ]
      }
      if (platform === "ado-mcp") {
        return [
          makeAdoMcpPrSource({
            $: deps.$,
            client: deps.client,
            directory: deps.directory,
            tasksDir: config.tasksDir,
            log: deps.log,
            loaded,
            ado: config.ado!,
            provider: adoMcpProvider(deps, config, sessionID),
          }),
        ]
      }
      const query = config.loops[kind]?.["query"]
      return [
        makeGithubPrSource({
          $: deps.$,
          client: deps.client,
          directory: deps.directory,
          tasksDir: config.tasksDir,
          log: deps.log,
          loaded,
          ...(typeof query === "string" ? { query } : {}),
        }),
      ]
    }
    return [
      makeBacklogSource({
        $: deps.$,
        client: deps.client,
        directory: deps.directory,
        tasksDir: config.tasksDir,
        log: deps.log,
        loaded,
        isDriving: (id) => findSessionDriving(id) !== undefined,
      }),
    ]
  })

type Client = PluginInput["client"]
type Shell = PluginInput["$"]
type Log = (level: "info" | "warn" | "error", message: string) => unknown

/** Everything the driver needs from the plugin host, bundled once in index.ts. */
export interface Deps {
  readonly client: Client
  readonly $: Shell
  readonly directory: string
  readonly log: Log
}

type Pending =
  | { readonly kind: "start-task"; readonly task: Task; readonly goal: string }
  | { readonly kind: "start-plan"; readonly task: Task; readonly goal: string }
  | { readonly kind: "recover"; readonly task: Task }
  | { readonly kind: "recover-state"; readonly state: LoopState }

const pending = new Map<string, Pending>()

/** The task whose on-disk claim marker a pending entry placed before it was queued. */
const pendingClaim = (p: Pending): { readonly id: string; readonly path: string } | undefined =>
  p.kind === "recover-state" ? p.state.task : p.task

/**
 * Release the claim marker an about-to-be-discarded pending placed. Every `pending`
 * entry is preceded by a `claimTask`, so a pending that is overwritten (a second
 * `/agent-loop task`) or dropped (`stop`/ESC) before `onIdle` drains it would leave
 * its task claim-held-but-undriven — invisible to every watcher until the stale-claim
 * sweep. Best-effort.
 */
const releasePendingMarker = async (deps: Deps, prior: Pending | undefined): Promise<void> => {
  const ref = prior && pendingClaim(prior)
  if (ref) await releaseClaim(deps.$, { id: ref.id, path: ref.path })
}

/** Queue a session's pending work, first releasing the marker of any prior unconsumed pending. */
const setPending = async (deps: Deps, sessionID: string, entry: Pending): Promise<void> => {
  await releasePendingMarker(deps, pending.get(sessionID))
  pending.set(sessionID, entry)
}

/** Drop a session's unconsumed pending work and release its claim marker. */
const dropPending = async (deps: Deps, sessionID: string): Promise<void> => {
  const prior = pending.get(sessionID)
  pending.delete(sessionID)
  await releasePendingMarker(deps, prior)
}
const driving = new Set<string>()
/** Sessions in `/agent-loop watch` mode — a standing flag, not a one-shot `Pending`,
 *  since it must survive many no-op idle ticks between claims. */
const watching = new Set<string>()
/** Sessions the user interrupted (ESC) mid-drive. Trips drive's stop guard after
 *  the current stage settles, so the loop halts without prematurely nulling
 *  `getLoop` (which `onIdle`'s catch still needs on a reject-on-abort). Cleared
 *  when the drive unwinds. */
const interrupted = new Set<string>()
/** Per-watching-session polling timers and their cadence (for status display). */
const watchTimers = new Map<string, ReturnType<typeof setInterval>>()
const watchIntervalsMs = new Map<string, number>()
/**
 * The clone's watch lease, refcounted per working directory: watch sessions in
 * THIS process share one on-disk lease (in-process races are covered by the
 * claim markers + `executingDirs`); the lease exists to refuse a SECOND
 * process watching the same clone — the cross-process race (threat-model T3)
 * the in-memory guards can't see. Last unwatch/stop releases it.
 */
const watchLeases = new Map<string, { count: number; deps: Deps; tasksDir: string; intervalMs: number }>()
/**
 * The in-flight on-disk acquisition per directory. A second watch session arming the
 * same clone while the first is still awaiting `acquireLease` would otherwise read an
 * empty `watchLeases`, race its own `acquireLease` (which the first pid already holds),
 * and wrongly refuse ITSELF ("another watcher holds the lease"). Joiners await this
 * single acquisition instead and share the refcount — but never return ok until the
 * cross-process disk lease is actually held.
 */
const watchLeaseAcquiring = new Map<string, Promise<{ ok: true } | { ok: false; message: string }>>()

const leaseOwner = (intervalMs: number) => ({ pid: process.pid, host: os.hostname(), intervalMs })

/** Acquire (or share) the clone's watch lease. On refusal, says who holds it. */
const acquireWatchLease = async (
  deps: Deps,
  config: Config,
  intervalMs: number,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const dir = deps.directory
  const existing = watchLeases.get(dir)
  if (existing) {
    existing.count += 1
    return { ok: true }
  }
  // Coalesce concurrent first-arms: joiners await the one in-flight acquisition, then
  // take the refcount fast-path on success rather than racing a second `acquireLease`.
  const inflight = watchLeaseAcquiring.get(dir)
  if (inflight) {
    const res = await inflight
    if (!res.ok) return res
    const e = watchLeases.get(dir)
    if (e) e.count += 1
    return { ok: true }
  }
  const attempt = (async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    const res = await acquireLease(deps.$, dir, config.tasksDir, leaseOwner(intervalMs), new Date())
    if (!res.ok) {
      const o = res.owner
      const ago = o && Number.isFinite(Date.parse(o.heartbeatAt)) ? Math.round((Date.now() - Date.parse(o.heartbeatAt)) / 1000) : null
      const who = o ? ` (pid ${o.pid} on ${o.host}${ago !== null ? `, heartbeat ${ago}s ago` : ""})` : ""
      return {
        ok: false,
        message: `Another watcher${who} holds this clone's watch lease — unwatch it there, or run this watcher in its own clone/worktree.`,
      }
    }
    watchLeases.set(dir, { count: 1, deps, tasksDir: config.tasksDir, intervalMs })
    return { ok: true }
  })()
  watchLeaseAcquiring.set(dir, attempt)
  try {
    return await attempt
  } finally {
    watchLeaseAcquiring.delete(dir)
  }
}

/** Drop one watch session's share of the lease; the last one releases it on disk. */
const releaseWatchLease = async (deps: Deps): Promise<void> => {
  const entry = watchLeases.get(deps.directory)
  if (!entry) return
  entry.count -= 1
  if (entry.count > 0) return
  watchLeases.delete(deps.directory)
  await releaseLease(deps.$, deps.directory, entry.tasksDir)
}
/**
 * Last no-claim reason toasted per watch session. Every tick logs its reason,
 * but the toast fires only when the reason CHANGES — a held marker or an
 * unplanned backlog would otherwise re-toast every 10s tick. Cleared on
 * successful claim, stop, unwatch, and (re-)watch so a re-arm re-toasts.
 */
const lastSkipReason = new Map<string, string>()
/**
 * Working directories with a drive in flight. All sessions of one opencode
 * instance share a single working tree and checked-out branch, so at most one
 * loop may drive stages in it at a time — a second would switch branches out
 * from under the first. (Separate opencode processes on the same clone are
 * NOT covered — run extra watchers in their own clones/worktrees.)
 */
const executingDirs = new Set<string>()

/** A check stage's name — validated against the driven kind's manifest. */
type CheckStage = string

/**
 * Verdicts recorded by the `loop_verdict` tool, per session, consumed by the
 * drive loop right after the check stage that recorded them completes. This
 * tool call — not the stage's free text — is the authoritative channel;
 * text is untrusted (quoted contracts, echoed repo content).
 */
const recordedVerdicts = new Map<string, { readonly stage: CheckStage; readonly record: VerdictRecord }>()

/** Per-session run metrics, accumulated across a drive and rendered on termination. */
const runSamples = new Map<string, StageSample[]>()

/** Append a stage sample to this session's run metrics. */
const addSample = (sessionID: string, sample: StageSample): void => {
  const list = runSamples.get(sessionID) ?? []
  list.push(sample)
  runSamples.set(sessionID, list)
}

/**
 * Record a verdict from the `loop_verdict` plugin tool. Only accepted while
 * this session's live loop is actually sitting in that check stage —
 * anything else (no loop, wrong stage, e.g. a build agent trying to
 * pre-empt its own verification) is ignored with an explanatory result.
 * The optional `reason`/`criteria` steer the next iteration's prompt only.
 */
export const recordVerdict = (sessionID: string, stage: CheckStage, record: VerdictRecord): string => {
  const state = getLoop(sessionID)
  if (!state) return "No active loop in this session — verdict ignored."
  if (state.stage !== stage) {
    return `The loop is at ${state.stage}, not ${stage} — verdict ignored. Only the running check stage may record its own verdict.`
  }
  const def = manifestFor(state.kind ?? "engineering").manifest.stages.find((d) => d.name === stage)
  if (def?.kind !== "check") {
    return `Stage ${stage} is not a check stage — verdict ignored.`
  }
  recordedVerdicts.set(sessionID, { stage, record })
  return `Recorded ${stage} verdict: ${record.verdict}.`
}

/** Consume (read-and-clear) the verdict record for a session's check stage, if any. */
const takeVerdictRecord = (sessionID: string, stage: CheckStage): VerdictRecord | null => {
  const rec = recordedVerdicts.get(sessionID)
  recordedVerdicts.delete(sessionID)
  return rec && rec.stage === stage ? rec.record : null
}

/**
 * Sessions with an ADO-MCP poll in flight → the resolver waiting for the bundle.
 * The ado-mcp source (codePlatform "ado-mcp") can't call MCP tools itself, so its
 * provider fires the `pr-poll` agent command in this session and awaits the
 * bundle that the loop-pr-poll agent delivers through the `loop_ado_data` tool —
 * the mirror of the loop_verdict channel above.
 */
const pendingAdoData = new Map<string, (bundle: AdoDataBundle | null) => void>()

/** Record the ADO data bundle the loop-pr-poll agent gathered, from the `loop_ado_data` tool. */
export const recordAdoData = (sessionID: string, raw: unknown): string => {
  const resolve = pendingAdoData.get(sessionID)
  if (!resolve) return "No ADO data poll is awaiting input in this session — ignored."
  const parsed = AdoDataBundleSchema.safeParse(raw)
  if (!parsed.success) {
    return `adoData did not match the expected bundle shape: ${parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
      .join("; ")}`
  }
  pendingAdoData.delete(sessionID)
  resolve(parsed.data)
  return `Recorded ADO data bundle (${parsed.data.pullRequests.length} PR(s)).`
}

/**
 * The ado-mcp source's data provider on OpenCode: fire the read-only `pr-poll`
 * agent command in this session with the fetch spec, and resolve with the bundle
 * it hands back via `loop_ado_data`. Returns null (→ a "needs data" skip that the
 * watcher logs and retries next tick) if a poll is already in flight, the command
 * ends without delivering a bundle, or it times out. Re-entrancy is safe: tryClaim
 * runs inside onIdle's `driving` guard, so the poll command's own idle events
 * cannot start a second claim.
 */
const adoMcpProvider = (deps: Deps, config: Config, sessionID: string): AdoDataProvider => ({
  fetch: (request) =>
    new Promise<AdoDataBundle | null>((resolve) => {
      if (pendingAdoData.has(sessionID)) return resolve(null) // one poll at a time per session
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (bundle: AdoDataBundle | null) => {
        if (settled) return
        settled = true
        pendingAdoData.delete(sessionID)
        if (timer) clearTimeout(timer)
        resolve(bundle)
      }
      pendingAdoData.set(sessionID, finish)
      timer = setTimeout(() => finish(null), config.stageTimeoutMinutes * 60_000)
      // Fire the poll command; its text output is ignored — the bundle arrives via
      // loop_ado_data (→ recordAdoData → finish). If the command returns without
      // delivering one, resolve null so the poll retries on the next tick.
      runStage(deps.client, sessionID, "pr-poll", describeAdoDataRequest(request), config.stageTimeoutMinutes)
        .then(() => finish(null))
        .catch(() => finish(null))
    }),
})

const toast = (client: Client, message: string, variant: "info" | "success" | "warning" | "error") =>
  client.tui.showToast({ body: { message, variant } }).catch(() => {})

/** A task's goal text: title headline plus its body, if any. */
const taskGoal = (task: Task): string => (task.body ? `${task.title}\n\n${task.body}` : task.title)

const taskRef = (task: Task, path: string): TaskRef => ({
  id: task.id,
  path,
  acceptance: task.acceptance,
})

/** Git isolation lives in core (`@agentic-loop/core/loop/isolate`); these
 *  wrappers thread this plugin's `Deps` into its host-agnostic signatures. */
const ensureIsolation = (deps: Deps, config: Config, state: LoopState): Promise<LoopState> =>
  coreEnsureIsolation(deps.$, deps.log, deps.directory, config, state)

const teardownIsolation = (deps: Deps, state: LoopState): Promise<void> =>
  // Gate on `isolated`, not `git`: a PR source pre-sets `git` to name the branch to
  // isolate onto, so a stage that never isolated (pr-sitter `triage` → done) must NOT
  // reach `coreTeardownIsolation`, which would checkout the base branch on the main tree.
  state.isolated ? coreTeardownIsolation(deps.$, deps.log, deps.directory, state) : Promise.resolve()

/** The working directory a loop's stages operate in: its worktree, else the main tree. */
const workTree = (deps: Deps, state: LoopState): string => state.git?.worktree ?? deps.directory

/**
 * Serialize commits per git tree. In worktree mode `serialize` is off, so N in-process
 * watch drives run concurrently — and a command handler can fire mid-drive in either
 * mode — all committing the MAIN tree. Concurrent `git commit`s contend on
 * `.git/index.lock`; the loser's `commitPaths`/`commitAll` hits `.nothrow()`, returns
 * false, and the change never enters history (the fs task-move still lands, so it looks
 * committed). A per-tree promise chain makes each tree's commits run one at a time.
 * Keyed by tree path: a worktree's own index never contends with the main tree's.
 */
const commitLocks = new Map<string, Promise<unknown>>()
const withCommitLock = <T>(treePath: string, fn: () => Promise<T>): Promise<T> => {
  const prev = commitLocks.get(treePath) ?? Promise.resolve()
  const run = prev.then(fn, fn) // run regardless of the prior commit's outcome
  commitLocks.set(
    treePath,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

/** Commit everything as a checkpoint on the loop branch/worktree. No-op until isolation ran. */
const checkpoint = async (deps: Deps, state: LoopState, message: string): Promise<void> => {
  // `isolated` (not `git`): don't `git add -A && commit` the human's main tree for a
  // loop whose pre-set `git` never became real isolation — that would sweep their WIP
  // into a bogus loop commit (pr-sitter `triage` → done on a dirty tree).
  if (!state.isolated) return
  const tree = workTree(deps, state)
  await withCommitLock(tree, () => commitAll(deps.$, tree, message))
}

/** Commit backlog path changes on the MAIN tree, serialized against other commits there. */
const commitTasks = (deps: Deps, config: Config, message: string): Promise<boolean> =>
  withCommitLock(deps.directory, () => commitPaths(deps.$, deps.directory, [config.tasksDir], message))

/**
 * Commit backlog mutations (audit notes, task moves) on the MAIN tree. In
 * shared mode these ride the loop-branch checkpoints; in worktree mode the
 * checkpoints commit the worktree, so terminal-event backlog changes must be
 * committed on the human's branch explicitly. No-op in shared mode.
 */
const commitBacklog = async (deps: Deps, config: Config, state: LoopState, message: string): Promise<void> => {
  if (!state.git?.worktree) return
  await commitTasks(deps, config, message)
}

/** The slash command a stage fires — named by the manifest (e.g. plan → `plan-task`). Pure. */
const stageCommand = (loaded: LoadedManifest, stage: Stage): string => stageDef(loaded.manifest, stage).command

/**
 * Fire a stage command and return the assistant text it produced. Throws when
 * the stage exceeds the configured wall-clock cap — a hung stage must fail
 * the loop (and release its locks via onIdle's catch) rather than wedge the
 * driver forever.
 */
const runStage = async (
  client: Client,
  sessionID: string,
  stage: string,
  args: string,
  timeoutMinutes: number,
): Promise<string> => {
  const command = client.session.command({
    path: { id: sessionID },
    body: { command: stage, arguments: args },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${stage} stage timed out after ${timeoutMinutes} minutes`)),
      timeoutMinutes * 60_000,
    )
  })
  try {
    const res = await Promise.race([command, timeout])
    const parts = res.data?.parts ?? []
    return parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Combine the verdict records of several review-lens passes into one: the worst
 * verdict wins, and the reasons/failed-criteria of every non-PASS pass are
 * merged so the re-build prompt sees all objections. Pure.
 */
const combineRecords = (records: readonly (VerdictRecord | null)[], lenses: readonly string[]): VerdictRecord => {
  const verdict = worstOf(records.map((r) => r?.verdict ?? null))
  const reasons: string[] = []
  const criteria: { criterion: string; pass: boolean }[] = []
  records.forEach((r, i) => {
    if (!r || r.verdict === "PASS") return
    const lens = lenses[i]
    if (r.reason) reasons.push(lens ? `[${lens}] ${r.reason}` : r.reason)
    for (const c of r.criteria ?? []) criteria.push(c)
  })
  return {
    verdict,
    ...(reasons.length ? { reason: reasons.join(" · ") } : {}),
    ...(criteria.length ? { criteria } : {}),
  }
}

/**
 * Fire a stage, log its output to the run log, and (for check stages) capture
 * its verdict record. REVIEW expands into one pass per configured lens — the
 * verdicts are combined worst-wins and non-PASS pass outputs concatenated, so
 * a single injected reviewer can't flip the outcome (threat model T1). All
 * other stages run exactly once. Stops firing further lens passes if a
 * `/agent-loop stop` clears the loop mid-pass.
 */
const runStageWithLenses = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  loaded: LoadedManifest,
  state: LoopState,
  stage: Stage,
  baseArgs: string,
  iteration: number,
): Promise<{ output: string; verdict: Verdict | null; record: VerdictRecord | null }> => {
  const isCheck = stageDef(loaded.manifest, stage).kind === "check"
  const lenses = stage === "review" ? config.reviewLenses : []
  const passes: (string | null)[] = lenses.length ? [...lenses] : [null]
  const outputs: string[] = []
  const records: (VerdictRecord | null)[] = []
  const { client } = deps

  for (let i = 0; i < passes.length; i++) {
    const lens = passes[i]
    const args = lens
      ? `${baseArgs}\n\nReview lens ${i + 1}/${passes.length}: focus exclusively on ${lens}. The other lenses ` +
        `run as separate passes — don't repeat them. Record this pass's verdict via loop_verdict as usual.`
      : baseArgs
    recordedVerdicts.delete(sessionID) // no stale verdict may leak into this pass
    const t0 = Date.now()
    const out = await runStage(client, sessionID, stageCommand(loaded, stage), args, config.stageTimeoutMinutes)
    const ms = Date.now() - t0
    const stamp = new Date().toISOString()
    const header = lens
      ? `${stage} (lens: ${lens}) · iteration ${iteration + 1} · ${stamp}`
      : `${stage} · iteration ${iteration + 1} · ${stamp}`
    await appendRunLog(deps.$, deps.directory, config.tasksDir, loopId(state), header, out, deps.log)
    outputs.push(lens ? `### Review lens: ${lens}\n${out}` : out)
    const passRecord = isCheck ? takeVerdictRecord(sessionID, stage as CheckStage) : null
    records.push(passRecord)
    addSample(sessionID, {
      stage,
      iteration,
      ms,
      ...(isCheck ? { verdict: passRecord?.verdict ?? "none" } : {}),
      ...(lens ? { lens } : {}),
    })
    if (!getLoop(sessionID)) break // /agent-loop stop mid-pass — don't fire the rest
  }

  if (!isCheck) return { output: outputs[0] ?? "", verdict: null, record: null }

  const record = lenses.length ? combineRecords(records, lenses) : (records[0] ?? null)
  const verdict = record?.verdict ?? null
  if (verdict === null) {
    const inText = parseVerdict(outputs.join("\n"), stage === "verify" ? LOOP_VERIFY_TAG : LOOP_REVIEW_TAG)
    await deps.log(
      "warn",
      `${stage} recorded no verdict via loop_verdict${inText ? ` (text claimed ${inText})` : ""} — treating as FAIL`,
    )
  }
  return { output: outputs.join("\n\n"), verdict, record }
}

/**
 * Persist a task-driven loop's state after a transition, so a crash/restart can
 * resume at the exact stage. No-op for free-text loops (no durable id yet).
 */
const snapshot = async (deps: Deps, config: Config, state: LoopState): Promise<void> => {
  if (!state.task) return
  await saveState(deps.$, deps.directory, config.tasksDir, state.task.id, state)
}

/**
 * Render this session's accumulated run metrics into the run log and clear the
 * accumulator. Called once per terminal event (done/stop/error). Best-effort —
 * never let telemetry failure disrupt the terminal handling.
 */
const renderMetrics = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  state: LoopState,
  outcome: Outcome,
  detail: string,
): Promise<void> => {
  const samples = runSamples.get(sessionID) ?? []
  runSamples.delete(sessionID)
  // Report against the EFFECTIVE cap the engine enforced — a kind's manifest may
  // override `config.maxIterations` (pr-sitter caps at 3), so `config.maxIterations`
  // alone would mislabel the footer (e.g. "iterations used: 3/1").
  const cap = manifestFor(state.kind ?? "engineering").manifest.maxIterations ?? config.maxIterations
  const summary = renderRunSummary(samples, outcome, detail, cap, new Date().toISOString())
  await appendRunLog(deps.$, deps.directory, config.tasksDir, loopId(state), `run · ${outcome}`, summary, deps.log)
}

/** Run the stage chain from `first` until the pure logic yields a gate/done/stop.
 *  Returns the terminal outcome so callers can report it to the work source. */
export const drive = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  first: { state: LoopState; action: Action },
): Promise<TerminalOutcome | null> => {
  const { client } = deps
  const loaded = manifestFor(first.state.kind ?? "engineering")
  const actor = await gitActor(deps.$, deps.directory)
  let step = first
  while (step.action.kind === "fire") {
    const { stage, arguments: args } = step.action
    // Every code-writing stage runs isolated: its own worktree (worktree mode)
    // or the loop/<id> branch in the shared tree (default). Created on the
    // first build; reconciled before every stage in case the tree/worktree
    // moved — including a snapshot-based `/agent-loop recover` that re-enters
    // directly at verify/review, where isolation must be re-established, not
    // assumed. PLAN is the exception: it writes only the task file (in the
    // main tree, on the human's branch) and parks, so it needs no branch, no
    // worktree, and no crash snapshot — a died PLAN is recovered by the stale
    // claim-marker sweep, not by /agent-loop recover.
    const isolated = stageDef(loaded.manifest, stage).isolation !== "none"
    if (isolated) {
      step = { ...step, state: await ensureIsolation(deps, config, step.state) }
    }
    setLoop(sessionID, step.state)
    if (isolated) await snapshot(deps, config, step.state)
    const { task, iteration } = step.state
    const trackBuild = stage === "build" && task
    if (trackBuild) await appendNote(deps.$, task, auditNote(`BUILD started (iteration ${iteration + 1})`, new Date(), actor), deps.log)
    const { output, verdict, record } = await runStageWithLenses(
      deps,
      sessionID,
      config,
      loaded,
      step.state,
      stage,
      args,
      iteration,
    )
    if (trackBuild) await appendNote(deps.$, task, auditNote(`BUILD finished (iteration ${iteration + 1})`, new Date(), actor), deps.log)
    // Halt the chain when either a `/agent-loop stop` cleared this session's loop
    // while the stage ran, or the user interrupted (ESC) mid-drive — preserving
    // whatever the stage did as a checkpoint on the branch. The interrupt path
    // leaves `getLoop` set (so `onIdle`'s catch stays intact on a reject-on-abort),
    // so this block clears it itself.
    const wasInterrupted = interrupted.has(sessionID)
    if (!getLoop(sessionID) || wasInterrupted) {
      const how = wasInterrupted ? "interrupted" : "stopped"
      await renderMetrics(deps, sessionID, config, step.state, "stopped", `${how} during ${stage}`)
      await checkpoint(deps, step.state, `loop(${loopId(step.state)}): incomplete — ${how} during ${stage}`)
      await teardownIsolation(deps, step.state)
      // A deliberate /agent-loop stop ends the run — drop the snapshot so recover can't
      // resurrect stale state. An ESC interrupt is a pause: KEEP the snapshot so
      // /agent-loop recover <id> resumes at THIS stage (recover-state), not a BUILD
      // restart. A reject-on-abort already keeps it (onIdle's catch never clears state),
      // so both interrupt paths converge on exact-stage resume.
      if (step.state.task && !wasInterrupted) await clearState(deps.$, deps.directory, config.tasksDir, step.state.task.id)
      clearLoop(sessionID) // self-contained — no-op no-harm when /agent-loop stop already cleared it
      return { kind: "stop", message: `${how} during ${stage}` }
    }
    // Checkpoint after any isolated code-writing (`work`) stage, not just the
    // engineering `build` — pr-sitter's `fix` stage writes code too and otherwise
    // gets no driver-side commit backstop if its agent forgets to commit.
    if (stageDef(loaded.manifest, stage).kind === "work" && isolated) {
      await checkpoint(deps, step.state, `loop(${loopId(step.state)}): ${stage} iteration ${iteration + 1}`)
    }
    if (stageDef(loaded.manifest, stage).kind === "check" && task) {
      const failed = record?.criteria?.filter((c) => !c.pass).length ?? 0
      const detail = record?.reason ? ` — ${record.reason}` : ""
      const criteriaNote = failed ? ` (${failed} criteria unmet)` : ""
      await appendNote(
        deps.$,
        task,
        auditNote(
          `${stage.toUpperCase()} verdict: ${verdict ?? "none recorded → FAIL"}${criteriaNote}${detail} (iteration ${iteration + 1})`,
          new Date(),
          actor,
        ),
        deps.log,
      )
    }
    // Thread the machine-recorded failure reasons ahead of the stage's prose so
    // the next PLAN/BUILD iteration leads with what actually failed.
    const block = failedCriteriaBlock(record)
    const threaded = block ? `${block}\n\n${output}` : output
    // Interpret transitions against the CLAIMED kind's manifest — `loaded`, not
    // the hardcoded engineering `eng`. A pr-sitter loop (stages triage/fix/
    // verify/publish) would otherwise crash on its first transition, as
    // `stageDef(eng.manifest, "triage")` throws. For engineering, `loaded` IS
    // `eng` (same map entry), so this is byte-identical there.
    step = advance(loaded, step.state, config, threaded, verdict)
  }

  const { state, action } = step
  switch (action.kind) {
    case "park": {
      // A manifest may name a pre-transition validator for this stage
      // (`hooks.validateBeforeTransition`); a registered hook returning a reason
      // vetoes the park. Engineering's plan-landed check needs backlog IO, so it
      // stays hardcoded below (its ref resolves to null here — harmless skip).
      const validate = resolveValidateHook(loaded.manifest.hooks.validateBeforeTransition[state.stage])
      const veto = validate ? await validate(state) : null
      if (veto) {
        await deps.log("warn", `loop: ${state.stage} park vetoed by validator — ${veto}`)
        if (state.task) {
          const held = await findByIdIn(deps.$, deps.directory, config.tasksDir, "queued", state.task.id)
          if (held) await releaseClaim(deps.$, held)
        }
        await renderMetrics(deps, sessionID, config, state, "error", veto)
        clearLoop(sessionID)
        await toast(client, `Park vetoed for "${state.task?.id ?? state.goal}" — ${veto}`, "error")
        return { kind: "error", message: veto }
      }
      // PLAN finished. Validate the plan actually landed on disk before
      // parking — a stage that wrote nothing must not put a planless task in
      // front of the human gate.
      if (!state.task) {
        clearLoop(sessionID)
        return { kind: "park", message: action.message }
      }
      const fresh = await findByIdIn(deps.$, deps.directory, config.tasksDir, "queued", state.task.id)
      if (!fresh || !hasPlan(fresh)) {
        const why = fresh ? "the PLAN stage wrote no ## Implementation Plan" : "the task left queued/ mid-plan"
        await deps.log("warn", `loop(${state.task.id}): not parking — ${why}`)
        if (fresh) {
          await appendNote(deps.$, fresh, auditNote(`PLAN stage failed — ${why}; still queued`, new Date(), actor), deps.log)
          await releaseClaim(deps.$, fresh)
        }
        await renderMetrics(deps, sessionID, config, state, "error", why)
        clearLoop(sessionID)
        await toast(client, `PLAN failed for "${state.task.id}" — ${why}. It stays in queued/.`, "error")
        return { kind: "error", message: why }
      }
      await appendNote(deps.$, fresh, auditNote("Plan written — parked for plan review", new Date(), actor), deps.log)
      await moveTask(deps.$, fresh, (action.toStatus ?? "plan-review") as TaskStatus) // also releases the queued/ claim marker
      await commitTasks(deps, config, `loop(${state.task.id}): plan written — parked for review`)
      await renderMetrics(deps, sessionID, config, state, "done", "plan parked for review")
      clearLoop(sessionID)
      await toast(
        client,
        `${action.message} Review it, then /agent-loop approve (or /agent-loop reject <why>).`,
        "success",
      )
      return { kind: "park", message: action.message }
    }
    case "done": {
      // "Done" for the loop is not "completed" for the task: a human still
      // has to look at the diff. The task parks in in-review/; moving it to
      // completed/ (e.g. when the PR merges) is the human's call.
      let moved = false
      if (state.task) {
        // Re-resolve the real current path (shell-authoritative) rather than trust
        // the claim-time state.task.path, which goes stale if the file moved since
        // the claim — a stale path makes the move fail and (before this) get
        // swallowed into a false "parked in in-review" success.
        const cur = await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-progress", state.task.id)
        if (cur) {
          try {
            await appendNote(deps.$, cur, auditNote("Loop done — review passed, awaiting human diff review", new Date(), actor))
            await moveTask(deps.$, cur, (action.toStatus ?? "in-review") as TaskStatus)
            await commitBacklog(deps, config, state, `loop(${state.task.id}): done — parked in in-review`)
            moved = true
          } catch (err) {
            await deps.log("warn", `loop done but task move failed: ${(err as Error).message}`)
          }
        } else {
          await deps.log("warn", `loop done but task ${state.task.id} not in in-progress/ — not moved`)
        }
      }
      await renderMetrics(deps, sessionID, config, state, "done", "review passed")
      await checkpoint(deps, state, `loop(${loopId(state)}): done — review passed`)
      await teardownIsolation(deps, state)
      if (state.task) await clearState(deps.$, deps.directory, config.tasksDir, state.task.id)
      clearLoop(sessionID)
      const where = state.git ? ` on branch ${state.git.branch}` : ""
      const next = state.task
        ? ` Review the diff${where}, then /agent-loop approve when it ships.`
        : where
          ? ` Review the diff${where}.`
          : ""
      if (state.task && !moved) {
        await toast(
          client,
          `Loop finished "${state.task.id}" but couldn't park it in in-review/ — it's still in in-progress/. Check the audit note.`,
          "warning",
        )
      } else {
        await toast(client, `${action.message}${next}`, "success")
      }
      return { kind: "done", message: action.message }
    }
    case "stop": {
      // Per design: a failed/stopped task stays in-progress, annotated for a human.
      if (state.task) {
        await appendNote(deps.$, state.task, auditNote(action.message, new Date(), actor))
        await commitBacklog(deps, config, state, `loop(${state.task.id}): stopped — ${action.message}`)
      }
      await renderMetrics(deps, sessionID, config, state, "stopped", action.message)
      await checkpoint(deps, state, `loop(${loopId(state)}): incomplete — ${action.message}`)
      await teardownIsolation(deps, state)
      if (state.task) await clearState(deps.$, deps.directory, config.tasksDir, state.task.id)
      clearLoop(sessionID)
      const where = state.git ? ` Partial work is preserved on branch ${state.git.branch}.` : ""
      await toast(client, `${action.message}${where}`, "warning")
      return { kind: "stop", message: action.message }
    }
    case "noop":
      return null
  }
}

export { claimSkipReason } from "@agentic-loop/core/source/backlog"
export type { ClaimSkipReason } from "@agentic-loop/core/source/types"

/**
 * A `/agent-loop watch` session's own idle check, over two pools in order:
 * first a claimable task in `in-progress/` (plan approved, never started) is
 * driven straight through BUILD → VERIFY → REVIEW — build work beats plan
 * work, so in-flight tasks finish before new ones spin up. Otherwise a
 * `queued/` task (approved, planless) is claimed for the PLAN stage, which
 * writes its plan and parks it in `plan-review/` for the human gate.
 * FAIL-driven re-builds happen inline in this same session, exactly like a
 * normal loop's iteration cap. Never silent: when nothing is claimed, the
 * reason is always logged, and toasted when actionable (deduped until the
 * reason changes).
 */
const tryClaim = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  const { claim, skips } = await pollOnce(sourcesFor(deps, config, sessionID))
  if (!claim) {
    const reason = combineSkips(skips)
    if (!reason) return
    await deps.log(reason.actionable ? "warn" : "info", reason.message)
    if (reason.actionable && lastSkipReason.get(sessionID) !== reason.message) {
      lastSkipReason.set(sessionID, reason.message)
      await toast(deps.client, reason.message, "warning")
    }
    return
  }
  lastSkipReason.delete(sessionID)
  const { item } = claim
  await toast(deps.client, item.claimMessage, "info")
  try {
    const outcome = await drive(deps, sessionID, config, firstStep(manifestFor(item.loopKind), item.state))
    if (outcome && claim.source.onTerminal) await claim.source.onTerminal(item, outcome)
  } catch (err) {
    // Died before real work started (e.g. ensureIsolation threw, before
    // setLoop ran — onIdle's catch can't see the task): the claim is ours, so
    // release it or watch stays wedged. The source knows what "real work"
    // means per pool (a BUILD-started note keeps the marker for recovery).
    await claim.source.release(item)
    throw err
  }
}

/** Which status folder a task id currently lives in, or null. For error messages. */
const findAnyStatus = async (deps: Deps, config: Config, id: string): Promise<TaskStatus | null> => {
  for (const status of STATUSES) {
    if (await findByIdIn(deps.$, deps.directory, config.tasksDir, status, id)) return status
  }
  return null
}

/** Load every status folder and roll it up. One list call per folder. */
const backlogSummary = async (deps: Deps, config: Config) => {
  const byStatus = {} as Record<TaskStatus, Task[]>
  for (const status of STATUSES) {
    byStatus[status] = await listByStatus(deps.client, deps.directory, config.tasksDir, status, deps.log)
  }
  const claimedIds = await listClaimIds(deps.$, deps.directory, config.tasksDir)
  return summarizeBacklog(byStatus, claimedIds)
}

/** Human-readable one-liner of the backlog roll-up. Pure. */
const formatBacklog = (s: Awaited<ReturnType<typeof backlogSummary>>): string => {
  const c = s.counts
  const gate = c["plan-review"] > 0 ? `${c["plan-review"]} plan-review (awaiting approve-plan)` : "0 plan-review"
  const held = s.claimHeld.length ? `, ${s.claimHeld.length} claim-held` : ""
  const progress =
    c["in-progress"] > 0
      ? `${c["in-progress"]} in-progress (${s.claimable.length} ready${held}, ${s.interrupted.length} interrupted)`
      : "0 in-progress"
  return `backlog: ${c.draft} draft · ${c.queued} queued · ${gate} · ${progress} · ${c["in-review"]} in-review · ${c.completed} completed · ${c.abandoned} abandoned`
}

/**
 * The shared "stop watching" cleanup: drop the session from `watching`, kill its
 * poll timer, forget its last skip reason, and release the clone's watch lease
 * (only if it was actually watching — a double release would corrupt the shared
 * per-directory refcount). Returns whether the session was watching. Every mutation
 * except the lease release is synchronous, so callers racing an idle event win.
 */
const stopWatching = async (deps: Deps, sessionID: string): Promise<boolean> => {
  const was = watching.delete(sessionID)
  stopWatchTimer(sessionID)
  lastSkipReason.delete(sessionID)
  if (was) await releaseWatchLease(deps)
  return was
}

/**
 * A user interrupt (ESC) mid-drive, routed from the plugin's event hook when a
 * `MessageAbortedError` lands on this session. Stops watching (no re-trigger on the
 * trailing idle) AND halts the current loop after the in-flight stage settles: the
 * `interrupted` flag trips drive's stop guard, and dropping `pending` cancels any
 * deferred one-shot work. Mutations are synchronous before the first `await` so a
 * racing `session.idle` sees the cleared `watching`. Idempotent — a double dispatch
 * (session.error + message.updated for one ESC) is a harmless no-op.
 */
export const onInterrupt = async (deps: Deps, sessionID: string): Promise<void> => {
  const state = getLoop(sessionID) // still set on the interrupt (the flag path keeps it)
  const hadLoop = state !== undefined
  const priorPending = pending.get(sessionID)
  pending.delete(sessionID) // synchronous — beat the racing idle; marker released below
  // Only flag when a loop is actually driving — otherwise the flag would linger
  // (no drive to consume it in onIdle's finally) and wrongly halt this session's
  // NEXT loop. A running stage always has getLoop set (drive's setLoop), so the
  // interruptable moment is covered.
  if (hadLoop) interrupted.add(sessionID)
  await releasePendingMarker(deps, priorPending) // dropped one-shot work must not leave a held claim
  const wasWatching = await stopWatching(deps, sessionID)
  // The interrupt keeps the snapshot, so recover resumes at the interrupted stage —
  // point the user straight at it.
  if (hadLoop) {
    const id = state?.task?.id
    const msg = id ? `Loop interrupted — run /agent-loop recover ${id} to resume.` : "Loop interrupted."
    await toast(deps.client, msg, "info")
  } else if (wasWatching) {
    await toast(deps.client, "Stopped watching — interrupted.", "info")
  }
}

/**
 * The watched session a user-interrupt event names, or undefined. A user ESC
 * surfaces only as a `MessageAbortedError` — on `message.updated` (assistant
 * message; `info.sessionID` always present, the primary signal) or `session.error`
 * (usable only when its optional `sessionID` is present). Everything else, including
 * `session.idle`, returns undefined so the normal flow is untouched. Pure.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const abortedSessionID = (event: any): string | undefined => {
  if (event?.type === "message.updated") {
    const info = event.properties?.info
    if (info?.error?.name === "MessageAbortedError") return info.sessionID
  }
  if (event?.type === "session.error") {
    const p = event.properties
    if (p?.error?.name === "MessageAbortedError" && p.sessionID) return p.sessionID
  }
  return undefined
}

/**
 * Consume any pending loop work for a session that just went idle. Guarded so the
 * idle events the driver's own commands generate do not re-enter it.
 */
export const onIdle = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  if (driving.has(sessionID)) return
  const work = pending.get(sessionID)
  // Nothing to do unless there's real pending work, or this is an idle
  // watch session with no loop of its own currently running.
  const shouldWatch = watching.has(sessionID) && !getLoop(sessionID)
  if (!work && !shouldWatch) return
  // Serialize drives per working tree ONLY in shared-tree mode — there, two
  // loops would switch branches out from under each other. In worktree mode
  // each drive owns its own checkout, so concurrent drives are safe and the
  // lock is skipped (`ensureIsolation` throws rather than falling back to
  // shared-tree switching, so the main tree's HEAD is never touched).
  const serialize = !config.worktreesDir
  if (serialize && executingDirs.has(deps.directory)) return
  if (work) pending.delete(sessionID)
  driving.add(sessionID)
  if (serialize) executingDirs.add(deps.directory)
  try {
    if (work?.kind === "start-task" || work?.kind === "recover") {
      // `start-task`: a `/agent-loop task <id>` claim entering execution at build.
      // `recover`: a human-forced resume of a started-but-dead task with no
      // valid snapshot. Both re-enter the state machine at build with the
      // persisted plan.
      const ref = taskRef(work.task, work.task.path)
      const state = resumeAtBuild(taskGoal(work.task), ref, extractPlan(work.task) ?? "")
      await drive(deps, sessionID, config, firstStep(eng, state))
    } else if (work?.kind === "start-plan") {
      // A `/agent-loop task <id>` claim on a queued (planless) task: run the PLAN
      // stage, which writes the plan and parks the task in plan-review/.
      const state = startAtPlan(work.goal, taskRef(work.task, work.task.path), extractPlan(work.task))
      await drive(deps, sessionID, config, firstStep(eng, state))
    } else if (work?.kind === "recover-state") {
      // A snapshot-based resume: re-enter at the exact stage the crash caught,
      // with artifacts intact, re-firing that stage from its own inputs.
      await drive(deps, sessionID, config, firstStep(eng, work.state))
    } else {
      // No pending work — a watch session with nothing to resume; look for
      // one claimable task in the backlog.
      await tryClaim(deps, sessionID, config)
    }
  } catch (err) {
    const message = (err as Error).message
    const state = getLoop(sessionID)
    if (state?.task) {
      await appendNote(
        deps.$,
        state.task,
        auditNote(`Loop error: ${message}`, new Date(), await gitActor(deps.$, deps.directory)),
      )
    }
    // A claim that died before its first "> BUILD started" note leaves the
    // task body claimable but the marker held — release it so no watcher is
    // wedged on it forever. (For `recover`, the body already carries BUILD
    // notes, so `isClaimable` is false and this is a no-op.)
    if (work?.kind === "start-task" || work?.kind === "recover") {
      const fresh = await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-progress", work.task.id)
      if (fresh && isClaimable(fresh)) await releaseClaim(deps.$, work.task)
    }
    // A PLAN claim that died leaves the task in queued/ with the marker held.
    if (work?.kind === "start-plan") {
      const fresh = await findByIdIn(deps.$, deps.directory, config.tasksDir, "queued", work.task.id)
      if (fresh) await releaseClaim(deps.$, work.task)
    }
    // Preserve whatever the failed run left behind and put the tree back.
    if (state) {
      await renderMetrics(deps, sessionID, config, state, "error", message)
      if (state.task) await commitBacklog(deps, config, state, `loop(${state.task.id}): loop error — ${message}`)
      await checkpoint(deps, state, `loop(${loopId(state)}): incomplete — loop error`)
      await teardownIsolation(deps, state)
    } else {
      runSamples.delete(sessionID)
    }
    clearLoop(sessionID)
    await toast(deps.client, `Loop error: ${message}`, "error")
  } finally {
    driving.delete(sessionID)
    interrupted.delete(sessionID) // consumed by this drive; a fresh drive re-arms via onInterrupt
    if (serialize) executingDirs.delete(deps.directory)
  }
}

// --- /agent-loop command handling (parses the mode; deferred work runs on next idle) ---

const TASK_PREFIX = "task "

/** Human-readable rendering of a polling cadence in ms. Pure. */
const formatInterval = (ms: number): string =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`

/** Minimum watch polling cadence — anything tighter just burns idle queries. */
const MIN_WATCH_INTERVAL_MS = 10_000

/**
 * Parse the interval spec of `/agent-loop watch [interval]`. Accepts `""` (use the
 * config default), `30s`, `5m`, `2h`, a bare number (minutes), and an
 * optional `--interval ` prefix. Clamped to at least 10 seconds. Pure.
 */
export const parseWatchArgs = (spec: string): { intervalMs?: number } | { error: string } => {
  const s = spec.trim().replace(/^--interval\s+/i, "")
  if (!s) return {}
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/i.exec(s)
  if (!m || Number(m[1]) <= 0) {
    return { error: `Unrecognized watch interval "${spec.trim()}" — use e.g. 30s, 5m, 2h, or a bare number of minutes.` }
  }
  const value = Number(m[1])
  const unit = (m[2] ?? "").toLowerCase() || "m"
  const ms = value * (unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000)
  return { intervalMs: Math.max(ms, MIN_WATCH_INTERVAL_MS) }
}

/** Clear one session's watch polling timer, if any. */
const stopWatchTimer = (sessionID: string): void => {
  const timer = watchTimers.get(sessionID)
  if (timer) clearInterval(timer)
  watchTimers.delete(sessionID)
  watchIntervalsMs.delete(sessionID)
}

/** Clear every watch timer and drop held leases — called from the plugin's dispose hook. */
export const disposeWatch = (): void => {
  for (const timer of watchTimers.values()) clearInterval(timer)
  watchTimers.clear()
  watchIntervalsMs.clear()
  for (const [dir, entry] of watchLeases) {
    watchLeases.delete(dir)
    void releaseLease(entry.deps.$, dir, entry.tasksDir)
  }
}

/**
 * One watch-timer tick: claim work only when this session is genuinely quiet.
 * The `session.idle` event path stays the fast trigger; the timer exists for
 * the case that path misses — a task approved (by `/agent-loop-task` in
 * another session) while this session sat idle generating no new events.
 * Idleness is queried, not tracked: absent from the status map counts as idle.
 * Never throws — an unhandled rejection inside a timer would crash the host.
 */
const watchTick = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  try {
    if (!watching.has(sessionID)) return
    // Prove liveness every tick, busy or idle — a watcher driving a long BUILD
    // must not read as dead to a would-be takeover.
    const entry = watchLeases.get(deps.directory)
    if (entry) await heartbeatLease(deps.$, deps.directory, entry.tasksDir, leaseOwner(entry.intervalMs), new Date())
    if (driving.has(sessionID) || getLoop(sessionID)) return
    const res = await deps.client.session.status().catch(() => null)
    const status = res?.data?.[sessionID]
    if (status && status.type !== "idle") return
    await onIdle(deps, sessionID, config)
  } catch (err) {
    await deps.log("warn", `loop: watch tick failed: ${(err as Error).message}`)
  }
}

/** Parsed `/agent-loop-task` arguments: which subcommand needs plugin work, if any. */
export type TaskCmdArgs = { mode: "approve" | "approve-plan" | "replan"; id: string; reason?: string } | { mode: "passthrough" }

/**
 * Classify `/agent-loop-task` arguments. `approve <id>`, `approve-plan <id>`,
 * and `replan <id> [reason]` are fully deterministic plugin work; everything
 * else (including `new <idea>` and `retask <id> [note]`) passes through
 * untouched — those two are agent-authored (interview + draft write), not
 * plugin moves. `approve-plan` is matched before `approve` (prefix collision).
 * An empty id is preserved so the caller can toast a usage hint.
 */
export const parseTaskArgs = (args: string): TaskCmdArgs => {
  const arg = args.trim()
  const lower = arg.toLowerCase()
  for (const mode of ["approve-plan", "approve", "replan"] as const) {
    if (lower === mode || lower.startsWith(`${mode} `)) {
      const rest = arg.slice(mode.length).trim()
      if (mode === "replan") {
        const [id = "", ...reasonParts] = rest.split(/\s+/)
        const reason = reasonParts.join(" ")
        return { mode, id, ...(reason ? { reason } : {}) }
      }
      return { mode, id: rest }
    }
  }
  return { mode: "passthrough" }
}

// --- Shared human-gate transitions -----------------------------------------
// The happy-path move for each gate, factored out so the explicit verbs
// (`/agent-loop-task approve|approve-plan|replan`, `/agent-loop ship`) and the
// folder-driven shortcuts (`/agent-loop approve`, `/agent-loop reject`) share one implementation.
// Each assumes the task has already been located in its source folder; callers
// own the not-found / wrong-folder messaging and the try/catch error toast.

/** approve: draft/ → queued/ (audited note + commit). */
const doApprove = async (deps: Deps, config: Config, task: Task): Promise<void> => {
  const actor = await gitActor(deps.$, deps.directory)
  await appendNote(deps.$, task, auditNote("Task approved — queued for planning", new Date(), actor))
  await moveTask(deps.$, task, "queued")
  await commitTasks(deps, config, `loop(${task.id}): task approved — queued for planning`)
  await toast(
    deps.client,
    `Task approved — "${task.title}" queued in ${config.tasksDir}/queued/. /agent-loop watch (or /agent-loop task ${task.id}) will plan it.`,
    "success",
  )
}

/** approve-plan: plan-review/ → in-progress/. Caller must have checked `hasPlan`. */
const doApprovePlan = async (deps: Deps, config: Config, task: Task): Promise<void> => {
  const actor = await gitActor(deps.$, deps.directory)
  await appendNote(deps.$, task, auditNote("Plan approved — parked for execution", new Date(), actor))
  await moveTask(deps.$, task, "in-progress")
  await commitTasks(deps, config, `loop(${task.id}): plan approved — parked for execution`)
  await toast(
    deps.client,
    `Plan approved — "${task.title}" parked in ${config.tasksDir}/in-progress/. /agent-loop watch (or /agent-loop task ${task.id}) will build it.`,
    "success",
  )
}

/** ship: in-review/ → completed/. */
const doShip = async (deps: Deps, config: Config, task: Task): Promise<void> => {
  await appendNote(deps.$, task, auditNote("Shipped — moved to completed", new Date(), await gitActor(deps.$, deps.directory)))
  await moveTask(deps.$, task, "completed")
  await commitTasks(deps, config, `loop(${task.id}): shipped — completed`)
  await toast(deps.client, `"${task.title}" completed.`, "success")
}

/** replan: plan-review/ or in-progress/ → queued/, with an optional reason. */
const doReplan = async (deps: Deps, config: Config, task: Task, reason?: string): Promise<void> => {
  const actor = await gitActor(deps.$, deps.directory)
  const why = reason ? ` — ${reason}` : ""
  await appendNote(deps.$, task, auditNote(`Plan rejected — sent back to queued for re-planning${why}`, new Date(), actor))
  await moveTask(deps.$, task, "queued")
  await commitTasks(deps, config, `loop(${task.id}): plan rejected — re-queued for planning`)
  await toast(
    deps.client,
    `"${task.title}" sent back to ${config.tasksDir}/queued/ — the next PLAN pass will address the rejection.`,
    "success",
  )
}

/** Outcome of resolving which task a folder-driven gate shortcut should act on. */
type GatePick =
  | { readonly ok: true; readonly task: Task; readonly from: TaskStatus }
  | { readonly ok: false; readonly kind: "none" }
  | { readonly ok: false; readonly kind: "message"; readonly message: string; readonly variant: "info" | "warning" }

/**
 * Resolve the single task a shortcut (`/agent-loop approve`, `/agent-loop reject`) should act on,
 * searching `folders` in priority order.
 *
 * - With `id`: the task must be in one of `folders`; otherwise a precise message
 *   ("already in X" for a forward status, "no task found" otherwise).
 * - Without `id`: exactly one candidate across all `folders` advances; zero →
 *   `none` (caller supplies the wording); two+ → an ambiguity message asking for
 *   an explicit id. Fail-safe — never guesses when ambiguous.
 */
const resolveGateTask = async (deps: Deps, config: Config, id: string, folders: readonly TaskStatus[]): Promise<GatePick> => {
  if (id) {
    for (const from of folders) {
      const task = await findByIdIn(deps.$, deps.directory, config.tasksDir, from, id)
      if (task) return { ok: true, task, from }
    }
    const elsewhere = await findAnyStatus(deps, config, id)
    // A forward status means the move already happened — report it as harmless, not an error.
    const alreadyForward = elsewhere === "queued" || elsewhere === "in-progress" || elsewhere === "completed"
    return {
      ok: false,
      kind: "message",
      message: elsewhere ? `"${id}" is in ${elsewhere} — nothing to do.` : `No task "${id}" found.`,
      variant: alreadyForward ? "info" : "warning",
    }
  }
  const found: { task: Task; from: TaskStatus }[] = []
  for (const from of folders) {
    for (const task of await listByStatus(deps.client, deps.directory, config.tasksDir, from, deps.log)) found.push({ task, from })
  }
  if (found.length === 0) return { ok: false, kind: "none" }
  if (found.length === 1) return { ok: true, ...found[0]! }
  const list = found.map((f) => `${f.task.id} (${f.from})`).join(", ")
  return { ok: false, kind: "message", message: `Multiple tasks awaiting: ${list} — pass an id, e.g. /agent-loop approve ${found[0]!.task.id}.`, variant: "warning" }
}

/**
 * Handle a `/agent-loop-task ...` command. Three subcommands are deterministic
 * plugin work (the agent writes nothing); `new <idea>` and `retask <id>` pass
 * through untouched — their authoring (interview, draft write / rewrite) is the
 * agent's job, see `.opencode/commands/agent-loop-task.md`:
 *
 * - `approve <id>` — the task gate: park a reviewed `draft/` task in
 *   `queued/`. No plan is required (or expected) — planning happens inside
 *   the loop's PLAN stage, right before execution.
 * - `approve-plan <id>` — the plan gate: validate the `plan-review/` task has
 *   an `## Implementation Plan` and park it in `in-progress/`, the
 *   build-ready queue.
 * - `replan <id> [reason]` — reject a parked plan, or send a cap-tripped
 *   `in-progress/` task back: moves it to `queued/` with an audited note so
 *   the next PLAN pass addresses why the old plan failed.
 */
export const handleTaskCommand = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  const parsed = parseTaskArgs(args)
  if (parsed.mode === "passthrough") return
  const { id } = parsed
  if (!id) return void (await toast(client, `Usage: /agent-loop-task ${parsed.mode} <id>.`, "warning"))

  if (parsed.mode === "approve") {
    const draft = await findByIdIn(deps.$, deps.directory, config.tasksDir, "draft", id)
    if (!draft) {
      const elsewhere = await findAnyStatus(deps, config, id)
      // A retry (model re-calling after a prior success, or a race with a
      // concurrent gate) lands here with the task already queued — report
      // success instead of an error so retries stay harmless.
      if (elsewhere === "queued") {
        return void (
          await toast(client, `Task "${id}" is already queued in ${config.tasksDir}/queued/ — nothing to do.`, "info")
        )
      }
      const detail = elsewhere ? `it's in ${elsewhere} — only draft tasks can be approved` : `no task "${id}" found`
      return void (await toast(client, `Can't approve "${id}": ${detail}.`, "warning"))
    }
    try {
      await doApprove(deps, config, draft)
    } catch (err) {
      await toast(client, `Approve failed for "${id}": ${(err as Error).message}`, "error")
    }
    return
  }

  if (parsed.mode === "approve-plan") {
    const task = await findByIdIn(deps.$, deps.directory, config.tasksDir, "plan-review", id)
    if (!task) {
      const elsewhere = await findAnyStatus(deps, config, id)
      if (elsewhere === "in-progress") {
        return void (
          await toast(
            client,
            `Plan for "${id}" is already approved — parked in ${config.tasksDir}/in-progress/. Nothing to do.`,
            "info",
          )
        )
      }
      const detail =
        elsewhere === "queued"
          ? `it's still queued — the loop hasn't planned it yet (/agent-loop task ${id} plans it now)`
          : elsewhere === "draft"
            ? `it's still a draft — approve the task first with /agent-loop-task approve ${id}`
            : elsewhere
              ? `it's in ${elsewhere} — only plan-review tasks can be plan-approved`
              : `no task "${id}" found`
      return void (await toast(client, `Can't approve the plan for "${id}": ${detail}.`, "warning"))
    }
    if (!hasPlan(task)) {
      return void (
        await toast(client, `Task "${id}" has no Implementation Plan — send it back with /agent-loop-task replan ${id}.`, "warning")
      )
    }
    try {
      await doApprovePlan(deps, config, task)
    } catch (err) {
      await toast(client, `Approve-plan failed for "${id}": ${(err as Error).message}`, "error")
    }
    return
  }

  // replan — from plan-review/ (rejected plan) or in-progress/ (cap-tripped / bad plan).
  const task =
    (await findByIdIn(deps.$, deps.directory, config.tasksDir, "plan-review", id)) ??
    (await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-progress", id))
  if (!task) {
    const elsewhere = await findAnyStatus(deps, config, id)
    if (elsewhere === "queued") {
      return void (
        await toast(client, `"${id}" is already queued in ${config.tasksDir}/queued/ — nothing to do.`, "info")
      )
    }
    const detail = elsewhere
      ? `it's in ${elsewhere} — only plan-review or in-progress tasks can be sent back to planning`
      : `no task "${id}" found`
    return void (await toast(client, `Can't replan "${id}": ${detail}.`, "warning"))
  }
  if (findSessionDriving(id)) {
    return void (await toast(client, `Task "${id}" is being driven by a live loop — /agent-loop stop it first.`, "warning"))
  }
  try {
    await doReplan(deps, config, task, parsed.reason)
  } catch (err) {
    await toast(client, `Replan failed for "${id}": ${(err as Error).message}`, "error")
  }
}

/**
 * Handle `/agent-loop approve [id]` — the folder-driven approval shortcut. Advances the one
 * task awaiting a human gate: `draft/` → queued, `plan-review/` → in-progress
 * (plan required), `in-review/` → completed (ship). The id is optional and only
 * needed to disambiguate when more than one task awaits. All three explicit
 * verbs still exist under `/agent-loop-task` and `/agent-loop ship`.
 */
export const handleApprove = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  const id = args.trim()
  const pick = await resolveGateTask(deps, config, id, ["draft", "plan-review", "in-review"])
  if (!pick.ok) {
    if (pick.kind === "none") return void (await toast(client, "Nothing awaiting approval.", "info"))
    return void (await toast(client, pick.message, pick.variant))
  }
  const { task, from } = pick
  if (from === "plan-review" && !hasPlan(task)) {
    return void (await toast(client, `Task "${task.id}" has no Implementation Plan — send it back with /agent-loop reject ${task.id}.`, "warning"))
  }
  try {
    if (from === "draft") await doApprove(deps, config, task)
    else if (from === "plan-review") await doApprovePlan(deps, config, task)
    else await doShip(deps, config, task) // in-review
  } catch (err) {
    await toast(client, `Approve failed for "${task.id}": ${(err as Error).message}`, "error")
  }
}

/**
 * Handle `/agent-loop reject [id] [reason]` — the folder-driven rejection shortcut. Sends a
 * parked plan back to `queued/` for re-planning (today's `replan`). Auto-targets
 * the single `plan-review/` task; an explicit id may also name an `in-progress/`
 * (cap-tripped) task. When no leading token names a rejectable task, the whole
 * argument is treated as the reason and the single plan-review task is chosen.
 */
export const handleReject = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  const arg = args.trim()
  const [first = "", ...restParts] = arg.split(/\s+/)
  const folders = ["plan-review", "in-progress"] as const

  // Treat the leading token as an explicit id only if it names a rejectable task.
  let picked: { task: Task; reason: string } | null = null
  if (first) {
    for (const from of folders) {
      const t = await findByIdIn(deps.$, deps.directory, config.tasksDir, from, first)
      if (t) {
        picked = { task: t, reason: restParts.join(" ") }
        break
      }
    }
  }
  if (!picked) {
    // No explicit id — auto-resolve the single plan-review task; the whole arg is the reason.
    const pick = await resolveGateTask(deps, config, "", ["plan-review"])
    if (!pick.ok) {
      if (pick.kind === "none") return void (await toast(client, "No plan awaiting rejection.", "info"))
      return void (await toast(client, pick.message, pick.variant))
    }
    picked = { task: pick.task, reason: arg }
  }

  if (findSessionDriving(picked.task.id)) {
    return void (await toast(client, `Task "${picked.task.id}" is being driven by a live loop — /agent-loop stop it first.`, "warning"))
  }
  try {
    await doReplan(deps, config, picked.task, picked.reason || undefined)
  } catch (err) {
    await toast(client, `Replan failed for "${picked.task.id}": ${(err as Error).message}`, "error")
  }
}

/** Parse and handle a `/agent-loop ...` command. */
export const handleCommand = async (
  deps: Deps,
  sessionID: string,
  args: string,
  config: Config,
): Promise<void> => {
  const { client } = deps
  const arg = args.trim()
  const lower = arg.toLowerCase()

  // Folder-driven gate shortcuts, namespaced under /agent-loop (not top-level, so
  // `approve`/`reject` never claim a reserved command word). `go` is a legacy alias
  // for `approve`. handleApprove/handleReject parse the post-verb remainder.
  if (lower === "go" || lower === "approve" || lower.startsWith("approve ")) {
    return handleApprove(deps, sessionID, lower === "go" ? "" : arg.slice("approve".length).trim(), config)
  }
  if (lower === "reject" || lower.startsWith("reject ")) {
    return handleReject(deps, sessionID, arg.slice("reject".length).trim(), config)
  }

  if (lower === "next") {
    await toast(
      client,
      "/agent-loop next was removed — author and approve a task with /agent-loop-task, then /agent-loop task <id> or /agent-loop watch.",
      "warning",
    )
    return
  }

  if (lower === "stop" || lower === "abort") {
    const wasWatching = await stopWatching(deps, sessionID)
    await dropPending(deps, sessionID) // release any queued-but-undriven claim marker
    const state = getLoop(sessionID)
    if (state?.task) {
      await appendNote(
        deps.$,
        state.task,
        auditNote(
          `Loop stopped by /agent-loop stop — was at ${state.stage} (iteration ${state.iteration + 1}).`,
          new Date(),
          await gitActor(deps.$, deps.directory),
        ),
      )
    }
    const existed = clearLoop(sessionID)
    const message = existed ? "Loop stopped." : wasWatching ? "Stopped watching." : "No active loop to stop."
    await toast(client, message, "info")
    return
  }

  if (lower === "watch" || lower.startsWith("watch ")) {
    const parsed = parseWatchArgs(arg.slice("watch".length))
    if ("error" in parsed) return void (await toast(client, parsed.error, "warning"))
    const intervalMs = parsed.intervalMs ?? Math.max(config.watchIntervalMinutes * 60_000, MIN_WATCH_INTERVAL_MS)
    // Only one watcher process per clone: acquire the on-disk lease before
    // arming (a re-arm by an already-watching session keeps its share).
    if (!watching.has(sessionID)) {
      const lease = await acquireWatchLease(deps, config, intervalMs)
      if (!lease.ok) return void (await toast(client, lease.message, "warning"))
    }
    watching.add(sessionID)
    stopWatchTimer(sessionID) // replace any prior timer instead of stacking
    watchTimers.set(
      sessionID,
      setInterval(() => void watchTick(deps, sessionID, config), intervalMs),
    )
    watchIntervalsMs.set(sessionID, intervalMs)
    lastSkipReason.delete(sessionID) // a fresh arm re-toasts whatever reason comes next
    await toast(client, `Watching for approved tasks to build (polling every ${formatInterval(intervalMs)}).`, "info")
    // Immediate first pull — don't make the user wait for the next idle event
    // or timer tick. watchTick self-guards: it claims only when the session is
    // actually idle, and never throws.
    void watchTick(deps, sessionID, config)
    return
  }

  if (lower === "unwatch") {
    const was = await stopWatching(deps, sessionID)
    await toast(client, was ? "Stopped watching." : "Not watching.", "info")
    return
  }

  if (lower === "recover" || lower.startsWith("recover ")) {
    const id = arg.slice("recover".length).trim()
    if (!id) return void (await toast(client, "Usage: /agent-loop recover <id>.", "warning"))
    const task = await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-progress", id)
    if (!task) return void (await toast(client, `No in-progress task "${id}".`, "warning"))
    const driving = findSessionDriving(id)
    if (driving) {
      return void (await toast(client, `Task "${id}" is being driven by a live loop — nothing to recover.`, "warning"))
    }
    if (isClaimable(task)) {
      return void (await toast(client, `Task "${id}" was never started — /agent-loop watch will claim it.`, "info"))
    }
    if (!isRecoverable(task)) {
      return void (await toast(client, `Task "${id}" has no persisted plan — send it back with /agent-loop-task replan ${id}.`, "warning"))
    }
    await claimTask(deps.$, task) // re-mark; the marker may already exist from the dead run
    // Prefer an exact-stage resume from the state snapshot; fall back to
    // re-entering at BUILD from the persisted plan when there's no valid one.
    const snap = await loadState(client, deps.directory, config.tasksDir, id)
    const actor = await gitActor(deps.$, deps.directory)
    clearLoop(sessionID)
    if (snap && snap.task?.id === id) {
      // Refresh the task path from disk — the file may have moved since the snapshot.
      const state: LoopState = { ...snap, task: { ...snap.task, path: task.path } }
      await appendNote(
        deps.$,
        task,
        auditNote(`Recovered by /agent-loop recover — resuming from snapshot at ${snap.stage}.`, new Date(), actor),
      )
      await setPending(deps, sessionID, { kind: "recover-state", state })
      await toast(
        client,
        `Recovering "${task.title}" from snapshot at ${snap.stage} — check git status/diff for leftovers; resuming…`,
        "info",
      )
      return
    }
    await appendNote(
      deps.$,
      task,
      auditNote("Recovered by /agent-loop recover — resuming BUILD from the persisted plan.", new Date(), actor),
    )
    await setPending(deps, sessionID, { kind: "recover", task })
    await toast(
      client,
      `Recovering "${task.title}" — check git status/diff for leftovers from the interrupted run; building…`,
      "info",
    )
    return
  }

  if (lower === "ship" || lower.startsWith("ship ")) {
    const id = arg.slice("ship".length).trim()
    // No id → ship the single in-review/ task (id only needed to disambiguate).
    if (!id) {
      const pick = await resolveGateTask(deps, config, "", ["in-review"])
      if (!pick.ok) {
        if (pick.kind === "none") return void (await toast(client, "Nothing awaiting ship.", "info"))
        return void (await toast(client, pick.message, pick.variant))
      }
      try {
        await doShip(deps, config, pick.task)
      } catch (err) {
        await toast(client, `Ship failed for "${pick.task.id}": ${(err as Error).message}`, "error")
      }
      return
    }
    const task = await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-review", id)
    if (!task) {
      // Locate it for a precise error instead of a bare "not found".
      const elsewhere = await findAnyStatus(deps, config, id)
      if (elsewhere === "completed") {
        return void (await toast(client, `"${id}" is already completed. Nothing to do.`, "info"))
      }
      const detail = elsewhere ? `it's in ${elsewhere}, not in-review — the loop hasn't finished it` : `no task "${id}" found`
      return void (await toast(client, `Can't ship "${id}": ${detail}.`, "warning"))
    }
    try {
      await doShip(deps, config, task)
    } catch (err) {
      await toast(client, `Ship failed for "${id}": ${(err as Error).message}`, "error")
    }
    return
  }

  if (lower === "task" || lower.startsWith(TASK_PREFIX)) {
    const id = arg.slice("task".length).trim()
    if (!id) return void (await toast(client, "Usage: /agent-loop task <id>.", "warning"))
    const task = await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-progress", id)
    if (!task) {
      // Not build-ready — a queued task enters at the PLAN stage instead.
      const queued = await findByIdIn(deps.$, deps.directory, config.tasksDir, "queued", id)
      if (queued) {
        if (findSessionDriving(id)) {
          return void (await toast(client, `Task "${id}" is already being driven by a live loop.`, "warning"))
        }
        if (!(await claimTask(deps.$, queued))) {
          return void (await toast(client, `Task "${id}" was just claimed by another watcher.`, "warning"))
        }
        clearLoop(sessionID)
        await setPending(deps, sessionID, { kind: "start-plan", task: queued, goal: taskGoal(queued) })
        await toast(client, `Loop started on "${queued.title}" — planning… (it will park in plan-review/ for your gate)`, "info")
        return
      }
      const elsewhere = await findAnyStatus(deps, config, id)
      const detail =
        elsewhere === "plan-review"
          ? `its plan is parked for review — /agent-loop approve ${id} (or /agent-loop reject ${id} <why>)`
          : elsewhere === "draft"
            ? `it's a draft — approve it first with /agent-loop approve ${id}`
            : elsewhere
              ? `it's in ${elsewhere}`
              : `no task "${id}" found`
      return void (await toast(client, `Can't start "${id}": ${detail}.`, "warning"))
    }
    if (findSessionDriving(id)) {
      return void (await toast(client, `Task "${id}" is already being driven by a live loop.`, "warning"))
    }
    if (!isClaimable(task)) {
      const detail = isRecoverable(task)
        ? `was already started — resume it with /agent-loop recover ${id}`
        : `has no persisted plan — send it back to planning with /agent-loop-task replan ${id}`
      return void (await toast(client, `Task "${id}" ${detail}.`, "warning"))
    }
    if (!(await claimTask(deps.$, task))) {
      return void (await toast(client, `Task "${id}" was just claimed by another watcher.`, "warning"))
    }
    clearLoop(sessionID)
    await setPending(deps, sessionID, { kind: "start-task", task, goal: taskGoal(task) })
    await toast(client, `Loop started on "${task.title}" — building…`, "info")
    return
  }

  if (lower === "doctor" || lower.startsWith("doctor ")) {
    const fix = /(^|\s)(--)?fix(\s|$)/.test(lower.slice("doctor".length))
    try {
      const anomalies = await auditBacklog(client, deps.directory, config.tasksDir)
      const heldQueued = await listClaimIds(deps.$, deps.directory, config.tasksDir, "queued")
      const heldInProgress = await listClaimIds(deps.$, deps.directory, config.tasksDir, "in-progress")
      for (const line of formatAnomalies(anomalies, config.tasksDir)) await deps.log("warn", `doctor: ${line}`)
      if (heldQueued.length) await deps.log("info", `doctor: claim marker(s) held in queued/.claims: ${heldQueued.join(", ")}`)
      if (heldInProgress.length) await deps.log("info", `doctor: claim marker(s) held in in-progress/.claims: ${heldInProgress.join(", ")}`)
      const findings = formatAnomalies(anomalies, config.tasksDir).length + heldQueued.length + heldInProgress.length
      if (!fix) {
        await toast(
          client,
          findings
            ? `Backlog doctor: ${findings} finding(s) — see the log. /agent-loop doctor fix applies the unambiguous repairs.`
            : "Backlog doctor: clean.",
          findings ? "warning" : "success",
        )
        return
      }
      // Unambiguous repairs only: rescue strays to draft/, remove now-empty
      // stray folders, release stale orphaned claim markers. Duplicates are a
      // human call — never auto-resolved.
      const actor = await gitActor(deps.$, deps.directory)
      const rescued: string[] = []
      for (const stray of anomalies.strayFiles) {
        try {
          const { id, path: newPath } = await rescueStray(deps.$, deps.directory, config.tasksDir, stray)
          await appendNote(deps.$, { id, path: newPath }, auditNote(`Rescued from ${stray} — was outside every status folder`, new Date(), actor))
          rescued.push(stray)
        } catch (err) {
          await deps.log("warn", `doctor: could not rescue ${stray}: ${(err as Error).message}`)
        }
      }
      const removedDirs: string[] = []
      for (const dir of anomalies.unknownDirs) {
        const out = await deps.$`rmdir ${path.join(deps.directory, config.tasksDir, dir)}`.quiet().nothrow()
        if (out.exitCode === 0) removedDirs.push(dir)
      }
      const released: string[] = []
      for (const [status, ids] of [["queued", heldQueued], ["in-progress", heldInProgress]] as const) {
        if (!ids.length) continue
        const tasks = await listByStatus(client, deps.directory, config.tasksDir, status, deps.log)
        released.push(
          ...(await releaseOrphanedClaims(deps.$, tasks, ids, path.join(deps.directory, config.tasksDir, status), {
            isDriving: (id) => findSessionDriving(id) !== undefined,
            ...(status === "queued" ? { isOrphaned: isOrphanedPlanClaim } : {}),
          })),
        )
      }
      if (rescued.length) {
        await commitTasks(deps, config, `loop: doctor rescued ${rescued.length} stray task file(s) to draft/`)
      }
      const summary = [
        rescued.length ? `rescued ${rescued.length} stray file(s) to draft/` : "",
        removedDirs.length ? `removed ${removedDirs.length} stray folder(s)` : "",
        released.length ? `released ${released.length} stale claim marker(s)` : "",
        anomalies.duplicates.length ? `${anomalies.duplicates.length} duplicate id(s) left for you` : "",
      ].filter(Boolean)
      await toast(client, summary.length ? `Backlog doctor: ${summary.join(" · ")}.` : "Backlog doctor: nothing to repair.", "success")
    } catch (err) {
      await toast(client, `Backlog doctor failed: ${(err as Error).message}`, "error")
    }
    return
  }

  if (lower === "status" || lower === "") {
    const isWatching = watching.has(sessionID)
    const state = getLoop(sessionID)
    // Backlog roll-up accompanies the session-loop line — a whole-backlog view,
    // not just this session's loop. Detailed flag lists go to the log.
    const summary = await backlogSummary(deps, config).catch(() => null)
    if (summary) {
      if (summary.interrupted.length) {
        await deps.log("warn", `interrupted (run /agent-loop recover <id>): ${summary.interrupted.join(", ")}`)
      }
      if (summary.awaitingReview.length) {
        await deps.log("info", `awaiting diff review (run /agent-loop ship <id>): ${summary.awaitingReview.join(", ")}`)
      }
    }
    const backlogLine = summary ? ` · ${formatBacklog(summary)}` : ""
    const cadence = watchIntervalsMs.get(sessionID)
    const watchLabel = cadence ? `Watching (every ${formatInterval(cadence)})` : "Watching"
    if (!state) {
      // Prefer the remembered skip reason over a bare "no claimable task" —
      // it says WHY the watcher isn't picking anything up.
      const why = lastSkipReason.get(sessionID)
      const head = isWatching ? `${watchLabel} — ${why ?? "no claimable task right now."}` : "No active loop."
      await toast(client, `${head}${backlogLine}`, "info")
      return
    }
    const what = state.task ? `task ${state.task.id}` : state.goal
    const prefix = isWatching ? `${watchLabel}. ` : ""
    await toast(client, `${prefix}Loop: ${state.stage} · iteration ${state.iteration + 1} · ${what}${backlogLine}`, "info")
    return
  }

  // The loop is a pure executor — there is no free-text mode. Anything
  // unrecognized gets usage help instead of silently becoming a goal.
  await toast(
    client,
    `Unknown /agent-loop mode "${arg}". Usage: /agent-loop task <id> · approve [id] · reject [id] [reason] · watch [interval] · unwatch · recover <id> · ship [id] · doctor [fix] · stop · status. ` +
      "Author tasks with /agent-loop-task.",
    "warning",
  )
}
