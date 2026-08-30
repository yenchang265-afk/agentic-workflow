# Simplification Signals

The scan list for `code-simplification` → Step 2. Each entry is a concrete
signal and the change it calls for — something you can find by looking, not a
smell you have to feel.

## Structure

- **Nesting past three levels** — invert into guard clauses, or extract the inner block.
- **A function past ~50 lines** — it has more than one responsibility; split it along them.
- **A nested ternary** — an if/else chain, a switch, or a lookup object.
- **Boolean parameters** — `doThing(true, false, true)` becomes an options object, or separate functions named for what they do.
- **The same condition repeated** — extract it into a named predicate, so the concept has one home.

## Naming

- **Generic names** — `data`, `result`, `temp`, `val`, `item` name nothing; say what they hold.
- **Abbreviations** — `usr`, `cfg`, `evt`. Spell them out unless the short form is universal (`id`, `url`, `api`).
- **A name that lies** — a `get*` that mutates. Rename to the behavior, then consider whether the behavior is right.
- **A comment restating the code** — delete it. A comment carrying *why* — a flaky API, a platform quirk — stays, and is the one kind worth adding.

## Redundancy

- **Duplicated logic** — the same handful of lines in several places, once the third copy appears.
- **Dead code** — unreachable branches, unused variables, commented-out blocks. Confirm it is dead, then remove it; the history keeps it.
- **A wrapper that adds nothing** — inline it and call through.
- **An abstraction with one implementation** — a factory for one product, a strategy with one strategy. Replace it with the direct call until a second case exists.
- **Assertions the compiler did not need** — a cast to a type already inferred.

Over-simplification is the mirror failure, and `code-simplification` → Step 4
judges for it: an inlined helper that was naming a concept, two simple functions
merged into one complex one, an abstraction that was earning its keep.
