---
name: security-and-hardening
description: Hunts exploitable findings — each with a repro and a blast radius. Use when a diff touches auth, input handling, secrets, money or state-machine flows, data export, or LLM output; also when building those surfaces.
---

# Security and Hardening

Two branches, and they run in opposite directions.

**Judging a diff** — hunting what is already broken and deciding what is worth
reporting. Everything below is this branch.

**Building the surface** — the controls to put in place while writing code:
always-do rules, OWASP prevention patterns, input validation, rate limiting,
secrets layout, dependency review, and the changes to raise with a human first.
All of it lives in `references/security-checklist.md`.

## Trust boundaries

A finding starts at a boundary, so name the ones *this diff* crosses before
looking for bugs. Untrusted data enters through HTTP requests, form fields, file
uploads, webhooks, third-party APIs, message queues, and **LLM output** — the
shared definition is in `references/untrusted-data.md`. Behind each boundary,
name the asset: credentials, PII, payment data, admin actions, money movement.

Run STRIDE over each boundary the diff touches — a lens, not a ceremony:

| Threat | Ask | Guarded by |
|---|---|---|
| **S**poofing | Can someone impersonate a user/service? | Authentication, signature verification |
| **T**ampering | Can data be altered in transit or at rest? | Integrity checks, parameterized queries, HTTPS |
| **R**epudiation | Can an action be denied later? | Audit logging of security events |
| **I**nformation disclosure | Can data leak? | Encryption, field allowlists, generic errors |
| **D**enial of service | Can it be overwhelmed? | Rate limiting, input size caps, timeouts |
| **E**levation of privilege | Can a user gain rights they shouldn't? | Authorization checks, least privilege |

A boundary you cannot name is one you cannot secure — that gap is OWASP
**A04: Insecure Design**, where most breaches begin.

## Severity: repro × blast radius

Severity is **repro × blast radius**, never deviation from a checklist. Grade
onto the three severities `code-review-and-quality` → Severity defines — that
skill owns the vocabulary; these are the two rules security adds to it.

**No repro, no finding.** Name the attacker, the action, and what they get. "An
attacker could theoretically…" is not a repro; "send this request, get that
result" is. A finding without one is a `suggestion` at most.

**Blast radius sets the level.** The dividing question is whether the finding
defeats an *explicit* security boundary:

- `critical` — unauthenticated or authenticated RCE, full data dump, admin
  takeover, injection with exfiltration, stored XSS firing for every user, auth
  bypass, or a role the system explicitly gates defeated for a consequential
  action.
- `important` — conditional or targeted XSS, CSRF with meaningful state change,
  secret or credential disclosure, business-logic bypass confined to the
  attacker's own data, or a bug that needs privileged access to reach.
- `suggestion` — non-secret information disclosure, DoS requiring sustained
  effort, and hardening gaps.

**Defense-in-depth gaps are not vulnerabilities.** If an existing layer already
blocks the attack, a missing second layer is a hardening note. "Missing
validation where the query builder already parameterizes" is a `suggestion`,
never `critical`.

## Hunting lenses beyond scanner classes

SQLi, XSS, and SSRF are what scanners already catch. Manual review earns its keep on the classes they can't:

- **Business logic** — state-machine violations (skip steps, replay a completed flow, partial-failure rollback), check-then-act races (double-spend, double-approve), numeric manipulation (negative, zero, overflow, string↔number coercion), time and expiry boundary logic, and the security posture of default/fallback behavior when config is missing or a feature flag is off.
- **Feature abuse & data leakage** — export/backup as exfiltration (low-privilege user triggers an export that includes data above their access), import/restore as injection, search/filter/sort as an oracle for content the user can't directly access, enumeration via differing error messages / timing / status codes, and preview/draft leakage through search, RSS, sitemaps, or CDN cache.
- **Chained & second-order** — individually-safe behaviors dangerous in combination (info-disclosure + IDOR + missing rate limit; open-redirect + OAuth callback = token theft), and data safe when stored but dangerous when later used in a different context (a field name safe in SQL becomes a JSON-path key; a slug safe in a URL becomes part of a file path; a config string gets parsed as a regex, URL, or template).

## Adversarial validation

Before a security finding is reported, a fresh reviewer — a different agent or model, with no stake in the find — tries to **disprove** it: read the actual code at each step, construct the concrete triggering input, and check for a mitigating layer, framework default, or database constraint that already blocks it. It returns CONFIRMED (with the code that makes it exploitable) or REJECTED (with what the trace got wrong). The reviewer that validates a finding is never the one that found it. Kill false positives aggressively; an honest "nothing exploitable here" is a valid result.

Two habits keep a report calibrated: OWASP is a checklist, not a bug list, so a
deviation only becomes a finding once it has a repro; and three real findings
beat thirty theoretical ones. Say what the code does well — solid auth,
parameterized queries — because that is what makes the remaining findings
credible.

## What every diff must guarantee

Each of these is checkable from the diff, and each names what belongs there
instead:

- **Secrets come from the environment.** A literal key, password, or token in
  the diff is `critical` — and once it reaches a remote it is compromised, so
  the finding is *rotate the key*, not *delete the line*.
- **Sensitive values stay out of logs.** Passwords, tokens, and full card
  numbers are redacted at the log call, not filtered downstream.
- **The server re-validates everything.** Client-side validation is a UX
  affordance; the boundary check lives server-side.
- **User data reaches the DOM as text.** `textContent` and framework
  auto-escaping, never `innerHTML` or `eval` with user-provided data.
- **Session tokens live in httpOnly cookies**, not `localStorage` or anywhere
  client script can read them.
- **Errors returned to users are generic.** Stack traces and internal details
  stay in the server log.
- **Queries are parameterized** and **server-side fetches of user-influenced
  URLs are allowlisted** (scheme and host allowlist, private/reserved-IP
  rejection across all resolved records, `redirect: 'error'`).
- **Every resource access checks authorization**, not merely authentication —
  ownership or role, on every endpoint.

## LLM surfaces

A feature that calls an LLM inherits a new boundary; map it to the
[OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/):

- **Model output is untrusted input (LLM05).** That "text" can be a SQL
  statement, a script tag, or a shell command — validate and encode it exactly
  as you would raw user input. Never into `eval`, SQL, a shell, `innerHTML`, or
  a file path.
- **The system prompt is not a security boundary (LLM01).** Untrusted text in
  the context window carries instructions; enforce permissions in code.
- **The context window leaks (LLM02/LLM06/LLM07).** Keep secrets and other
  tenants' data out of it, scope tool permissions to the minimum, and require
  confirmation for destructive actions.

Bounded consumption, RAG tenant partitioning, and a worked example are in
`references/security-checklist.md` → AI / LLM Security.

## Verification

After auditing a diff:

- [ ] Every trust boundary the diff crosses is traced to the check that guards it
- [ ] Every reported finding carries a repro — the attacker, the action, and what they get
- [ ] Every finding carries a blast radius, and its severity follows from it
- [ ] Findings a mitigating layer already blocks were downgraded, not dropped silently
- [ ] The areas found sound are named, so the remaining findings can be trusted
