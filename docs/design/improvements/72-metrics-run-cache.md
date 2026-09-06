English | [繁體中文](72-metrics-run-cache.zh-TW.md)

# 72 — The run reader caches parses and reads in parallel

**Status: implemented.**

## The problem

`readRunInputs` read and parsed every `runs/*.md` and `*.metrics.json`
serially on every call, and the hub's Metrics tab refetches on every
`versions.run`/`versions.tokens` SSE bump — so one run-log append re-read
the whole tree, several times, on a WSL DrvFs tree where per-file latency
is the dominant cost. Core's `Client` has no stat, so there was nothing to
key a cache on.

## What changed

- **`ReadRunInputsOptions`**: an optional `stat(absPath)` hook and a
  caller-owned `cache` map. With both, a run's parse is reused while BOTH
  files' size and mtime stand (the lesson `tokens/transcripts.ts` records:
  size alone served a same-length rewrite stale); a changed file re-parses;
  a vanished id is evicted. `concurrency` (default 16) replaces the serial
  loop with a bounded worker pool, order preserved.
- **The hub** passes `fs.statSync` and a per-repo process-lifetime map
  (`metrics/runcache.ts`); core stays stat-free by default, so both CLI
  hosts' `metrics` verb keep working unchanged and can opt in later.

## Sharp edges

- **Keyed on both files.** `upsertRunMetrics` rewrites a sidecar to an
  identical length routinely; mtime is what catches it.
- **The cache is the caller's.** Its lifetime and bound are a hub decision,
  not a core one.
