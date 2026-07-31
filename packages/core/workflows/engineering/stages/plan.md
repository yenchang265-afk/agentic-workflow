Goal: {{goal}}
---
{{#task}}Task file: {{task.path}} — write the ## Implementation Plan onto this file in place. If the file already carries a ## Implementation Plan section, REPLACE that section rather than appending a second heading: a queued task sent back by replan keeps its old plan, and stacking a new heading below it leaves the superseded text in the task's prose forever. Leave every `> …` audit-note line exactly where it is — those are the trail the replan reason lives in.{{/task}}
---
{{#artifacts.plan}}Prior plan (rejected or capped out — the new plan must address why this one failed, using the task file's audit notes):
{{artifacts.plan}}{{/artifacts.plan}}
---
{{#acceptance}}Acceptance criteria (the plan must lead to satisfying each):
{{acceptance.bullets}}{{/acceptance}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
