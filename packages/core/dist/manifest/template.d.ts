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
export type TemplateValue = string | boolean | TemplateContext;
export interface TemplateContext {
    readonly [key: string]: TemplateValue | undefined;
}
/** Render one section: expand nested blocks, then interpolate variables. */
export declare const renderSection: (tpl: string, ctx: TemplateContext) => string;
/**
 * Render a full stage prompt: each section rendered, trimmed, empties dropped,
 * joined with a blank line.
 */
export declare const renderPrompt: (tpl: string, ctx: TemplateContext) => string;
