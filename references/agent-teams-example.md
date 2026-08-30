# Agent Teams: competing-hypothesis debugging

The one branch that reaches past a fan-out, split out of
`references/orchestration-patterns.md` — which owns the catalog, the
anti-patterns, and the decision flow. Reach for it when an investigation's
hypotheses have to **argue with each other**.

## When it beats a fan-out

Both spawn three investigators, and the difference is where the value comes
from. A fan-out gives each investigator the same artifact through a different
lens and merges independent reports: a verdict on something you already have. A
team shares a task list and lets teammates message each other, so a theory only
survives once the others fail to disprove it: an investigation that has to *find*
the artifact among competing hypotheses.

The symptom shape that calls for it: intermittent, no error output, several
mutually exclusive causes that all fit — a race, a slow synchronous call on an
occasional path, an unindexed query that scales with input, a dependency
retrying silently. One agent takes the first plausible theory and stops. A
fan-out produces three reports that never meet, so nothing rules anything out.

## Running one

Experimental, and gated on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in
`~/.claude/settings.json` with Claude Code v2.1.32 or later. There are no team
config files: teammates are spawned from the trigger prompt, which has to carry
four things — the symptom, one distinct investigation angle per teammate, the
instruction to **message each other to challenge theories**, and the convergence
bar ("only converge when two can disprove the others"). This repo has no
standing specialist personas outside the loop's own stage agents, so teammates
are `general-purpose` with the angle folded into the prompt.

While it runs, `Ctrl+T` shows the shared task list (a tmux pane in split mode)
and `Shift+Down` cycles into a teammate to redirect it. Cleanup goes through the
lead — "clean up the team" — because a teammate lacks the team context to do it.

Three teammates debating for 10–15 minutes costs noticeably more than the same
three as subagents. It buys the *quality of the conclusion*, so spend it where a
wrong fix is expensive and not on a routine review.

## Where it is the wrong tool

A verdict on a known diff is a fan-out (`stageFanout` review). One perspective on
one artifact is a direct persona call. A plan → build → verify → review sequence
is the loop. Read-heavy research with a small digest is an `Explore` subagent.

And never rebuild this as a slash command that fans out subagents: subagents
cannot message each other, so the debate — the entire mechanism — is gone while
the shape still looks right. Keep the trigger prompt as a snippet instead.
