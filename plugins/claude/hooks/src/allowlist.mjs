/**
 * Pure check-stage bash-allowlist matching for the PreToolUse guard hook.
 * Extracted from check-stage-guard.entry.mjs so it can be unit-tested
 * (hooks/*.test.mjs) and so the segment-splitting that closes the
 * command-chaining bypass lives in exactly one place.
 *
 * The entry imports these; esbuild inlines them into the bundled
 * ../check-stage-guard.mjs. Keep this file dependency-free (no @agentic-workflow/core,
 * no node built-ins) so a test can import it under bare `node --test`.
 *
 * TWIN FILE: `packages/core/src/task/write-backstop.ts` carries the same
 * segment-aware write backstops for the OpenCode host's tool.execute.before hook.
 * Any semantic change to the classifiers here MUST be mirrored there — the two
 * test suites share their vectors so the twins can't drift silently.
 */

// Built-in fallback lists (ported from workflow-verify.md / workflow-review.md
// frontmatter), used only for markers written by older servers that didn't stamp
// the manifest allowlist. The compound `cd <dir> && <runner>` test form is NOT
// listed here: `commandAllowed` splits on operators and accepts a bare `cd` as
// its own segment, so a single `cd *` entry would be dead weight.
const GIT_READ = ["git status*", "git diff*", "git log*", "git show*", "git -C * status*", "git -C * diff*", "git -C * log*", "git -C * show*"]
const READ = ["ls*", "cat *", "head *", "tail *", "grep *", "find *", "wc *"]
const RUNNERS = ["npm test*", "npm run *", "pnpm test*", "pnpm run *", "yarn test*", "yarn run *", "bun test*", "node --test*", "npx tsc*", "npx vitest*", "npx jest*", "npx eslint*", "pytest*", "go test*", "cargo test*", "make test*", "make check*"]
export const VERIFY_ALLOW = [...GIT_READ, ...READ, ...RUNNERS]
export const REVIEW_ALLOW = [...GIT_READ, "git blame*", "git -C * blame*", ...READ]

const toRe = (glob) => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "s")
const matchesAny = (cmd, globs) => globs.some((g) => toRe(g).test(cmd.trim()))

/**
 * A bare directory change executes nothing on its own. The allowlists permit
 * exactly one compound form — `cd <dir> && <runner>` — and `splitSegments` yields
 * the `cd <dir>` as its own segment, so it must be recognized as safe for that
 * form to pass. Reject any shell metacharacter in the argument so a `cd`-prefixed
 * command substitution or further chaining can't ride through.
 */
const isBareCd = (seg) => /^cd\s+[^;&|<>()`$]+$/.test(seg)

/**
 * Split a bash command into chain/pipe segments at shell operators that sit
 * OUTSIDE single/double quotes. Operators inside a quoted argument (a
 * `gh pr comment --body "fixed A && B"`) are NOT split points; unquoted
 * `&&`/`||`/`|`/`;`/`&`/newlines are. Not a full shell parser — it does not
 * resolve `$()`, backticks, or backslash-escaped quotes (those remain residuals,
 * same as core's task/guard.ts) — but enough that the allowlist matches each real
 * command instead of letting a read-only prefix's dotAll `.*` swallow a chained
 * mutation (`git status && curl … | sh`, `git push origin x && gh pr merge`).
 */
export const splitSegments = (cmd) => {
  const segments = []
  let cur = ""
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
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
 * Shell constructs that run a command (or write a file) the allowlist glob can
 * never see, because every glob ends in `*` compiled with dotAll — so `^cat .*$`
 * happily matches the whole of `cat $(rm -rf build)` and the read-only stage
 * executes the substitution.
 *
 * Quote rules follow bash, not intuition: `$( )` and backticks are STILL expanded
 * inside double quotes, so only single quotes make them inert. Redirections are
 * literal inside either kind of quote. `isBareCd` already rejects these same
 * characters in its argument; this extends the rule to every segment.
 *
 * Both `<` and `>` are rejected: `>`/`>>` write, and `<(…)` is process
 * substitution (a command). Plain `< file` input redirection is collateral — no
 * allowlisted read/test command needs it.
 *
 * Residual (shared with `splitSegments`): backslash-escaped quotes are not
 * resolved, so this is defense-in-depth, not a shell sandbox.
 */
export const hasShellExpansion = (seg) => {
  let quote = null
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
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
 * Whether EVERY chained/piped segment of `cmd` is on the allowlist (a bare `cd`
 * counts as allowed). A command with no runnable segment is rejected. This is the
 * check-stage read-only guarantee (threat-model T2) and the pr-sitter publish
 * "never merge" backstop (T1/T8) — both hinge on splitting before matching, since
 * the globs compile with dotAll so a whole-command match is chain-bypassable, and
 * on rejecting substitution/redirection for the same reason.
 */
export const commandAllowed = (cmd, globs) => {
  const segments = splitSegments(cmd)
  if (segments.some(hasShellExpansion)) return false
  return segments.length > 0 && segments.every((s) => isBareCd(s) || matchesAny(s, globs))
}

/**
 * A `gh` command that mutates a pull request. The loop must NEVER merge, close,
 * approve, or otherwise change PR state — the GitHub mirror of the ADO write
 * backstop (threat-model T1/T8). The publish stage's allowlist permits `gh api *`
 * for reads and per-thread review-comment replies, and the glob can't exclude the
 * mutating subset (`gh api -X PUT …/pulls/N/merge`), so this classifier does:
 *
 *  - `gh pr merge|close|ready|edit|lock|unlock|review` — state changes / approvals
 *    (the sitter replies with `gh pr comment`, never these);
 *  - `gh api` with a non-GET/POST method (PUT/PATCH/DELETE) or hitting a `/merge`
 *    endpoint — GET reads and POST review-comment replies stay allowed, mirroring
 *    the ADO backstop's "GET or POST-to-/threads only" rule;
 *  - `gh api` with any write method to a `/reviews` or `/requested_reviewers`
 *    resource — a review SUBMISSION (`event=APPROVE|REQUEST_CHANGES|COMMENT`) or a
 *    reviewer change is a POST, so the GET/POST rule above would wave it through;
 *    a review is a PR state change (T1), and the sitter comments via `gh pr comment`
 *    / a POST to `.../issues/N/comments`, never a review. GET reads of reviews stay allowed.
 *
 * Evaluate PER SEGMENT (`chainedGithubPrMutation`): the `^gh` anchor means a whole
 * command starting with an allowlisted read (`gh pr view && gh api -X PUT …/merge`)
 * would otherwise slip the mutation past this classifier while the segment-aware
 * allowlist happily passes both. The caller gates this on an active loop marker, so
 * a human's manual `gh pr merge` outside a loop is untouched.
 */
export const isGithubPrMutation = (cmd) => {
  const c = cmd.trim()
  if (/^gh\s+(?:-\S+\s+)*pr\s+(?:merge|close|ready|edit|lock|unlock|review)\b/.test(c)) return true
  if (/^gh\s+(?:-\S+\s+)*api\b/.test(c)) {
    if (/\/merge(?:\b|\/|\?|$)/.test(c)) return true
    const m = /(?:-X|--method)[ =]+([A-Za-z]+)/.exec(c)
    // No explicit -X but a body flag (-f/-F/--field/--raw-field/--input) makes
    // gh send POST — `gh api …/reviews -f event=APPROVE` must not read as GET.
    const impliesBody = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:[=\s]|$)/.test(c)
    const method = m ? m[1].toUpperCase() : impliesBody ? "POST" : "GET"
    // Submitting a review or changing reviewers mutates PR state even via POST.
    if (method !== "GET" && /\/(?:reviews|requested_reviewers)(?:\b|\/|\?|$)/.test(c)) return true
    return !(method === "GET" || method === "POST")
  }
  return false
}

// A Bash command that calls the Azure DevOps REST API (curl against an ADO host).
export const isAdoCurl = (cmd) => /\bcurl\b/.test(cmd) && /https?:\/\/(?:dev\.azure\.com|[a-z0-9.-]+\.visualstudio\.com)\//i.test(cmd)

// The effective HTTP method of a curl: an explicit -X/--request wins, else a body
// flag (-d/--data*/-F/--form) implies POST, else GET.
export const curlMethod = (cmd) => {
  const explicit = /(?:-X|--request)[ =]+([A-Za-z]+)/.exec(cmd)
  if (explicit) return explicit[1].toUpperCase()
  return /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\b/.test(cmd) ? "POST" : "GET"
}

/**
 * A curl against Azure DevOps that mutates state beyond what the sitter family is
 * allowed: a thread-comment reply (POST to a `/threads` resource — pr-sitter,
 * review-sitter, main-sitter's culprit-PR note) and creating a brand-new pull
 * request (POST to `.../pullrequests` with no id segment after it — dep-sitter's
 * and main-sitter's publish stage; ADO drafts a PR the same way it drafts any
 * other, `isDraft: true` in the body, not a separate verb). Everything else —
 * PATCH/PUT/DELETE (completing, abandoning, voting, editing), or a POST to any
 * OTHER pull-request sub-resource (`.../pullrequests/<id>/reviewers`, `.../<id>`
 * itself) — is a mutation the loop must never make (threat-model T8/T12/T13).
 * The `(?![a-zA-Z0-9\/])` lookahead is what tells "create" (`/pullrequests?…` or
 * `/pullrequests"` at the end of the URL) apart from "act on an existing one"
 * (`/pullrequests/<id>...`) — a sub-path starts with `/`, an id segment with an
 * alphanumeric; either one disqualifies the "bare collection" reading.
 */
export const isAdoWriteBackstopViolation = (cmd) => {
  if (!isAdoCurl(cmd)) return false
  const method = curlMethod(cmd)
  const targetsThread = /\/threads(?:\/|\?|\b)/i.test(cmd)
  const createsNewPr = /\/pullrequests(?![a-zA-Z0-9/])/i.test(cmd)
  return !(method === "GET" || (method === "POST" && (targetsThread || createsNewPr)))
}

// An `az` CLI call against Azure DevOps (the azure-devops extension's command
// groups, plus the generic `az devops invoke` REST escape hatch).
export const isAdoAz = (cmd) => /^az\s+(?:repos|pipelines|boards|devops)\b/.test(cmd.trim())

/**
 * An `az` CLI call that mutates Azure DevOps state beyond what the sitter family
 * is allowed — the az mirror of `isAdoWriteBackstopViolation` (threat-model
 * T8/T12/T13). Allowed writes: `az repos pr create` ONLY with `--draft`, and
 * `az devops invoke` POSTs to a thread resource (thread-comment reply / new
 * thread) or the bare pull-request collection (PR creation — ADO drafts via
 * `isDraft` in the body, not a separate verb). Everything else that writes —
 * `az repos pr update|set-vote`, reviewer/work-item changes, queueing a policy
 * or a pipeline run, or an `invoke` with any other method/resource — is a
 * mutation the loop must never make. Unconditional like the curl backstop; the
 * caller gates on an active loop marker, so a human's manual `az` is untouched.
 */
export const isAdoAzWriteViolation = (cmd) => {
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
    const method = m ? m[1].toUpperCase() : "GET"
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
 * conventional shapes (e.g. microsoft/azure-devops-mcp) rather than an exact
 * list — the stage prompt's NEVER clause stays the primary control, and a real
 * per-stage MCP allowlist is future work. Creation tools (`create_pull_request`)
 * stay allowed: the publish stages legitimately open draft PRs, and draftness
 * lives in tool ARGUMENTS this name-level check can't see.
 */
export const isAdoMcpMutationTool = (toolName) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (!m) return false
  const [, server, tool] = m
  if (!/(?:azure|ado|devops)/i.test(server)) return false
  return /(?:update|complete|abandon|merge|vote|approve|reject|delete|reviewer|publish)/i.test(tool)
}

/**
 * A `git push` that could move a branch the loop must never move. The sitters push
 * ONLY their own head (`feature/*`, `main-sitter/*`) fast-forward, never the watched
 * or default branch, never force. A push allowlist glob (`git push origin main-sitter/*`)
 * compiles with dotAll, so `.*` matches a `:dst` refspec and a space —
 * `git push origin x:main` or `... --force` slip through the glob. On top of it, reject:
 *  - any force (`-f`, `--force`, `--force-with-lease`) or a delete (`--delete`, `:dst` with empty src);
 *  - a `+`-prefixed refspec (a forced ref update);
 *  - a `src:dst` refspec whose destination differs from its source (pushing onto a
 *    DIFFERENT branch — the `x:main` / `x:refs/heads/main` escape);
 *  - any refspec naming the default branch (`main`/`master`, bare or as `:dst`) or a
 *    bare `HEAD` — a fast-forward `git push origin main` has no force flag and no
 *    mismatched refspec, so the rules above wave it through, and `HEAD` is statically
 *    unresolvable (it IS the default branch whenever that's checked out). Residual:
 *    a PR whose head branch is literally named main/master parks — fail-safe.
 * The `refs/heads/` prefix is normalized so `x:refs/heads/x` (same branch) still passes.
 * Gated on an active loop marker by the caller, so a human's manual push is untouched.
 */
export const isGitPushViolation = (cmd) => {
  const c = cmd.trim()
  if (!/^git\s+(?:-\S+\s+|-C\s+\S+\s+)*push\b/.test(c)) return false
  if (/(?:^|\s)(?:-f|--force|--force-with-lease)(?:[=\s]|$)/.test(c)) return true
  if (/(?:^|\s)--delete(?:\s|$)/.test(c)) return true
  const bare = (ref) => ref.replace(/^refs\/heads\//, "")
  const protectedRef = (ref) => ["main", "master", "HEAD"].includes(bare(ref))
  const tokens = c.split(/\s+/)
  let refspecs = 0
  for (let i = tokens.indexOf("push") + 1; i < tokens.length; i++) {
    const t = tokens[i]
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
 * The write backstops evaluated PER chain/pipe segment (like `commandAllowed`).
 * The classifiers anchor on a single command, so a whole-command scan lets a
 * chained allowlisted read hide a mutation (`gh pr view && gh api -X PUT …/merge`,
 * `curl -X GET … && curl -X PATCH …`). Splitting first is what actually closes the
 * bypass — the segment-aware allowlist already passes each real command, and now the
 * backstop inspects each real command too.
 */
export const chainedGithubPrMutation = (cmd) => splitSegments(cmd).some(isGithubPrMutation)
export const chainedAdoWriteBackstopViolation = (cmd) => splitSegments(cmd).some(isAdoWriteBackstopViolation)
export const chainedAdoAzWriteViolation = (cmd) => splitSegments(cmd).some(isAdoAzWriteViolation)
export const chainedGitPushViolation = (cmd) => splitSegments(cmd).some(isGitPushViolation)
