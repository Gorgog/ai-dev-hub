#!/usr/bin/env bash
# Убрать worktree сессии задачи — только чистый и только если работа не потеряется.
# usage: wt-remove.sh <repo> <worktree>
# Стоп, если: есть незакоммиченное; ветка не в origin/main и не совпадает с origin/<ветка>.
# Junction'ы node_modules снимаются `cmd /c rmdir` ДО `git worktree remove` (иначе git стирает их цель).
set -euo pipefail
[ $# -eq 2 ] || { sed -n 2,5p "$0"; exit 2; }
repo=$1; wt=$2
br=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
[ -z "$(git -C "$wt" status --porcelain)" ] || { echo "СТОП: в $wt есть незакоммиченное"; git -C "$wt" status --short | head; exit 1; }
git -C "$repo" fetch origin --quiet
if [ -n "$(git -C "$repo" cherry origin/main "$br" | grep '^+' || true)" ]; then
  remote=$(git -C "$repo" rev-parse -q --verify "origin/$br" || true)
  [ "$remote" = "$(git -C "$repo" rev-parse "$br")" ] || { echo "СТОП: $br не в main и не запушена целиком"; exit 1; }
  echo "ветка $br не смержена, но запушена ($remote) — убираю только папку"
fi
# Живые процессы из worktree (next dev, nest, jest держат файлы и DLL Prisma): remove упадёт посреди удаления
# и оставит полуудалённую папку. Shell-процессы не считаются — в их командной строке этот же путь.
wtw=$(cygpath -w "$wt"); wtu=$(cygpath -u "$wt")
procs=$(WTW="$wtw" WTU="$wtu" powershell -NoProfile -Command '
  $w = $env:WTW.TrimEnd("\"); $u = $env:WTU.TrimEnd("/")
  $skip = "bash.exe","sh.exe","powershell.exe","pwsh.exe","cmd.exe","conhost.exe","git.exe"
  Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and ($skip -notcontains $_.Name) -and (
      ($_.ExecutablePath -and $_.ExecutablePath -like "$w*") -or
      ($_.CommandLine -and ($_.CommandLine -like "*$w*" -or $_.CommandLine -like "*$u*")))
  } | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.Name }' 2>/dev/null | tr -d '\r')
if [ -n "$procs" ]; then
  echo "СТОП: из $wt работают процессы (останови их хозяина, preview_stop, или погаси по PID с согласия):"
  echo "$procs" | sed 's/^/  /'
  exit 1
fi
for nm in "$wt"/apps/*/node_modules "$wt"/node_modules; do
  [ -e "$nm" ] || continue
  w=$(cygpath -w "$nm")
  lt=$(powershell -NoProfile -Command "(Get-Item -LiteralPath '$w' -Force).LinkType" 2>/dev/null | tr -d '\r' || true)
  if [ "$lt" = "Junction" ] || [ "$lt" = "SymbolicLink" ]; then cmd //c rmdir "$w"; echo "снят junction $nm"; fi
done
git -C "$repo" worktree remove "$wt"
echo "убран $wt (ветка $br осталась)"
