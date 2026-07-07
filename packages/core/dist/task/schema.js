import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
export const TRACKER_SYSTEMS = ["jira", "azure-devops"];
/** The tracker a task is paired to. `system` + `key` together identify the item. */
export const TaskTrackerSchema = z.object({
    /** Which tracker this task is paired to. */
    system: z.enum(TRACKER_SYSTEMS),
    /** Jira issue key (`PROJ-123`) or Azure DevOps work item id (`1234`). */
    key: z.string().min(1, "tracker.key is required when a tracker is set"),
    /** Deep link to the item in the tracker's web UI. Optional. */
    url: z.string().url("tracker.url must be a URL").optional(),
    /** Jira Epic Link / Azure DevOps parent — the parent item's key or id. Optional. */
    parent: z.string().min(1).optional(),
});
export const TaskFrontmatterSchema = z.object({
    /** Required. The one-line task title; also the loop goal's headline. (Jira Summary / ADO Title) */
    title: z.string().min(1, "title is required"),
    /**
     * Issue type / work item type. Free-form to allow custom types, but the
     * common values pair cleanly: `story`, `task`, `bug`, `epic`, `feature`,
     * `spike`. Optional.
     */
    type: z.string().min(1).optional(),
    /**
     * Selection order — lower runs first. Defaults to 0. This is the loop's own
     * scheduling knob and is a plain integer, not the tracker's named priority
     * (Jira Highest…Lowest, ADO 1–4); map by hand when pairing.
     */
    priority: z.number().int().default(0),
    /** Story points / effort estimate. Fractional allowed (0.5, 1, 2, 3, 5, 8…). Optional. */
    estimate: z.number().nonnegative().optional(),
    /** Assignee / Assigned To — an email, username, or display name. Optional. */
    assignee: z.string().min(1).optional(),
    /** Jira labels / Azure DevOps tags. Optional; defaults to []. */
    labels: z.array(z.string()).default([]),
    /** Testable criteria threaded into the verify stage. (Acceptance Criteria) Optional. */
    acceptance: z.array(z.string()).default([]),
    /** The tracker item this task is paired to. Optional; set it to link a task. */
    tracker: TaskTrackerSchema.optional(),
});
/** Leading `---\n…\n---` frontmatter block, then the body. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
/** Derive the task id from its filename (`add-foo.md` → `add-foo`). */
export const taskId = (filename) => filename.replace(/\.md$/i, "");
/** Whether a task is paired to a tracker item (has a `tracker` block). Pure. */
export const isPaired = (task) => task.tracker !== undefined;
/**
 * Parse and validate a task file. Throws a readable, filename-prefixed error when
 * the frontmatter is missing, not valid YAML, or fails the schema.
 */
export const parseTask = (filename, content, path) => {
    const match = FRONTMATTER_RE.exec(content);
    if (!match) {
        throw new Error(`${filename}: missing YAML frontmatter (expected a leading --- block)`);
    }
    const [, yamlBlock, body] = match;
    let raw;
    try {
        raw = parseYaml(yamlBlock ?? "");
    }
    catch (err) {
        throw new Error(`${filename}: invalid YAML frontmatter (${err.message})`);
    }
    const result = TaskFrontmatterSchema.safeParse(raw);
    if (!result.success) {
        const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ");
        throw new Error(`${filename}: ${detail}`);
    }
    const fm = result.data;
    return {
        id: taskId(filename),
        title: fm.title,
        type: fm.type,
        priority: fm.priority,
        estimate: fm.estimate,
        assignee: fm.assignee,
        labels: fm.labels,
        acceptance: fm.acceptance,
        tracker: fm.tracker,
        body: (body ?? "").trim(),
        path,
    };
};
/** Kebab-case a title into a filename-safe slug (`"Add Rate Limit!"` → `add-rate-limit`). */
export const slugify = (title) => title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
/**
 * Serialize a task to markdown (frontmatter + body) — the inverse of `parseTask`.
 * Validates through the same schema, so `title` is required and defaults apply.
 * Optional fields are emitted only when set, keeping paired-and-unpaired files
 * side by side clean.
 */
export const serializeTask = (input) => {
    const fm = TaskFrontmatterSchema.parse({
        title: input.title,
        type: input.type,
        priority: input.priority,
        estimate: input.estimate,
        assignee: input.assignee,
        labels: input.labels,
        acceptance: input.acceptance,
        tracker: input.tracker,
    });
    // Emit title/priority/acceptance always; the rest only when meaningful.
    const out = { title: fm.title };
    if (fm.type !== undefined)
        out.type = fm.type;
    out.priority = fm.priority;
    if (fm.estimate !== undefined)
        out.estimate = fm.estimate;
    if (fm.assignee !== undefined)
        out.assignee = fm.assignee;
    if (fm.labels.length)
        out.labels = fm.labels;
    out.acceptance = fm.acceptance;
    if (fm.tracker !== undefined) {
        const t = { system: fm.tracker.system, key: fm.tracker.key };
        if (fm.tracker.url !== undefined)
            t.url = fm.tracker.url;
        if (fm.tracker.parent !== undefined)
            t.parent = fm.tracker.parent;
        out.tracker = t;
    }
    const frontmatter = stringifyYaml(out).trimEnd();
    const body = (input.body ?? "").trim();
    return `---\n${frontmatter}\n---\n${body ? `${body}\n` : ""}`;
};
/**
 * Build a task file with an id that does not collide with `taken` (existing ids,
 * without the `.md`). On a clash the slug gets a numeric suffix (`-2`, `-3`, …).
 * Pure: it decides the id and content; writing to disk is `store.writeTask`.
 */
export const buildTaskFile = (input, taken = []) => {
    const content = serializeTask(input); // validates title before we bother with a slug
    const base = slugify(input.title) || "task";
    const takenSet = new Set(taken);
    let id = base;
    for (let n = 2; takenSet.has(id); n++)
        id = `${base}-${n}`;
    return { id, filename: `${id}.md`, content };
};
