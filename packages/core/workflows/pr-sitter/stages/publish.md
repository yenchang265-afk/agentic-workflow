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
{{#git}}Push the verified commits: `git push origin {{git.branch}}`. {{#platform.github}}Then reply on the PR — one `gh pr comment` (or per-thread reply via `gh api repos/{owner}/{repo}/pulls/<n>/comments/<comment-id>/replies -f body=…` — path first, no other endpoints are allowlisted) per addressed finding, saying what changed and where. NEVER merge, close, or approve the PR; that stays a human call.{{/platform.github}}{{#platform.ado}}Then reply on the PR — one reply per addressed finding, saying what changed and where: via the `az` CLI: `az devops invoke --area git --resource pullRequestThreadComments --route-parameters project=<project> repositoryId=<repoId> pullRequestId=<n> threadId=<threadId> --http-method POST --in-file reply.json --api-version 7.1` where `reply.json` is `{"content":"…","commentType":"text"}`. NEVER complete, abandon, or approve the PR; that stays a human call.{{/platform.ado}}{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
