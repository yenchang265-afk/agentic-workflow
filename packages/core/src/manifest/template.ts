/**
 * The tiny template language stage prompts are written in. Pure, no deps.
 *
 * A prompt file is a sequence of SECTIONS separated by lines containing only
 * `---`. Each section renders independently; sections that render to nothing
 * (all their conditional blocks were falsy) are dropped, and the survivors are
 * joined with a blank line — reproducing the "parts" model the engineering
 * loop's prompts were originally composed with.
 *
 * Inside a section:
 * - `{{path}}`            — interpolate a context value (dot paths: `git.branch`)
 * - `{{#path}}…{{/path}}` — render the span only when the value is truthy
 *   (non-empty string / `true`). Blocks may nest.
 *
 * Unknown paths interpolate to "" and are falsy as block conditions.
 */

export type TemplateValue = string | boolean | TemplateContext
export interface TemplateContext {
  readonly [key: string]: TemplateValue | undefined
}

const lookup = (ctx: TemplateContext, path: string): TemplateValue | undefined => {
  let cur: TemplateValue | undefined = ctx
  for (const key of path.split(".")) {
    if (cur === undefined || typeof cur === "string" || typeof cur === "boolean") return undefined
    cur = cur[key]
  }
  return cur
}

const truthy = (v: TemplateValue | undefined): boolean => {
  if (v === undefined || v === false) return false
  if (typeof v === "string") return v.length > 0
  return true
}

const asString = (v: TemplateValue | undefined): string => (typeof v === "string" ? v : "")

/** Render one section: expand nested blocks, then interpolate variables. */
export const renderSection = (tpl: string, ctx: TemplateContext): string => {
  // Expand innermost blocks first so nesting works without a real parser.
  const BLOCK = /\{\{#([\w.-]+)\}\}((?:(?!\{\{[#/])[\s\S])*?)\{\{\/\1\}\}/
  let out = tpl
  for (let guard = 0; guard < 100; guard++) {
    const m = BLOCK.exec(out)
    if (!m) break
    const [whole, path, body] = m
    out = out.replace(whole, truthy(lookup(ctx, path ?? "")) ? (body ?? "") : "")
  }
  return out.replace(/\{\{([\w.-]+)\}\}/g, (_, path: string) => asString(lookup(ctx, path)))
}

/** Split a prompt file into sections on `---` lines. */
const sections = (tpl: string): string[] => tpl.split(/^[ \t]*---[ \t]*$/m)

/**
 * Render a full stage prompt: each section rendered, trimmed, empties dropped,
 * joined with a blank line.
 */
export const renderPrompt = (tpl: string, ctx: TemplateContext): string =>
  sections(tpl)
    .map((s) => renderSection(s, ctx).trim())
    .filter((s) => s.length > 0)
    .join("\n\n")
