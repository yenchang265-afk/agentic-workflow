# Design: explore auto-fetch task + right-sized PR gating

Status: **Draft / design only** — no implementation in this round.
Audience: implementers of the next round.

## 1. Context & goals

The agentic loop is `explore → plan → build → verify`. Today `/explore` takes a
hand-typed free-text target. Two gaps this design closes:

1. **Task ingestion** — start the loop from the *real* backlog item, not a retyped
   target. Tasks live in **Azure DevOps work items** or a **task list under
   `/docs`**.
2. **PR-size discipline (human gate)** — work happens in an isolated git worktree
   and must land as a PR small enough for a human to review. Large tasks are
   decomposed into review-sized slices: **one slice → one worktree → one PR**,
   each under a size budget; a plugin gate blocks/​warns on oversized PRs.

Non-goals (this round): building it. This doc specifies interfaces, config, hook
wiring, and file layout so the next round is mechanical.

## 2. Decisions (locked)

| Area | Decision |
|------|----------|
| Task source | **Both**, behind one adapter interface (Azure DevOps + `/docs`). |
| Azure access | **Official `microsoft/azure-devops-mcp`** server, `work-items` domain. Structured, no shell — explore stays read-only. |
| PR sizing | **Decompose into slices + LOC/file budget.** Each slice = one worktree + one PR. Plugin gate enforces the budget. |

## 3. Grounding in the opencode plugin SDK

Verified against `node_modules/@opencode-ai/plugin` and `@opencode-ai/sdk`:

- **Hooks** (`Hooks` interface): `event`, `tool.execute.before`,
  `tool.execute.after`, **`command.execute.before`** (intercept a slash command,
  return injected `parts`), `permission.ask` (override allow/deny/ask),
  `tool[name]` (register custom tools), `chat.message`.
- **Context** (`PluginInput`): `client`, `project`, `directory`, `worktree`
  (git root), `$` (Bun shell), `serverUrl`, `experimental_workspace.register`.
- **Client** (`OpencodeClient`):
  - `client.session.prompt` / `promptAsync` (inject a prompt; `noReply` option),
    `command`, `messages`, `fork`, `revert`, `summarize`, `todo`.
  - **`client.session.diff(sessionID)` → `FileDiff[]`**, each
    `{ file, before, after, additions, deletions }` — the PR-size signal,
    no `git diff` shell needed.
  - `client.vcs.get()` → `{ branch }`; event `vcs.branch.updated`.
  - `client.mcp.status()` / `add` / `connect` — detect/manage the ADO MCP server.
  - `client.app.log`, `client.tui.showToast`.
- **Custom tool** via `tool({ description, args: <zod shape>, execute(args, ctx) })`;
  `ctx` has `sessionID`, `worktree`, `directory`, `abort`, and
  `ctx.ask({...})` for a permission prompt.
- **No native PR/GitHub API** → PR *creation* is `gh pr create` / `az repos pr
  create` via `$`; PR *sizing* uses `client.session.diff` (preferred) or
  `git diff --numstat base...HEAD` via `$`.
- Explore agent is read-only (`edit: deny`, `bash: deny`,
  `.opencode/agents/explore.md`). **MCP tool permission is independent of bash**,
  so ADO-via-MCP keeps explore read-only.

## 4. Architecture

```
                 ┌─────────────── task source (adapter) ───────────────┐
/explore  ──▶    │  AzureTaskSource (ADO MCP)   DocsTaskSource (/docs)  │
   │             └──────────────────────────────────────────────────────┘
   │                                  │ Task
   ▼                                  ▼
command.execute.before  ─── inject Task into the explore prompt ───▶ explore agent
                                                                        │
                                                          code map  +  WorkPlan (slices)
                                                                        │
                            plan/build: per slice → own worktree → PR   ▼
                                                          ┌─────────────────────────┐
                                 tool.execute.before ───▶ │  PR size gate (budget)  │ ─▶ human gate (PR)
                                                          └─────────────────────────┘
```

### 4.1 Task source adapter (repository pattern)

`src/task/types.ts`:

```ts
import { z } from "zod"

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  source: z.enum(["azure", "docs"]),
  url: z.string().url().optional(),
})
export type Task = z.infer<typeof TaskSchema>

export interface TaskSource {
  fetchNext(): Promise<Task | null>          // next ready/assigned task
  fetchById(id: string): Promise<Task | null>
}
```

- `src/task/azure.ts` — `AzureTaskSource`. Calls the ADO MCP `work-items` tools
  through `client` (list ready/assigned via a WIQL/saved query, then fetch detail).
  Maps the work item (System.Title, System.Description, acceptance-criteria field,
  `_links.html.href`) → `Task`. No shell.
- `src/task/docs.ts` — `DocsTaskSource`. Reads the `/docs` task list file via
  `client.file.read` (or fs) and parses it (§4.2). Pure read.
- `src/task/index.ts` — `resolveTaskSource(config, client): TaskSource` factory,
  selecting by `config.taskSource`. Validates with Zod; throws a clear error on
  misconfig (per error-handling rules).

### 4.2 `/docs` task-list convention

Define one parseable format, default path `docs/tasks.md`:

```md
## TASK: Add rate limiting to the API   <!-- id: T-12 -->
- status: ready            # ready | in-progress | done
- description: Throttle authenticated callers to 100 req/min.
- acceptance:
  - [ ] Returns 429 over the limit
  - [ ] Limit is configurable per route
```

Parser rules: each `## TASK:` heading is a task; `id` from the trailing HTML
comment (or slugged title); `status`/`description`/`acceptance` from the list.
`fetchNext()` = first `status: ready` in file order. `fetchById(id)` matches the
comment id.

### 4.3 `/explore` modes (via `command.execute.before`)

Keep the command surface, resolve the target in the plugin so arg-parsing stays
out of the markdown:

- `/explore`             → `fetchNext()`
- `/explore task:<id>`   → `fetchById(<id>)`
- `/explore <free text>` → unchanged manual target (no fetch)

The `command.execute.before` hook detects the `explore` command, runs the adapter,
and returns `parts` that prepend the resolved `Task` (title, description,
acceptance criteria, url) to the prompt. The explore agent then maps the code
**and** emits a WorkPlan. `.opencode/commands/explore.md`,
`.opencode/agents/explore.md`, and the skill are updated to describe the new
task-aware output.

### 4.4 Decomposition + size budget (explore output)

Explore emits a `WorkPlan` alongside its findings map:

```ts
interface Slice {
  title: string
  rationale: string
  targetFiles: string[]
  estLoc: number
  branch: string            // suggested worktree branch name
  prTitle: string
  dependsOn: string[]       // other slice titles/ids
}
interface WorkPlan { task: Task; slices: Slice[] }
```

Budget (configurable, defaults): `maxLoc ≈ 400`, `maxFiles ≈ 10` per slice.
Explore splits anything larger and orders slices by dependency. This is the
hand-off to plan/build: each slice becomes one worktree + one PR.

### 4.5 Worktree + PR size gate (plugin)

- Each slice is built in its own worktree (`context.worktree`); branch from §4.4.
- **PR size gate** — `tool.execute.before` intercepts PR-creating / push bash
  commands (`gh pr create`, `az repos pr create`, `git push`). Before allowing:
  1. Get the diff size: prefer `client.session.diff(sessionID)` summed
     `additions + deletions` and changed-file count; fallback
     `git diff --numstat <base>...HEAD` via `$`.
  2. If over `prBudget` → **deny** with a message telling the agent to split per
     the WorkPlan slices (`tui.showToast` for the human). Under budget → allow.
- Optional **`propose-pr` custom tool**: runs the budget check, then creates the
  PR with a generated body that links the source `Task` + acceptance criteria, so
  the human reviewer sees scope and traceability in the PR description.
- **Human gate** = the PR itself. The gate guarantees it is small and linked to a
  task; `permission.ask` can additionally require explicit human approval before
  the PR command runs.

### 4.6 Config

`.agentic-loop.json` at repo root (or the plugin's `opencode.json` config block),
validated with Zod:

```jsonc
{
  "taskSource": "azure",                 // "azure" | "docs"
  "azure": {
    "org": "https://dev.azure.com/acme",
    "project": "Platform",
    "areaPath": "Platform\\API",
    "query": "<WIQL or saved-query id for 'ready' work>"
  },
  "docs": { "path": "docs/tasks.md" },
  "prBudget": { "maxLoc": 400, "maxFiles": 10 }
}
```

ADO auth (PAT) and MCP server registration live in opencode's MCP config, not
here — the plugin only reads work items through the connected MCP server.

## 5. File layout (built next round)

| Path | Purpose |
|------|---------|
| `src/task/types.ts` | `Task`, `TaskSource`, Zod schemas |
| `src/task/azure.ts` | `AzureTaskSource` (ADO MCP) |
| `src/task/docs.ts` | `DocsTaskSource` + markdown parser |
| `src/task/index.ts` | `resolveTaskSource` factory |
| `src/pr/budget.ts` | diff-size computation + budget check |
| `src/config.ts` | load/validate `.agentic-loop.json` |
| `src/index.ts` (edit) | wire `command.execute.before` + PR gate; optional `propose-pr` tool |
| `.opencode/commands/explore.md` (edit) | document task modes |
| `.opencode/agents/explore.md` (edit) | task-aware output + allow ADO MCP tools, keep `bash: deny` |
| `.opencode/skills/explore/SKILL.md` (edit) | WorkPlan + budget guidance |

Keep files small and focused (per coding-style rules).

## 6. Open questions for implementation

- **ADO "next ready" semantics** — exact WIQL: assigned-to-me AND state in
  (Ready/Approved), ordered by priority/stack-rank? Confirm field for acceptance
  criteria (`Microsoft.VSTS.Common.AcceptanceCriteria`).
- **Gate strictness** — hard deny vs warn-with-human-override (`permission.ask`).
- **Base branch detection** for the diff — `client.vcs.get()` gives current
  branch; need the PR base (config or `git merge-base`).
- **WorkPlan persistence** — emit to the session only, or also write
  `docs/workplans/<task-id>.md` so build/verify and humans can re-read it.

## 7. Verification

Design-doc acceptance (this round):
- [ ] Covers all 4 decisions: dual adapter, ADO-via-MCP, decompose+budget,
      worktree+PR gate.
- [ ] Interfaces, config shape, hook names, and file layout are concrete.
- [ ] Read-only explore constraint preserved (MCP + Read only; `bash: deny`).

Deferred end-to-end checks (implementation round):
- `/explore` with no arg fetches a real ADO work item via the MCP server.
- `/explore` parses a sample `docs/tasks.md` and returns the first `ready` task.
- A slice/diff over `prBudget` trips the gate (`tool.execute.before` denies the
  PR command); under budget it passes.
- A created PR body links the source task and its acceptance criteria.
```
