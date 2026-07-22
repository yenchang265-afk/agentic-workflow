import { useState } from "react"
import type { AgentPreset, AssetSkill, ScaffoldResponse } from "../../shared/api.js"
import { postJson } from "../api.js"
import { Button } from "../ui/Button.js"

/**
 * Scaffold-with-light-fields forms for repo assets (agent persona / command
 * wrapper / skill). Each writes idiomatic stub files via the /api/assets
 * endpoints — the hub gets the asset started; deep editing stays in $EDITOR.
 * Hand-rolled pending/error state, same style as TerminalAddForm.
 */

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="form-field">
    <span>{label}</span>
    {children}
  </label>
)

const Actions = ({
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  pending: boolean
  submitLabel: string
  onSubmit: () => void
  onCancel: () => void
}) => (
  <div className="asset-scaffold__actions">
    <Button onClick={onCancel} disabled={pending}>
      Cancel
    </Button>
    <Button variant="primary" onClick={onSubmit} disabled={pending}>
      {pending ? "Working…" : submitLabel}
    </Button>
  </div>
)

export const SkillScaffoldForm = ({
  onCreated,
  onCancel,
}: {
  onCreated: (name: string) => void
  onCancel: () => void
}) => {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await postJson<ScaffoldResponse>("/api/assets/skill", { name: name.trim(), description })
      onCreated(name.trim())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="asset-scaffold">
      <h3>New skill</h3>
      <Field label="name (skills/<name>/SKILL.md)">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. release-notes" />
      </Field>
      <Field label="description (when should an agent invoke it?)">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {error && <div className="asset-scaffold__error">{error}</div>}
      <Actions pending={pending} submitLabel="Create skill" onSubmit={() => void submit()} onCancel={onCancel} />
    </div>
  )
}

export const AgentScaffoldForm = ({
  initialName,
  defaultPreset,
  skills,
  onCreated,
  onSkillCreated,
  onCancel,
}: {
  initialName: string
  defaultPreset: AgentPreset
  skills: readonly AssetSkill[]
  onCreated: (name: string, notes?: readonly string[]) => void
  /** A skill was scaffolded from inside this form — parent should refetch the inventory. */
  onSkillCreated: () => void
  onCancel: () => void
}) => {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState("")
  const [preset, setPreset] = useState<AgentPreset>(defaultPreset)
  const [checked, setChecked] = useState<readonly string[]>([])
  // Skills created inline show up immediately, even before the inventory refetch lands.
  const [extraSkills, setExtraSkills] = useState<readonly AssetSkill[]>([])
  const [newSkill, setNewSkill] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allSkills = [...skills, ...extraSkills.filter((e) => !skills.some((s) => s.name === e.name))]

  const submit = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const res = await postJson<ScaffoldResponse>("/api/assets/agent", {
        name: name.trim(),
        description,
        preset,
        skills: checked,
      })
      onCreated(name.trim(), res.notes)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  if (newSkill) {
    return (
      <SkillScaffoldForm
        onCreated={(skillName) => {
          setExtraSkills((x) => [...x, { name: skillName }])
          setChecked((c) => [...c, skillName])
          setNewSkill(false)
          onSkillCreated()
        }}
        onCancel={() => setNewSkill(false)}
      />
    )
  }

  return (
    <div className="asset-scaffold">
      <h3>New agent persona</h3>
      <Field label="name (prompts/agents/<name>/)">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. workflow-triage" />
      </Field>
      <Field label="description (one line, becomes the persona frontmatter)">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="permission preset">
        <select value={preset} onChange={(e) => setPreset(e.target.value === "checker" ? "checker" : "builder")}>
          <option value="builder">builder — edits files, full bash</option>
          <option value="checker">checker — read-only, allowlisted bash + verdict tool</option>
        </select>
      </Field>
      <Field label="skills to invoke (woven into body.md as prose)">
        <div>
          {allSkills.map((s) => (
            <label key={s.name} className="check-inline" title={s.description ?? ""}>
              <input
                type="checkbox"
                checked={checked.includes(s.name)}
                onChange={(e) =>
                  setChecked((c) => (e.target.checked ? [...c, s.name] : c.filter((x) => x !== s.name)))
                }
              />
              {s.name}
            </label>
          ))}
          <Button onClick={() => setNewSkill(true)}>+ new skill</Button>
        </div>
      </Field>
      {error && <div className="asset-scaffold__error">{error}</div>}
      <Actions pending={pending} submitLabel="Create agent" onSubmit={() => void submit()} onCancel={onCancel} />
    </div>
  )
}

export const CommandScaffoldForm = ({
  initialName,
  initialAgent,
  onCreated,
  onCancel,
}: {
  initialName: string
  initialAgent: string
  onCreated: (name: string) => void
  onCancel: () => void
}) => {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState("")
  const [agent, setAgent] = useState(initialAgent)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await postJson<ScaffoldResponse>("/api/assets/command", { name: name.trim(), description, agent: agent.trim() })
      onCreated(name.trim())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="asset-scaffold">
      <h3>New opencode command</h3>
      <Field label="name (plugins/opencode/commands/<name>.md)">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. triage" />
      </Field>
      <Field label="description (one line, becomes the command frontmatter)">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="agent it delegates to (need not exist yet)">
        {/* Reuses the StageForm's asset-agents datalist — this form only mounts inside it. */}
        <input list="asset-agents" value={agent} onChange={(e) => setAgent(e.target.value)} />
      </Field>
      {error && <div className="asset-scaffold__error">{error}</div>}
      <Actions pending={pending} submitLabel="Create command" onSubmit={() => void submit()} onCancel={onCancel} />
    </div>
  )
}
