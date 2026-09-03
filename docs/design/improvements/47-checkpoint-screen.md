English | [繁體中文](47-checkpoint-screen.zh-TW.md)

# 47 — The automatic checkpoint screens what it sweeps

**Status: implemented.**

## The problem

`commitAll` — the checkpoint every work stage ends with, on both hosts — is
a `git add -A`. Its only exclusions were the backlog dir (worktree mode) and
the lockfiles, so anything a stage left in the tree that `.gitignore` did not
cover rode the feature branch: a `.env` a setup script wrote, a `.pem` an
install step dropped, a `credentials.json` from a test harness, a downloaded
fixture or coverage archive. Design 05's redaction covers the durable TEXT
artifacts (audit notes, plans, run logs); it never looked at the code the
checkpoint commits, and a checkpoint is permanent history on the branch the
PR carries.

## What changed

- **`screenCheckpoint` runs inside `commitAll`**, ahead of the `add -A`: it
  reads `git status --porcelain -z --untracked-files=all`, keeps every path the
  sweep would take (deletions and rename sources skipped), and refuses each
  that is **secret-shaped** by basename (`CHECKPOINT_SECRET_BASENAMES`:
  dotenv files bar the `.example`/`.sample`/`.template`/`.dist`/`.defaults`
  conventions, `*.pem|key|p12|pfx|jks|keystore|asc|gpg|kdbx`, SSH private
  keys, `credentials.json`/`service-account*.json`/`client_secret*.json`,
  `.netrc`/`.pgpass`/`.git-credentials`, `*.tfstate`) or **oversized** (a
  regular file over `CHECKPOINT_BLOB_MAX`, 5 MiB, by `stat`).
- **Refused paths become `:(exclude,literal)` pathspecs** on the same `add`,
  exactly the mechanism the lockfile exclusion already uses — and `literal`
  because a screened path is a NAME, and a glob character in it must not widen
  into a pattern.
- **`commitAll` returns `{ committed, screened }`**, and every host site
  (the OpenCode driver's `checkpoint`, the Claude server's terminal port, its
  build checkpoint, and `workflow_checkpoint`) logs `screenedWarning` —
  "N paths kept out of the automatic sweep — `.env` (secret-shaped) …
  committed with an explicit `git add <path>`".

## Sharp edges

- **The screen lives inside `commitAll`, not at the callers**, so no checkpoint
  site can be written without it — the four existing ones were the proof that
  a per-caller rule would have been missed.
- **It narrows the AUTOMATIC sweep and nothing else.** A path BUILD staged
  explicitly is untouched, as the lockfile rule already promises; a screened
  path that belongs to the change costs one explicit `git add`. Deliberately
  tight, because a false positive costs that command while a false negative
  is a secret in history. `.npmrc`/`.pypirc` are NOT screened: repos commit
  them for mirror config.
- **It fails toward the sweep.** A failed status probe screens nothing; a
  path that cannot be `stat`ed is not a blob. A guard on the checkpoint must
  never cost the checkpoint.
- **The porcelain is read RAW.** `run`'s `trim` would eat the leading space
  of a ` M path` entry and hand the parser the path's first character as its
  XY code — hence `runRaw`, and a test that puts that entry first.
