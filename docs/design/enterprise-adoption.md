# Enterprise adoption — gap analysis and improvement roadmap

Status: proposed roadmap (nothing in here is built yet).
Sourced from: a full audit of `main` at `35284e8` — every stage agent, skill,
subagent, driver path, and design doc; all cited paths and line references
verified against source at that commit. Companion to
[`threat-model.md`](./threat-model.md) (whose residual risks this roadmap
converts into work items) and the shipped hardening plans in
[`improvements/`](./improvements/README.md).

Prioritization (adopter decision): **governance & audit** and **CI/CD &
toolchain integration** first; scale/multi-user and cost/observability are
catalogued but deferred to phase 3.

---

## 1. Executive summary

The plugin today is a well-engineered **single-team, single-repo developer
tool** with genuinely strong *local* safety controls: a trusted verdict
channel, default-deny check stages, opt-in worktree isolation, shape-based
secret redaction, fail-closed crash recovery, and an unusually honest threat
model. Its enterprise gaps are almost entirely the ones the threat model
**deliberately delegates to "the host environment"**: authenticated identity,
approval policy, tamper-evident audit, CI/PR gating, task-system integration,
cost governance, and observability export. The scope boundary stops exactly
where enterprise governance begins.

Replacing an engineering workflow in an enterprise therefore means closing
two families of gaps:

1. **Governance & audit** — today every approval is attributed to an
   unauthenticated local `git config` identity, recorded in mutable markdown,
   and gated by nothing stronger than "a human typed the command". Phase 1
   adds authenticated approvals, approval policy, a tamper-evident exportable
   audit trail, and end-to-end requirements traceability.
2. **CI/CD & toolchain** — today the loop parks at `in-review/` and stops;
   shipping is a local folder move, there is no CI anywhere (not even for
   this repo's own tests), and task-system integration is prompt-only.
   Phase 2 adds gated PR automation, CI as an independent second verifier,
   and a code-side task-ingestion adapter.

Everything else (multi-process scale, cost budgets, observability export) is
real but secondary, and is parked in phase 3 with sketches.

---

## 2. How the system works today

Two commands split the lifecycle. Planning is interactive and human-gated;
execution is unattended and machine-gated.

### 2.1 Stage-by-stage map

| Stage | Command → agent | Permissions (host-enforced) | Skills invoked (prompt-only) | Hard (code) enforcement |
|---|---|---|---|---|
| Draft | `/agent-loop-plan new <idea>` → `loop-plan-author` | `edit: allow`, `bash: deny` | `interview-me` (mandatory), `task-backlog-management` | none at write time — agent-written files are validated lazily on next parse (`src/task/store.ts:139-141`) |
| Plan | `/agent-loop-plan task <id>` → plugin move, then `loop-plan-author` | same | `planning-and-task-breakdown`, `task-backlog-management` | plugin moves `draft/ → in-planning/` with audit note + commit before the turn (`src/loop/driver.ts:818-834`) |
| Approve | `/agent-loop-plan approve <id>` → plugin only | agent writes nothing | — | `hasPlan` heading check, move to `in-progress/`, audit note, commit (`src/loop/driver.ts:836-862`, `src/task/store.ts:31-34`) |
| BUILD | driver-fired `loop-build` | `edit: allow`, `bash: allow` (full shell) | `incremental-implementation`, `test-driven-development` | commit checkpoint per iteration (`src/loop/driver.ts:527-529`); worktree pinning for edit tools only (`src/index.ts:134-154`) |
| VERIFY | driver-fired `loop-verify` | `edit: deny`, `webfetch: deny`, default-deny bash allowlist (test runners + read tools) | `debugging-and-error-recovery` on FAIL | verdict only via `loop_verdict` tool gated to session+stage; missing verdict = FAIL (`src/index.ts:156-192`, `src/loop/driver.ts:163-178`) |
| REVIEW | driver-fired `loop-review` | `edit: deny`, `webfetch: deny`, tighter allowlist (git inspection, no test runners) | `code-review-and-quality`; `security-and-hardening` / `performance-optimization` conditionally | same verdict channel; optional `reviewLenses` worst-of-N (`src/loop/driver.ts:397-453`, `src/loop/verdict.ts:48-52`) |
| Ship | `/agent-loop ship <id>` → plugin only | — | — | refuses unless task is in `in-review/`; audited move + commit (`src/loop/driver.ts:989-1008`) — **a local folder move, not a PR** |

Control flow between stages is the pure state machine `advanceOnIdle`
(`src/loop/state.ts:175-248`): verify FAIL/review FAIL re-build within a
shared `maxIterations` cap; any ERROR stops for a human; context composition
is deterministic (`composeArgs`, `src/loop/state.ts:116-160`) with stale
cross-check feedback dropped on re-build.

### 2.2 The enforcement ledger

This is the single most important table for an enterprise evaluation. Almost
all *engineering discipline* is prompt-instruction-only; a small core is
enforced in code.

**Enforced in code (cannot be bypassed by a non-compliant subagent):**

1. Verdict channel — only a `loop_verdict` tool call from the correct
   session *and* current stage flips control flow; text verdicts are ignored;
   a missing call counts as FAIL (`src/index.ts:156-192`,
   `src/loop/driver.ts:163-178`, `src/loop/verdict.ts`).
2. VERIFY/REVIEW bash default-deny allowlists + `edit: deny` +
   `webfetch: deny` (agent frontmatter, host permission system).
3. Worktree pinning for edit/write/patch tools — throws outside the worktree
   (`src/index.ts:134-154`). **Bash is not pinned** — documented residual.
4. Secret shape-redaction at every durable-write boundary
   (`src/loop/redact.ts`, wired in `src/task/store.ts:220-262`).
5. Iteration cap, stage timeout, ERROR-stops, fail-closed Zod snapshot
   validation (`src/loop/persist.ts:70-88`), atomic `mkdir` claim markers
   (`src/task/store.ts:187-191`), git isolation + checkpoints, worst-of lens
   combination.
6. Backlog surgery — every folder transition done by a command is audited
   and committed by plugin code, never by the agent.

**Prompt-only (relies on model compliance; no code backstop):**

- All skill discipline: TDD actually followed, tests not weakened,
  incremental scope discipline, five-axis review depth, conditional
  security/performance review passes.
- The interview actually running (and reaching real confidence) in
  `/agent-loop-plan new`.
- Acceptance criteria being *testable* — Zod accepts any strings, including
  an **empty list** (`acceptance` defaults to `[]`,
  `src/task/schema.ts:19`).
- Plan content quality — the only machine gate at approve is the literal
  string `## Implementation Plan` existing (`src/task/store.ts:31-34`).
- BUILD's bash staying inside its worktree.
- "Show the draft before writing", ADO double-confirmation, one-file-only
  rules for the authoring agents.

The threat model is explicit about the consequence (T1 residual): code
enforces *where a verdict comes from*, never *whether it is honest*. The
defenses against a persuaded or sloppy agent are downstream and
probabilistic — the iteration cap, optional `reviewLenses`, and the human
diff gate.

---

## 3. Gap analysis

### 3.1 Governance & audit (priority 1)

| # | Gap | Evidence | Enterprise impact |
|---|---|---|---|
| G1 | **Unauthenticated actor identity.** Every audit note's "by <actor>" is the machine's configured `git config user.name/email` (`src/loop/git.ts:64-69`) — spoofable, and identical for the loop and the human. | threat-model T4 names this residual explicitly | Audit trail cannot prove *who* approved; fails change-management review |
| G2 | **Ungated approvals.** `/agent-loop-plan approve` and `/agent-loop ship` execute for whoever types them; no approver roles, no policy. | `src/loop/driver.ts:836-862`, `:989-1008` | No separation of duties; any user (or compromised session) can approve and ship |
| G3 | **Mutable, non-evidentiary audit trail.** Audit notes are appended markdown (`printf >>`, `src/task/store.ts:223`); a raw edit rewrites history undetectably (only git history, itself rewritable pre-push, backstops it). | task-backlog SKILL red-flags raw `mv` bypasses but can't detect note tampering | Not compliance-grade; no SIEM ingestion path |
| G4 | **Plan-content gate is a heading check.** A task with zero acceptance criteria and a one-line garbage plan is approvable and claimable. | `hasPlan` = `includes("## Implementation Plan")`; `acceptance` may be `[]` | VERIFY has nothing concrete to check; "verified" becomes vacuous |
| G5 | **Lazy validation of agent-written files.** The authoring agent writes via the `edit` tool with no write-time schema gate; malformed files are *silently skipped with a warning* on the next listing. | `src/task/store.ts:139-141`; the validating `writeTask` path exists but is unused (`src/task/store.ts:284-293`) | Drafts can vanish from every listing without a loud error |
| G6 | **Schema is non-strict.** Unknown frontmatter keys (including a forbidden `status:`) are silently dropped, not rejected. | `z.object` non-strict, `src/task/schema.ts:13` | Mistakes are masked instead of surfaced |
| G7 | **Traceability breaks at the first hop.** The interview's confirmed intent restate is chat-only, never persisted; acceptance lives in two copies (frontmatter + plan section) that can silently diverge — VERIFY reads only the frontmatter. | `skills/interview-me/SKILL.md` step 5; `composeArgs` threads `task.acceptance` | Cannot demonstrate idea → acceptance → verdict lineage |

### 3.2 CI/CD & toolchain integration (priority 2)

| # | Gap | Evidence | Enterprise impact |
|---|---|---|---|
| C1 | **No PR automation.** The loop never pushes, opens PRs, or merges (deliberate non-goal, threat-model "Non-goals"); `/agent-loop ship` is a local folder move + commit. | `src/loop/driver.ts:989-1008` | The last mile of every task is manual; forge-side gates (protected branches, required reviews) never see loop output unless a human wires it |
| C2 | **No CI as a second verifier.** VERIFY and REVIEW are the same model family reading the same artifact chain — the loop grades its own homework. `reviewLenses` mitigates within-model; nothing independent ever runs. | threat-model boundary 2 | A model-family blind spot passes both check stages |
| C3 | **No CI for the plugin repo itself.** No `.github/workflows`; typecheck and tests are manual (`README.md` Develop section). | confirmed absent | Regressions land silently; bad signal for adopters |
| C4 | **Task-system integration is prompt-only.** ADO linking assumes a pre-connected MCP server; nothing in this repo registers, configures, or verifies it. Fetched linkage is mapped once at draft time and never re-synced. | `skills/task-backlog-management/SKILL.md` "Linking a task to Azure DevOps" | Local tasks silently diverge from the system of record |
| C5 | **Dangling design pointer.** `src/task/store.ts:285` cites `docs/design/explore-task-fetch-and-pr-gating.md` — the file does not exist. The dormant `writeTask` sync path was built for it. | grep confirms absence | The two things an enterprise wants most (task fetch, PR gating) have a stub and no design |
| C6 | **Unpinned plugin dependency.** `@opencode-ai/plugin` at `"*"` (peer) / `"latest"` (dev); distribution is clone-and-symlink `install.sh`, no versioned artifact, no checksums. | `package.json:29,33` | Non-reproducible installs; supply-chain exposure |

### 3.3 Catalogued but deferred (phase 3)

- **Scale/multi-user:** all coordination is single-process in-memory
  (`src/loop/state.ts:256-268`, `src/loop/driver.ts:118-147`); the atomic
  claim marker is the only cross-process-safe primitive; separate opencode
  processes on one clone race `index.lock` on backlog commits (T3 residual).
  "Multi-user" today = one clone per watcher, manual sharding.
- **BUILD bash not worktree-pinned** — only edit tools are
  (`src/index.ts:142`); a build agent can shell anywhere.
- **No cost/token budgets** — `maxIterations` and `stageTimeoutMinutes`
  bound iterations and wall-clock, not spend; `reviewLenses` multiplies cost
  N× with only a doc warning.
- **No observability export** — metrics are per-run markdown tables
  (`src/loop/metrics.ts`); no OTel/Prometheus, no cross-run aggregation
  (explicitly out of scope in improvements/06).
- **Redaction blind spots** — snapshots (`runs/*.state.json`) and
  `writeTask` output are not redacted; only append paths are; custom-format
  secrets pass (T6 residual).
- **Brittle status heuristics** — claimability/recovery grep for the literal
  `> BUILD started` audit prose (`src/task/store.ts:43-70`).
- **Two implementations drifting** — the Claude Code port duplicates the
  bash allowlists in `claude-plugin/hooks/check-stage-guard.mjs` and still
  carries config knobs (`gateBeforeBuild`, `interviewBeforePlan`) the
  OpenCode plugin removed.
- **Skill library dead weight** — of 26 skills, 11 are wired into the
  pipeline; `using-agent-skills` (the discovery hub) is referenced by
  nothing; `idea-refine` is never invoked; `doubt-driven-development` — the
  purpose-built adversarial reviewer — is wired into **no** gate.

---

## 4. Improvement roadmap

Each item follows the conventions of the shipped `improvements/` plans:
opt-in or purely additive, TDD, purity boundary respected (`state.ts` and
store predicates stay pure; shell/clock/fs in `driver.ts`/`git.ts`/store IO),
docs updated as part of done.

### Phase 1 — Governance & audit

**1a. Authenticated approvals** *(closes G1, G2 — medium)*
- New config: `approvers: string[]` (forge usernames) and
  `forge: "github" | "azdo"`. When set, `handlePlanCommand` approve and
  `/agent-loop ship` resolve the live forge identity (`gh api user` / ADO profile
  via the connected MCP or CLI) and refuse unless it is in `approvers`.
- Audit note records **both** identities: `approved by <forge-user> (machine
  actor <git-actor>)` — separating "who decided" from "which machine ran it".
- Optional `requireSignedApprovals: true` — approval/ship commits made with
  `git commit -S`; refuse if signing fails.
- Key files: `src/config.ts`, `src/loop/driver.ts` (approve/ship paths),
  `src/loop/git.ts` (signing), new `src/forge.ts` (identity resolution).
- Unset config = today's behavior (backward compatible).

**1b. Approval policy hardening** *(closes G4, G5, G6 — small)*
- `minAcceptanceCriteria` config (default `2` when governance mode on,
  `0` otherwise): approve refuses `task.acceptance.length < n`.
- `TaskFrontmatterSchema` becomes `.strict()` — unknown keys (incl.
  `status:`) error loudly at parse instead of vanishing.
- Post-turn validation sweep: after a `loop-plan` agent turn, the plugin
  re-parses the file(s) under `tasksDir` touched this turn and surfaces
  schema errors as a toast immediately — closing the lazy-validation window.
- Key files: `src/task/schema.ts`, `src/loop/driver.ts`
  (`handlePlanCommand`), `src/config.ts`.

**1c. Tamper-evident, exportable audit trail** *(closes G3 — medium)*
- Hash-chain audit notes: each `auditNote` gains
  `[… sha256:<hash-of-previous-note+content>]`; a pure verifier walks the
  chain and flags breaks. Bootstrap: first note hashes from the task id.
- New `/agent-loop audit export [<id>]` — emits JSONL (task id, transition, both
  identities, ISO timestamp, backlog commit SHA, verdict record incl.
  per-criterion results) to `runs/audit.jsonl` for SIEM ingestion. Redaction
  applied at write, same as run logs.
- Key files: `src/task/store.ts` (`auditNote`, new chain verifier —
  pure, unit-testable), `src/loop/driver.ts` (export command),
  `src/loop/metrics.ts` (verdict record source).

**1d. Requirements traceability** *(closes G7 — small/medium)*
- `/agent-loop-plan new` persists the interview's confirmed restate into the task
  file as an `## Intent` section (outcome, success, constraint, out of
  scope) — the durable link from idea to acceptance bullets. Prompt change
  in `.opencode/agents/loop-plan-author.md` + schema note; no code needed
  beyond allowing the section.
- Single-source acceptance: the plan template stops duplicating acceptance
  ("Acceptance criteria: see frontmatter") so frontmatter is the one copy
  VERIFY already reads. Prompt change in `loop-plan-author.md` +
  `planning-and-task-breakdown`.
- Run summary gains checkpoint SHAs per iteration
  (`src/loop/metrics.ts`), completing idea → acceptance → verdict → commit
  lineage in one greppable file.

### Phase 2 — CI/CD & toolchain

**2e. PR automation behind the human gate** *(closes C1, half of C5 — medium)*
- `/agent-loop ship <id> --pr` (requires `forge` config): push `loop/<id>`,
  open a **draft PR** via `gh pr create` / ADO API with the task body,
  acceptance, `## Run summary`, and audit-note excerpt as the description;
  then do today's audited move to `completed/`. Plain `/agent-loop ship` unchanged.
- The loop still never merges; the forge's protected branches + required
  reviews become the hard change-management layer the threat model defers to.
- Includes writing the missing `docs/design/explore-task-fetch-and-pr-gating.md`
  (this item + 2h are its two halves), fixing the dangling pointer at
  `src/task/store.ts:285`.
- Key files: `src/loop/driver.ts` (ship path), `src/loop/git.ts` (push —
  currently deliberately absent), `src/forge.ts`, threat-model.md non-goals
  section (narrow it: "never merges" stays; "never pushes" becomes
  config-gated).

**2f. CI as independent second verifier** *(closes C2 — medium)*
- Ship workflow templates in `templates/ci/` (GitHub Actions + Azure
  Pipelines): checkout the `loop/<id>` branch, run the repo's test command,
  report a status check.
- New config `requireCi: true`: `/agent-loop ship` polls the forge's checks for
  the loop branch head and **refuses to ship on red or pending** — an
  independent (non-LLM) verifier now gates the exit, breaking the
  grades-its-own-homework loop.
- Key files: `src/forge.ts` (checks API), `src/loop/driver.ts` (ship gate),
  `templates/ci/*`.

**2g. Dogfood CI** *(closes C3 — trivial)*
- `.github/workflows/ci.yml`: `npm ci && npm run typecheck && npm test` on
  push/PR. Also runs the audit-chain verifier's tests once 1c lands.

**2h. Task ingestion adapter** *(closes C4, other half of C5 — large)*
- Activate the dormant `writeTask` path (`src/task/store.ts:284-314`): a
  `/agent-loop-plan sync` command (or watch-mode hook) that queries the configured
  forge/ADO for work items tagged for the loop, files them as schema-valid
  drafts (code-side Zod validation at write — no lazy-validation gap), and
  on re-sync warns when a linked work item drifted from the local task.
- Ingested drafts still flow through the mandatory interview? No — they
  carry the work item's acceptance; the human review happens at
  `/agent-loop-plan task` + `approve`. Document the distinction.
- Key files: `src/task/store.ts` (`writeTask`, already built),
  new `src/task/sync.ts`, `src/loop/driver.ts` (command routing),
  `.opencode/commands/agent-loop-plan.md`.

**2i. Supply chain** *(closes C6 — small)*
- Pin `@opencode-ai/plugin` to a tested version; publish the package with a
  real semver; `install.sh` verifies a checksum in `--copy` mode and records
  the installed version. Reconcile the Claude-port config schema (drop dead
  knobs) in the same pass.

### Phase 3 — Scale & ops (sketches only, unscheduled)

- **Cross-process coordination**: move claim/commit serialization from
  in-memory maps to filesystem locks next to the existing `.claims/`
  markers, making multi-process watchers on one clone safe (retires the
  "separate clones" workaround).
- **Bash worktree pinning for BUILD**: extend the `tool.execute.before`
  guard to rewrite/deny bash outside the worktree, or run BUILD under a
  sandboxed shell — closes the last isolation hole.
- **Token/cost budgets**: per-run and per-day token ceilings in config;
  driver aborts a run that exceeds them (needs usage data from the host API).
- **Observability export**: optional OTel exporter fed from the existing
  `StageSample` accumulator; per-org dashboards.
- **Adversarial plan review**: wire `doubt-driven-development` as an
  optional pre-approve lens (`planLenses` config) — the plan path's
  equivalent of `reviewLenses`, closing the "nothing adversarially reviews
  the plan" gap.
- **Marker robustness**: replace `> BUILD started` prose-grep predicates
  with structured audit-note markers.

### Dependency order

1b and 1d are independent and small — do first. 1a before 1c (the chain
should record authenticated identities). 2g any time. 2e before 2f (ship
must push before CI can gate it); both need `src/forge.ts` from 1a. 2h and
2i independent.

---

## 5. Adoption guidance today (before any roadmap item lands)

An enterprise can pilot the current plugin safely with this posture:

- `.agentic-loop.json`: set `worktreesDir` + `worktreeSetup` (never touch
  the human's tree; safe concurrent watchers in one instance), and
  `reviewLenses: ["correctness", "security", "test-adequacy"]` (worst-of-N
  review; the strongest available defense against a single persuaded
  reviewer).
- One clone per watcher process (the documented T3 workaround).
- Treat the forge as the governance layer: protected branches, required PR
  reviews, no direct pushes — the loop's output only reaches shared history
  through a human-opened PR, which is where authenticated identity and
  change management live today.
- Treat `docs/tasks/runs/` as sensitive (redaction is shape-based; snapshots
  are unredacted), and keep real secrets out of the working tree entirely.
- Keep `maxIterations` at 3 and `stageTimeoutMinutes` at 60 unless a repo's
  test suite demands otherwise — they are the runaway-automation bounds.

---

## 6. Appendix — inventories

### 6.1 Subagents (`.opencode/agents/`)

| Agent | Command | Permissions | Role |
|---|---|---|---|
| `loop-plan-author` | `/agent-loop-plan` | `edit: allow`, `bash: deny` | interview → draft; plan-in-place; approve is report-only |
| `loop-plan` | `/plan` | `edit: deny`, `bash: deny` | standalone ad-hoc planner, chat-only output |
| `loop-explore` | `/explore` | `edit: allow`, `bash: deny` | repo-health scan; files ≤5 deduped drafts |
| `loop-build` | `/build` + driver | `edit: allow`, `bash: allow` | the only code-writing agent |
| `loop-verify` | `/verify` + driver | `edit: deny`, `webfetch: deny`, bash allowlist (test runners + read) | runs tests, records verdict |
| `loop-review` | `/review` + driver | `edit: deny`, `webfetch: deny`, bash allowlist (git inspection only) | five-axis review, records verdict |

`/agent-loop` itself binds no agent — the plugin intercepts it and drives the
stage subagents programmatically.

### 6.2 Skills (26 total)

**Pipeline-wired (11):** `interview-me`, `planning-and-task-breakdown`,
`task-backlog-management`, `spec-driven-development` (standalone `/plan`
only), `incremental-implementation`, `test-driven-development`,
`debugging-and-error-recovery`, `code-review-and-quality`,
`security-and-hardening`, `performance-optimization`, `loop-orchestration`
(documentation skill).

**Ad-hoc only (12):** `api-and-interface-design`, `code-simplification`,
`frontend-ui-engineering`, `source-driven-development`,
`context-engineering`, `documentation-and-adrs`,
`git-workflow-and-versioning`, `observability-and-instrumentation`,
`shipping-and-launch`, `deprecation-and-migration`, `ci-cd-and-automation`,
`browser-testing-with-devtools`.

**Orphaned (3):** `using-agent-skills` (referenced by nothing),
`idea-refine` (mentioned, never invoked), `doubt-driven-development`
(exists, wired into no gate — see phase 3).

No dangling skill references — every `Invoke the X skill` pointer resolves.

### 6.3 references/ (7 files)

`definition-of-done.md` (most-referenced; the "done" anchor),
`testing-patterns.md`, `security-checklist.md`, `performance-checklist.md`,
`observability-checklist.md`, `accessibility-checklist.md`,
`orchestration-patterns.md` (largest; nearly orphaned — pulled mainly by the
unwired `doubt-driven-development`). All reached only transitively through
skills, never directly by an agent.
