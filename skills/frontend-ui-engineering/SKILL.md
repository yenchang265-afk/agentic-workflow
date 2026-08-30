---
name: frontend-ui-engineering
description: Builds production-quality, accessible UIs free of the generic AI aesthetic. Use when creating or modifying user-facing components, layouts, or interactions.
---

# Frontend UI Engineering

Build UI that looks like a design-aware engineer at a top company built it: real
design-system adherence, WCAG 2.1 AA accessibility, every state rendered, and
none of the **AI aesthetic**.

## Avoid the AI aesthetic

Generated UI has a recognizable look. Each row below is a default to override
with the project's own system:

| AI Default | Why It Is a Problem | Production Quality |
|---|---|---|
| Purple/indigo everything | Models default to visually "safe" palettes, making every app look identical | Use the project's actual color palette |
| Excessive gradients | Gradients add visual noise and clash with most design systems | Flat or subtle gradients matching the design system |
| Rounded everything (rounded-2xl) | Maximum rounding signals "friendly" but ignores the hierarchy of corner radii in real designs | Consistent border-radius from the design system |
| Generic hero sections | Template-driven layout with no connection to the actual content or user need | Content-first layouts |
| Lorem ipsum-style copy | Placeholder text hides layout problems that real content reveals (length, wrapping, overflow) | Realistic placeholder content |
| Oversized padding everywhere | Equal generous padding destroys visual hierarchy and wastes screen space | Consistent spacing scale |
| Stock card grids | Uniform grids are a layout shortcut that ignores information priority and scanning patterns | Purpose-driven layouts |
| Shadow-heavy design | Layered shadows add depth that competes with content and slows rendering on low-end devices | Subtle or no shadows unless the design system specifies |

## Design system adherence

**Spacing** — every value comes from the project's scale. `padding: 1rem` and
`gap: 0.75rem` are on a 0.25rem scale; `padding: 13px` and `margin-top: 2.3rem`
are invented. Arbitrary pixel values and inline styles are the tell.

**Typography** — one `h1` per page, then h2 → h3 with no skipped levels. Heading
elements are for headings; body text that should merely *look* large gets a
class, not an `<h2>`.

**Color** — semantic tokens (`text-primary`, `bg-surface`, `border-default`),
never raw hex. Contrast at 4.5:1 for normal text, 3:1 for large text. Color
never carries meaning alone — pair it with an icon, text, or pattern.

## Accessibility (WCAG 2.1 AA)

Copy-ready HTML/ARIA patterns live in `references/accessibility-checklist.md`:

- **Keyboard**: every interactive element is a real `<button>`/`<a>`/input —
  focusable and key-operable for free. A `div` with `onClick` needs `role`,
  `tabIndex`, and both Enter and Space handling; use the element instead.
- **Labels**: a visible `<label htmlFor>` for every form input; `aria-label` on
  icon-only controls.
- **Focus**: when content changes, focus moves with it — a dialog focuses its
  first actionable element on open and traps focus while open.

## Component structure

Colocate a component's implementation, tests, stories, hook, and types in one
directory. Prefer composition (`<Card><CardHeader>…`) over configuration
(`<Card title= headerVariant= bodyPadding=`), keep each component doing one
thing under ~200 lines, and separate data fetching from presentation.

Place state at the lowest level that works: local, then lifted, then URL state
for anything shareable (filters, pagination), then a server-state cache for
remote data, then a global store. Props passed through components that don't use
them past three levels means the tree needs context or restructuring.

## Every state renders something

Loading, empty, and error are not edge cases — they are three of the four states
every data-driven view has (the fourth is the loaded state itself), and a blank
screen is a bug. Use skeletons rather
than spinners for content and mark them `aria-busy`, give every empty state
`role="status"` and the action that resolves it, and give every error state a
retry. Where an interaction updates optimistically, its rollback path is part of
the pattern, not a follow-up.

## Responsive

Design mobile-first: the smallest layout is the base, breakpoints add to it.
Verify at 320px, 768px, 1024px, and 1440px.

Images, fonts, bundles, and the scheduling rules that hold INP and CLS inside
their targets are in `references/performance-checklist.md`.

## Verification

- [ ] Component renders with no console errors
- [ ] Every interactive element is reachable and operable by keyboard alone
      (Tab through the page) and exposes an accessible name in the a11y tree
- [ ] Headings run h1 → h2 → h3 with no skips
- [ ] axe-core and dev-tools accessibility audits report no violations
- [ ] Loading, error, and empty states each render something useful
- [ ] Layout holds at 320px, 768px, 1024px, and 1440px
- [ ] Spacing, color, and typography values all come from the design system —
      no arbitrary pixel values, no raw hex
