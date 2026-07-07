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
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. {{#platform.github}}Then reply on the PR — one `gh pr comment` (or per-thread reply via `gh api`) per addressed finding, saying what changed and where. NEVER merge, close, or approve the PR; that stays a human call.{{/platform.github}}{{#platform.ado}}Then reply on the PR — one thread reply via `az devops invoke --area git --resource pullRequestThreads …` per addressed finding, saying what changed and where. NEVER complete, abandon, or approve the PR; that stays a human call.{{/platform.ado}}{{#platform.adoMcp}}Then reply on the PR via the `ado` MCP server — one `mcp__ado__repo_reply_to_comment` (or `mcp__ado__repo_create_pull_request_thread` for a new thread) per addressed finding, saying what changed and where. NEVER complete, abandon, approve, or add reviewers to the PR (`repo_update_pull_request`, `repo_vote_pull_request`, `repo_update_pull_request_reviewers` are off-limits); merging stays a human call.{{/platform.adoMcp}}{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
