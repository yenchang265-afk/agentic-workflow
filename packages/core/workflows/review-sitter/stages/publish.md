Goal: {{goal}}
---
{{#artifacts.assess}}The review to post:
{{artifacts.assess}}{{/artifacts.assess}}
---
{{#git}}{{#platform.github}}Post the review as exactly ONE comment: `gh pr comment <n> --body "…"`, opening with a one-line note that this is an automated first-pass review and the human reviewer stays the reviewer of record. NEVER approve, request changes, merge, close, or push; those stay a human call.{{/platform.github}}{{#platform.ado}}Post the review as exactly ONE new thread with `mcp__azure-devops__repo_create_pull_request_thread` with `{"project":"{{ado.project}}","repositoryId":"{{ado.repository}}","pullRequestId":<n>,"content":"…","status":"active"}` — opening with a one-line note that this is an automated first-pass review and the human reviewer stays the reviewer of record. NEVER vote, approve, complete, abandon, or push; those stay a human call.{{/platform.ado}}{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
