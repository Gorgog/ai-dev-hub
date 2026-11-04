#!/usr/bin/env bash
# Blocks a commit whose added lines match a private pattern: names of work projects, task keys, studio names.
# Patterns live in .githooks/private-patterns of the main copy (untracked, one extended regex per line,
# case-insensitive, '#' starts a comment). Looked for in this working tree first (the main copy, whatever its .git
# layout), then beside git-common-dir (a worktree: no copy of the list, the main copy holds it). No list or an
# empty one -> a line on stderr that the check is skipped, never silence. ASCII only.
export LC_ALL=C.UTF-8
top=$(git rev-parse --show-toplevel) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir) || exit 0
src=""
for f in "$top/.githooks/private-patterns" "$(dirname "$common")/.githooks/private-patterns"; do
  if [ -f "$f" ]; then src=$f; break; fi
done
if [ -z "$src" ]; then
  echo "private-patterns: list not found ($top/.githooks or $(dirname "$common")/.githooks), check skipped" >&2
  exit 0
fi
pat=$(mktemp)
trap 'rm -f "$pat"' EXIT
tr -d '\r' < "$src" | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' > "$pat"
if [ ! -s "$pat" ]; then
  echo "private-patterns: list is empty ($src), check skipped" >&2
  exit 0
fi
found=0
# NUL-separated names: a path with spaces or newlines stays one path.
while IFS= read -r -d '' f; do
  hits=$(git diff --cached -U0 --no-color -- "$f" | grep '^+' | grep -v '^+++' | grep -i -E -f "$pat")
  if [ -n "$hits" ]; then
    found=1
    echo "private pattern in $f:" >&2
    echo "$hits" | head -5 >&2
  fi
done < <(git diff --cached --name-only -z --diff-filter=ACMR)
if [ "$found" = 1 ]; then
  echo "Remove private names (see $src) or move the text out of the hub." >&2
  exit 1
fi
exit 0
