#!/usr/bin/env bash
# Install the agentic-loop plugins.
#
# OpenCode half: symlinks agents/commands/skills/references into an OpenCode
# config directory (global by default: ~/.config/opencode, or
# $OPENCODE_CONFIG_DIR if set) so `git pull` in this repo keeps the install up
# to date, and registers the plugin itself as a local plugin file.
# Claude Code half: delegates to claude-plugin/install.sh, which builds the
# bundled MCP server and links the shared skills/references into the plugin.
# Re-run any time; both halves are idempotent.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./install.sh                    # install both plugins (OpenCode + Claude Code)
  ./install.sh opencode           # OpenCode only: symlink into $OPENCODE_CONFIG_DIR or ~/.config/opencode
  ./install.sh claude             # Claude Code only: build mcp-server + link shared skills/references
  ./install.sh all                # explicit both (same as no target)
  ./install.sh [opencode] --copy  # copy instead of symlink (OpenCode half only)
  ./install.sh [opencode] /dir    # install the OpenCode half into an arbitrary config dir
                                  # (a dir literally named "claude"/"opencode"/"all" needs a slash, e.g. ./claude)
EOF
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=all
MODE=symlink
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

for arg in "$@"; do
  case "$arg" in
    opencode|claude|all) TARGET="$arg" ;;
    --copy) MODE=copy ;;
    -h|--help)
      usage
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

install_opencode() {
  echo "Installing agentic-loop for OpenCode ($MODE) into $CONFIG_DIR"

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

  if [ ! -d "$REPO_DIR/node_modules" ] || [ ! -d "$REPO_DIR/packages/core/dist" ]; then
    echo
    echo "warning: dependencies not built — run 'npm install' in $REPO_DIR" >&2
    echo "         (it also builds the @agentic-loop/core workspace the plugin imports)" >&2
  fi

  echo
  echo "OpenCode: /agent-loop and the bundled skills are available in every OpenCode session."
}

install_claude() {
  echo "Installing agentic-loop for Claude Code (claude-plugin/)"
  if [ "$MODE" = copy ]; then
    echo "note: --copy applies to the OpenCode install only"
  fi
  "$REPO_DIR/claude-plugin/install.sh"
}

case "$TARGET" in
  opencode) install_opencode ;;
  claude) install_claude ;;
  all)
    install_opencode
    echo
    install_claude
    ;;
esac
