#!/usr/bin/env bash
# Clean agentic-workflow local state for the project the loop drives.
#
# Tiers (least to most destructive):
#   default     — ephemeral run state only: <tasksDir>/runs/ (snapshots,
#                 metrics, .stage.json, .watch-lease/, .claims/, and the per-kind
#                 dedup ledgers pr-sitter/ review-sitter/ dep-sitter/ main-sitter/).
#                 This is the loop's "external memory" — machine state that is
#                 regenerated on the next run. Safe.
#   --backlog   — ALSO delete the task .md files in every status folder
#                 (draft/ queued/ plan-review/ in-progress/ in-review/
#                 completed/ abandoned/). The folders and their .gitkeep stay.
#                 Destructive — this is your authored backlog. Confirm-gated.
#   --config    — ALSO remove the project's .agentic-workflow.json.
#   --purge     — everything above (runs + backlog + config): a full reset.
#
# Target dir resolves like the plugin at runtime: $AGENTIC_WORKFLOW_DIR, else $PWD.
# tasksDir is read from that project's .agentic-workflow.json (default docs/tasks).
#
#   ./scripts/clean.sh [dir] [--backlog] [--config] [--purge] [--dry-run] [-y]

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/clean.sh                 # remove <tasksDir>/runs/ ephemeral state only
  ./scripts/clean.sh /path/to/repo   # target a specific project (default: $AGENTIC_WORKFLOW_DIR or $PWD)
  ./scripts/clean.sh --backlog       # also delete task files in the status folders (destructive)
  ./scripts/clean.sh --config        # also remove .agentic-workflow.json
  ./scripts/clean.sh --purge         # runs + backlog + config (full reset)
  ./scripts/clean.sh --dry-run       # list what would be removed, delete nothing
  ./scripts/clean.sh -y | --yes      # skip the confirmation prompt
EOF
}

TARGET_DIR="${AGENTIC_WORKFLOW_DIR:-$PWD}"
DO_BACKLOG=0
DO_CONFIG=0
DRY_RUN=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --backlog) DO_BACKLOG=1 ;;
    --config) DO_CONFIG=1 ;;
    --purge) DO_BACKLOG=1; DO_CONFIG=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "unknown option: $arg" >&2
      usage
      exit 1
      ;;
    *) TARGET_DIR="$arg" ;;
  esac
done

if [ ! -d "$TARGET_DIR" ]; then
  echo "error: '$TARGET_DIR' is not a directory" >&2
  exit 1
fi
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
CONFIG_FILE="$TARGET_DIR/.agentic-workflow.json"

# tasksDir: read it from the config (JSON) when node is available; else default.
TASKS_DIR="docs/tasks"
if [ -f "$CONFIG_FILE" ] && command -v node >/dev/null 2>&1; then
  resolved="$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (typeof c.tasksDir === "string" && c.tasksDir.trim()) process.stdout.write(c.tasksDir.trim());
    } catch (_) { /* leave default */ }
  ' "$CONFIG_FILE" 2>/dev/null || true)"
  [ -n "$resolved" ] && TASKS_DIR="$resolved"
fi
TASKS_PATH="$TARGET_DIR/$TASKS_DIR"
RUNS_PATH="$TASKS_PATH/runs"

STATUS_FOLDERS="draft queued plan-review in-progress in-review completed abandoned"

# Collect the removal plan into REMOVALS (one path per line) so we can preview,
# confirm, and report uniformly.
REMOVALS=""
# Note the explicit `return 0`: a missing path makes the `[ -e ]` test the
# function's last command and it would return 1, tripping `set -e`.
add_removal() { [ -e "$1" ] && REMOVALS="${REMOVALS}$1"$'\n'; return 0; }

# 1) Ephemeral run state (always).
add_removal "$RUNS_PATH"
if [ -d "$RUNS_PATH" ] && [ -d "$TASKS_PATH/.watch-lease" ]; then
  # Older layout tolerance: a lease at the tasks root rather than under runs/.
  add_removal "$TASKS_PATH/.watch-lease"
fi

# 2) Backlog task files (--backlog): every *.md under each status folder.
BACKLOG_FILES=""
if [ "$DO_BACKLOG" -eq 1 ]; then
  for folder in $STATUS_FOLDERS; do
    dir="$TASKS_PATH/$folder"
    [ -d "$dir" ] || continue
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      BACKLOG_FILES="${BACKLOG_FILES}${f}"$'\n'
    done <<EOF
$(find "$dir" -maxdepth 1 -type f -name '*.md' 2>/dev/null)
EOF
  done
fi

# 3) Config (--config).
if [ "$DO_CONFIG" -eq 1 ]; then
  add_removal "$CONFIG_FILE"
fi

# ---- Preview ---------------------------------------------------------------
echo "Project:   $TARGET_DIR"
echo "tasksDir:  $TASKS_DIR"
echo

have_something=0
if [ -n "$REMOVALS" ]; then
  echo "Ephemeral / config paths to remove:"
  printf '%s' "$REMOVALS" | while IFS= read -r p; do [ -n "$p" ] && echo "  - ${p#$TARGET_DIR/}"; done
  have_something=1
fi
if [ -n "$BACKLOG_FILES" ]; then
  count="$(printf '%s' "$BACKLOG_FILES" | grep -c . || true)"
  echo "Backlog task files to delete ($count):"
  printf '%s' "$BACKLOG_FILES" | while IFS= read -r p; do [ -n "$p" ] && echo "  - ${p#$TARGET_DIR/}"; done
  have_something=1
fi

if [ "$have_something" -eq 0 ]; then
  echo "Nothing to clean — no run state, backlog files, or config matched."
  exit 0
fi

# Warn on an apparently-active watcher.
if [ -d "$RUNS_PATH/.watch-lease" ]; then
  echo
  echo "note: a watch lease exists ($TASKS_DIR/runs/.watch-lease/) — stop any running"
  echo "      watcher (/agentic-workflow:<kind> stop or ESC) before cleaning."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "dry run — nothing deleted."
  exit 0
fi

# ---- Confirm (destructive tiers, or any run without -y) --------------------
if [ "$ASSUME_YES" -ne 1 ]; then
  destructive=""
  [ "$DO_BACKLOG" -eq 1 ] && [ -n "$BACKLOG_FILES" ] && destructive="backlog task files"
  [ "$DO_CONFIG" -eq 1 ] && [ -f "$CONFIG_FILE" ] && destructive="${destructive:+$destructive + }.agentic-workflow.json"
  echo
  if [ -n "$destructive" ]; then
    printf 'This DELETES %s and cannot be undone. Continue? [y/N]: ' "$destructive" >&2
  else
    printf 'Remove the ephemeral run state above? [y/N]: ' >&2
  fi
  read -r reply || reply=""
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "aborted — nothing deleted."; exit 0 ;;
  esac
fi

# ---- Execute ---------------------------------------------------------------
printf '%s' "$REMOVALS" | while IFS= read -r p; do
  [ -n "$p" ] || continue
  rm -rf "$p" && echo "removed: ${p#$TARGET_DIR/}"
done
printf '%s' "$BACKLOG_FILES" | while IFS= read -r p; do
  [ -n "$p" ] || continue
  rm -f "$p" && echo "removed: ${p#$TARGET_DIR/}"
done

echo
echo "done. The status folders and their .gitkeep files remain; runs/ is recreated on the next loop."
