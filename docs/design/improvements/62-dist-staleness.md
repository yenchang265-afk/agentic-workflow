English | [繁體中文](62-dist-staleness.zh-TW.md)

# 62 — A stale build is named at session start, on both hosts

**Status: implemented.**

## The problem

The bundled hooks, the MCP server and the OpenCode plugin all resolve core
through `packages/core/dist` — gitignored, rebuilt only by `pnpm install`.
A `git pull` that touched core left every consumer running OLD core with
nothing failing until a contract mismatch surfaced mid-gate (a gate result
with no `data.gate` on it, diagnosed after the fact on one host — "the
silent seam that cost the most"). The session-start reconciler checked that
`mcp-server/dist/server.js` EXISTED and never looked at core at all;
OpenCode caught only a hard load failure.

## What changed

- **`distStaleness(pkgDir)`** (`dist-staleness.ts`, `node:fs` only) compares
  the newest non-test `src/**/*.ts` mtime with the newest `dist/**/*.js`;
  `staleDistWarning` is the one line both hosts print. Absent `src/` or
  `dist/` is "cannot tell" (null), never stale — a plugin installed away from
  the monorepo has no sources beside it.
- **The Claude/Qwen reconciler** probes `mcp-server` and
  `../../packages/core` after its existence check, budgeted (`maxFiles`,
  `partial` reported) because a hook the host kills at its deadline drops the
  whole report.
- **OpenCode's `reconcileOnce`** probes core the same way and logs the
  warning with the rebuild command.

## Sharp edges

- **Newest-vs-newest, not per file.** `tsc` rewrites every output, so a
  per-file pairing would misread an unchanged module as stale.
- **Tests excluded from the source side.** A `*.test.ts` edit does not
  change dist and must not read as stale.
