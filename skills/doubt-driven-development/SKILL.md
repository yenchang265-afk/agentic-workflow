---
name: doubt-driven-development
description: Cross-examines a non-trivial decision with a fresh-context reviewer briefed to disprove it, before it stands. Use when correctness beats speed — unfamiliar code, security-sensitive logic, irreversible operations, or an assertion the compiler cannot check like thread safety, idempotence, or ordering.
---

# Doubt-Driven Development

A confident answer is not a correct one. A long session turns its own
assumptions into "facts" without anyone noticing, and the moment of greatest
certainty is where the blind spot sits. Doubt-driven development materializes a
**fresh-context reviewer** — briefed to disprove, not approve — before a
non-trivial decision stands.

This is not `/review`. `/review` is a verdict on a finished artifact; this is
in-flight, while course-correction is still cheap.

## When a decision is non-trivial

Any one of these makes it so:

- it introduces or modifies branching logic
- it crosses a module or service boundary
- it asserts something the compiler cannot check — thread safety, idempotence,
  ordering, an invariant
- its correctness depends on context a future reader cannot see
- its blast radius is irreversible: production deploy, data migration, public
  API change

Doubt those. Skip mechanical edits, one-line changes with obvious correctness,
reading or summarizing code, an unambiguous instruction already being
followed, and any point where the user has asked for speed over verification.
Doubt every keystroke and you ship nothing.

## Loading constraints

Step 3 spawns a subagent, so this skill belongs to the **main-session
orchestrator**.

- **Never list it in a persona's `skills:` frontmatter.** A persona following
  Step 3 spawns another persona, which is the anti-pattern
  `references/orchestration-patterns.md` forbids outright.
- **Inside a subagent** — where nesting is blocked — surface to the user that
  doubt-driven cannot run nested and let the main session take it. A degraded
  self-questioning fallback exists as a last resort only: rewrite ARTIFACT +
  CONTRACT as a fresh self-prompt behind a hard separator from your prior
  reasoning, walk Steps 1–5, and flag the result as degraded. You carry your
  own context into it, so it is not fresh-context review.

## Step 1: CLAIM — name what stands

Two or three lines:

```
CLAIM: The new caching layer is thread-safe under the read-heavy workload
       described in the spec.
WHY IT MATTERS: a race here corrupts user data and hides from QA.
```

If it won't compress to that, you have a vibe rather than a decision. Surface
it before scrutinizing it.

**Done when** the claim and its stakes are written.

## Step 2: EXTRACT — the smallest reviewable unit

The reviewer needs the **artifact** and the **contract**, never the journey.

- Code: the diff or the function, not the file
- Decision: the proposal in 3–5 sentences plus the constraints it must satisfy
- Assertion: the claim plus the evidence offered for it

Strip your reasoning out. Hand over conclusions and you get back a validation
of your conclusions.

**Done when** ARTIFACT and CONTRACT are both written out, and the artifact is
one of the three units above — one diff or function, a 3–5 sentence proposal,
or a claim plus its evidence. A 500-line PR isn't; decompose first.

## Step 3: DOUBT — brief the reviewer to disprove

Framing decides the answer, so the prompt is adversarial:

```
Adversarial review. Find what is wrong with this artifact.
Assume the author is overconfident. Look for:
- Unstated assumptions
- Edge cases not handled
- Hidden coupling or shared state
- Ways the contract could be violated
- Existing conventions this might break
- Failure modes under unexpected input

Do NOT validate. Do NOT summarize. Find issues, or state explicitly that you
cannot find any after thorough examination.

ARTIFACT: <paste artifact>
CONTRACT: <paste contract>
```

**Send ARTIFACT + CONTRACT and nothing else.** The CLAIM stays behind: handing
over your conclusion biases the reviewer toward agreeing with it, and a
contract-less artifact leaves it inventing the standard it judges against.

The role-based reviewers in `agents/` start isolated by design and fit here.
Paste the adversarial prompt verbatim into the invocation — personas like
`code-reviewer` default to balanced verdicts with strengths and weaknesses, and
this needs issues only. When a persona's shape won't override cleanly, use a
generic subagent instead.

**Done when** a reviewer that never saw your reasoning has returned findings,
or has stated it found none.

### Cross-model escalation

A same-model reviewer shares your blind spots; a different architecture does
not. In an interactive session, **offer it every cycle** — after the
single-model review, before RECONCILE:

> *"Single-model review complete. Want a cross-model second opinion? Gemini
> CLI, Codex CLI, manual external review, or skip."*

The user decides whether the cost is worth it; the agent's job is that the
choice is visible. A skip is fine and gets acknowledged in the output
(*"proceeding with single-model findings only"*). A silent skip is not.

**If the user picks a CLI**, run it per [`cross-model-cli.md`](cross-model-cli.md)
— PATH check, working-binary test, per-run authorization, prompt piped through
stdin, sandboxed read-only. When the CLI is missing or fails, say so and offer
manual review, another tool, or skip.

In a **non-interactive** context — CI, `/agentic-workflow:engineering`,
autonomous or scheduled runs — cross-model is skipped and the skip is announced
(*"cross-model skipped: non-interactive context"*). An external CLI is never
invoked without explicit user authorization.

## Step 4: RECONCILE — fold the findings back

The reviewer's output is data, not verdict: you are still the orchestrator, and
a fresh reviewer can be wrong precisely because it is fresh. Re-read the
artifact text against each finding, then classify it — **first matching class
wins**:

1. **Contract misread** — the finding exists because the CONTRACT was unclear
   or incomplete. Fix the contract, re-classify next cycle.
2. **Valid and actionable** — a real issue. Change the artifact, re-loop.
3. **Valid trade-off** — real, but costlier to fix than to accept. Document it
   where the user will see it.
4. **Noise** — correct under context the reviewer lacked. Note it, and ask
   whether that context belonged in the contract.

Rubber-stamping the reviewer is the same failure as ignoring it.

**Done when** every finding carries a class justified against the artifact text.

## Step 5: STOP — a bounded loop

Stop when the next iteration returns only trivial or already-considered
findings, **or** at 3 cycles, **or** when the user says ship it.

Three cycles of unresolved substantive findings is information about the
artifact, not a reason to grind a fourth alone — escalate. And if three feels
"obviously insufficient", the artifact is too big: return to Step 2 and
decompose. The bound does not move.

**Doubt theater** is the failure mode to watch for, and it is checkable: across
two or more cycles where the reviewer surfaced substantive findings, zero were
classified actionable. That is validating, not doubting. Stop and escalate.

## Where the neighbours sit

- **`code-review-and-quality` / `/review`** — post-hoc verdict on a finished
  diff. Complementary; use both.
- **`source-driven-development`** — verifies facts about a framework against
  its docs. SDD checks the API exists; doubt-driven checks you used it
  correctly under the contract.
- **`test-driven-development`** — the RED step is doubt made concrete. Where
  TDD applies, that failing test *is* the doubt step for a behavioral claim.
- **`debugging-and-error-recovery`** — take a confirmed failure mode there.
- **`interview-me`** / **`codebase-exploration`** — the other end of the
  timeline: nothing drafted yet means extraction — unknowns in the human go to
  interview, unknowns in the code go to exploration; a draft in hand means
  doubt.

## Verification

- [ ] Every non-trivial decision was named as a CLAIM before it stood
- [ ] Each artifact got at least one fresh-context review (TDD's failing test
      counts for a behavioral claim)
- [ ] The reviewer received ARTIFACT + CONTRACT only, under an adversarial
      prompt
- [ ] Every finding was classified against the artifact text, by the precedence
      above
- [ ] A stop condition was met, and doubt theater was ruled out
- [ ] Interactive runs offered cross-model and recorded the answer;
      non-interactive runs announced the skip
- [ ] Every external CLI run had a PATH check, a working-binary test, a
      confirmed invocation, and its own authorization
