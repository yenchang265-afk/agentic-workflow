# Documentation Patterns

The forms documentation takes once it is being written — README, changelog,
inline comment, API reference. `documentation-and-adrs` owns the decision of
*what* deserves recording, above all the ADR. The same rule governs every form
here: document the **why**, because the *what* is in the code and goes stale on
the next edit.

## Inline comments

Anchor a gotcha to the line that carries the trap, state the failure it prevents
rather than the rule, and name the ADR when one exists — "must run before first
render; after hydration the theme context is missing under SSR and the page
flashes unstyled (ADR-003)".

Two things never survive a diff: a `TODO` for work you could do now, and
commented-out code. Do the work, or delete the block and let the history keep it.

## API reference

The types already carry the shape, so the prose carries what they cannot: what a
parameter *means*, every failure mode the caller must handle, and one call that
works. A doc comment that renames the parameters in English is noise. Where a
REST surface is specified rather than described, the schema (OpenAPI) is the
artifact and the prose hangs off it — but the shape of that contract is decided
in `api-and-interface-design`, not here.

## README

Quick start, commands, architecture sketch, contributing. Quick start is the one
section every new reader executes, so its commands must be the ones that work on
a clean checkout — stale setup steps are the most expensive documentation bug
there is, because they land on someone with no way to tell what changed.

## Changelog

Newest first, grouped by change type, each entry linked to its issue or PR, and
each written from the user's side. "Refactored the task service" is git history,
not a changelog entry.

## Verification

- [ ] README covers quick start, commands, and architecture, and its commands work on a clean checkout
- [ ] Public API entries document meaning, failure modes, and one working call
- [ ] Known gotchas are commented at the code that carries them
- [ ] Changelog entries describe user-visible change, each linked to an issue or PR
- [ ] No commented-out code or stale TODOs remain
