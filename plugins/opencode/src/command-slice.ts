/**
 * Trimming a rendered `/agentic-workflow:*` command template down to the verb
 * that was actually invoked.
 *
 * The engineering command body describes every verb — authoring, both gates,
 * every execution and introspection verb, the pipeline — because a human
 * reading the command wants the whole surface. The model does not: on
 * `new <idea>` the ~37 lines that matter arrive wrapped in ~190 lines about
 * `claim`, `watch`, `doctor`, and deterministic plugin work it must not
 * attempt. That is both wasted context and a live confusion risk, since the
 * body is written in the imperative and nothing in it marks which half is the
 * plugin's job.
 *
 * The command markdown delimits each verb's prose with HTML-comment anchors —
 * invisible when rendered, ignored by the hub's frontmatter reader:
 *
 *   <!-- aw:verb new -->            …kept only when the invoked verb matches
 *   <!-- /aw:verb new -->
 *   <!-- aw:verb stop|abort -->     …one block can serve several verbs
 *   <!-- /aw:verb stop|abort -->
 *
 * **Text outside every block is always kept.** Shared prose is the complement
 * of the markers, not a marker of its own, so prose added to the file later is
 * shared by default — it can never be silently dropped from a verb by someone
 * who did not know the markers existed. Only the per-verb bullets, which are
 * demonstrably irrelevant to the other verbs, are behind a marker.
 *
 * Kept dependency-free (no core imports, no fs) to match command-prompt.ts:
 * this runs inside opencode's command hook, and the plugin has no handle on its
 * own on-disk `commands/` directory anyway — the rendered text is the only copy
 * it ever sees.
 *
 * A near-identical port drives the Claude host, where the hook can only prepend
 * context and the slice therefore has to come from a separate file; keep the
 * two in step (plugins/claude/hooks/verb-slice.mjs).
 */

/** The verb a bare `/agentic-workflow:<kind>` (no argument) behaves as. */
const BARE_VERB = "status"

/** `<!-- aw:verb new -->` / `<!-- aw:verb stop|abort -->`, opening or closing, whole line only. */
const MARKER = /^<!--\s*(\/?)aw:verb\s+([a-z][a-z0-9|-]*)\s*-->$/

type Line = { text: string; verbs: string[] | null }

/**
 * Tag every line with the verbs it belongs to (`null` = shared), dropping the
 * marker lines themselves.
 *
 * Returns `undefined` on any structural problem — a nested block, an unclosed
 * block, a stray or mismatched close. Every caller treats that as "leave the
 * body alone", which matters for more than typos: the user's own argument text
 * is substituted into the body before the plugin ever sees it, so
 * `new fix the <!-- /aw:verb new --> parser` reaches this function as markup.
 * Rejecting the whole file costs the trim and nothing else; accepting it would
 * let an argument truncate the instructions.
 */
const tagLines = (rendered: string): Line[] | undefined => {
  const tagged: Line[] = []
  let open: string | undefined
  for (const text of rendered.split("\n")) {
    const marker = MARKER.exec(text.trim())
    if (marker) {
      const [, closing, names] = marker
      if (closing) {
        if (open !== names) return undefined // stray, mismatched, or crossed close
        open = undefined
      } else {
        if (open !== undefined) return undefined // nested block
        open = names
      }
      continue
    }
    tagged.push({ text, verbs: open === undefined ? null : open.split("|") })
  }
  if (open !== undefined) return undefined // unclosed block
  return tagged.some((line) => line.verbs !== null) ? tagged : undefined
}

/**
 * Marks a line the slice removed. Removed lines are kept in place as sentinels
 * rather than spliced out, because `tidy` must distinguish "this heading's
 * section was emptied BY THE SLICE" from "these two headings were always
 * adjacent" — and once the lines are gone those look identical.
 */
const DROP = Symbol("dropped by the slice")
type Sliced = string | typeof DROP

const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line)

/**
 * Drop headings the slice emptied, then collapse the blank runs the removed
 * blocks left behind. A heading whose section is gone reads as a promise the
 * slice does not keep ("## Human gates" with nothing under it), and the
 * `\n{3,}` collapse is the same idiom scripts/gen-prompts.mjs uses after
 * dropping a host block.
 *
 * A heading is dropped only when the slice actually emptied it: the scan must
 * see at least one REMOVED line before reaching either the next kept heading or
 * the end. Without that condition this also deleted headings that were adjacent
 * in the source — and since `$ARGUMENTS` is substituted into the body BEFORE
 * the hook runs, "the source" includes the user's own text. A pasted spec whose
 * `## Goals` was immediately followed by `## Non-goals` silently lost the first
 * heading, which is precisely the "text outside every block is always kept"
 * promise this module opens with. (`neutralizeArgumentMarkers` defuses marker
 * lines in the argument; nothing defuses a `#`, and nothing should have to.)
 */
const tidy = (lines: readonly Sliced[]): string => {
  const kept = [...lines]
  // Iterate to a fixpoint: emptying "## Introspection" can in turn empty the
  // "## Execution" above it once everything between them is gone.
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 0; i < kept.length; i++) {
      const line = kept[i]
      if (typeof line !== "string" || !isHeading(line)) continue
      let sawDropped = false
      let emptied = true
      for (let j = i + 1; j < kept.length; j++) {
        const next = kept[j]!
        // Sentinels and blanks are skipped, never decisive: a section whose
        // verb blocks were dropped but whose SHARED prose survives is not
        // empty, and that prose can sit below the sentinels.
        if (next === DROP) {
          sawDropped = true
          continue
        }
        if (next.trim().length === 0) continue
        emptied = isHeading(next)
        break
      }
      if (!emptied || !sawDropped) continue
      // A dropped heading is itself a removal, so the heading above it can
      // empty in the same pass.
      kept[i] = DROP
      changed = true
      break
    }
  }
  return kept
    .filter((line): line is string => typeof line === "string")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Defuse marker-shaped lines the USER's argument substituted into the body.
 *
 * The slice runs on the POST-substitution text (the hook never sees the raw
 * template), so an argument containing a line that parses as a marker — a
 * pasted spec, an issue body, a `new <idea>` quoting the syntax — used to trip
 * `tagLines`' structural rejection and the model received the entire ~230-line
 * body with no warning: exactly the context blow-up the split exists to remove.
 * (Truncation was never reachable — the whole-line rule holds — only denial.)
 *
 * Every occurrence of the argument in the rendered body has its marker-shaped
 * lines prefixed with `\` — one byte, renders as the same text in markdown,
 * and `MARKER` no longer matches, so the argument's copies are inert while the
 * template's own markers keep their structure. A renderer that reshaped the
 * argument (so it no longer occurs verbatim) makes this a no-op, which merely
 * falls back to the old keep-the-full-body behavior. Pure.
 */
export const neutralizeArgumentMarkers = (rendered: string, argument: string): string => {
  const arg = argument ?? ""
  if (!arg || !arg.split("\n").some((line) => MARKER.test(line.trim()))) return rendered
  const safe = arg
    .split("\n")
    .map((line) => (MARKER.test(line.trim()) ? `\\${line}` : line))
    .join("\n")
  return rendered.split(arg).join(safe)
}

/**
 * Every verb the body carries a block for. Used by the coverage test that
 * asserts the markup keeps up with the command's `argument-hint`, so the test
 * and the slicer agree on what "has a block" means.
 */
export const commandPromptVerbs = (rendered: string): string[] => {
  const tagged = tagLines(rendered)
  if (!tagged) return []
  const verbs = new Set<string>()
  for (const line of tagged) for (const verb of line.verbs ?? []) verbs.add(verb)
  return [...verbs]
}

/**
 * The shared text plus the invoked verb's blocks, with every other verb's
 * blocks removed.
 *
 * `undefined` means "keep the full body": the text carries no usable markers,
 * the markup is broken, or the verb has no block of its own — an unknown verb,
 * whose template the command hook replaces with the usage string anyway.
 */
export const sliceCommandPrompt = (rendered: string, verb: string): string | undefined => {
  const tagged = tagLines(rendered)
  if (!tagged) return undefined
  const wanted = verb.trim().toLowerCase() || BARE_VERB
  if (!tagged.some((line) => line.verbs?.includes(wanted))) return undefined
  return tidy(tagged.map((line) => (line.verbs === null || line.verbs.includes(wanted) ? line.text : DROP)))
}
