import type { AuditNote } from "../shared/api.js"

/**
 * Extract the audit blockquote trail from a task body. The loop appends
 * `> <event> [<ISO timestamp> by <actor>]` lines (task/store.ts auditNote);
 * plain `> <event>` blockquotes (no stamp) are kept too with empty at/by so
 * the timeline stays complete. Pure.
 *
 * Deliberately permissive, unlike core's `AUDIT_NOTE_LINE_RE` (task/store.ts),
 * which requires the stamp because it marks where the plan text ends — there a
 * stray blockquote would truncate the plan, here it only adds a timeline row.
 * Keep the two separate.
 */

const STAMPED = /^>\s+(.*?)\s+\[([^\]]+?)\s+by\s+([^\]]+)\]\s*$/
const PLAIN = /^>\s+(\S.*?)\s*$/

export const extractAuditNotes = (body: string): AuditNote[] => {
  const notes: AuditNote[] = []
  for (const line of body.split("\n")) {
    const stamped = STAMPED.exec(line)
    if (stamped) {
      notes.push({ event: stamped[1] as string, at: stamped[2] as string, by: stamped[3] as string })
      continue
    }
    const plain = PLAIN.exec(line)
    if (plain) notes.push({ event: plain[1] as string, at: "", by: "" })
  }
  return notes
}
