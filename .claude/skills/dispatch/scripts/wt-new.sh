#!/usr/bin/env bash
# Создать worktree для сессии задачи.
# usage: wt-new.sh <repo> <worktrees-root> <branch> <base> [gitignored-file ...]
#   base  — origin/main или ветка родителя-среза (локальная или origin/<ветка>)
#   files — пути от корня repo (.env и т.п.): копируются как есть, если их нет в worktree. Не правятся.
# Ветка создаётся БЕЗ трекинга: случайный `git push` не уедет в main; пушить `-u origin <branch>`.
set -euo pipefail
[ $# -ge 4 ] || { sed -n 2,6p "$0"; exit 2; }
repo=$1; root=$2; br=$3; base=$4; shift 4
wt="$root/$br"
[ -e "$wt" ] && { echo "уже есть: $wt"; exit 1; }
git -C "$repo" fetch origin --quiet
mkdir -p "$root"
if git -C "$repo" show-ref --verify --quiet "refs/heads/$br"; then
  git -C "$repo" worktree add "$wt" "$br"
else
  git -C "$repo" worktree add --no-track -b "$br" "$wt" "$base"
fi
for f in "$@"; do
  if [ -f "$repo/$f" ] && [ ! -e "$wt/$f" ]; then mkdir -p "$(dirname "$wt/$f")"; cp "$repo/$f" "$wt/$f"; echo "скопирован $f"; fi
done
echo "worktree: $wt"
git -C "$wt" log -1 --format='HEAD %h %s'
