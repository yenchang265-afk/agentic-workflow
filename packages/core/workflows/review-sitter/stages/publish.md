Goal: {{goal}}
---
{{#artifacts.assess}}The review to post:
{{artifacts.assess}}{{/artifacts.assess}}
---
{{#git}}{{#platform.github}}Post the review as exactly ONE comment: `gh pr comment <n> --body "…"`, opening with a one-line note that this is an automated first-pass review and the human reviewer stays the reviewer of record. NEVER approve, request changes, merge, close, or push; those stay a human call.{{/platform.github}}{{#platform.ado}}Post the review as exactly ONE new thread via the `az` CLI: `az devops invoke --area git --resource pullRequestThreads --route-parameters project=<project> repositoryId=<repoId> pullRequestId=<n> --http-method POST --in-file thread.json --api-version 7.1` where `thread.json` is `{"comments":[{"content":"…","commentType":"text"}],"status":"active"}` — opening with a one-line note that this is an automated first-pass review and the human reviewer stays the reviewer of record. NEVER vote, approve, complete, abandon, or push; those stay a human call.{{/platform.ado}}{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
