/**
 * Per-verb instruction injection for `/agentic-workflow:engineering`.
 *
 * The command body used to describe every verb in one 227-line file, so
 * `new <idea>` handed the model ~190 lines about `claim`, `doctor`, and gate
 * moves the hook performs before its turn — wasted context, and a confusion
 * risk, since the body is imperative and nothing in it marks which half is the
 * plugin's job.
 *
 * The OpenCode host fixes this by rewriting the rendered prompt in
 * `command.execute.before`. This host cannot: a `UserPromptSubmit` hook may
 * only prepend context (`additionalContext`) or block the turn — there is no
 * "replace the prompt" lever. So the split is physical instead:
 *
 *   commands/engineering.md   the router. Always sent. Preamble, a one-line
 *                             index, the standing prohibitions.
 *   verbs/engineering.md      every verb's procedure, each inside an
 *                             `<!-- aw:verb name -->` block. Never sent whole:
 *                             this module extracts one block and the hook
 *                             injects it.
 *
 * Reading the verb file cannot be left to the model: the plugin normally lives
 * outside the user's project (`~/.claude/plugins/...`), where a `Read` would
 * fail — it would work only for maintainers dogfooding from the repo, which is
 * the worst kind of fallback.
 *
 * The slicing half is a port of plugins/opencode/src/command-slice.ts — keep
 * the two in step. The port is deliberate duplication: sharing the code would
 * mean routing this hand-authored hook through scripts/build-hooks.mjs and its
 * generated-output diff check, for ~40 lines.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** `<!-- aw:verb new -->` / `<!-- aw:verb stop|abort -->`, opening or closing, whole line only. */
const MARKER = /^<!--\s*(\/?)aw:verb\s+([a-z][a-z0-9|-]*)\s*-->$/

/**
 * The agent a verb spawns OUTSIDE the loop, and only those.
 *
 * `new` step 4 and `retask` step 4 spawn `workflow-plan-author` to write draft
 * files before any loop exists — no stage, no StageDef, so `modelFor` has nothing
 * to resolve and no fire payload carries a model for them. `plan` is deliberately
 * absent: its spawn IS the PLAN stage, and `workflows.engineering.stageModels.plan`
 * already governs it through the MCP response.
 */
const VERB_DRAFT_AGENT = { new: "workflow-plan-author", retask: "workflow-plan-author" }

/**
 * The user-scope config path, mirroring core's `resolveUserConfigPath`. Duplicated
 * rather than imported for the same reason the slicer is: this hook is
 * hand-authored and runs from a plugin dir with no build step, so it cannot reach
 * the TypeScript core or its zod schema.
 */
const userConfigPath = () => {
  const env = process.env.AGENTIC_WORKFLOW_USER_CONFIG
  if (env !== undefined) return env === "" ? null : env
  const home = os.homedir()
  if (!home) return null
  const xdg = process.env.XDG_CONFIG_HOME?.trim() ? process.env.XDG_CONFIG_HOME : path.join(home, ".config")
  const primary = path.join(xdg, "agentic-workflow", "agentic-workflow.json")
  if (fs.existsSync(primary)) return primary
  const legacy = path.join(home, ".agentic-workflow.json")
  return fs.existsSync(legacy) ? legacy : primary
}

/** A config layer's parsed object, or null — an unreadable or malformed file is "no config", never an error. */
const layer = (file) => {
  if (!file) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

/**
 * `agentModels.<agent>` with the repo layer winning over the user layer — the
 * per-key merge core's `mergeConfigLayers` performs, which for a flat map is just
 * this. Only a non-empty string counts; anything else is treated as unset so a
 * malformed value degrades to the host default rather than into a prompt.
 */
export const agentModelFor = (cwd, agent) => {
  const pick = (cfg) => {
    const value = cfg?.agentModels?.[agent]
    return typeof value === "string" && value.trim() ? value.trim() : null
  }
  const model = pick(layer(path.join(cwd, ".agentic-workflow.json"))) ?? pick(layer(userConfigPath()))
  // The Task tool takes bare model ids; strip a `provider/` prefix the way core's
  // `bareModel` does, so one config written OpenCode-style works on both hosts.
  return model?.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model
}

/**
 * A verb name, or null when there isn't one.
 *
 * Deliberately does NOT default an empty verb to `status`: `verbFor` already
 * maps a bare command to `status`, and it returns null for a prompt that is not
 * the engineering command at all. Defaulting here swallowed that null and
 * injected engineering's `status` instructions into every unrelated prompt in
 * the session — this hook's matcher is `""`, so that is every prompt.
 */
const normalize = (verb) => String(verb ?? "").trim().toLowerCase() || null

/**
 * Tag every line with the verbs it belongs to (`null` = outside all blocks),
 * dropping the marker lines. `null` on any structural problem — nested,
 * unclosed, stray, or mismatched markers — so a broken file degrades to "inject
 * nothing" rather than to a half-truncated procedure.
 */
const tagLines = (body) => {
  const tagged = []
  let open
  for (const text of body.split("\n")) {
    const marker = MARKER.exec(text.trim())
    if (marker) {
      const [, closing, names] = marker
      if (closing) {
        if (open !== names) return null
        open = undefined
      } else {
        if (open !== undefined) return null
        open = names
      }
      continue
    }
    tagged.push({ text, verbs: open === undefined ? null : open.split("|") })
  }
  return open === undefined ? tagged : null
}

/** Every verb the file carries a block for — the coverage test's view of the markup. */
export const verbsIn = (body) => {
  const tagged = tagLines(body)
  if (!tagged) return []
  const verbs = new Set()
  for (const line of tagged) for (const verb of line.verbs ?? []) verbs.add(verb)
  return [...verbs]
}

/**
 * Blank out every `<!-- … -->` span, including ones spanning lines, keeping
 * newlines so the result stays line-aligned with the input. A comment left
 * unterminated swallows the rest of the file, which is what a browser would do
 * with it too.
 */
const stripComments = (body) => {
  let out = ""
  let i = 0
  while (i < body.length) {
    const start = body.indexOf("<!--", i)
    if (start === -1) return out + body.slice(i)
    const end = body.indexOf("-->", start + 4)
    const stop = end === -1 ? body.length : end + 3
    out += body.slice(i, start) + body.slice(start, stop).replace(/[^\n]/g, " ")
    i = stop
  }
  return out
}

/**
 * Prose in `body` that sits outside every block — must be empty in
 * verbs/engineering.md, where anything unmarked is prose a maintainer believed
 * was shared but which this module silently drops. HTML comments don't count:
 * they are notes to the next maintainer and never reach a model.
 */
export const unmarkedLines = (body) => {
  if (!tagLines(body)) return [] // broken markup — sliceForVerb already reports that
  const bare = stripComments(body).split("\n")
  const prose = []
  let open
  body.split("\n").forEach((text, i) => {
    const marker = MARKER.exec(text.trim())
    if (marker) {
      open = marker[1] ? undefined : marker[2]
      return
    }
    if (open === undefined && bare[i].trim().length > 0) prose.push(text)
  })
  return prose
}

/**
 * The blocks belonging to `verb`, in source order, markers stripped.
 *
 * `null` when the verb has no block (so the hook stays silent and the router's
 * "no VERB INSTRUCTIONS arrived" rule does not misfire on a real verb) or the
 * markup is broken. Unlike the OpenCode port this drops unmarked text: here the
 * shared prose lives in the router, and repeating it would double the context
 * the split exists to cut.
 */
export const sliceForVerb = (body, verb) => {
  const tagged = tagLines(body)
  const wanted = normalize(verb)
  if (!tagged || !wanted) return null
  const kept = tagged.filter((line) => line.verbs?.includes(wanted)).map((line) => line.text)
  if (kept.length === 0) return null
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * The injectable context for `verb`, or `null` to inject nothing.
 *
 * Self-labelling on purpose: the model receives this alongside the router, and
 * has to know which of the two carries the procedure. A missing or unreadable
 * verb file is not an error — it means the plugin is partially installed, and
 * behaving exactly as before this module existed is the safe outcome.
 *
 * `cwd` is the session's directory, used only to resolve `agentModels` for the
 * verbs that spawn outside the loop. Omit it and that line is simply absent —
 * which is also what happens when nothing is configured, so the default install
 * pays no tokens for a knob it does not use.
 */
export const verbContext = (pluginRoot, verb, cwd) => {
  const wanted = normalize(verb)
  if (!wanted) return null
  let body
  try {
    body = fs.readFileSync(path.join(pluginRoot, "verbs", "engineering.md"), "utf8")
  } catch {
    return null
  }
  const slice = sliceForVerb(body, wanted)
  if (!slice) return null
  const draftAgent = VERB_DRAFT_AGENT[wanted]
  const model = draftAgent && cwd ? agentModelFor(cwd, draftAgent) : null
  const modelLine =
    `Spawn \`${draftAgent}\` with the Task tool's \`model\` set to \`${model}\` ` +
    "(config `agentModels`). This covers the drafting spawn only — a PLAN stage " +
    "spawn still takes the `model` field off the MCP response."
  return [
    `VERB INSTRUCTIONS — /agentic-workflow:engineering ${wanted}`,
    "",
    "This is the authoritative procedure for the verb you were asked to run.",
    "The command body you received is only the router. Follow this block, and do",
    "not act on any other verb's description.",
    "",
    slice,
    ...(model ? ["", modelLine] : []),
  ].join("\n")
}

/**
 * The injectable line for a spawn that has no MCP response to carry a model —
 * today only the ad-hoc `/agentic-workflow:plan`, which runs `workflow-plan`
 * outside any loop. `null` when nothing is configured, so the default install
 * pays nothing.
 */
export const adhocAgentContext = (cwd, agent) => {
  const model = cwd ? agentModelFor(cwd, agent) : null
  return model ? `Spawn \`${agent}\` with the Task tool's \`model\` set to \`${model}\` (config \`agentModels\`).` : null
}
