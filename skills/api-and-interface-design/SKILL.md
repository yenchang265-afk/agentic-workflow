---
name: api-and-interface-design
description: Designs stable, hard-to-misuse interfaces. Use when designing API endpoints, module boundaries, or type contracts, or changing any public interface.
---

# API and Interface Design

## Overview

Design interfaces that make the right thing easy and the wrong thing hard. This applies to REST APIs, GraphQL schemas, module boundaries, component props, and any surface where one piece of code talks to another.

Interface design is decided before it is written. The decisions below are the ones a plan has to settle; the code that expresses them is in `references/api-implementation-patterns.md`.

## When to Use

- Designing new API endpoints, module boundaries, or contracts between teams
- Creating component prop interfaces
- Establishing a database schema that informs API shape
- Changing an existing public interface

## Core Principles

### Hyrum's Law

> With a sufficient number of users of an API, all observable behaviors of your system will be depended on by somebody, regardless of what you promise in the contract.

Every public behavior — including undocumented quirks, error message text, timing, and ordering — becomes a de facto contract once users depend on it. Design implications:

- **Be intentional about what you expose.** Every observable behavior is a potential commitment.
- **Keep implementation details unobservable.** If users can see it, they will depend on it.
- **Plan for deprecation at design time.** See `deprecation-and-migration` for how to safely remove things users depend on.
- **Contract tests are not enough.** They pin the promised contract; Hyrum's Law is about the unpromised one, so a "safe" change can still break real users.

### The One-Version Rule

Consumers should never have to choose between versions of the same dependency or API. Diamond dependency problems arise when different consumers need different versions of the same thing. Design for a world where only one version exists at a time — extend rather than fork.

### Contract First

Define the interface before implementing it. The contract is the spec — implementation follows. Each method's comment states what the caller can rely on, which is the part Hyrum's Law makes expensive to change later:

```typescript
interface TaskAPI {
  // Creates a task and returns it with server-generated fields
  createTask(input: CreateTaskInput): Promise<Task>;

  // Returns paginated tasks matching filters
  listTasks(params: ListTasksParams): Promise<PaginatedResult<Task>>;

  // Returns a single task or throws NotFoundError
  getTask(id: string): Promise<Task>;

  // Partial update — only provided fields change
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;

  // Idempotent delete — succeeds even if already deleted
  deleteTask(id: string): Promise<void>;
}
```

### One Error Strategy, Everywhere

Pick one and apply it across the whole surface. When some endpoints throw, others return null, and others return `{ error }`, the consumer cannot predict behavior and ends up handling all three.

```typescript
interface APIError {
  error: {
    code: string;        // Machine-readable: "VALIDATION_ERROR"
    message: string;     // Human-readable: "Email is required"
    details?: unknown;   // Additional context when helpful
  };
}
```

| Status | Meaning |
|---|---|
| 400 | Client sent invalid data |
| 401 | Not authenticated |
| 403 | Authenticated but not authorized |
| 404 | Resource not found |
| 409 | Conflict (duplicate, version mismatch) |
| 422 | Validation failed (semantically invalid) |
| 500 | Server error — the message stays generic |

### Validate at Boundaries

Validation is a placement decision: it belongs where untrusted data enters, and nowhere else. Past that line, internal code trusts its types.

**Validate here:**
- API route handlers and form submission handlers (user input)
- External service response parsing (third-party data — **always untrusted**)
- Environment variable loading (configuration)

**Not here:**
- Between internal functions that share type contracts
- In utility functions called by already-validated code
- On data that just came from your own database

> **Third-party API responses are untrusted data.** Validate shape and content before use — see `references/untrusted-data.md`.

### Prefer Addition Over Modification

Extend interfaces without breaking existing consumers: new fields are optional, existing fields keep their type and their presence.

```typescript
interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';  // Added later, optional
  labels?: string[];                      // Added later, optional
}
```

Removing a field or changing its type breaks every consumer that reads it — that is a deprecation, not an edit. Route it through `deprecation-and-migration`.

### Predictable Naming

| Pattern | Convention | Example |
|---------|-----------|---------|
| REST endpoints | Plural nouns, no verbs | `GET /api/tasks`, `POST /api/tasks` |
| Query params | camelCase | `?sortBy=createdAt&pageSize=20` |
| Response fields | camelCase | `{ createdAt, updatedAt, taskId }` |
| Boolean fields | is/has/can prefix | `isComplete`, `hasAttachments` |
| Enum values | UPPER_SNAKE | `"IN_PROGRESS"`, `"COMPLETED"` |

## Implementation Patterns

Resource and sub-resource URL design, pagination and filtering shapes, PATCH semantics, validated route handlers, discriminated unions, input/output type separation, and branded ID types are in `references/api-implementation-patterns.md`. Reach for it when writing the interface, not when deciding it.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Nobody uses that undocumented behavior" | Hyrum's Law: if it's observable, somebody depends on it. Treat every public behavior as a commitment. |
| "We can just maintain two versions" | Multiple versions multiply maintenance cost and create diamond dependency problems. Prefer the One-Version Rule. |

## Red Flags

- Endpoints that return different shapes depending on conditions
- Inconsistent error formats across endpoints
- Breaking changes to existing fields (type changes, removals)
- List endpoints without pagination
- Verbs in REST URLs (`/api/createTask`, `/api/getUsers`)
- Third-party API responses used without validation

## Verification

**When the interface has been designed** (before it is written):

- [ ] The contract names every operation, its input, its output, and its failure mode
- [ ] One error strategy is named and covers every operation on the surface
- [ ] Each validation point is placed at a boundary where untrusted data enters
- [ ] Every change to an existing interface is additive, or is routed through `deprecation-and-migration`
- [ ] Naming follows the conventions above across the whole surface

**When the interface has been written:**

- [ ] Input and output types exist for every operation and are enforced at runtime at the boundary
- [ ] List endpoints support pagination
- [ ] The types or API documentation ship in the same change as the implementation
