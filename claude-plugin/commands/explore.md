---
description: Scan the repository for improvement opportunities and file up to 5 as draft backlog tasks
---

Spawn the **`loop-explore`** subagent (Task tool) to scan this repository for
concrete improvement opportunities — bugs, missing tests, tech debt, security or
performance gaps — and file up to **5** of them as schema-valid draft tasks in
`docs/tasks/draft/`, deduped against what already exists. It writes task files
only; it never touches source code. Review the drafts, plan the worthwhile
ones with `/agent-loop-plan task <id>`, and approve them with
`/agent-loop-plan approve <id>`.
