import { readUserLayer, resolveUserConfigPath } from "@agentic-workflow/core/config"
import { z } from "zod"

/**
 * Hub settings live in the `hub` section of the USER-SCOPE config only
 * (`~/.agentic-workflow.json`, or $AGENTIC_WORKFLOW_USER_CONFIG). The hub monitors
 * many repos at once, so a repos list inside any single repo's
 * `.agentic-workflow.json` would be circular — a repo-level `hub` key is
 * deliberately ignored.
 */

export const HubSectionSchema = z
  .object({
    /** Directories to monitor; entries may contain `*` wildcards (see repos.ts). */
    repos: z.array(z.string().min(1)).min(1),
    port: z.number().int().positive().optional(),
  })
  .strict()

export type HubSettings = z.infer<typeof HubSectionSchema>

/**
 * Read the `hub` section from the user-scope config. Returns null when the
 * layer is disabled, the file is absent, or it has no `hub` key; throws a
 * readable error naming the file on malformed JSON or an invalid section.
 */
export const loadHubSettings = (
  userConfigPath: string | null = resolveUserConfigPath(),
): HubSettings | null => {
  if (!userConfigPath) return null
  const raw = readUserLayer(userConfigPath)
  if (raw === undefined) return null
  const hub = (raw as Record<string, unknown>)["hub"]
  if (hub === undefined) return null
  const parsed = HubSectionSchema.safeParse(hub)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`Invalid ${userConfigPath}: hub${issue?.path.length ? `.${issue.path.join(".")}` : ""} — ${issue?.message}`)
  }
  return parsed.data
}
