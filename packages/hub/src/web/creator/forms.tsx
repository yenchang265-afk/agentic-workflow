import type { StageDef } from "@agentic-loop/core/manifest/schema"
import type { GraphMeta } from "./graphmodel.js"
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
  onChange,
  onPromptChange,
  onDelete,
}: {
  stage: StageDef
  prompt: string
  onChange: (next: StageDef) => void
  onPromptChange: (text: string) => void
  onDelete: () => void
}) => {
  const set = (patch: Partial<StageDef>): void => onChange({ ...stage, ...patch } as StageDef)
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
        <input value={stage.command} onChange={(e) => set({ command: e.target.value })} />
      </Field>
      <Field label="agent (persona)">
        <input value={stage.agent} onChange={(e) => set({ agent: e.target.value })} />
      </Field>
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
      <Button variant="danger" onClick={onDelete}>
        Delete stage
      </Button>
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
                  : { type: "github-pr", query: "is:open author:@me", triggers: ["failing-checks"] },
            })
          }
        >
          <option value="backlog">backlog — docs/tasks folders</option>
          <option value="github-pr">github-pr — open pull requests</option>
        </select>
      </Field>
      {ws.type === "backlog" ? (
        <>
          <Field label="statuses (lifecycle order, comma-separated)">
            <input
              value={csv(ws.statuses)}
              onChange={(e) => onChange({ ...meta, workSource: { ...ws, statuses: fromCsv(e.target.value) } })}
            />
          </Field>
          <Field label="pools (status:entryStage[:claimPredicate], one per line, priority order)">
            <textarea
              rows={3}
              value={ws.pools.map((p) => [p.status, p.entryStage, p.claimPredicate].filter(Boolean).join(":")).join("\n")}
              onChange={(e) => {
                const pools = e.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const [status = "", entryStage = "", claimPredicate] = line.split(":").map((s) => s.trim())
                    return { status, entryStage, ...(claimPredicate ? { claimPredicate } : {}) }
                  })
                onChange({ ...meta, workSource: { ...ws, pools } })
              }}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="query (gh pr list --search)">
            <input value={ws.query} onChange={(e) => onChange({ ...meta, workSource: { ...ws, query: e.target.value } })} />
          </Field>
          <Field label="triggers">
            {(["failing-checks", "changes-requested", "new-comments", "merge-conflict"] as const).map((t) => (
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
      {Object.keys(meta.hooks.compose ?? {}).length + Object.keys(meta.hooks.validateBeforeTransition ?? {}).length > 0 && (
        <div className="muted">
          hooks: {JSON.stringify(meta.hooks)} (registry refs — edited in TS, preserved here)
        </div>
      )}
    </div>
  )
}
