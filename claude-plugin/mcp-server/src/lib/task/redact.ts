/**
 * Secret redaction for durable, committed artifacts (task audit notes,
 * persisted plans, run logs). A stage that echoes a secret — a test's env
 * dump, a quoted config, a stack trace with a connection string — must not
 * leak it into files the loop commits to git. Applied at the write boundary
 * in `store.ts`. **Pure and total.**
 *
 * Shape-based scanning: recognized secret formats are replaced; custom-format
 * secrets (a company-internal token shaped like a UUID) pass through. Defense
 * in depth remains "keep secrets out of the working tree" — see
 * docs/design/threat-model.md T6.
 *
 * Posture: prefer false positives over leaks. A redacted non-secret costs a
 * little log fidelity; a leaked secret costs a rotation.
 */

export interface RedactionHit {
  readonly pattern: string
  readonly count: number
}

export interface Redacted {
  readonly text: string
  readonly hits: readonly RedactionHit[]
}

interface Rule {
  readonly name: string
  readonly re: RegExp
  /**
   * When set, only this capture group is replaced (the rest of the match — a
   * key name, an assignment operator — is preserved). Otherwise the whole
   * match is replaced.
   */
  readonly valueGroup?: number
}

// Order matters: more specific patterns first (anthropic before the generic
// sk- key; private-key block before anything line-oriented). First rule to
// claim a span wins, because each rule runs over the output of the previous.
const RULES: readonly Rule[] = [
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: "generic-assignment",
    // key name + separator, then the value we redact (group 2). The value is
    // non-space/quote, ≥8 chars, so short/example values slip through.
    re: /\b(api[_-]?key|secret|token|password|passwd)\b(\s*[:=]\s*["']?)([^\s"']{8,})/gi,
    valueGroup: 3,
  },
]

/** Replace recognized secret shapes with `[REDACTED:<name>]`. Idempotent. */
export const redact = (text: string): Redacted => {
  if (!text) return { text, hits: [] }
  let out = text
  const hits: RedactionHit[] = []
  for (const rule of RULES) {
    let count = 0
    out = out.replace(rule.re, (match, ...groups) => {
      count++
      if (rule.valueGroup === undefined) return `[REDACTED:${rule.name}]`
      // Rebuild the match with only the value group replaced.
      const g = groups as string[]
      const before = match.slice(0, match.length - g[rule.valueGroup - 1]!.length)
      return `${before}[REDACTED:${rule.name}]`
    })
    if (count > 0) hits.push({ pattern: rule.name, count })
  }
  return { text: out, hits }
}
