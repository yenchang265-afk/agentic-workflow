Goal: {{goal}}
---
{{#artifacts.triage}}Triage findings the fix had to address:
{{artifacts.triage}}{{/artifacts.triage}}
---
{{#artifacts.fix}}Fix summary:
{{artifacts.fix}}{{/artifacts.fix}}
---
Check every finding is addressed and the test suite passes locally. Record the verdict via loop_verdict: PASS only when each finding is resolved and tests are green; FAIL with the gaps otherwise; ERROR when the checks themselves could not run.
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
