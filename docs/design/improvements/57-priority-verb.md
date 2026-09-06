English | [繁體中文](57-priority-verb.zh-TW.md)

# 57 — `priority <id> <n>`: the loop's own ordering knob, from the terminal

**Status: implemented.**

## The problem

`priority` is the one frontmatter field the loop's scheduling reads
(`selectOrder`: lowest first, ties by id). The hub's editor could change it;
no CLI verb could — the terminal the loop is driven from had `retask` (an
interview that rewrites the goal) and hand-editing YAML, which skips the
off-schema screen, the audit note and the commit.

## What changed

- **`setTaskPriority(ctx, id, priority)`** in `workflow/gate.ts`: resolves
  the id, refuses a value outside `PRIORITY_MIN..PRIORITY_MAX`, a terminal
  folder (nothing orders a completed or abandoned task), a live-driven or
  claim-held task, and a file carrying off-schema frontmatter (`rewriteTask`
  serialises through the schema, and zod strips what it does not know — that
  is refused, never warned past). The current value is an `alreadyDone`
  success. Otherwise: `rewriteTask` with the one field changed, a
  `Priority changed from X to Y` audit note, `commitBacklog`.
- **`PRIORITY_MIN` / `PRIORITY_MAX`** exported from `task/schema.ts` and used
  by the hub's `SaveTaskRequestSchema`, so the two writers share one bound.
- **Both hosts**: `priority <id> <n>` (the hook parses "an integer follows the
  id" because it blocks the turn and no model could ask for the number),
  `workflow_priority`.

## Sharp edges

- **The bound is on the writers, not the parse schema.** A hand-written task
  outside it must still parse, or it would vanish from every listing instead
  of merely sorting first or last.
- **Any non-terminal folder, including `in-progress/`.** A build-ready task
  waiting for a claim is ordered by priority; the claim-held and live-loop
  refusals are what keep a task mid-run out of reach.
- **No hub button.** The editor already covers it; a second write path for
  one field would be a second place for the bound to drift.
