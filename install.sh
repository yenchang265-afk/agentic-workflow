#!/usr/bin/env bash
# Install agentic-loop into an OpenCode config directory (global by default:
# ~/.config/opencode, or $OPENCODE_CONFIG_DIR if set).
#
# Symlinks agents/commands/skills/references so `git pull` in this repo keeps
# the install up to date, and registers the plugin itself as a local plugin
# file. Re-run any time; it's idempotent.
#
# Usage:
#   ./install.sh              # symlink into $OPENCODE_CONFIG_DIR or ~/.config/opencode
#   ./install.sh --copy       # copy instead of symlink (no live updates)
#   ./install.sh /path/to/dir # install into an arbitrary config dir instead

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=symlink
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

for arg in "$@"; do
  case "$arg" in
    --copy) MODE=copy ;;
    -h|--help)
      sed -n '2,15p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) CONFIG_DIR="$arg" ;;
  esac
done

link_or_copy() {
  local src="$1" dest="$2"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    return 0
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    rm -rf "$dest"
  fi
  if [ "$MODE" = symlink ]; then
    ln -s "$src" "$dest"
  else
    if [ -d "$src" ]; then
      cp -R "$src" "$dest"
    else
      cp "$src" "$dest"
    fi
  fi
  echo "installed: $dest"
}

echo "Installing agentic-loop ($MODE) into $CONFIG_DIR"

mkdir -p "$CONFIG_DIR/agents" "$CONFIG_DIR/commands" "$CONFIG_DIR/skills" \
         "$CONFIG_DIR/references" "$CONFIG_DIR/plugins"

# Drop symlinks that point back into this repo but whose source is gone —
# e.g. commands/task.md after its rename to loop-plan.md.
for dir in agents commands skills references; do
  for link in "$CONFIG_DIR/$dir"/*; do
    [ -L "$link" ] || continue
    target="$(readlink "$link")"
    case "$target" in
      "$REPO_DIR"/*) [ -e "$link" ] || { rm "$link"; echo "removed (dangling): $link"; } ;;
    esac
  done
done

for f in "$REPO_DIR"/.opencode/agents/*.md; do
  link_or_copy "$f" "$CONFIG_DIR/agents/$(basename "$f")"
done

for f in "$REPO_DIR"/.opencode/commands/*.md; do
  link_or_copy "$f" "$CONFIG_DIR/commands/$(basename "$f")"
done

for d in "$REPO_DIR"/skills/*/; do
  name="$(basename "$d")"
  link_or_copy "${d%/}" "$CONFIG_DIR/skills/$name"
done

for f in "$REPO_DIR"/references/*.md; do
  link_or_copy "$f" "$CONFIG_DIR/references/$(basename "$f")"
done

# The plugin itself: a local plugin file that re-exports this repo's entry
# point. OpenCode auto-loads any file dropped in plugins/, no opencode.json
# edit needed. Requires `npm install` to have been run in $REPO_DIR.
PLUGIN_FILE="$CONFIG_DIR/plugins/agentic-loop.ts"
printf 'export * from "%s/src/index.ts"\n' "$REPO_DIR" > "$PLUGIN_FILE"
echo "installed: $PLUGIN_FILE"

if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo
  echo "warning: $REPO_DIR/node_modules is missing — run 'npm install' in $REPO_DIR" >&2
fi

echo
echo "Done. /agent-loop and the bundled skills are available in every OpenCode session."
