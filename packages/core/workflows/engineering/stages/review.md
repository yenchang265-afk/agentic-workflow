Goal: {{goal}}
---
{{#artifacts.plan}}Approved plan:
{{artifacts.plan}}{{/artifacts.plan}}
---
{{#artifacts.build}}Build summary:
{{artifacts.build}}{{/artifacts.build}}
---
{{#git}}Diff boundary: this loop's work is the commits on branch {{git.branch}} since {{git.base}} — review exactly `{{git.diffCmd}}`, nothing outside it.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
