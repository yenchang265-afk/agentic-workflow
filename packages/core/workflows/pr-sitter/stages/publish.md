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
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. {{#platform.github}}Then reply on the PR — one `gh pr comment` (or per-thread reply via `gh api repos/{owner}/{repo}/pulls/<n>/comments/<comment-id>/replies -f body=…` — path first, no other endpoints are allowlisted) per addressed finding, saying what changed and where. NEVER merge, close, or approve the PR; that stays a human call.{{/platform.github}}{{#platform.ado}}Then reply on the PR — one reply per addressed finding, saying what changed and where — with `mcp__azure-devops__repo_reply_to_comment` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","pullRequestId":<n>,"threadId":<threadId>,"content":"…"}`, on the thread that raised it (`mcp__azure-devops__repo_list_pull_request_threads` gives you the `threadId`). NEVER call `repo_update_pull_request`, `repo_vote_pull_request`, or `repo_update_pull_request_reviewers` — completing, abandoning, approving and reviewer changes all stay a human call.{{/platform.ado}}{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
