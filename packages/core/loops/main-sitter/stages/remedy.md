Goal: {{goal}}
---
{{#artifacts.diagnose}}Remedy work order:
{{artifacts.diagnose}}{{/artifacts.diagnose}}
---
{{#artifacts.verify}}Verify failure to address:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Work on branch {{git.branch}} (pinned at the red head of {{git.base}}). Write the forward fix, or construct the revert (`git revert <sha>`) when the work order calls for it — the smallest change that makes the failing job pass. Commit your work; do NOT push — the publish stage pushes after verification. NEVER touch {{git.base}} itself.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
