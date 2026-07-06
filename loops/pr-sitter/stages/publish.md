Goal: {{goal}}
---
{{#artifacts.triage}}Triage findings that were addressed:
{{artifacts.triage}}{{/artifacts.triage}}
---
{{#artifacts.fix}}Fix summary:
{{artifacts.fix}}{{/artifacts.fix}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. Then reply on the PR — one `gh pr comment` (or per-thread reply via `gh api`) per addressed finding, saying what changed and where. NEVER merge, close, or approve the PR; that stays a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
