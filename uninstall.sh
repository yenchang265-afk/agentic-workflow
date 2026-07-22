#!/usr/bin/env bash
# Uninstall the agentic-workflow plugins — the reverse of ./install.sh.
#
# OpenCode half: removes the agents/commands/skills/references entries this repo
# installed into an OpenCode config directory (symlinks that point back here, or
# — with --copy — the copies install left by name), plus the local plugin file.
# Claude Code half: drops the built MCP server (mcp-server/dist); the plugin's
# committed in-repo skill/reference symlinks are git-tracked, not install
# artifacts, so they are left alone. Detaching the plugin from Claude Code
# itself is a `/plugin uninstall agentic-workflow` (or dropping --plugin-dir) — this
# script prints the reminder.
#
# It never touches your .agentic-workflow.json or the docs/tasks/ backlog — use
# ./scripts/clean.sh for that. It also does NOT reverse ./bootstrap.sh extras
# (e.g. the chrome-devtools MCP registration in the user-global Claude /
# OpenCode configs) — remove those entries by hand if you want them gone.
# Re-run any time; idempotent.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./uninstall.sh                  # uninstall both plugins (OpenCode + Claude Code)
  ./uninstall.sh opencode         # OpenCode only: remove entries from $OPENCODE_CONFIG_DIR or ~/.config/opencode
  ./uninstall.sh claude           # Claude Code only: remove the built mcp-server/dist
  ./uninstall.sh all              # explicit both (same as no target)
  ./uninstall.sh [opencode] --copy # also remove copies install left (not just symlinks)
  ./uninstall.sh [opencode] /dir  # uninstall the OpenCode half from an arbitrary config dir

To also wipe local run state / backlog / config, see ./scripts/clean.sh.
EOF
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=all
MODE=symlink
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

for arg in "$@"; do
  case "$arg" in
    opencode|claude|all) TARGET="$arg" ;;
    both) TARGET=all ;;
    --copy) MODE=copy ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "unknown option: $arg" >&2
      usage
      exit 1
      ;;
    *) CONFIG_DIR="$arg" ;;
  esac
done

# Remove a dest we own: a symlink pointing back into this repo always goes; a
# plain file/dir goes only in --copy mode (that is what install left behind).
remove_owned() {
  local dest="$1"
  if [ -L "$dest" ]; then
    local target
    target="$(readlink "$dest")"
    case "$target" in
      "$REPO_DIR"/*) rm -rf "$dest"; echo "removed: $dest" ;;
      *) : ;;  # a symlink to somewhere else — not ours, leave it
    esac
  elif [ -e "$dest" ] && [ "$MODE" = copy ]; then
    rm -rf "$dest"; echo "removed (copy): $dest"
  fi
}

uninstall_opencode() {
  echo "Uninstalling agentic-workflow for OpenCode from $CONFIG_DIR"
  if [ ! -d "$CONFIG_DIR" ]; then
    echo "skip: $CONFIG_DIR does not exist — nothing to remove"
    return
  fi

  # Iterate this repo's own sources so we only ever touch names install owns.
  for f in "$REPO_DIR"/plugins/opencode/agents/*.md; do
    [ -e "$f" ] || continue
    remove_owned "$CONFIG_DIR/agents/$(basename "$f")"
  done
  for f in "$REPO_DIR"/plugins/opencode/commands/*.md; do
    [ -e "$f" ] || continue
    remove_owned "$CONFIG_DIR/commands/$(basename "$f")"
  done
  for d in "$REPO_DIR"/skills/*/; do
    [ -d "$d" ] || continue
    remove_owned "$CONFIG_DIR/skills/$(basename "$d")"
  done
  for f in "$REPO_DIR"/references/*.md; do
    [ -e "$f" ] || continue
    remove_owned "$CONFIG_DIR/references/$(basename "$f")"
  done

  # The local plugin file — remove it only when it re-exports THIS repo, so a
  # second clone's uninstall doesn't yank a plugin file pointing elsewhere.
  local plugin_file="$CONFIG_DIR/plugins/agentic-workflow.ts"
  if [ -f "$plugin_file" ] && grep -qF "$REPO_DIR/plugins/opencode/src/index.ts" "$plugin_file" 2>/dev/null; then
    rm -f "$plugin_file"; echo "removed: $plugin_file"
  fi

  # Drop now-empty dirs we may have created (never fails if non-empty).
  for dir in agents commands skills references plugins; do
    rmdir "$CONFIG_DIR/$dir" 2>/dev/null || true
  done

  echo "OpenCode: agentic-workflow entries removed. Your OpenCode config file is untouched."
}

uninstall_claude() {
  echo "Uninstalling agentic-workflow for Claude Code (plugins/claude/)"
  local dist="$REPO_DIR/plugins/claude/mcp-server/dist"
  if [ -d "$dist" ]; then
    rm -rf "$dist"; echo "removed: $dist"
  else
    echo "skip: $dist not present"
  fi
  echo "Claude Code: detach the plugin itself with '/plugin uninstall agentic-workflow'"
  echo "             (or drop the --plugin-dir flag). The in-repo skill/reference"
  echo "             symlinks are git-tracked and are left in place."
}

case "$TARGET" in
  opencode) uninstall_opencode ;;
  claude) uninstall_claude ;;
  all)
    uninstall_opencode
    echo
    uninstall_claude
    ;;
esac
