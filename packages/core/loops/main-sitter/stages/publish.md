Goal: {{goal}}
---
{{#artifacts.diagnose}}Diagnosis:
{{artifacts.diagnose}}{{/artifacts.diagnose}}
---
{{#artifacts.verify}}Verification result:
{{artifacts.verify}}{{/artifacts.verify}}
---
{{#git}}Push the remedy: `git push origin {{git.branch}}`. Open a DRAFT pull request onto {{git.base}} (`gh pr create --draft --base {{git.base}}`) whose body carries the diagnosis, the failing workflow(s), and the verification result; if a PR for this branch already exists (`gh pr list --head {{git.branch}}`), comment the update on it instead. When the diagnosis identifies the culprit PR, comment ONCE on it linking the remedy PR — informational, not an assignment. NEVER push {{git.base}} and never merge, close, or mark the remedy ready for review; those stay a human call.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
