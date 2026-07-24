---
name: security-and-hardening
description: Hardens code against vulnerabilities and audits for exploitable ones. Use when handling untrusted input, authentication, sensitive data, or external integrations, or when auditing code for vulnerabilities.
---

# Security and Hardening

## Overview

Security-first development practices for web applications. Treat every external input as hostile, every secret as sacred, and every authorization check as mandatory. Security isn't a phase — it's a constraint on every line of code that touches user data, authentication, or external systems.

## When to Use

- Building anything that accepts user input
- Implementing authentication or authorization
- Storing or transmitting sensitive data
- Integrating with external APIs or services
- Adding file uploads, webhooks, or callbacks
- Handling payment or PII data

## Process: Threat Model First

Controls bolted on without a threat model are guesses. Before hardening, spend five minutes thinking like an attacker:

1. **Map the trust boundaries.** Where does untrusted data cross into your system? HTTP requests, form fields, file uploads, webhooks, third-party APIs, message queues, and **LLM output**. Every boundary is attack surface.
2. **Name the assets.** What's worth stealing or breaking? Credentials, PII, payment data, admin actions, money movement.
3. **Run STRIDE over each boundary** — a quick lens, not a ceremony:

| Threat | Ask | Typical mitigation |
|---|---|---|
| **S**poofing | Can someone impersonate a user/service? | Authentication, signature verification |
| **T**ampering | Can data be altered in transit or at rest? | Integrity checks, parameterized queries, HTTPS |
| **R**epudiation | Can an action be denied later? | Audit logging of security events |
| **I**nformation disclosure | Can data leak? | Encryption, field allowlists, generic errors |
| **D**enial of service | Can it be overwhelmed? | Rate limiting, input size caps, timeouts |
| **E**levation of privilege | Can a user gain rights they shouldn't? | Authorization checks, least privilege |

4. **Write abuse cases next to use cases.** For each feature, ask "how would I misuse this?" — then make that your first test.

If you can't name the trust boundaries for a feature, you're not ready to secure it. This is OWASP **A04: Insecure Design** — most breaches begin in design, not code.

## The Three-Tier Boundary System

### Always Do (No Exceptions)

- **Validate all external input** at the system boundary (API routes, form handlers)
- **Parameterize all database queries** — never concatenate user input into SQL
- **Encode output** to prevent XSS (use framework auto-escaping, don't bypass it)
- **Use HTTPS** for all external communication
- **Hash passwords** with bcrypt/scrypt/argon2 (never store plaintext)
- **Set security headers** (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
- **Use httpOnly, secure, sameSite cookies** for sessions
- **Run `npm audit`** (or equivalent) before every release

### Ask First (Requires Human Approval)

- Adding new authentication flows or changing auth logic
- Storing new categories of sensitive data (PII, payment info)
- Adding new external service integrations
- Changing CORS configuration
- Adding file upload handlers
- Modifying rate limiting or throttling
- Granting elevated permissions or roles

### Never Do

- **Never commit secrets** to version control (API keys, passwords, tokens)
- **Never log sensitive data** (passwords, tokens, full credit card numbers)
- **Never trust client-side validation** as a security boundary
- **Never disable security headers** for convenience
- **Never use `eval()` or `innerHTML`** with user-provided data
- **Never store sessions in client-accessible storage** (localStorage for auth tokens)
- **Never expose stack traces** or internal error details to users

## OWASP Top 10 Prevention Patterns

One rule per class — copy-ready implementation examples for every rule live in `references/security-checklist.md` → Implementation Patterns:

- **Injection** — parameterize every query (placeholders or ORM); build no SQL, shell, or NoSQL string from external input.
- **Broken authentication** — hash with bcrypt/scrypt/argon2 (≥12 rounds); sessions ride httpOnly/secure/sameSite cookies with an expiry.
- **XSS** — rely on framework auto-escaping; the rare path that must render HTML goes through DOMPurify.
- **Broken access control** — every resource access checks *authorization* (ownership or role), not just authentication.
- **Misconfiguration** — helmet defaults on (CSP, HSTS, X-Frame-Options); CORS restricted to named origins.
- **Sensitive data exposure** — strip secret fields before a record leaves the API; secrets come from the environment, never code.
- **SSRF** — a server-side fetch of any user-influenced URL gets scheme+host allowlisting, private/reserved-IP rejection across *all* resolved records, and `redirect: 'error'`; high-risk surfaces pin the resolved IP (the check-then-fetch gap is a TOCTOU).

## Input Validation

Validate at the system boundary with a schema (zod or equivalent) — types, lengths, enums, formats — then internal code trusts the result. File uploads additionally get an allowlisted MIME set and a size cap; check magic bytes when it matters, never the extension. Examples: `references/security-checklist.md` → Implementation Patterns.

## Triaging npm audit Results

Not all audit findings require immediate action. Use this decision tree:

```
npm audit reports a vulnerability
├── Severity: critical or high
│   ├── Is the vulnerable code reachable in your app?
│   │   ├── YES --> Fix immediately (update, patch, or replace the dependency)
│   │   └── NO (dev-only dep, unused code path) --> Fix soon, but not a blocker
│   └── Is a fix available?
│       ├── YES --> Update to the patched version
│       └── NO --> Check for workarounds, consider replacing the dependency, or add to allowlist with a review date
├── Severity: moderate
│   ├── Reachable in production? --> Fix in the next release cycle
│   └── Dev-only? --> Fix when convenient, track in backlog
└── Severity: low
    └── Track and fix during regular dependency updates
```

**Key questions:**
- Is the vulnerable function actually called in your code path?
- Is the dependency a runtime dependency or dev-only?
- Is the vulnerability exploitable given your deployment context (e.g., a server-side vulnerability in a client-only app)?

When you defer a fix, document the reason and set a review date.

### Supply-Chain Hygiene

`npm audit` catches known CVEs; it won't catch a malicious or typosquatted package. Also:

- **Commit the lockfile** and install with `npm ci` (not `npm install`) in CI — reproducible builds, no silent version drift.
- **Review new dependencies before adding them** — maintenance, download counts, and whether they truly earn their place. Every dependency is attack surface (OWASP **A06: Vulnerable Components**, **LLM03: Supply Chain**).
- **Be wary of `postinstall` scripts** in unfamiliar packages — they run arbitrary code at install time.
- **Watch for typosquats** — `cross-env` vs `crossenv`, `react-dom` vs `reactdom`.

## Rate Limiting

Rate-limit the API globally and auth endpoints an order of magnitude tighter (e.g. 100 req/15 min general, 10/15 min on `/api/auth/`). Example middleware: `references/security-checklist.md` → Implementation Patterns.

## Secrets Management

```
.env files:
  ├── .env.example  → Committed (template with placeholder values)
  ├── .env          → NOT committed (contains real secrets)
  └── .env.local    → NOT committed (local overrides)

.gitignore must include:
  .env
  .env.local
  .env.*.local
  *.pem
  *.key
```

**Always check before committing:**
```bash
# Check for accidentally staged secrets
git diff --cached | grep -i "password\|secret\|api_key\|token"
```

**If a secret is ever committed, rotate it.** Deleting the line or rewriting history is not enough — assume it's compromised the moment it reaches a remote. Revoke and reissue the key first, then purge it from history.

## Securing AI / LLM Features

If your app calls an LLM — chatbots, summarizers, agents, RAG — it inherits a new attack surface (the shared trust boundary is defined in `references/untrusted-data.md`). Map it to the [OWASP Top 10 for LLM Applications (2025)](https://genai.owasp.org/llm-top-10/):

- **Treat all model output as untrusted input (LLM05: Improper Output Handling).** Never pass LLM output straight into `eval`, SQL, a shell, `innerHTML`, or a file path. Validate and encode it exactly as you would raw user input.
- **Assume prompts can be hijacked (LLM01: Prompt Injection).** Untrusted text in the context window — a user message, a fetched web page, a PDF — can carry instructions. The system prompt is not a security boundary; enforce permissions in code, not in the prompt.
- **Keep secrets and other users' data out of prompts (LLM02 / LLM07).** Anything in the context can be echoed back. Don't put API keys, cross-tenant data, or the full system prompt where the model can repeat it.
- **Constrain tool and agent permissions (LLM06: Excessive Agency).** Scope tools to the minimum, require confirmation for destructive or irreversible actions, and validate every tool argument.
- **Bound consumption (LLM10: Unbounded Consumption).** Cap tokens, request rate, and loop/recursion depth so a crafted input can't run up cost or hang the system.
- **Isolate retrieval data (LLM08: Vector and Embedding Weaknesses).** In RAG, treat the vector store as a trust boundary: partition embeddings per tenant so one user can't retrieve another's data, and validate documents before indexing so poisoned content can't steer answers.

```typescript
// BAD: trusting model output as a command or as markup
const sql = await llm.generate(`Write SQL for: ${userQuestion}`);
await db.query(sql);                                   // arbitrary query execution
container.innerHTML = await llm.reply(userMessage);   // stored XSS, via the model

// GOOD: model output is data — parse defensively, then validate, then encode
let intent;
try {
  intent = CommandSchema.parse(JSON.parse(await llm.replyJson(userMessage)));
} catch {
  throw new ValidationError('unexpected model output'); // JSON.parse or schema failed
}
await runAllowlistedAction(intent.action, intent.params);
container.textContent = await llm.reply(userMessage);
```

## Auditing for Vulnerabilities

The patterns above are about *building* secure code. Auditing is the opposite direction — you're hunting for what's already broken and deciding what's worth reporting. Different discipline, different failure modes.

### Exploitability first

Every finding names the attacker, the action, and what they get. "An attacker could theoretically…" is not a finding; "send this request, get that result" is. If you can't describe the concrete damage, the severity is lower than you think.

### Severity = likelihood × impact

Rate on both axes — how hard to exploit and what access it needs, against what damage it achieves — not on deviation from a checklist:

- **CRITICAL** — unauthenticated RCE, full data dump, admin takeover without credentials.
- **HIGH** — authenticated RCE, SQL injection with exfiltration, stored XSS firing for all users, auth bypass, or an explicit role/permission boundary fully defeated for a consequential action.
- **MEDIUM** — conditional or targeted XSS, CSRF with meaningful state change, secret/credential disclosure, business-logic bypass confined to the attacker's own data.
- **LOW** — non-secret information disclosure, DoS requiring sustained effort, hardening and defense-in-depth gaps.

The line between HIGH and MEDIUM: **does the finding defeat an explicit security boundary?** A user performing an action the system explicitly gates behind a higher role is HIGH. A data inconsistency, a bug that needs privileged access to reach, or one with limited blast radius is MEDIUM.

### Defense-in-depth gaps are not vulnerabilities

If an existing layer already blocks the attack, a missing second layer is a hardening note, not a blocking finding — don't inflate its severity. "Missing validation where the query builder already parameterizes" is not HIGH.

### Hunting lenses beyond scanner classes

SQLi, XSS, and SSRF are what scanners already catch. Manual review earns its keep on the classes they can't:

- **Business logic** — state-machine violations (skip steps, replay a completed flow, partial-failure rollback), check-then-act races (double-spend, double-approve), numeric manipulation (negative, zero, overflow, string↔number coercion), time and expiry boundary logic, and the security posture of default/fallback behavior when config is missing or a feature flag is off.
- **Feature abuse & data leakage** — export/backup as exfiltration (low-privilege user triggers an export that includes data above their access), import/restore as injection, search/filter/sort as an oracle for content the user can't directly access, enumeration via differing error messages / timing / status codes, and preview/draft leakage through search, RSS, sitemaps, or CDN cache.
- **Chained & second-order** — individually-safe behaviors dangerous in combination (info-disclosure + IDOR + missing rate limit; open-redirect + OAuth callback = token theft), and data safe when stored but dangerous when later used in a different context (a field name safe in SQL becomes a JSON-path key; a slug safe in a URL becomes part of a file path; a config string gets parsed as a regex, URL, or template).

### Adversarial validation

Before a security finding is reported, a fresh reviewer — a different agent or model, with no stake in the find — tries to **disprove** it: read the actual code at each step, construct the concrete triggering input, and check for a mitigating layer, framework default, or database constraint that already blocks it. It returns CONFIRMED (with the code that makes it exploitable) or REJECTED (with what the trace got wrong). The reviewer that validates a finding is never the one that found it. Kill false positives aggressively; an honest "nothing exploitable here" is a valid result.

### Audit anti-patterns

- Flagging every OWASP deviation as a bug — OWASP is a checklist, not a bug list.
- Rating defense-in-depth gaps CRITICAL or HIGH.
- Padding a report with LOWs — three real findings beat thirty theoretical ones.
- "Potential" or "theoretical" findings with no concrete exploit path.
- Not acknowledging what the code does well (solid auth, parameterized queries) — saying so calibrates trust in the findings that remain.

## Security Review Checklist

```markdown
### Authentication
- [ ] Passwords hashed with bcrypt/scrypt/argon2 (salt rounds ≥ 12)
- [ ] Session tokens are httpOnly, secure, sameSite
- [ ] Login has rate limiting
- [ ] Password reset tokens expire

### Authorization
- [ ] Every endpoint checks user permissions
- [ ] Users can only access their own resources
- [ ] Admin actions require admin role verification

### Input
- [ ] All user input validated at the boundary
- [ ] SQL queries are parameterized
- [ ] HTML output is encoded/escaped
- [ ] Server-side URL fetches are allowlisted (no SSRF to internal services)

### Data
- [ ] No secrets in code or version control
- [ ] Sensitive fields excluded from API responses
- [ ] PII encrypted at rest (if applicable)

### Infrastructure
- [ ] Security headers configured (CSP, HSTS, etc.)
- [ ] CORS restricted to known origins
- [ ] Dependencies audited for vulnerabilities
- [ ] Error messages don't expose internals

### Supply Chain
- [ ] Lockfile committed; CI installs with `npm ci`
- [ ] New dependencies reviewed (maintenance, downloads, postinstall scripts)

### AI / LLM (if used)
- [ ] Model output treated as untrusted (no eval/SQL/innerHTML/shell)
- [ ] Secrets and other users' data kept out of prompts
- [ ] Tool/agent permissions scoped; destructive actions require confirmation
```
## See Also

For detailed security checklists and pre-commit verification steps, see `references/security-checklist.md`.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "This is an internal tool, security doesn't matter" | Internal tools get compromised. Attackers target the weakest link. |
| "We'll add security later" | Security retrofitting is 10x harder than building it in. Add it now. |
| "No one would try to exploit this" | Automated scanners will find it. Security by obscurity is not security. |
| "The framework handles security" | Frameworks provide tools, not guarantees. You still need to use them correctly. |
| "It's just a prototype" | Prototypes become production. Security habits from day one. |
| "Threat modeling is overkill here" | Five minutes of "how would I attack this?" prevents the design flaws no control can patch later. |
| "It's just LLM output, it's only text" | That "text" can be a SQL statement, a script tag, or a shell command. Treat it like any untrusted input. |

## Red Flags

- User input passed directly to database queries, shell commands, or HTML rendering
- Secrets in source code or commit history
- API endpoints without authentication or authorization checks
- Missing CORS configuration or wildcard (`*`) origins
- No rate limiting on authentication endpoints
- Stack traces or internal errors exposed to users
- Dependencies with known critical vulnerabilities
- Server fetches user-supplied URLs without an allowlist (SSRF)
- LLM/model output passed into a query, the DOM, a shell, or `eval`
- Secrets, PII, or the full system prompt placed inside an LLM context window

## Verification

After implementing security-relevant code:

- [ ] `npm audit` shows no critical or high vulnerabilities
- [ ] No secrets in source code or git history
- [ ] All user input validated at system boundaries
- [ ] Authentication and authorization checked on every protected endpoint
- [ ] Security headers present in response (check with browser DevTools)
- [ ] Error responses don't expose internal details
- [ ] Rate limiting active on auth endpoints
- [ ] Server-side URL fetches validated against an allowlist (no SSRF)
- [ ] LLM/model output validated and encoded before use (if AI features present)
