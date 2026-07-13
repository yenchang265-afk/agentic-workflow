/**
 * Pure check-stage bash-allowlist matching for the PreToolUse guard hook.
 * Extracted from check-stage-guard.entry.mjs so it can be unit-tested
 * (hooks/*.test.mjs) and so the segment-splitting that closes the
 * command-chaining bypass lives in exactly one place.
 *
 * The entry imports these; esbuild inlines them into the bundled
 * ../check-stage-guard.mjs. Keep this file dependency-free (no @agentic-loop/core,
 * no node built-ins) so a test can import it under bare `node --test`.
 */

// Built-in fallback lists (ported from loop-verify.md / loop-review.md
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
 * Whether EVERY chained/piped segment of `cmd` is on the allowlist (a bare `cd`
 * counts as allowed). A command with no runnable segment is rejected. This is the
 * check-stage read-only guarantee (threat-model T2) and the pr-sitter publish
 * "never merge" backstop (T1/T8) — both hinge on splitting before matching, since
 * the globs compile with dotAll so a whole-command match is chain-bypassable.
 */
export const commandAllowed = (cmd, globs) => {
  const segments = splitSegments(cmd)
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
    const method = m ? m[1].toUpperCase() : "GET"
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

/**
 * A `git push` that could move a branch the loop must never move. The sitters push
 * ONLY their own head (`feature/*`, `main-sitter/*`) fast-forward, never the watched
 * or default branch, never force. A push allowlist glob (`git push origin main-sitter/*`)
 * compiles with dotAll, so `.*` matches a `:dst` refspec and a space —
 * `git push origin x:main` or `... --force` slip through the glob. On top of it, reject:
 *  - any force (`-f`, `--force`, `--force-with-lease`) or a delete (`--delete`, `:dst` with empty src);
 *  - a `+`-prefixed refspec (a forced ref update);
 *  - a `src:dst` refspec whose destination differs from its source (pushing onto a
 *    DIFFERENT branch — the `x:main` / `x:refs/heads/main` escape).
 * The `refs/heads/` prefix is normalized so `x:refs/heads/x` (same branch) still passes.
 * Gated on an active loop marker by the caller, so a human's manual push is untouched.
 */
export const isGitPushViolation = (cmd) => {
  const c = cmd.trim()
  if (!/^git\s+(?:-\S+\s+|-C\s+\S+\s+)*push\b/.test(c)) return false
  if (/(?:^|\s)(?:-f|--force|--force-with-lease)(?:[=\s]|$)/.test(c)) return true
  if (/(?:^|\s)--delete(?:\s|$)/.test(c)) return true
  const bare = (ref) => ref.replace(/^refs\/heads\//, "")
  for (const t of c.split(/\s+/)) {
    if (t.startsWith("-")) continue // flag/option, not a refspec
    if (t.startsWith("+")) return true // forced ref update (+src:dst or +ref)
    const ci = t.indexOf(":")
    if (ci !== -1) {
      const src = t.slice(0, ci)
      const dst = t.slice(ci + 1)
      if (src === "") return true // delete form (:dst)
      if (dst && bare(dst) !== bare(src)) return true // pushing onto a different-named branch
    }
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
export const chainedGitPushViolation = (cmd) => splitSegments(cmd).some(isGitPushViolation)
