import { useCallback, useEffect, useState } from "react"
import type { WorkflowManifest } from "@agentic-workflow/core/manifest/schema"
import type { PreviewResponse, PreviewSample } from "../../shared/api.js"
import { postJson } from "../api.js"
import { Button } from "../ui/Button.js"

/**
 * Render the selected stage's prompt the way the loop will compose it.
 *
 * The toggles are the point. A stage prompt is mostly conditional sections —
 * `{{#task.id}}`, `{{#worktree}}`, `{{#platform.ado}}` — and the mistake they
 * hide is a block that silently never fires. Flipping a switch and watching a
 * paragraph appear or vanish is what tells an author their template is wired to
 * the state it thinks it is. Without them this would be a glorified `cat`.
 *
 * The render happens server-side: `renderPrompt` is pure and could run here, but
 * shared/api.ts draws the boundary at type-only imports from core, and one
 * feature isn't worth pulling the template engine into the bundle.
 */

const TOGGLES: readonly { key: keyof Omit<PreviewSample, "platform">; label: string; hint: string }[] = [
  { key: "task", label: "task", hint: "loop started from a backlog task" },
  { key: "git", label: "git", hint: "branch/base established" },
  { key: "worktree", label: "worktree", hint: "isolated checkout (implies git)" },
]

export const PromptPreview = ({
  manifest,
  stage,
  prompts,
}: {
  manifest: WorkflowManifest | null
  stage: string
  prompts: Readonly<Record<string, string>>
}) => {
  const [open, setOpen] = useState(false)
  const [sample, setSample] = useState<PreviewSample>({ task: true, git: true, worktree: true, platform: "github" })
  const [result, setResult] = useState<PreviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const promptSrc = prompts[stage] ?? ""

  const run = useCallback(async (): Promise<void> => {
    if (!manifest) return
    try {
      setResult(await postJson<PreviewResponse>("/api/kinds/preview", { manifest, prompts, stage, sample }))
      setError(null)
    } catch (e) {
      setResult(null)
      setError((e as Error).message)
    }
  }, [manifest, prompts, stage, sample])

  // Re-render as the author types or flips a toggle — the feedback loop is the
  // feature, and the route is a local, pure function call away.
  useEffect(() => {
    if (!open) return
    void run()
  }, [open, run])

  if (!manifest) return null

  return (
    <div className="preview">
      <div className="preview__head">
        <Button onClick={() => setOpen((o) => !o)}>{open ? "Hide preview" : "Preview prompt"}</Button>
        {open && (
          <div className="preview__toggles">
            {TOGGLES.map((t) => (
              <label key={t.key} title={t.hint}>
                <input
                  type="checkbox"
                  checked={sample[t.key]}
                  onChange={(e) => setSample((s) => ({ ...s, [t.key]: e.target.checked }))}
                />
                {t.label}
              </label>
            ))}
            <label title="which platform branch of the template renders">
              <select
                value={sample.platform}
                onChange={(e) => setSample((s) => ({ ...s, platform: e.target.value as PreviewSample["platform"] }))}
              >
                <option value="github">github</option>
                <option value="ado">ado</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {open && (
        <>
          {error && <p className="preview__error">{error}</p>}
          {result?.note && <p className="preview__note">{result.note}</p>}
          {promptSrc.trim().length === 0 && !error && (
            <p className="preview__note">This stage has no prompt yet — type one above to see it render.</p>
          )}
          {result && <pre className="preview__out">{result.rendered}</pre>}
        </>
      )}
    </div>
  )
}
