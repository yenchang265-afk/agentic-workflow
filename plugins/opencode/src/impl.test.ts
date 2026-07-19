import assert from "node:assert/strict"
import { test } from "node:test"
import { clearLoop, setLoop, type LoopState } from "@agentic-loop/core/loop/state"
import { makeAgenticLoop } from "./impl.ts"

/**
 * The worktree-pinning guard in `tool.execute.before`, driven end-to-end through
 * the plugin factory with a fake client. Stage commands run as subtasks, so tool
 * calls arrive with the CHILD session's id — the regression here is the guard
 * reading only `getLoop(input.sessionID)` and silently skipping enforcement for
 * every stage subagent (edits landed in the human's main tree).
 */

type Hooks = { "tool.execute.before": (input: { sessionID: string; tool: string; callID: string }, output: { args: Record<string, unknown> }) => Promise<void> }

const makeHooks = async (sessions: Record<string, string | undefined>, opts: { failSessionApi?: boolean } = {}): Promise<Hooks> => {
  const client = {
    app: { log: async () => {} },
    file: { read: async () => Promise.reject(new Error("no config file")) },
    session: {
      get: async ({ path: { id } }: { path: { id: string } }) => {
        if (opts.failSessionApi) throw new Error("session API down")
        return { data: { parentID: sessions[id] } }
      },
    },
    tui: { showToast: async () => {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const $ = (() => ({ quiet: () => ({ nothrow: () => Promise.resolve({ exitCode: 1, stdout: "" }) }) })) as any
  return (await makeAgenticLoop({ client, directory: "/repo", $, worktree: "/repo" } as never)) as unknown as Hooks
}

const worktreeLoop = (): LoopState => ({
  goal: "Do it",
  stage: "build",
  iteration: 0,
  artifacts: {},
  task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] },
  git: { base: "main", branch: "feature/t", worktree: "/repo/.worktrees/t" },
  isolated: true,
})

test("worktree pinning fires for a stage subagent's child session (the dead-guard regression)", async () => {
  setLoop("drv", worktreeLoop())
  try {
    const hooks = await makeHooks({ child: "drv" })
    // Outside the worktree → refused, even though the call carries the CHILD id.
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "child", tool: "write", callID: "c1" }, { args: { filePath: "/repo/src/x.ts" } }),
      /outside it/,
    )
    // Relative path → refused (resolves against the main tree's cwd).
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "child", tool: "edit", callID: "c2" }, { args: { filePath: "src/x.ts" } }),
      /relative path/,
    )
    // Inside the worktree → allowed.
    await hooks["tool.execute.before"]({ sessionID: "child", tool: "write", callID: "c3" }, { args: { filePath: "/repo/.worktrees/t/src/x.ts" } })
  } finally {
    clearLoop("drv")
  }
})

test("a session with no loop ancestor is untouched while a worktree loop runs elsewhere", async () => {
  setLoop("drv", worktreeLoop())
  try {
    const hooks = await makeHooks({ stranger: undefined })
    await hooks["tool.execute.before"]({ sessionID: "stranger", tool: "write", callID: "c1" }, { args: { filePath: "/elsewhere/x.ts" } })
  } finally {
    clearLoop("drv")
  }
})

test("session-API failure while a worktree loop is live fails CLOSED for edit tools", async () => {
  setLoop("drv", worktreeLoop())
  try {
    const hooks = await makeHooks({}, { failSessionApi: true })
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "child", tool: "write", callID: "c1" }, { args: { filePath: "/repo/src/x.ts" } }),
      /could not be attributed/,
    )
  } finally {
    clearLoop("drv")
  }
})

test("no live loop → no session walk, edits pass through", async () => {
  const hooks = await makeHooks({}, { failSessionApi: true }) // API failure must not matter when nothing is live
  await hooks["tool.execute.before"]({ sessionID: "any", tool: "write", callID: "c1" }, { args: { filePath: "/anywhere/x.ts" } })
})
