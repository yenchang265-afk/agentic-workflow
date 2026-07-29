Goal: {{goal}}
---
{{#artifacts.scan}}Upgrade work order:
{{artifacts.scan}}{{/artifacts.scan}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. {{#platform.github}}Then open a DRAFT pull request (`gh pr create --draft`) whose title names the package and target version and whose body carries the advisory closed, the semver impact, the fallout fixed, and the verification result. If a PR for this branch already exists (`gh pr list --head {{git.branch}}`), comment the update on it instead of opening another.{{/platform.github}}{{#platform.ado}}Then open a DRAFT pull request whose title names the package and target version and whose description carries the advisory closed, the semver impact, the fallout fixed, and the verification result. First check for an existing one with `mcp__azure-devops__repo_list_pull_requests_by_repo_or_project` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","sourceRefName":"refs/heads/{{git.branch}}","status":"active"}`; if one exists, post the update as a thread comment on it instead of opening another, with `mcp__azure-devops__repo_create_pull_request_thread` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","pullRequestId":<existingId>,"content":"…"}`. Otherwise call `mcp__azure-devops__repo_create_pull_request` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","sourceRefName":"refs/heads/{{git.branch}}","targetRefName":"refs/heads/{{git.base}}","title":"…","description":"…","isDraft":true}` — `isDraft` MUST be true.{{/platform.ado}} NEVER merge or close the PR and never mark it ready for review; those stay a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
