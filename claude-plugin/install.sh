#!/usr/bin/env bash
# Prepare the agentic-loop Claude Code plugin for use:
#   1. build the MCP server (npm install + tsc → mcp-server/dist)
#   2. symlink the platform-agnostic skills + references from the repo top level
#      into the plugin (the two loop-specific skills are authored here directly)
#
# Run this once after cloning, then load the plugin with either:
#   claude --plugin-dir /abs/path/to/claude-plugin
# or add the repo as a marketplace:
#   /plugin marketplace add /abs/path/to/repo   (then)   /plugin install agentic-loop
#
# Re-run any time; it's idempotent.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$PLUGIN_DIR/.." && pwd)"

echo "Building the agentic-loop MCP server…"
( cd "$PLUGIN_DIR/mcp-server" && npm install && npm run build )

echo "Linking shared skills + references…"
mkdir -p "$PLUGIN_DIR/skills" "$PLUGIN_DIR/references"

# Loop-specific skills authored for Claude Code directly in the plugin and
# must NOT be overwritten by the OpenCode versions. task-backlog-management is
# substrate-agnostic and ships as a committed symlink to the canonical copy.
CLAUDE_OWNED_SKILLS="loop-orchestration"

# Relative symlinks so they survive a fresh clone (git tracks them).
for d in "$REPO_DIR"/skills/*/; do
  name="$(basename "$d")"
  case " $CLAUDE_OWNED_SKILLS " in
    *" $name "*) continue ;;   # keep the Claude-specific version
  esac
  dest="$PLUGIN_DIR/skills/$name"
  target="../../skills/$name"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$target" ]; then
    continue
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    rm -rf "$dest"
  fi
  ln -s "$target" "$dest"
done

for f in "$REPO_DIR"/references/*.md; do
  base="$(basename "$f")"
  dest="$PLUGIN_DIR/references/$base"
  target="../../references/$base"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$target" ]; then
    continue
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    rm -rf "$dest"
  fi
  ln -s "$target" "$dest"
done

echo
echo "Done. Load with:  claude --plugin-dir \"$PLUGIN_DIR\""
echo "Then run:  /agent-loop-plan new <idea>   (draft → plan → approve → /agent-loop task <id>)"
