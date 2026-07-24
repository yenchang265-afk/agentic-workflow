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

/** A Bash command that calls the Azure DevOps REST API (curl against an ADO host). */
export const isAdoCurl = (cmd: string): boolean =>
  /\bcurl\b/.test(cmd) && /https?:\/\/(?:dev\.azure\.com|[a-z0-9.-]+\.visualstudio\.com)\//i.test(cmd)

/** The effective HTTP method of a curl: an explicit -X/--request wins, else a body
 *  flag (-d, --data-*, -F, --form) implies POST, else GET. */
export const curlMethod = (cmd: string): string => {
  const explicit = /(?:-X|--request)[ =]+([A-Za-z]+)/.exec(cmd)
  if (explicit) return explicit[1]!.toUpperCase()
  return /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\b/.test(cmd) ? "POST" : "GET"
}

/**
 * A curl against Azure DevOps that mutates state beyond what the sitter family is
 * allowed: only GET reads, a thread-comment reply (POST to a `/threads` resource),
 * and creating a brand-new pull request (POST to a bare `…/pullrequests`
 * collection) pass. Everything else — PATCH/PUT/DELETE, or a POST to any other
 * pull-request sub-resource — is a mutation the loop must never make. The
 * `(?![a-zA-Z0-9/])` lookahead tells "create" apart from "act on an existing PR"
 * (a sub-path starts with `/`, an id segment with an alphanumeric).
 */
export const isAdoWriteBackstopViolation = (cmd: string): boolean => {
  if (!isAdoCurl(cmd)) return false
  const method = curlMethod(cmd)
  const targetsThread = /\/threads(?:\/|\?|\b)/i.test(cmd)
  const createsNewPr = /\/pullrequests(?![a-zA-Z0-9/])/i.test(cmd)
  return !(method === "GET" || (method === "POST" && (targetsThread || createsNewPr)))
}

/** An `az` CLI call against Azure DevOps (the azure-devops extension's command
 *  groups, plus the generic `az devops invoke` REST escape hatch). */
export const isAdoAz = (cmd: string): boolean => /^az\s+(?:repos|pipelines|boards|devops)\b/.test(cmd.trim())

/**
 * An `az` CLI call that mutates Azure DevOps state beyond what the sitter family
 * is allowed — the az mirror of `isAdoWriteBackstopViolation`. The loop reaches
 * ADO only over REST, so this is defense-in-depth against an az CLI slipping
 * onto PATH, never a path the loop takes. Allowed writes: `az repos pr create`
 * ONLY with `--draft`,
 * and `az devops invoke` POSTs to a thread resource (thread-comment reply / new
 * thread) or the bare pull-request collection (PR creation — ADO drafts via
 * `isDraft` in the body, not a separate verb). Everything else that writes —
 * `az repos pr update|set-vote`, reviewer/work-item changes, queueing a policy
 * or a pipeline run, or an `invoke` with any other method/resource — is a
 * mutation the loop must never make.
 */
export const isAdoAzWriteViolation = (cmd: string): boolean => {
  const c = cmd.trim()
  if (!isAdoAz(c)) return false
  if (/^az\s+repos\s+pr\s+create\b/.test(c)) return !/(?:^|\s)--draft\b/.test(c)
  if (/^az\s+repos\s+pr\s+(?:update|set-vote)\b/.test(c)) return true
  if (/^az\s+repos\s+pr\s+(?:reviewer|work-item)\s+(?:add|remove)\b/.test(c)) return true
  if (/^az\s+repos\s+(?:policy|ref|import)\b/.test(c)) return true
  if (/^az\s+repos\s+pr\s+policy\s+queue\b/.test(c)) return true
  if (/^az\s+pipelines\s+(?:run\b|build\s+queue\b)/.test(c)) return true
  if (/^az\s+devops\s+invoke\b/.test(c)) {
    const m = /--http-method[ =]+([A-Za-z]+)/i.exec(c)
    const method = m ? m[1]!.toUpperCase() : "GET"
    if (method === "GET") return false
    if (method !== "POST") return true
    const resource = (/--resource[ =]+([\w-]+)/.exec(c)?.[1] ?? "").toLowerCase()
    return !["pullrequestthreads", "pullrequestthreadcomments", "pullrequests"].includes(resource)
  }
  return false
}

/**
 * An MCP tool name that looks like an Azure DevOps server's state-mutating tool
 * (merge/complete/vote/approve/reviewer changes…). Best-effort by design: MCP
 * server tool names are third-party and vary, so this pattern-matches the
 * conventional shapes rather than an exact list — the stage prompt's NEVER
 * clause stays the primary control. Creation tools (`create_pull_request`) stay
 * allowed: the publish stages legitimately open draft PRs, and draftness lives
 * in tool ARGUMENTS this name-level check can't see.
 */
export const isAdoMcpMutationTool = (toolName: string): boolean => {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (!m) return false
  const [, server, tool] = m
  if (!/(?:azure|ado|devops)/i.test(server!)) return false
  return /(?:update|complete|abandon|merge|vote|approve|reject|delete|reviewer|publish)/i.test(tool!)
}

/**
 * A `git push` that could move a branch the loop must never move. The sitters push
 * ONLY their own head fast-forward, never the watched or default branch, never
 * force. On top of any push allowlist glob, reject:
 *  - any force (`-f`, `--force`, `--force-with-lease`) or a delete (`-d`, `--delete`,
 *    `:dst` with empty src), including bundled short-flag clusters (`-fd`);
 *  - a `+`-prefixed refspec (a forced ref update);
 *  - a `src:dst` refspec whose destination differs from its source;
 *  - any refspec naming the default branch (`main`/`master`, bare or as `:dst`) or a
 *    bare `HEAD` — a fast-forward `git push origin main` has no force flag and no
 *    mismatched refspec, and `HEAD` is statically unresolvable. Residual: a PR whose
 *    head branch is literally named main/master parks — fail-safe.
 * The `refs/heads/` prefix is normalized so `x:refs/heads/x` (same branch) passes.
 * Gated on an actively-driving loop by the caller, so a human's manual push is untouched.
 */
export const isGitPushViolation = (cmd: string): boolean => {
  const c = cmd.trim()
  if (!/^git\s+(?:-\S+\s+|-C\s+\S+\s+)*push\b/.test(c)) return false
  if (/(?:^|\s)(?:--force(?:-with-lease(?:=\S*)?)?|--delete)(?:\s|$)/.test(c)) return true
  // Short flags are walked per token so the short delete form (`-d`) and
  // bundled clusters (`-fd`, `-df`) are caught, not just a lone `-f`.
  if (c.split(/\s+/).some((t) => /^-[a-zA-Z]+$/.test(t) && /[fd]/.test(t))) return true
  const bare = (ref: string): string => ref.replace(/^refs\/heads\//, "")
  const protectedRef = (ref: string): boolean => ["main", "master", "HEAD"].includes(bare(ref))
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
 */
export const chainedGithubPrMutation = (cmd: string): boolean => splitSegments(cmd).some(isGithubPrMutation)
export const chainedAdoWriteBackstopViolation = (cmd: string): boolean => splitSegments(cmd).some(isAdoWriteBackstopViolation)
export const chainedAdoAzWriteViolation = (cmd: string): boolean => splitSegments(cmd).some(isAdoAzWriteViolation)
export const chainedGitPushViolation = (cmd: string): boolean => splitSegments(cmd).some(isGitPushViolation)
