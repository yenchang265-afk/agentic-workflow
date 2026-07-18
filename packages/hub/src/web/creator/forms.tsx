import { useState } from "react"
import type { LoopManifest, StageDef } from "@agentic-loop/core/manifest/schema"
import type { AssetsResponse } from "../../shared/api.js"
import { isUnknownAsset, knownNames } from "./assets.js"
import { AgentScaffoldForm, CommandScaffoldForm } from "./assetforms.js"
import { terminalStatusOptions, type GraphMeta } from "./graphmodel.js"
import { PromptPreview } from "./PromptPreview.js"
import { Button } from "../ui/Button.js"

/**
 * Side-panel forms: plain controlled inputs writing immutable updates back to
 * the creator's state. No form library — a dozen fields don't justify one.
 */

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="form-field">
    <span>{label}</span>
    {children}
  </label>
)

const csv = (list: readonly string[] | undefined): string => (list ?? []).join(", ")
const fromCsv = (text: string): string[] =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

export const StageForm = ({
  stage,
  prompt,
  manifest,
  prompts,
  assets,
  onScaffolded,
  onChange,
  onPromptChange,
  onDelete,
}: {
  stage: StageDef
  prompt: string
  /** The live graph as a manifest, for the preview. Null while it doesn't validate. */
  manifest: LoopManifest | null
  prompts: Readonly<Record<string, string>>
  /** Repo asset inventory for the command/agent pickers. Null while loading. */
  assets: AssetsResponse | null
  /** A scaffold wrote files — the parent refetches the inventory (and checklist). */
  onScaffolded: () => void
  onChange: (next: StageDef) => void
  onPromptChange: (text: string) => void
  onDelete: () => void
}) => {
  const set = (patch: Partial<StageDef>): void => onChange({ ...stage, ...patch } as StageDef)
  const [scaffold, setScaffold] = useState<"agent" | "command" | null>(null)
  const [notes, setNotes] = useState<readonly string[]>([])
  return (
    <div className="panel-form">
      <h3>Stage: {stage.name}</h3>
      <Field label="name">
        <input
          value={stage.name}
          onChange={(e) => {
            const name = e.target.value
            set({ name, prompt: `stages/${name}.md` })
          }}
        />
      </Field>
      <Field label="kind">
        <select value={stage.kind} onChange={(e) => set({ kind: e.target.value as StageDef["kind"] })}>
          <option value="work">work — completes on its own</option>
          <option value="check">check — must record a verdict</option>
        </select>
      </Field>
      <Field label="command (host slash command)">
        <input list="asset-commands" value={stage.command} onChange={(e) => set({ command: e.target.value })} />
        <datalist id="asset-commands">
          {assets?.commands.map((c) => (
            <option key={c.name} value={c.name}>
              {c.description}
            </option>
          ))}
        </datalist>
      </Field>
      <div className="asset-hint">
        {isUnknownAsset(knownNames(assets?.commands), stage.command) && (
          <span>not in this repo yet — it will appear on the post-save checklist</span>
        )}
        <Button onClick={() => setScaffold((s) => (s === "command" ? null : "command"))}>+ new command</Button>
      </div>
      {scaffold === "command" && (
        <CommandScaffoldForm
          initialName={stage.command}
          initialAgent={stage.agent}
          onCreated={(name) => {
            set({ command: name })
            setScaffold(null)
            onScaffolded()
          }}
          onCancel={() => setScaffold(null)}
        />
      )}
      <Field label="agent (persona)">
        <input list="asset-agents" value={stage.agent} onChange={(e) => set({ agent: e.target.value })} />
        <datalist id="asset-agents">
          {assets?.agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.description}
            </option>
          ))}
        </datalist>
      </Field>
      <div className="asset-hint">
        {isUnknownAsset(knownNames(assets?.agents), stage.agent) && (
          <span>not in this repo yet — it will appear on the post-save checklist</span>
        )}
        <Button onClick={() => setScaffold((s) => (s === "agent" ? null : "agent"))}>+ new agent</Button>
      </div>
      {scaffold === "agent" && (
        <AgentScaffoldForm
          initialName={stage.agent}
          defaultPreset={stage.kind === "check" ? "checker" : "builder"}
          skills={assets?.skills ?? []}
          onCreated={(name, createdNotes) => {
            set({ agent: name })
            setNotes(createdNotes ?? [])
            setScaffold(null)
            onScaffolded()
          }}
          onSkillCreated={onScaffolded}
          onCancel={() => setScaffold(null)}
        />
      )}
      {notes.map((n, k) => (
        <div key={k} className="muted asset-note">
          {n}
        </div>
      ))}
      <Field label="isolation">
        <select value={stage.isolation} onChange={(e) => set({ isolation: e.target.value as StageDef["isolation"] })}>
          <option value="worktree">worktree (isolated)</option>
          <option value="none">none (main tree)</option>
        </select>
      </Field>
      <Field label="timeout minutes (blank = config default)">
        <input
          type="number"
          value={stage.timeoutMinutes ?? ""}
          onChange={(e) => {
            const { timeoutMinutes: _drop, ...rest } = stage
            onChange(e.target.value ? ({ ...rest, timeoutMinutes: Number(e.target.value) } as StageDef) : (rest as StageDef))
          }}
        />
      </Field>
      <Field label="bash allowlist (comma-separated globs; blank = deny all in check stages)">
        <input
          value={csv(stage.bashAllowlist)}
          onChange={(e) => {
            const { bashAllowlist: _drop, ...rest } = stage
            const list = fromCsv(e.target.value)
            onChange(list.length ? ({ ...rest, bashAllowlist: list } as StageDef) : (rest as StageDef))
          }}
        />
      </Field>
      <Field label="stage prompt (stages/{name}.md)">
        <textarea rows={10} value={prompt} onChange={(e) => onPromptChange(e.target.value)} />
      </Field>
      <PromptPreview manifest={manifest} stage={stage.name} prompts={prompts} />
      <Button variant="danger" onClick={onDelete}>
        Delete stage
      </Button>
    </div>
  )
}

const CUSTOM_STATUS = "__custom__"

/** Inline popover form for adding a park/done terminal (stop never asks — it has no status). */
export const TerminalAddForm = ({
  outcome,
  workSource,
  onAdd,
  onCancel,
}: {
  outcome: "park" | "done"
  workSource: LoopManifest["workSource"]
  onAdd: (toStatus?: string) => void
  onCancel: () => void
}) => {
  const options = terminalStatusOptions(workSource)
  const [choice, setChoice] = useState("")
  const [custom, setCustom] = useState("")
  const freeText = options.length === 0 || choice === CUSTOM_STATUS
  const submit = (): void => {
    // trim + drop empties: toStatus is optional but must be non-empty when present
    const status = (freeText ? custom : choice).trim()
    onAdd(status || undefined)
  }
  return (
    <div className="panel-form">
      <h3>Add {outcome} terminal</h3>
      {options.length > 0 && (
        <Field label="move the task to (backlog status)">
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">(no status move)</option>
            {options.map((s) => (
              <option key={s} value={s}>
                {s}/
              </option>
            ))}
            <option value={CUSTOM_STATUS}>custom…</option>
          </select>
        </Field>
      )}
      {freeText && (
        <Field label="status folder (optional)">
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. plan-review" />
        </Field>
      )}
      <div className="terminal-popover__actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={submit}>
          Add
        </Button>
      </div>
    </div>
  )
}

export interface EdgeFormValue {
  readonly targetIsTerminal: boolean
  readonly message?: string
  readonly countIteration?: boolean
  readonly capMessage?: string
  readonly dropArtifacts?: readonly string[]
}

export const EdgeForm = ({
  slot,
  targetLabel,
  value,
  onChange,
  onDelete,
}: {
  slot: string
  targetLabel: string
  value: EdgeFormValue
  onChange: (next: EdgeFormValue) => void
  onDelete: () => void
}) => (
  <div className="panel-form">
    <h3>
      Transition: {slot} → {targetLabel}
    </h3>
    {value.targetIsTerminal ? (
      <Field label="message (shown to the human at this outcome)">
        <textarea rows={3} value={value.message ?? ""} onChange={(e) => onChange({ ...value, message: e.target.value })} />
      </Field>
    ) : (
      <>
        <Field label="count iteration (re-fire burns the shared retry budget)">
          <input
            type="checkbox"
            checked={value.countIteration ?? false}
            onChange={(e) => onChange({ ...value, countIteration: e.target.checked })}
          />
        </Field>
        {value.countIteration && (
          <Field label="cap message (required; {maxIterations} interpolates)">
            <textarea rows={2} value={value.capMessage ?? ""} onChange={(e) => onChange({ ...value, capMessage: e.target.value })} />
          </Field>
        )}
        <Field label="drop artifacts (stale feedback to remove, comma-separated)">
          <input
            value={csv(value.dropArtifacts)}
            onChange={(e) => onChange({ ...value, dropArtifacts: fromCsv(e.target.value) })}
          />
        </Field>
      </>
    )}
    <Button variant="danger" onClick={onDelete}>
      Delete transition
    </Button>
  </div>
)

export const MetaForm = ({ meta, onChange }: { meta: GraphMeta; onChange: (next: GraphMeta) => void }) => {
  const ws = meta.workSource
  return (
    <div className="panel-form">
      <h3>Loop kind</h3>
      <Field label="kind (folder + command name)">
        <input value={meta.kind} onChange={(e) => onChange({ ...meta, kind: e.target.value })} />
      </Field>
      <Field label="description">
        <textarea rows={2} value={meta.description} onChange={(e) => onChange({ ...meta, description: e.target.value })} />
      </Field>
      <Field label="max iterations (blank = config default)">
        <input
          type="number"
          value={meta.maxIterations ?? ""}
          onChange={(e) => {
            const { maxIterations: _drop, ...rest } = meta
            onChange(e.target.value ? { ...rest, maxIterations: Number(e.target.value) } : rest)
          }}
        />
      </Field>
      <Field label="work source">
        <select
          value={ws.type}
          onChange={(e) =>
            onChange({
              ...meta,
              workSource:
                e.target.value === "backlog"
                  ? { type: "backlog", statuses: ["queued", "in-progress", "completed"], pools: [] }
                  : e.target.value === "dependency-scan"
                    ? { type: "dependency-scan", autoFix: ["patch", "minor"], severityFloor: "high", includeOutdated: false, ecosystem: "auto" }
                    : e.target.value === "ci-runs"
                      ? { type: "ci-runs", workflows: [] }
                      : { type: "github-pr", query: "is:open author:@me", triggers: ["failing-checks"], role: "author" },
            })
          }
        >
          <option value="backlog">backlog — docs/tasks folders</option>
          <option value="github-pr">github-pr — open pull requests</option>
          <option value="dependency-scan">dependency-scan — npm audit / OSV-Scanner</option>
          <option value="ci-runs">ci-runs — the watched branch's CI</option>
        </select>
      </Field>
      {ws.type === "backlog" && (
        <>
          <Field label="statuses (lifecycle order, comma-separated)">
            <input
              value={csv(ws.statuses)}
              onChange={(e) => onChange({ ...meta, workSource: { ...ws, statuses: fromCsv(e.target.value) } })}
            />
          </Field>
          <Field label="pools (status:entryStage[:claimPredicate][:manual], one per line, priority order)">
            <textarea
              rows={3}
              value={ws.pools
                .map((p) => [p.status, p.entryStage, p.claimPredicate, p.manual ? "manual" : undefined].filter(Boolean).join(":"))
                .join("\n")}
              onChange={(e) => {
                const pools = e.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const parts = line.split(":").map((s) => s.trim())
                    const manual = parts[parts.length - 1] === "manual"
                    if (manual) parts.pop()
                    const [status = "", entryStage = "", claimPredicate] = parts
                    return { status, entryStage, manual, ...(claimPredicate ? { claimPredicate } : {}) }
                  })
                onChange({ ...meta, workSource: { ...ws, pools } })
              }}
            />
          </Field>
        </>
      )}
      {ws.type === "github-pr" && (
        <>
          <Field label="query (gh pr list --search)">
            <input value={ws.query} onChange={(e) => onChange({ ...meta, workSource: { ...ws, query: e.target.value } })} />
          </Field>
          <Field label="role (author = own PRs, may push; reviewer = requested reviews, comment-only)">
            <select
              value={ws.role}
              onChange={(e) => onChange({ ...meta, workSource: { ...ws, role: e.target.value === "reviewer" ? "reviewer" : "author" } })}
            >
              <option value="author">author</option>
              <option value="reviewer">reviewer</option>
            </select>
          </Field>
          <Field label="triggers">
            {(["failing-checks", "changes-requested", "new-comments", "merge-conflict", "review-requested"] as const).map((t) => (
              <label key={t} className="check-inline">
                <input
                  type="checkbox"
                  checked={ws.triggers.includes(t)}
                  onChange={(e) =>
                    onChange({
                      ...meta,
                      workSource: {
                        ...ws,
                        triggers: e.target.checked ? [...ws.triggers, t] : ws.triggers.filter((x) => x !== t),
                      },
                    })
                  }
                />
                {t}
              </label>
            ))}
          </Field>
        </>
      )}
      {ws.type === "dependency-scan" && (
        <>
          <Field label="ecosystem (auto = detect npm/maven/gradle and merge)">
            <select
              value={ws.ecosystem}
              onChange={(e) =>
                onChange({
                  ...meta,
                  workSource: {
                    ...ws,
                    ecosystem: (["auto", "npm", "maven", "gradle"].includes(e.target.value) ? e.target.value : "auto") as typeof ws.ecosystem,
                  },
                })
              }
            >
              {["auto", "npm", "maven", "gradle"].map((eco) => (
                <option key={eco} value={eco}>
                  {eco}
                </option>
              ))}
            </select>
          </Field>
          <Field label="severity floor">
            <select
              value={ws.severityFloor}
              onChange={(e) =>
                onChange({
                  ...meta,
                  workSource: { ...ws, severityFloor: (["low", "moderate", "high", "critical"].includes(e.target.value) ? e.target.value : "high") as typeof ws.severityFloor },
                })
              }
            >
              {["low", "moderate", "high", "critical"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="also claim non-vulnerable outdated deps">
            <input
              type="checkbox"
              checked={ws.includeOutdated}
              onChange={(e) => onChange({ ...meta, workSource: { ...ws, includeOutdated: e.target.checked } })}
            />
          </Field>
        </>
      )}
      {ws.type === "ci-runs" && (
        <>
          <Field label="branch (blank = the remote default branch)">
            <input
              value={ws.branch ?? ""}
              onChange={(e) => {
                const { branch: _drop, ...rest } = ws
                onChange({ ...meta, workSource: e.target.value ? { ...rest, branch: e.target.value } : rest })
              }}
            />
          </Field>
          <Field label="workflows (comma-separated; blank = all)">
            <input
              value={csv(ws.workflows)}
              onChange={(e) => onChange({ ...meta, workSource: { ...ws, workflows: fromCsv(e.target.value) } })}
            />
          </Field>
        </>
      )}
      {Object.keys(meta.hooks.compose ?? {}).length + Object.keys(meta.hooks.validateBeforeTransition ?? {}).length > 0 && (
        <div className="muted">
          hooks: {JSON.stringify(meta.hooks)} (registry refs — edited in TS, preserved here)
        </div>
      )}
    </div>
  )
}
