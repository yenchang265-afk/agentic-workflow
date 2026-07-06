import { z } from "zod";
/**
 * Task schema for the filesystem backlog.
 *
 * A task is one markdown file: a YAML frontmatter block (validated here) plus a
 * free-form body. The folder the file lives in is its status — there is no
 * `status:` field, so the two can never drift. This module is **pure**: it parses
 * and validates text and never touches the filesystem (that is `store.ts`).
 */
export declare const TaskFrontmatterSchema: z.ZodObject<{
    title: z.ZodString;
    priority: z.ZodDefault<z.ZodNumber>;
    acceptance: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
export interface Task {
    /** Stable id = the filename without its `.md` extension. */
    readonly id: string;
    readonly title: string;
    readonly priority: number;
    readonly acceptance: readonly string[];
    /** The free-form markdown body after the frontmatter. */
    readonly body: string;
    /** Absolute path to the task file on disk. */
    readonly path: string;
}
/** Derive the task id from its filename (`add-foo.md` → `add-foo`). */
export declare const taskId: (filename: string) => string;
/**
 * Parse and validate a task file. Throws a readable, filename-prefixed error when
 * the frontmatter is missing, not valid YAML, or fails the schema.
 */
export declare const parseTask: (filename: string, content: string, path: string) => Task;
/** Fields for a new task. `title` is required; the rest default like the schema. */
export interface TaskInput {
    readonly title: string;
    readonly priority?: number;
    readonly acceptance?: readonly string[];
    readonly body?: string;
}
/** A generated task file: its id (unique among `taken`), filename, and content. */
export interface TaskFile {
    readonly id: string;
    readonly filename: string;
    readonly content: string;
}
/** Kebab-case a title into a filename-safe slug (`"Add Rate Limit!"` → `add-rate-limit`). */
export declare const slugify: (title: string) => string;
/**
 * Serialize a task to markdown (frontmatter + body) — the inverse of `parseTask`.
 * Validates through the same schema, so `title` is required and defaults apply.
 */
export declare const serializeTask: (input: TaskInput) => string;
/**
 * Build a task file with an id that does not collide with `taken` (existing ids,
 * without the `.md`). On a clash the slug gets a numeric suffix (`-2`, `-3`, …).
 * Pure: it decides the id and content; writing to disk is `store.writeTask`.
 */
export declare const buildTaskFile: (input: TaskInput, taken?: Iterable<string>) => TaskFile;
