/**
 * Pure helpers behind `MermaidBlock` — split out so the node-only hub test
 * runner can cover them without a DOM.
 *
 * The security posture lives here as much as in the component: a mermaid
 * diagram in a plan is repo content that may have arrived on someone else's
 * branch, and mermaid renders via innerHTML internally (with a history of
 * sanitizer bypasses), which the Markdown renderer's no-`dangerouslySetInnerHTML`
 * invariant forbids on the hub origin. So the rendered SVG is never mounted
 * into the hub document — `svgDoc` wraps it into a standalone page for an
 * `<iframe sandbox="">`, which is scriptless and origin-less: even a full
 * sanitizer bypass cannot run script or reach the hub from there.
 */

/** Does a fenced code block's language tag ask for a mermaid diagram? */
export const isMermaidLang = (lang: string): boolean => lang.trim().toLowerCase() === "mermaid"

/**
 * The standalone document an `<iframe sandbox="" srcdoc>` renders one diagram
 * from. White canvas regardless of the hub theme — mermaid's palettes assume
 * a light background — and the SVG scales down to the frame instead of
 * overflowing it.
 */
export const svgDoc = (svg: string): string =>
  [
    "<!doctype html>",
    "<html><head><style>",
    "html,body{margin:0;padding:8px;background:#fff}",
    "svg{max-width:100%;height:auto;display:block;margin:0 auto}",
    "</style></head><body>",
    svg,
    "</body></html>",
  ].join("")
