Goal: {{goal}}
---
{{#task}}Task file: {{task.path}} — write the ## Implementation Plan onto this file in place.{{/task}}
---
{{#artifacts.plan}}Prior plan (rejected or capped out — the new plan must address why this one failed, using the task file's audit notes):
{{artifacts.plan}}{{/artifacts.plan}}
---
{{#acceptance}}Acceptance criteria (the plan must lead to satisfying each):
{{acceptance.bullets}}{{/acceptance}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
