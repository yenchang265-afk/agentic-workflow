# Loop kinds

A **loop kind** is a declarative definition of one agentic loop: its stages,
transitions, prompts, guardrails, and where its work comes from. The shared
engine (`@agentic-loop/core`) interprets these definitions; both the OpenCode
plugin and the Claude Code MCP server drive them through the same scheduler.

```
loops/
├── engineering/          # PLAN → BUILD → VERIFY → REVIEW over docs/tasks/
│   ├── loop.json
│   └── stages/{plan,build,verify,review}.md
├── pr-sitter/            # TRIAGE → FIX → VERIFY → PUBLISH over open PRs
│   ├── loop.json
│   └── stages/{triage,fix,verify,publish}.md
├── review-sitter/        # FETCH → ASSESS → PUBLISH over requested reviews (comment-only)
│   ├── loop.json
│   └── stages/{fetch,assess,publish}.md
├── dep-sitter/           # SCAN → UPGRADE → VERIFY → PUBLISH over npm advisories
│   ├── loop.json
│   └── stages/{scan,upgrade,verify,publish}.md
└── main-sitter/          # DIAGNOSE → REMEDY → VERIFY → PUBLISH over red default-branch CI
    ├── loop.json
    └── stages/{diagnose,remedy,verify,publish}.md
```

Ideas for further kinds are cataloged in
[`docs/design/proposed-loops.md`](../../../docs/design/proposed-loops.md).

## loop.json anatomy

Validated by `packages/core/src/manifest/schema.ts` (zod — a broken manifest
fails loud at host startup). A minimal two-stage kind:

```jsonc
{
  "kind": "example",
  "version": 1,
  "description": "What this loop sits on and does.",
  "workSource": {                       // where claimable work comes from
    "type": "backlog",                  // or "github-pr" | "dependency-scan" | "ci-runs"
    "statuses": ["queued", "done"],     // the folder set (backlog only)
    "pools": [                          // claim pools, priority order
      { "status": "queued", "entryStage": "work" }
    ]
  },
  "maxIterations": 3,                   // shared retry budget for counted fires
  "stages": [
    {
      "name": "work",
      "kind": "work",                   // "work" completes on its own …
      "command": "build",               // OpenCode slash command it fires
      "agent": "loop-build",            // subagent persona backing it
      "prompt": "stages/work.md",       // template, relative to this folder
      "isolation": "worktree",          // "worktree" | "none" (main tree, no snapshot)
      "timeoutMinutes": 90              // optional wall-clock cap override; defaults to config.stageTimeoutMinutes
    },
    {
      "name": "check",
      "kind": "check",                  // … "check" must record a loop_verdict (missing = FAIL)
      "command": "verify",
      "agent": "loop-verify",
      "prompt": "stages/check.md",
      "isolation": "worktree",
      "bashAllowlist": ["git diff*", "npm test*"]  // default-deny bash for this stage
    }
  ],
  "transitions": {
    "work":  { "onDone": { "kind": "fire", "stage": "check" } },
    "check": {
      "onPass":  { "kind": "done", "message": "✓ done" },
      "onFail":  { "kind": "fire", "stage": "work", "countIteration": true,
                   "dropArtifacts": [], "capMessage": "✗ stopped after {maxIterations} iterations." },
      "onError": { "kind": "stop", "message": "✗ environment error." }
    }
  },
  "hooks": { "compose": {}, "validateBeforeTransition": {} }
}
```

Transition **effects**:

- `fire` — run another stage. `countIteration: true` spends one unit of the
  shared `maxIterations` budget and requires a `capMessage`
  (`{maxIterations}` interpolates); `dropArtifacts` removes stale feedback
  that judged an older attempt.
- `park` — exit the loop at a human gate; `toStatus` names the work-source
  status the item parks into (engineering's PLAN → `plan-review`).
- `done` — terminal success, with a message and an optional `toStatus` (the
  work-source status the item lands in, e.g. `in-review`).
- `stop` — terminal halt, with a message only (no `toStatus`).

Every stage needs a transitions entry; `work` stages need `onDone`, `check`
stages need all of `onPass`/`onFail`/`onError`. A missing verdict on a check
stage resolves as FAIL — never as a stall, never parsed from prose.

## Stage prompt templates

`stages/*.md` files compose the prompt threaded into each stage command
(`packages/core/src/manifest/template.ts`):

- A file is a sequence of **sections** separated by lines containing only
  `---`. Each section renders independently; sections that render empty are
  dropped; survivors join with a blank line.
- `{{path}}` interpolates a context value (dot paths: `git.branch`).
- `{{#path}}…{{/path}}` renders its span only when the value is truthy
  (non-empty string). Blocks nest.

Context available: `goal`, `iteration`, `task.id`/`task.path`,
`acceptance.bullets` (pre-rendered `- …` list), `artifacts.<stage>` (each
completed stage's captured output; the approved plan under `artifacts.plan`),
`git.base`/`git.branch`/`git.worktree`/`git.diffCmd` (precomputed review diff
command), `worktree.instructions` (the standard pinning paragraph — every
kind gets isolation discipline for free by including it), and
`platform.github`/`platform.ado` (exactly one is truthy, per the resolved
code platform — pr-sitter stages branch on these to pick `gh` vs ADO REST
(`curl`) guidance).

## Work sources

- **`backlog`** — markdown task files in status folders under the configured
  `tasksDir` (engineering). Pools are walked in priority order; claims are
  atomic `.claims/` mkdir markers; `claimPredicate` names a registered
  predicate (e.g. `engineering.isClaimable`).
- **`github-pr`** — open hosted PRs needing attention per the `triggers` list
  (`failing-checks`, `changes-requested`, `new-comments`, `merge-conflict`,
  `review-requested`), deduped by the per-PR ledger under
  `<tasksDir>/runs/<kind>/` (namespaced per kind, so pr-sitter and
  review-sitter never share bookkeeping). Drafts and fork PRs are skipped;
  the PR's head is fetched into a local branch at claim so isolation reuses
  it. The optional `role` (`author`, the default, or `reviewer`) states the
  kind's relationship to the PRs it claims — on ADO, where there is no
  server-side search query, it picks the client-side identity filter
  (`createdBy` vs pending-reviewer membership). The concrete platform is
  resolved from config `codePlatform` at wiring time: `github` polls
  `gh pr list --search <query>`; `ado` polls the REST API
  (`_apis/git/pullrequests?searchCriteria.status=active`) with failing checks
  read from blocking branch policy evaluations — a repo without a build
  policy never fires `failing-checks`. Stage `platformAllowlist` entries
  merge into `bashAllowlist` for the resolved platform.
- **`dependency-scan`** — direct dependencies with a fixable advisory
  (`npm audit --json`) at or above `severityFloor`, optionally plus plainly
  outdated ones (`includeOutdated`). One item per dependency, deduped by a
  per-dependency ledger under `<tasksDir>/runs/<kind>/dep-<pkg>.json`; a
  bump outside the `autoFix` classes (majors always) is logged and never
  claimed. GitHub-only for now — on an `ado` platform the wiring skips the
  kind with a warning.
- **`ci-runs`** — the watched branch's newest head when its completed CI runs
  conclude red (`gh run list`; `branch` defaults to the remote default
  branch, `workflows` narrows the judgement). Heads with runs still in
  flight are left alone; a green re-run or a newer push retires the item
  naturally. Deduped per head under `<tasksDir>/runs/<kind>/head-<sha>.json`;
  at claim the red head is pinned to a local `<kind>/<sha>` branch for
  isolation. GitHub-only for now — on an `ado` platform the wiring skips the
  kind with a warning.

## The TS escape hatch

Logic a manifest can't express hangs off named refs. Three kinds are resolved
through `packages/core/src/manifest/registry.ts`:

- `hooks.compose.<stage>` — augment the template context before rendering.
- `pools[].claimPredicate` — claimability predicates for backlog pools.
- `hooks.validateBeforeTransition.<stage>` — a check that vetoes a park/done
  whose side conditions don't hold, resolved via `resolveValidateHook`.

These are registered before the first poll (see
`packages/core/src/kinds/engineering.ts`; hosts call `registerEngineeringHooks()`
at startup — engineering registers only `engineering.isClaimable`).

Engineering names `validateBeforeTransition.plan =
"engineering.planLandedOnDisk"` ("the PLAN actually landed on disk") but
deliberately leaves that ref **unregistered** — the check needs backlog IO, so
the ref resolves to `null` and each host runs the check directly in its park
handler instead (`plugins/claude/mcp-server/src/server.ts`, `src/loop/driver.ts`
— they re-read the task file and confirm the `## Implementation Plan` heading
landed). The registry path is there for kinds whose validation is pure.

## Enabling a kind

`.agentic-loop.json` at the target repo's root:

```json
{
  "loops": {
    "pr-sitter": { "enabled": true, "query": "is:open author:@me" },
    "review-sitter": { "enabled": true },
    "dep-sitter": { "enabled": true, "severityFloor": "high" },
    "main-sitter": { "enabled": true, "branch": "main" }
  }
}
```

Engineering runs unless explicitly disabled (`"engineering": { "enabled":
false }`); every other kind is opt-in by adding its section. Kind-specific
knobs (like the sitter's `query`) live in the same section. The scheduler
polls enabled kinds in claim-priority order — engineering's backlog first.

## Checklist for a new kind

1. `loops/<kind>/loop.json` + `stages/*.md` (this page + the zod schema are
   the contract; `npm test -w @agentic-loop/core` exercises manifest
   validation).
2. Stage **agents** for both plugins: author the source under
   `prompts/agents/loop-<kind>-*/` (`body.md` + `opencode.yaml` — frontmatter
   bash permissions mirror the manifest allowlists — + `claude.yaml`) and run
   `npm run gen:prompts`; it renders into `plugins/opencode/agents/` and
   `plugins/claude/agents/` (never edit those outputs — CI drift-checks them;
   the PreToolUse guard enforces the manifest allowlist via the stage marker).
3. OpenCode **commands** for each stage `command` that doesn't already exist
   (`plugins/opencode/commands/<command>.md`, thin `agent:`-frontmatter
   wrappers).
4. A **work source** if neither `backlog` nor `github-pr` fits
   (`packages/core/src/source/`, implement `WorkSource`), wired into both
   hosts' `sourcesFor`.
5. Registry hooks, registered at host startup.
6. **Tests**: an engine walk of the manifest (see the pr-sitter cases in
   `core/src/loop/engine.test.ts`) and source tests with scripted shells
   (see `source/github-pr.test.ts`).
7. Config docs: `docs/configuration.md` + the threat model if the kind gains
   new authority (push, comment, network).
