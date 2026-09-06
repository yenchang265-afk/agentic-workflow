English | [繁體中文](66-installer-next-steps.zh-TW.md)

# 66 — The installer's last line is the first command to type

**Status: implemented.**

## The problem

A successful install ended on the user-scope config-key catalogue, and the
one "then run" line anywhere (the standalone Claude installer) named `new
<idea>` — the second verb. `init`, which scaffolds `docs/tasks/` and a safe
config, was never named; the OpenCode half stated availability, the Qwen
half sent the human to `status`, which prints an empty roll-up on a fresh
repo; `bootstrap.sh`, the top-level entry point, ended on "Done".

## What changed

- **`next_steps` / `Write-NextSteps`** in `install.sh` and `install.ps1`,
  called last for every plugin target: per host, how to load the plugin,
  then `init`, then `new <idea>`; plus the hub command. The per-host
  installers keep their "installed" line and drop their own advice.
- **The standalone Claude installer and `bootstrap.sh`** close on the same
  two commands, `init` first.
- **`scripts/install-next-steps.test.mjs`** greps the sources (the style of
  `bootstrap-ado.test.mjs`): both installers end on the block, every host is
  named, `init` precedes `new`, and no installer sends the human to `status`
  first.

## Sharp edges

- **Source-grep, not execution.** The installers write to the user's home;
  a test that ran them would be a test that changed the machine.
