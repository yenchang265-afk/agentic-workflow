import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Config-layer plumbing and model-string normalization, split out of `config.ts`
 * and re-exported from it (so no import site changed).
 *
 * The split exists for one reason: **this module must stay zod-free**. Two
 * consumers cannot afford zod —
 *
 * - a bare-node `PreToolUse` hook, bundled by `scripts/build-hooks.mjs`, which
 *   inlines whatever it imports. Importing anything from `config.ts` evaluates
 *   that module's top-level zod schemas and drags the whole library into every
 *   hook bundle.
 * - OpenCode's `config` plugin hook, which runs during bootstrap where a host
 *   client call is a circular wait (see `plugins/opencode/src/impl.ts`).
 *
 * So: `node:fs`/`node:os`/`node:path` only. Do not import zod here, and do not
 * import `config.ts` (that would reintroduce the cycle this file removes).
 */

export const CONFIG_FILE = ".agentic-workflow.json"

/** Env override for the user-scope config path; set to "" to disable the layer (e.g. in CI). */
export const USER_CONFIG_ENV = "AGENTIC_WORKFLOW_USER_CONFIG"

/** New user-scope location, under the XDG config home: `<xdg>/agentic-workflow/agentic-workflow.json`. */
const USER_CONFIG_SUBPATH = ["agentic-workflow", "agentic-workflow.json"] as const
/** Pre-XDG location read as a fallback so existing installs keep working: `~/.agentic-workflow.json`. */
const LEGACY_USER_CONFIG_FILE = ".agentic-workflow.json"

/** $XDG_CONFIG_HOME when set to a non-blank value, else `~/.config`. */
const xdgConfigHome = (home: string): string => {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && xdg.trim() ? xdg : path.join(home, ".config")
}

/**
 * Where the user-scope config lives: $AGENTIC_WORKFLOW_USER_CONFIG when set ("" →
 * layer disabled) wins. Otherwise `${XDG_CONFIG_HOME:-~/.config}/agentic-workflow/agentic-workflow.json`,
 * falling back on read to the pre-XDG `~/.agentic-workflow.json` when only that
 * exists (so existing installs keep working; the XDG path is the write target for
 * new installs). Returns null when the layer is disabled or no home resolves.
 */
export const resolveUserConfigPath = (): string | null => {
  const env = process.env[USER_CONFIG_ENV]
  if (env !== undefined) return env === "" ? null : env
  const home = os.homedir()
  if (!home) return null
  const primary = path.join(xdgConfigHome(home), ...USER_CONFIG_SUBPATH)
  if (fs.existsSync(primary)) return primary
  const legacy = path.join(home, LEGACY_USER_CONFIG_FILE)
  if (fs.existsSync(legacy)) return legacy
  return primary
}

/**
 * User-scope config files that EXIST but are not the one being read.
 *
 * Exactly one user-scope file is ever loaded — the layering is user-under-repo,
 * not user-under-user — so a second one is dead weight that looks live. Two
 * ways to land here, both silent and both indistinguishable from "my setting
 * doesn't work":
 *
 * - **Shadowed:** once the XDG file exists (the hub's Config tab writes it),
 *   `~/.agentic-workflow.json` is ignored WHOLESALE, not merged under it.
 * - **Misnamed:** the two locations use different file names — dotted
 *   `~/.agentic-workflow.json` but undotted `…/agentic-workflow/agentic-workflow.json`.
 *   Writing the repo-style dotted name into the XDG dir resolves to nothing.
 *
 * Callers report these; a config that is quietly not read is the hardest
 * possible misconfig to diagnose from the symptom. Pure apart from `fs.existsSync`.
 */
export const ignoredUserConfigPaths = (chosen: string | null): string[] => {
  if (chosen === null) return [] // layer explicitly disabled — nothing is "ignored"
  const home = os.homedir()
  if (!home) return []
  const candidates = [
    path.join(home, LEGACY_USER_CONFIG_FILE),
    path.join(xdgConfigHome(home), ...USER_CONFIG_SUBPATH),
    // The repo-style dotted name inside the XDG dir: the intuitive guess, and
    // it is never read at any layer.
    path.join(xdgConfigHome(home), USER_CONFIG_SUBPATH[0], CONFIG_FILE),
  ]
  return candidates.filter((p) => p !== chosen && fs.existsSync(p))
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Field-level deep merge of raw config layers (override wins): plain objects
 * merge per key recursively; arrays, scalars, and null replace wholesale —
 * null is not a delete operator, it simply fails schema validation downstream.
 * Layers merge BEFORE the zod parse so schema defaults apply only to the
 * combined view (a repo file omitting `maxIterations` cannot clobber a
 * user-scope `maxIterations`). Pure.
 */
export const mergeConfigLayers = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfigLayers(base[key], value) : value
  }
  return out
}

/**
 * Read and JSON-parse the user-scope layer with Node fs (it lives outside the
 * project directory, beyond the host client's reach). Absent or unreadable →
 * undefined (layer not present); malformed JSON or a non-object top level →
 * throw naming the offending file, never a silent skip — this layer may carry
 * `ado.pat`/`selfLogin`, and dropping it would surface later as a baffling
 * validation error. Exported for consumers of user-scope-only sections (the
 * hub reads its `hub` section exclusively from this layer).
 */
export const readUserLayer = (userPath: string): unknown => {
  let content: string
  try {
    content = fs.readFileSync(userPath, "utf8")
  } catch {
    return undefined
  }
  if (!content.trim()) return undefined
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    throw new Error(`Invalid ${userPath}: not valid JSON (${(err as Error).message})`)
  }
  if (!isPlainObject(json)) throw new Error(`Invalid ${userPath}: top level must be a JSON object`)
  return json
}

/**
 * Config keys whose value is shell the loop executes verbatim (isolate.ts runs
 * `worktreeSetup` via raw interpolation). The repo layer rides along with any
 * cloned repo, so honoring these from `.agentic-workflow.json` would let a
 * merely-watched repo run arbitrary shell on first claim — npm-postinstall
 * class risk, silently. They are honored from the user-scope layer only.
 */
export const SHELL_BEARING_KEYS = ["worktreeSetup", "notifyCommand"] as const

/**
 * Keys INSIDE a `workflows.<kind>` section whose value is shell the loop
 * executes verbatim — the nested sibling of SHELL_BEARING_KEYS, same rule and
 * same reason. The top-level drop deletes whole keys and cannot see one level
 * down, so this is a sibling rather than a generalization into a path walker:
 * two small obviously-correct lists beat one clever one.
 */
export const SHELL_BEARING_WORKFLOW_KEYS = ["scannerCommand", "stageChecks"] as const

/**
 * Keys inside the `ado` section that decide WHERE an authenticated request goes
 * and HOW it is secured. The third sibling of the two lists above, same rule for
 * a different asset: not shell the repo can run, but the user's Personal Access
 * Token it can aim.
 *
 * `adoMcpSpawn` resolves the PAT as `env AZURE_DEVOPS_EXT_PAT ?? ado.pat` and
 * hands it to the Azure DevOps MCP server it launches against
 * `ado.organization`. Because layers merge per key, a cloned repo supplying
 * only `organization` keeps the user's PAT underneath it — and
 * `pr-sitter`/`review-sitter` poll on the first watch tick, so nobody has to
 * run anything for the token to leave. `mcp` is dropped for the same reason
 * one step further along: it names the COMMAND that gets spawned, so a repo
 * that could set it could run anything with the token in its environment.
 *
 * `project`, `repository` and `selfLogin` are NOT here: they describe this repo
 * and nothing else, and dropping them would make the rule unusable rather than
 * safe.
 */
export const ADO_USER_LAYER_ONLY_KEYS = ["organization", "pat", "mcp"] as const

/** Which drop rule claimed a repo-layer key — decides the warning's wording. */
export interface DroppedRepoKey {
  /** Dotted path as the config file spells it, e.g. `workflows.engineering.stageChecks`. */
  readonly path: string
  readonly family: "shell" | "workflowShell" | "ado"
}

/**
 * Every repo-layer key the runtime IGNORES, as dotted paths — the single
 * answer to "why is my repo config not taking effect". Pure and zod-free so
 * `loadConfig`'s warnings, `sanitizeRepoLayer`, the hub's effective view, and
 * a doctor report all read the same list and cannot drift.
 */
export const droppedRepoKeys = (repoRaw: unknown): DroppedRepoKey[] => {
  if (!isPlainObject(repoRaw)) return []
  const out: DroppedRepoKey[] = []
  for (const key of SHELL_BEARING_KEYS) if (key in repoRaw) out.push({ path: key, family: "shell" })
  const workflows = repoRaw["workflows"]
  if (isPlainObject(workflows)) {
    for (const [kind, section] of Object.entries(workflows)) {
      if (!isPlainObject(section)) continue
      for (const key of SHELL_BEARING_WORKFLOW_KEYS) {
        if (key in section) out.push({ path: `workflows.${kind}.${key}`, family: "workflowShell" })
      }
    }
  }
  const ado = repoRaw["ado"]
  if (isPlainObject(ado)) {
    for (const key of ADO_USER_LAYER_ONLY_KEYS) if (key in ado) out.push({ path: `ado.${key}`, family: "ado" })
  }
  return out
}

/**
 * The repo layer with every user-layer-only key removed — the pure half of
 * what `loadConfig` does before merging (it also warns per dropped key).
 * Never mutates its input. Sound to apply per-kind because
 * `mergeConfigLayers` merges `workflows.<kind>` per key: a repo section
 * setting `severityFloor` beside a dropped `scannerCommand` keeps its
 * severityFloor AND the user layer's scannerCommand underneath.
 */
export const sanitizeRepoLayer = (repoRaw: unknown): unknown => {
  if (!isPlainObject(repoRaw)) return repoRaw
  let out: Record<string, unknown> = repoRaw
  const without = (obj: Record<string, unknown>, key: string): Record<string, unknown> => {
    const { [key]: _dropped, ...rest } = obj
    return rest
  }
  for (const key of SHELL_BEARING_KEYS) if (key in out) out = without(out, key)
  const workflows = out["workflows"]
  if (isPlainObject(workflows)) {
    const cleaned: Record<string, unknown> = {}
    let dropped = false
    for (const [kind, section] of Object.entries(workflows)) {
      if (!isPlainObject(section)) {
        cleaned[kind] = section
        continue
      }
      let sec = section
      for (const key of SHELL_BEARING_WORKFLOW_KEYS) {
        if (!(key in sec)) continue
        sec = without(sec, key)
        dropped = true
      }
      cleaned[kind] = sec
    }
    if (dropped) out = { ...out, workflows: cleaned }
  }
  const ado = out["ado"]
  if (isPlainObject(ado)) {
    let sec = ado
    let dropped = false
    for (const key of ADO_USER_LAYER_ONLY_KEYS) {
      if (!(key in sec)) continue
      sec = without(sec, key)
      dropped = true
    }
    if (dropped) out = { ...out, ado: sec }
  }
  return out
}

/** Key names whose string values never leave a display surface unmasked. */
const SECRET_KEY_RE = /^(pat|token|secret|password|passwd|api[_-]?key)$/i

/**
 * A deep copy of a config value with secret-named string leaves replaced by
 * `"[REDACTED]"` — for DISPLAY surfaces only (a doctor report, a log line).
 * Key-name–based like the hub's `redactSecrets`, and deliberately broader than
 * today's one secret field (`ado.pat`): a future credential key is masked the
 * day it is added, not the day someone remembers this list. Pure.
 */
export const maskConfigSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(maskConfigSecrets)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_RE.test(k) && typeof v === "string" && v ? "[REDACTED]" : maskConfigSecrets(v)
  }
  return out
}

/** What `effectiveConfigReport` returns — see there. */
export interface EffectiveConfigReport {
  /** The user-scope file in effect, or null (layer disabled, or no file exists). */
  readonly userConfigPath: string | null
  /** The repo-scope file name (relative — it may not exist; then nothing was layered). */
  readonly repoConfigPath: string
  /** Repo-layer keys the runtime ignores (user-layer-only), as dotted paths. */
  readonly droppedRepoKeys: readonly string[]
  /** The config actually in force, secrets masked. Display only — never write it back. */
  readonly effective: unknown
}

/**
 * The "what configuration is actually in force, and why" report behind
 * `doctor config`. `parsedConfig` is the host's ALREADY-LOADED config — the
 * ground truth of what the process is running with — so this never re-derives
 * the merge; it only adds the two facts a loaded object cannot carry: where
 * the layers came from, and which repo-layer keys were dropped on the way in.
 * Filesystem reads are best-effort: outside a repo, or with no config files at
 * all, the report is simply "defaults, nothing dropped".
 */
export const effectiveConfigReport = (cwd: string, parsedConfig: unknown): EffectiveConfigReport => {
  let userPath: string | null = null
  try {
    const resolved = resolveUserConfigPath()
    userPath = resolved && fs.existsSync(resolved) ? resolved : null
  } catch {
    userPath = null
  }
  let repoRaw: unknown
  try {
    const content = fs.readFileSync(path.join(cwd, CONFIG_FILE), "utf8")
    repoRaw = content.trim() ? JSON.parse(content) : undefined
  } catch {
    repoRaw = undefined
  }
  return {
    userConfigPath: userPath,
    repoConfigPath: CONFIG_FILE,
    droppedRepoKeys: droppedRepoKeys(repoRaw).map((d) => d.path),
    effective: maskConfigSecrets(parsedConfig),
  }
}

/**
 * A model string without its provider prefix ("anthropic/claude-sonnet-4-5" →
 * "claude-sonnet-4-5") — for hosts that take bare model ids (Qwen's agent
 * frontmatter), so a config written OpenCode-style works on both hosts. Pure.
 *
 * NOTE this is NOT the right normalization for Claude Code's spawn tool, whose
 * `model` parameter is an alias enum — use `spawnAlias` for that.
 */
export const bareModel = (model: string): string =>
  model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model

/**
 * The only values Claude Code's `Agent` (spawn) tool accepts for `model`,
 * probed against 2.1.220. Anything else fails the tool's schema validation:
 *
 *     PreToolUse hook for Agent returned updatedInput that failed schema
 *     validation: [{ "code": "invalid_value",
 *       "values": ["sonnet","opus","haiku","fable"], "path": ["model"] }]
 *
 * and — the part that matters — a rejected `model` errors the WHOLE spawn. It
 * does not degrade to the default. So an unmappable value must be left
 * unstamped, never guessed at.
 */
export const SPAWN_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const

export type SpawnAlias = (typeof SPAWN_ALIASES)[number]

/**
 * A configured model value → the alias Claude Code's spawn tool will accept, or
 * null when it cannot be mapped.
 *
 * Matched on the model FAMILY as a substring, which is why this needs no
 * per-release maintenance: `claude-sonnet-4-5`, `claude-sonnet-5`,
 * `anthropic/claude-3-5-sonnet-20241022` and a bare `sonnet` all resolve to
 * `sonnet`. A value naming no known family (`gpt-4o`) returns null so the
 * caller leaves the spawn alone and warns, rather than hard-failing it.
 *
 * `SPAWN_ALIASES` order decides a string that somehow names two families; it is
 * fixed rather than "first occurrence" so the result never depends on id spelling.
 */
export const spawnAlias = (model: unknown): SpawnAlias | null => {
  if (typeof model !== "string") return null
  const lower = model.trim().toLowerCase()
  if (!lower) return null
  return SPAWN_ALIASES.find((alias) => lower.includes(alias)) ?? null
}

/**
 * The merged RAW config layers, read straight off disk with node fs — the
 * user-scope layer under `resolveUserConfigPath()`, the repo layer at
 * `<cwd>/.agentic-workflow.json`, repo winning per key via `mergeConfigLayers`.
 *
 * Never throws and never validates: an absent, unreadable, malformed, or
 * non-object layer is simply not there. That is deliberate, and it is the only
 * safe policy for the callers — a hook that threw would block a tool call, and
 * an OpenCode `config` hook that threw would break bootstrap. Degrading to the
 * host default beats both.
 *
 * Shell-bearing repo keys are dropped exactly as `loadConfig` drops them, so
 * this entry point can never become a way to reintroduce the "cloned repo runs
 * arbitrary shell" risk `SHELL_BEARING_KEYS` documents.
 *
 * For the two contexts that CANNOT use `loadConfig`: a bare-node `PreToolUse`
 * hook (no host client exists) and OpenCode's `config` hook (bootstrap).
 */
export const readRawConfigLayers = (cwd: string): Record<string, unknown> => {
  const read = (file: string): unknown => {
    try {
      const content = fs.readFileSync(file, "utf8")
      if (!content.trim()) return undefined
      const json: unknown = JSON.parse(content)
      return isPlainObject(json) ? json : undefined
    } catch {
      return undefined
    }
  }

  let userLayer: unknown
  try {
    const userPath = resolveUserConfigPath()
    userLayer = userPath ? read(userPath) : undefined
  } catch {
    userLayer = undefined
  }

  // The FULL drop set, not just the top-level keys: this reader used to strip
  // only SHELL_BEARING_KEYS, which made its own doc comment a lie one level
  // down — a repo-layer `workflows.<kind>.stageChecks` or `ado.organization`
  // reached the hooks that trust this function.
  const repoLayer = sanitizeRepoLayer(read(path.join(cwd, CONFIG_FILE)))

  const merged = mergeConfigLayers(userLayer ?? {}, repoLayer)
  return isPlainObject(merged) ? merged : {}
}

/**
 * The `cd <worktree> && ` prefix a worktree-pinned stage command arrives with.
 * OpenCode matches permission globs against the WHOLE command string, so every
 * allowlist glob for a worktree-isolated stage needs a twin carrying this
 * prefix — see `scripts/gen-prompts.mjs` (`allowlistFor`), which derives the
 * same twins at generation time.
 */
export const CD_TWIN_PREFIX = "cd * && "

/**
 * Each glob plus its `cd * && ` twin, deduplicated, original order kept. A glob
 * already carrying the prefix gets no double twin. Pure.
 */
export const withCdTwins = (globs: readonly string[]): string[] => {
  const out: string[] = []
  for (const glob of globs) {
    if (!out.includes(glob)) out.push(glob)
    const twin = CD_TWIN_PREFIX + glob
    if (!glob.startsWith(CD_TWIN_PREFIX) && !out.includes(twin)) out.push(twin)
  }
  return out
}

/**
 * `bashAllowlistExtra` off a raw or already-parsed config: user/project bash
 * globs appended to every allowlisted stage's grants, on top of the manifest's
 * `bashAllowlist`. The escape hatch for an environment the manifests cannot
 * know — a project-specific test runner, or a command-rewriting proxy (an rtk
 *-style token saver) whose output shape (`rtk <cmd>`) matches no shipped glob
 * and would otherwise starve every check stage into ERROR.
 *
 * Non-string, blank, and duplicate entries are dropped; a malformed value
 * degrades to no extras, never to junk travelling onward — same policy as
 * `rawAgentModel`. Pure.
 */
export const bashAllowlistExtras = (config: unknown): string[] => {
  if (!isPlainObject(config)) return []
  const raw = config.bashAllowlistExtra
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== "string") continue
    const glob = value.trim()
    if (glob && !out.includes(glob)) out.push(glob)
  }
  return out
}

/**
 * The shape a command prefix may take: whitespace-separated words of ordinary
 * command/path characters. Everything else is dropped by `bashAllowlistPrefixes`.
 *
 * A prefix is spliced in front of a stage's OWN globs, so it is the one place a
 * user string reaches the matcher ahead of the boundary rather than behind it.
 * `*` is refused for that reason: `"rtk *"` as a prefix would derive
 * `rtk * npm test*`, re-admitting the arbitrary middle the derivation exists to
 * remove. Shell metacharacters are refused because a prefix is a command head,
 * never a fragment of shell syntax. Multi-word prefixes are legal — `rtk proxy`
 * is a real one.
 */
const PREFIX_SHAPE = /^[A-Za-z0-9_@./+-]+(?: [A-Za-z0-9_@./+-]+)*$/

/**
 * `bashAllowlistPrefix` off a raw or already-parsed config: command prefixes a
 * rewriting proxy puts in front of the command a stage actually asked for.
 *
 * Malformed entries are dropped INDIVIDUALLY rather than degrading the whole
 * list, and the failure direction is narrow: a dropped prefix starves the stage
 * (visible, one config fix) where an admitted junk prefix widens the boundary
 * silently. Pure.
 */
export const bashAllowlistPrefixes = (config: unknown): string[] => {
  if (!isPlainObject(config)) return []
  const raw = config.bashAllowlistPrefix
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== "string") continue
    const prefix = value.trim()
    if (prefix && PREFIX_SHAPE.test(prefix) && !out.includes(prefix)) out.push(prefix)
  }
  return out
}

/**
 * Each glob plus a `<prefix> <glob>` variant per configured prefix, deduplicated,
 * original order kept. The narrow answer to a command-REWRITING proxy: instead of
 * one blanket `"rtk *"` extra — which accepts `rtk npm publish` as readily as
 * `rtk npm test` — every glob the stage ALREADY declares is re-expressed behind
 * the proxy, and nothing else is.
 *
 * Two globs are skipped as sources. One already carrying a configured prefix
 * (a user's own `rtk *` extra) would otherwise derive `rtk rtk *`. One carrying
 * `CD_TWIN_PREFIX` is skipped because the chained shape is produced by running
 * `withCdTwins` over the RESULT — the proxies rewrite per chain segment
 * (`cd <wt> && git status` → `cd <wt> && rtk git status`), so the twin belongs
 * outside the prefix, not inside it. Pure.
 */
export const withCommandPrefixes = (globs: readonly string[], prefixes: readonly string[]): string[] => {
  const out: string[] = []
  for (const glob of globs) {
    if (!out.includes(glob)) out.push(glob)
    if (glob.startsWith(CD_TWIN_PREFIX)) continue
    if (prefixes.some((p) => glob.startsWith(`${p} `))) continue
    for (const prefix of prefixes) {
      const derived = `${prefix} ${glob}`
      if (!out.includes(derived)) out.push(derived)
    }
  }
  return out
}

/**
 * A command segment with one leading configured prefix removed, or the segment
 * unchanged when it carries none.
 *
 * The write backstops (`isGitPushViolation`, `isGithubPrMutation`,
 * `isFindMutation`) all anchor on the bare tool name, so a rewritten segment —
 * `rtk git push --force origin main`, `rtk gh pr merge 3`, `rtk find . -delete` —
 * slips every one of them. The allowlist cannot stand in for those checks: a
 * derived `rtk git push origin *` glob legitimately matches, and only
 * `isGitPushViolation` knows `main` is protected. So each classifier is asked
 * about the stripped form as well.
 *
 * Exactly ONE hop is stripped: that is what a proxy emits, and a loop would let
 * `rtk rtk …` launder a second layer past a classifier the first hop already
 * defeated.
 *
 * LONGEST prefix first, and that ordering is load-bearing whenever one prefix
 * is a prefix of another — `["rtk", "rtk proxy"]` is the ordinary case, since a
 * proxy's own escape hatch usually lives under its name. Taking `"rtk "` off
 * `rtk proxy git push origin main` leaves `proxy git push …`, which no
 * classifier recognizes, and the derived `rtk proxy git push origin *` glob
 * admits the command — the exact laundering the strip exists to stop. Pure.
 */
export const stripCommandPrefix = (segment: string, prefixes: readonly string[]): string => {
  const seg = segment.trim()
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    const head = `${prefix} `
    if (seg.startsWith(head)) return seg.slice(head.length).trim()
  }
  return seg
}

/**
 * `agentModels.<agent>` off a raw or already-parsed config; anything that is not
 * a non-blank string reads as unset, so a malformed value degrades to the host
 * default instead of travelling onward as junk.
 *
 * `bare` strips a `provider/` prefix. Callers that need Claude Code's spawn
 * enum want `spawnAlias` on the result instead — see its docstring for why a
 * bare id is not good enough there.
 */
export const rawAgentModel = (config: unknown, agent: string, opts?: { readonly bare?: boolean }): string | null => {
  if (!isPlainObject(config)) return null
  const models = config.agentModels
  if (!isPlainObject(models)) return null
  const value = models[agent]
  if (typeof value !== "string" || !value.trim()) return null
  const trimmed = value.trim()
  return opts?.bare ? bareModel(trimmed) : trimmed
}

/** One workflow kind's stage roster, as much of it as agent→model resolution needs. */
export interface KindStages {
  readonly kind: string
  readonly stages: readonly { readonly name: string; readonly agent?: string }[]
}

/**
 * Resolve agent → model from a merged config plus the workflow manifests.
 *
 * `agentModels.<agent>` is the explicit per-agent knob and wins outright.
 * Otherwise an agent inherits the model configured for the STAGE it backs, via
 * each kind's manifest. An agent backing two kinds' stages with different
 * models is a genuine ambiguity, so it is reported AND left unset rather than
 * silently resolved — `workflow-verify` is shared by four kinds today. An
 * explicit `agentModels.<agent>` still resolves it, which is the documented
 * way out.
 *
 * Promoted here from `scripts/qwen-agents.mjs` so the installer and core share
 * one `bareModel`: the local copy stripped only the FIRST path segment, so
 * `openrouter/anthropic/claude-sonnet-4-5` baked as `anthropic/claude-sonnet-4-5`
 * on Qwen while Claude resolved it to `claude-sonnet-4-5`.
 */
export const resolveAgentModels = (
  config: unknown,
  manifests: readonly KindStages[],
  opts?: { readonly bare?: boolean },
): { readonly models: Readonly<Record<string, string>>; readonly conflicts: readonly string[] } => {
  const bare = opts?.bare ?? true
  const norm = (model: string): string => (bare ? bareModel(model) : model)
  const models: Record<string, string> = {}
  const conflicts: string[] = []
  // Agents whose stage models disagreed. A conflict must leave the agent
  // UNSET, which is what the docs above and the installer's warning both
  // promise: `continue`-ing on the clash kept whichever kind was iterated
  // first (manifests are read in directory order), so the operator was told
  // "leaving the model unset for that agent" while an arbitrary one was in
  // fact baked in. Membership is tracked separately from `models` because a
  // LATER binding for the same agent must not resurrect it.
  const conflicted = new Set<string>()
  const workflows = isPlainObject(config) && isPlainObject(config.workflows) ? config.workflows : {}
  for (const { kind, stages } of manifests) {
    const kindConfigRaw = workflows[kind]
    const stageModels = isPlainObject(kindConfigRaw) && isPlainObject(kindConfigRaw.stageModels) ? kindConfigRaw.stageModels : {}
    for (const stage of stages) {
      const model = stageModels[stage.name]
      if (typeof model !== "string" || !model.trim() || !stage.agent) continue
      const value = norm(model.trim())
      if (conflicted.has(stage.agent)) {
        conflicts.push(`${stage.agent}: unset (conflicting stage models) vs "${value}" (${kind}.${stage.name})`)
        continue
      }
      if (models[stage.agent] && models[stage.agent] !== value) {
        conflicts.push(`${stage.agent}: "${models[stage.agent]}" vs "${value}" (${kind}.${stage.name})`)
        conflicted.add(stage.agent)
        delete models[stage.agent]
        continue
      }
      models[stage.agent] = value
    }
  }
  const agentModels = isPlainObject(config) && isPlainObject(config.agentModels) ? config.agentModels : {}
  for (const [agent, model] of Object.entries(agentModels)) {
    if (typeof model === "string" && model.trim()) models[agent] = norm(model.trim())
  }
  return { models, conflicts }
}
