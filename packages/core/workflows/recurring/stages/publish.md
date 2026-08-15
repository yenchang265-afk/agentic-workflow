Goal: {{goal}}
---
{{#artifacts.plan}}Plan for this cycle:
{{artifacts.plan}}{{/artifacts.plan}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push this cycle's work: `git push origin {{git.branch}}`. {{#platform.github}}Open a DRAFT pull request onto {{git.base}} (`gh pr create --draft --base {{git.base}}`) whose body carries what this cycle changed and the verification result, and states that it was produced by a recurring work order so a reviewer knows another one is coming. Each cycle gets its OWN branch and its own PR — if `gh pr list --head {{git.branch}}` somehow already shows one for this exact branch, comment the update on it instead of opening a second.{{/platform.github}}{{#platform.ado}}Open a DRAFT pull request onto {{git.base}} whose description carries what this cycle changed and the verification result, and states that it was produced by a recurring work order. First check for an existing one with `mcp__azure-devops__repo_list_pull_requests_by_repo_or_project` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","sourceRefName":"refs/heads/{{git.branch}}","status":"active"}`; if one exists, post the update as a thread comment on it with `mcp__azure-devops__repo_create_pull_request_thread` instead of opening another. Otherwise call `mcp__azure-devops__repo_create_pull_request` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","sourceRefName":"refs/heads/{{git.branch}}","targetRefName":"refs/heads/{{git.base}}","title":"…","description":"…","isDraft":true}` — `isDraft` MUST be true.{{/platform.ado}} NEVER push {{git.base}} and never merge, close, or mark the pull request ready for review; those stay a human call.{{/git}}
---
Do not modify the recurring definition registry, and do not try to pause or reschedule this order — the schedule is the human's to change.
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
