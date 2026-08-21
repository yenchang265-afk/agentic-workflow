#!/usr/bin/env pwsh
# Windows port of install.sh (same behavior, same flags). Install the
# agentic-workflow plugins.
#
# OpenCode half: symlinks agents/commands/skills/references into an OpenCode
# config directory (global by default: ~/.config/opencode, or
# $env:OPENCODE_CONFIG_DIR if set) so `git pull` in this repo keeps the
# install up to date, and registers the plugin itself as a local plugin file.
# Claude Code half: delegates to plugins/claude/install.ps1, which builds the
# bundled MCP server and links the shared skills/references into the plugin.
# Re-run any time; both halves are idempotent.
#
# Creating symlinks on Windows needs Administrator or Developer Mode
# (Windows 10/11 Settings > Update & Security > For developers). Without
# either, this script automatically falls back to copies (pass -Copy to do
# that on purpose and silence the warning; re-run after `git pull` to refresh
# a copy install).

$ErrorActionPreference = 'Stop'

function Show-Usage {
    @'
Usage:
  .\install.ps1                    # interactive: detect installed hosts and let you pick
                                    #   (non-interactive with no target installs only the
                                    #    detected host(s); both when neither CLI is found)
  .\install.ps1 opencode           # OpenCode only: symlink into $env:OPENCODE_CONFIG_DIR or ~/.config/opencode
  .\install.ps1 claude             # Claude Code only: build mcp-server + link shared skills/references
  .\install.ps1 qwen               # Qwen Code only: build mcp-server, install agents/commands/skills into
                                    #   $env:QWEN_CONFIG_DIR or ~/.qwen, and merge hooks + MCP into settings.json
  .\install.ps1 all                # explicit all (OpenCode + Claude Code + Qwen Code)
  .\install.ps1 config             # config only: run the wizard, install no plugin files
  .\install.ps1 [opencode] --copy  # copy instead of symlink (OpenCode half only)
  .\install.ps1 [opencode] <dir>   # install the OpenCode half into an arbitrary config dir
  .\install.ps1 qwen <dir>         # install the Qwen half into an arbitrary config dir
                                    # (a dir literally named "claude"/"opencode"/"qwen"/"all"/"config" needs a path prefix, e.g. .\claude)

After installing, a short wizard offers to write an initial .agentic-workflow.json
into the project the loop will drive (interactive terminals only):
  --config                        # force the config wizard on
  --no-config                     # skip the config wizard (also skips the
                                   # user-scope defaults file below)
  --user                          # write config to the user scope (see path below), not the repo
  --repo                          # write config to the project's .agentic-workflow.json (default)
  -y, --yes                       # non-interactive: seed a defaults .agentic-workflow.json, no prompts

Every run (regardless of the above) also seeds a fully-expanded user-scope config
at ${env:XDG_CONFIG_HOME}\agentic-workflow\agentic-workflow.json (default
~\.config\agentic-workflow\agentic-workflow.json) — every field at its default,
every sitter listed with enabled:false — if one doesn't already exist there, so
every knob is visible without reading docs/configuration.md.
Never overwrites an existing file; a pre-XDG ~\.agentic-workflow.json is still read
as a fallback and left untouched.

To reverse an install: .\uninstall.ps1 [opencode|claude|qwen|all].
'@
}

$RepoDir = $PSScriptRoot
$Target = 'all'
# $true once a positional target (opencode/claude/qwen/all/both/config) is given, so the
# host-selection menu only runs when the user let the target default.
$TargetExplicit = $false
$Mode = 'symlink'
$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $HOME '.config\opencode' }
# Qwen Code reads ~/.qwen; the override exists so CI can round-trip into a temp
# dir, mirroring OPENCODE_CONFIG_DIR above.
$QwenConfigDir = if ($env:QWEN_CONFIG_DIR) { $env:QWEN_CONFIG_DIR } else { Join-Path $HOME '.qwen' }
$WantConfig = $true
$AssumeYes = $false
# Config scope the wizard writes to: "" = ask, "repo" = <project>\.agentic-workflow.json,
# "user" = the user-scope file shared across every repo. Forced by --repo/--user.
$ConfigScope = ''
# The directory the plugin actually reads .agentic-workflow.json from at runtime:
# the Claude host uses $env:AGENTIC_WORKFLOW_DIR ?? cwd, the OpenCode host the project
# dir. Default the wizard's target to that same resolution; it is prompted for.
$TargetDir = if ($env:AGENTIC_WORKFLOW_DIR) { $env:AGENTIC_WORKFLOW_DIR } else { (Get-Location).Path }
$PositionalDir = $null

# Where the user-scope config lives, mirroring core's resolveUserConfigPath:
# $env:AGENTIC_WORKFLOW_USER_CONFIG when set non-empty wins; else
# ${env:XDG_CONFIG_HOME}\agentic-workflow\agentic-workflow.json (default
# ~\.config\...), falling back on read to the pre-XDG ~\.agentic-workflow.json
# when only that exists. Echoes $null if no path can be resolved.
function Get-UserConfigPath {
    if ($env:AGENTIC_WORKFLOW_USER_CONFIG) { return $env:AGENTIC_WORKFLOW_USER_CONFIG }
    if (-not $HOME) { return $null }
    $configHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }
    $primary = Join-Path $configHome 'agentic-workflow\agentic-workflow.json'
    $legacy = Join-Path $HOME '.agentic-workflow.json'
    if (Test-Path -LiteralPath $primary) { return $primary }
    if (Test-Path -LiteralPath $legacy) { return $legacy }
    return $primary
}

foreach ($arg in $args) {
    if ($arg -in @('opencode', 'claude', 'qwen', 'all', 'config')) { $Target = $arg; $TargetExplicit = $true }
    elseif ($arg -eq 'both') { $Target = 'all'; $TargetExplicit = $true }
    elseif ($arg -eq '--copy') { $Mode = 'copy' }
    elseif ($arg -eq '--config') { $WantConfig = $true }
    elseif ($arg -eq '--no-config') { $WantConfig = $false }
    elseif ($arg -eq '--user') { $ConfigScope = 'user' }
    elseif ($arg -eq '--repo') { $ConfigScope = 'repo' }
    elseif ($arg -in @('-y', '--yes')) { $AssumeYes = $true }
    elseif ($arg -in @('-h', '--help')) { Show-Usage; exit 0 }
    elseif ($arg.StartsWith('-')) {
        # Reject an unknown flag rather than silently treating it as the config
        # dir. Matches bootstrap.sh. A bare path is still accepted below.
        Write-Host "unknown option: $arg"
        Show-Usage
        exit 1
    }
    else { $PositionalDir = $arg }
}

# Route the positional config dir to the named host. Defaults to OpenCode, which
# is the only host that accepted one before Qwen existed.
if ($PositionalDir) {
    if ($Target -eq 'qwen') { $QwenConfigDir = $PositionalDir } else { $ConfigDir = $PositionalDir }
}

$script:SymlinkWarned = $false

# Removes whatever is at $Dest, then creates a symlink from $Dest -> $Source
# (falling back to a copy if symlink creation isn't permitted), or copies
# outright in --copy mode.
function New-LinkOrCopy {
    param([string]$Source, [string]$Dest)
    $existing = Get-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
    if ($existing) {
        Remove-Item -LiteralPath $Dest -Recurse -Force
    }
    if ($Mode -eq 'copy') {
        Copy-Item -LiteralPath $Source -Destination $Dest -Recurse -Force
        Write-Host "installed: $Dest"
        return
    }
    try {
        New-Item -ItemType SymbolicLink -Path $Dest -Target $Source | Out-Null
        Write-Host "installed: $Dest"
    } catch {
        if (-not $script:SymlinkWarned) {
            Write-Warning "Cannot create symlinks (needs Administrator or Developer Mode on Windows 10/11). Falling back to copies for this run — pass -Copy to silence this, or enable Developer Mode / run elevated for live symlinks that track 'git pull'."
            $script:SymlinkWarned = $true
        }
        Copy-Item -LiteralPath $Source -Destination $Dest -Recurse -Force
        Write-Host "installed (copy fallback): $Dest"
    }
}

# $null when $Path isn't a symlink/reparse point.
function Get-SymlinkTarget {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    if ($item.LinkType -ne 'SymbolicLink' -and $item.LinkType -ne 'Junction') { return $null }
    $t = $item.Target
    if ($t -is [array]) { return $t[0] }
    return $t
}

function Install-OpenCode {
    Write-Host "Installing agentic-workflow for OpenCode ($Mode) into $ConfigDir"

    foreach ($sub in @('agents', 'commands', 'skills', 'references', 'plugins')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $ConfigDir $sub) | Out-Null
    }

    # Drop symlinks that point back into this repo but whose source is gone —
    # e.g. commands/task.md after its rename to workflow-plan.md.
    foreach ($sub in @('agents', 'commands', 'skills', 'references')) {
        $dir = Join-Path $ConfigDir $sub
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($entry in Get-ChildItem -Path $dir -Force -ErrorAction SilentlyContinue) {
            $target = Get-SymlinkTarget $entry.FullName
            if ($target -and $target.StartsWith($RepoDir) -and -not (Test-Path -LiteralPath $target)) {
                Remove-Item -LiteralPath $entry.FullName -Force
                Write-Host "removed (dangling): $($entry.FullName)"
            }
        }
    }

    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'plugins\opencode\agents') -Filter '*.md' -File) {
        New-LinkOrCopy -Source $f.FullName -Dest (Join-Path $ConfigDir "agents\$($f.Name)")
    }

    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'plugins\opencode\commands') -Filter '*.md' -File) {
        New-LinkOrCopy -Source $f.FullName -Dest (Join-Path $ConfigDir "commands\$($f.Name)")
    }

    foreach ($d in Get-ChildItem -Path (Join-Path $RepoDir 'skills') -Directory) {
        New-LinkOrCopy -Source $d.FullName -Dest (Join-Path $ConfigDir "skills\$($d.Name)")
    }

    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'references') -Filter '*.md' -File) {
        New-LinkOrCopy -Source $f.FullName -Dest (Join-Path $ConfigDir "references\$($f.Name)")
    }

    # The plugin itself: a local plugin file that re-exports this repo's entry
    # point. OpenCode auto-loads any file dropped in plugins/, no opencode.json
    # edit needed. Requires `pnpm install` to have been run in $RepoDir.
    $pluginFile = Join-Path $ConfigDir 'plugins\agentic-workflow.ts'
    $importPath = ($RepoDir -replace '\\', '/') + '/plugins/opencode/src/index.ts'
    Set-Content -LiteralPath $pluginFile -Value "export * from `"$importPath`"" -NoNewline:$false -Encoding utf8
    Write-Host "installed: $pluginFile"

    if (-not (Test-Path -LiteralPath (Join-Path $RepoDir 'node_modules')) -or -not (Test-Path -LiteralPath (Join-Path $RepoDir 'packages\core\dist'))) {
        Write-Host ""
        Write-Warning "dependencies not built — run 'pnpm install' in $RepoDir (it also builds the @agentic-workflow/core workspace the plugin imports)"
    }

    Write-Host ""
    Write-Host "OpenCode: /agentic-workflow:engineering and the bundled skills are available in every OpenCode session."
}

function Install-Claude {
    Write-Host "Installing agentic-workflow for Claude Code (plugins\claude\)"
    if ($Mode -eq 'copy') {
        Write-Host "note: --copy applies to the OpenCode install only"
    }
    & (Join-Path $RepoDir 'plugins\claude\install.ps1')
    if ($LASTEXITCODE -ne 0) { throw "plugins\claude\install.ps1 failed with exit code $LASTEXITCODE" }
}

# Qwen Code half. Unlike the Claude plugin (which the host loads in place from
# a --plugin-dir) Qwen has no plugin-dir concept, so this installs INTO the
# Qwen config dir, the way the OpenCode half does: symlinks for everything
# static, plus two things symlinks can't express —
#   * agents are COPIES, because each one's `model:` is baked in from config
#     (Qwen's `agent` tool takes no per-call model), and
#   * hooks + the MCP server are merged into settings.json, because Qwen
#     extensions cannot carry hooks at all and the guard hooks ARE the safety
#     substrate.
function Install-Qwen {
    Write-Host "Installing agentic-workflow for Qwen Code ($QwenConfigDir)"
    if ($Mode -eq 'copy') {
        Write-Host "note: --copy applies to the OpenCode install only"
    }

    # The MCP server is shared with the Claude host; build it the same way.
    Push-Location $RepoDir
    try {
        # -ErrorAction SilentlyContinue: $ErrorActionPreference = 'Stop' above would
        # otherwise turn a missing command into a terminating error before the check.
        if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
            throw "pnpm is required to build the MCP server - install it with 'npm i -g pnpm' (or see https://pnpm.io/installation)"
        }
        & pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
        & pnpm --filter agentic-workflow-mcp run build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    foreach ($sub in @('commands\agentic-workflow', 'skills', 'references')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $QwenConfigDir $sub) | Out-Null
    }

    # Sweep our own dangling links first, so a renamed source doesn't linger.
    foreach ($sub in @('commands\agentic-workflow', 'skills', 'references')) {
        $dir = Join-Path $QwenConfigDir $sub
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($entry in Get-ChildItem -Path $dir -Force -ErrorAction SilentlyContinue) {
            $target = Get-SymlinkTarget $entry.FullName
            if ($target -and $target.StartsWith($RepoDir) -and -not (Test-Path -LiteralPath $target)) {
                Remove-Item -LiteralPath $entry.FullName -Force
            }
        }
    }

    # Commands land under a namespace dir, which is what makes Qwen render them as
    # /agentic-workflow:engineering — byte-identical names to the other two hosts.
    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'plugins\qwen\commands') -Filter '*.md' -File) {
        New-LinkOrCopy -Source $f.FullName -Dest (Join-Path $QwenConfigDir "commands\agentic-workflow\$($f.Name)")
    }

    # The shared skill library, with the loop's own driving protocol taken from the
    # Qwen rendering rather than the OpenCode one.
    foreach ($d in Get-ChildItem -Path (Join-Path $RepoDir 'skills') -Directory) {
        if ($d.Name -eq 'workflow-orchestration') { continue }
        New-LinkOrCopy -Source $d.FullName -Dest (Join-Path $QwenConfigDir "skills\$($d.Name)")
    }
    New-LinkOrCopy -Source (Join-Path $RepoDir 'plugins\qwen\skills\workflow-orchestration') -Dest (Join-Path $QwenConfigDir 'skills\workflow-orchestration')

    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'references') -Filter '*.md' -File) {
        New-LinkOrCopy -Source $f.FullName -Dest (Join-Path $QwenConfigDir "references\$($f.Name)")
    }

    # Agents are generated, not linked: `model:` is baked in from config.
    & node (Join-Path $RepoDir 'scripts\qwen-agents.mjs') $QwenConfigDir $TargetDir
    if ($LASTEXITCODE -ne 0) { throw "qwen-agents.mjs failed with exit code $LASTEXITCODE" }

    # Hooks + MCP server, merged into settings.json without disturbing the rest.
    & node (Join-Path $RepoDir 'scripts\qwen-settings.mjs') merge `
        $QwenConfigDir `
        (Join-Path $RepoDir 'plugins\qwen') `
        (Join-Path $RepoDir 'plugins\claude\mcp-server\dist\server.js')
    if ($LASTEXITCODE -ne 0) { throw "qwen-settings.mjs merge failed with exit code $LASTEXITCODE" }

    Write-Host ""
    Write-Host "Qwen Code: restart the session, then run /agentic-workflow:engineering status"
    Write-Host "           (re-run this installer after changing stageModels/agentModels —"
    Write-Host "            Qwen binds a subagent's model statically, at install time)"
}

# ---------------------------------------------------------------------------
# Config wizard: writes an initial .agentic-workflow.json into the project the
# loop will drive.
# ---------------------------------------------------------------------------

# Read-Answer "Prompt" "default" -> the answer, or the default when blank.
function Read-Answer {
    param([string]$Prompt, [string]$Default = '')
    $label = if ($Default) { "$Prompt [$Default]" } else { $Prompt }
    $reply = Read-Host $label
    if ([string]::IsNullOrEmpty($reply)) { return $Default }
    return $reply
}

# Read-RequiredAnswer "Prompt" -> re-asks until non-empty; may return empty
# after the bounded retries (caller must check and abort rather than emit a
# partial file).
function Read-RequiredAnswer {
    param([string]$Prompt)
    $reply = ''
    $tries = 0
    while ([string]::IsNullOrEmpty($reply) -and $tries -lt 5) {
        $reply = Read-Host $Prompt
        $tries++
    }
    return $reply
}

# Confirm-Prompt "Prompt" -> $true for yes, $false for no (default No).
function Confirm-Prompt {
    param([string]$Prompt)
    $reply = Read-Host "$Prompt [y/N]"
    return ($reply -match '^(?i:y|yes)$')
}

function Test-Interactive {
    return (-not $env:CI) -and [Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)
}

function Invoke-ConfigWizard {
    Write-Host ""
    Write-Host "== config (.agentic-workflow.json) =="
    Write-Host "A few questions to seed an initial config. Blank accepts the [default]."

    # Q0a — scope: user-scope (shared across every repo) or repo-scope (this
    # project only). The runtime layers repo OVER user, so shared settings
    # (ado org/selfLogin/pat, maxIterations) belong in user scope and
    # project-specific ones (a PR query, worktreesDir) in the repo file.
    $scope = $ConfigScope
    if (-not $scope) {
        Write-Host ""
        Write-Host "Where should this config be written?"
        Write-Host "  [1] This project only — <dir>\.agentic-workflow.json (repo scope, default)"
        Write-Host "  [2] User scope — shared across every repo you drive"
        $choice = Read-Answer "Choice" "1"
        $scope = if ($choice -eq '2') { 'user' } else { 'repo' }
    }

    # Q0b — resolve the destination path for the chosen scope.
    $targetConfig = $null
    if ($scope -eq 'user') {
        $targetConfig = Get-UserConfigPath
        if (-not $targetConfig) {
            Write-Host "skip:    config wizard — cannot resolve a user-scope path (no `$env:AGENTIC_WORKFLOW_USER_CONFIG and no `$HOME)"
            return
        }
        if ($env:AGENTIC_WORKFLOW_USER_CONFIG -eq '') {
            Write-Host "note: `$env:AGENTIC_WORKFLOW_USER_CONFIG is set to '' (user layer disabled at runtime); writing to $targetConfig anyway — unset it to have the loop read this file."
        }
    } else {
        $dir = Read-Answer "Write config for which project directory" $TargetDir
        $script:TargetDir = $dir
        $targetConfig = Join-Path $script:TargetDir '.agentic-workflow.json'
        if (-not (Test-Path -LiteralPath $script:TargetDir -PathType Container)) {
            Write-Host "skip:    config wizard — '$($script:TargetDir)' is not a directory"
            return
        }
    }
    if (Test-Path -LiteralPath $targetConfig) {
        Write-Host "skip:    $targetConfig already exists — leaving it untouched"
        return
    }

    $config = [ordered]@{}
    $workflows = [ordered]@{}

    # Q1 — code platform.
    Write-Host ""
    Write-Host "Which code platform do your PRs live on?"
    Write-Host "  [1] GitHub (default)"
    Write-Host "  [2] Azure DevOps (MCP server + PAT)"
    $choice = Read-Answer "Choice" "1"
    $platform = if ($choice -eq '2') { 'ado' } else { 'github' }
    $config['codePlatform'] = $platform

    if ($platform -eq 'ado') {
        # organization/project/repository are optional here — they can be set later
        # in the project's own .agentic-workflow.json. Only selfLogin is required: a
        # PAT carries no reliable email identity, so comment filtering needs it.
        $org = Read-Answer "Azure DevOps organization URL (blank = set later in the project's .agentic-workflow.json)" ""
        $project = Read-Answer "Azure DevOps project name (blank = set later in the project's .agentic-workflow.json)" ""
        $repo = Read-Answer "Repository name (blank = all repos / set later in the project)" ""
        $login = Read-RequiredAnswer "Your ADO login/email for comment filtering (ado.selfLogin)"
        if (-not $login) {
            Write-Host "skip:    config wizard — ado.selfLogin is required for ado (a PAT cannot resolve it; aborted, nothing written)"
            return
        }
        $ado = [ordered]@{}
        if ($org) { $ado['organization'] = $org }
        if ($project) { $ado['project'] = $project }
        if ($repo) { $ado['repository'] = $repo }
        $ado['selfLogin'] = $login
        $config['ado'] = $ado
        Write-Host ""
        Write-Host "  -> Azure DevOps is reached through the Azure DevOps MCP server, launched"
        Write-Host "     with npx — nothing to install. Auth is a PAT scoped to Code (read) +"
        Write-Host "     Pull Request (contribute)."
        Write-Host "     Preferred: `$env:AZURE_DEVOPS_EXT_PAT='<pat>'. Or add `"pat`":`"<pat>`" to the"
        Write-Host "     ado section of the (gitignored) .agentic-workflow.json — the env var wins if both are set."
        Write-Host "     For the STAGE AGENTS, the server must also be registered with your host"
        Write-Host "     under exactly the name `"azure-devops`" — the tool names in their prompts"
        Write-Host "     hard-code it."
        Write-Host "     Tip: settings shared across repos (organization, selfLogin, pat) can live in a"
        Write-Host "     user-scope config; the repo file overrides it field by field."
    }

    # Q2 — PR sitter (experimental).
    Write-Host ""
    if (Confirm-Prompt "Enable the PR-sitter loop (experimental — watches your open PRs)?") {
        if ($platform -eq 'github') {
            $query = Read-Answer "PR search query" "is:open author:@me"
            $workflows['pr-sitter'] = [ordered]@{ enabled = $true; query = $query }
        } else {
            # query is a GitHub-only knob; on ADO the sitter watches its own PRs.
            $workflows['pr-sitter'] = [ordered]@{ enabled = $true }
        }
    }

    # Q2b — the other sitters (all experimental). One gate, then per-sitter.
    Write-Host ""
    if (Confirm-Prompt "Enable any of the other experimental sitters (review / dep / main)?") {
        Write-Host "  These are experimental — manifests and config keys may still change."

        if (Confirm-Prompt "  review-sitter — sit on PRs awaiting your review, post one review comment?") {
            if ($platform -eq 'github') {
                $rquery = Read-Answer "  Review-request search query" "is:open review-requested:@me"
                $workflows['review-sitter'] = [ordered]@{ enabled = $true; query = $rquery }
            } else {
                $workflows['review-sitter'] = [ordered]@{ enabled = $true }
            }
        }

        if (Confirm-Prompt "  dep-sitter — sit on vulnerable/outdated deps, open a draft PR for patch/minor bumps?") {
            Write-Host "    Minimum advisory severity to act on:"
            Write-Host "      [1] high (default)  [2] critical  [3] moderate  [4] low"
            $floorChoice = Read-Answer "    Choice" "1"
            $floor = switch ($floorChoice) {
                '2' { 'critical' }
                '3' { 'moderate' }
                '4' { 'low' }
                default { 'high' }
            }
            $workflows['dep-sitter'] = [ordered]@{ enabled = $true; severityFloor = $floor }
        }

        if (Confirm-Prompt "  main-sitter — sit on the default branch's CI, open a draft remedy PR when it goes red?") {
            $mbranch = Read-Answer "  Watched branch (blank = the remote default branch)" ""
            if ($mbranch) {
                $workflows['main-sitter'] = [ordered]@{ enabled = $true; branch = $mbranch }
            } else {
                $workflows['main-sitter'] = [ordered]@{ enabled = $true }
            }
        }
    }

    # Q3 — worktrees. On by default (schema default: worktreesDir=".workflow-worktrees"),
    # so nothing needs writing unless the path is overridden or opted out of.
    Write-Host ""
    $wtOptOut = $false
    if (Confirm-Prompt "Worktree isolation runs by default (.workflow-worktrees) — customize the path or opt out?") {
        if (Confirm-Prompt "  Opt out (use shared-tree branch switching instead)?") {
            $config['worktreesDir'] = $false
            $wtOptOut = $true
        } else {
            $wtdir = Read-Answer "  Worktrees directory" ".workflow-worktrees"
            $config['worktreesDir'] = $wtdir
        }
    }
    if (-not $wtOptOut) {
        $wtsetup = Read-Answer "Setup command to run in a fresh worktree (blank = none, e.g. npm ci)" ""
        if ($wtsetup) { $config['worktreeSetup'] = $wtsetup }
    }

    # Advanced (single gate).
    Write-Host ""
    if (Confirm-Prompt "Configure advanced options (task tracker, multi-pass review, iterations)?") {
        Write-Host ""
        Write-Host "Team task tracker?"
        Write-Host "  [1] none (default)"
        Write-Host "  [2] Jira"
        Write-Host "  [3] Azure DevOps"
        $tracker = Read-Answer "Choice" "1"
        $system = switch ($tracker) {
            '2' { 'jira' }
            '3' { 'azure-devops' }
            default { $null }
        }
        if ($system) {
            $pm = [ordered]@{ system = $system }
            $baseurl = Read-Answer "Deep-link base URL (blank = none)" ""
            if ($baseurl) {
                if ($baseurl -match '^https?://') {
                    $pm['baseUrl'] = $baseurl
                } else {
                    Write-Host "note: '$baseurl' is not an http(s) URL — skipping baseUrl"
                }
            }
            $deftype = Read-Answer "Default issue/work-item type (blank = none, e.g. story)" ""
            if ($deftype) { $pm['defaultType'] = $deftype }
            $config['projectManagement'] = $pm
        }

        # This used to ask for "extra review lenses" and write the top-level
        # reviewLenses. Both halves were wrong. Lenses REPLACED the single review
        # pass rather than adding to it, so the one-lens answer this prompt
        # invited ("security") turned a review admitted against all five axes
        # into one pass admitted against none — a coverage loss, offered as an
        # enhancement. The key is retired; the multi-pass review now lives on the
        # stage as workflows.engineering.stageFanout.review, and "axis" is the
        # form that covers every required axis AND enforces it per pass.
        if (Confirm-Prompt "Run REVIEW as one focused pass per axis (5 passes, stronger but ~5x the review cost)?") {
            $workflows['engineering'] = [ordered]@{ stageFanout = [ordered]@{ review = 'axis' } }
        }

        $iters = Read-Answer "Max loop iterations" "3"
        if ($iters -and $iters -ne '3') {
            if ($iters -match '^\d+$' -and [int]$iters -gt 0) {
                $config['maxIterations'] = [int]$iters
            } elseif ($iters -notmatch '^\d+$') {
                Write-Host "note: '$iters' is not a positive integer — using default (3)"
            } else {
                Write-Host "note: maxIterations must be positive — using default (3)"
            }
        }
    }

    if ($workflows.Count -gt 0) { $config['workflows'] = $workflows }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetConfig) | Out-Null
    ($config | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $targetConfig -Encoding utf8

    Write-Host "ok:      wrote $targetConfig ($scope scope)"
    if ($scope -eq 'user') {
        Write-Host "         (shared across every repo you drive; a repo's own .agentic-workflow.json overrides it field by field)"
    } elseif ($script:TargetDir -ne $RepoDir) {
        Write-Host "         (the loop reads this from the project it runs in — move it if you drive a different repo)"
    }
}

function Invoke-MaybeConfigure {
    if (-not $WantConfig) {
        Write-Host "skip:    config wizard (--no-config)"
        return
    }
    if ($AssumeYes) {
        # Non-interactive: honor a forced --user/--repo scope, default to repo.
        $scope = if ($ConfigScope) { $ConfigScope } else { 'repo' }
        $targetConfig = $null
        if ($scope -eq 'user') {
            $targetConfig = Get-UserConfigPath
            if (-not $targetConfig) {
                Write-Host "skip:    config wizard — cannot resolve a user-scope path (no `$env:AGENTIC_WORKFLOW_USER_CONFIG and no `$HOME)"
                return
            }
        } else {
            if (-not (Test-Path -LiteralPath $TargetDir -PathType Container)) {
                Write-Host "skip:    config wizard — '$TargetDir' is not a directory"
                return
            }
            $targetConfig = Join-Path $TargetDir '.agentic-workflow.json'
        }
        if (Test-Path -LiteralPath $targetConfig) {
            Write-Host "skip:    $targetConfig already exists — leaving it untouched"
        } else {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetConfig) | Out-Null
            Set-Content -LiteralPath $targetConfig -Value '{}' -Encoding utf8
            Write-Host "ok:      wrote defaults $targetConfig ($scope scope)"
        }
        return
    }
    # Interactive: Invoke-ConfigWizard asks scope and checks existence for that scope.
    if (Test-Interactive) {
        Invoke-ConfigWizard
    } else {
        Write-Host "skip:    non-interactive shell — run .\install.ps1 --config to configure, or --yes to seed defaults"
    }
}

# Ensure a fully-expanded user-scope defaults file exists. A repo-scope file
# stays sparse (only the fields someone actively chose), but the runtime
# layers it OVER this one field-by-field (mergeConfigLayers), so seeding
# every default here once makes every knob visible/adjustable — without
# reading docs/configuration.md or touching this checkout again — for every
# repo the user drives. Idempotent: never touches an existing file. Sitters
# are listed but left `enabled: false` — they open PRs / post PR comments
# under the user's identity, so they must stay an explicit opt-in.
function Set-UserDefaults {
    if (-not $WantConfig) { return }
    $targetConfig = Get-UserConfigPath
    if (-not $targetConfig) {
        Write-Host "skip:    user-scope defaults — cannot resolve a path (no `$env:AGENTIC_WORKFLOW_USER_CONFIG and no `$HOME)"
        return
    }
    if (Test-Path -LiteralPath $targetConfig) {
        Write-Host "skip:    $targetConfig already exists — leaving it untouched"
        return
    }
    if ($env:AGENTIC_WORKFLOW_USER_CONFIG -eq '') {
        Write-Host "note: `$env:AGENTIC_WORKFLOW_USER_CONFIG is set to '' (user layer disabled at runtime); writing to $targetConfig anyway — unset it to have the loop read this file."
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetConfig) | Out-Null

    $defaults = [ordered]@{
        maxIterations       = 3
        tasksDir            = 'docs/tasks'
        stageTimeoutMinutes = 60
        codePlatform        = 'github'
        worktreesDir        = '.workflow-worktrees'
        taskBranch          = 'feature/'
        workflows           = [ordered]@{
            'pr-sitter'     = [ordered]@{ enabled = $false; query = 'is:open author:@me' }
            'review-sitter' = [ordered]@{ enabled = $false; query = 'is:open review-requested:@me' }
            'dep-sitter'    = [ordered]@{ enabled = $false; severityFloor = 'high' }
            'main-sitter'   = [ordered]@{ enabled = $false }
        }
    }
    ($defaults | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $targetConfig -Encoding utf8

    Write-Host "ok:      wrote $targetConfig (user scope, full defaults — shared across every repo you drive)"
    Write-Host "         Every field has a sane default; edit any of them, or flip a sitter's"
    Write-Host "         `"enabled`" to true, to change behavior. What's here:"
    Write-Host "           maxIterations (3)                 — cap on verify/review-FAIL re-builds"
    Write-Host "           tasksDir (`"docs/tasks`")           — root of the task backlog"
    Write-Host "           stageTimeoutMinutes (60)           — wall-clock cap per stage"
    Write-Host "           codePlatform (`"github`")            — or `"ado`" (needs an `"ado`" section)"
    Write-Host "           worktreesDir (`".workflow-worktrees`")   — per-task git worktree isolation; false to opt out"
    Write-Host "           taskBranch (`"feature/`")           — work-branch prefix; false to build on your current branch"
    Write-Host "           workflows.pr-sitter    (off) — watches your own open PRs"
    Write-Host "           workflows.review-sitter (off) — comments on PRs awaiting your review"
    Write-Host "           workflows.dep-sitter   (off) — opens draft PRs for vulnerable/outdated deps"
    Write-Host "           workflows.main-sitter  (off) — opens a draft PR when the default branch's CI goes red"
    Write-Host "         Multi-pass REVIEW is per stage, not global: set"
    Write-Host "           workflows.engineering.stageFanout.review to `"axis`" (one enforced pass per axis)."
    Write-Host "         See docs/configuration.md for every constraint and the ado/projectManagement sections."
}

# Host detection. Claude Code ships a `claude` CLI (and a ~\.claude dir); OpenCode
# ships an `opencode` CLI. We detect the CLI — the OpenCode config dir is an
# unreliable signal because this installer creates it.
function Test-HasClaude { [bool](Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath (Join-Path $HOME '.claude')) }
function Test-HasOpenCode { [bool](Get-Command opencode -ErrorAction SilentlyContinue) }
function Test-HasQwen { [bool](Get-Command qwen -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath (Join-Path $HOME '.qwen')) }

# Interactive host-selection menu, run only when no positional target was given.
# Sets $Target to claude|opencode|qwen|all|config, defaulting to whatever was detected.
function Select-Host2 {
    $cMark = if (Test-HasClaude) { [char]0x2713 } else { [char]0x2717 }
    $oMark = if (Test-HasOpenCode) { [char]0x2713 } else { [char]0x2717 }
    $qMark = if (Test-HasQwen) { [char]0x2713 } else { [char]0x2717 }

    # Default to the single detected host; anything else (none, or several) -> all.
    $detected = 0
    if (Test-HasClaude) { $detected++ }
    if (Test-HasOpenCode) { $detected++ }
    if (Test-HasQwen) { $detected++ }
    $default = if ($detected -ne 1) { '4' } elseif (Test-HasClaude) { '1' } elseif (Test-HasOpenCode) { '2' } else { '3' }

    Write-Host ""
    Write-Host "Detected hosts: Claude Code $cMark   OpenCode $oMark   Qwen Code $qMark"
    Write-Host "Install agentic-workflow for which?"
    Write-Host "  [1] Claude Code"
    Write-Host "  [2] OpenCode"
    Write-Host "  [3] Qwen Code"
    Write-Host "  [4] All (default)"
    Write-Host "  [5] Config only — no plugin files, just the .agentic-workflow.json wizard"
    $choice = Read-Answer "Choice" $default
    $script:Target = switch ($choice) {
        '1' { 'claude' }
        '2' { 'opencode' }
        '3' { 'qwen' }
        '5' { 'config' }
        default { 'all' }
    }
}

# Pick a target from the detected hosts when the user didn't name one. Returns
# claude|opencode|qwen|all: exactly one detected -> that one; none or several -> all.
function Get-DefaultTarget {
    $n = 0
    if (Test-HasClaude) { $n++ }
    if (Test-HasOpenCode) { $n++ }
    if (Test-HasQwen) { $n++ }
    if ($n -ne 1) { return 'all' }
    if (Test-HasClaude) { return 'claude' }
    if (Test-HasOpenCode) { return 'opencode' }
    return 'qwen'
}

# No positional target given: in an interactive shell, let the user pick a host
# (defaulting to what's detected). Non-interactive installs only the detected
# host(s) instead of blindly doing both — falling back to `all` only when
# neither CLI is found (fresh machine; better to install both than nothing).
if (-not $TargetExplicit) {
    if (Test-Interactive) {
        Select-Host2
    } else {
        $Target = Get-DefaultTarget
        if ($Target -eq 'all' -and -not (Test-HasClaude) -and -not (Test-HasOpenCode) -and -not (Test-HasQwen)) {
            Write-Host "note: no 'claude', 'opencode' or 'qwen' CLI detected — installing every half."
        } else {
            Write-Host "note: no target given; installing for detected host(s): $Target"
        }
    }
} elseif ($Target -eq 'claude' -and -not (Test-HasClaude)) {
    Write-Host "note: installing the Claude Code half, but no 'claude' CLI / ~\.claude was detected."
} elseif ($Target -eq 'opencode' -and -not (Test-HasOpenCode)) {
    Write-Host "note: installing the OpenCode half, but no 'opencode' CLI was detected."
} elseif ($Target -eq 'qwen' -and -not (Test-HasQwen)) {
    Write-Host "note: installing the Qwen Code half, but no 'qwen' CLI / ~\.qwen was detected."
}

switch ($Target) {
    'opencode' { Install-OpenCode }
    'claude' { Install-Claude }
    'qwen' { Install-Qwen }
    'all' {
        Install-OpenCode
        Write-Host ""
        Install-Claude
        Write-Host ""
        Install-Qwen
    }
    'config' { Write-Host "Config only — skipping plugin install (OpenCode + Claude Code + Qwen Code)." }
}

Invoke-MaybeConfigure
Set-UserDefaults
