import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
});
/** Leading `---\n…\n---` frontmatter block, then the body. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
/** Derive the task id from its filename (`add-foo.md` → `add-foo`). */
export const taskId = (filename) => filename.replace(/\.md$/i, "");
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
        priority: fm.priority,
        acceptance: fm.acceptance,
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
 */
export const serializeTask = (input) => {
    const fm = TaskFrontmatterSchema.parse({
        title: input.title,
        priority: input.priority,
        acceptance: input.acceptance,
    });
    const frontmatter = stringifyYaml({
        title: fm.title,
        priority: fm.priority,
        acceptance: fm.acceptance,
    }).trimEnd();
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
