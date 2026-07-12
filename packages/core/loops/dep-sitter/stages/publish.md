Goal: {{goal}}
---
{{#artifacts.scan}}Upgrade work order:
{{artifacts.scan}}{{/artifacts.scan}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. {{#platform.github}}Then open a DRAFT pull request (`gh pr create --draft`) whose title names the package and target version and whose body carries the advisory closed, the semver impact, the fallout fixed, and the verification result. If a PR for this branch already exists (`gh pr list --head {{git.branch}}`), comment the update on it instead of opening another.{{/platform.github}}{{#platform.ado}}Then open a DRAFT pull request via the Azure DevOps REST API, authenticated with `curl -sS -u :"$AZURE_DEVOPS_EXT_PAT"`: `POST _apis/git/repositories/<repo>/pullrequests?api-version=7.1` with body `{"sourceRefName":"refs/heads/{{git.branch}}","targetRefName":"refs/heads/{{git.base}}","title":"…","description":"…","isDraft":true}` — the title names the package and target version, the description carries the advisory closed, the semver impact, the fallout fixed, and the verification result. If a PR for this branch already exists (`GET _apis/git/repositories/<repo>/pullrequests?searchCriteria.sourceRefName=refs/heads/{{git.branch}}&searchCriteria.status=active&api-version=7.1`), post a thread comment with the update instead of opening another.{{/platform.ado}} NEVER merge or close the PR and never mark it ready for review; those stay a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
