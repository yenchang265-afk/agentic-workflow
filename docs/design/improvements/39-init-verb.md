English | [繁體中文](39-init-verb.zh-TW.md)

# 39 — `init` scaffolds a repo on day one

**Status: implemented.**

## The problem

Nothing set a repo up. The status folders appear lazily (`moveTask`/
`createTask` mkdir at the point of use), the repo config is a filename to
remember and hand-write, and the backlog's git-exclude happens on the first
claim — all fine for the loop, all invisible to the human onboarding a new
repo, who learns the structure piecemeal by watching it materialize. The
installers set up the PLUGIN (user-scope config included) and deliberately
never touch a repo.

## What changed

- **`initRepo`** (`workflow/init.ts`): create the `tasksDir` status folders,
  write `.agentic-workflow.json` when none exists, and — when `ignoreBacklog`
  is on and the directory is a git repo — run the same `ensureExcluded` the
  claim path uses, so the first `git status` after init is already clean.
  Returns a structured report (`createdDirs`/`kept`/`configCreated`/
  `excluded`) plus the one-line summary hosts surface, ending with the
  natural next step (`new <idea>`).
- **The verb on every host**: OpenCode handles `init` deterministically like
  `doctor`; Claude/Qwen get a `workflow_init` MCP tool and a verb block.
  Argument hints, routers, and the docs' verb lists all name it.

## Sharp edges

- **Idempotent, and never overwrites.** Every step is create-if-absent;
  re-running reports what was `kept` and changes nothing. An existing config
  — however partial — is the human's, and "init fixed my config" is a bug
  report waiting to happen. The test pins that a second run issues no write.
- **Safe keys only in the skeleton** (`initConfigSkeleton`): `tasksDir` and
  `maxIterations`, defaults made visible. Nothing shell-bearing or
  credential-shaped — those are user-layer-only (`droppedRepoKeys`), so
  scaffolding them would write a file the runtime immediately warns about.
- No README or placeholder files inside `tasksDir`: `auditBacklog` reads any
  stray file there as damage, and `doctor fix` would "rescue" it to
  `draft/`.
