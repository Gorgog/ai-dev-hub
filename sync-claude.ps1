# Link the hub's skills and agents into the personal ~/.claude/ so they work in sessions OUTSIDE the hub
# (inside the hub Claude Code finds .claude/ of parent folders by itself).
# Skills: one junction per skill -> edits in the hub are live, copies never drift.
# Agents: files are copied (a junction cannot replace single files; a hard link cannot cross drives).
# Re-run after adding a skill or changing an agent. Safe to re-run.
# A real folder in the way is moved to ~/.claude/skills-backup-<date>/ first, never deleted.
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.

$hub = $PSScriptRoot
$dest = Join-Path $env:USERPROFILE ".claude"
$backup = Join-Path $dest ("skills-backup-" + (Get-Date -Format "yyyy-MM-dd"))

$skillsSrc = Join-Path $hub ".claude\skills"
$skillsDst = Join-Path $dest "skills"
New-Item -ItemType Directory -Force $skillsDst | Out-Null
foreach ($s in Get-ChildItem $skillsSrc -Directory) {
    $t = Join-Path $skillsDst $s.Name
    $item = Get-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -eq "Junction" -and (@($item.Target)[0] -eq $s.FullName)) {
        Write-Host "ok        skills\$($s.Name)"
        continue
    }
    if ($item) {
        New-Item -ItemType Directory -Force $backup | Out-Null
        if ($item.LinkType) { cmd /c rmdir "$t" | Out-Null } else { Move-Item -LiteralPath $t (Join-Path $backup $s.Name) }
        Write-Host "replaced  skills\$($s.Name) (old copy -> $backup)"
    }
    New-Item -ItemType Junction -Path $t -Target $s.FullName | Out-Null
    Write-Host "linked    skills\$($s.Name) -> $($s.FullName)"
}

$agentsSrc = Join-Path $hub ".claude\agents"
$agentsDst = Join-Path $dest "agents"
$agentsBak = Join-Path $dest ("agents-backup-" + (Get-Date -Format "yyyy-MM-dd"))
if (Test-Path $agentsSrc) {
    New-Item -ItemType Directory -Force $agentsDst | Out-Null
    foreach ($a in Get-ChildItem $agentsSrc -File) {
        $t = Join-Path $agentsDst $a.Name
        if ((Test-Path $t) -and ((Get-FileHash $t).Hash -ne (Get-FileHash $a.FullName).Hash)) {
            New-Item -ItemType Directory -Force $agentsBak | Out-Null
            Copy-Item $t (Join-Path $agentsBak $a.Name) -Force
            Write-Host "backup    agents\$($a.Name) -> $agentsBak"
        }
        Copy-Item $a.FullName $t -Force
    }
    Write-Host "copied    agents -> $agentsDst"
}

# Dispatcher's resource lock: PreToolUse hook in ~/.claude/settings.json (acts only in projects/*/worktrees/*).
$installGuard = Join-Path $hub ".claude\skills\dispatch\scripts\install-guard.cjs"
if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path $installGuard)) {
    node $installGuard
} else {
    Write-Host "skipped   guard hook: node not found (install Node.js and re-run)"
}

# Hub's own git hooks: pre-commit blocks private names (.githooks/private-patterns, untracked) from this public repo.
if (Get-Command git -ErrorAction SilentlyContinue) {
    git -C $hub config core.hooksPath .githooks
    Write-Host "set       git hooks of the hub -> .githooks (add your private names to .githooks/private-patterns)"
}
Write-Host "Done. New Claude Code sessions will see the hub skills, agents and the guard hook."
