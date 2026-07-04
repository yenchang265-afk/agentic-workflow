# 01 — Per-task git worktree isolation

## Context

Today `ensureBranch` (`src/loop/driver.ts:189`) checks out `loop/<id>` **in
the shared working tree**: a human working in the same checkout has branches
switched under them mid-drive, and `executingDirs` (`driver.ts:130`) must
serialize all drives in one opencode instance to one at a time. Separate
opencode processes sharing one clone aren't serialized at all — threat model
T3's explicit residual, with "run extra watchers in their own
clones/worktrees" as the manual workaround.

Fix: on claim, create a dedicated `git worktree` per task under a configured
directory, run BUILD/VERIFY/REVIEW against it, and remove it on completion
(branch kept). The human's checkout is never touched; concurrent drives in
one instance become safe.

## Key design decision: prompt-level pinning, not SDK session directories

Verified against `@opencode-ai/plugin` / `@opencode-ai/sdk` v1.17.11:

- `SessionCommandData` and `SessionCreateData` do accept
  `query: { directory?: string }` — but pointing a stage session at the
  worktree **boots a separate app instance rooted there**, which loads its
  own plugin set. A fresh worktree has no `node_modules`, so this plugin
  can't load there — **the `loop_verdict` tool would not exist in the stage
  session**, breaking the loop's only trusted verdict channel. Even if it
  loaded, it would be a different module instance with its own
  `recordedVerdicts` map, invisible to the driving instance, plus version
  skew (the worktree has the base branch's plugin code).
- There is no per-command cwd override for an existing session;
  `experimental_workspace` is an adapter-registration hook, not "run this
  session over there".

So: stages keep running in the one instance where the plugin lives, and the
worktree is threaded in as **prompt-level pinning** (`composeArgs`) plus
allowlist extensions for the check stages. Pinning is prompt-enforced for
BUILD (which has broad bash/edit access) — same trust class as today's
"BUILD is trusted after human plan approval" posture; §10 adds a cheap
enforcement guard for edit-tool paths.

Worktree mode is **opt-in** (config knob unset → exactly today's behavior):
a fresh worktree lacks installed deps, so without a project-specific setup
command VERIFY's `npm test` would ERROR on most JS projects. Default-off
also keeps all 85 existing tests meaningful unchanged.

## 1. Config — `src/config.ts` + `Config` in `src/loop/state.ts:74`

```ts
// ConfigSchema additions
/** Repo-relative (or absolute) directory for per-task worktrees. Unset → current shared-tree branch switching. */
worktreesDir: z.string().min(1).optional(),
/** Optional shell command run inside a fresh worktree after creation (e.g. "npm ci"). */
worktreeSetup: z.string().min(1).optional(),
```

Mirror both (optional) on the `Config` interface in `state.ts`. Suggested
README value: `".loop-worktrees"`.

## 2. State — `src/loop/state.ts`

- `GitRef` (line 44) gains `readonly worktree?: string` (absolute path).
  Absent ⇒ shared-tree mode; present ⇒ worktree mode.
- `composeArgs` (line 122): when `state.git?.worktree` is set, for
  `build`/`verify`/`review` push a pinning block:

  ```
  Worktree: this loop's isolated checkout is <abs path> — every file you read,
  edit, or test lives THERE, not in the repo root. Use absolute paths under it
  for edit/read; prefix every shell command with `cd <abs path> && ` (or use
  `git -C <abs path> …`). Never modify anything outside it.
  ```

- The review `Diff boundary` line (line 147) becomes, in worktree mode:
  `` review exactly `git -C <worktree> diff <base>...<branch>` `` (branch
  refs are shared across worktrees, but keep the agent pinned to one place).

## 3. Git helpers — `src/loop/git.ts`

All `($, cwd, …)`, best-effort, same conventions as the existing helpers:

```ts
export const branchExists = ($: Shell, cwd: string, branch: string): Promise<boolean>
// git -C cwd rev-parse --verify --quiet refs/heads/<branch>

export const addWorktree = ($: Shell, cwd: string, wtPath: string, branch: string, base?: string): Promise<boolean>
// branchExists ? `worktree add <wtPath> <branch>` : `worktree add -b <branch> <wtPath> <base ?? HEAD>`
// (existing branch reused, never reset — same contract as checkoutBranch)

export const removeWorktree = ($: Shell, cwd: string, wtPath: string): Promise<boolean>
// `worktree remove <wtPath>` — deliberately NO --force: a dirty worktree
// (failed checkpoint) must survive for inspection. Branch always survives.

export const pruneWorktrees = ($: Shell, cwd: string): Promise<void>
// `worktree prune` — only clears registrations whose dirs vanished; safe.

export const worktreeForBranch = ($: Shell, cwd: string, branch: string): Promise<string | null>
// parse `worktree list --porcelain` for `branch refs/heads/<branch>` → its `worktree <path>`

export const ensureExcluded = ($: Shell, cwd: string, rel: string): Promise<void>
// idempotently append `/<rel>/` to <gitdir>/info/exclude (via `git -C cwd
// rev-parse --git-common-dir`) — keeps the nested worktrees dir out of the
// human's `git status` without mutating the tracked .gitignore
```

## 4. Driver lifecycle — `src/loop/driver.ts`

Replace `ensureBranch` with `ensureIsolation(deps, config, state)`:

1. **`state.git` already set:**
   - Worktree mode: if `state.git.worktree` dir vanished (crash/manual rm),
     `pruneWorktrees` + `addWorktree` again (branch exists → reused); else
     no-op. **Never re-checkout the shared tree in worktree mode.**
   - Shared mode: current re-checkout logic unchanged.
2. **Fresh isolation** with `config.worktreesDir` set, `isGitRepo`, and a
   resolvable `currentBranch`:
   - `base = currentBranch(main)`; `branch = loop/<id>`;
     `wtPath = path.resolve(deps.directory, config.worktreesDir, loopId(state))`.
   - `ensureExcluded(main, worktreesDir)`.
   - Reuse: `worktreeForBranch(main, branch)` → if registered (recovered
     run), adopt that path (log if ≠ expected). Else if `wtPath` exists on
     disk but unregistered → `pruneWorktrees`, retry; still failing →
     **throw** (see below).
   - `addWorktree(main, wtPath, branch, base)`; on failure **throw a loop
     error** — never fall back to shared-tree branch switching. In worktree
     mode the drive may run concurrently with another; silently checking out
     branches in the shared tree would reintroduce exactly the race
     worktrees remove. (`onIdle`'s catch at `driver.ts:543` annotates the
     task and toasts; the human fixes and runs `/loop recover`.)
   - If `config.worktreeSetup`: run it via the Bun shell's `.cwd(wtPath)`
     (verified in `plugin/dist/shell.d.ts:25`); warn-and-continue on failure
     (BUILD can self-recover; VERIFY will ERROR loudly if not).
   - Log (not block) when the main tree `isDirty` — uncommitted human
     changes are *not* visible in the worktree (a behavior change from
     today, usually an improvement).
   - Return `{ ...state, git: { base, branch, worktree: wtPath } }`.
3. `worktreesDir` unset → existing `ensureBranch` body verbatim.

Retarget the two write points:

- `checkpoint` (line 220):
  `commitAll(deps.$, state.git?.worktree ?? deps.directory, message)`.
- `restoreBase` → rename **`teardownIsolation`**:
  - Worktree mode: if `!isDirty(worktree)` → `removeWorktree` (branch kept,
    matching the done-toast "review the diff on branch …"); if dirty or
    removal fails → warn and leave in place for inspection. The main tree's
    HEAD was never touched; nothing to restore.
  - Shared mode: current checkout-base behavior.
  - Call sites keep their shape: stop-during-stage (`driver.ts:304-308`),
    `done` (line 368-369), `stop` (line 383-384), `onIdle` catch (line
    554-557) — all already do `checkpoint(...)` then `restoreBase(...)`,
    the right order for worktrees too.

## 5. Backlog stays canonical in the MAIN tree

Traced every mutation path — all already resolve into the main tree, so no
cwd changes needed, only awareness:

- `task.path` is always absolute-into-main-tree: `listByStatus` uses
  `node.absolute` from `client.file.list({directory: deps.directory})`;
  `findByIdIn` uses `path.join(directory, rel)` (`store.ts:129`). Hence
  `appendNote`, `appendPlan`, `moveTask`, `claimTask`, `releaseClaim` (all
  keyed off `task.path`) hit the main tree even while stages run in the
  worktree. ✔
- `appendRunLog(deps.$, deps.directory, …)` (`driver.ts:294`) → main tree. ✔
- `commitPaths(deps.$, deps.directory, [config.tasksDir], …)` (plan gate
  line 349, park line 453) → main tree, planning phase, before any worktree
  exists. ✔
- **The one real gap:** today execution-phase audit notes (BUILD
  started/finished, verdicts, done/stop notes) get swept into loop-branch
  checkpoints because the shared tree sits on the loop branch. In worktree
  mode `commitAll` runs in the worktree, so those main-tree notes would sit
  **uncommitted on the human's branch**. Fix: in worktree mode, after the
  `done`/`stop`/error-path `appendNote` + `moveTask`, add
  `commitPaths(deps.$, deps.directory, [config.tasksDir], "loop(<id>): <event>")`
  — small pathspec-scoped commits on the human's current branch (same
  precedent as the existing approval commits; `commitPaths` commits only the
  listed paths). Once per terminal event, not per note. Document this
  behavior change in README + threat model T4.
- The worktree contains its own stale copy of `docs/tasks` (as of base);
  stage agents never mutate tasks (the driver owns that). Add one line to
  `.opencode/agents/build.md` hard rules: "never edit the task backlog
  files".

## 6. Concurrency

- Per-sessionID structures verified safe as-is: `pending`, `driving`,
  `watching`, `recordedVerdicts`, and the `state.ts` store are all keyed by
  sessionID; cross-task races are closed by `claimTask`'s atomic `mkdir` and
  unique `loop/<id>` branches/worktree paths.
- `executingDirs` (`driver.ts:130`): change the `onIdle` gate (line 498) to
  **skip the lock entirely when `config.worktreesDir` is set** — each drive
  owns its own tree; nothing switches branches under anyone. Keep it
  verbatim for shared mode. Sound because `ensureIsolation` now throws
  instead of falling back to shared-tree switching.
- Residual: two concurrent `commitPaths` into the main tree can collide on
  `index.lock` — best-effort (returns false), matching the codebase's
  existing filesystem-race posture; note in a comment.
- Update threat model T3: same-instance concurrency safe with
  `worktreesDir`; separate-process residual shrinks to "backlog commits
  unserialized".

## 7. Check-stage allowlists — `.opencode/agents/verify.md`, `review.md`

Format: OpenCode permission globs match the **raw command string**,
prefix-style (`"npm test*": allow`, default `"*": deny`).
`cd /wt && npm test` starts with `cd ` → **denied today**. Changes:

- `git -C` variants next to the existing git entries (mid-pattern `*` is
  supported):
  - verify: `"git -C * status*"`, `"git -C * diff*"`, `"git -C * log*"`,
    `"git -C * show*"` → allow
  - review: those four plus `"git -C * blame*"` → allow
- `cd`-prefixed twins for every runner entry in verify.md (~16 mechanical
  duplications): `"cd * && npm test*"`, `"cd * && npm run *"`,
  `"cd * && pnpm test*"`, `"cd * && pnpm run *"`, `"cd * && yarn test*"`,
  `"cd * && yarn run *"`, `"cd * && bun test*"`, `"cd * && node --test*"`,
  `"cd * && npx tsc*"`, `"cd * && npx vitest*"`, `"cd * && npx jest*"`,
  `"cd * && npx eslint*"`, `"cd * && pytest*"`, `"cd * && go test*"`,
  `"cd * && cargo test*"`, `"cd * && make test*"`, `"cd * && make check*"`.
  review.md needs no cd-twins — its allowed commands take absolute paths
  (`cat /abs`, `grep … /abs` already match `cat *` / `grep *`).
- Security delta: none in kind — `"npm test*"` already matches
  `npm test && anything` (raw-string matching); the `cd * && ` prefix admits
  the same command class, relocated. Say so in the commit message.
- **Spike first** (cheap, before wiring the driver): add one
  `cd * && npm test*` rule and confirm the matcher accepts
  `cd /x && npm test`. This is the single load-bearing assumption of
  approach A.

## 8. Prompt/agent text

- `.opencode/agents/{build,verify,review}.md`: add a short "Worktree
  isolation" section — *when your input contains a `Worktree:` line, that
  directory is the entire universe of this task: read/edit with absolute
  paths under it, prefix shell commands with `cd <path> && `, use
  `git -C <path>`; anything outside it is out of scope and must not be
  touched.* verify.md additionally: "if a test command is denied, the
  `cd <worktree> && <runner>` forms are the allowed shape".
- `.opencode/commands/{build,verify,review}.md` need no structural change —
  `$ARGUMENTS` already carries the composed block. `plan.md` untouched
  (PLAN runs read-only against the main tree, before a worktree exists —
  correct).

## 9. Startup reconciliation — `src/index.ts:49-60`

After the interrupted-task scan, when `config.worktreesDir` is set:
`pruneWorktrees` (safe), then `worktree list --porcelain` and log a `warn`
for each worktree under `worktreesDir`: "stale loop worktree <path> (branch
<b>) — /loop recover <id> will reuse it, or `git worktree remove` it".
**Never auto-delete**: another opencode process may own it, and a crashed
BUILD's uncommitted diff is evidence. `/loop recover` reuses it via
`ensureIsolation`'s `worktreeForBranch` path.

## 10. Optional hardening (small, recommended)

In `index.ts`'s existing `"tool.execute.before"` hook (line 74): when
`getLoop(sessionID)?.git?.worktree` is set and the tool is the edit/write
tool, reject a `filePath` outside the worktree (throw with a corrective
message). Cheap; enforces pinning for the only tool that mutates files
structurally. Bash remains prompt-enforced — documented residual.

## 11. Edge cases

| Case | Behavior |
|---|---|
| Branch `loop/<id>` exists, no worktree (old shared-mode run, recover) | `addWorktree` without `-b` reuses it; never reset |
| Worktree already registered (recovered run) | `worktreeForBranch` → adopt existing path |
| Path exists on disk but unregistered (crash + pruned registration) | `pruneWorktrees` then retry; still failing → loop error, human cleans up |
| `worktree add` fails (locks, perms) | Loop error (note + toast); **never** falls back to shared-tree branch switching |
| Dirty worktree at teardown (checkpoint commit failed) | Left in place with warn; branch keeps whatever was committed |
| `/loop stop` mid-stage | Existing `driver.ts:304-308` path: checkpoint into worktree → teardown (remove if clean) |
| Plugin crash mid-drive | Worktree survives; startup logs it; `/loop recover` reuses branch + worktree |
| Not a git repo / detached HEAD | Same degraded no-isolation path as today (worktree mode needs a base branch) |
| Main tree dirty at claim | Worktree is clean-from-base; log that uncommitted human changes are invisible to the build |
| `worktreesDir` inside the repo | Hidden from `git status` via `.git/info/exclude`, not a tracked `.gitignore` edit |

## 12. Test plan

- **Pure (extend existing):**
  - `src/loop/state.test.ts`: `composeArgs` with `git.worktree` set —
    pinning block present for build/verify/review, absent for plan; review
    diff boundary uses `git -C`.
  - Config tests: `worktreesDir`/`worktreeSetup` optional, reject empty
    string, defaults unchanged.
  - Extract & test pure helpers from the driver:
    `worktreePathFor(directory, worktreesDir, id)`.
- **Shell-dependent (new `src/loop/git.test.ts`, integration-style):**
  `git.ts` is thin `git -C` wrappers — use `fs.mkdtemp` + `git init`
  fixtures at test runtime: `addWorktree` fresh / existing-branch / reuse,
  `removeWorktree` clean vs dirty (dirty must fail, not delete),
  `pruneWorktrees`, `worktreeForBranch`, `ensureExcluded` idempotence.
  Skip when `git` is absent.
- **Manual/e2e checklist:** the §7 matcher spike; a full worktree-mode loop
  on a sample project with `worktreeSetup: "npm ci"`; confirm the human
  checkout's HEAD never moves during a drive; two watch sessions driving two
  tasks concurrently; `/loop stop` mid-BUILD then `/loop recover`;
  crash-kill opencode mid-BUILD → restart log → recover.
- All 85 existing tests pass unchanged with `worktreesDir` unset.

## Sequencing

1. Allowlist-matcher spike (§7) — de-risks the whole approach.
2. `git.ts` helpers + tests.
3. Config + `Config` type.
4. `state.ts` (`GitRef.worktree`, `composeArgs`) + tests.
5. Driver (`ensureIsolation` / `checkpoint` / `teardownIsolation`,
   terminal-event `commitPaths`, `executingDirs` gate).
6. Agent/command prompt + allowlist edits.
7. `index.ts` reconciliation + optional edit guard.
8. Docs.

## Docs to update

- `README.md` — the two knobs, the "one drive per tree" limitation lifted in
  worktree mode, backlog-commit behavior change.
- `.opencode/commands/loop.md` — concurrency note.
- `skills/loop-orchestration/SKILL.md` — isolation section, watch
  concurrency.
- `docs/design/threat-model.md` — T3 (residual shrinks), T4 (execution-phase
  notes now committed to the human's branch via `commitPaths`).
