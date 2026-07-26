/**
 * Overriding the prompt of a `/agentic-workflow:*` command the plugin declined
 * to run.
 *
 * opencode registers the command markdowns independently of the plugin, so a
 * command whose deterministic half the plugin did NOT perform still renders its
 * template and sends it to the model. Those templates describe the loop's work
 * in full — "poll the configured PR source", the manifest path, the `gh`
 * surface — so a model handed one with no plugin behind it does the only thing
 * it can: improvises the sitter by hand, shelling out to `gh`, reading
 * `packages/core/workflows/<kind>/`, and guessing what `watch` or `claim` mean.
 * The toast that explains the refusal goes to the TUI, which the model cannot
 * see, so nothing contradicts the template.
 *
 * `command.execute.before`'s second argument is the mutable prompt payload.
 * Rewriting its text parts is the only way to tell the model the command was
 * refused. Kept dependency-free (structural types, no core imports) so
 * load-failure.ts — which must survive a failed core build — can use it too.
 */

/** The mutable prompt payload opencode passes as `command.execute.before`'s second argument. */
export type CommandPromptOutput = { parts?: Array<{ type?: string; text?: string } | null | undefined> }

/**
 * The standing "this body is not your instructions" directive.
 *
 * Shared by every override that leaves the model holding a rendered template it
 * must not act on. The explicit prohibitions are not decoration: without them a
 * capable model reads a bare "the plugin did not run" as an invitation to fill
 * the gap. One copy so a refusal and a crash cannot drift apart.
 */
const DO_NOT_IMPROVISE = [
  "This command's body is a description of work the PLUGIN performs, not instructions for you.",
  "Do NOT attempt any of it: do not read files, do not run git/gh/az or call any API,",
  "do not start, watch, or claim anything, and do not move task files.",
]

/** Wrap a refusal reason in the standing "do not do this yourself" directive. */
export const refusalPrompt = (reason: string, remedy: string): string =>
  [
    `The agentic-workflow plugin did NOT run this command: ${reason}`,
    "",
    ...DO_NOT_IMPROVISE,
    "",
    "Reply with exactly the following and nothing else:",
    "",
    remedy,
  ].join("\n")

/**
 * The override for a command whose deterministic half THREW.
 *
 * Distinct from `refusalPrompt` on purpose. A refusal is a decision taken before
 * anything ran, so it can promise nothing happened; a crash can land anywhere —
 * `approve` moves the task file and only then reconciles — so this must not
 * claim the command did nothing. It must also not invite the model to finish or
 * retry the half-applied work: the body it is holding was already sliced to the
 * invoked verb, and for the report-and-stop verbs that prose describes the
 * plugin's own deterministic work in the imperative. Reporting the error and
 * stopping is the only safe action; the kind's `status` verb is how the human
 * inspects what actually landed.
 */
export const failurePrompt = (command: string, verb: string, error: string): string => {
  const invocation = verb ? `\`/${command} ${verb}\`` : `\`/${command}\``
  return [
    `The agentic-workflow plugin FAILED while running ${invocation}: ${error}`,
    "",
    ...DO_NOT_IMPROVISE,
    "Do NOT retry it, and do NOT try to finish what it started — part of its work may already have been applied.",
    "",
    "Reply with exactly the following and nothing else:",
    "",
    `${invocation} failed: ${error}. Nothing further was attempted, and some of its work may already have been applied — check \`/${command} status\` before re-running it.`,
  ].join("\n")
}

/**
 * The rendered template as the model would receive it.
 *
 * The counterpart to `overrideCommandPrompt`: trimming the body to the invoked
 * verb (see command-slice.ts) needs to READ what opencode rendered, and this
 * payload is the plugin's only copy of it — it cannot reach its own
 * `commands/` directory on disk. Text parts are joined bare because they are
 * one template opencode happened to split, not separate messages; `undefined`
 * means there was no text to work with.
 */
export const readCommandPrompt = (output: CommandPromptOutput | undefined): string | undefined => {
  const parts = output?.parts
  if (!Array.isArray(parts)) return undefined
  const text = parts
    .filter((p): p is { type?: string; text?: string } => !!p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("")
  return text.length > 0 ? text : undefined
}

/**
 * Replace the rendered command template with `text`.
 *
 * The first text part carries the message; any further text parts are blanked
 * rather than left in place — they hold the rest of the rendered template, and
 * leaving them is what lets the model act on the original instructions.
 * Defensive about shape: opencode owns this payload, and a refusal that throws
 * here would take the whole command turn down with it.
 */
export const overrideCommandPrompt = (output: CommandPromptOutput | undefined, text: string): void => {
  const parts = output?.parts
  if (!Array.isArray(parts)) return
  const textParts = parts.filter((p): p is { type?: string; text?: string } => !!p && p.type === "text" && typeof p.text === "string")
  if (textParts.length === 0) return
  textParts[0]!.text = text
  for (let i = 1; i < textParts.length; i++) textParts[i]!.text = ""
}
