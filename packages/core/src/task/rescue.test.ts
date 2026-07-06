import assert from "node:assert/strict"
import { test } from "node:test"
import { rescueStray } from "./store.js"

/** Mirrors makeShell in store.test.ts. */
type FakeResult = { exitCode?: number; stdout?: string; stderr?: string }

const makeShell = (handler: (cmd: string) => FakeResult, log?: string[]) => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
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

test("rescueStray moves a stray file into draft/ and returns its id", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 1 } : { exitCode: 0 }), log)
  const { id, path } = await rescueStray($, "/r", "docs/tasks", "docs/tasks/run/lost.md")
  assert.equal(id, "lost")
  assert.equal(path, "/r/docs/tasks/draft/lost.md")
  assert.ok(log.some((cmd) => cmd === "mv /r/docs/tasks/run/lost.md /r/docs/tasks/draft/lost.md"))
})

test("rescueStray refuses to clobber an existing draft", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 0 } : { exitCode: 0 }), log)
  await assert.rejects(() => rescueStray($, "/r", "docs/tasks", "docs/tasks/run/lost.md"), /already exists/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")))
})

test("rescueStray surfaces a failed mv", async () => {
  const $ = makeShell((cmd) => {
    if (cmd.startsWith("test -e")) return { exitCode: 1 }
    if (cmd.startsWith("mv ")) return { exitCode: 1, stderr: "mv: permission denied" }
    return { exitCode: 0 }
  })
  await assert.rejects(() => rescueStray($, "/r", "docs/tasks", "docs/tasks/run/lost.md"), /permission denied/)
})
