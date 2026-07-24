Goal: {{goal}}
---
{{#artifacts.scan}}Upgrade work order:
{{artifacts.scan}}{{/artifacts.scan}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. {{#platform.github}}Then open a DRAFT pull request (`gh pr create --draft`) whose title names the package and target version and whose body carries the advisory closed, the semver impact, the fallout fixed, and the verification result. If a PR for this branch already exists (`gh pr list --head {{git.branch}}`), comment the update on it instead of opening another.{{/platform.github}}{{#platform.ado}}Then open a DRAFT pull request whose title names the package and target version and whose description carries the advisory closed, the semver impact, the fallout fixed, and the verification result. Via the `az` CLI: `az repos pr create --draft --source-branch {{git.branch}} --target-branch {{git.base}} --title "…" --description "…"`. If a PR for this branch already exists (`az repos pr list --source-branch {{git.branch}} --status active`), post a thread comment with the update instead of opening another (`az devops invoke --area git --resource pullRequestThreads --route-parameters project=<project> repositoryId=<repo> pullRequestId=<n> --http-method POST --in-file thread.json --api-version 7.1`).{{/platform.ado}} NEVER merge or close the PR and never mark it ready for review; those stay a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
