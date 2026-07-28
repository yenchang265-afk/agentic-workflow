Goal: {{goal}}
---
{{#artifacts.plan}}Approved plan:
{{artifacts.plan}}{{/artifacts.plan}}
---
{{#artifacts.build}}Build summary:
{{artifacts.build}}{{/artifacts.build}}
---
{{#artifacts.review}}Your own findings from the previous iteration — the build above is the attempt to address them. Confirm each one explicitly as resolved or still open; a still-open Critical or Important finding is a FAIL:
{{artifacts.review}}{{/artifacts.review}}
---
{{#acceptance}}Acceptance criteria (VERIFY has already checked these; judge whether the implementation is a good way of meeting them):
{{acceptance.bullets}}{{/acceptance}}
---
{{#git}}Diff boundary: this loop's work is the commits on branch {{git.branch}} since {{git.base}} — review exactly `{{git.diffCmd}}`, nothing outside it.{{/git}}
---
{{#worktree}}{{worktree.instructions}}{{/worktree}}
