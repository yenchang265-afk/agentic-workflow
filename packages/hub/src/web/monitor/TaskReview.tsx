import { useMemo, useState } from "react"
import type { GateResult, TaskCard, TaskStatus } from "../../shared/api.js"
import { postAction } from "../api.js"
import { Markdown } from "../markdown/Markdown.js"
import { parseBlocks, type Block } from "../markdown/parse.js"
import { repoPath, useRepo } from "../repo.js"
import { Button } from "../ui/Button.js"
import { Confirm } from "../ui/Confirm.js"
import { composeReason, reasonStats, sendableCount, type AnchoredComment, type CommentTarget } from "./comments.js"

/**
 * The drawer's read-only half — a task the editor will not touch, because it
 * already has a plan (or a loop is driving it) — rendered as Markdown you can
 * comment on line by line.
 *
 * The comments are the point. Replan already took a reason, but it was typed
 * into a textarea with none of the plan in front of it, so it came out vague
 * ("step 2 is wrong") and the next PLAN pass repeated the mistake. Here each
 * comment quotes the block it hangs off, and they are composed into that same
 * reason — so the audit note still says which step, three stages later.
 *
 * Comments live in this component only: they are a composition aid for one gate
 * move, not a review thread. What persists is the note replan writes, which is
 * what the next pass actually reads.
 */

/** Replan is the only move a reviewer can send from here; these are its origins. */
const REPLAN_FROM: readonly TaskStatus[] = ["plan-review", "in-progress"]

const Composer = ({
  initial,
  onSave,
  onRemove,
  onCancel,
}: {
  initial: string
  onSave: (note: string) => void
  onRemove: () => void
  onCancel: () => void
}) => {
  const [text, setText] = useState(initial)
  return (
    <div className="md-composer">
      <textarea
        rows={3}
        autoFocus
        value={text}
        placeholder="What should change here?"
        onChange={(e) => setText(e.target.value)}
        // Ctrl/Cmd+Enter saves — the same reflex as a review comment box.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(text)
        }}
      />
      <div className="md-composer__actions">
        <Button variant="primary" onClick={() => onSave(text)}>
          Save comment
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        {initial !== "" && (
          <Button variant="danger" onClick={onRemove}>
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}

/** One commentable file section (the task body, or the plan). */
const Section = ({
  title,
  target,
  source,
  comments,
  composing,
  setComposing,
  onSave,
  onRemove,
  commentable,
}: {
  title: string
  target: CommentTarget
  source: string
  comments: Readonly<Record<string, AnchoredComment>>
  composing: string | null
  setComposing: (key: string | null) => void
  onSave: (target: CommentTarget, block: Block, note: string) => void
  onRemove: (target: CommentTarget, block: Block) => void
  /** False where no gate move could carry a comment — then it is just a preview. */
  commentable: boolean
}) => {
  const blocks = useMemo(() => parseBlocks(source), [source])
  const mine = Object.values(comments).filter((c) => c.target === target)
  const notes = Object.fromEntries(mine.map((c) => [c.id, c.note]))
  // The composer key is `<target>:<blockId>`: the same line number exists in
  // both files, so the block id alone would collide across sections.
  const openIn = composing?.startsWith(`${target}:`) ? composing.slice(target.length + 1) : null

  return (
    <section>
      <h3>{title}</h3>
      <Markdown
        blocks={blocks}
        comments={notes}
        composing={openIn}
        readOnly={!commentable}
        onCompose={(id) => setComposing(id === null ? null : `${target}:${id}`)}
        composer={(block) => (
          <Composer
            initial={comments[`${target}:${block.id}`]?.note ?? ""}
            onSave={(note) => onSave(target, block, note)}
            onRemove={() => onRemove(target, block)}
            onCancel={() => setComposing(null)}
          />
        )}
      />
    </section>
  )
}

export const TaskReview = ({
  id,
  status,
  claimed,
  card,
  body,
  plan,
}: {
  id: string
  status: TaskStatus
  claimed: boolean
  card: TaskCard
  body: string
  plan?: string
}) => {
  const { repoId } = useRepo()
  const [raw, setRaw] = useState(false)
  const [composing, setComposing] = useState<string | null>(null)
  const [comments, setComments] = useState<Readonly<Record<string, AnchoredComment>>>({})
  const [result, setResult] = useState<GateResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = Object.values(comments)
  const sendable = sendableCount(list)
  // A claimed task is being driven right now; core refuses replan anyway, and
  // the drawer already says so above.
  const canSend = REPLAN_FROM.includes(status) && !claimed

  const saveComment = (target: CommentTarget, block: Block, note: string): void => {
    const key = `${target}:${block.id}`
    setComposing(null)
    setComments((prev) =>
      note.trim() === ""
        ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key))
        : { ...prev, [key]: { id: block.id, target, anchor: block.anchor, note: note.trim() } },
    )
  }

  const removeComment = (target: CommentTarget, block: Block): void => {
    const key = `${target}:${block.id}`
    setComposing(null)
    setComments((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)))
  }

  const send = async (): Promise<void> => {
    try {
      setResult(
        await postAction<GateResult>(repoPath("/api/gate/replan", repoId), {
          id,
          expectStatus: status,
          reason: composeReason(list),
        }),
      )
      setError(null)
    } catch (e) {
      setResult(null)
      setError((e as Error).message)
    }
  }

  return (
    <div className="task-view">
      <div className="task-view__bar">
        <p className="task-view__why">
          {claimed
            ? "A loop is driving this task right now — stop it, or wait for it to park, before editing."
            : canSend
              ? "Comment on any line — your comments become the reason the next PLAN pass reads."
              : "This task is read-only here; no gate move from this column carries a comment."}
        </p>
        <Button onClick={() => setRaw((r) => !r)} title="Toggle rendered preview / raw Markdown">
          {raw ? "Preview" : "Raw"}
        </Button>
      </div>

      {card.acceptance.length > 0 && (
        <section>
          <h3>acceptance</h3>
          <ul>
            {card.acceptance.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      {raw ? (
        <>
          <section>
            <h3>body</h3>
            <pre>{body}</pre>
          </section>
          {plan && (
            <section>
              <h3>plan</h3>
              <pre>{plan}</pre>
            </section>
          )}
        </>
      ) : (
        <>
          <Section
            title="body"
            target="task"
            source={body}
            comments={comments}
            composing={composing}
            setComposing={setComposing}
            onSave={saveComment}
            onRemove={removeComment}
            commentable={canSend}
          />
          {plan && (
            <Section
              title="plan"
              target="plan"
              source={plan}
              comments={comments}
              composing={composing}
              setComposing={setComposing}
              onSave={saveComment}
              onRemove={removeComment}
              commentable={canSend}
            />
          )}
        </>
      )}

      {canSend && (
        <div className="task-view__send">
          {/* Once the move landed the task has left this column, so a second send
              would 409 on a stale expectStatus. Report and stop offering it. */}
          {result?.ok ? (
            <p className="gate-msg gate-msg--ok">{result.message}</p>
          ) : (
            <>
              <span className="muted">
                {sendable === 0
                  ? "No comments yet — they are sent together as one replan reason."
                  : (() => {
                      // The reason rides one bounded audit-note line, so the
                      // meter keeps the budget visible — and says so when the
                      // notes are being clipped to share it.
                      const stats = reasonStats(list)
                      return `${sendable} comment${sendable === 1 ? "" : "s"} ready to send · reason ${stats.length}/${stats.budget}${
                        stats.squeezed ? " — the budget is shared, long notes are clipped; trim or consolidate to keep every point whole" : ""
                      }`
                    })()}
              </span>
              {sendable === 0 ? (
                <Button disabled title="Leave at least one comment first — it becomes the reason.">
                  Send back to planning
                </Button>
              ) : (
                <Confirm
                  title="Reject this plan with these comments?"
                  detail={
                    <>
                      <p>
                        Moves the task back to queued/ marked plan-next, with your comments as its audit note, and
                        commits the move. The next PLAN pass runs this task first and must address them.
                      </p>
                      <p className="muted">Your comments travel as that note — nothing else about them is kept.</p>
                    </>
                  }
                  confirmLabel="Send back to planning"
                  onConfirm={send}
                  trigger={<Button variant="primary">Send back to planning</Button>}
                />
              )}
            </>
          )}
          {/* A refusal is data, not an error: core explains why and nothing moved. */}
          {result && !result.ok && (
            <p className={`gate-msg gate-msg--${result.variant ?? "warning"}`}>{result.message}</p>
          )}
          {error && <p className="gate-msg gate-msg--warning">{error}</p>}
        </div>
      )}
    </div>
  )
}
