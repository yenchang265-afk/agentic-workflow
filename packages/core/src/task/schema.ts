import { z } from "zod"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

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
export const TRACKER_SYSTEMS = ["jira", "azure-devops"] as const
export type TrackerSystem = (typeof TRACKER_SYSTEMS)[number]

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
})

export type TaskTracker = z.infer<typeof TaskTrackerSchema>

/**
 * Coerce one YAML-parsed list item back to a string.
 *
 * Hand- and LLM-authored frontmatter routinely trips the YAML colon-space
 * footgun: a block-sequence entry like `- Dashboard shows: ticker, price`
 * parses as a single-key MAP (`{ "Dashboard shows": "ticker, price" }`), not
 * the string the author meant. A strict `z.array(z.string())` would then
 * reject a plainly-valid task file — and because `findByIdIn` swallows the
 * parse error to `null`, every gate would toast a misleading "no task found"
 * for a file that is right there on disk. Reconstruct the original
 * `key: value` text so these files parse; coerce bare scalars (e.g. a numeric
 * ticker) via String(). Pure.
 */
const coerceListItem = (v: unknown): string => {
  if (typeof v === "string") return v
  if (v === null || v === undefined) return ""
  if (Array.isArray(v)) return v.map(coerceListItem).join(", ")
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => (val === null || val === undefined ? `${k}:` : `${k}: ${coerceListItem(val)}`))
      .join(", ")
  }
  return String(v)
}

/**
 * A YAML string-list field (`acceptance`, `labels`) that tolerates the
 * colon-space footgun above by normalizing every item to a string before
 * validation. An absent field still defaults to `[]`.
 */
const StringListSchema = z.preprocess(
  (v) => (Array.isArray(v) ? v.map(coerceListItem) : v),
  z.array(z.string()),
)

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
  labels: StringListSchema.default([]),
  /** Testable criteria threaded into the verify stage. (Acceptance Criteria) Optional. */
  acceptance: StringListSchema.default([]),
  /** The tracker item this task is paired to. Optional; set it to link a task. */
  tracker: TaskTrackerSchema.optional(),
})

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>

export interface Task {
  /** Stable id = the filename without its `.md` extension. */
  readonly id: string
  readonly title: string
  readonly type?: string
  readonly priority: number
  readonly estimate?: number
  readonly assignee?: string
  readonly labels: readonly string[]
  readonly acceptance: readonly string[]
  /** The tracker item this task is paired to, if any. */
  readonly tracker?: TaskTracker
  /** The free-form markdown body after the frontmatter. */
  readonly body: string
  /** Absolute path to the task file on disk. */
  readonly path: string
}

/** Leading `---\n…\n---` frontmatter block, then the body. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Derive the task id from its filename (`f7k3-add-foo.md` → `f7k3-add-foo`). */
export const taskId = (filename: string): string => filename.replace(/\.md$/i, "")

/** Length of the leading short-hash segment on a modern task id. */
export const SHORT_ID_LEN = 4
const SHORT_ID_DIGITS = "0123456789"
const SHORT_ID_ALPHABET = `${SHORT_ID_DIGITS}abcdefghijklmnopqrstuvwxyz`
/**
 * A "modern" id is `<hash>-<slug>` where `<hash>` is a fixed-length base36 mint
 * that ALWAYS carries at least one digit (guaranteed by `mintShortId`). That
 * digit is the discriminator: a legacy slug whose first word is exactly
 * `SHORT_ID_LEN` all-letter chars (`rate-limiting`, `code-review`, `auth-fix`)
 * has the same `<4>-` shape, so shape alone is ambiguous — requiring a digit in
 * the leading segment rules those out and keeps their full id as the handle. A
 * legacy slug that happens to carry a digit in its first four chars (`utf8-fix`)
 * is a rare, benign false positive: it still resolves by its exact full id.
 */
export const SHORT_ID_RE = new RegExp(`^(?=[a-z0-9]{${SHORT_ID_LEN}}-)[a-z0-9]*[0-9][a-z0-9]*-`)

/** The short-hash handle for an id: the leading segment on a modern id, else the whole id. */
export const shortIdOf = (id: string): string => (SHORT_ID_RE.test(id) ? id.slice(0, SHORT_ID_LEN) : id)

/**
 * Mint a random `SHORT_ID_LEN`-char base36 short hash carrying at least one digit,
 * so `SHORT_ID_RE` can tell a mint apart from an all-letter legacy slug. Impure
 * (host RNG).
 */
export const mintShortId = (rand: () => number = Math.random): string => {
  const pick = (alphabet: string): string => alphabet[Math.floor(rand() * alphabet.length)]!
  let s = ""
  for (let i = 0; i < SHORT_ID_LEN; i++) s += pick(SHORT_ID_ALPHABET)
  if (/[0-9]/.test(s)) return s
  // No digit landed — force one into a random slot so the mint stays detectable.
  const pos = Math.floor(rand() * SHORT_ID_LEN)
  return s.slice(0, pos) + pick(SHORT_ID_DIGITS) + s.slice(pos + 1)
}

/** Whether a task is paired to a tracker item (has a `tracker` block). Pure. */
export const isPaired = (task: Pick<Task, "tracker">): boolean => task.tracker !== undefined

/**
 * Double-quote the plain scalars in a frontmatter block that YAML's lexer
 * rejects outright. The colon-space footgun is survivable after parsing
 * (`coerceListItem` above), but a value STARTING with a reserved character —
 * an LLM-authored bullet like `` - `calc --help` prints usage `` — kills
 * `parseYaml` itself, and the swallowed error surfaces as a misleading "no
 * task found" at every gate. Used only as a RETRY after a failed parse, so
 * valid files are never rewritten. Quotes exactly the values that trip the
 * lexer (reserved leading character) plus `key: value` scalars containing a
 * further `: ` (the mapping-inside-a-mapping error); numbers, booleans, and
 * block starts are untouched so the schema still sees their real types. Pure.
 */
// Characters that break the YAML lexer when they START a plain scalar: the
// spec-reserved `@`/backtick, block indicators |>, tag/anchor/alias %!&*, and
// the flow indicators. Already-quoted values are deliberately NOT matched.
const RESERVED_START = /^[`@|>%!&*,[\]{}]/
const quotePlainScalars = (yamlBlock: string): string => {
  const quote = (v: string): string => `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  return yamlBlock
    .split(/\r?\n/)
    .map((line) => {
      const item = /^(\s*-\s+)(\S.*)$/.exec(line)
      if (item && (RESERVED_START.test(item[2]!) || item[2]!.includes(": "))) return `${item[1]}${quote(item[2]!)}`
      const kv = /^(\s*[A-Za-z_][\w.-]*:\s+)(\S.*)$/.exec(line)
      if (kv && (RESERVED_START.test(kv[2]!) || kv[2]!.includes(": "))) return `${kv[1]}${quote(kv[2]!)}`
      return line
    })
    .join("\n")
}

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
    // One retry with the lexer-tripping scalars quoted; a file this can't
    // rescue reports the ORIGINAL parse error, not the repair's.
    try {
      raw = parseYaml(quotePlainScalars(yamlBlock ?? ""))
    } catch {
      throw new Error(`${filename}: invalid YAML frontmatter (${(err as Error).message})`)
    }
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
    type: fm.type,
    priority: fm.priority,
    estimate: fm.estimate,
    assignee: fm.assignee,
    labels: fm.labels,
    acceptance: fm.acceptance,
    tracker: fm.tracker,
    body: (body ?? "").trim(),
    path,
  }
}

// --- Programmatic creation (the "automatic" path; parse's inverse) ---

/** Fields for a new task. `title` is required; the rest default like the schema. */
export interface TaskInput {
  readonly title: string
  readonly type?: string
  readonly priority?: number
  readonly estimate?: number
  readonly assignee?: string
  readonly labels?: readonly string[]
  readonly acceptance?: readonly string[]
  readonly tracker?: TaskTracker
  readonly body?: string
}

/** A generated task file: its id (unique among `taken`), filename, and content. */
export interface TaskFile {
  readonly id: string
  readonly filename: string
  readonly content: string
}

/** Kebab-case a title into a filename-safe slug (`"Add Rate Limit!"` → `add-rate-limit`). */
export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/**
 * Serialize a task to markdown (frontmatter + body) — the inverse of `parseTask`.
 * Validates through the same schema, so `title` is required and defaults apply.
 * Optional fields are emitted only when set, keeping paired-and-unpaired files
 * side by side clean.
 */
export const serializeTask = (input: TaskInput): string => {
  const fm = TaskFrontmatterSchema.parse({
    title: input.title,
    type: input.type,
    priority: input.priority,
    estimate: input.estimate,
    assignee: input.assignee,
    labels: input.labels,
    acceptance: input.acceptance,
    tracker: input.tracker,
  })
  // Emit title/priority/acceptance always; the rest only when meaningful.
  const out: Record<string, unknown> = { title: fm.title }
  if (fm.type !== undefined) out.type = fm.type
  out.priority = fm.priority
  if (fm.estimate !== undefined) out.estimate = fm.estimate
  if (fm.assignee !== undefined) out.assignee = fm.assignee
  if (fm.labels.length) out.labels = fm.labels
  out.acceptance = fm.acceptance
  if (fm.tracker !== undefined) {
    const t: Record<string, unknown> = { system: fm.tracker.system, key: fm.tracker.key }
    if (fm.tracker.url !== undefined) t.url = fm.tracker.url
    if (fm.tracker.parent !== undefined) t.parent = fm.tracker.parent
    out.tracker = t
  }
  const frontmatter = stringifyYaml(out).trimEnd()
  const body = (input.body ?? "").trim()
  return `---\n${frontmatter}\n---\n${body ? `${body}\n` : ""}`
}

/**
 * Build a task file whose id is `<shortHash>-<slug>` (e.g. `f7k3-add-rate-limit`):
 * a short random handle for targeting, plus the readable slug so the name shows on
 * the filesystem. `taken` is the existing ids (without `.md`) to avoid colliding
 * with. `mint` supplies the short hash — injectable so tests stay deterministic.
 * Pure given `mint`: it decides the id and content; writing to disk is `store.writeTask`.
 */
export const buildTaskFile = (input: TaskInput, taken: Iterable<string> = [], mint: () => string = mintShortId): TaskFile => {
  const content = serializeTask(input) // validates title before we bother with a slug
  const slug = slugify(input.title) || "task"
  const takenList = [...taken]
  // Dedup on the short HASH, not the whole id: the 4-char handle is what a human types
  // to target the task, so it must be unique even when the slug differs. `taken` should
  // span every status folder (see `writeTask`) so a draft can't reuse a live task's hash.
  const takenHashes = new Set(takenList.map(shortIdOf))
  const takenIds = new Set(takenList)
  // The real random mint frees a hash in ~1 try (≈1.5M space); re-roll on a clash.
  let id = `${mint()}-${slug}`
  for (let tries = 0; takenHashes.has(shortIdOf(id)) && tries < 8; tries++) id = `${mint()}-${slug}`
  // A mint that can't produce a free hash (a deterministic stub, or an exhausted RNG)
  // still needs a unique FILE — disambiguate the slug so the write never clobbers an
  // existing task or loops forever.
  for (let tries = 0; takenIds.has(id); tries++) id = `${mint()}-${slug}-${tries}`
  return { id, filename: `${id}.md`, content }
}
