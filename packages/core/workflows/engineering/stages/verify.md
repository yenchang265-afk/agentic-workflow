Goal: {{goal}}
---
{{#artifacts.plan}}Plan & acceptance criteria:
{{artifacts.plan}}{{/artifacts.plan}}
---
{{#artifacts.build}}Build summary:
{{artifacts.build}}{{/artifacts.build}}
---
{{#acceptance}}Acceptance criteria (the verdict must check each):
{{acceptance.bullets}}{{/acceptance}}
---
{{#git}}Change scope: this loop's work is the commits on branch {{git.branch}} since {{git.base}} — `{{git.diffCmd}}` shows exactly what changed. Verify that work; a failure that pre-dates it is not this task's regression.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
