#!/usr/bin/env bash
# Bootstrap ALL dependencies the agentic-workflow needs, then run the plugin
# installer.
#
# install.sh installs the *plugins* (npm workspaces + symlinks + the bundled
# MCP server) but assumes the system prerequisites already exist. This script
# fills that gap: it verifies/installs the system CLIs (Node 22.13+, git, curl, gh,
# Chrome), registers the chrome-devtools MCP server the loop's skills expect,
# and finally delegates to ./install.sh all.
#
# Auth is never automated — the script only reminds you to run `gh auth login`
# and (for Azure DevOps) export AZURE_DEVOPS_EXT_PAT at the end. Re-run any
# time; every step is idempotent.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 22.13 is the first release where `node:sqlite` works without
# --experimental-sqlite (unflagged in v22.13.0 / v23.4.0); the hub's opencode.db
# token backfill needs it. The minor floor is checked too — 22.0-22.12 would
# pass a major-only test and still fail at import.
NODE_MAJOR_MIN=22
NODE_MINOR_MIN=13
NODE_VERSION_MIN="${NODE_MAJOR_MIN}.${NODE_MINOR_MIN}"

WANT_ADO=1
WANT_BROWSER=1
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Usage:
  ./bootstrap.sh                  # install everything, then ./install.sh all
  ./bootstrap.sh --no-ado         # skip the Azure DevOps prerequisite check
  ./bootstrap.sh --no-browser     # skip Chrome + the chrome-devtools MCP server
  ./bootstrap.sh --check-only     # report status of every dependency, change nothing
  ./bootstrap.sh -h | --help

Covers: Node.js >=22.13, git, curl, gh (GitHub CLI), Google Chrome, the
chrome-devtools MCP server, and the in-repo JS deps (via ./install.sh). Azure
DevOps needs npx (bundled with Node) to launch the Azure DevOps MCP server,
plus a PAT (AZURE_DEVOPS_EXT_PAT). Auth steps are printed, never run for you.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-ado) WANT_ADO=0 ;;
    --no-browser) WANT_BROWSER=0 ;;
    --check-only) CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# platform / package manager detection
# ---------------------------------------------------------------------------
PKG=""            # apt | brew | none
SUDO=""
if command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v brew >/dev/null 2>&1; then
  PKG=brew
else
  PKG=none
fi
if [ "$PKG" = apt ] && [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=""; fi
fi

APT_UPDATED=0
apt_update_once() {
  [ "$APT_UPDATED" -eq 1 ] && return 0
  $SUDO apt-get update -y
  APT_UPDATED=1
}

# Track what we could not do automatically so we can print a summary at the end.
MANUAL_STEPS=()
note_manual() { MANUAL_STEPS+=("$1"); }

# echo helpers ---------------------------------------------------------------
ok()   { echo "ok:      $1"; }
todo() { echo "install: $1"; }
skip() { echo "skip:    $1"; }

# Print instructions instead of installing (check-only, no pkg mgr, or no sudo
# on apt). Returns 0 when the caller should NOT attempt a real install.
cannot_install() {
  if [ "$CHECK_ONLY" -eq 1 ]; then return 0; fi
  if [ "$PKG" = none ]; then return 0; fi
  if [ "$PKG" = apt ] && [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ]; then return 0; fi
  return 1
}

# ---------------------------------------------------------------------------
# node >= 22.13
# ---------------------------------------------------------------------------
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
node_minor() { node -v 2>/dev/null | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/'; }

# 0 when the installed node satisfies NODE_MAJOR_MIN.NODE_MINOR_MIN or newer.
node_ok() {
  local maj="$1" min="$2"
  [ -z "$maj" ] && return 1
  [ "$maj" -gt "$NODE_MAJOR_MIN" ] && return 0
  [ "$maj" -eq "$NODE_MAJOR_MIN" ] && [ "$min" -ge "$NODE_MINOR_MIN" ] && return 0
  return 1
}

ensure_node() {
  local maj="" min=""
  if command -v node >/dev/null 2>&1; then maj="$(node_major)"; min="$(node_minor)"; fi
  if node_ok "$maj" "$min"; then
    ok "node $(node -v) (>= $NODE_VERSION_MIN)"
    return 0
  fi
  if [ -n "$maj" ]; then
    todo "node $(node -v) is too old — need >= $NODE_VERSION_MIN"
  else
    todo "node (>= $NODE_VERSION_MIN) not found"
  fi
  if cannot_install; then
    case "$PKG" in
      apt) note_manual "Node >= $NODE_VERSION_MIN: curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x | sudo -E bash - && sudo apt-get install -y nodejs" ;;
      brew) note_manual "Node: brew install node@${NODE_MAJOR_MIN} && brew link --overwrite --force node@${NODE_MAJOR_MIN}" ;;
      *) note_manual "Node >= $NODE_VERSION_MIN: install from https://nodejs.org/ or via nvm" ;;
    esac
    return 0
  fi
  case "$PKG" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | $SUDO bash -
      $SUDO apt-get install -y nodejs
      ;;
    brew)
      brew install "node@${NODE_MAJOR_MIN}"
      brew link --overwrite --force "node@${NODE_MAJOR_MIN}" || true
      ;;
  esac
  maj="$(node_major)"
  min="$(node_minor)"
  if node_ok "$maj" "$min"; then
    ok "node $(node -v)"
  else
    note_manual "Node install did not yield >= $NODE_VERSION_MIN — check PATH / nvm shadowing"
  fi
}

# ---------------------------------------------------------------------------
# generic apt/brew single-package tools (git, curl)
# ---------------------------------------------------------------------------
ensure_simple() {
  local bin="$1" apt_pkg="$2" brew_pkg="$3"
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin"
    return 0
  fi
  todo "$bin not found"
  if cannot_install; then
    case "$PKG" in
      apt) note_manual "$bin: sudo apt-get install -y $apt_pkg" ;;
      brew) note_manual "$bin: brew install $brew_pkg" ;;
      *) note_manual "$bin: install '$apt_pkg' via your package manager" ;;
    esac
    return 0
  fi
  case "$PKG" in
    apt) apt_update_once; $SUDO apt-get install -y "$apt_pkg" ;;
    brew) brew install "$brew_pkg" ;;
  esac
  command -v "$bin" >/dev/null 2>&1 && ok "$bin"
}

# ---------------------------------------------------------------------------
# gh (GitHub CLI) — needs GitHub's apt repo on Debian/Ubuntu
# ---------------------------------------------------------------------------
ensure_gh() {
  if command -v gh >/dev/null 2>&1; then
    ok "gh $(gh --version 2>/dev/null | head -1 | awk '{print $3}')"
    return 0
  fi
  todo "gh (GitHub CLI) not found"
  if cannot_install; then
    case "$PKG" in
      apt) note_manual "gh: https://github.com/cli/cli/blob/trunk/docs/install_linux.md (add GitHub apt repo, then: sudo apt-get install gh)" ;;
      brew) note_manual "gh: brew install gh" ;;
      *) note_manual "gh: https://github.com/cli/cli#installation" ;;
    esac
    return 0
  fi
  case "$PKG" in
    apt)
      local key=/usr/share/keyrings/githubcli-archive-keyring.gpg
      $SUDO mkdir -p -m 755 /etc/apt/keyrings
      if [ ! -s "$key" ]; then
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | $SUDO tee "$key" >/dev/null
        $SUDO chmod go+r "$key"
      fi
      echo "deb [arch=$(dpkg --print-architecture) signed-by=$key] https://cli.github.com/packages stable main" \
        | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
      $SUDO apt-get update -y
      $SUDO apt-get install -y gh
      ;;
    brew) brew install gh ;;
  esac
  command -v gh >/dev/null 2>&1 && ok "gh installed"
}

# The Azure DevOps MCP server, pinned — its tool NAMES are baked into stage
# prompts and generated agent frontmatter, so a floating version can rename the
# surface out from under them. Mirrors ADO_MCP_PACKAGE in
# packages/core/src/source/ado-tools.ts.
ADO_MCP_PACKAGE="@azure-devops/mcp@2.8.1"

# ---------------------------------------------------------------------------
# Azure DevOps prerequisites (ADO mode only)
# ---------------------------------------------------------------------------
# codePlatform "ado" reaches Azure DevOps ONLY through the Azure DevOps MCP
# server (@azure-devops/mcp, launched with npx), for both the stage agents and
# the engine's own polling/ship calls. Nothing to install: npx fetches the
# pinned version on first use. Auth is a PAT in AZURE_DEVOPS_EXT_PAT, which the
# engine base64-encodes into the server's PERSONAL_ACCESS_TOKEN itself.
# The value @azure-devops/mcp expects in PERSONAL_ACCESS_TOKEN: base64 of
# ":<pat>". The server decodes it, splits on ":" and keeps everything after the
# FIRST colon, so the username half is discarded and an empty one is correct.
# A value with no colon decodes to an empty token and fails opaquely.
ado_mcp_token() {
  printf ':%s' "${AZURE_DEVOPS_EXT_PAT:-}" | base64 | tr -d '\n'
}

# The user-scope config files, in the order core's `resolveUserConfigPath()`
# consults them: the env override (empty disables the layer outright), then the
# XDG file, then the legacy dotted one. Hard-coding only the XDG path meant a
# user whose org lived in `~/.agentic-workflow.json` was read as having none.
ado_user_config_files() {
  if [ -n "${AGENTIC_WORKFLOW_USER_CONFIG+x}" ]; then
    [ -n "$AGENTIC_WORKFLOW_USER_CONFIG" ] && printf '%s\n' "$AGENTIC_WORKFLOW_USER_CONFIG"
    return 0
  fi
  printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/agentic-workflow/agentic-workflow.json"
  printf '%s\n' "$HOME/.agentic-workflow.json"
}

# Whether the REPO's config carries an `ado.organization`. Only to explain why
# it is being ignored — never to use the value. See `ado_org_from_config`.
ado_org_in_repo_config() {
  command -v jq >/dev/null 2>&1 || return 1
  [ -f "$REPO_DIR/.agentic-workflow.json" ] || return 1
  [ -n "$(jq -r '.ado.organization // empty' "$REPO_DIR/.agentic-workflow.json" 2>/dev/null || true)" ]
}

# The organization NAME the server takes as its positional argument, read from
# the configured organization URL (https://dev.azure.com/<org>). Empty when no
# user-scope config has one, in which case registration is skipped and a manual
# note is printed instead of guessing.
#
# USER-SCOPE ONLY, and that is the whole point: `ado.organization` is one of
# core's `ADO_USER_LAYER_ONLY_KEYS`, which `loadConfig` DROPS from a repo's
# `.agentic-workflow.json` so that "a cloned repo cannot aim your PAT at a host
# it chooses". Reading it from the repo layer here honoured exactly the key the
# engine refuses to honour — and did something the engine never does with it:
# registered an MCP server against it, in the user's global opencode config.
ado_org_from_config() {
  [ -n "${ADO_ORG:-}" ] && { printf '%s' "$ADO_ORG"; return 0; }
  command -v jq >/dev/null 2>&1 || return 0
  local url="" f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    url="$(jq -r '.ado.organization // empty' "$f" 2>/dev/null || true)"
    [ -n "$url" ] && break
  done < <(ado_user_config_files)
  [ -n "$url" ] || return 0
  printf '%s' "${url%/}" | sed -E 's#.*/([^/]+)$#\1#'
}
ADO_ORG="$(ado_org_from_config)"

ensure_ado() {
  if [ "$WANT_ADO" -eq 0 ]; then
    skip "Azure DevOps (--no-ado)"
    return 0
  fi
  if command -v npx >/dev/null 2>&1; then
    ok "Azure DevOps: MCP server via npx ($ADO_MCP_PACKAGE)"
  else
    todo "Azure DevOps needs npx (install Node.js 20+)"
  fi
  if [ -n "${AZURE_DEVOPS_EXT_PAT:-}" ]; then
    ok "Azure DevOps: AZURE_DEVOPS_EXT_PAT is set"
  else
    todo "Azure DevOps: export AZURE_DEVOPS_EXT_PAT=<pat> (Code read + PR contribute), or set ado.pat"
  fi
  # Never silent about the ignored repo value: without this, moving the read to
  # the user layer would look exactly like "ADO registration stopped working".
  if [ -z "$ADO_ORG" ] && ado_org_in_repo_config; then
    note_manual "Azure DevOps: .agentic-workflow.json sets ado.organization, which is IGNORED — the engine honours it from your user config only (a cloned repo must not choose where your PAT is sent). Move it to ~/.config/agentic-workflow/agentic-workflow.json and re-run."
  fi
}

# ---------------------------------------------------------------------------
# Chrome — required by chrome-devtools-mcp (it does NOT bundle a browser)
# ---------------------------------------------------------------------------
have_chrome() {
  local b
  for b in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$b" >/dev/null 2>&1 && { echo "$b"; return 0; }
  done
  return 1
}

ensure_chrome() {
  if [ "$WANT_BROWSER" -eq 0 ]; then
    skip "Chrome / chrome-devtools (--no-browser)"
    return 0
  fi
  local found
  if found="$(have_chrome)"; then
    ok "chrome: $found"
    return 0
  fi
  todo "Chrome/Chromium not found (chrome-devtools-mcp needs a system browser)"
  if cannot_install; then
    case "$PKG" in
      apt) note_manual "Chrome: install google-chrome-stable — https://www.google.com/chrome/ (or: sudo apt-get install -y chromium)" ;;
      brew) note_manual "Chrome: brew install --cask google-chrome" ;;
      *) note_manual "Chrome: install a current stable Google Chrome / Chromium" ;;
    esac
    return 0
  fi
  case "$PKG" in
    apt)
      local key=/usr/share/keyrings/google-chrome.gpg
      $SUDO mkdir -p /etc/apt/keyrings
      if [ ! -s "$key" ]; then
        curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | $SUDO gpg --dearmor -o "$key"
      fi
      echo "deb [arch=amd64 signed-by=$key] https://dl.google.com/linux/chrome/deb/ stable main" \
        | $SUDO tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
      $SUDO apt-get update -y
      $SUDO apt-get install -y google-chrome-stable
      ;;
    brew) brew install --cask google-chrome ;;
  esac
  have_chrome >/dev/null && ok "chrome installed"
}

# ---------------------------------------------------------------------------
# External MCP server: chrome-devtools (idempotent, user-global config)
# ---------------------------------------------------------------------------

register_mcp_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    echo "claude CLI not found — add these to .mcp.json / Claude settings manually:"
    if [ "$WANT_BROWSER" -eq 1 ]; then
      echo '    "chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest", "--isolated"] }'
    fi
    return 0
  fi

  local existing
  existing="$(claude mcp list 2>/dev/null || true)"

  if [ "$WANT_BROWSER" -eq 1 ]; then
    if printf '%s' "$existing" | grep -q '^chrome-devtools'; then
      ok "mcp(claude): chrome-devtools"
    elif [ "$CHECK_ONLY" -eq 1 ]; then
      todo "mcp(claude): chrome-devtools (would register)"
    else
      claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --isolated \
        && ok "mcp(claude): chrome-devtools registered"
    fi
  fi

  # The stage agents call Azure DevOps through this server, and the tool names
  # in their prompts hard-code the server NAME `azure-devops` — registering it
  # under any other name makes every ADO stage call a tool that does not exist.
  if [ "$WANT_ADO" -eq 1 ] && [ -n "$ADO_ORG" ]; then
    if printf '%s' "$existing" | grep -q '^azure-devops'; then
      ok "mcp(claude): azure-devops"
    elif [ "$CHECK_ONLY" -eq 1 ]; then
      todo "mcp(claude): azure-devops (would register)"
    else
      claude mcp add azure-devops --env "PERSONAL_ACCESS_TOKEN=$(ado_mcp_token)" \
        -- npx -y "$ADO_MCP_PACKAGE" "$ADO_ORG" -d repositories -d pipelines -a pat \
        && ok "mcp(claude): azure-devops registered"
    fi
  fi
}

register_mcp_opencode() {
  local cfg_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
  local cfg="$cfg_dir/opencode.json"

  if ! command -v jq >/dev/null 2>&1; then
    echo "jq not found — add an \"mcp\" block to $cfg manually:"
    [ "$WANT_BROWSER" -eq 1 ] && echo '    "chrome-devtools": { "type": "local", "command": ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"], "enabled": true }'
    return 0
  fi

  if [ "$CHECK_ONLY" -eq 1 ]; then
    todo "mcp(opencode): would merge chrome-devtools into $cfg"
    return 0
  fi

  mkdir -p "$cfg_dir"
  [ -f "$cfg" ] || echo '{}' > "$cfg"

  local tmp; tmp="$(mktemp)"
  # Merge without clobbering existing keys; our entries win only for their names.
  local filter='.mcp = (.mcp // {})'
  # Every value that comes from OUTSIDE this script travels as a jq ARGUMENT,
  # never as jq program text. `$pkg` is a constant and is here only so the array
  # is never empty (`"${jqargs[@]}"` on an empty array is an unbound-variable
  # error under `set -u` on bash 3.2, which is what macOS ships).
  local -a jqargs=(--arg pkg "$ADO_MCP_PACKAGE")
  if [ "$WANT_BROWSER" -eq 1 ]; then
    filter="$filter"' | .mcp["chrome-devtools"] = {"type":"local","command":["npx","-y","chrome-devtools-mcp@latest","--isolated"],"enabled":true}'
  fi
  # Same fixed name as the Claude side — the stage prompts hard-code it.
  #
  # `$org`/`$pat` are interpolated by JQ, not by the shell. Spliced into the
  # program text they were a straight injection: the org is read out of a config
  # file, so a value carrying a `"` closed the string literal and everything
  # after it parsed AS JQ — and jq comments (`#`) swallow the rest of the line.
  # That let a config choose any key in the user's global opencode.json,
  # `.mcp["<anything>"] = {"command":["sh","-c",…]}` included, which opencode
  # launches on next start. The same splice broke the merge outright for any org
  # or PAT containing a quote or backslash: jq failed, `2>/dev/null` ate the
  # parse error, and the user got "edit it by hand".
  if [ "$WANT_ADO" -eq 1 ] && [ -n "$ADO_ORG" ]; then
    jqargs+=(--arg org "$ADO_ORG" --arg pat "$(ado_mcp_token)")
    filter="$filter"' | .mcp["azure-devops"] = {"type":"local","command":["npx","-y",$pkg,$org,"-d","repositories","-d","pipelines","-a","pat"],"environment":{"PERSONAL_ACCESS_TOKEN":$pat},"enabled":true}'
  fi
  if jq "${jqargs[@]}" "$filter" "$cfg" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$cfg"
    ok "mcp(opencode): merged into $cfg"
  else
    rm -f "$tmp"
    note_manual "opencode MCP: failed to merge into $cfg — edit it by hand"
  fi
}

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
echo "agentic-workflow bootstrap — pkg manager: $PKG"
[ "$CHECK_ONLY" -eq 1 ] && echo "(check-only: reporting status, changing nothing)"
echo

echo "== system CLIs =="
ensure_node
ensure_simple git git git
ensure_simple curl curl curl
ensure_gh
ensure_ado
ensure_chrome
echo

echo "== external MCP servers =="
register_mcp_claude
register_mcp_opencode
echo

if [ "$CHECK_ONLY" -eq 0 ]; then
  echo "== plugins (delegating to install.sh) =="
  "$REPO_DIR/install.sh" all
  echo
else
  echo "== plugins =="
  skip "install.sh (check-only) — run ./install.sh all to install the plugins"
  echo
fi

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
if [ "${#MANUAL_STEPS[@]}" -gt 0 ]; then
  echo "== manual steps needed =="
  for step in "${MANUAL_STEPS[@]}"; do
    echo "  - $step"
  done
  echo
fi

echo "== next: authenticate (not automated) =="
echo "  - GitHub:       gh auth login"
if [ "$WANT_ADO" -eq 1 ]; then
  echo "  - Azure DevOps: export AZURE_DEVOPS_EXT_PAT=<pat>   (Code read + Pull Request contribute scopes)"
  echo "    (or put \"pat\" — with organization/selfLogin — in a user-scope config"
  echo "     (\${XDG_CONFIG_HOME:-~/.config}/agentic-workflow/agentic-workflow.json), shared"
  echo "     across repos; the env var wins if both are set)"
fi
if [ "$WANT_BROWSER" -eq 1 ]; then
  echo "  - chrome-devtools MCP launches its own isolated Chrome profile on first use."
fi
echo
echo "Done. Re-run this script any time — it is idempotent."
