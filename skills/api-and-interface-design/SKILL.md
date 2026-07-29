---
name: api-and-interface-design
description: Decides the shape of an interface before it is written — contract, errors, validation placement, and what stays unobservable. Use when designing an endpoint, module boundary, or type contract, or changing any public surface.
---

# API and Interface Design

Make the right thing easy and the wrong thing hard, across REST endpoints,
GraphQL schemas, module boundaries, component props — anywhere one piece of
code talks to another.

Interface design is **decided before it is written**. This file holds the
decisions a plan has to settle; the code that expresses them — resource URLs,
pagination and filtering shapes, PATCH semantics, validated route handlers,
discriminated unions, input/output type separation, branded IDs — is in
`references/api-implementation-patterns.md`. Reach for that when writing the
interface, not when deciding it.

## Hyrum's Law

> With a sufficient number of users of an API, all observable behaviors of your
> system will be depended on by somebody, regardless of what you promise in the
> contract.

Undocumented quirks, error message text, timing, and ordering all become de
facto contract once anyone depends on them. So:

- **Expose deliberately.** Every observable behavior is a commitment you did
  not necessarily mean to make.
- **Keep implementation details unobservable.** What users can see, they will
  depend on.
- **Contract tests are not enough.** They pin the promised contract; Hyrum's
  Law is about the unpromised one, which is why a "safe" change still breaks
  real users.
- **Plan removal at design time** — `deprecation-and-migration`.

## The One-Version Rule

A consumer should never have to choose between versions of the same dependency
or API. Different consumers needing different versions is the diamond
dependency problem, and it multiplies maintenance for as long as both live.
Design for one version existing at a time: extend rather than fork.

## Contract first

Define the interface before implementing it — the contract is the spec, and the
comment on each operation states what the caller may rely on, which is the
expensive-to-change part:

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

A list operation without pagination in its contract is unbounded work by
design — `performance-optimization`.

## One error strategy, everywhere

Pick one and apply it to the whole surface. When some operations throw, some
return null, and some return `{ error }`, every consumer ends up handling all
three, forever.

```typescript
interface APIError {
  error: {
    code: string;        // machine-readable: "VALIDATION_ERROR"
    message: string;     // human-readable: "Email is required"
    details?: unknown;
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
| 500 | Server error — message stays generic |

## Validate at boundaries

Validation is a **placement** decision: it goes where untrusted data enters,
and nowhere past that line, where internal code trusts its types.

**Here:** route handlers and form submission (user input); parsing external
service responses (third-party data is **always** untrusted —
`references/untrusted-data.md`); loading environment variables.

**Not here:** between internal functions sharing a type contract; in utilities
called by already-validated code; on data from your own database.

Validation scattered past the boundary is not defense in depth — it is the same
check written many times, each of which can drift.

## Prefer addition over modification

New fields are optional; existing fields keep their type and their presence:

```typescript
interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';  // added later, optional
  labels?: string[];                      // added later, optional
}
```

Removing a field or changing its type breaks every consumer that reads it. That
is a deprecation, not an edit — route it through `deprecation-and-migration`.

## Predictable naming

| Pattern | Convention | Example |
|---|---|---|
| REST endpoints | plural nouns, no verbs | `GET /api/tasks`, `POST /api/tasks` |
| Query params | camelCase | `?sortBy=createdAt&pageSize=20` |
| Response fields | camelCase | `{ createdAt, updatedAt, taskId }` |
| Boolean fields | is/has/can prefix | `isComplete`, `hasAttachments` |
| Enum values | UPPER_SNAKE | `"IN_PROGRESS"`, `"COMPLETED"` |

Consistency is the whole value: one endpoint following a different convention
costs every consumer a lookup.

## Verification

**When the interface has been designed** (before it is written):

- [ ] The contract names every operation, its input, its output, and its
      failure mode
- [ ] One error strategy is named and covers the whole surface, in one shape
- [ ] Each validation point sits at a boundary where untrusted data enters
- [ ] Every change to an existing interface is additive, or goes through
      `deprecation-and-migration`
- [ ] Naming follows the conventions above across the whole surface, verbs
      included out of REST URLs
- [ ] No operation returns a different shape depending on conditions

**When the interface has been written:**

- [ ] Input and output types exist per operation and are enforced at runtime at
      the boundary
- [ ] Every list operation paginates
- [ ] Third-party responses are validated before use
- [ ] Types or API documentation ship in the same change as the implementation
