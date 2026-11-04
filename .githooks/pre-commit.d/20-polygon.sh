#!/usr/bin/env bash
# Polygon, deterministic level only: the hook scenarios on the working tree against the same scenarios on main
# (POLYGON_BASE_REF). A check that got worse blocks the commit; a check red on both sides does not (it is part of the
# baseline). Model scenarios never run here: they are heavy (claude -p) and go through the dispatcher's lock.
# Runs only when the commit touches the hub base (CLAUDE.md, plugin/, templates/) or the polygon itself. Note: the
# scenarios read the working tree, unstaged edits included. Real corpora come from $HUB_DATA (default ~/hub-data);
# without them the runner says they were skipped. ASCII only.
root=$(git rev-parse --show-toplevel) || exit 0
run="$root/polygon/run.cjs"
[ -f "$run" ] || exit 0
git diff --cached --name-only | grep -qE '^(CLAUDE\.md|plugin/|templates/|polygon/)' || exit 0
command -v node >/dev/null || { echo "polygon: node not found, skipped" >&2; exit 0; }
ref=${POLYGON_BASE_REF:-main}
git rev-parse -q --verify "$ref^{commit}" >/dev/null || { echo "polygon: no $ref here, skipped" >&2; exit 0; }
# git hands its hooks GIT_DIR (and in a worktree GIT_INDEX_FILE): `git -C <fixture>` inside the polygon would still
# write into this repository with them. Everything git-related above is done; the runner gets a clean environment.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_NAMESPACE
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
t0=$(date +%s%N)
# Both sides at once: each is a few hundred short hook processes, light, and the commit waits for the slower one.
node "$run" --level hook --ref "$ref" --hub "$root" --quiet --work "$tmp/work" --out "$tmp/base.json" >"$tmp/base.log" 2>&1 &
base_pid=$!
node "$run" --level hook --hub "$root" --quiet --work "$tmp/work" --out "$tmp/tree.json" >"$tmp/tree.log" 2>&1
tree_code=$?
wait "$base_pid"
base_code=$?
for side in base tree; do
  code_var="${side}_code"
  if [ "${!code_var}" != 0 ]; then
    cat "$tmp/$side.log" >&2
    echo "polygon: the run on $side failed" >&2
    exit 1
  fi
done
# Second line of the runner's log: which real corpora were used, or that they were skipped.
sed -n 2p "$tmp/tree.log" >&2
node "$run" compare "$tmp/base.json" "$tmp/tree.json" >"$tmp/compare.log" 2>&1
code=$?
secs=$(awk -v a="$t0" -v b="$(date +%s%N)" 'BEGIN { printf "%.1f", (b - a) / 1e9 }')
if [ "$code" != 0 ]; then
  cat "$tmp/compare.log" >&2
  echo "polygon: a check is worse than $ref ($secs s), see the lines marked '-' above" >&2
  exit 1
fi
echo "polygon: no check worse than $ref ($secs s)" >&2
exit 0
