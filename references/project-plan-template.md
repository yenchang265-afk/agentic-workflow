# Project Plan Template

The write-up form for a decomposition that spans multiple phases, or where some tasks can run concurrently. Reached from `planning-and-task-breakdown` → branch A, which owns the mechanics (dependency graph, vertical slicing, sizing, checkpoints); this file is only the document those mechanics get written into.

A single-task plan does not use this template — that is `planning-and-task-breakdown` → branch B.

## Template

```markdown
# Implementation Plan: [Feature/Project Name]

## Overview
[One paragraph summary of what we're building]

## Architecture Decisions
- [Key decision 1 and rationale]
- [Key decision 2 and rationale]

## Task List

### Phase 1: Foundation
- [ ] Task 1: ...
- [ ] Task 2: ...

### Checkpoint: Foundation
- [ ] Tests pass, builds clean

### Phase 2: Core Features
- [ ] Task 3: ...
- [ ] Task 4: ...

### Checkpoint: Core Features
- [ ] End-to-end flow works

### Phase 3: Polish
- [ ] Task 5: ...
- [ ] Task 6: ...

### Checkpoint: Complete
- [ ] All acceptance criteria met
- [ ] Ready for review

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| [Risk] | [High/Med/Low] | [Strategy] |

## Open Questions
- [Question needing human input]
```

Each task in the list expands to the full task structure from `planning-and-task-breakdown` → "Write each task". Architecture decisions worth preserving beyond the plan belong in an ADR — see `documentation-and-adrs`.

## Parallelization

When multiple agents or sessions are available, sort the tasks three ways:

| Category | What qualifies | How to plan it |
|---|---|---|
| **Safe to parallelize** | Independent feature slices, tests for already-implemented features, documentation | Assign freely; no ordering constraint |
| **Must be sequential** | Database migrations, shared state changes, anything on a dependency chain | Keep in the graph order; one at a time |
| **Needs coordination** | Features sharing an API contract | Define the contract as its own earlier task, then parallelize the consumers |

The third category is the one that gets missed: two agents building against an undefined shared contract produce two incompatible halves, and the merge costs more than the parallelism saved.

> **In the agentic loop:** parallelism comes from the backlog, not from this section. Sibling drafts are claimed independently, and a worktree branches from `origin/main` — so a child that builds on a sibling's code cannot see it until that sibling ships. Stacked children are gated by the human approving them one at a time. See `task-backlog-management` → "Slicing a heavy idea".
