Goal: {{goal}}
---
{{#artifacts.diagnose}}Remedy work order:
{{artifacts.diagnose}}{{/artifacts.diagnose}}
---
{{#artifacts.remedy}}Remedy summary:
{{artifacts.remedy}}{{/artifacts.remedy}}
---
Check the remedy does what the work order asked: the failing workflow's command now passes locally on this branch, and the diff contains only the fix or revert the summary names. Record the verdict via workflow_verdict: PASS only when the failing command is green and the diff is scoped; FAIL with the gaps otherwise; ERROR when the checks themselves could not run.
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
