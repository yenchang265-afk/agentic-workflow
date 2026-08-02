---
name: code-review-and-quality
description: Judges a diff on five axes and grades every finding critical, important, or suggestion. Use before merging any change; other skills reach here for the severity scale.
---

# Code Review and Quality

You are judging a diff someone already wrote — reporting what is wrong, not
fixing it.

**Approve when the change definitely improves overall code health**, even if it
isn't perfect. Perfect code doesn't exist, and "not how I would have written it"
is not a finding. Two biases run the other way and are worth naming: code that
reads as confident and plausible still needs *more* scrutiny when a model wrote
it, not less; and passing tests are necessary, not sufficient — they say nothing
about architecture, security, or whether the next reader can follow this.

## Severity

Every finding carries one of exactly three severities. These are the only three
the loop's `workflow_verdict` tool accepts, so a finding graded anything else is
a finding the loop throws away:

| Severity | Means | In the loop |
|---|---|---|
| `critical` | Broken behaviour, data loss, or an exploitable vulnerability with a repro | Blocks — FAILs the stage |
| `important` | A real defect or structural regression the next iteration must fix | Blocks — FAILs the stage |
| `suggestion` | Worth doing, not worth blocking | Never blocks |

Three rules decide which one a finding gets:

- **Lead with what matters.** Order findings by leverage: correctness and
  security first, then structural regressions and missed simplifications, then
  everything else. A few high-conviction findings beat a long list — one
  structural problem alongside ten cosmetic ones means the structural problem
  *is* the review.
- **No concrete failure path, no block.** A finding you cannot state as "this
  input, that wrong result" is a `suggestion` at most.
- **Structure is a `suggestion` unless the change makes structure worse.**
  Propose the simpler design either way; escalate to `important` only when the
  change actively degrades structure — a shell game, a file pushed past its size
  boundary with no decomposition, feature logic added to a shared module, a
  near-duplicate of an existing canonical helper, or a silent fallback hiding an
  unclear invariant.

This is the vocabulary every review grades against. Other skills map their
ratings onto it rather than defining a second scale.

## The Five Axes

Start from intent: what is this change trying to accomplish, which spec or task
does it implement, and what behaviour should differ afterwards? Then read the
tests before the implementation — they are where intent and coverage show.

Every axis gets a stated verdict, including the clean ones.

### 1. Correctness

Does the code do what it claims to do?

- Does it match the spec or task requirements?
- Are edge cases handled (null, empty, boundary values)?
- Are error paths handled, not just the happy path?
- Do tests exist, test behavior rather than implementation details, cover the edge cases, and actually fail if the code regresses?
- Are there off-by-one errors, race conditions, or state inconsistencies?
- Is the verification story real — what was run, what passed, and for UI, what it looks like now?

### 2. Readability & Simplicity

Can another engineer (or agent) understand this code without the author explaining it?

- Are names descriptive and consistent with project conventions? (No `temp`, `data`, `result` without context)
- Is the control flow straightforward (avoid nested ternaries, deep callbacks)?
- Is the code organized logically (related code grouped, clear module boundaries)?
- Are there any "clever" tricks that should be simplified? Run the simplicity checks from `using-agent-skills` → Enforce Simplicity.
- Would comments help clarify non-obvious intent? (But don't comment obvious code.)
- Are there dead code artifacts: no-op variables (`_unused`), backwards-compat shims, or `// removed` comments?
- **Is a new conditional bolted onto an unrelated flow?** That's a design smell, not a nitpick — push the logic into its own helper, state, or policy instead of tangling an existing path.
- **Do repeated conditionals on the same shape appear?** They signal a missing model or dispatcher. A "temporary" branch is usually permanent debt.

### 3. Architecture

Does the change fit the system's design?

- Does it follow existing patterns or introduce a new one? If new, is it justified?
- Does it maintain clean module boundaries?
- Is there code duplication that should be shared?
- Are dependencies flowing in the right direction (no circular dependencies)?
- Is the abstraction level appropriate (not over-engineered, not too coupled)?
- **Is this refactor a shell game?** A refactor that leaves the reader holding the same number of concepts has relocated complexity, not reduced it. Count the concepts; name the version where a whole branch, mode, or layer disappears. Prefer deleting an abstraction to polishing it.
- **Does the change grow an already-large file?** Around 1000 total lines in one file is an inspection signal, not a hard cap — when a change materially grows such a file, ask whether to extract helpers, subcomponents, or modules *first*. Decompose, then add.
- **Is feature-specific logic leaking into a shared or general-purpose module?** Keep logic in its owning layer, reuse the existing canonical helper instead of a near-duplicate, and don't normalize architectural drift.
- **Are type boundaries explicit?** Question gratuitous `any`/`unknown`/optional/casts and silent fallbacks that paper over an unclear invariant — making the boundary explicit often makes the surrounding control flow simpler.

### 4. Security

Does the change introduce vulnerabilities? Invoke `security-and-hardening` when
the diff touches auth, input handling, or secrets — it carries the hunting
lenses and the repro-and-blast-radius rating.

- Is user input validated at the system boundary, and are queries parameterized?
- Are secrets kept out of code, logs, and version control?
- Is authorization — not merely authentication — checked on every resource access?
- Are outputs encoded to prevent XSS?
- Is data from external sources (APIs, logs, user content, config files, model output) treated as untrusted?
- Does a new dependency earn its place, and is it free of known vulnerabilities? (`references/security-checklist.md` → Dependency Security)

### 5. Performance

Does the change introduce unbounded work? Invoke `performance-optimization` when
the diff touches hot paths, loops over unbounded data, or queries — it carries
the bound lens.

- Any N+1 query patterns, or missing pagination on list endpoints?
- Any loop, fetch, cache, or allocation with no bound on how far it grows?
- Any synchronous operation on a hot path that should be async or batched?
- Any unnecessary re-renders, or memoization added without a profile behind it?

## Structural Remedies

When you flag a structural problem, propose the move — not just the problem. A review that only says "this is complex" leaves the author guessing. Reach for a named restructuring:

- **Replace a chain of conditionals** with a typed model or an explicit dispatcher.
- **Collapse duplicate branches** into a single clearer flow.
- **Separate orchestration from business logic** so each reads on its own.
- **Move feature-specific logic** out of a shared module into the package that owns the concept.
- **Reuse the canonical helper** instead of a bespoke near-duplicate.
- **Make a type boundary explicit** so downstream branching disappears.
- **Delete a pass-through wrapper** that adds indirection without clarifying the API.
- **Extract a helper, or split a large file** into focused modules.

Prefer the remedy that removes moving pieces over one that spreads the same complexity around. `code-simplification` and `references/simplification-patterns.md` carry the fuller catalogue.

## Dead Code

After any refactor, name what the change orphaned — a function with no remaining
callers, a component nothing renders, a constant nothing reads — as a
`suggestion` naming each element and what replaced it. Dead code confuses future
readers and agents, but deleting on a guess is worse; report it and let the next
iteration decide.

## Honesty in Review

- **Back every approval with evidence.** "LGTM" alone helps no one.
- **Say the severity you mean.** "This might be a minor concern" about a bug that will hit production is dishonest — sycophancy is a review failure mode.
- **Quantify when you can.** "This N+1 adds a query per row in the list" beats "this could be slow."
- **Comment on code, not people**, and defer to the author when they have full context and disagree.
- **Resolve disputes by evidence:** technical facts over preference, the style guide as the authority on style, engineering principles over taste, and codebase consistency where it doesn't degrade health.
- **"I'll clean it up later" doesn't land.** Deferred cleanup rarely happens — require it in this change, or a filed and assigned follow-up.

## Verification

The review is complete when:

- [ ] All five axes have a stated verdict — the clean ones named, not omitted
- [ ] Every finding carries a severity, a `file:line`, and the move that fixes it
- [ ] No finding is hedged as "potential" or "theoretical" — that is a `suggestion` or it is nothing
- [ ] Findings are ordered by leverage, not by file order
- [ ] Any `critical` or `important` finding is concrete enough to act on without re-reading the whole diff
