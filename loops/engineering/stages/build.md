Goal: {{goal}}
---
{{#artifacts.plan}}Approved plan:
{{artifacts.plan}}{{/artifacts.plan}}
---
{{#artifacts.verify}}Verify failure to address:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#artifacts.review}}Review feedback to address:
{{artifacts.review}}{{/artifacts.review}}
---
{{#acceptance}}Acceptance criteria (the build must satisfy each):
{{acceptance.bullets}}{{/acceptance}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
