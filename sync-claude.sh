#!/usr/bin/env bash
# Install the hub as the Claude Code plugin `hub` (local marketplace in this folder, read in place).
# Settings, old links and agent copies — install.cjs; then the hub's own git hooks. Safe to re-run.
# usage: bash sync-claude.sh
set -euo pipefail
hub=$(cd "$(dirname "$0")" && pwd)
# Claude Desktop started from the desktop menu does not read ~/.bashrc, so nvm's node is not on its PATH: the hooks
# find it through links in ~/.local/bin. With nvm the links follow `nvm alias default`, so an upgrade that removes
# the old version does not leave them dangling (every hook would fail with «node: not found»). No nvm - untouched.
bin="$HOME/.local/bin"
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  want=$(NVM_DIR="${NVM_DIR:-$HOME/.nvm}" bash -c '. "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm which default' 2>/dev/null | tail -1)
  if [ -x "$want" ]; then
    dir=$(dirname "$want")
    mkdir -p "$bin"
    for t in node npm npx; do
      [ -e "$dir/$t" ] || continue
      was=$(readlink "$bin/$t" || true)
      if [ "$was" = "$dir/$t" ]; then echo "node      ~/.local/bin/$t -> $dir/$t (nvm default)"
      else ln -sfn "$dir/$t" "$bin/$t"; echo "linked    ~/.local/bin/$t -> $dir/$t (nvm default, was: ${was:--})"; fi
    done
  else
    echo "nvm: no default version (nvm alias default <version>) - ~/.local/bin left as is"
  fi
fi
if [ -L "$bin/node" ] && ! readlink -e "$bin/node" >/dev/null; then
  echo "broken link ~/.local/bin/node -> $(readlink "$bin/node"): relink it to an installed node (nvm alias default <version>)"
  exit 1
fi
export PATH="$bin:$PATH"
if ! command -v node >/dev/null; then
  echo "node not found: install Node.js 18+ (nvm) and link it into ~/.local/bin — the plugin hooks run 'node' too"
  exit 1
fi
node "$hub/install.cjs"

# Hub's own git hooks: pre-commit blocks private names (.githooks/private-patterns, untracked) from this public repo.
git -C "$hub" config core.hooksPath .githooks
echo "set       git hooks of the hub -> .githooks (add your private names to .githooks/private-patterns)"
