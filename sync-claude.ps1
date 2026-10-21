# Install the hub as the Claude Code plugin `hub` (local marketplace in this folder, read in place).
# Settings, old junctions and agent copies — install.cjs; then the hub's own git hooks.
# Safe to re-run. ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.

$hub = $PSScriptRoot
if (Get-Command node -ErrorAction SilentlyContinue) {
    node (Join-Path $hub "install.cjs")
} else {
    Write-Host "node not found: install Node.js 18+ and re-run (the plugin hooks need it too)"
    exit 1
}

# Hub's own git hooks: pre-commit blocks private names (.githooks/private-patterns, untracked) from this public repo.
if (Get-Command git -ErrorAction SilentlyContinue) {
    git -C $hub config core.hooksPath .githooks
    Write-Host "set       git hooks of the hub -> .githooks (add your private names to .githooks/private-patterns)"
}
