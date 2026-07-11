Goal: {{goal}}
---
{{#artifacts.triage}}Triage findings that were addressed:
{{artifacts.triage}}{{/artifacts.triage}}
---
{{#artifacts.fix}}Fix summary:
{{artifacts.fix}}{{/artifacts.fix}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. {{#platform.github}}Then reply on the PR — one `gh pr comment` (or per-thread reply via `gh api`) per addressed finding, saying what changed and where. NEVER merge, close, or approve the PR; that stays a human call.{{/platform.github}}{{#platform.ado}}Then reply on the PR via the Azure DevOps REST API, each call authenticated with `curl -sS -u :"$AZURE_DEVOPS_EXT_PAT"` — one reply per addressed finding: `POST _apis/git/repositories/<repoId>/pullRequests/<n>/threads/<threadId>/comments?api-version=7.1` with body `{"content":"…","commentType":"text"}`, saying what changed and where. NEVER complete, abandon, or approve the PR; that stays a human call.{{/platform.ado}}{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
