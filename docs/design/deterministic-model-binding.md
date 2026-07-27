# Deterministic model binding

How `workflows.<kind>.stageModels` and `agentModels` reach a subagent spawn, and
why none of the three hosts does it with prose any more.

## The defect

Both settings used to be delivered as an **English sentence**. The MCP server put
a `model` field in its stage responses and the surrounding note asked the
orchestrating model to pass it to the spawn tool; `agentModels` was interpolated
into a `UserPromptSubmit` context block (Claude/Qwen) or appended to the rendered
command body (OpenCode).

A prompt is a request, not a binding. It was ignored at least once, silently:
every stage ran the host default while the config said otherwise, and nothing
failed. That is the failure mode the guard test `spawn-model-binding.test.mjs`
was originally written for — and a lint over prose can never do better than
check that the request was *made*.

## Probe results (Claude Code 2.1.220)

Run headlessly with `claude -p … --settings <inline> --permission-mode bypassPermissions`
in a scratch directory.

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does `PreToolUse` fire for the subagent-spawn tool? | **Yes.** `tool_name` is `Agent`. |
| 2 | What does `tool_input` look like? | `description`, `prompt`, `subagent_type`, `run_in_background`. No `model` key by default. The payload also carries `cwd`, `transcript_path`, `session_id` at top level, so a hook never has to guess the directory. |
| 3 | Does `updatedInput` with `model` actually bind it? | **Yes.** Same prompt twice: hook logging only → subagent ran `claude-opus-5` (inherited); hook stamping `model: "haiku"` → subagent ran `claude-haiku-4-5-20251001`. |
| 4 | Is `^(Agent\|Task)$` a working matcher? | Yes. |
| 5 | What values does `model` accept? | **Only `sonnet`, `opus`, `haiku`, `fable`.** See below. |

### Gap 1 — `model` is an alias enum, and a miss is fatal

```
PreToolUse hook for Agent returned updatedInput that failed schema validation:
[{ "code": "invalid_value", "values": ["sonnet","opus","haiku","fable"],
   "path": ["model"], "message": "Invalid option: expected one of \"sonnet\"|\"opus\"|\"haiku\"|\"fable\"" }]
```

A rejected `model` **errors the entire spawn**; it does not degrade to the
default. So `bareModel()` — which yields `claude-sonnet-4-5` — is the wrong
normalization for this channel, and an unmappable value must be left *unstamped*
rather than passed through. `spawnAlias()` (`packages/core/src/config-layers.ts`)
owns the mapping: it matches on model FAMILY as a substring, so it needs no
per-release maintenance, and returns null for anything it does not recognize.

This also means the pre-existing prose was describing a call the tool would have
rejected for any config naming a real model id. It stayed invisible only because
the prose was being ignored.

### Gap 2 — a hook cannot read the manifests

`packages/core/src/manifest/dir.ts` resolves the workflows directory from
`import.meta.url`, and `scripts/build-hooks.mjs` **inlines core into each hook
bundle** — so inside a bundled hook that walk lands on the hook's own directory.
Manifest loading from a hook is broken by construction.

Hence the split: anything manifest-derived is resolved **server-side** and parked
on the stage marker (the same reason the marker already carries `bashAllowlist`),
while `agentModels` — a flat top-level map — is read directly from the config
layers.

### Gap 3 — `workflow_advance` writes no marker

`workflow_advance`'s fire branch returns the **next** stage's payload and
deliberately defers the marker write to `workflow_stage`. A marker field holding
only the *current* stage's model would therefore be stale for exactly the spawn
that follows an advance: after a VERIFY FAIL re-fires BUILD, the marker still
says `verify`, so an agent-gated lookup would decline and the re-built BUILD
would run the host default — bound on iteration 1, unbound from iteration 2.

The marker therefore carries `stageAgentModels`, an **agent → model map for the
whole kind**. Staleness stops mattering: any spawn of `workflow-build` during the
loop gets BUILD's model. Cross-kind ambiguity (`workflow-verify` backs a stage in
four kinds) cannot arise, because a marker belongs to one loop of one kind.

## The mechanism, per host

| Host | Binding | Latency of a config change |
| --- | --- | --- |
| Claude Code | `PreToolUse` hook rewrites the spawn call's `model` (`hooks/src/stamp-spawn-model.entry.mjs`) | next spawn |
| OpenCode | plugin `config` hook sets `agent.<name>.model` | next opencode restart |
| Qwen Code | `model:` baked into the installed agent file (`scripts/qwen-agents.mjs`) | next `./install.sh qwen` |

Stage fires on OpenCode were already deterministic and are untouched — the driver
passes `model` to `client.session.command`.

### Why the Claude stamp is a separate hook

It is not folded into `check-stage-guard`, for three reasons in descending
weight:

1. **Opposite failure policies.** The guard fails **closed** on an unrecognized
   host, because guessing a dialect disarms every security rule it enforces. The
   stamp fails **open** everywhere: refusing every subagent spawn in a session
   over a typo'd env var is far worse than running the default model.
2. **Blast radius.** Folding in would widen the guard's matcher to the spawn
   tool, running the ADO backstop, the bash allowlist, the worktree pin and the
   backlog classifier against a `tool_input` shape none of them was written for.
3. **No dual-`updatedInput` case.** The guard's matcher is
   `Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*`; no alternative is a
   substring of `Agent` or `Task`, so the two groups are provably
   non-overlapping and no call is ever seen by both.

The wire envelope itself is shared (`hooks/src/pretooluse.mjs`) so the two cannot
drift — in particular, neither ever emits `permissionDecision`, which would
auto-approve a call that would otherwise have been prompted for.

## Why some prose survives

The fire payload's `model` field and the `spawnModelNote` clause are **kept and
made declarative** ("its `model` is already pinned…") rather than deleted.

They are no longer instructions, so they cannot be disobeyed — but they are the
only observability the binding has. If the hook ever stops firing (a marker write
that failed, another spawn-tool rename — `Task` → `Agent` already happened once
inside one minor series), the transcript shows a stated model that does not match
the model the subagent actually ran on. Delete them and that regression is
invisible again, which is precisely the condition that let the original one go
unnoticed.

The prose that was genuinely an *instruction* is gone: `verb-slice.mjs`'s model
line and `adhocAgentContext`, plus the `isAdhocPlan` matcher that existed only to
find the one command with no MCP response to carry a model. The stamp keys off
`subagent_type`, so one rule now covers `/plan`, `new`, `retask` and any nested
spawn with no prompt sniffing at all.

## Smoke test

Machine-readable, and **not** the model's self-report. Note the parent transcript
records the *pre-hook* `tool_use` input and contains no subagent turns — read the
subagent's own file:

```bash
grep -o '"model":"[^"]*"' ~/.claude/projects/<slug>/<session-id>/subagents/agent-*.jsonl | sort -u
```

1. Scratch repo with `{"agentModels": {"workflow-plan": "haiku"}}` → run
   `/agentic-workflow:plan add a cache` → the grep prints only `claude-haiku-4-5-*`.
2. Remove the key → it prints the session default.
3. Set `{"workflows":{"engineering":{"stageModels":{"build":"haiku"}}}}`, drive a
   task through `approve` → `claim` → BUILD → the BUILD subagent shows haiku.
4. **Force a VERIFY FAIL so `workflow_advance` re-fires BUILD**, and check the
   second BUILD subagent. This is the Gap 3 case; a current-stage marker field
   fails here.

OpenCode: same config with a provider-qualified id, run `/agentic-workflow:plan`,
confirm the subtask's model; then set a different `stageModels.plan` and confirm a
real claim's PLAN stage still uses *that* — the assertion that the `config` hook
does not fight `session.command({ model })`.

## Status

The Claude Code path is verified end to end (probe 3 above). **The OpenCode
`config` hook has not been run against a live opencode** — `Hooks.config` is
typed to mutate in place and returns void, so mutation is the only channel it
offers, but "the only channel" is not the same claim as "a working channel".
Until someone runs the OpenCode smoke test, `draftModelNote` is deliberately left
in place there as a fallback for the `new`/`retask` drafting spawn; it costs a
sentence and is harmless once the hook is confirmed. Remove it then.
