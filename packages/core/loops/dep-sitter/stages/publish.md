Goal: {{goal}}
---
{{#artifacts.scan}}Upgrade work order:
{{artifacts.scan}}{{/artifacts.scan}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. Then open a DRAFT pull request (`gh pr create --draft`) whose title names the package and target version and whose body carries the advisory closed, the semver impact, the fallout fixed, and the verification result. If a PR for this branch already exists (`gh pr list --head {{git.branch}}`), comment the update on it instead of opening another. NEVER merge or close the PR and never mark it ready for review; those stay a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
