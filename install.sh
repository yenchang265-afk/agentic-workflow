#!/usr/bin/env bash
# Install the agentic-workflow plugins.
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
  ./install.sh                    # interactive: detect installed hosts and let you pick
                                  #   (non-interactive with no target defaults to both)
  ./install.sh opencode           # OpenCode only: symlink into $OPENCODE_CONFIG_DIR or ~/.config/opencode
  ./install.sh claude             # Claude Code only: build mcp-server + link shared skills/references
  ./install.sh all                # explicit both (OpenCode + Claude Code)
  ./install.sh config             # config only: run the wizard, install no plugin files
  ./install.sh [opencode] --copy  # copy instead of symlink (OpenCode half only)
  ./install.sh [opencode] /dir    # install the OpenCode half into an arbitrary config dir
                                  # (a dir literally named "claude"/"opencode"/"all"/"config" needs a slash, e.g. ./claude)

After installing, a short wizard offers to write an initial .agentic-workflow.json
into the project the loop will drive (interactive terminals only):
  --config                        # force the config wizard on
  --no-config                     # skip the config wizard (also skips the
                                   # user-scope defaults file below)
  --user                          # write config to the user scope (see path below), not the repo
  --repo                          # write config to the project's .agentic-workflow.json (default)
  -y, --yes                       # non-interactive: seed a defaults .agentic-workflow.json, no prompts

Every run (regardless of the above) also seeds a fully-expanded user-scope config
at ${XDG_CONFIG_HOME:-~/.config}/agentic-workflow/agentic-workflow.json — every
field at its default, every sitter listed with enabled:false — if one doesn't
already exist there, so every knob is visible without reading docs/configuration.md.
Never overwrites an existing file; a pre-XDG ~/.agentic-workflow.json is still read
as a fallback and left untouched.

To reverse an install: ./uninstall.sh [opencode|claude|all].
To clear local run state / backlog / config: ./scripts/clean.sh (see --help).
EOF
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=all
# 1 once a positional target (opencode/claude/all/both/config) is given, so the
# host-selection menu only runs when the user let the target default.
TARGET_EXPLICIT=0
MODE=symlink
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
WANT_CONFIG=1
ASSUME_YES=0
# Config scope the wizard writes to: "" = ask, "repo" = <project>/.agentic-workflow.json,
# "user" = the user-scope file shared across every repo. Forced by --repo/--user.
CONFIG_SCOPE=""
# The directory the plugin actually reads .agentic-workflow.json from at runtime:
# the Claude host uses `AGENTIC_WORKFLOW_DIR ?? cwd`, the OpenCode host the project
# dir. Default the wizard's target to that same resolution; it is prompted for.
TARGET_DIR="${AGENTIC_WORKFLOW_DIR:-$PWD}"

# Where the user-scope config lives, mirroring core's resolveUserConfigPath:
# $AGENTIC_WORKFLOW_USER_CONFIG when set non-empty wins; else
# ${XDG_CONFIG_HOME:-$HOME/.config}/agentic-workflow/agentic-workflow.json,
# falling back on read to the pre-XDG ~/.agentic-workflow.json when only that
# exists (so we never shadow a customized legacy file; the XDG path is the write
# target for new installs). ("" disables the layer for the runtime; for the
# wizard we still resolve a path so a scoped write has a home, and warn.)
# Echoes the path, or "" if none.
user_config_path() {
  if [ -n "${AGENTIC_WORKFLOW_USER_CONFIG-}" ]; then
    printf '%s' "$AGENTIC_WORKFLOW_USER_CONFIG"
    return
  fi
  [ -n "${HOME-}" ] || { printf ''; return; }
  local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  local primary="$config_home/agentic-workflow/agentic-workflow.json"
  local legacy="$HOME/.agentic-workflow.json"
  if [ -f "$primary" ]; then
    printf '%s' "$primary"
  elif [ -f "$legacy" ]; then
    printf '%s' "$legacy"
  else
    printf '%s' "$primary"
  fi
}

for arg in "$@"; do
  case "$arg" in
    opencode|claude|all|config) TARGET="$arg"; TARGET_EXPLICIT=1 ;;
    both) TARGET=all; TARGET_EXPLICIT=1 ;;  # tolerate the historical alias; never let it fall to the config-dir catch-all
    --copy) MODE=copy ;;
    --config) WANT_CONFIG=1 ;;
    --no-config) WANT_CONFIG=0 ;;
    --user) CONFIG_SCOPE=user ;;
    --repo) CONFIG_SCOPE=repo ;;
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
  echo "Installing agentic-workflow for OpenCode ($MODE) into $CONFIG_DIR"

  mkdir -p "$CONFIG_DIR/agents" "$CONFIG_DIR/commands" "$CONFIG_DIR/skills" \
           "$CONFIG_DIR/references" "$CONFIG_DIR/plugins"

  # Drop symlinks that point back into this repo but whose source is gone —
  # e.g. commands/task.md after its rename to workflow-plan.md.
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
  PLUGIN_FILE="$CONFIG_DIR/plugins/agentic-workflow.ts"
  printf 'export * from "%s/plugins/opencode/src/index.ts"\n' "$REPO_DIR" > "$PLUGIN_FILE"
  echo "installed: $PLUGIN_FILE"

  if [ ! -d "$REPO_DIR/node_modules" ] || [ ! -d "$REPO_DIR/packages/core/dist" ]; then
    echo
    echo "warning: dependencies not built — run 'npm install' in $REPO_DIR" >&2
    echo "         (it also builds the @agentic-workflow/core workspace the plugin imports)" >&2
  fi

  echo
  echo "OpenCode: /agentic-workflow:engineering and the bundled skills are available in every OpenCode session."
}

install_claude() {
  echo "Installing agentic-workflow for Claude Code (plugins/claude/)"
  if [ "$MODE" = copy ]; then
    echo "note: --copy applies to the OpenCode install only"
  fi
  "$REPO_DIR/plugins/claude/install.sh"
}

# ---------------------------------------------------------------------------
# Config wizard: writes an initial .agentic-workflow.json into the project the loop
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

# Host detection. Claude Code ships a `claude` CLI (and a ~/.claude dir); OpenCode
# ships an `opencode` CLI. We detect the CLI — the OpenCode config dir is an
# unreliable signal because this installer creates it.
has_claude()   { command -v claude   >/dev/null 2>&1 || [ -d "$HOME/.claude" ]; }
has_opencode() { command -v opencode >/dev/null 2>&1; }

# Interactive host-selection menu, run only when no positional target was given.
# Sets TARGET to claude|opencode|all|config, defaulting to whatever was detected.
select_host() {
  local c_mark o_mark default
  if has_claude;   then c_mark="✓"; else c_mark="✗"; fi
  if has_opencode; then o_mark="✓"; else o_mark="✗"; fi

  # Default the choice to the detected host(s): both → 3, one → that one, else 3.
  if has_claude && has_opencode; then default="3"
  elif has_claude;   then default="1"
  elif has_opencode; then default="2"
  else default="3"; fi

  echo
  echo "Detected hosts: Claude Code $c_mark   OpenCode $o_mark"
  echo "Install agentic-workflow for which?"
  echo "  [1] Claude Code"
  echo "  [2] OpenCode"
  echo "  [3] Both (default)"
  echo "  [4] Config only — no plugin files, just the .agentic-workflow.json wizard"
  case "$(ask "Choice" "$default")" in
    1) TARGET=claude ;;
    2) TARGET=opencode ;;
    4) TARGET=config ;;
    *) TARGET=all ;;
  esac
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

# Workflow kinds accumulate into one "workflows" object so several can be enabled at
# once without emitting a duplicate "workflows" key. add_workflow takes a
# "\"kind\":{…}" fragment; flush_workflows folds them into a single member.
WORKFLOWS=""
add_workflow()    { WORKFLOWS="${WORKFLOWS:+$WORKFLOWS,}$1"; }
# `return 0`: with no sitters the `[ -n ]` test is the last command and returns
# 1, which would trip `set -e` at the bare `flush_workflows` call before the write.
flush_workflows() { [ -n "$WORKFLOWS" ] && add_member "\"workflows\":{$WORKFLOWS}"; return 0; }

configure() {
  echo
  echo "== config (.agentic-workflow.json) =="
  echo "A few questions to seed an initial config. Blank accepts the [default]."

  # Q0a — scope: user-scope (shared across every repo) or repo-scope (this
  # project only). The runtime layers repo OVER user, so shared settings
  # (ado org/selfLogin/pat, review lenses) belong in user scope and
  # project-specific ones (a PR query, worktreesDir) in the repo file.
  local scope="$CONFIG_SCOPE"
  if [ -z "$scope" ]; then
    echo
    echo "Where should this config be written?"
    echo "  [1] This project only — <dir>/.agentic-workflow.json (repo scope, default)"
    echo "  [2] User scope — shared across every repo you drive"
    case "$(ask "Choice" "1")" in
      2) scope="user" ;;
      *) scope="repo" ;;
    esac
  fi

  # Q0b — resolve the destination path for the chosen scope.
  local target_config
  if [ "$scope" = "user" ]; then
    target_config="$(user_config_path)"
    if [ -z "$target_config" ]; then
      skip "config wizard — cannot resolve a user-scope path (no \$AGENTIC_WORKFLOW_USER_CONFIG and no \$HOME)"
      return
    fi
    if [ "${AGENTIC_WORKFLOW_USER_CONFIG-x}" = "" ]; then
      echo "note: \$AGENTIC_WORKFLOW_USER_CONFIG is set to \"\" (user layer disabled at runtime);" >&2
      echo "      writing to $target_config anyway — unset it to have the loop read this file." >&2
    fi
  else
    local dir
    dir="$(ask "Write config for which project directory" "$TARGET_DIR")"
    TARGET_DIR="$dir"
    target_config="$TARGET_DIR/.agentic-workflow.json"
    if [ ! -d "$TARGET_DIR" ]; then
      skip "config wizard — '$TARGET_DIR' is not a directory"
      return
    fi
  fi
  if [ -f "$target_config" ]; then
    skip "$target_config already exists — leaving it untouched"
    return
  fi

  MEMBERS=""
  WORKFLOWS=""

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
    # organization/project/repository are optional here — they can be set later
    # in the project's own .agentic-workflow.json. Only selfLogin is required: a
    # PAT carries no reliable email identity, so comment filtering needs it.
    org="$(ask "Azure DevOps organization URL (blank = set later in the project's .agentic-workflow.json)" "")"
    project="$(ask "Azure DevOps project name (blank = set later in the project's .agentic-workflow.json)" "")"
    repo="$(ask "Repository name (blank = all repos / set later in the project)" "")"
    login="$(ask_required "Your ADO login/email for comment filtering (ado.selfLogin)")"
    if [ -z "$login" ]; then
      skip "config wizard — ado.selfLogin is required for ado (a PAT cannot resolve it; aborted, nothing written)"
      return
    fi
    # Emit only the fields the user supplied; an ado section with just selfLogin
    # is valid (org/project/repo set in the repo file later).
    local ado=""
    [ -n "$org" ]     && ado="${ado:+$ado,}\"organization\":\"$(json_escape "$org")\""
    [ -n "$project" ] && ado="${ado:+$ado,}\"project\":\"$(json_escape "$project")\""
    [ -n "$repo" ]    && ado="${ado:+$ado,}\"repository\":\"$(json_escape "$repo")\""
    ado="${ado:+$ado,}\"selfLogin\":\"$(json_escape "$login")\""
    add_member "\"ado\":{$ado}"
    echo
    echo "  → Azure DevOps auth: a PAT scoped to Code (read) + Pull Request (contribute)."
    echo "    Preferred: export AZURE_DEVOPS_EXT_PAT=<pat>. Or add \"pat\":\"<pat>\" to the"
    echo "    ado section of the (gitignored) .agentic-workflow.json — the env var wins if both are set."
    echo "    Tip: settings shared across repos (organization, selfLogin, pat) can live in a"
    echo "    user-scope ~/.agentic-workflow.json; the repo file overrides it field by field."
  fi

  # Q2 — PR sitter (experimental).
  echo
  if confirm "Enable the PR-sitter loop (experimental — watches your open PRs)?"; then
    if [ "$platform" = "github" ]; then
      local query
      query="$(ask "PR search query" "is:open author:@me")"
      add_workflow "\"pr-sitter\":{\"enabled\":true,\"query\":\"$(json_escape "$query")\"}"
    else
      # query is a GitHub-only knob; on ADO the sitter watches its own PRs.
      add_workflow "\"pr-sitter\":{\"enabled\":true}"
    fi
  fi

  # Q2b — the other sitters (all experimental). One gate, then per-sitter.
  echo
  if confirm "Enable any of the other experimental sitters (review / dep / main)?"; then
    echo "  These are experimental — manifests and config keys may still change."

    # review-sitter — PRs where your review is requested. Comment-only.
    if confirm "  review-sitter — sit on PRs awaiting your review, post one review comment?"; then
      if [ "$platform" = "github" ]; then
        local rquery
        rquery="$(ask "  Review-request search query" "is:open review-requested:@me")"
        add_workflow "\"review-sitter\":{\"enabled\":true,\"query\":\"$(json_escape "$rquery")\"}"
      else
        add_workflow "\"review-sitter\":{\"enabled\":true}"
      fi
    fi

    # dep-sitter — vulnerable/outdated deps. Platform-agnostic source.
    if confirm "  dep-sitter — sit on vulnerable/outdated deps, open a draft PR for patch/minor bumps?"; then
      local floor
      echo "    Minimum advisory severity to act on:"
      echo "      [1] high (default)  [2] critical  [3] moderate  [4] low"
      floor="$(ask "    Choice" "1")"
      case "$floor" in
        2) floor="critical" ;;
        3) floor="moderate" ;;
        4) floor="low" ;;
        *) floor="high" ;;
      esac
      add_workflow "\"dep-sitter\":{\"enabled\":true,\"severityFloor\":\"$floor\"}"
    fi

    # main-sitter — the default branch's CI. Never pushes the watched branch.
    if confirm "  main-sitter — sit on the default branch's CI, open a draft remedy PR when it goes red?"; then
      local mbranch
      mbranch="$(ask "  Watched branch (blank = the remote default branch)" "")"
      if [ -n "$mbranch" ]; then
        add_workflow "\"main-sitter\":{\"enabled\":true,\"branch\":\"$(json_escape "$mbranch")\"}"
      else
        add_workflow "\"main-sitter\":{\"enabled\":true}"
      fi
    fi
  fi

  # Q3 — worktrees. On by default (schema default: worktreesDir=".workflow-worktrees"),
  # so nothing needs writing unless the path is overridden or opted out of.
  echo
  local wt_opt_out=""
  if confirm "Worktree isolation runs by default (.workflow-worktrees) — customize the path or opt out?"; then
    if confirm "  Opt out (use shared-tree branch switching instead)?"; then
      add_member "\"worktreesDir\":false"
      wt_opt_out="1"
    else
      local wtdir
      wtdir="$(ask "  Worktrees directory" ".workflow-worktrees")"
      add_member "\"worktreesDir\":\"$(json_escape "$wtdir")\""
    fi
  fi
  if [ -z "$wt_opt_out" ]; then
    local wtsetup
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

  flush_workflows
  mkdir -p "$(dirname "$target_config")"
  printf '{\n  %s\n}\n' "$MEMBERS" > "$target_config"

  # Safety net: confirm the file parses. We author it deterministically, so a
  # failure here is a bug, not user error — warn, don't fail the install.
  if command -v node >/dev/null 2>&1; then
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$target_config" 2>/dev/null; then
      echo "warning: wrote $target_config but it did not parse as JSON — please review" >&2
      return
    fi
  fi
  ok "wrote $target_config ($scope scope)"
  if [ "$scope" = "user" ]; then
    echo "         (shared across every repo you drive; a repo's own .agentic-workflow.json overrides it field by field)"
  elif [ "$TARGET_DIR" != "$REPO_DIR" ]; then
    echo "         (the loop reads this from the project it runs in — move it if you drive a different repo)"
  fi
}

maybe_configure() {
  if [ "$WANT_CONFIG" -ne 1 ]; then
    skip "config wizard (--no-config)"
    return
  fi
  if [ "$ASSUME_YES" -eq 1 ]; then
    # Non-interactive: honor a forced --user/--repo scope, default to repo.
    local scope="${CONFIG_SCOPE:-repo}" target_config
    if [ "$scope" = "user" ]; then
      target_config="$(user_config_path)"
      if [ -z "$target_config" ]; then
        skip "config wizard — cannot resolve a user-scope path (no \$AGENTIC_WORKFLOW_USER_CONFIG and no \$HOME)"
        return
      fi
    else
      if [ ! -d "$TARGET_DIR" ]; then
        skip "config wizard — '$TARGET_DIR' is not a directory"
        return
      fi
      target_config="$TARGET_DIR/.agentic-workflow.json"
    fi
    if [ -f "$target_config" ]; then
      skip "$target_config already exists — leaving it untouched"
    else
      mkdir -p "$(dirname "$target_config")"
      printf '{}\n' > "$target_config"
      ok "wrote defaults $target_config ($scope scope)"
    fi
    return
  fi
  # Interactive: configure() asks scope and checks existence for that scope.
  if [ -t 0 ] && [ -t 1 ] && [ -z "${CI:-}" ]; then
    configure
  else
    skip "non-interactive shell — run ./install.sh --config to configure, or --yes to seed defaults"
  fi
}

# Ensure a fully-expanded user-scope defaults file exists. A repo-scope file
# stays sparse (only the fields someone actively chose), but the runtime
# layers it OVER this one field-by-field (mergeConfigLayers), so seeding
# every default here once makes every knob visible/adjustable — without
# reading docs/configuration.md or touching this checkout again — for every
# repo the user drives. Idempotent: never touches an existing file. Sitters
# are listed but left `enabled: false` — they open PRs / post PR comments
# under the user's identity, so they must stay an explicit opt-in.
ensure_user_defaults() {
  if [ "$WANT_CONFIG" -ne 1 ]; then
    return
  fi
  local target_config
  target_config="$(user_config_path)"
  if [ -z "$target_config" ]; then
    skip "user-scope defaults — cannot resolve a path (no \$AGENTIC_WORKFLOW_USER_CONFIG and no \$HOME)"
    return
  fi
  if [ -f "$target_config" ]; then
    skip "$target_config already exists — leaving it untouched"
    return
  fi
  if [ "${AGENTIC_WORKFLOW_USER_CONFIG-x}" = "" ]; then
    echo "note: \$AGENTIC_WORKFLOW_USER_CONFIG is set to \"\" (user layer disabled at runtime);" >&2
    echo "      writing to $target_config anyway — unset it to have the loop read this file." >&2
  fi
  mkdir -p "$(dirname "$target_config")"
  cat <<'EOF' > "$target_config"
{
  "maxIterations": 3,
  "tasksDir": "docs/tasks",
  "stageTimeoutMinutes": 60,
  "codePlatform": "github",
  "worktreesDir": ".workflow-worktrees",
  "reviewLenses": [],
  "workflows": {
    "pr-sitter": { "enabled": false, "query": "is:open author:@me" },
    "review-sitter": { "enabled": false, "query": "is:open review-requested:@me" },
    "dep-sitter": { "enabled": false, "severityFloor": "high" },
    "main-sitter": { "enabled": false }
  }
}
EOF

  # Safety net: confirm the file parses. We author it deterministically, so a
  # failure here is a bug, not user error — warn, don't fail the install.
  if command -v node >/dev/null 2>&1; then
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$target_config" 2>/dev/null; then
      echo "warning: wrote $target_config but it did not parse as JSON — please review" >&2
      return
    fi
  fi
  ok "wrote $target_config (user scope, full defaults — shared across every repo you drive)"
  echo "         Every field has a sane default; edit any of them, or flip a sitter's"
  echo "         \"enabled\" to true, to change behavior. What's here:"
  echo "           maxIterations (3)                 — cap on verify/review-FAIL re-builds"
  echo "           tasksDir (\"docs/tasks\")           — root of the task backlog"
  echo "           stageTimeoutMinutes (60)           — wall-clock cap per stage"
  echo "           codePlatform (\"github\")            — or \"ado\" (needs an \"ado\" section)"
  echo "           worktreesDir (\".workflow-worktrees\")   — per-task git worktree isolation; false to opt out"
  echo "           reviewLenses ([])                  — extra REVIEW passes, e.g. [\"security\"]"
  echo "           workflows.pr-sitter    (off) — watches your own open PRs"
  echo "           workflows.review-sitter (off) — comments on PRs awaiting your review"
  echo "           workflows.dep-sitter   (off) — opens draft PRs for vulnerable/outdated deps"
  echo "           workflows.main-sitter  (off) — opens a draft PR when the default branch's CI goes red"
  echo "         See docs/configuration.md for every constraint and the ado/projectManagement sections."
}

# No positional target given: in an interactive shell, let the user pick a host
# (defaulting to what's detected). Non-interactive keeps today's `all` default.
if [ "$TARGET_EXPLICIT" -eq 0 ] && [ -t 0 ] && [ -t 1 ] && [ -z "${CI:-}" ]; then
  select_host
fi

case "$TARGET" in
  opencode) install_opencode ;;
  claude) install_claude ;;
  all)
    install_opencode
    echo
    install_claude
    ;;
  config) echo "Config only — skipping plugin install (OpenCode + Claude Code)." ;;
esac

maybe_configure
ensure_user_defaults
