---
name: interview-me
description: Extracts what the user actually wants via a one-question-at-a-time interview to ~95% confidence. Use when an ask is underspecified, when you catch yourself silently filling in requirements, or when the user says "interview me" or "grill me".
---

# Interview Me

What people ask for and what they actually want are different things. They ask for "a dashboard" because that's what one asks for, not because a dashboard solves their problem. They say "make it faster" without a number to hit.

The cheapest moment to find that gap is before any plan, spec, or code exists. Once building starts, switching costs are real, the user rationalizes the wrong thing into a "good enough" thing, and the misfit gets locked in.

Every other Define-phase skill assumes you already roughly know what you want. This is the part before those: one question at a time, with your best guess attached, until you can predict what the user will say before they say it.

## When to Use

Apply this skill when:

- The ask is missing at least one of: **who** the user is, **why** they want it, what **success** looks like, what the binding **constraint** is
- The request is conventional rather than specific ("build me X", "make it faster") and you can't unpack the convention without guessing
- You're tempted to start with assumptions you haven't surfaced
- The user hasn't said which value they're optimizing for when two reasonable ones are in tension (simplicity vs. flexibility, cost vs. speed)
- The user explicitly invokes: "interview me", "grill me", "before we start, are we sure?", "stress-test my thinking"

**When NOT to use:**

- The ask is unambiguous and self-contained, or mechanical ("rename this variable", "fix this typo", format, file move)
- Pure information requests ("how does X work?", "what does this code do?")
- The user has explicitly asked for speed over verification
- **Predict-three** (below) already passes on the ask as written

## Loading Constraints

This skill needs a live, responsive user. **Do not invoke it in an unattended pipeline** — the BUILD/VERIFY/REVIEW stage turns `/agentic-workflow:engineering` drives on `session.idle`, CI runs, scheduled runs, autonomous loops. If you're in one of those and the ask is underspecified, that's a blocker to report, not a gap to guess at.

It is **mandatory** in `/agentic-workflow:engineering new <idea>` and `retask <id>`: every run interviews the user before a draft is written or rewritten. The interview runs in the **calling agent's own turn** — subagents cannot converse with the user — and only once the user confirms does the calling agent hand the confirmed intent to the `workflow-task-author` subagent to write the file. Nothing is queued for execution until a human later runs `approve`.

## The Process

### Step 1: Hypothesize, with a confidence number

Before asking anything, write your current best read of what the user wants in **one sentence**, plus an honest confidence number (0–100%). Below ~70%, append what's still missing on the same line — that tells the user exactly what the interview has to surface, and keeps the number from being a vague signal.

Two openings, depending on what you're holding.

**Cold start** — an ad-hoc ask, or `new <idea>`. Nothing is written down yet, so the hypothesis is a genuine guess:

```
HYPOTHESIS: You want a way to answer "how are we doing?" in standup, and "dashboard" was the convention that came to mind.
CONFIDENCE: ~30% — missing: who it's for, what "metrics" means in context, and what success looks like
```

**Reshape** — `retask <id>`, or any existing draft, spec, or note in hand. Here the hypothesis is not a guess: it is the artifact's stated goal plus what the new note changes. Open high and spend the interview on what the note *breaks*, not on re-deriving intent that's already written down:

```
HYPOTHESIS: Same goal as the draft (single-tenant export), but the note moves the boundary to per-workspace, which invalidates acceptance criterion 3.
CONFIDENCE: ~80% — missing: whether criterion 3 is dropped or replaced
```

The number forces honesty. If you wrote a high number but can't predict the user's reactions to the next three questions you'd ask, the number is wrong — see **predict-three** below.

**The floor.** When the ask already carries a clear goal and 2–5 testable criteria, the interview is a single restate-and-confirm question. It is never a silent skip: no path through this skill asks the user nothing.

### Facts are looked up, decisions are asked

Before sending any question, check whether its answer already lives in the environment — the repo, its docs, its git history. A question whose answer is greppable is legwork you skipped, not an interview question: `Glob`/`Grep`/`Read` it yourself and spend the user's turn on a genuine decision, preference, or piece of intent. When the codebase holds most of what's missing, `codebase-exploration` does that lookup wholesale, and its findings arrive here as your `GUESS:` lines.

### Step 2: Ask guess-first, one question at a time

A **guess-first** question is one question with your hypothesis for its answer attached:

```
Q:     <one focused question>
GUESS: <your hypothesis for the answer, with the reasoning that produced it>
```

Wait for the user to react before asking the next one.

The guess is the load-bearing half. The user reacts to a wrong guess faster than they generate an answer from scratch; it commits you to a position you can be visibly wrong about; and it exposes *your* assumptions, which is what the interview exists to do. A question without a guess is surveying, not interviewing.

One at a time, because the user can't react to a hypothesis buried in a list, batches invite skim-reading and surface answers, and the third question usually depends on the answer to the first — asking all three at once locks in the wrong framing.

The risk is a polite user agreeing with your guess to be agreeable. Mitigate by being visibly willing to be wrong, and by occasionally guessing in a direction you expect pushback on.

### Step 3: Listen for "want vs. should want", then probe

The most dangerous answers are the ones where the user says what a thoughtful answer *sounds like* rather than what they want. The tells:

- best-practice talk with no specifics ("scalable", "clean architecture", "modern", "robust")
- deference to convention ("the way most apps do it", "the standard approach")
- "I should probably…", "I think I'm supposed to…", "good engineering practice says…"

Any of those fires the **no-justification probe**:

> *"If you didn't have to justify this to anyone, what would you actually want?"*

That single question often does more work than the previous five.

### Step 4: Restate intent in the user's own words

When **predict-three** passes (see below), write back what you now think the user wants. Keep it tight, use their language, and structure it so they can confirm or correct line by line:

```
Here's what I now think you want:

- Outcome:      <one line>
- User:         <one line — who benefits>
- Why now:      <one line — what changed>
- Success:      <one line — how we know it worked>
- Acceptance:   <2–5 checks, each one observably pass/fail>
- Constraint:   <one line — the binding limit>
- Out of scope: <one line — what we're explicitly not doing>

Yes / no / refine?
```

`Success` and `Acceptance` are different artifacts and both stay: `Success` is the human win in a sentence, `Acceptance` is the set of checks a later build or verify stage can actually run. Inside `new` and `retask`, `Acceptance` is what you hand to `workflow-task-author` as the task's acceptance criteria — so keep it to 2–5 lines and keep every line testable. For a pure ad-hoc interview with no downstream task file, it's optional.

`Out of scope` is non-negotiable in both branches. Half of misalignment is silent disagreement about what is *not* being built.

### Step 5: Confirm — an explicit yes, not a hollow yes

A **hollow yes** is agreement that isn't confirmation. Four kinds, each with its counter-move:

| The user says | What it means | Counter-move |
|---|---|---|
| "Whatever you think is best." | Delegation — they don't have 95% confidence either | Re-ask as a choice between two concrete options |
| "Sounds good." / "Sure, let's go." | Politeness, possibly a polite exit | Ask "anything you'd refine?" — silence isn't confirmation |
| Silence, then "okay let's start." | They've given up on the interview, not converged | Stop and ask what you've missed |
| A yes on a vague restate | The restate committed to nothing falsifiable | Restate in the Step 4 shape and re-confirm |

Fold every correction in and restate. Loop until the yes lands on a concrete restate.

### The predict-three stop

**Predict-three** is the stop test:

> *Can I predict the user's reaction to the next three questions I would ask?*

Yes → you have shared understanding; stop interviewing and produce the Step 4 restate. No → ask the next guess-first question.

It's checkable rather than a vibe, and it has a budget. A typical interview is 3–6 guess-first questions. If predict-three still fails at **8**, the count isn't the problem — something foundational is. Stop and say so: "I've asked eight questions and still can't predict your reactions. Something foundational is missing — want to step back?"

## Output

The deliverable is a **confirmed statement of intent**: the Step 4 restate with an explicit yes behind it, not a **hollow yes**. Specs, plans, and task lists are downstream; they consume this.

Inside `new` and `retask`, that confirmed intent — the goal plus its 2–5 acceptance criteria — is what the calling agent hands to the `workflow-task-author` subagent. Elsewhere, if the user wants the intent to survive the session or travel to another collaborator, offer to save it to `docs/intent/[topic].md`. Save only after they confirm: the doc itself implies a yes.

## Example

Without this skill, "build me a dashboard for our metrics" goes straight to chart libraries and layouts — silently assuming who it's for, which metrics, and what done looks like. Two guess-first questions instead:

```
Agent:
HYPOTHESIS: You want to answer "how are we doing?" in standup; "dashboard" was the convention that came to mind.
CONFIDENCE: ~30% — missing: who it's for, what "metrics" are, what success looks like

Q:     Who's asking that question — you alone, the team in standup, or up the chain?
GUESS: the team in standup, because "we" usually scopes that way. For execs the metrics and framing change a lot.

User:  It's for me. I keep losing track of which experiments are running.

Agent: Updated read: a personal experiment tracker, not a team dashboard. Confidence ~60% — still missing what "done" looks like.

Q:     Is the gap that you don't know which experiments exist, or that you can't see their results in one place?
GUESS: the second — results scattered across five tools, and reconciling them by hand is what you're tired of.

User:  First one. I don't have a list at all.
```

The ask was never a dashboard. It was a list — different artifact, different scope, and two questions bought that.

## Interaction with Other Skills

- **`plan-router`** — upstream dispatcher: routes here when the missing information lives in the human's head.
- **`codebase-exploration`** — the sibling for the other holder: facts living in the codebase are looked up there, decisions living in the human are asked here.
- **`idea-refine`** — downstream. Confirmed intent that still needs scoping ("I want X, but I don't know how big X should be") hands off here for variations generated against the now-explicit intent.
- **`spec-driven-development`** — downstream. Concrete confirmed intent hands off here to be written down.
- **`doubt-driven-development`** — the far end of the same timeline. This skill is pre-decision intent extraction; doubt-driven is post-decision artifact review. Picking the wrong one wastes a round: nothing drafted yet → interview; a draft exists → doubt.

## Two moves that look wrong and aren't

**Attaching your guess is not leading the witness.** Reacting beats generating
from scratch, and a guess you can be visibly wrong about is what exposes your
assumptions. The real risk is the opposite one — sycophancy — so guess in
directions you expect pushback on.

**Listing options is not the opening move.** Options work when the user knows
what they want and is choosing between trade-offs; here they don't yet, so a
menu widens the search where a guess-first question narrows it. Two concrete
options are for breaking a **hollow yes**, not for opening.

**Three rounds with the confidence number flat** means you are asking the wrong
questions. Reframe rather than continue — the count is not the problem.

## Verification

- [ ] Step 1 opened with a hypothesis and a confidence number, from the right opening (cold start vs. reshape), and any number below ~70% named what was missing
- [ ] Every question was **guess-first** and sent on its own
- [ ] No question was asked whose answer was discoverable in the repo
- [ ] A **no-justification probe** ran on each convention- or best-practice-signalling answer
- [ ] The restate carried every line, including `Out of scope` and — for `new`/`retask` — 2–5 testable `Acceptance` checks
- [ ] The confirming yes was explicit, not a **hollow yes**
- [ ] **Predict-three** passed at the stop point, or the 8-question escalation fired
- [ ] No spec, plan, or task file was written before that yes
