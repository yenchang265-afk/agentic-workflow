Goal: {{goal}}
---
{{#artifacts.diagnose}}Diagnosis:
{{artifacts.diagnose}}{{/artifacts.diagnose}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the remedy: `git push origin {{git.branch}}`. {{#platform.github}}Open a DRAFT pull request onto {{git.base}} (`gh pr create --draft --base {{git.base}}`) whose body carries the diagnosis, the failing workflow(s), and the verification result; if a PR for this branch already exists (`gh pr list --head {{git.branch}}`), comment the update on it instead. When the diagnosis identifies the culprit PR, comment ONCE on it (`gh pr comment`) linking the remedy PR — informational, not an assignment.{{/platform.github}}{{#platform.ado}}Open a DRAFT pull request onto {{git.base}} whose description carries the diagnosis, the failing workflow(s), and the verification result. Via the Azure DevOps REST API, authenticated with `curl -sS -u :"$AZURE_DEVOPS_EXT_PAT"`: `POST _apis/git/repositories/<repo>/pullrequests?api-version=7.1` with body `{"sourceRefName":"refs/heads/{{git.branch}}","targetRefName":"refs/heads/{{git.base}}","title":"…","description":"…","isDraft":true}`. If a PR for this branch already exists (`GET _apis/git/repositories/<repo>/pullrequests?searchCriteria.sourceRefName=refs/heads/{{git.branch}}&searchCriteria.status=active&api-version=7.1`), post a thread comment with the update instead. When the diagnosis identifies the culprit PR, post ONE thread comment on it (`POST _apis/git/repositories/<repo>/pullRequests/<culpritId>/threads?api-version=7.1`) linking the remedy PR — informational, not an assignment.{{/platform.ado}} NEVER push {{git.base}} and never merge, close, or mark the remedy ready for review; those stay a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
