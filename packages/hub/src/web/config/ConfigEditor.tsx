import { useEffect, useState } from "react"
import type {
  ConfigEdit,
  ConfigLayer,
  ConfigLayerResponse,
  ConfigProvenance,
  MonitorKindsResponse,
  SaveConfigResponse,
} from "../../shared/api.js"
import { postJson } from "../api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { Confirm } from "../ui/Confirm.js"
import { useJson } from "../useJson.js"

/**
 * The `.agentic-workflow.json` editor.
 *
 * It always edits **one named layer**, never the merged view. The merged view is
 * shown beside each field as provenance, read-only. Saving a merged view to the
 * repo file would flatten the user layer into it — writing `ado.pat` out of
 * `~/.agentic-workflow.json` and into a file that may well be committed.
 */

const PROV_TITLE: Readonly<Record<ConfigProvenance, string>> = {
  repo: "set by this repo's .agentic-workflow.json",
  user: "inherited from your ~/.agentic-workflow.json (edit the user layer to change it)",
  default: "not set in either file — the schema's default applies",
}

const Prov = ({ from }: { from: ConfigProvenance | undefined }) =>
  from ? (
    <Badge tone={from === "repo" ? "ok" : undefined} title={PROV_TITLE[from]}>
      {from}
    </Badge>
  ) : null

interface FieldProps {
  label: string
  path: string
  hint?: string
  provenance: ConfigProvenance | undefined
  children: React.ReactNode
}

const Field = ({ label, path, hint, provenance, children }: FieldProps) => (
  <label className="form-field cfg-field">
    <span>
      {label} <Prov from={provenance} />
    </span>
    {children}
    {hint && <small className="cfg-hint">{hint}</small>}
    <code className="cfg-path">{path}</code>
  </label>
)

export const ConfigEditor = () => {
  const { repoId } = useRepo()
  const { versions } = useEvents()
  const [layer, setLayer] = useState<ConfigLayer>("repo")
  const [edits, setEdits] = useState<Record<string, ConfigEdit>>({})
  const [saved, setSaved] = useState<SaveConfigResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, error: loadError } = useJson<ConfigLayerResponse>(
    repoPath(`/api/config?layer=${layer}`, repoId),
    [layer, repoId, versions.config],
  )
  const { data: kinds } = useJson<MonitorKindsResponse>(repoPath("/api/monitor/kinds", repoId), [repoId, versions.config])

  // A layer or repo switch abandons pending edits rather than carrying them to a
  // different file — silently writing them somewhere else would be worse.
  useEffect(() => {
    setEdits({})
    setSaved(null)
    setError(null)
  }, [layer, repoId])

  if (loadError) return <div className="error-banner">Could not load config: {loadError}</div>
  if (!data) return <div className="placeholder">Loading config…</div>

  const raw = data.raw ?? {}
  const at = (path: string): unknown => path.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), raw)
  const pending = (path: string): unknown => (path in edits ? edits[path]?.value : at(path))
  const set = (path: string, value: unknown): void => setEdits((e) => ({ ...e, [path]: { path, value } }))
  const clear = (path: string): void => setEdits((e) => ({ ...e, [path]: { path } }))
  const prov = (path: string): ConfigProvenance | undefined => data.provenance[path]

  const str = (path: string): string => {
    const v = pending(path)
    return v === undefined || v === null ? "" : String(v)
  }

  const setOrClear = (path: string, text: string, cast: (s: string) => unknown = (s) => s): void =>
    text.trim() === "" ? clear(path) : set(path, cast(text))

  const dirty = Object.keys(edits).length > 0

  const save = async (): Promise<void> => {
    try {
      setSaved(await postJson<SaveConfigResponse>(repoPath("/api/config", repoId), { layer, edits: Object.values(edits) }))
      setEdits({})
      setError(null)
    } catch (e) {
      setSaved(null)
      setError((e as Error).message)
    }
  }

  return (
    <div className="cfg">
      <div className="cfg-head">
        <div className="cfg-layers">
          {(["repo", "user"] as const).map((l) => (
            <Button key={l} variant={layer === l ? "primary" : "default"} onClick={() => setLayer(l)}>
              {l === "repo" ? "This repo" : "User (all repos)"}
            </Button>
          ))}
        </div>
        <code className="cfg-file">{data.path ?? "(layer disabled)"}</code>
      </div>

      {data.parseError && (
        <div className="error-banner">
          This file isn’t valid JSON ({data.parseError}). Fix it by hand — the editor won’t touch a file it can’t parse,
          because rewriting it would destroy whatever is in there.
        </div>
      )}

      {data.issues.length > 0 && (
        <div className="error-banner">
          <strong>The merged config is invalid.</strong> Saving is refused until it validates.
          <ul>
            {data.issues.map((i) => (
              <li key={`${i.path}-${i.message}`}>
                <code>{i.path}</code> — {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!data.parseError && (
        <>
          <section className="cfg-section">
            <h3>Loop</h3>
            <Field label="max iterations" path="maxIterations" provenance={prov("maxIterations")} hint="verify/review failures before the loop stops">
              <input type="number" value={str("maxIterations")} onChange={(e) => setOrClear("maxIterations", e.target.value, Number)} />
            </Field>
            <Field label="tasks dir" path="tasksDir" provenance={prov("tasksDir")} hint="changing this re-points the watcher">
              <input value={str("tasksDir")} onChange={(e) => setOrClear("tasksDir", e.target.value)} />
            </Field>
            <Field label="stage timeout (minutes)" path="stageTimeoutMinutes" provenance={prov("stageTimeoutMinutes")}>
              <input type="number" value={str("stageTimeoutMinutes")} onChange={(e) => setOrClear("stageTimeoutMinutes", e.target.value, Number)} />
            </Field>
            <Field label="worktrees dir" path="worktreesDir" provenance={prov("worktreesDir")} hint='set to "false" for shared-tree branch switching'>
              <input
                value={str("worktreesDir")}
                onChange={(e) => setOrClear("worktreesDir", e.target.value, (s) => (s === "false" ? false : s))}
              />
            </Field>
            <Field label="worktree setup command" path="worktreeSetup" provenance={prov("worktreeSetup")} hint="e.g. npm ci — runs in a fresh worktree">
              <input value={str("worktreeSetup")} onChange={(e) => setOrClear("worktreeSetup", e.target.value)} />
            </Field>
            <Field label="review lenses" path="reviewLenses" provenance={prov("reviewLenses")} hint="comma-separated, max 5 — each runs REVIEW again focused on that lens">
              <input
                value={(pending("reviewLenses") as string[] | undefined)?.join(", ") ?? ""}
                onChange={(e) => {
                  const list = e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                  list.length ? set("reviewLenses", list) : clear("reviewLenses")
                }}
              />
            </Field>
          </section>

          <section className="cfg-section">
            <h3>Code platform</h3>
            <Field label="platform" path="codePlatform" provenance={prov("codePlatform")}>
              <select value={str("codePlatform") || "github"} onChange={(e) => set("codePlatform", e.target.value)}>
                <option value="github">github (gh CLI)</option>
                <option value="ado">ado (Azure DevOps REST)</option>
              </select>
            </Field>
            {["organization", "project", "repository", "selfLogin"].map((k) => (
              <Field key={k} label={`ado.${k}`} path={`ado.${k}`} provenance={prov(`ado.${k}`)}>
                <input value={str(`ado.${k}`)} onChange={(e) => setOrClear(`ado.${k}`, e.target.value)} />
              </Field>
            ))}
            <Field
              label="ado.pat"
              path="ado.pat"
              provenance={prov("ado.pat")}
              hint="prefer the AZURE_DEVOPS_EXT_PAT env var. Stored in plaintext; the file must be gitignored, and the hub refuses to write it into one that isn't."
            >
              <input
                type="password"
                value={str("ado.pat")}
                onChange={(e) => setOrClear("ado.pat", e.target.value)}
                placeholder={data.redactedPaths.includes("ado.pat") ? "unchanged (stored)" : ""}
              />
            </Field>
          </section>

          <section className="cfg-section">
            <h3>Workflow kinds</h3>
            <p className="cfg-hint">
              Engineering runs unless disabled; every other kind is opt-in. This is the switch the creator’s checklist
              points at.
            </p>
            {(kinds?.kinds ?? []).map((k) => {
              const path = `workflows.${k.kind}.enabled`
              const value = pending(path)
              const on = value === undefined ? k.kind === "engineering" : value === true
              return (
                <Field key={k.kind} label={k.kind} path={path} provenance={prov(path)} hint={k.description}>
                  <input type="checkbox" checked={on} onChange={(e) => set(path, e.target.checked)} />
                </Field>
              )
            })}
          </section>

          {data.warnings.length > 0 && (
            <section className="cfg-section">
              <h3>Warnings</h3>
              <p className="cfg-hint">
                Advisory — these never block a save. They’re knobs the loop reads positionally, so a typo is silently
                ignored rather than reported.
              </p>
              <ul className="cfg-warnings">
                {data.warnings.map((w) => (
                  <li key={w.path}>
                    <code>{w.path}</code> — {w.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.passthrough.length > 0 && (
            <section className="cfg-section">
              <h3>Preserved, not editable</h3>
              <p className="cfg-hint">
                Keys in this file that core’s schema doesn’t define — a host-only setting, the hub’s own section, or a
                typo. The editor writes raw JSON, so they survive a save untouched; they’re listed here so “preserved” is
                visible rather than assumed.
              </p>
              <ul className="cfg-warnings">
                {data.passthrough.map((k) => (
                  <li key={k}>
                    <code>{k}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <div className="cfg-actions">
        <Confirm
          title="Save this config?"
          detail={
            <>
              Writes <code>{data.path}</code> — the <strong>{layer === "repo" ? "repo" : "user"}</strong> layer only.
              Values shown as <em>{layer === "repo" ? "user" : "repo"}</em> or <em>default</em> are not copied into it.
              The hub reloads immediately; a running loop picks it up on its next stage.
            </>
          }
          confirmLabel="Save"
          onConfirm={save}
          trigger={
            <Button variant="primary" disabled={!dirty || !!data.parseError}>
              {dirty ? `Save ${Object.keys(edits).length} change${Object.keys(edits).length === 1 ? "" : "s"}` : "No changes"}
            </Button>
          }
        />
        {dirty && <Button onClick={() => setEdits({})}>Discard</Button>}
        {saved && <span className="cfg-saved">Saved {saved.written}</span>}
        {error && <span className="cfg-error">{error}</span>}
      </div>
    </div>
  )
}
