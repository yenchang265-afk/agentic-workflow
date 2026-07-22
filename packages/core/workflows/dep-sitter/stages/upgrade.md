Goal: {{goal}}
---
{{#artifacts.scan}}Upgrade work order:
{{artifacts.scan}}{{/artifacts.scan}}
---
{{#artifacts.verify}}Verify failure to address:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Work on branch {{git.branch}} (base {{git.base}}). Apply the upgrade exactly as the work order names it: bump the manifest entry, refresh the lockfile, and fix the fallout the bump causes (type errors, renamed APIs, failing tests) — nothing else; never touch versions the work order doesn't name. Commit your work; do NOT push — the publish stage pushes after verification. Never merge.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
