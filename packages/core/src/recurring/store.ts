import path from "node:path"
import { z } from "zod"
import { writeFileAtomic } from "../fsatomic.js"
import type { Client, Log, Shell } from "../host.js"
import { isSafeTaskId, shortIdOf, SHORT_ID_RE } from "../task/schema.js"
import {
  buildRecurringFile,
  parseRecurring,
  recurringToInput,
  serializeRecurring,
  unknownRecurringKeys,
  type RecurringDef,
  type RecurringInput,
} from "./schema.js"

/**
 * Filesystem IO for recurring definitions.
 *
 * A deliberately small surface compared with `task/store.ts`, because the model
 * is smaller: definitions live in ONE flat directory with no status subfolders,
 * so there is no move primitive and no transition graph — nothing to guard,
 * because there is nowhere to move to. The only mutations are authoring one,
 * flipping `paused`, and removing one.
 *
 * Claim markers and per-definition ledgers live under `<recurringDir>/.runs/`,
 * mirroring the sitters' `<tasksDir>/runs/<kind>/` layout. They are machine
 * state, not content: the dot prefix keeps them out of every listing.
 */

/** The directory holding claim markers and ledgers for recurring definitions. */
export const recurringRunsDir = (directory: string, recurringDir: string): string =>
  path.join(directory, recurringDir, ".runs")

/** One definition's claim-marker directory. */
export const recurringMarker = (directory: string, recurringDir: string, id: string): string =>
  path.join(recurringRunsDir(directory, recurringDir), ".claims", id)

/** One definition's ledger file. */
export const recurringLedgerPath = (directory: string, recurringDir: string, id: string): string =>
  path.join(recurringRunsDir(directory, recurringDir), `${id}.json`)

/** Repo-relative ledger path, for the client's file reader. */
export const recurringLedgerRel = (recurringDir: string, id: string): string => `${recurringDir}/.runs/${id}.json`

/**
 * What a cycle left behind. `lastRunAt` is the ONLY scheduling input — the next
 * due time is always recomputed from it (see `schedule.ts`), never stored.
 */
export const RecurringLedgerSchema = z.object({
  id: z.string(),
  /** ISO instant of the last cycle that actually completed or was capped. */
  lastRunAt: z.string().optional(),
  lastOutcome: z.enum(["done", "stop", "error"]).optional(),
  lastMessage: z.string().optional(),
  /**
   * Consecutive non-retryable failures. Observability only — it deliberately
   * does NOT feed a backoff curve. A definition that keeps failing keeps its
   * cadence and stays visible in `list`/`status`; inventing an exponential
   * backoff here would hide a broken definition rather than surface it, and
   * nothing else in this codebase backs off that way to match.
   */
  consecutiveFailures: z.number().int().nonnegative().default(0),
  updatedAt: z.string(),
})

export type RecurringLedger = z.infer<typeof RecurringLedgerSchema>

/** Read one definition's ledger; a missing or unreadable one reads as never-run. */
export const loadRecurringLedger = async (
  client: Client,
  directory: string,
  recurringDir: string,
  id: string,
  now: string,
): Promise<RecurringLedger> => {
  const empty: RecurringLedger = { id, consecutiveFailures: 0, updatedAt: now }
  const read = await client.file
    .read({ query: { path: recurringLedgerRel(recurringDir, id), directory } })
    .catch(() => null)
  const content = read?.data?.content
  if (!content) return empty
  try {
    const parsed = RecurringLedgerSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : empty
  } catch {
    return empty
  }
}

/** Write one definition's ledger atomically. */
export const saveRecurringLedger = async (
  $: Shell,
  directory: string,
  recurringDir: string,
  ledger: RecurringLedger,
): Promise<void> => {
  const dir = recurringRunsDir(directory, recurringDir)
  await $`mkdir -p ${dir}`.quiet().nothrow()
  await writeFileAtomic($, recurringLedgerPath(directory, recurringDir, ledger.id), JSON.stringify(ledger, null, 2))
}

/**
 * Every definition in the registry, id-sorted. A file that fails to parse is
 * LOGGED and skipped rather than taking the listing down with it — one typo'd
 * definition must not stop every other one from running.
 */
export const listRecurring = async (
  client: Client,
  directory: string,
  recurringDir: string,
  log?: Log,
): Promise<RecurringDef[]> => {
  const listed = await client.file.list({ query: { path: recurringDir, directory } }).catch(() => null)
  const entries = listed?.data ?? []
  const defs: RecurringDef[] = []
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.toLowerCase().endsWith(".md")) continue
    const read = await client.file
      .read({ query: { path: `${recurringDir}/${entry.name}`, directory } })
      .catch(() => null)
    const content = read?.data?.content
    if (!content) continue
    try {
      defs.push(parseRecurring(entry.name, content, entry.absolute ?? path.join(directory, recurringDir, entry.name)))
    } catch (err) {
      await log?.("warn", `recurring: skipping ${entry.name} — ${(err as Error).message}`)
    }
  }
  return defs.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * One definition by id, accepting the short-hash handle the same way the gate
 * verbs do (`pause f7k3`). Returns null when nothing matches; reports the
 * candidates when a prefix is ambiguous, so "use more characters" is actionable.
 */
export const findRecurring = async (
  client: Client,
  directory: string,
  recurringDir: string,
  query: string,
  log?: Log,
): Promise<RecurringDef | { ambiguous: string[] } | null> => {
  if (!query || !isSafeTaskId(query)) {
    if (query) await log?.("warn", `recurring: rejecting unsafe id query ${JSON.stringify(query)}`)
    return null
  }
  const defs = await listRecurring(client, directory, recurringDir, log)
  const exact = defs.find((d) => d.id === query)
  if (exact) return exact
  // Prefix match, on the short hash or on a longer prefix of the full id —
  // the same resolution rule `resolveTaskIdIn` applies to the backlog.
  const matches = defs.filter((d) => d.id.startsWith(query) || (SHORT_ID_RE.test(d.id) && shortIdOf(d.id) === query))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) return { ambiguous: matches.map((d) => d.id).sort() }
  return null
}

/** Write a new definition file, avoiding id collisions with the existing ones. */
export const writeRecurring = async (
  $: Shell,
  client: Client,
  directory: string,
  recurringDir: string,
  input: RecurringInput,
  log?: Log,
): Promise<RecurringDef> => {
  const existing = await listRecurring(client, directory, recurringDir, log)
  const file = buildRecurringFile(input, existing.map((d) => d.id))
  const dir = path.join(directory, recurringDir)
  await $`mkdir -p ${dir}`.quiet().nothrow()
  const dest = path.join(dir, file.filename)
  const wrote = await writeFileAtomic($, dest, file.content)
  if (wrote.exitCode !== 0) throw new Error(`could not write ${recurringDir}/${file.filename}`)
  return parseRecurring(file.filename, file.content, dest)
}

/**
 * Rewrite a definition in place with a patch. Refuses over off-schema
 * frontmatter keys: zod strips what it does not know, so the rewrite would
 * DELETE them — the same schema-or-nothing rule `rewriteTask` enforces on the
 * backlog. A rewrite can never move or rename the file.
 */
export const rewriteRecurring = async (
  $: Shell,
  client: Client,
  directory: string,
  recurringDir: string,
  def: RecurringDef,
  patch: Partial<RecurringInput>,
): Promise<RecurringDef> => {
  const read = await client.file
    .read({ query: { path: `${recurringDir}/${def.id}.md`, directory } })
    .catch(() => null)
  const current = read?.data?.content
  if (current) {
    const unknown = unknownRecurringKeys(current)
    if (unknown.length) {
      throw new Error(
        `${def.id} carries frontmatter this schema does not know (${unknown.join(", ")}) — ` +
          `rewriting would delete it. Remove the keys or add them to the schema first.`,
      )
    }
  }
  const content = serializeRecurring({ ...recurringToInput(def), ...patch })
  const wrote = await writeFileAtomic($, def.path, content)
  if (wrote.exitCode !== 0) throw new Error(`could not rewrite ${def.path}`)
  return parseRecurring(`${def.id}.md`, content, def.path)
}

/** Pause or resume a definition — the only in-place mutation a human makes routinely. */
export const setRecurringPaused = (
  $: Shell,
  client: Client,
  directory: string,
  recurringDir: string,
  def: RecurringDef,
  paused: boolean,
): Promise<RecurringDef> => rewriteRecurring($, client, directory, recurringDir, def, { paused })

/**
 * Delete a definition and its ledger. There is no `abandoned/`-style soft state
 * here — a definition is either in the registry or it isn't — so removal is a
 * real delete, and the caller is expected to have required `--force` and to
 * have refused while a claim marker is held.
 */
export const removeRecurring = async (
  $: Shell,
  directory: string,
  recurringDir: string,
  def: RecurringDef,
): Promise<void> => {
  await $`rm -f ${def.path}`.quiet().nothrow()
  await $`rm -f ${recurringLedgerPath(directory, recurringDir, def.id)}`.quiet().nothrow()
}
