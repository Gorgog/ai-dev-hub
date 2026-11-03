#!/usr/bin/env bash
# Убрать worktree сессии задачи — только чистый и только если работа не потеряется.
# usage: wt-remove.sh <repo> <worktree>
# Стоп, если: есть незакоммиченное; ветка не в origin/main и не совпадает с origin/<ветка>.
# Ссылки node_modules (на node_modules основной копии) снимаются ДО `git worktree remove`.
set -euo pipefail
export LC_ALL=C
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
# и оставит полуудалённую папку. Процесс «из worktree» — его cwd, exe или аргумент командной строки внутри папки.
# Shell-процессы не считаются — в их командной строке этот же путь. Один find на все cwd/exe и один grep на все
# cmdline вместо 4 спаунов на процесс (было 5,4 с на 435 процессах).
w=$(realpath "$wt")
we=$(printf '%s' "$w" | sed 's/[][\.*^$+?(){}|]/\\&/g')
pids=$( {
  find /proc/[0-9]*/cwd /proc/[0-9]*/exe -maxdepth 0 -printf '%p\t%l\n' 2>/dev/null |
    W="$w" awk -F'\t' '{ l = $2; sub(/ \(deleted\)$/, "", l) } l == ENVIRON["W"] || index(l, ENVIRON["W"] "/") == 1 { split($1, p, "/"); print p[3] }'
  # -z: каждый аргумент — отдельная запись; путь целиком (TASK-1 не ловит TASK-11) или с хвостом /…
  grep -lzE -- "${we}(/|$)" /proc/[0-9]*/cmdline 2>/dev/null | cut -d/ -f3
} | sort -un)
procs=''; units=''
for pid in $pids; do
  [ "$pid" = $$ ] && continue
  { name=$(< "/proc/$pid/comm"); } 2>/dev/null || continue  # find, grep и прочие из этого конвейера уже вышли
  case "$name" in bash|sh|zsh|dash|git|ssh|sed|grep|cat|tail|less|find|awk|mawk|sort|cut) continue ;; esac
  procs+="$pid $name"$'\n'
  # Прогон hub-run.sh: его scope гасится целиком одной командой.
  u=$(grep -o 'hub-[^/]*\.scope' "/proc/$pid/cgroup" 2>/dev/null) && units+="$u"$'\n'
done
if [ -n "$procs" ]; then
  echo "СТОП: из $wt работают процессы (останови их хозяина, preview_stop, или погаси с согласия):"
  printf '%s' "$procs" | sed 's/^/  /'
  if [ -n "$units" ]; then
    echo "  прогоны hub-run.sh: $(printf '%s' "$units" | sort -u | tr '\n' ' ')"
    echo "  погасить целиком: bash $(dirname "$0")/hub-run.sh --stop $(basename "$w")"
  fi
  exit 1
fi
for nm in "$wt"/apps/*/node_modules "$wt"/node_modules; do
  if [ -L "$nm" ]; then rm "$nm"; echo "снята ссылка $nm"; fi
done
git -C "$repo" worktree remove "$wt"
echo "убран $wt (ветка $br осталась)"
