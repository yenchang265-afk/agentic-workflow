# Documentation Patterns

The forms documentation takes once it is being written: READMEs, changelogs, inline comments, and API docs. Reached from `documentation-and-adrs`, which owns the decision of *what* deserves recording — above all the ADR, the record of why a choice was made and what was rejected.

Everything here follows the same rule as the skill: document the **why**, because the **what** is already in the code and goes stale the moment it changes.

## Inline Comments

### Document known gotchas

Anchor the warning to the code that carries the trap, and point at the ADR for the reasoning:

```typescript
/**
 * IMPORTANT: This function must be called before the first render.
 * If called after hydration, it causes a flash of unstyled content
 * because the theme context isn't available during SSR.
 *
 * See ADR-003 for the full design rationale.
 */
export function initializeTheme(theme: Theme): void {
  // ...
}
```

### What not to leave behind

```typescript
// Self-explanatory code needs no comment
function calculateTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

// TODO: add error handling   ← add it now instead
// const oldImplementation = () => { ... }   ← delete it; git has history
```

## API Documentation

### Inline with types (preferred for TypeScript)

The types carry the shape, so the prose carries only what the types cannot: what the parameters mean, what is thrown, and a call that works.

```typescript
/**
 * Creates a new task.
 *
 * @param input - Task creation data (title required, description optional)
 * @returns The created task with server-generated ID and timestamps
 * @throws {ValidationError} If title is empty or exceeds 200 characters
 * @throws {AuthenticationError} If the user is not authenticated
 *
 * @example
 * const task = await createTask({ title: 'Buy groceries' });
 * console.log(task.id); // "task_abc123"
 */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  // ...
}
```

### OpenAPI / Swagger for REST APIs

```yaml
paths:
  /api/tasks:
    post:
      summary: Create a task
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateTaskInput'
      responses:
        '201':
          description: Task created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Task'
        '422':
          description: Validation error
```

Interface design decisions — error shape, pagination, versioning stance — are made in `api-and-interface-design`, not here.

## README Structure

```markdown
# Project Name

One-paragraph description of what this project does.

## Quick Start
1. Clone the repo
2. Install dependencies: `npm install`
3. Set up environment: `cp .env.example .env`
4. Run the dev server: `npm run dev`

## Commands
| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm test` | Run tests |
| `npm run build` | Production build |
| `npm run lint` | Run linter |

## Architecture
Brief overview of the project structure and key design decisions.
Link to ADRs for details.

## Contributing
How to contribute, coding standards, PR process.
```

Quick Start is the section that gets tested by every new reader, so its commands must be the ones that actually work on a clean checkout.

## Changelog

Grouped by change type, newest first, each entry linking its issue or PR:

```markdown
# Changelog

## [1.2.0] - 2025-01-20
### Added
- Task sharing: users can share tasks with team members (#123)
- Email notifications for task assignments (#124)

### Fixed
- Duplicate tasks appearing when rapidly clicking create button (#125)

### Changed
- Task list now loads 50 items per page (was 20) for better UX (#126)
```

Entries describe the change from the user's side. "Refactored the task service" belongs in git history, not a changelog.

## Verification

After documenting written code:

- [ ] README covers quick start, commands, and architecture overview, and its commands work on a clean checkout
- [ ] Public API functions document parameters, return values, and failure modes
- [ ] Known gotchas are commented at the code that carries them
- [ ] Changelog entries describe user-visible change, each linked to an issue or PR
- [ ] No commented-out code or stale TODOs remain
