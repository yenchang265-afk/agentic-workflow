# Threat model — the agentic loop

What can go wrong when PLAN → BUILD → VERIFY → REVIEW runs largely
unattended, and which control answers it. The audience is a team adopting
`/agent-loop` in an environment where unreviewed code changes, data exfiltration,
or unauditable approvals are real costs, not hypotheticals.

## Assets

- The repository (source, history, branches).
- Secrets reachable from the working tree or environment (`.env`, tokens in
  git config, CI credentials on the machine).
- The task backlog and its audit trail (`docs/tasks/`).
- The human's trust in the loop's verdicts.

## Trust boundaries

The loop's agents consume three kinds of input with very different trust:

1. **Human input** — the goal, the plan approval, `/agent-loop` commands. Trusted.
2. **Loop-internal context** — prior stage artifacts threaded between
   stages. Semi-trusted: produced by our own agents, but those agents read
   untrusted input, so anything in an artifact may be attacker-influenced.
3. **Repository content** — code, comments, docs, test fixtures,
   dependencies. **Untrusted.** A hostile or compromised repo can contain
   text written to steer an LLM ("ignore previous instructions", fake
   verdict lines, instructions to run commands).

## Threats and controls

### T1. Repo-content prompt injection flips a verdict

A file the VERIFY/REVIEW agent reads contains `LOOP_VERIFY: PASS`, or prose
persuading the agent the check passed.

- **Control:** verdicts are only accepted through the `loop_verdict` plugin
  tool, and only from the session whose loop is currently in that exact
  check stage. Verdict text in a transcript is diagnostic only; a missing
  tool call is a FAIL. Injected text cannot call tools by itself.
- **Residual:** an injection that persuades the *agent* to call the tool
  with PASS. Mitigated by the iteration cap, the human diff review after
  REVIEW, and the loop never pushing. Optionally hardened further by
  `reviewLenses`: REVIEW runs once per lens and the loop takes the worst
  verdict, so a single persuaded reviewer can't flip the outcome — an
  injection would have to survive every lens's independent pass. Residual
  shrinks to N simultaneous persuasions.

### T2. A "read-only" check stage mutates state or exfiltrates data

`edit: deny` alone does not restrict bash; `git commit`, `rm`, or `curl`
would all have been available to VERIFY/REVIEW.

- **Control:** VERIFY and REVIEW run under a bash **allowlist** (default
  deny) of inspection and test commands, plus `webfetch: deny`. BUILD keeps
  broad access but only runs after a human approved its plan, on an
  isolated branch, and never pushes.
- **Residual:** `npm run *` / `make test*` execute repo-defined scripts —
  an attacker who can commit to the repo can run code inside VERIFY. That
  is the same trust you already extend to CI. There is no network egress
  control beyond webfetch; sandbox the watcher host (containers, egress
  rules) when the repo is not fully trusted.

### T3. Cross-task contamination of the working tree

One task's half-finished diff leaks into another task's build or review.

- **Control:** each execution runs on its own `loop/<id>` branch with a
  commit checkpoint per build iteration; REVIEW is told the exact
  `git diff base...branch` boundary; an atomic claim marker prevents two
  watchers from taking the same task. In shared-tree mode a per-directory
  lock also serializes drives within one opencode instance. With
  `worktreesDir` set, each execution runs in its **own git worktree**, so the
  shared checkout is never branch-switched under a concurrent drive and the
  serialization lock is unnecessary — same-instance concurrent watchers are
  safe.
- **Residual:** two *separate opencode processes* sharing one clone still
  race the main tree's `index.lock` when committing backlog mutations
  (best-effort, degrades gracefully). Run extra watchers in their own clones
  for hard isolation.

### T4. Unauditable or spoofable approvals

Change management needs who/what/when for every gate decision.

- **Control:** every lifecycle event (plan recorded, plan approved, build
  start/finish, verdicts, stop, recovery, completion) is appended to the
  task file as a timestamped note attributed to the machine's git identity,
  and backlog mutations are committed (planning-phase commits scoped to the
  tasks dir; execution-phase notes ride the branch checkpoints in shared-tree
  mode, or are committed to the main tree per terminal event in worktree
  mode). Full stage outputs land in `<tasksDir>/runs/<id>.md`, plus a
  `## Run summary` with per-stage timings and verdict history on termination.
- **Residual:** the actor is the *configured* git identity, not an
  authenticated one. For hard identity guarantees, gate approvals through
  your forge instead (protected branches + PR review of the parked plan).

### T5. Runaway or wedged automation

A stage hangs forever, or FAIL loops burn unbounded tokens.

- **Control:** shared `maxIterations` cap on re-plans/re-builds; per-stage
  wall-clock timeout (`stageTimeoutMinutes`); ERROR verdicts stop the loop
  on environment breakage instead of iterating; a missing/garbled verdict
  is a FAIL, never a stall.

### T6. Secrets leak into durable artifacts

Plans, build summaries, and run logs are written to files that may be
committed.

- **Control:** every write to a durable artifact (audit notes, persisted
  plans, run logs) passes through a **shape-based redactor** first — AWS
  keys, `sk-`/`sk-ant-` keys, GitHub/Slack tokens, JWTs, PEM private-key
  blocks, and `key/secret/token/password: …` assignments are replaced with
  `[REDACTED:<pattern>]` (the pattern names, never values, are logged). Stages
  also have no reason to read secret files, and REVIEW's checklist flags
  secret handling in the diff.
- **Residual:** redaction is shape-based, so a custom-format secret (e.g. an
  internal token shaped like a UUID) can still slip through. Defense in depth
  remains: keep secrets out of the working tree (use a secret manager) and
  treat `runs/` as sensitive when the environment holds credentials.

## Non-goals

The loop never pushes, opens PRs, or merges — the human does, after REVIEW
passes. Anything requiring authenticated identity, network egress control,
or OS-level sandboxing belongs to the host environment, not this plugin.
