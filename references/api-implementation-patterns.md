# API Implementation Patterns

The code that expresses the decisions in `api-and-interface-design`. Reach for this file when writing an interface; the decisions themselves — contract-first, one error strategy, validation placement, additive change — are made in the skill, before any of this.

Examples are TypeScript/REST. The shapes carry over to other stacks; the syntax does not.

## REST Resource Design

Plural nouns, no verbs. Sub-resources hang off the parent's id:

```
GET    /api/tasks              → List tasks (query params filter)
POST   /api/tasks              → Create a task
GET    /api/tasks/:id          → Get a single task
PATCH  /api/tasks/:id          → Update a task (partial)
DELETE /api/tasks/:id          → Delete a task

GET    /api/tasks/:id/comments → List comments for a task
POST   /api/tasks/:id/comments → Add a comment to a task
```

## Pagination

Every list endpoint paginates. Unbounded list endpoints fail in production the first time a caller has a lot of data, and adding pagination later is a breaking change.

```typescript
// Request
GET /api/tasks?page=1&pageSize=20&sortBy=createdAt&sortOrder=desc

// Response
{
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 142,
    "totalPages": 8
  }
}
```

## Filtering

Query parameters, one per filterable field:

```
GET /api/tasks?status=in_progress&assignee=user123&createdAfter=2025-01-01
```

## Partial Updates (PATCH)

PATCH accepts a partial object and changes only what is provided. PUT requires the caller to send the full object every time, which turns every client-side field addition into a race:

```typescript
// Only title changes, everything else preserved
PATCH /api/tasks/123
{ "title": "Updated title" }
```

## Validated Route Handler

Validation sits at the boundary; past it, the handler trusts its types:

```typescript
app.post('/api/tasks', async (req, res) => {
  const result = CreateTaskSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid task data',
        details: result.error.flatten(),
      },
    });
  }

  // After validation, internal code trusts the types
  const task = await taskService.create(result.data);
  return res.status(201).json(task);
});
```

## Discriminated Unions for Variants

Each variant carries exactly the fields it has, so the consumer gets narrowing instead of a bag of optionals:

```typescript
type TaskStatus =
  | { type: 'pending' }
  | { type: 'in_progress'; assignee: string; startedAt: Date }
  | { type: 'completed'; completedAt: Date; completedBy: string }
  | { type: 'cancelled'; reason: string; cancelledAt: Date };

function getStatusLabel(status: TaskStatus): string {
  switch (status.type) {
    case 'pending': return 'Pending';
    case 'in_progress': return `In progress (${status.assignee})`;
    case 'completed': return `Done on ${status.completedAt}`;
    case 'cancelled': return `Cancelled: ${status.reason}`;
  }
}
```

## Input/Output Separation

The caller's type and the system's type are different types. Merging them forces server-generated fields to be optional on input and nullable on output:

```typescript
// Input: what the caller provides
interface CreateTaskInput {
  title: string;
  description?: string;
}

// Output: what the system returns (includes server-generated fields)
interface Task {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}
```

## Branded Types for IDs

Two ids that are both `string` are interchangeable to the compiler. Branding makes them distinct:

```typescript
type TaskId = string & { readonly __brand: 'TaskId' };
type UserId = string & { readonly __brand: 'UserId' };

// Prevents accidentally passing a UserId where a TaskId is expected
function getTask(id: TaskId): Promise<Task> { ... }
```
