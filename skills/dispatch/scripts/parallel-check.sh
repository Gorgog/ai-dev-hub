#!/usr/bin/env bash
# Ранний перехват конфликтов между параллельными ветками — без checkout, ничего не меняет.
# usage: parallel-check.sh <repo> <base> <branch> <branch> [branch ...]
# env HOT — regex горячих точек из профиля (по умолчанию — монорепо NestJS + Prisma и Next + kubb).
# Код выхода: 0 — чисто; 1 — есть текстовый конфликт; 3 — только общие горячие точки/файлы.
set -uo pipefail
[ $# -ge 4 ] || { sed -n 2,5p "$0"; exit 2; }
repo=$1; base=$2; shift 2
HOT=${HOT:-'prisma/migrations/|prisma/models/|src/kubb/|i18n/locales/|permission.*enum|^docs/|app\.module\.ts'}
g() { git -C "$repo" "$@"; }
declare -A files
for b in "$@"; do files[$b]=$(g diff --name-only "$base...$b"); done
rc=0
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do for ((j=i+1; j<${#args[@]}; j++)); do
  a=${args[i]}; b=${args[j]}
  out=$(g merge-tree --write-tree --name-only --no-messages "$a" "$b" 2>&1); st=$?
  common=$(comm -12 <(echo "${files[$a]}" | sort) <(echo "${files[$b]}" | sort) | sed '/^$/d')
  hot=$(echo "$common" | grep -E "$HOT" || true)
  if [ $st -eq 1 ]; then echo "КОНФЛИКТ $a × $b:"; echo "$out" | tail -n +2 | sed 's/^/  /'; rc=1
  elif [ $st -ne 0 ]; then echo "ошибка merge-tree $a × $b: $out"; rc=1
  elif [ -n "$hot" ]; then echo "горячие точки $a × $b (сливается, но проверить):"; echo "$hot" | sed 's/^/  /'; [ $rc -eq 0 ] && rc=3
  elif [ -n "$common" ]; then echo "общие файлы $a × $b (сливается):"; echo "$common" | sed 's/^/  /'; [ $rc -eq 0 ] && rc=3
  else echo "чисто $a × $b"; fi
done; done
exit $rc
