#!/usr/bin/env pwsh
# Windows port of install.sh (same directory). Prepare the agentic-workflow
# Claude Code plugin for use:
#   1. build the MCP server (npm install + tsc -> mcp-server/dist)
#   2. symlink the platform-agnostic skills + references from the repo top
#      level into the plugin (the two loop-specific skills are authored here
#      directly)
#
# Run this once after cloning, then load the plugin with either:
#   claude --plugin-dir C:\abs\path\to\plugins\claude
# or add the repo as a marketplace:
#   /plugin marketplace add C:\abs\path\to\repo   (then)   /plugin install agentic-workflow
#
# Re-run any time; it's idempotent. Creating the skill/reference symlinks
# needs Administrator or Developer Mode (Windows 10/11) — without either,
# this script falls back to copies automatically (re-run after `git pull`
# to pick up changes when running in copy mode).

$ErrorActionPreference = 'Stop'

$PluginDir = $PSScriptRoot
$RepoDir = (Resolve-Path (Join-Path $PluginDir '..\..')).Path

Write-Host "Building the agentic-workflow MCP server..."
Push-Location $RepoDir
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    & npm run build -w agentic-workflow-mcp
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "Linking shared skills + references..."
New-Item -ItemType Directory -Force -Path (Join-Path $PluginDir 'skills') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PluginDir 'references') | Out-Null

# Loop-specific skills authored for Claude Code directly in the plugin and
# must NOT be overwritten by the OpenCode versions. task-backlog-management is
# substrate-agnostic and ships as a committed symlink to the canonical copy.
$ClaudeOwnedSkills = @('workflow-orchestration')

$script:SymlinkWarned = $false

# Create a relative symlink (falling back to a copy if symlinks aren't
# permitted), removing whatever is already at $Dest first.
function New-RelativeLinkOrCopy {
    param(
        [string]$AbsoluteSource,
        [string]$Dest,
        [string]$RelativeTarget
    )
    $existing = Get-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
    if ($existing) {
        Remove-Item -LiteralPath $Dest -Recurse -Force
    }
    try {
        New-Item -ItemType SymbolicLink -Path $Dest -Target $RelativeTarget | Out-Null
    } catch {
        if (-not $script:SymlinkWarned) {
            Write-Warning "Cannot create symlinks (needs Administrator or Developer Mode on Windows 10/11). Falling back to copies — re-run this script after 'git pull' to refresh them."
            $script:SymlinkWarned = $true
        }
        Copy-Item -LiteralPath $AbsoluteSource -Destination $Dest -Recurse -Force
    }
}

foreach ($dir in Get-ChildItem -Path (Join-Path $RepoDir 'skills') -Directory) {
    $name = $dir.Name
    if ($ClaudeOwnedSkills -contains $name) { continue }
    $dest = Join-Path $PluginDir "skills\$name"
    New-RelativeLinkOrCopy -AbsoluteSource $dir.FullName -Dest $dest -RelativeTarget "..\..\..\skills\$name"
}

foreach ($file in Get-ChildItem -Path (Join-Path $RepoDir 'references') -Filter '*.md' -File) {
    $dest = Join-Path $PluginDir "references\$($file.Name)"
    New-RelativeLinkOrCopy -AbsoluteSource $file.FullName -Dest $dest -RelativeTarget "..\..\..\references\$($file.Name)"
}

Write-Host ""
Write-Host "Done. Load with:  claude --plugin-dir `"$PluginDir`""
Write-Host "Then run:  /agentic-workflow:engineering new <idea>   (draft -> approve <id> -> claim plans & parks it -> approve -> claim builds -> approve ships)"
