/**
 * Segment-aware write backstops for loop-driven bash: the classifiers that stop a
 * stage agent from mutating PR state, pushing a branch it must never move, or
 * writing through the ADO REST API — even when a permissive allowlist glob would
 * match the command (globs compile with dotAll `*` → `.*`, so they can never
 * exclude trailing flags like `-X DELETE`).
 *
 * TWIN FILE: `plugins/claude/hooks/src/allowlist.mjs` carries the same classifiers
 * for the Claude host's PreToolUse hook (kept dependency-free so it tests under
 * bare `node --test`). Any semantic change here MUST be mirrored there — the
 * colocated `write-backstop.test.ts` and `plugins/claude/hooks/check-stage-guard.test.mjs`
 * share their vectors so the twins can't drift silently.
 */

import { stripCommandPrefix } from "../config-layers.js"
import { ADO_MCP_SERVER_NAME, ADO_READ_TOOLS, ADO_TOOLS, ADO_WRITE_TOOLS } from "../source/ado-tools.js"

/**
 * Split a bash command into chain/pipe segments at shell operators that sit
 * OUTSIDE single/double quotes. Operators inside a quoted argument (a
 * `gh pr comment --body "fixed A && B"`) are NOT split points; unquoted
 * `&&`/`||`/`|`/`;`/`&`/newlines are. Not a full shell parser — it does not
 * resolve `$()`, backticks, or backslash-escaped quotes (those remain residuals,
 * same as `task/guard.ts`) — but enough that a classifier inspects each real
 * command instead of only the first one in a chain.
 */
export const splitSegments = (cmd: string): string[] => {
  const segments: string[] = []
  let cur = ""
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === "\n" || c === "\r" || c === ";") {
      segments.push(cur)
      cur = ""
      continue
    }
    if (c === "&" && cmd[i + 1] === "&") {
      segments.push(cur)
      cur = ""
      i++
      continue
    }
    if (c === "|" && cmd[i + 1] === "|") {
      segments.push(cur)
      cur = ""
      i++
      continue
    }
    if (c === "|" || c === "&") {
      segments.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  segments.push(cur)
  return segments.map((s) => s.trim()).filter(Boolean)
}

/**
 * Shell constructs that run a command (or write a file) a glob allowlist can
 * never see through, because the globs end in `*` and compile with dotAll — so
 * `^cat .*$` matches the whole of `cat $(rm -rf docs/tasks)`.
 *
 * Quote rules follow bash, not intuition: `$( )` and backticks are STILL
 * expanded inside double quotes, so only single quotes make them inert.
 * Redirections are literal inside either kind of quote. Both `<` and `>` are
 * rejected — `>`/`>>` write, and `<(…)` is process substitution.
 *
 * Residual (shared with `splitSegments`): backslash-escaped quotes are not
 * resolved, so this is defense-in-depth, not a shell sandbox.
 *
 * TWIN: `plugins/claude/hooks/src/allowlist.mjs` carries the identical scanner
 * for the Claude host's PreToolUse hook. Keep the two in step.
 */
export const hasShellExpansion = (seg: string): boolean => {
  let quote: string | null = null
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      // bash expands these inside double quotes
      else if (c === "`" || (c === "$" && seg[i + 1] === "(")) return true
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === "`" || (c === "$" && seg[i + 1] === "(") || c === ">" || c === "<") return true
  }
  return false
}

/**
 * `find` action flags that execute commands (`-exec`, `-execdir`, `-ok`, `-okdir`)
 * or write to the filesystem (`-delete`, `-fprint`/`-fprintf`/`-fprint0`, `-fls`).
 * The check-stage read allowlists carry `find *`, which compiles to `^find .*$`
 * with dotAll — so `find . -exec rm {} +` and `find . -delete` are single
 * segments the glob happily matches, with none of the substitution/redirection
 * characters `hasShellExpansion` rejects. find is an execution primitive behind a
 * read-shaped name; the glob can never exclude a trailing flag, so this
 * classifier must.
 *
 * TWIN: `plugins/claude/hooks/src/allowlist.mjs` folds the identical classifier
 * into `commandAllowed`; here the chained variant is applied to check-stage bash
 * by the OpenCode host, whose allowlist (agent frontmatter `permission.bash`)
 * cannot express a flag exclusion.
 */
export const FIND_MUTATING_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fprint0", "-fls"])

/**
 * A `find` segment carrying a mutating action flag. Token equality, not substring:
 * a quoted pattern (`-name '-delete'`) keeps its quote characters after
 * whitespace-split and so never equals the bare flag; an UNQUOTED `-delete`
 * anywhere in the argv is indistinguishable from the flag and is rejected —
 * fail-safe, matching find's own parsing.
 */
export const isFindMutation = (seg: string): boolean => {
  const tokens = seg.trim().split(/\s+/)
  if (tokens[0] !== "find") return false
  return tokens.some((t) => FIND_MUTATING_FLAGS.has(t))
}

/** A stage allowlist glob as a whole-segment regex. `*` → `.*`, dotAll. Pure. */
const toRe = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s")

/** Whether a command segment matches any of the stage's globs. Pure. */
export const matchesAny = (cmd: string, globs: readonly string[]): boolean => globs.some((g) => toRe(g).test(cmd.trim()))

/**
 * A bare directory change executes nothing on its own. The allowlists permit
 * exactly one compound form — `cd <dir> && <runner>` — and `splitSegments` yields
 * the `cd <dir>` as its own segment, so it must be recognized as safe for that
 * form to pass. Reject any shell metacharacter in the argument so a `cd`-prefixed
 * command substitution or further chaining can't ride through.
 */
export const isBareCd = (seg: string): boolean => /^cd\s+[^;&|<>()`$]+$/.test(seg)

/**
 * Whether EVERY chained/piped segment of `cmd` is on `globs` (a bare `cd` counts
 * as allowed). A command with no runnable segment is rejected.
 *
 * TWIN: `plugins/claude/hooks/src/allowlist.mjs` runs this as the Claude host's
 * PreToolUse check-stage guard. Ported here — not imported — because that file
 * must stay dependency-free; the shared test vectors keep the two honest.
 *
 * Core's own caller is `workflow/discovered-checks.ts`, which admits a
 * model-discovered check command only when the consuming stage's own allowlist
 * would have let its agent run it. That is what caps discovery: a check the
 * driver runs bypasses the allowlist entirely (`manifest/schema.ts`), so without
 * this the plan document — repo content — would be an unfiltered shell channel.
 */
export const commandAllowed = (cmd: string, globs: readonly string[], prefixes: readonly string[] = []): boolean => {
  const segments = splitSegments(cmd)
  if (segments.some(hasShellExpansion)) return false
  // Raw AND one-hop-stripped, like the chained classifiers below: with a
  // `bashAllowlistPrefix` configured the globs carry derived `<prefix> find *`
  // twins, so `rtk find . -delete` matches a glob while the raw segment's
  // `tokens[0]` is `rtk`, not `find` — prefix-blind, the classifier never fires.
  if (segments.some((s) => isFindMutation(s) || (prefixes.length > 0 && isFindMutation(stripCommandPrefix(s, prefixes))))) return false
  return segments.length > 0 && segments.every((s) => isBareCd(s) || matchesAny(s, globs))
}

/**
 * A `gh` command that mutates a pull request. The loop must NEVER merge, close,
 * approve, or otherwise change PR state:
 *
 *  - `gh pr merge|close|ready|edit|lock|unlock|review` — state changes / approvals
 *    (the sitter replies with `gh pr comment`, never these);
 *  - `gh api` with a non-GET/POST method (PUT/PATCH/DELETE) or hitting a `/merge`
 *    endpoint — GET reads and POST review-comment replies stay allowed;
 *  - `gh api` with any write method (including the POST implied by a body flag —
 *    `-f`/`-F`/`--field`/`--raw-field`/`--input`) to a `/reviews` or
 *    `/requested_reviewers` resource — a review submission (`event=APPROVE|…`) or a
 *    reviewer change is a PR state change even via POST.
 *
 * Evaluate PER SEGMENT (`chainedGithubPrMutation`): the `^gh` anchor means a whole
 * command starting with an allowlisted read (`gh pr view && gh api -X PUT …/merge`)
 * would otherwise slip the mutation past this classifier. The caller gates this on
 * an actively-driving loop, so a human's manual `gh pr merge` is untouched.
 */
export const isGithubPrMutation = (cmd: string): boolean => {
  const c = cmd.trim()
  if (/^gh\s+(?:-\S+\s+)*pr\s+(?:merge|close|ready|edit|lock|unlock|review)\b/.test(c)) return true
  if (/^gh\s+(?:-\S+\s+)*api\b/.test(c)) {
    if (/\/merge(?:\b|\/|\?|$)/.test(c)) return true
    const m = /(?:-X|--method)[ =]+([A-Za-z]+)/.exec(c)
    // No explicit -X but a body flag makes gh send POST — `gh api …/reviews
    // -f event=APPROVE` must not read as GET.
    const impliesBody = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:[=\s]|$)/.test(c)
    const method = m ? m[1]!.toUpperCase() : impliesBody ? "POST" : "GET"
    if (method !== "GET" && /\/(?:reviews|requested_reviewers)(?:\b|\/|\?|$)/.test(c)) return true
    return !(method === "GET" || method === "POST")
  }
  return false
}

/**
 * Split an MCP tool name into `{ server, tool }`, or null when it isn't one.
 * Deliberately wide on the server half: a user may register their own Azure
 * DevOps MCP server under any name, and the backstop should still recognize it.
 */
const parseAdoMcpTool = (toolName: string): { server: string; tool: string } | null => {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (!m?.[1] || !m[2]) return null
  const server = m[1]
  if (server !== ADO_MCP_SERVER_NAME && !/(?:azure|ado|devops)/i.test(server)) return null
  return { server, tool: m[2] }
}

/** Whether this tool call reaches Azure DevOps at all. */
export const isAdoMcpTool = (toolName: string): boolean => parseAdoMcpTool(toolName) !== null

/**
 * An Azure DevOps MCP tool call the loop must never make.
 *
 * Driven by the explicit `ADO_READ_TOOLS` / `ADO_WRITE_TOOLS` sets rather than a
 * name pattern, and FAIL-CLOSED: a tool in neither set is a violation. That
 * inversion matters. The previous check allow-listed by name SHAPE, which meant
 * every mutator whose name didn't happen to match its regex sailed through —
 * and the shipped surface has several (`repo_create_branch`,
 * `pipelines_run_pipeline`, `pipelines_update_build_stage`). Enumerating what is
 * PERMITTED is the only version of this that stays correct as the server grows.
 *
 * One argument-level rule survives: `repo_create_pull_request` is allowed only
 * with `isDraft: true`. A loop-opened PR must never look review-ready before a
 * human has seen it — the rule the old comment here said it could not enforce
 * because draftness "lives in tool ARGUMENTS this name-level check can't see".
 */
export const isAdoMcpWriteViolation = (toolName: string, args: Readonly<Record<string, unknown>> = {}): boolean => {
  const parsed = parseAdoMcpTool(toolName)
  if (!parsed) return false
  const { tool } = parsed
  if (ADO_READ_TOOLS.includes(tool)) return false
  if (!ADO_WRITE_TOOLS.includes(tool)) return true
  if (tool === ADO_TOOLS.createPr) return args["isDraft"] !== true
  return false
}

/**
 * An ADO tool call outside the budget the running stage's manifest grants
 * (`effectivePlatformTools`). This is the per-stage precision the old
 * name-matching check deferred as "future work" — with the tool list generated
 * from the manifest, an off-menu tool is off-menu by definition. An EMPTY
 * allowed list means the stage declares no ADO tools, so every ADO call is out
 * of scope.
 */
export const isAdoMcpToolOutOfStageScope = (toolName: string, allowed: readonly string[]): boolean => {
  const parsed = parseAdoMcpTool(toolName)
  if (!parsed) return false
  return !allowed.includes(parsed.tool)
}

/**
 * A `git push` that could move a branch the loop must never move. The sitters push
 * ONLY their own head fast-forward, never the watched or default branch, never
 * force. On top of any push allowlist glob, reject:
 *  - any force (`-f`, `--force`, `--force-with-lease`) or a delete (`-d`, `--delete`,
 *    `:dst` with empty src), including bundled short-flag clusters (`-fd`);
 *  - a `+`-prefixed refspec (a forced ref update);
 *  - a `src:dst` refspec whose destination differs from its source;
 *  - any refspec naming a protected branch (`main`/`master`, bare or as `:dst`) or a
 *    bare `HEAD` — a fast-forward `git push origin main` has no force flag and no
 *    mismatched refspec, and `HEAD` is statically unresolvable. Residual: a PR whose
 *    head branch is literally named main/master parks — fail-safe.
 *
 * `extra` adds to `PROTECTED_BRANCH_FLOOR` (the repo's `protectedBranches`), for a
 * team whose integration branch is `release/2.4` rather than the repo default. It is
 * additive ONLY: the floor cannot be configured away, because a config that could
 * unprotect `main` is a config that can be wrong about the one branch that matters.
 * Deliberately NOT `prBase` — where PRs target and what agents may not push are
 * separate policies, and an integration branch the loop IS allowed to push is a
 * legitimate setup.
 * The `refs/heads/` prefix is normalized so `x:refs/heads/x` (same branch) passes.
 * Gated on an actively-driving loop by the caller, so a human's manual push is untouched.
 */
export const PROTECTED_BRANCH_FLOOR: readonly string[] = ["main", "master", "HEAD"]

export const isGitPushViolation = (cmd: string, extra: readonly string[] = []): boolean => {
  const c = cmd.trim()
  if (!/^git\s+(?:-\S+\s+|-C\s+\S+\s+)*push\b/.test(c)) return false
  if (/(?:^|\s)(?:--force(?:-with-lease(?:=\S*)?)?|--delete)(?:\s|$)/.test(c)) return true
  // Short flags are walked per token so the short delete form (`-d`) and
  // bundled clusters (`-fd`, `-df`) are caught, not just a lone `-f`.
  if (c.split(/\s+/).some((t) => /^-[a-zA-Z]+$/.test(t) && /[fd]/.test(t))) return true
  const bare = (ref: string): string => ref.replace(/^refs\/heads\//, "")
  const guarded = extra.length === 0 ? PROTECTED_BRANCH_FLOOR : [...PROTECTED_BRANCH_FLOOR, ...extra.map(bare)]
  const protectedRef = (ref: string): boolean => guarded.includes(bare(ref))
  const tokens = c.split(/\s+/)
  let refspecs = 0
  for (let i = tokens.indexOf("push") + 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith("-")) continue // flag/option, not a refspec
    if (t.startsWith("+")) return true // forced ref update (+src:dst or +ref)
    if (++refspecs === 1) continue // the first non-flag argument is the remote, not a refspec
    const ci = t.indexOf(":")
    if (ci === -1) {
      if (protectedRef(t)) return true // fast-forward push of the default branch (or HEAD)
      continue
    }
    const src = t.slice(0, ci)
    const dst = t.slice(ci + 1)
    if (src === "") return true // delete form (:dst)
    if (dst && bare(dst) !== bare(src)) return true // pushing onto a different-named branch
    if (dst && protectedRef(dst)) return true // main:main etc. — still the default branch
  }
  return false
}

/**
 * The write backstops evaluated PER chain/pipe segment. The classifiers anchor on
 * a single command, so a whole-command scan lets a chained allowlisted read hide a
 * mutation (`gh pr view && gh api -X PUT …/merge`). Splitting first closes the bypass.
 *
 * `prefixes` (config `bashAllowlistPrefix`) closes the same bypass one layer up.
 * Every classifier here anchors on the BARE tool name, so a command-rewriting
 * proxy defeats all of them at once: `rtk git push --force origin main`,
 * `rtk gh pr merge 3` and `rtk find . -delete` each read as no violation. The
 * allowlist cannot cover for that — with the prefix configured, `rtk git push
 * origin main` matches a derived `rtk git push origin *` glob quite legitimately,
 * and only `isGitPushViolation` knows `main` is protected. So each segment is
 * classified BOTH raw and stripped, and a hit either way is a violation: nothing
 * that trips today can stop tripping.
 *
 * Unset prefixes reduce this to the previous behaviour exactly.
 */
const eitherForm = (cmd: string, prefixes: readonly string[], classify: (seg: string) => boolean): boolean =>
  splitSegments(cmd).some((seg) => classify(seg) || (prefixes.length > 0 && classify(stripCommandPrefix(seg, prefixes))))

export const chainedGithubPrMutation = (cmd: string, prefixes: readonly string[] = []): boolean =>
  eitherForm(cmd, prefixes, isGithubPrMutation)
export const chainedGitPushViolation = (cmd: string, prefixes: readonly string[] = [], extra: readonly string[] = []): boolean =>
  eitherForm(cmd, prefixes, (seg) => isGitPushViolation(seg, extra))
export const chainedFindMutation = (cmd: string, prefixes: readonly string[] = []): boolean =>
  eitherForm(cmd, prefixes, isFindMutation)
