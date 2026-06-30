import { z } from "zod"
import { parse as parseYaml } from "yaml"

/**
 * Task schema for the filesystem backlog.
 *
 * A task is one markdown file: a YAML frontmatter block (validated here) plus a
 * free-form body. The folder the file lives in is its status — there is no
 * `status:` field, so the two can never drift. This module is **pure**: it parses
 * and validates text and never touches the filesystem (that is `store.ts`).
 */

export const TaskFrontmatterSchema = z.object({
  /** Required. The one-line task title; also the loop goal's headline. */
  title: z.string().min(1, "title is required"),
  /** Selection order — lower runs first. Defaults to 0. */
  priority: z.number().int().default(0),
  /** Testable criteria threaded into the verify stage. Optional. */
  acceptance: z.array(z.string()).default([]),
})

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>

export interface Task {
  /** Stable id = the filename without its `.md` extension. */
  readonly id: string
  readonly title: string
  readonly priority: number
  readonly acceptance: readonly string[]
  /** The free-form markdown body after the frontmatter. */
  readonly body: string
  /** Absolute path to the task file on disk. */
  readonly path: string
}

/** Leading `---\n…\n---` frontmatter block, then the body. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Derive the task id from its filename (`add-foo.md` → `add-foo`). */
export const taskId = (filename: string): string => filename.replace(/\.md$/i, "")

/**
 * Parse and validate a task file. Throws a readable, filename-prefixed error when
 * the frontmatter is missing, not valid YAML, or fails the schema.
 */
export const parseTask = (filename: string, content: string, path: string): Task => {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) {
    throw new Error(`${filename}: missing YAML frontmatter (expected a leading --- block)`)
  }
  const [, yamlBlock, body] = match

  let raw: unknown
  try {
    raw = parseYaml(yamlBlock ?? "")
  } catch (err) {
    throw new Error(`${filename}: invalid YAML frontmatter (${(err as Error).message})`)
  }

  const result = TaskFrontmatterSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")
    throw new Error(`${filename}: ${detail}`)
  }

  const fm = result.data
  return {
    id: taskId(filename),
    title: fm.title,
    priority: fm.priority,
    acceptance: fm.acceptance,
    body: (body ?? "").trim(),
    path,
  }
}
