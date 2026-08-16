English | [繁體中文](31-terminal-notifications.zh-TW.md)

# 31 — Terminal events can push a notification

**Status: implemented.**

## The problem

The gates go quiet when nobody is watching the terminal. A plan parks as a
toast and scrollback; a `watch` worker accumulates finished runs in
`in-review/` silently; a stopped loop waits on a human who has no idea it
stopped. The hub shows all of it — but only while it is open. Every "the
loop finished an hour ago and I only just noticed" is a latency cost the
whole pipeline pays.

## What changed

- **`notifyCommand`** (user-scope config): a shell command fired after a
  terminal loop event, run as `sh -c <command>` under `env` with
  `AW_EVENT` (`park` | `done` | `stop` | `error`), `AW_KIND`, `AW_TASK`,
  and a one-line `AW_MESSAGE` — enough for a `notify-send`, an
  `osascript`, or a `curl` to a chat webhook. Every value reaches the
  command as an escaped interpolation, so nothing from a task title or
  terminal message can become shell syntax.
- **One choke point**: `notifyTerminal` wraps core's `runTerminal`, which
  every host and every kind already routes its terminals through — so
  OpenCode drives, watch workers, and the Claude/Qwen `workflow_advance`
  terminals all announce without per-host wiring. It runs AFTER the
  terminal's own bookkeeping, is bounded at 10s (`NOTIFY_TIMEOUT_MS`,
  abandoned with a warning — the loop will not wait on a webhook), and
  every failure degrades to a `warn` log. `park-free` fires nothing: a
  task-less free-text plan has no gate to announce.
- **`notifyEvents`** filters the set (absent = all four). It is not
  shell-bearing — four literals — so a repo may narrow, never widen, what
  its contributors get pinged about.
- **`notifyCommand` is SHELL-BEARING**: added to `SHELL_BEARING_KEYS`, so
  the repo layer drops it with the existing per-key warning — a cloned
  repo must not be able to run arbitrary shell on the first park. Both
  strip sites (loadConfig and the raw-layer reader) iterate the shared
  list, so the new key was covered by construction.

## Sharp edges

- A ship's publish step does not notify — the ship gate is crossed by a
  human who is present by definition. The away-events are park, done,
  stop, and error, and those are exactly the `TerminalReport` kinds.
- The 10s abandonment leaves the spawned command running detached; that is
  the documented trade for never stalling a terminal on a notifier.
- `sh -c` assumes a POSIX shell on PATH — true on Linux/WSL/macOS, the
  supported hosts.
