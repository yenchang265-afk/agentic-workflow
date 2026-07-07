import { z } from "zod";
/**
 * Task schema for the filesystem backlog.
 *
 * A task is one markdown file: a YAML frontmatter block (validated here) plus a
 * free-form body. The folder the file lives in is its status — there is no
 * `status:` field, so the two can never drift. This module is **pure**: it parses
 * and validates text and never touches the filesystem (that is `store.ts`).
 *
 * The optional fields (`type`, `labels`, `assignee`, `estimate`, `tracker`) are
 * modelled on the fields Jira issues and Azure DevOps work items have in common,
 * so a human can eyeball a task file next to a tracker item and **manually pair
 * them** — copy the issue key/id into `tracker.key` and the shared attributes
 * across. Field name → tracker mapping:
 *
 * | this schema  | Jira issue        | Azure DevOps work item |
 * | ------------ | ----------------- | ---------------------- |
 * | `title`      | Summary           | Title                  |
 * | `body`       | Description       | Description            |
 * | `acceptance` | Acceptance Crit.  | Acceptance Criteria    |
 * | `type`       | Issue Type        | Work Item Type         |
 * | `priority`   | Priority          | Priority               |
 * | `labels`     | Labels            | Tags                   |
 * | `assignee`   | Assignee          | Assigned To            |
 * | `estimate`   | Story Points      | Story Points / Effort  |
 * | `tracker`    | Issue Key + link  | Work Item ID + link    |
 *
 * Everything past `title` is optional, so pre-existing task files still parse.
 */
/** The project-management trackers a task can be paired to. */
export declare const TRACKER_SYSTEMS: readonly ["jira", "azure-devops"];
export type TrackerSystem = (typeof TRACKER_SYSTEMS)[number];
/** The tracker a task is paired to. `system` + `key` together identify the item. */
export declare const TaskTrackerSchema: z.ZodObject<{
    system: z.ZodEnum<{
        jira: "jira";
        "azure-devops": "azure-devops";
    }>;
    key: z.ZodString;
    url: z.ZodOptional<z.ZodString>;
    parent: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type TaskTracker = z.infer<typeof TaskTrackerSchema>;
export declare const TaskFrontmatterSchema: z.ZodObject<{
    title: z.ZodString;
    type: z.ZodOptional<z.ZodString>;
    priority: z.ZodDefault<z.ZodNumber>;
    estimate: z.ZodOptional<z.ZodNumber>;
    assignee: z.ZodOptional<z.ZodString>;
    labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
    acceptance: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tracker: z.ZodOptional<z.ZodObject<{
        system: z.ZodEnum<{
            jira: "jira";
            "azure-devops": "azure-devops";
        }>;
        key: z.ZodString;
        url: z.ZodOptional<z.ZodString>;
        parent: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
export interface Task {
    /** Stable id = the filename without its `.md` extension. */
    readonly id: string;
    readonly title: string;
    readonly type?: string;
    readonly priority: number;
    readonly estimate?: number;
    readonly assignee?: string;
    readonly labels: readonly string[];
    readonly acceptance: readonly string[];
    /** The tracker item this task is paired to, if any. */
    readonly tracker?: TaskTracker;
    /** The free-form markdown body after the frontmatter. */
    readonly body: string;
    /** Absolute path to the task file on disk. */
    readonly path: string;
}
/** Derive the task id from its filename (`add-foo.md` → `add-foo`). */
export declare const taskId: (filename: string) => string;
/** Whether a task is paired to a tracker item (has a `tracker` block). Pure. */
export declare const isPaired: (task: Pick<Task, "tracker">) => boolean;
/**
 * Parse and validate a task file. Throws a readable, filename-prefixed error when
 * the frontmatter is missing, not valid YAML, or fails the schema.
 */
export declare const parseTask: (filename: string, content: string, path: string) => Task;
/** Fields for a new task. `title` is required; the rest default like the schema. */
export interface TaskInput {
    readonly title: string;
    readonly type?: string;
    readonly priority?: number;
    readonly estimate?: number;
    readonly assignee?: string;
    readonly labels?: readonly string[];
    readonly acceptance?: readonly string[];
    readonly tracker?: TaskTracker;
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
 * Optional fields are emitted only when set, keeping paired-and-unpaired files
 * side by side clean.
 */
export declare const serializeTask: (input: TaskInput) => string;
/**
 * Build a task file with an id that does not collide with `taken` (existing ids,
 * without the `.md`). On a clash the slug gets a numeric suffix (`-2`, `-3`, …).
 * Pure: it decides the id and content; writing to disk is `store.writeTask`.
 */
export declare const buildTaskFile: (input: TaskInput, taken?: Iterable<string>) => TaskFile;
