---
name: source-driven-development
description: Grounds framework-specific code in the current version's official docs, with citations the user can check. Use when writing or reviewing code whose correctness depends on a library's actual API.
---

# Source-Driven Development

Training data goes stale silently. A deprecated pattern still reads as
plausible, still compiles in some versions, and still gets copied into ten
files before anyone finds out. So framework-specific code is not written from
memory: it is written from the docs for the **version this project actually
has**, and every non-obvious decision carries the URL that backs it.

Apply it whenever the framework's own recommended approach matters — forms,
routing, data fetching, state, auth — or when reviewing code that already uses
such a pattern. Skip it where the version cannot change the answer: renames,
typo fixes, file moves, and pure logic that behaves identically everywhere.

```
DETECT ──→ FETCH ──→ IMPLEMENT ──→ CITE
```

## 1. Detect the versions

Read the project's dependency file — `package.json`, `composer.json`,
`requirements.txt` / `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile` — and
state what you found:

```
STACK: React 19.1.0, Vite 6.2.0, Tailwind 4.0.3 (package.json)
→ fetching the docs for those versions
```

**Done when** every library the change touches has a version behind it. Where
the version is missing or ambiguous, ask — it decides which pattern is correct,
so guessing it invalidates everything downstream.

## 2. Fetch the page, not the site

Fetch the specific page for the feature being implemented:
`react.dev/reference/react/useActionState`, not the React homepage;
`docs.djangoproject.com/en/6.0/topics/auth/`, not a search for "django
authentication best practices".

Authority runs in this order: official documentation, then official blog and
changelog, then web standards references (MDN, web.dev, the specs), then
compatibility data (caniuse, node.green).

**Nothing else is a primary source** — not Stack Overflow, not tutorials however
popular, not AI-generated summaries, and above all not your own recollection,
which is the thing this skill exists to check.

Extract the patterns and note every deprecation warning on the page. When two
official sources disagree — a migration guide against an API reference —
surface the discrepancy and establish which one holds for the detected version.

**Done when** the pattern you are about to write appears in a page you fetched.

## 3. Implement what the docs show

Use the signatures on the page, the current pattern where the docs have moved
on, and never a form the docs mark deprecated. Where the docs do not cover what
you need, flag it as unverified rather than filling the gap from memory.

When the docs and the existing codebase disagree, that is the user's decision,
not yours:

```
CONFLICT: the codebase uses useState for form loading state; React 19 docs
recommend useActionState (react.dev/reference/react/useActionState).
A) modern pattern — consistent with current docs
B) match existing code — consistent with the codebase
→ which?
```

**Done when** every framework-specific line traces to something you read.

## 4. Cite

The user must be able to check any decision without taking your word for it.

```typescript
// React 19 form handling with useActionState
// Source: https://react.dev/reference/react/useActionState#usage
const [state, formAction, isPending] = useActionState(submitOrder, initialState);
```

Full URLs, never shortened. Prefer deep links with anchors (`#usage`) — they
survive restructuring better than a top-level page. Quote the passage when it
carries a non-obvious decision, and include support data when recommending a
platform feature.

Where you could not find documentation, say so in those words:

```
UNVERIFIED: no official documentation found for this pattern. Based on
training data; may be outdated. Verify before production use.
```

An honest gap is worth more than a confident citation-free assertion — the
whole value of the skill is that the user can tell which is which.

**Done when** every non-obvious framework decision carries a URL or an
explicit UNVERIFIED flag.

## Verification

- [ ] Versions came from the dependency file, and every library in the change
      has one
- [ ] A specific documentation page was fetched for each framework pattern used
- [ ] Every source is official documentation, standards, or compatibility data
- [ ] No deprecated API is used, checked against the migration guide
- [ ] Every non-obvious decision carries a full URL, with an anchor where one
      exists
- [ ] Conflicts — docs against docs, or docs against the codebase — were
      surfaced to the user rather than resolved silently
- [ ] Anything unverifiable is labelled UNVERIFIED in the output
