Goal: {{goal}}
---
{{#artifacts.diagnose}}Diagnosis:
{{artifacts.diagnose}}{{/artifacts.diagnose}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the remedy: `git push origin {{git.branch}}`. {{#platform.github}}Open a DRAFT pull request onto {{git.base}} (`gh pr create --draft --base {{git.base}}`) whose body carries the diagnosis, the failing workflow(s), and the verification result; if a PR for this branch already exists (`gh pr list --head {{git.branch}}`), comment the update on it instead. When the diagnosis identifies the culprit PR, comment ONCE on it (`gh pr comment`) linking the remedy PR — informational, not an assignment.{{/platform.github}}{{#platform.ado}}Open a DRAFT pull request onto {{git.base}} whose description carries the diagnosis, the failing workflow(s), and the verification result. Via the `az` CLI: `az repos pr create --draft --source-branch {{git.branch}} --target-branch {{git.base}} --title "…" --description "…"`. If a PR for this branch already exists (`az repos pr list --source-branch {{git.branch}} --status active`), post a thread comment with the update instead (`az devops invoke --area git --resource pullRequestThreads --route-parameters project=<project> repositoryId=<repo> pullRequestId=<n> --http-method POST --in-file thread.json --api-version 7.1`). When the diagnosis identifies the culprit PR, post ONE thread comment on it the same way, linking the remedy PR — informational, not an assignment.{{/platform.ado}} NEVER push {{git.base}} and never merge, close, or mark the remedy ready for review; those stay a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
