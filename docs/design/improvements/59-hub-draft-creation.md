English | [繁體中文](59-hub-draft-creation.zh-TW.md)

# 59 — The board can create a draft

**Status: implemented.**

## The problem

The hub could gate, edit in place, plan, abandon, restore and remove a task
and could not CREATE one. The first column's only entrances were the CLI's
`new` interview and a hand-written file — and `writeTask`, core's
programmatic creator, had no caller at all: the CLI `new` verb deliberately
hands the turn to an authoring agent instead of writing a file itself.

## What changed

- **`POST /api/tasks/draft`** (`postTaskCreate`): the editor's fields minus
  the two that describe an existing file (`expectStatus`, `baseHash`), the
  same bounds and single-line rule (`CreateTaskRequestSchema`), the same
  secret-shaped refusal — named, never rewritten. Under the gate lock so two
  creates cannot mint one id from one lagging index; `writeTask` mints the
  board-unique id and refuses to clobber; a `Task created in the hub` note
  and `commitBacklog` like every other backlog write.
- **`NewDraft`** on the board's draft column (`+ new`), reusing the editor's
  `Field`/`fromLines` helpers behind the same `<Confirm>`; on success the
  form closes and the new task opens in the drawer.

## Sharp edges

- **A form, not an interview.** The CLI's `new` shapes an idea through an
  interview and a subagent; the hub has no agent, so the human fills the
  fields the interview would have. The draft waits at the task gate like any
  other, and the editor can reshape it before approval.
- **The engineering column only.** `sourceType: "backlog"` gates the button;
  a sitter board has no draft folder to write into.
