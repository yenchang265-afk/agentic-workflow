# Accessibility Checklist

The WCAG 2.1 AA bar a UI is audited against, backing `frontend-ui-engineering`.
Semantic elements, `alt` text, and label association are assumed; what follows is
what a review actually catches missing, so work each list to its end.

## Keyboard

- [ ] Focus order matches the visual order, and the focus ring is visible everywhere (styled, never removed)
- [ ] Custom widgets answer Enter and Escape; no component can trap focus
- [ ] A skip-to-content link opens the page, visible at least on focus
- [ ] A dialog moves focus in on open, traps it while open, and returns it to the trigger on close
- [ ] No positive `tabindex` anywhere — `0` and `-1` only

## Screen reader

- [ ] Exactly one `<h1>`, and no skipped heading levels
- [ ] Every control has an accessible name — icon-only buttons carry `aria-label`, and no link reads as "click here"
- [ ] Tables use `<th>` with `scope`
- [ ] Dynamic changes are announced: `aria-live="polite"` (equivalently `role="status"`) for confirmations, `assertive` (equivalently `role="alert"`) reserved for errors and time-critical messages
- [ ] Decorative images are `alt=""` rather than described

## Visual

- [ ] Text contrast ≥ 4.5:1, large text and UI components ≥ 3:1
- [ ] Color never carries meaning alone
- [ ] Layout survives 200% text zoom
- [ ] Nothing flashes more than three times per second
- [ ] Touch targets ≥ 44×44px

## Forms

- [ ] Every input has a *visible* label; required state shown by more than color
- [ ] Each error message is specific and programmatically associated with its field
- [ ] Error state is visible by icon or text as well as border color
- [ ] A submission failure summarises the errors somewhere focusable
- [ ] Known fields carry the right `type` and `autocomplete`

## Page

- [ ] `<html lang>` set and the `<title>` describes the page
- [ ] Links distinguishable from body text without relying on color
- [ ] Empty states render meaning, never a blank region

## Audit

`axe-core` or `pa11y` in CI, the DevTools accessibility tree for names and
roles, and one pass with a real screen reader (VoiceOver, NVDA, or Orca) —
automation catches roughly a third of what the manual pass does.
