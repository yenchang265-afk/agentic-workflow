English | [繁體中文](26-task-gate-validation.zh-TW.md)

# 26 — The task gate validates what it approves

**Status: implemented.**

## The problem

`approveTask` validated only location (a `draft/`) and the epic refusal.
Everything else about the draft was taken on faith at the one moment a human
was actually reading it:

- **No secret screen.** The hub's task editor refuses to save a body that
  scans as a secret (`redact()`, `routes/tasks.ts`), but the authoring path —
  the `workflow-task-author` subagent writing with the host's raw Write tool —
  is scanned by nothing, and the CLI/MCP approve path wasn't either. Design
  05's justification cited `writeTask` as the validated writer, and `writeTask`
  has no production caller. An approved task's body rides into stage prompts,
  checkpoint commits, and possibly a PR.
- **No acceptance-criteria visibility.** The interview's "2–5 testable
  acceptance criteria" is prose-only; `acceptance` defaults to `[]` in the
  schema, and a criteria-less draft approves, plans, and builds — VERIFY then
  has nothing objective to judge and the plan contract's `### Verification`
  has nothing to map. Nothing ever said so.

## What changed

In `approveTask` (`packages/core/src/workflow/gate.ts`), after the epic
refusal:

- **Secret scan — refuse.** `redact(title + body)` with any hits refuses the
  approval, naming the matched patterns and the `retask` route out. Gate verbs
  fail closed, and the cost of a false positive is one retask; the cost of the
  false negative was a credential in every downstream artifact. This is the
  one choke point every draft passes whichever path authored it — subagent,
  hand-written file, hub, CLI.
- **Empty acceptance — warn.** The success message gains
  `Note: it has no acceptance criteria — VERIFY will have nothing objective to
  check …`, plus `data.acceptanceMissing: true` for hosts. A warning, never a
  refusal: legitimately criteria-less chores exist, the interview normally
  fills the field, and a refusal would need a force-flag escape hatch rippled
  through three hosts and the hub — against the same "priority orders, never
  blocks" spirit the backlog runs on.

## What was deliberately not done

- No draft-parse validation sweep, no unknown-frontmatter rejection on the CLI
  path, no interview-enforcement marker: the gate reads the draft through
  `parseTask` already (an unparseable draft gets `unparseableAt`'s diagnosis),
  and the interview's chief output — the criteria — is exactly what the new
  warning names, so the gate absorbs that failure without new machinery.
- `writeTask` stays (reserved for the future sync adapter; its docstring now
  names the right author agent).

## Where it lives

`approveTask` in `packages/core/src/workflow/gate.ts`, importing
`redact` from `task/redact.ts`. Tests: `gate.test.ts` (token-bearing draft
refused with the pattern named; criteria-less draft approved-with-note;
normal draft unchanged).
