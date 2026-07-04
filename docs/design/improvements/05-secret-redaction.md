# 05 — Secret redaction on durable artifacts

## Context

Threat model T6 is the only threat with a **partial** control: stages have
no reason to read secret files, and REVIEW's checklist flags secret
handling, but nothing stops a secret an agent *echoes* (a test's env dump, a
quoted config, a stack trace with a connection string) from landing in the
durable, committed artifacts — task-file audit notes, persisted plans, and
`runs/<id>.md` logs. Those are committed to git (`commitPaths` on backlog
mutations), so a leaked secret becomes a leaked-secret-in-history.

Fix: a redaction pass at the write boundary of every durable artifact.

## Design

### New pure module: `src/task/redact.ts`

```ts
export interface RedactionHit { readonly pattern: string; readonly count: number }
export interface Redacted { readonly text: string; readonly hits: readonly RedactionHit[] }

/** Replace recognized secret shapes with "[REDACTED:<pattern>]". Pure, total. */
export const redact = (text: string): Redacted
```

Pattern list (named, so hits are diagnosable without echoing the secret):

| Name | Pattern (sketch) |
|---|---|
| `aws-access-key` | `AKIA[0-9A-Z]{16}` |
| `aws-secret-key` | `(?<=aws.{0,20})[A-Za-z0-9/+=]{40}` (guarded — high-FP shape needs the context anchor) |
| `openai-key` | `sk-[A-Za-z0-9_-]{20,}` |
| `anthropic-key` | `sk-ant-[A-Za-z0-9_-]{20,}` (before `openai-key` — order matters, first match wins) |
| `github-token` | `gh[pousr]_[A-Za-z0-9]{36,}` \| `github_pat_[A-Za-z0-9_]{20,}` |
| `slack-token` | `xox[baprs]-[A-Za-z0-9-]{10,}` |
| `private-key-block` | `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` |
| `jwt` | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |
| `generic-assignment` | `(?i)\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[^\s"']{8,}` — redact only the value group |

Replacement keeps the name: `[REDACTED:openai-key]`. Multi-line
`private-key-block` collapses to one marker.

Precision posture: **prefer false positives over leaks** in audit notes and
run logs — a redacted non-secret costs a little log fidelity; a leaked
secret costs a rotation. The `generic-assignment` pattern will
occasionally eat a harmless `password: "hunter2-example"` in a test
fixture quote; acceptable.

### Wire-in — the three write boundaries in `src/task/store.ts`

- `appendNote` (line 174), `appendPlan` (line 207),
  `appendRunLog` (line 192): run `redact()` on the payload before the
  `printf`. These are the only functions that write loop-generated text to
  durable files (verified — `writeTask` writes human/task-author-confirmed
  content; still cheap to include it for consistency, decide at
  implementation).
- Signature choice: keep the store functions' signatures unchanged and
  redact inside them (every current and future caller is covered by
  default), rather than making callers opt in. Add an optional
  `log?: Log` param (several store functions already take one) to warn:
  `"redacted 2 secret-shaped strings (openai-key, jwt) from runs/<id>.md"` —
  the warning names patterns, never values.
- The `auditNote` timestamp/actor suffix must be applied **after**
  redaction can't mangle it — order: build the note text, redact, suffix is
  part of the text already; simpler: redact the final string; the suffix
  contains no secret shapes, so it passes through. Marker greps
  (`> BUILD started`) are unaffected — redaction never touches those
  literals.

### Threat-model honesty

This is shape-based scanning: custom-format secrets (a company-internal
token that looks like a UUID) pass through. Update T6 from "partial" to
"mitigated (shape-based) with residual: unrecognized secret formats;
defense in depth remains keep-secrets-out-of-the-working-tree". The
existing recommendation to treat `runs/` as sensitive stands.

## Edge cases

- Payload is entirely a secret (a stage echoes a key alone) → note becomes
  `> [REDACTED:openai-key] [timestamp]` — fine, the audit event survives.
- Enormous run-log payloads: patterns are all linear-ish; the
  `private-key-block` regex is lazy-quantified. No catastrophic
  backtracking shapes in the list (review each pattern for this at
  implementation — it's the one regex-safety requirement).
- Idempotence: redacting already-redacted text is a no-op
  (`[REDACTED:…]` matches no pattern). Test it.
- False-positive escape hatch: none by design (no allowlist knob) — a knob
  to disable redaction is a knob an injected prompt can talk someone into
  documenting around. If fidelity matters for debugging, the secret-free
  original is in the session transcript, not the committed artifact.

## Test plan (TDD — pure module, table-driven)

New `src/task/redact.test.ts`:
- One positive + one negative case per pattern (e.g. `sk-` followed by 10
  chars does NOT match `openai-key`; `AKIA` + 15 chars doesn't match).
- Value-only redaction for `generic-assignment` (key name survives).
- Multi-hit counting; hit names; idempotence; empty string; text with no
  hits returns identical string (reference equality not required).
- PEM block spanning many lines → single marker.

Store integration (extend `src/task/store.test.ts`): `appendNote` with a
key-shaped payload writes the redacted form; warn callback invoked with
pattern names only.

## Docs to update

- `docs/design/threat-model.md` — T6 rewrite (see above).
- `README.md` — one line in the hardening/features list.
- `skills/loop-orchestration/SKILL.md` — note that run logs and audit notes
  are shape-redacted, and the residual.
