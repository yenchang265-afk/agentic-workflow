# The bash allowlist and config authority

Which commands a stage can run, how the two matchers differ, and which
configuration layer may widen any of it. A mismatch here does not error — the
stage starves behind one warning line.

Part of the engineering invariants indexed in [`AGENTS.md`](../../AGENTS.md)
— that index carries each rule in one line; this file carries the reasoning
behind it, which is what stops a future change from "fixing" the rule back.

## The two hosts match a bash command differently

The Claude Code / Qwen guard splits a command on `&&`/`|`/`;` and matches each
segment (`commandAllowed`), accepting a bare `cd` as its own segment. **OpenCode
matches the WHOLE command string** against the agent frontmatter's
`permission.bash` globs. So one allowlist has to satisfy both, and only OpenCode
needs the `cd * && <glob>` twins — `gen-prompts.mjs` (`allowlistFor`) derives one
per glob for every worktree-isolated stage. Declare **bare forms only** in
`workflows/<kind>/workflow.json`; a hand-written `cd * && ` prefix there fails
`scripts/workflow-allowlist.test.mjs`. Deriving beats hand-listing because a
missing twin is invisible until a stage runs: REVIEW, whose allowlist is
*entirely* inspection commands, once had none at all, so on OpenCode every
command it ran hit the `"*": deny` sentinel and the starved stage ERRORed instead
of recording a verdict.

The prompt half matters as much as the data half. `worktree.instructions` must
stay shaped per command-kind — inspection through `git -C <wt>` and absolute
paths, runners through the `cd <wt> && ` prefix — because a blanket "prefix every
shell command" order there is a blanket denial here.

A glob is **position-anchored**, so declare it in the shape the tool is actually
invoked with, not the shape its docs list first. `mvn test*` matches a bare
`mvn test` and nothing else: Maven and Gradle take global options (`-B`,
`-pl core -am`, `--no-daemon`) and preceding phases (`clean`) BEFORE the goal, and
Gradle qualifies tasks by module (`:core:test`), so `mvn clean test` and
`./gradlew :core:test` fall to the deny sentinel and VERIFY ERRORs on a runner the
project has. Hence the second form per goal (`mvn * test*`, `gradle *:test*`).
That widens nothing: every glob ends in `*` compiled with dotAll, so a trailing
second goal always matched — the goal names are a scope boundary against a
confused agent (T2), never a sandbox.

The JS package managers are the same trap one ecosystem over, and `npm test*`
looks like proof they are covered. The WORKSPACE selector precedes the script
(`npm -w apps/web test`, `pnpm -r test`, `pnpm --filter web test`,
`yarn workspace web test`), and berry moves the subcommand outright
(`yarn workspaces foreach run test`), so on a monorepo every CI command falls to
the deny sentinel — which matters more now that VERIFY's checks are DISCOVERED:
the plan names the right command, admission refuses it, and the stage runs no
checks at all behind one warning line. The flags are ENUMERATED (`npm -w *`,
`pnpm --filter*`) rather than tolerated generically, and that is load-bearing:
`npm -* test*` would also match `npm --tag test publish`, because the glob only
needs a literal " test" somewhere after the flag. Maven survives `mvn * test*`
only because `-Dtest=Foo` never produces a space-delimited " test". When adding a
runner, check where its argv puts the subcommand before copying the `npm test*`
shape.

A command-REWRITING plugin is the same starvation with no manifest fix: an
rtk-style token proxy mutates the command in `tool.execute.before` BEFORE
OpenCode evaluates permissions, so every allowlisted command reaches the matcher
as `rtk <cmd>` — a shape no shipped glob matches — and the whole stage starves.
The remedy is config, never the proxy: `bashAllowlistPrefix` derives a
`<prefix> <glob>` twin of everything the stage ALREADY grants
(`withCommandPrefixes`), and those — like `bashAllowlistExtra` globs — are
appended AFTER the sentinel by the plugin's `config` hook, the only position that
wins under OpenCode's **last-match-wins** evaluation. That is also why the
generated maps' `"*": deny`-first ordering is semantic rather than stylistic
(`workflow-allowlist.test.mjs` pins it; a trailing `"*": deny` would remove the
bash tool from the agent outright). Diagnostic to know: OpenCode's DeniedError
dumps EVERY bash rule, pattern-unfiltered, so a stage transcript claiming "the
deny-all rule wins over the specific allows" means "no glob matched the final
command string" — check for a rewritten prefix first.

Derived rather than blanket, because a blanket `"rtk *"` accepts `rtk npm
publish` as readily as `rtk npm test` — and because **the same rewrite blinds
every write backstop**: `isGitPushViolation`, `isGithubPrMutation` and
`isFindMutation` all anchor on the BARE tool name, so `rtk git push --force
origin main` reads as no violation on either host. Narrowing the allowlist cannot
fix that half — `rtk git push origin main` matches a derived
`rtk git push origin *` glob quite legitimately, and only the classifier knows
`main` is protected — so each segment is classified raw AND with one prefix hop
stripped (`stripCommandPrefix`, twinned into `hooks/src/allowlist.mjs`). One hop
only, or `rtk rtk …` launders a second. The prefixes ride the Claude/Qwen stage
marker as `bashPrefix` for the same reason `kindAgents` does — a bundled hook
reads neither config nor manifest — and an absent field means no strip, i.e.
exactly the old behaviour. A rewrite that renames the verb (`cat x` →
`rtk read x`) is beyond any derivation and stays an extras job.

## The repo layer may not decide what runs — including indirectly

`.agentic-workflow.json` ships with any cloned repo, so `droppedRepoKeys` keeps
the keys that name shell (`worktreeSetup`, `notifyCommand`,
`workflows.<kind>.{scannerCommand,stageChecks}`) and the ADO destination out of
the repo layer. The rule the list keeps failing is that it is not about SHELL —
it is about AUTHORITY over what executes, and the boundary a repo must not touch
is the bash allowlist itself. `bashAllowlistExtra` sat outside the drop set for
exactly that reason and was two executions at once: `stageBashGlobs` stamps it
onto the Claude stage marker and (through OpenCode's `config` hook) appends it
AFTER the `"*": deny` sentinel, where last-match-wins makes `["*"]` an
unrestricted stage shell; and the same composed list is `admissibleChecks`'
gate, the ONLY cap on the driver-run commands a plan's `agentic-checks` fence
names — and a plan document is repo content too.

So when adding a top-level config key, ask what it AUTHORISES, not whether its
value is a command: a key that widens an allowlist, names a tool, or picks the
directory a write lands in belongs in `ALLOWLIST_WIDENING_KEYS` (or its own
sibling list) with a warning of its own. `Config` in `state.ts` declares neither
allowlist key structurally — they are read through `bashAllowlistExtras` /
`bashAllowlistPrefixes` off an `unknown` — which is part of why they were easy
to miss; a new key read that way needs its drop decision made deliberately.
