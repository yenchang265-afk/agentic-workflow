/**
 * The first argument token, read the way opencode's positional-placeholder
 * substitution reads it (opencode packages/opencode/src/session/prompt.ts:
 * `argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi`, each token
 * stripped of surrounding quotes). `$1` in a command template renders exactly
 * that token, so the plugin must dispatch on the same value — otherwise the
 * rendered `Verb:` line and the plugin's outcome disagree about what was
 * invoked (`'new' idea` used to dispatch as the unknown verb `'new'` while
 * `$1` rendered `new`).
 *
 * The `[Image N]` alternative is deliberately omitted: an image placeholder
 * can never be a verb, and both readings land on "unknown verb".
 */
const FIRST_TOKEN = /(?:"[^"]*"|'[^']*'|[^\s"']+)/

/**
 * Split a command argument into its verb (first token, quote-trimmed and
 * lowercased, matching what `$1` renders) and the RAW remainder (trimmed,
 * quotes intact — payloads are literal user text). Pure.
 */
export const splitVerb = (arg: string): { verb: string; rest: string } => {
  const m = FIRST_TOKEN.exec(arg)
  if (!m) return { verb: "", rest: "" }
  return {
    verb: m[0].replace(/^["']|["']$/g, "").toLowerCase(),
    rest: arg.slice(m.index + m[0].length).trim(),
  }
}
