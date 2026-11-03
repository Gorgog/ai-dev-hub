#!/usr/bin/env bash
# Install the hub as the Claude Code plugin `hub` (local marketplace in this folder, read in place).
# Settings, old links and agent copies — install.cjs; then the hub's own git hooks. Safe to re-run.
# usage: bash sync-claude.sh
set -euo pipefail
hub=$(cd "$(dirname "$0")" && pwd)
# Claude Desktop started from the desktop menu does not read ~/.bashrc, so nvm's node is not on its PATH.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "node not found: install Node.js 18+ (nvm) and link it into ~/.local/bin — the plugin hooks run 'node' too"
  exit 1
fi
node "$hub/install.cjs"

# Hub's own git hooks: pre-commit blocks private names (.githooks/private-patterns, untracked) from this public repo.
git -C "$hub" config core.hooksPath .githooks
echo "set       git hooks of the hub -> .githooks (add your private names to .githooks/private-patterns)"
