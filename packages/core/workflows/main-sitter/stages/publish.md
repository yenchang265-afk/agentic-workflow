Goal: {{goal}}
---
{{#artifacts.diagnose}}Diagnosis:
{{artifacts.diagnose}}{{/artifacts.diagnose}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the remedy: `git push origin {{git.branch}}`. {{#platform.github}}Open a DRAFT pull request onto {{git.base}} (`gh pr create --draft --base {{git.base}}`) whose body carries the diagnosis, the failing workflow(s), and the verification result; if a PR for this branch already exists (`gh pr list --head {{git.branch}}`), comment the update on it instead. When the diagnosis identifies the culprit PR, comment ONCE on it (`gh pr comment`) linking the remedy PR — informational, not an assignment.{{/platform.github}}{{#platform.ado}}Open a DRAFT pull request onto {{git.base}} whose description carries the diagnosis, the failing workflow(s), and the verification result. First check for an existing one with `mcp__azure-devops__repo_list_pull_requests_by_repo_or_project` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","sourceRefName":"refs/heads/{{git.branch}}","status":"active"}`; if one exists, post the update as a thread comment on it instead of opening another, with `mcp__azure-devops__repo_create_pull_request_thread` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","pullRequestId":<existingId>,"content":"…"}`. Otherwise call `mcp__azure-devops__repo_create_pull_request` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","sourceRefName":"refs/heads/{{git.branch}}","targetRefName":"refs/heads/{{git.base}}","title":"…","description":"…","isDraft":true}` — `isDraft` MUST be true. When the diagnosis identifies the culprit PR, post ONE thread comment on it with `mcp__azure-devops__repo_create_pull_request_thread` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","pullRequestId":<culpritId>,"content":"…"}` linking the remedy PR — informational, not an assignment.{{/platform.ado}} NEVER push {{git.base}} and never merge, close, or mark the remedy ready for review; those stay a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
