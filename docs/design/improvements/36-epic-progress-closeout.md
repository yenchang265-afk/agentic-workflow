English | [繁體中文](36-epic-progress-closeout.zh-TW.md)

# 36 — An epic's progress is reported, and its close-out is offered

**Status: implemented.**

## The problem

A slice set's tracking epic sits in `draft/` un-approved for good, and the
documented way to close it — "abandon it by hand once every child has
shipped" — was surfaced nowhere: `epicSiblings` had exactly one consumer (the
task gate's next-slice walk), `shipTask` never touched epics, and no surface
counted a set's progress. Shipping the last slice looked exactly like
shipping any other task, so trackers accumulated in `draft/` while the human
had to reconstruct "is this set done?" from folder listings.

## What changed

- **`shipTask` reports the set** (`epicShipOutcome`, best-effort like
  `remainingSlices` and for the same reason — it runs after the ship
  committed, so a failed listing costs the tail, never the move). A
  mid-set ship says `Epic <id>: 1/3 slices shipped; still open: b, c`; the
  LAST slice says `all N slices shipped — abandon <id> closes the tracker`.
  Data mirrors it (`epic`, `epicShipped`, `epicTotal`, `epicOpen` /
  `epicDone`), omit-when-absent like every epic key.
- **`summarizeBacklog` gains `epics`** — one `EpicProgress` row per tracking
  draft with live-or-shipped children ({id, shipped, open ids in claim
  order, total}), derived purely from the `epic:` links, never the tracker's
  prose. Trackers whose set was emptied by removes/abandons yield no row.
  The Claude host's `workflow_status` carries it for free (it returns the
  summary whole).
- **`nextActions` names the close-out**: a fully-shipped set renders
  `epic <id>: all N slices shipped — <cmd> abandon <id> closes the tracker`
  on both hosts' status surfaces.

## Sharp edges

- **Abandoned slices shrink the set.** `total` = shipped + open, excluding
  abandoned children: abandoning is the documented way to cut scope, and a
  set whose every LIVE child shipped is done regardless of what was
  cancelled. `ACTIVE_STATUSES` (now exported) is the boundary.
- The close-out suggests `abandon`, the reversible close — never `remove`.
- The already-completed retry arm of `shipTask` adds no tail: a re-publish
  is not a fresh ship, and repeating the suggestion there would fire on
  every retry.
