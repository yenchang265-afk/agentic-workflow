#!/usr/bin/env pwsh
# Windows port of uninstall.sh (same behavior, same flags) — the reverse of
# .\install.ps1.
#
# OpenCode half: removes the agents/commands/skills/references entries this
# repo installed into an OpenCode config directory (symlinks that point back
# here, or — with --copy — the copies install left by name), plus the local
# plugin file.
# Claude Code half: drops the built MCP server (mcp-server\dist); the plugin's
# committed in-repo skill/reference symlinks are git-tracked, not install
# artifacts, so they are left alone. Detaching the plugin from Claude Code
# itself is a `/plugin uninstall agentic-workflow` (or dropping --plugin-dir)
# — this script prints the reminder.
#
# It never touches your .agentic-workflow.json or the docs\tasks\ backlog —
# use .\scripts\clean.sh (or run it under WSL/git-bash) for that. Re-run any
# time; idempotent.

$ErrorActionPreference = 'Stop'

function Show-Usage {
    @'
Usage:
  .\uninstall.ps1                  # uninstall every plugin (OpenCode + Claude Code + Qwen Code)
  .\uninstall.ps1 opencode         # OpenCode only: remove entries from $env:OPENCODE_CONFIG_DIR or ~/.config/opencode
  .\uninstall.ps1 claude           # Claude Code only: remove the built mcp-server\dist
  .\uninstall.ps1 qwen             # Qwen Code only: remove entries from $env:QWEN_CONFIG_DIR or ~/.qwen
                                    #   (including our hooks + MCP entries in settings.json)
  .\uninstall.ps1 all              # explicit all (same as no target)
  .\uninstall.ps1 [opencode] --copy # also remove copies install left (not just symlinks)
  .\uninstall.ps1 [opencode] <dir> # uninstall the OpenCode half from an arbitrary config dir
  .\uninstall.ps1 qwen <dir>       # uninstall the Qwen half from an arbitrary config dir

To also wipe local run state / backlog / config, see .\scripts\clean.sh.
'@
}

$RepoDir = $PSScriptRoot
$Target = 'all'
$Mode = 'symlink'
$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $HOME '.config\opencode' }
$QwenConfigDir = if ($env:QWEN_CONFIG_DIR) { $env:QWEN_CONFIG_DIR } else { Join-Path $HOME '.qwen' }
$PositionalDir = $null

foreach ($arg in $args) {
    if ($arg -in @('opencode', 'claude', 'qwen', 'all')) { $Target = $arg }
    elseif ($arg -eq 'both') { $Target = 'all' }
    elseif ($arg -eq '--copy') { $Mode = 'copy' }
    elseif ($arg -in @('-h', '--help')) { Show-Usage; exit 0 }
    elseif ($arg.StartsWith('-')) {
        Write-Host "unknown option: $arg"
        Show-Usage
        exit 1
    }
    else { $PositionalDir = $arg }
}

if ($PositionalDir) {
    if ($Target -eq 'qwen') { $QwenConfigDir = $PositionalDir } else { $ConfigDir = $PositionalDir }
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

# Remove a dest we own: a symlink pointing back into this repo always goes; a
# plain file/dir goes only in --copy mode (that is what install left behind).
function Remove-Owned {
    param([string]$Dest)
    $item = Get-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
    if (-not $item) { return }
    $target = Get-SymlinkTarget $Dest
    if ($target) {
        if ($target.StartsWith($RepoDir)) {
            Remove-Item -LiteralPath $Dest -Recurse -Force
            Write-Host "removed: $Dest"
        }
        # a symlink to somewhere else — not ours, leave it
        return
    }
    if ($Mode -eq 'copy') {
        Remove-Item -LiteralPath $Dest -Recurse -Force
        Write-Host "removed (copy): $Dest"
    }
}

function Uninstall-OpenCode {
    Write-Host "Uninstalling agentic-workflow for OpenCode from $ConfigDir"
    if (-not (Test-Path -LiteralPath $ConfigDir)) {
        Write-Host "skip: $ConfigDir does not exist — nothing to remove"
        return
    }

    # Iterate this repo's own sources so we only ever touch names install owns.
    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'plugins\opencode\agents') -Filter '*.md' -File -ErrorAction SilentlyContinue) {
        Remove-Owned (Join-Path $ConfigDir "agents\$($f.Name)")
    }
    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'plugins\opencode\commands') -Filter '*.md' -File -ErrorAction SilentlyContinue) {
        Remove-Owned (Join-Path $ConfigDir "commands\$($f.Name)")
    }
    foreach ($d in Get-ChildItem -Path (Join-Path $RepoDir 'skills') -Directory -ErrorAction SilentlyContinue) {
        Remove-Owned (Join-Path $ConfigDir "skills\$($d.Name)")
    }
    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'references') -Filter '*.md' -File -ErrorAction SilentlyContinue) {
        Remove-Owned (Join-Path $ConfigDir "references\$($f.Name)")
    }

    # The local plugin file — remove it only when it re-exports THIS repo, so a
    # second clone's uninstall doesn't yank a plugin file pointing elsewhere.
    $pluginFile = Join-Path $ConfigDir 'plugins\agentic-workflow.ts'
    if (Test-Path -LiteralPath $pluginFile) {
        $needle = ($RepoDir -replace '\\', '/') + '/plugins/opencode/src/index.ts'
        if ((Get-Content -LiteralPath $pluginFile -Raw) -match [regex]::Escape($needle)) {
            Remove-Item -LiteralPath $pluginFile -Force
            Write-Host "removed: $pluginFile"
        }
    }

    # Drop now-empty dirs we may have created (never fails if non-empty).
    foreach ($sub in @('agents', 'commands', 'skills', 'references', 'plugins')) {
        $dir = Join-Path $ConfigDir $sub
        if ((Test-Path -LiteralPath $dir) -and (Get-ChildItem -Path $dir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
            Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host "OpenCode: agentic-workflow entries removed. Your OpenCode config file is untouched."
}

function Uninstall-Claude {
    Write-Host "Uninstalling agentic-workflow for Claude Code (plugins\claude\)"
    $dist = Join-Path $RepoDir 'plugins\claude\mcp-server\dist'
    if (Test-Path -LiteralPath $dist) {
        Remove-Item -LiteralPath $dist -Recurse -Force
        Write-Host "removed: $dist"
    } else {
        Write-Host "skip: $dist not present"
    }
    Write-Host "Claude Code: detach the plugin itself with '/plugin uninstall agentic-workflow'"
    Write-Host "             (or drop the --plugin-dir flag). The in-repo skill/reference"
    Write-Host "             symlinks are git-tracked and are left in place."
}

# Qwen Code half. The mirror of Install-Qwen: remove the symlinks we own, the
# GENERATED agent copies (which Remove-Owned can't recognize — they are real
# files, by design, because each carries a baked-in `model:`), and our entries in
# settings.json. Everything else in that file, including hooks the user added to
# the same events, is left exactly as it was.
function Uninstall-Qwen {
    Write-Host "Uninstalling agentic-workflow for Qwen Code ($QwenConfigDir)"

    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'plugins\qwen\commands') -Filter '*.md' -File -ErrorAction SilentlyContinue) {
        Remove-Owned (Join-Path $QwenConfigDir "commands\agentic-workflow\$($f.Name)")
    }
    foreach ($d in Get-ChildItem -Path (Join-Path $RepoDir 'skills') -Directory -ErrorAction SilentlyContinue) {
        Remove-Owned (Join-Path $QwenConfigDir "skills\$($d.Name)")
    }
    Remove-Owned (Join-Path $QwenConfigDir 'skills\workflow-orchestration')
    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'references') -Filter '*.md' -File -ErrorAction SilentlyContinue) {
        Remove-Owned (Join-Path $QwenConfigDir "references\$($f.Name)")
    }

    # Agents are copies, so match by the names this repo ships rather than by link
    # target — never a blanket wipe of the user's agents dir.
    foreach ($f in Get-ChildItem -Path (Join-Path $RepoDir 'plugins\qwen\agents') -Filter '*.md' -File -ErrorAction SilentlyContinue) {
        $dest = Join-Path $QwenConfigDir "agents\$($f.Name)"
        if (Test-Path -LiteralPath $dest -PathType Leaf) {
            Remove-Item -LiteralPath $dest -Force
            Write-Host "removed: $dest"
        }
    }

    if (Test-Path -LiteralPath (Join-Path $QwenConfigDir 'settings.json')) {
        & node (Join-Path $RepoDir 'scripts\qwen-settings.mjs') remove $QwenConfigDir
        if ($LASTEXITCODE -ne 0) { throw "qwen-settings.mjs remove failed with exit code $LASTEXITCODE" }
    }

    $agenticCommands = Join-Path $QwenConfigDir 'commands\agentic-workflow'
    if ((Test-Path -LiteralPath $agenticCommands) -and (Get-ChildItem -Path $agenticCommands -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $agenticCommands -Force -ErrorAction SilentlyContinue
    }
    foreach ($sub in @('agents', 'commands', 'skills', 'references')) {
        $dir = Join-Path $QwenConfigDir $sub
        if ((Test-Path -LiteralPath $dir) -and (Get-ChildItem -Path $dir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
            Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
        }
    }
}

switch ($Target) {
    'opencode' { Uninstall-OpenCode }
    'claude' { Uninstall-Claude }
    'qwen' { Uninstall-Qwen }
    'all' {
        Uninstall-OpenCode
        Write-Host ""
        Uninstall-Claude
        Write-Host ""
        Uninstall-Qwen
    }
}
