#!/usr/bin/env bash
# Убрать worktree сессии задачи — только чистый и только если работа не потеряется.
# usage: wt-remove.sh <repo> <worktree>
# Стоп, если: есть незакоммиченное; ветка не в origin/main и не совпадает с origin/<ветка>.
# Ссылки node_modules (на node_modules основной копии) снимаются ДО `git worktree remove`.
set -euo pipefail
[ $# -eq 2 ] || { sed -n 2,5p "$0"; exit 2; }
repo=$1; wt=$2
br=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
# Ссылку node_modules правило `node_modules/` (со слешем) не игнорирует — она не папка, поэтому исключена здесь.
nm_out=(':(exclude)node_modules' ':(exclude)apps/*/node_modules')
[ -z "$(git -C "$wt" status --porcelain -- . "${nm_out[@]}")" ] || { echo "СТОП: в $wt есть незакоммиченное"; git -C "$wt" status --short -- . "${nm_out[@]}" | head; exit 1; }
git -C "$repo" fetch origin --quiet
if [ -n "$(git -C "$repo" cherry origin/main "$br" | grep '^+' || true)" ]; then
  remote=$(git -C "$repo" rev-parse -q --verify "origin/$br" || true)
  [ "$remote" = "$(git -C "$repo" rev-parse "$br")" ] || { echo "СТОП: $br не в main и не запушена целиком"; exit 1; }
  echo "ветка $br не смержена, но запушена ($remote) — убираю только папку"
fi
# Живые процессы из worktree (next dev, nest, jest держат файлы): remove упадёт посреди удаления
# и оставит полуудалённую папку. Shell-процессы не считаются — в их командной строке этот же путь.
w=$(realpath "$wt")
procs=$(for d in /proc/[0-9]*; do
  pid=${d#/proc/}; [ "$pid" = $$ ] && continue
  name=$(cat "$d/comm" 2>/dev/null) || continue
  case "$name" in bash|sh|zsh|dash|git|ssh|sed|grep|cat|tail|less) continue ;; esac
  where="$(readlink "$d/cwd" 2>/dev/null || true)/ $(readlink "$d/exe" 2>/dev/null || true) $(tr '\0' ' ' < "$d/cmdline" 2>/dev/null || true)"
  case "$where" in *"$w/"*|*"$w "*) echo "$pid $name" ;; esac
done)
if [ -n "$procs" ]; then
  echo "СТОП: из $wt работают процессы (останови их хозяина, preview_stop, или погаси по PID с согласия):"
  echo "$procs" | sed 's/^/  /'
  exit 1
fi
for nm in "$wt"/apps/*/node_modules "$wt"/node_modules; do
  if [ -L "$nm" ]; then rm "$nm"; echo "снята ссылка $nm"; fi
done
git -C "$repo" worktree remove "$wt"
echo "убран $wt (ветка $br осталась)"
