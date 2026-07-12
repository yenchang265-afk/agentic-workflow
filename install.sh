#!/usr/bin/env bash
# Install the agentic-loop plugins.
#
# OpenCode half: symlinks agents/commands/skills/references into an OpenCode
# config directory (global by default: ~/.config/opencode, or
# $OPENCODE_CONFIG_DIR if set) so `git pull` in this repo keeps the install up
# to date, and registers the plugin itself as a local plugin file.
# Claude Code half: delegates to plugins/claude/install.sh, which builds the
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

After installing, a short wizard offers to write an initial .agentic-loop.json
into the project the loop will drive (interactive terminals only):
  --config                        # force the config wizard on
  --no-config                     # skip the config wizard
  -y, --yes                       # non-interactive: seed a defaults .agentic-loop.json, no prompts
EOF
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=all
MODE=symlink
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
WANT_CONFIG=1
ASSUME_YES=0
# The directory the plugin actually reads .agentic-loop.json from at runtime:
# the Claude host uses `AGENTIC_LOOP_DIR ?? cwd`, the OpenCode host the project
# dir. Default the wizard's target to that same resolution; it is prompted for.
TARGET_DIR="${AGENTIC_LOOP_DIR:-$PWD}"

for arg in "$@"; do
  case "$arg" in
    opencode|claude|all) TARGET="$arg" ;;
    both) TARGET=all ;;  # tolerate the historical alias; never let it fall to the config-dir catch-all
    --copy) MODE=copy ;;
    --config) WANT_CONFIG=1 ;;
    --no-config) WANT_CONFIG=0 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      # Reject an unknown flag rather than silently treating it as the config
      # dir (a typo'd `--coppy` must error, not install into `./--coppy`).
      # Matches bootstrap.sh. A bare path is still accepted as the config dir below.
      echo "unknown option: $arg" >&2
      usage
      exit 1
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

  for f in "$REPO_DIR"/plugins/opencode/agents/*.md; do
    link_or_copy "$f" "$CONFIG_DIR/agents/$(basename "$f")"
  done

  for f in "$REPO_DIR"/plugins/opencode/commands/*.md; do
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
  printf 'export * from "%s/plugins/opencode/src/index.ts"\n' "$REPO_DIR" > "$PLUGIN_FILE"
  echo "installed: $PLUGIN_FILE"

  if [ ! -d "$REPO_DIR/node_modules" ] || [ ! -d "$REPO_DIR/packages/core/dist" ]; then
    echo
    echo "warning: dependencies not built — run 'npm install' in $REPO_DIR" >&2
    echo "         (it also builds the @agentic-loop/core workspace the plugin imports)" >&2
  fi

  echo
  echo "OpenCode: /agentic-loop:engineering and the bundled skills are available in every OpenCode session."
}

install_claude() {
  echo "Installing agentic-loop for Claude Code (plugins/claude/)"
  if [ "$MODE" = copy ]; then
    echo "note: --copy applies to the OpenCode install only"
  fi
  "$REPO_DIR/plugins/claude/install.sh"
}

# ---------------------------------------------------------------------------
# Config wizard: writes an initial .agentic-loop.json into the project the loop
# will drive. All bash 3.2 compatible (no associative arrays, no `read -i`).
# ---------------------------------------------------------------------------

ok()   { echo "ok:      $1"; }
skip() { echo "skip:    $1"; }

# Prompt on stderr (so $(...) captures only the answer), read EOF-safe so a
# closed stdin under `set -e` degrades to the default instead of aborting.
# ask "Prompt" "default" -> echoes the answer, or the default when blank/EOF.
ask() {
  local prompt="$1" default="${2:-}" reply=""
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r reply || reply=""
  if [ -n "$reply" ]; then printf '%s' "$reply"; else printf '%s' "$default"; fi
}

# ask_required "Prompt" -> re-asks until non-empty; may return empty after the
# bounded retries (caller must check and abort rather than emit a partial file).
ask_required() {
  local prompt="$1" reply="" tries=0
  while [ -z "$reply" ] && [ "$tries" -lt 5 ]; do
    reply="$(ask "$prompt")"
    tries=$((tries + 1))
  done
  printf '%s' "$reply"
}

# confirm "Prompt" -> 0 for yes, 1 for no (default No).
confirm() {
  local reply
  reply="$(ask "$1 [y/N]" "")"
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# Escape a string's inner text for embedding in a JSON double-quoted value.
# Backslash MUST be replaced first. ${var//old/new} is available in bash 3.2.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

MEMBERS=""
add_member() { MEMBERS="${MEMBERS:+$MEMBERS,}$1"; }

configure() {
  echo
  echo "== config (.agentic-loop.json) =="
  echo "A few questions to seed an initial config. Blank accepts the [default]."

  # Q0 — which project the loop will drive (the dir the plugin reads config from).
  local dir
  dir="$(ask "Write config for which project directory" "$TARGET_DIR")"
  TARGET_DIR="$dir"
  local target_config="$TARGET_DIR/.agentic-loop.json"
  if [ ! -d "$TARGET_DIR" ]; then
    skip "config wizard — '$TARGET_DIR' is not a directory"
    return
  fi
  if [ -f "$target_config" ]; then
    skip "$target_config already exists — leaving it untouched"
    return
  fi

  MEMBERS=""

  # Q1 — code platform.
  local platform choice
  echo
  echo "Which code platform do your PRs live on?"
  echo "  [1] GitHub (default)"
  echo "  [2] Azure DevOps (REST API + PAT)"
  choice="$(ask "Choice" "1")"
  case "$choice" in
    2) platform="ado" ;;
    *) platform="github" ;;
  esac
  add_member "\"codePlatform\":\"$platform\""

  if [ "$platform" = "ado" ]; then
    local org project repo login
    org="$(ask_required "Azure DevOps organization URL (e.g. https://dev.azure.com/acme)")"
    project="$(ask_required "Azure DevOps project name")"
    if [ -z "$org" ] || [ -z "$project" ]; then
      skip "config wizard — Azure DevOps organization and project are required (aborted, nothing written)"
      return
    fi
    # A PAT carries no reliable email identity, so selfLogin is required for ado.
    login="$(ask_required "Your ADO login/email for comment filtering (ado.selfLogin)")"
    if [ -z "$login" ]; then
      skip "config wizard — ado.selfLogin is required for ado (a PAT cannot resolve it; aborted, nothing written)"
      return
    fi
    repo="$(ask "Repository name (blank = all repos in the project)" "")"
    local ado="\"organization\":\"$(json_escape "$org")\",\"project\":\"$(json_escape "$project")\""
    [ -n "$repo" ] && ado="$ado,\"repository\":\"$(json_escape "$repo")\""
    ado="$ado,\"selfLogin\":\"$(json_escape "$login")\""
    add_member "\"ado\":{$ado}"
    echo
    echo "  → Azure DevOps auth: a PAT scoped to Code (read) + Pull Request (contribute)."
    echo "    Preferred: export AZURE_DEVOPS_EXT_PAT=<pat>. Or add \"pat\":\"<pat>\" to the"
    echo "    ado section of the (gitignored) .agentic-loop.json — the env var wins if both are set."
    echo "    Tip: settings shared across repos (organization, selfLogin, pat) can live in a"
    echo "    user-scope ~/.agentic-loop.json; the repo file overrides it field by field."
  fi

  # Q2 — PR sitter.
  echo
  if confirm "Enable the PR-sitter loop (watches your open PRs)?"; then
    if [ "$platform" = "github" ]; then
      local query
      query="$(ask "PR search query" "is:open author:@me")"
      add_member "\"loops\":{\"pr-sitter\":{\"enabled\":true,\"query\":\"$(json_escape "$query")\"}}"
    else
      # query is a GitHub-only knob; on ADO the sitter watches its own PRs.
      add_member "\"loops\":{\"pr-sitter\":{\"enabled\":true}}"
    fi
  fi

  # Q3 — worktrees.
  echo
  if confirm "Run each task in an isolated git worktree?"; then
    local wtdir wtsetup
    wtdir="$(ask "Worktrees directory" ".worktrees")"
    add_member "\"worktreesDir\":\"$(json_escape "$wtdir")\""
    wtsetup="$(ask "Setup command to run in a fresh worktree (blank = none, e.g. npm ci)" "")"
    [ -n "$wtsetup" ] && add_member "\"worktreeSetup\":\"$(json_escape "$wtsetup")\""
  fi

  # Advanced (single gate).
  echo
  if confirm "Configure advanced options (task tracker, review lenses, iterations)?"; then
    local tracker
    echo
    echo "Team task tracker?"
    echo "  [1] none (default)"
    echo "  [2] Jira"
    echo "  [3] Azure DevOps"
    tracker="$(ask "Choice" "1")"
    local system=""
    case "$tracker" in
      2) system="jira" ;;
      3) system="azure-devops" ;;
    esac
    if [ -n "$system" ]; then
      local pm="\"system\":\"$system\"" baseurl deftype
      baseurl="$(ask "Deep-link base URL (blank = none)" "")"
      if [ -n "$baseurl" ]; then
        case "$baseurl" in
          http://* | https://*) pm="$pm,\"baseUrl\":\"$(json_escape "$baseurl")\"" ;;
          *) echo "note: '$baseurl' is not an http(s) URL — skipping baseUrl" >&2 ;;
        esac
      fi
      deftype="$(ask "Default issue/work-item type (blank = none, e.g. story)" "")"
      [ -n "$deftype" ] && pm="$pm,\"defaultType\":\"$(json_escape "$deftype")\""
      add_member "\"projectManagement\":{$pm}"
    fi

    local lenses
    lenses="$(ask "Extra review lenses, comma-separated (max 5, blank = none)" "")"
    if [ -n "$lenses" ]; then
      local arr="" item count=0 rest="$lenses"
      # Split on commas, trim surrounding spaces, drop empties, cap at 5.
      while [ -n "$rest" ]; do
        case "$rest" in
          *,*) item="${rest%%,*}"; rest="${rest#*,}" ;;
          *)   item="$rest"; rest="" ;;
        esac
        item="${item#"${item%%[![:space:]]*}"}"
        item="${item%"${item##*[![:space:]]}"}"
        [ -z "$item" ] && continue
        [ "$count" -ge 5 ] && { echo "note: capping review lenses at 5" >&2; break; }
        arr="${arr:+$arr,}\"$(json_escape "$item")\""
        count=$((count + 1))
      done
      [ -n "$arr" ] && add_member "\"reviewLenses\":[$arr]"
    fi

    local iters
    iters="$(ask "Max loop iterations" "3")"
    case "$iters" in
      "" | 3) ;;
      *[!0-9]*) echo "note: '$iters' is not a positive integer — using default (3)" >&2 ;;
      0) echo "note: maxIterations must be positive — using default (3)" >&2 ;;
      *) add_member "\"maxIterations\":$iters" ;;
    esac
  fi

  printf '{\n  %s\n}\n' "$MEMBERS" > "$target_config"

  # Safety net: confirm the file parses. We author it deterministically, so a
  # failure here is a bug, not user error — warn, don't fail the install.
  if command -v node >/dev/null 2>&1; then
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$target_config" 2>/dev/null; then
      echo "warning: wrote $target_config but it did not parse as JSON — please review" >&2
      return
    fi
  fi
  ok "wrote $target_config"
  if [ "$TARGET_DIR" != "$REPO_DIR" ]; then
    echo "         (the loop reads this from the project it runs in — move it if you drive a different repo)"
  fi
}

maybe_configure() {
  if [ "$WANT_CONFIG" -ne 1 ]; then
    skip "config wizard (--no-config)"
    return
  fi
  local target_config="$TARGET_DIR/.agentic-loop.json"
  if [ "$ASSUME_YES" -eq 1 ]; then
    if [ -f "$target_config" ]; then
      skip "$target_config already exists — leaving it untouched"
    else
      printf '{}\n' > "$target_config"
      ok "wrote defaults $target_config"
    fi
    return
  fi
  if [ -f "$target_config" ]; then
    skip "$target_config already exists — leaving it untouched"
    return
  fi
  if [ -t 0 ] && [ -t 1 ] && [ -z "${CI:-}" ]; then
    configure
  else
    skip "non-interactive shell — run ./install.sh --config to configure, or --yes to seed defaults"
  fi
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

maybe_configure
