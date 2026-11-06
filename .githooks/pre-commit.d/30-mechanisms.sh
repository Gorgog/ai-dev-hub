#!/usr/bin/env bash
# Mechanisms registry and budget: every hook module (plugin/hooks/<event>.d/) has a record plugin/mechanisms/<id>.json
# with a polygon scenario that exists; more logical handlers or kinds of state files than BUDGET of registry.cjs
# (12 and 12) blocks the commit with the list; an expired review date only warns. The check reads the index (what is being committed), not the working
# tree: a staged snapshot of plugin/hooks, plugin/mechanisms and polygon/scenarios goes to a temp folder and
# plugin/hooks/lib/registry.cjs of that snapshot checks it. Runs only when the commit touches those paths. ASCII only.
git diff --cached --name-only | grep -qE '^(plugin/hooks/|plugin/mechanisms/|polygon/scenarios/)' || exit 0
command -v node >/dev/null || { echo "mechanisms: node not found, skipped" >&2; exit 0; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git ls-files -z -- plugin/hooks plugin/mechanisms polygon/scenarios | git checkout-index -z --stdin --prefix="$tmp/" || exit 1
if [ ! -f "$tmp/plugin/hooks/lib/registry.cjs" ]; then
  echo "mechanisms: plugin/hooks/lib/registry.cjs is not in the index, check skipped" >&2
  exit 0
fi
node "$tmp/plugin/hooks/lib/registry.cjs" check "$tmp"
