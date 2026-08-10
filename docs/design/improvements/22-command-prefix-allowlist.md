English | [繁體中文](22-command-prefix-allowlist.zh-TW.md)

# 22 — A proxy prefix re-expresses the allowlist instead of replacing it

**Status: implemented.** `bashAllowlistPrefixes` / `withCommandPrefixes` /
`stripCommandPrefix` in `packages/core/src/config-layers.ts`,
`bashAllowlistPrefix` on the config schema in `packages/core/src/config.ts`,
prefix-aware `chained*` backstops in `packages/core/src/task/write-backstop.ts`
(twinned into `plugins/claude/hooks/src/allowlist.mjs`),
`applyBashAllowlistConfig` in `plugins/opencode/src/impl.ts`, the marker's
`bashPrefix` field in `plugins/claude/mcp-server/src/server.ts` consumed by
`plugins/claude/hooks/src/check-stage-guard.entry.mjs`, admission in
`packages/core/src/workflow/discovered-checks.ts`; `config-layers.test.ts`,
`write-backstop.test.ts`, `discovered-checks.test.ts`, `impl.test.ts`,
`server.test.ts`, `check-stage-guard.test.mjs`, and the end-to-end
`plugins/claude/hooks/allowlist-prefix.test.mjs`.

## Context

A command-rewriting proxy (an rtk-style token saver) mutates every bash command
before either host evaluates permissions, so an allowlisted `git status*`
reaches the matcher as `rtk git status` and the stage starves on the `"*": deny`
sentinel. The shipped remedy was one `bashAllowlistExtra` glob, `"rtk *"` — and
that glob accepts `rtk npm publish` and `rtk gh pr merge` exactly as readily as
`rtk npm test`. Restoring the stage meant deleting its boundary.

The boundary is derivable instead. Every stage already declares what it may run;
a prefix only needs to re-express that same list one shape over. `npm test*`
also grants `rtk npm test`, and grants nothing else — no command becomes
reachable that the stage could not already run.

**And the same rewrite silently disables the write backstops.** This was found
while mapping the change and is the reason it is not allowlist-only.
`isGitPushViolation`, `isGithubPrMutation` and `isFindMutation` all anchor on
the BARE tool name, so under any proxy they classify nothing. Verified against
rtk 0.42.3:

| command | rewritten to | classifier verdict |
| --- | --- | --- |
| `git push --force origin main` | `rtk git push --force origin main` | no violation |
| `gh pr merge 3` | `rtk gh pr merge 3` | no violation |
| `find . -delete` | `rtk find . -delete` | not a mutation |

Narrowing the allowlist cannot cover for that half: with the prefix configured,
`rtk git push origin main` matches the derived `rtk git push origin *` glob
quite legitimately, and only `isGitPushViolation` knows `main` is protected. So
T8 ("never merge, never push the watched or default branch") was bypassable for
anyone who had followed the documented rtk advice.

## What changed

- **`bashAllowlistPrefix`** (top-level config, array of bare command heads).
  `withCommandPrefixes` emits `<prefix> <glob>` for every glob a stage grants,
  skipping a glob that already carries a prefix (else a user's own `"rtk *"`
  extra derives `rtk rtk *`) and skipping `cd * && ` twins as sources — the
  chained shape comes from running `withCdTwins` over the RESULT, because the
  proxies rewrite per chain segment (`cd <wt> && git status` →
  `cd <wt> && rtk git status`).
- **OpenCode** derives from the merged config's own permission map:
  `applyBashAllowlistConfig` reads each sentinel-guarded agent's `allow` keys as
  the source list, so per-stage precision needs no manifest read at bootstrap
  and a user-added kind's agent is covered too. Appended after the sentinel,
  where last-match-wins makes a rule mean anything.
- **Claude Code / Qwen** stamp the prefixed list into the stage marker's
  `bashAllowlist` (no `cd * && ` twins — that guard matches per segment), plus
  the prefixes themselves as **`bashPrefix`**. A bundled hook can read neither
  config nor manifest, the same constraint `kindAgents` lives under. An absent
  field means no strip, i.e. exactly the previous behaviour.
- **The backstops classify each segment twice** — as written, and with one
  prefix hop removed (`stripCommandPrefix`). One hop only: a loop would let
  `rtk rtk …` launder a second layer past a classifier the first already
  defeated. Nothing that tripped before stops tripping, and unset prefixes
  reduce the whole thing to the old code path. On OpenCode this has a second
  effect: the backstops no longer depend on whether the proxy's plugin ran
  before or after ours in `tool.execute.before`.
- **Discovered checks** admit the prefixed form too, so under a proxy a plan
  naming `rtk npm test` is not refused while `rtk npm publish` still is.

## Boundaries kept

- Prefixes are validated as bare command heads — no `*`, no shell
  metacharacters. A `*` would derive `rtk * npm test*`, re-admitting the
  arbitrary middle the derivation exists to remove. Invalid entries are dropped
  individually: a dropped prefix starves a stage visibly, an admitted junk one
  widens the boundary silently.
- Nothing is granted that the stage's own allowlist did not already grant, so
  unlike `bashAllowlistExtra` this key does not widen the T2 boundary at all.
  For the same reason it is NOT a `SHELL_BEARING_KEYS` entry: like
  `bashAllowlistExtra`, and unlike `worktreeSetup`, its value is never executed
  — it can only re-express globs the manifest already ships, and the glob it
  composes stays position-anchored (`env` as a prefix yields `env npm test*`,
  which matches nothing a bare `npm test*` did not).
- The strip takes the LONGEST matching prefix. With the ordinary overlapping
  pair `["rtk", "rtk proxy"]`, taking the shorter one off
  `rtk proxy git push origin main` leaves `proxy git push …` — unrecognizable
  to every classifier, while the derived `rtk proxy git push origin *` glob
  admits it. That is the laundering the strip exists to stop, so it is pinned
  by vectors in both twins' suites.

## Residual

A rewrite that RENAMES the verb is beyond any derivation: rtk 0.42.3 turns
`cat x` into `rtk read x`, `head -20 x` into `rtk read x --max-lines 20`,
`npx tsc` into `rtk tsc`, `npx eslint .` into `rtk lint .`, `./gradlew build`
into `rtk gradlew build`, `bundle exec rspec` into `rtk rspec`. Those stay an
extras job, documented as a copy-paste block in
[`../../configuration.md`](../../configuration.md) with the caveat that the list
is versioned with the proxy, not with this project. No rename table is baked
into core for that reason — it would rot with each proxy release, and it is
provider-specific policy in a provider-neutral engine.

Measured against the real generated `workflow-verify` frontmatter and real
`rtk rewrite` output over 19 representative commands: 15 were starving before
and pass now (including the worktree `cd … && rtk …` form), one is a verb
rename (`./gradlew :core:test` → `rtk gradlew :core:test`), three were never
rewritten and always passed. Zero of `npm publish`, `gh pr merge 3`,
`git push --force origin main`, `rm -rf build`, `npm --tag test publish` are
admitted after rewriting.
