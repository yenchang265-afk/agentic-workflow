English | [繁體中文](44-cross-process-status.zh-TW.md)

# 44 — Status sees loops driven by other processes

**Status: implemented.**

## The problem

Both hosts' status answered from their own process alone — OpenCode from
`getWorkflow(sessionID)`, the Claude host from its in-memory `active`. A
watch worker in another terminal driving task X read as "No active loop"
here, inviting a competing `claim X` (or `recover`) that then bounced off
refusals status never foreshadowed — "just claimed by another watcher",
with no way to see where that loop lives. The cross-process oracle already
existed: `taskDrivenByStageMarker`, consulted by `recover` and `doctor`.

## What changed

- **`liveStageMarkers` (core, `stage-marker.ts`)** reports every host's LIVE
  stage marker with the facts a status line needs — task, stage, kind,
  deadline, writer pid — under the EXACT liveness rule
  `taskDrivenByStageMarker` applies (deadline in the future, a carried pid
  must still exist). Both readers now share one internal
  (`liveMarkerFor`), so the two oracles cannot drift.
- **OpenCode's status** appends a `driven elsewhere: <task> @ <stage>
  (<host> pid N, deadline in Mm)` segment to both the idle and the
  live-loop lines.
- **`workflow_status`** gains a `drivenElsewhere` list, each entry ending
  "gate verbs and claim will refuse it while that loop is live" — the
  refusal is foreshadowed where the competing command would be typed.

## Sharp edges

- **Each host filters its own pid.** The driving session's status must not
  report its own loop twice; an older marker with no pid is kept (it cannot
  be proven ours, and both current writers always stamp one).
- **Display-only.** The deadline was always documented as display-only on
  the marker; nothing here gates or sweeps — recover/doctor keep their own
  liveness paths.
- **Best-effort like every marker read**: missing, garbled, expired, or
  dead-writer markers degrade to nothing, never to a throw.
