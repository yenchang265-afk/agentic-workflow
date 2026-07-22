import fs from "node:fs"
import path from "node:path"
import { promptContext } from "@agentic-workflow/core/workflow/engine"
import type { WorkflowState } from "@agentic-workflow/core/workflow/state"
import { verdictContractBlock, workScopeBlock } from "@agentic-workflow/core/workflow/verdict"
import { listWorkflowKinds, loadManifest } from "@agentic-workflow/core/manifest/load"
import { WorkflowManifestSchema, type WorkflowManifest, type StageDef } from "@agentic-workflow/core/manifest/schema"
import { renderPrompt } from "@agentic-workflow/core/manifest/template"
import type {
  ChecklistItem,
  ChecklistResponse,
  KindDetailResponse,
  KindsResponse,
  ManifestIssue,
  PreviewRequest,
  PreviewResponse,
  PreviewSample,
  SaveKindResponse,
  ValidateResponse,
} from "../../shared/api.js"
import { readRawLayer } from "../configfile.js"
import { valueAt } from "../configlayers.js"
import type { HubDeps } from "../deps.js"
import { badRequest, json, notFound, ok, type JsonResponse, type ParsedRequest } from "../http.js"

/** Loop-kind manifest views + the creator's validate/save/preview surface. */

/** Kind and stage names come from URLs and file writes — same slug rule everywhere. */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,32}$/

/**
 * Sub-paths of `/api/kinds/` that are verbs, not kind names. `POST
 * /api/kinds/:kind` (saveKind) would otherwise happily write a workflow kind called
 * "preview" if it ever matched first — the route table orders the verbs ahead of
 * `:kind`, but that is array order, and array order is not a safety property.
 * Both spellings pass SLUG_RE, so reject them here where it cannot drift.
 */
const RESERVED_KINDS: readonly string[] = ["validate", "preview", "checklist"]

export const getKinds = async (deps: HubDeps): Promise<JsonResponse> => {
  const kinds = listWorkflowKinds(deps.workflowsDir).flatMap((kind) => {
    try {
      const { manifest } = loadManifest(deps.workflowsDir, kind)
      return [{ kind, description: manifest.description, stages: manifest.stages.map((s) => s.name) }]
    } catch (err) {
      deps.log("warn", `skipping workflow kind ${kind}: ${(err as Error).message}`)
      return []
    }
  })
  const response: KindsResponse = { kinds }
  return ok(response)
}

export const getKind = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const kind = req.params["kind"] ?? ""
  if (!SLUG_RE.test(kind) || !listWorkflowKinds(deps.workflowsDir).includes(kind)) return notFound(`workflow kind ${kind}`)
  const { manifest, prompts } = loadManifest(deps.workflowsDir, kind)
  const response: KindDetailResponse = { manifest, prompts }
  return ok(response)
}

// --- creator: validate + save ---

const issuesOf = (raw: unknown): ManifestIssue[] | null => {
  const result = WorkflowManifestSchema.safeParse(raw)
  if (result.success) return null
  return result.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }))
}

export const validateKind = async (_deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const body = req.body as { manifest?: unknown } | undefined
  if (!body?.manifest) return badRequest("body must be {manifest}")
  const issues = issuesOf(body.manifest)
  const response: ValidateResponse = { valid: issues === null, issues: issues ?? [] }
  return ok(response)
}

// --- creator: prompt preview ---

const DEFAULT_SAMPLE: PreviewSample = { task: true, git: true, worktree: true, platform: "github" }

/**
 * A plausible `WorkflowState` to render a prompt against. Values are visibly sample
 * text rather than realistic-looking fakes — an author reading the preview should
 * never wonder whether `f7k3-add-rate-limit` is a real task of theirs.
 *
 * Artifacts are filled for every stage *except* the previewed one, since a stage
 * can only read what ran before it; that makes `{{artifacts.plan}}` and friends
 * render instead of silently vanishing.
 */
const sampleState = (manifest: WorkflowManifest, stage: string, sample: PreviewSample): WorkflowState => {
  const artifacts: Record<string, string> = {}
  for (const s of manifest.stages) if (s.name !== stage) artifacts[s.name] = `<sample ${s.name} output>`
  // The approved plan rides in artifacts under its own key, not a stage name.
  if (!artifacts["plan"]) artifacts["plan"] = "<sample approved plan>"

  const worktree = sample.git && sample.worktree ? "/sample/worktree/path" : undefined
  return {
    kind: manifest.kind,
    goal: "<sample goal>",
    stage,
    iteration: 0,
    artifacts,
    platform: sample.platform,
    ...(sample.task
      ? { task: { id: "sample-task-id", path: "docs/tasks/in-progress/sample-task-id.md", acceptance: ["<sample acceptance criterion>"] } }
      : {}),
    ...(sample.git ? { git: { base: "main", branch: "feature/sample-task-id", ...(worktree ? { worktree } : {}) } } : {}),
  }
}

/**
 * Render a stage prompt exactly as the loop would compose it, against sample state.
 *
 * Deliberately does NOT call core's `composePrompt`, which would throw on exactly
 * the kinds the creator authors: it loads the manifest's prompts from disk (the
 * manifest being previewed isn't saved yet) and resolves `hooks.compose[stage]`
 * through the registry, which for a hub-authored kind names a hook no host has
 * registered. Instead it composes the same two primitives `composePrompt` does —
 * `renderPrompt(tpl, promptContext(state))` plus the check-stage verdict contract
 * — so the output matches without the throw. A composed-hooked stage is reported
 * via `note` rather than guessed at.
 */
export const previewKind = async (_deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const body = req.body as Partial<PreviewRequest> | undefined
  if (!body?.manifest || typeof body.stage !== "string") return badRequest("body must be {manifest, stage, prompts, sample?}")

  const issues = issuesOf(body.manifest)
  if (issues) return json(400, { error: "manifest invalid", issues })
  const manifest = WorkflowManifestSchema.parse(body.manifest)

  const def: StageDef | undefined = manifest.stages.find((s) => s.name === body.stage)
  if (!def) return badRequest(`unknown stage "${body.stage}" — the manifest declares ${manifest.stages.map((s) => s.name).join(", ")}`)

  const tpl = body.prompts?.[def.name]
  if (typeof tpl !== "string") return badRequest(`no prompt source provided for stage "${def.name}"`)

  const sample: PreviewSample = { ...DEFAULT_SAMPLE, ...body.sample }
  const rendered = renderPrompt(tpl, promptContext(sampleState(manifest, def.name, sample)))
  // Every stage carries its contract in the prompt itself (see verdict.ts):
  // the verdict contract for check stages, the scope fence for work stages.
  const full =
    def.kind === "check"
      ? `${rendered}\n\n${verdictContractBlock(def.name, def.requiredAxes)}`
      : `${rendered}\n\n${workScopeBlock(def.name)}`

  const hookRef = manifest.hooks.compose?.[def.name]
  const response: PreviewResponse = {
    rendered: full,
    sample,
    ...(hookRef
      ? { note: `Stage "${def.name}" has a compose hook ("${hookRef}") that rewrites its context at run time — this preview shows the un-hooked render.` }
      : {}),
  }
  return ok(response)
}

const STUB = (kind: string, stage: string): string =>
  [
    `You are the ${stage.toUpperCase()} stage of the "${kind}" loop.`,
    "",
    "Goal: {{goal}}",
    "",
    "{{#task.id}}",
    "---",
    "Task: {{task.id}} — {{task.title}}",
    "{{/task.id}}",
    "",
    "---",
    `TODO: describe what ${stage} must do, its inputs (artifacts.<stage>), and`,
    "how it reports its result (work stages just finish; check stages MUST",
    "record a PASS/FAIL verdict via the workflow_verdict tool).",
    "",
  ].join("\n")

/** Remaining manual steps for a saved kind, computed against the repo on disk. Pure given fs. */
const buildChecklist = (deps: HubDeps, manifest: WorkflowManifest): ChecklistItem[] => {
  const items: ChecklistItem[] = []
  const repo = deps.directory
  const agents = [...new Set(manifest.stages.map((s) => s.agent))]
  for (const agent of agents) {
    const dir = path.join(repo, "prompts", "agents", agent)
    items.push({ done: fs.existsSync(dir), label: `agent persona prompts/agents/${agent}/ (body.md + opencode.yaml + claude.yaml)` })
  }
  const missingAgent = agents.some((a) => !fs.existsSync(path.join(repo, "prompts", "agents", a)))
  items.push({ done: !missingAgent, label: "run `npm run gen:prompts` after authoring the personas", action: "gen-prompts" })
  for (const command of [...new Set(manifest.stages.map((s) => s.command))]) {
    const file = path.join(repo, "plugins", "opencode", "commands", `${command}.md`)
    items.push({ done: fs.existsSync(file), label: `opencode command wrapper plugins/opencode/commands/${command}.md` })
  }
  const claudeCmd = path.join(repo, "plugins", "claude", "commands", `${manifest.kind}.md`)
  items.push({ done: fs.existsSync(claudeCmd), label: `Claude command plugins/claude/commands/${manifest.kind}.md (/agentic-workflow:${manifest.kind})` })
  const hookRefs = [...Object.values(manifest.hooks.compose ?? {}), ...Object.values(manifest.hooks.validateBeforeTransition ?? {})]
  for (const ref of hookRefs) {
    items.push({ done: false, label: `register hook "${ref}" at host startup (pattern: packages/core/src/kinds/)` })
  }
  // Read through the same layer reader the config editor uses, rather than a
  // second raw fs.readFileSync + JSON.parse that could drift from it.
  const cfg = readRawLayer(deps, "repo").raw
  const enabled = valueAt(cfg, ["workflows", manifest.kind, "enabled"]) === true
  if (manifest.kind !== "engineering") {
    // No longer "go hand-edit the file" — the Config tab writes this.
    items.push({ done: enabled, label: `enable it in the Config tab (workflows.${manifest.kind}.enabled)` })
  }
  return items
}

/**
 * Recompute the post-save checklist for a manifest without re-saving it —
 * scaffolds and gen:prompts runs change what's on disk, and the creator
 * refreshes through here. Writes nothing, so it carries no `mutating` guard.
 */
export const checklistKind = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const body = req.body as { manifest?: unknown } | undefined
  if (!body?.manifest) return badRequest("body must be {manifest}")
  const issues = issuesOf(body.manifest)
  if (issues) return json(400, { error: "manifest invalid", issues })
  const manifest = WorkflowManifestSchema.parse(body.manifest)
  const response: ChecklistResponse = { checklist: buildChecklist(deps, manifest) }
  return ok(response)
}

export const saveKind = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const kind = req.params["kind"] ?? ""
  if (!SLUG_RE.test(kind)) return badRequest(`kind must match ${SLUG_RE}`)
  if (RESERVED_KINDS.includes(kind)) return badRequest(`"${kind}" is a reserved route name, not a workflow kind`)
  const body = req.body as
    | { manifest?: unknown; prompts?: Record<string, string>; overwrite?: boolean }
    | undefined
  if (!body?.manifest) return badRequest("body must be {manifest, prompts?, overwrite?}")

  const issues = issuesOf(body.manifest)
  if (issues) return json(400, { error: "manifest invalid", issues })
  const manifest = WorkflowManifestSchema.parse(body.manifest)
  if (manifest.kind !== kind) return badRequest(`manifest.kind "${manifest.kind}" must equal the URL kind "${kind}"`)
  for (const stage of manifest.stages) {
    if (!SLUG_RE.test(stage.name)) return badRequest(`stage name "${stage.name}" must match ${SLUG_RE}`)
    if (stage.prompt !== `stages/${stage.name}.md`)
      return badRequest(`hub-authored kinds keep prompts at stages/<stage>.md — stage "${stage.name}" declares "${stage.prompt}"`)
  }

  const workflowsRoot = path.resolve(deps.workflowsDir)
  const dir = path.resolve(workflowsRoot, kind)
  if (dir !== path.join(workflowsRoot, kind) || !dir.startsWith(workflowsRoot + path.sep)) return badRequest("bad kind path")
  const exists = fs.existsSync(path.join(dir, "workflow.json"))
  if (exists && !body.overwrite) return json(409, { error: `workflow kind "${kind}" already exists — pass overwrite to update it` })

  const written: string[] = []
  fs.mkdirSync(path.join(dir, "stages"), { recursive: true })
  fs.writeFileSync(path.join(dir, "workflow.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  written.push(`workflows/${kind}/workflow.json`)
  for (const stage of manifest.stages) {
    const file = path.join(dir, "stages", `${stage.name}.md`)
    const provided = body.prompts?.[stage.name]
    if (provided !== undefined && (body.overwrite || !fs.existsSync(file))) {
      fs.writeFileSync(file, provided.endsWith("\n") ? provided : `${provided}\n`)
      written.push(`workflows/${kind}/stages/${stage.name}.md`)
    } else if (!fs.existsSync(file)) {
      fs.writeFileSync(file, STUB(kind, stage.name))
      written.push(`workflows/${kind}/stages/${stage.name}.md (stub)`)
    }
  }

  const response: SaveKindResponse = { written, checklist: buildChecklist(deps, manifest) }
  return ok(response)
}
