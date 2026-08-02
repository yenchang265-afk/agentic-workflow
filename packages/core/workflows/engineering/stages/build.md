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
{{#attempts}}Previous attempts on this task — do not repeat a fix that already failed:
{{attempts.lines}}{{/attempts}}
---
{{#iterations}}Iteration budget: this is iteration {{iterations.human}} of {{iterations.cap}}. {{#iterations.final}}This is the FINAL iteration — a check failure now stops the loop and sends the task back to a human for re-planning. {{/iterations.final}}A prior attempt on this task already failed: address the failure's root cause, and change approach rather than retrying a fix the attempts list already shows failing.{{/iterations}}
---
{{#acceptance}}Acceptance criteria (the build must satisfy each):
{{acceptance.bullets}}{{/acceptance}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
