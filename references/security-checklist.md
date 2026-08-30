# Security Checklist

The **building** branch of web application security: what to put in place while
writing code, and what to audit a surface against. The `security-and-hardening`
skill carries the **judging** branch — hunting exploitable findings in a diff
someone already wrote — and points here.

Every list below is an exhaustiveness bar, not a tutorial: the value is covering
the class you would not have thought to look at, so work each list to its end.

## Threat modeling (start here)

- [ ] Boundaries mapped, assets named, and STRIDE run per boundary — the table is `security-and-hardening` → Trust boundaries
- [ ] Abuse cases written next to use cases ("how would I misuse this?")

## Ask first (human approval)

Each of these reshapes the attack surface, so raise it with a human before
implementing rather than deciding alone:

- [ ] New authentication flows, or changes to existing auth logic
- [ ] Storing a new category of sensitive data (PII, payment info)
- [ ] New external service integrations
- [ ] CORS configuration changes
- [ ] New file upload handlers
- [ ] Changes to rate limiting or throttling
- [ ] Granting elevated permissions or roles

## Secrets

- [ ] `.gitignore` covers `.env`, `.env.local`, `.env.*.local`, `*.pem`, `*.key`; `.env.example` holds placeholders only
- [ ] Every secret read from the environment, and its absence fails at startup rather than at first use

**A secret that reached a remote is compromised.** Revoke and reissue the key
first; deleting the line or rewriting history only hides it.

## Authentication and authorization

- [ ] Passwords hashed with argon2, scrypt, or bcrypt at ≥12 rounds
- [ ] Session cookies `httpOnly`, `secure`, `sameSite: 'lax'`, with a bounded max-age
- [ ] Login rate-limited (≤10 attempts per 15 minutes); reset tokens time-limited (≤1 hour) and single-use
- [ ] Every resource access checks ownership, not merely authentication (prevents IDOR)
- [ ] Admin routes verify the admin role; API keys and JWT claims scoped to the minimum

## Input and output

- [ ] Every boundary — API route, form handler, queue consumer, webhook — validates with a schema carrying length caps, numeric ranges, and enums
- [ ] Validation allowlists rather than denylists
- [ ] File uploads restricted by type and size, and verified by magic bytes rather than by extension
- [ ] Redirect targets validated (prevent open redirect)
- [ ] Server-side URL fetches allowlisted, with private and reserved IPs blocked — see SSRF below
- [ ] Error responses carry a code and a generic message; stack traces, SQL, and internal hostnames stay server-side
- [ ] CORS names its allowed origins — never `origin: '*'` alongside credentials
- [ ] Response headers set CSP, HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a `Referrer-Policy`, and a `Permissions-Policy`; `X-XSS-Protection: 0` disables the legacy auditor in favour of CSP

### SSRF

Wherever the server fetches a URL the user influenced — webhooks, "import from
URL", image proxies, link previews — an attacker aims it at internal services.
Allowlist scheme and host, then resolve **all** DNS records and reject the fetch
when any address is outside `unicast`, which covers loopback, link-local
`169.254.169.254` (cloud metadata, the most common target), private, and
unique-local ranges across IPv4 and IPv6. Forbid redirects on the request.

```typescript
const addrs = await lookup(url.hostname, { all: true });
if (addrs.some((a) => ipaddr.parse(a.address).range() !== 'unicast')) throw new Error('private/reserved IP');
await fetch(url, { redirect: 'error' });
```

That check still leaves a **TOCTOU gap**: `fetch` resolves DNS again after it, so
a short-TTL record can rebind to an internal address between validation and
connection. On a high-risk surface, resolve once and connect to the pinned IP, or
front it with a filtering agent (`request-filtering-agent`, `ssrf-req-filter`).

## Data protection

- [ ] Sensitive fields stripped from API responses (`passwordHash`, `resetToken`)
- [ ] Passwords, tokens, and full card numbers kept out of logs
- [ ] PII encrypted at rest where regulation requires it; backups encrypted too

## Dependencies

`npm audit` catches published advisories, not a malicious package:

- [ ] Lockfile committed, and CI installs from it (`npm ci`, `pnpm install --frozen-lockfile`)
- [ ] A new dependency's maintenance, download count, and `postinstall` scripts reviewed — install-time scripts run arbitrary code
- [ ] No typosquats (`cross-env` vs `crossenv`, `react-dom` vs `reactdom`)
- [ ] The existing stack genuinely cannot do this, and the license fits

**Triaging an advisory** turns on reachability, not on the reported severity:
is the vulnerable function called on a path this code reaches; is the package a
runtime or a dev-only dependency; and is the flaw exploitable in this deployment
(a server-side flaw in a client-only app is not). Fix a reachable critical
immediately; record a reason and a review date whenever you defer one.

That is npm's severity scale, not the review vocabulary — a review finding about
a dependency is graded per `code-review-and-quality` → Severity.

## LLM features

For anything calling a model — chatbot, summarizer, agent, RAG:

- [ ] Model output treated as untrusted — never into `eval`, SQL, shell, `innerHTML`, or a file path
- [ ] Prompt injection assumed; permissions enforced in code, never by the system prompt
- [ ] Secrets, cross-tenant data, and full system prompts kept out of the context window
- [ ] Tool permissions scoped, and destructive or irreversible actions confirmed
- [ ] Token, rate, and recursion limits set, bounding consumption
- [ ] RAG embeddings partitioned per tenant, and indexed documents validated before ingest

The risk catalogue behind these is the [OWASP GenAI Top 10 for LLMs](https://genai.owasp.org/llm-top-10/).
