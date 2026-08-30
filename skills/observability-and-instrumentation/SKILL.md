---
name: observability-and-instrumentation
description: Instruments code so production behavior is diagnosable from telemetry. Use when adding logging, metrics, tracing, or alerting, when shipping a feature whose health needs evidence, or when reviewing a diff for missing or unqueryable telemetry.
---

# Observability and Instrumentation

Code you can't observe is code you can't operate. Instrumentation is written
alongside the feature, the same way tests are — a feature that ships without
telemetry turns its first user-reported bug into archaeology instead of a query.

Two neighbours own the adjacent work: a failure happening **right now** goes to
`debugging-and-error-recovery` (this skill is what makes that one fast next
time), and measured slowness goes to `performance-optimization`.

Copy-ready checklists for every step below live in
`references/observability-checklist.md`, including the pre-launch gate.

## 1. Define "working" before instrumenting

Telemetry without a question is noise. Before adding any instrumentation, write
down 2–4 questions an on-call engineer will ask about this feature:

```
FEATURE: checkout payment retry
QUESTIONS ON-CALL WILL ASK:
1. What fraction of payments succeed on first attempt vs after retry?
2. When a payment fails permanently, why? (provider error? timeout? validation?)
3. Is the payment provider slower than usual?
→ Every signal below must help answer one of these.
```

If you can't name the questions, you're not ready to instrument — you'll log
everything and learn nothing.

## 2. Pick the right signal for each question

| Signal | Answers | Cost profile | Example |
|---|---|---|---|
| **Structured log** | "What happened in this specific case?" | Per-event; grows with traffic | `payment_failed` with provider error code |
| **Metric** | "How often / how fast, in aggregate?" | Fixed per series; cheap to query | p99 latency of provider calls |
| **Trace** | "Where did time go across services?" | Per-request; usually sampled | One slow checkout, broken down by hop |

Metrics tell you **that** something is wrong, traces tell you **where**, logs
tell you **why**.

## 3. Structured logging

Log events, not prose: every line is a JSON object with a stable event name and
machine-readable fields, so it can be queried instead of grepped. An
interpolated sentence — `Payment ${id} failed after ${n} retries` — is the
anti-pattern: it carries the same facts in a form nothing can filter on.

**Log levels — use them consistently:**

| Level | Meaning | On-call action |
|---|---|---|
| `error` | Invariant broken; someone may need to act | Investigate |
| `warn` | Degraded but handled (retry succeeded, fallback used) | Watch for trends |
| `info` | Significant business event (order placed, job finished) | None |
| `debug` | Diagnostic detail | Off in production by default |

**Correlation IDs are mandatory.** Generate (or accept) a request ID at the
system boundary and attach it to every log line, span, and outbound call —
without it you cannot reconstruct a single request from interleaved logs.

**Never log secrets, tokens, passwords, or full PII.** This is a hard rule from
`security-and-hardening` — telemetry pipelines are a classic data-leak path.
Allowlist fields; don't log whole request bodies.

## 4. Metrics

Which series to instrument is fixed rather than a judgement call: **RED** per
endpoint and per external dependency, **USE** per resource, both expanded and
enumerated in `references/observability-checklist.md` → Metrics.

**Cardinality is the failure mode.** Every unique label combination is a
separate time series, so labels come from small, fixed sets — route template,
status class, provider name. A user ID, raw URL, or error message as a label is
a **cardinality bomb**: that detail belongs in logs and traces.

Track averages never, percentiles always — an average hides the 1% of users
having a terrible time. Use histograms and read p50/p95/p99.

## 5. Distributed tracing

Use OpenTelemetry: it is the vendor-neutral standard, and auto-instrumentation
covers HTTP, gRPC, and common DB clients with near-zero code. Add manual spans
only around meaningful internal units of work (`applyDiscounts`,
`chargeProvider`) and attach the attributes on-call will filter by. A trace dies
at the first async boundary its context does not cross, so take the propagation
and sampling settings from `references/observability-checklist.md` →
Distributed Tracing.

## 6. Alerting

Alert on **symptoms users feel**, not on causes:

```
SYMPTOM (page-worthy):           CAUSE (dashboard, not a page):
error rate > 1% for 5 min        CPU at 85%
p99 latency > 2s                 one pod restarted
queue age > 10 min               disk at 70%
```

Cause-based alerts fire when nothing is wrong and miss failures you didn't
predict. Symptom-based alerts fire exactly when users are hurt, whatever the
cause. The causes still need a home that answers the step-1 questions — the
panels are in `references/observability-checklist.md` → Dashboards.

Every alert then has to survive four rules — actionable, runbook-linked,
threshold and duration justified by an SLO or by history, and filed as **page**
(user-facing, act now) or **ticket** (degradation, act this week), because a
third tier becomes noise that trains people to ignore everything. Each is a
checkbox in `references/observability-checklist.md` → Alerting.

## 7. Verify the telemetry itself

Instrumentation is code; it can be wrong. Trigger the paths and read the actual
output before calling the work done — the checks are in
`references/observability-checklist.md` → Verify the Telemetry.

## Signals to catch in review

Each of these is visible in a diff:

- A change adding retries, queues, or external calls with zero new telemetry
- Log lines built by string interpolation instead of structured fields
- A log line with no correlation ID — an orphan
- Secrets, tokens, or whole request bodies reaching a log
- A metric labeled with a user ID, raw URL, or error message text
- Latency recorded as an average, with no histogram

## Verification

- [ ] The on-call questions for this feature are written down, and each signal
      maps to one
- [ ] All log output is structured, with stable event names and a correlation ID
      on every line — confirmed by reading real output, not the source
- [ ] No secrets, tokens, or unredacted PII in any log line (spot-check actual
      output)
- [ ] RED metrics exist for every new endpoint and every external dependency,
      with bounded label sets
- [ ] Latency is a histogram; p95/p99 are queryable
- [ ] A single request can be followed end-to-end in the tracing UI without
      broken spans
- [ ] Every new alert is symptom-based, has a runbook link, and was test-fired
      once
- [ ] An induced failure in staging was located via telemetry alone, without
      reading the source
