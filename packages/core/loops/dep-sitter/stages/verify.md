Goal: {{goal}}
---
{{#artifacts.scan}}Upgrade work order:
{{artifacts.scan}}{{/artifacts.scan}}
---
{{#artifacts.upgrade}}Upgrade summary:
{{artifacts.upgrade}}{{/artifacts.upgrade}}
---
Check the upgrade landed exactly as ordered and nothing else moved: the dependency resolves at the target version (`npm ls <pkg>`), the advisory is gone from `npm audit`, the diff touches only the manifest/lockfile plus the fallout the summary names, and the test suite passes locally. Record the verdict via loop_verdict: PASS only when all of that holds; FAIL with the gaps otherwise; ERROR when the checks themselves could not run.
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
