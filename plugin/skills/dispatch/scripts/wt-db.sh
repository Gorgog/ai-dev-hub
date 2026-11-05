#!/usr/bin/env bash
# Своя тестовая БД на worktree: в существующем тестовом контейнере проекта, из шаблона, по разделу
# «## Тестовая БД» профиля <хаб>/projects/<имя>/dispatch-profile.md (worktree — <имя>/worktrees/<ветка>). Нет
# раздела — create/drop/orphans молчат, run запускает команду как есть: поведение прежнее.
# usage:
#   wt-db.sh create <worktree>             создать БД из шаблона (осталась от прежней копии — пересоздать)
#   wt-db.sh drop <worktree>               удалить БД (WITH (FORCE): сначала убедись, что из worktree никто не работает)
#   wt-db.sh run <worktree> [-- cmd …]     команда с адресом своей БД в переменной профиля; без cmd — «тесты»
#                                          профиля в папке worktree; БД нет — создаётся
#   wt-db.sh orphans <repo> <worktrees> [--drop]   БД с меткой проекта без живого worktree (шаблон — никогда)
#   wt-db.sh name <worktree>               имя БД: префикс + путь от worktrees, [a-z0-9_], ≤ 63
# exit: 0; 2 — usage, битый раздел, нет папки worktree; 3 — команда к БД не прошла или имя БД занято другим
# worktree (причина — строкой); run — код команды.
# Адрес подаётся только переменной окружения, остальное окружение команды не меняется; файлы проекта не правятся.
# Проект, чей загрузчик перекрывает env файлом (.env.test с override), так не работает — проба P4.
set -uo pipefail
# C-локаль — только своим утилитам: команда тестов получает окружение вызывающего (как в hub-run.sh).
tr() { LC_ALL=C command tr "$@"; }
awk() { LC_ALL=C command awk "$@"; }
me=$(basename "$0")
usage() { sed -n 5,11p "$0" >&2; exit 2; }
die() { echo "$me: $*" >&2; exit 2; }
fail() { echo "$me: БД $1: $2" >&2; exit 3; }
[ $# -ge 2 ] || usage
cmd=$1; shift
args=("$@")  # для строки повтора — команда целиком

# Раздел профиля → kv[ключ]; раздела нет — has=0. Значение — первый `…` строки (пояснение после него — текст)
# или вся строка, если обратных кавычек нет.
has=0
load() { # $1 — профиль, $2 — имя проекта (префикс по умолчанию)
  local line key val k
  declare -gA kv=()
  [ -f "$1" ] || return 0
  while IFS= read -r line; do
    [[ $line =~ ^-[[:space:]]+([^:]+):[[:space:]]*(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}; val=${BASH_REMATCH[2]}
    if [[ $val =~ ^\`([^\`]*)\` ]]; then val=${BASH_REMATCH[1]}; else val=${val%"${val##*[![:space:]]}"}; fi
    kv[$key]=$val; has=1
  done < <(awk '/^```/ { code = !code; next } !code && /^## / { on = ($0 ~ /^## Тестовая БД[[:space:]]*$/); next } on && !code' "$1")
  [ "$has" = 1 ] || return 0
  local where="раздел «Тестовая БД» в $1"
  for k in контейнер пользователь шаблон переменная адрес; do
    [ -n "${kv[$k]-}" ] || die "$where: нет ключа «$k»"
  done
  # Заглушки шаблона — <…>; в команде тестов < и > бывают перенаправлениями, там заглушка — только целиком.
  for k in контейнер пользователь шаблон переменная адрес префикс тесты; do
    [ -n "${kv[$k]+x}" ] || continue
    if [ "$k" = тесты ]; then [[ ${kv[$k]} != '<'*'>' ]]; else [[ ${kv[$k]} != *'<'*'>'* ]]; fi ||
      die "$where: в «$k» осталась заглушка: ${kv[$k]}"
  done
  [ -n "${kv[префикс]+x}" ] || kv[префикс]="wt_$(printf '%s' "$2" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '_' | cut -c1-12)_"
  [[ ${kv[префикс]} =~ ^[a-z][a-z0-9_]{0,19}$ ]] || die "$where: префикс «${kv[префикс]}» — нужен [a-z][a-z0-9_]{0,19}"
  [[ ${kv[контейнер]} =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "$where: контейнер «${kv[контейнер]}»"
  [[ ${kv[пользователь]} =~ ^[A-Za-z0-9_.-]+$ ]] || die "$where: пользователь «${kv[пользователь]}»"
  [[ ${kv[шаблон]} =~ ^[A-Za-z0-9_.-]+$ ]] || die "$where: шаблон «${kv[шаблон]}» — нужен [A-Za-z0-9_.-]"
  [[ ${kv[переменная]} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "$where: переменная «${kv[переменная]}»"
  [[ ${kv[адрес]} == *'{db}'* && ${kv[адрес]} != *[[:space:]]* ]] || die "$where: в адресе нет {db} или есть пробел"
}
# Ближайший предок worktree с именем worktrees: root, рядом с ним — профиль; rel — путь worktree от root.
locate() { # $1 — worktree
  local p; p=$(realpath -m "$1"); root=''
  local q=$p
  while [ "$q" != / ]; do
    q=$(dirname "$q")
    [ "$(basename "$q")" = worktrees ] && { root=$q; break; }
  done
  [ -n "$root" ] || return 0
  rel=${p#"$root"/}
  # Метка владельца на БД (COMMENT ON DATABASE): чужие и непомеченные БД скрипт не пересоздаёт, не удаляет и не
  # отдаёт тестам — префикс одного проекта бывает началом чужого (wt_shop_ ⊂ wt_shop_admin_).
  mark="hub-wt:$root"
  load "$(dirname "$root")/dispatch-profile.md" "$(basename "$(dirname "$root")")"
}
dbname() { # $1 — путь worktree от root
  local n; n=$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '_')
  printf '%s' "${kv[префикс]}$n" | cut -c1-63
}
sql() { docker exec "${kv[контейнер]}" psql -U "${kv[пользователь]}" -d postgres -v ON_ERROR_STOP=1 -Atqc "$1"; }
# Строки «имя|метка».
dblist() { sql "SELECT datname || '|' || coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database"; }
# Код 0 — БД нет или она этого проекта; 1 — есть и чужая (метка — в stdout); 3 — список не прочитан (ошибка — в
# stdout). Зовётся в $(…): exit внутри кончил бы только подоболочку, поэтому коды, а не fail.
mine() { # $1 — имя БД
  local all line; all=$(dblist 2>&1) || { printf '%s' "$all"; return 3; }
  line=$(grep -F -- "$1|" <<< "$all" | grep -m1 "^$1|") || return 0
  [ "${line#*|}" = "$mark" ] && return 0
  printf '%s' "${line#*|}"; return 1
}
retry() { printf 'повтор: bash'; printf ' %q' "$(dirname "$0")/$me" "$cmd" "${args[@]}"; }
# Есть ли БД: 0 — да, 1 — нет; список не прочитан — стоп (сбой docker — не ответ «нет»).
exists() { # $1 — имя БД
  local all; all=$(dblist 2>&1) ||
    fail "$1" "список БД не прочитан (контейнер ${kv[контейнер]} запущен?): $all"$'\n'"$(retry)"
  cut -d'|' -f1 <<< "$all" | grep -x -- "$1" >/dev/null
}
own() { # $1 — имя БД: нет или своя, иначе стоп
  local m rc; m=$(mine "$1"); rc=$?
  case $rc in
    0) ;;
    1) fail "$1" "чужая — другого проекта или без метки (метка «$m», ждал «$mark»): не трогаю; переименуй worktree или префикс" ;;
    *) fail "$1" "список БД не прочитан (контейнер ${kv[контейнер]} запущен?): $m"$'\n'"$(retry)" ;;
  esac
}
q() { printf '%s' "${1//\'/\'\'}"; }
# Другой worktree (папка под root) с тем же именем БД — его БД не трогать.
twin() { # $1 — rel, $2 — имя БД; печатает путь двойника
  local d r
  while IFS= read -r d; do
    r=${d#"$root"/}
    [ "$r" != "$1" ] && [ "$(dbname "$r")" = "$2" ] && { echo "$d"; return 0; }
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null; find "$root" -mindepth 3 -maxdepth 3 -name .git -printf '%h\n' 2>/dev/null)
  return 1
}
guard() { # $1 — имя БД: не шаблон, не чужая
  [ "$1" != "${kv[шаблон]}" ] || die "имя БД $1 совпадает с шаблоном — переименуй worktree или префикс"
  local t; t=$(twin "$rel" "$1") && fail "$1" "то же имя у worktree $t — переименуй один из них"
  return 0
}
create() { # $1 — имя; $2 — re: пересоздать, если есть (только свою — own перед вызовом)
  local out was=создана
  if [ "$2" = re ] && exists "$1"; then
    out=$(sql "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)" 2>&1) || fail "$1" "не удалена: $out"$'\n'"$(retry)"
    was=пересоздана
  fi
  # Шаблон занят чужим подключением — postgres ждёт до 5 с, потом ошибка (P4).
  out=$(sql "CREATE DATABASE \"$1\" TEMPLATE \"${kv[шаблон]}\"" 2>&1) ||
    fail "$1" "не создана: $out"$'\n'"$(retry)"
  # Без метки БД стала бы «чужой» и для самого скрипта: только что созданную — сразу убрать, повтор пройдёт.
  if ! out=$(sql "COMMENT ON DATABASE \"$1\" IS '$(q "$mark")'" 2>&1); then
    sql "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)" >/dev/null 2>&1 &&
      fail "$1" "метка проекта не поставлена, БД убрана: $out"$'\n'"$(retry)"
    # Повтор упрётся в «чужая»: сначала убрать руками.
    fail "$1" "метка проекта не поставлена: $out"$'\n'"БД осталась без метки — снять руками: DROP DATABASE \"$1\", потом $(retry | sed 's/^повтор: //')"
  fi
  echo "БД $1 $was из шаблона ${kv[шаблон]} (${kv[контейнер]})"
}
# Пароль — и в user:pass@ (до последнего @), и в ?password=.
mask() { sed -E 's#(://[^:/@]*:)[^/]*@#\1***@#; s#([?&]password=)[^&]*#\1***#g'; }

case "$cmd" in
create|drop|run|name)
  wt=$1; shift
  locate "$wt"
  if [ "$cmd" = run ]; then
    [ "${1-}" = -- ] && shift
    if [ "$has" = 0 ]; then
      [ $# -gt 0 ] || die "нет раздела «Тестовая БД» в профиле проекта и нет команды"
      exec "$@"
    fi
    [ -d "$wt" ] || die "нет папки worktree $wt"
    db=$(dbname "$rel"); guard "$db"; own "$db"
    exists "$db" || create "$db" new >&2
    url=${kv[адрес]//\{db\}/$db}
    export "${kv[переменная]}=$url"
    echo "$me: ${kv[переменная]} → $(printf '%s' "$url" | mask)" >&2
    if [ $# -gt 0 ]; then exec "$@"; fi
    [ -n "${kv[тесты]-}" ] || die "нет команды и нет ключа «тесты» в разделе «Тестовая БД»"
    cd "$wt" || die "не войти в $wt"
    exec bash -c "${kv[тесты]}"
  fi
  [ "$has" = 1 ] || exit 0
  db=$(dbname "$rel")
  case "$cmd" in
    name) echo "$db" ;;
    create) [ -d "$wt" ] || die "нет папки worktree $wt"
            guard "$db"; own "$db"; create "$db" re ;;
    drop) guard "$db"; own "$db"
          exists "$db" || { echo "БД $db уже нет"; exit 0; }
          out=$(sql "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" 2>&1) || fail "$db" "не удалена: $out"$'\n'"$(retry)"
          echo "БД $db удалена" ;;
  esac ;;
orphans)
  [ $# -ge 2 ] || usage
  repo=$1; drop=${3-}
  [ "$(basename "$(realpath -m "$2")")" = worktrees ] || die "$2 — не папка <проект>/worktrees"
  locate "$(realpath -m "$2")/x"
  [ "$has" = 1 ] || exit 0
  # Живые — worktree репозитория под root, чья папка на месте (rm -rf оставляет запись git «prunable»),
  # плюс любая папка под root и любой worktree (.git) веток со слешем — на случай чужого repo.
  # Список не построен — стоп: пустой список сделал бы сиротами все БД.
  list=$(git -C "$repo" worktree list --porcelain) || die "git worktree list в $repo не прошёл — ничего не удаляю"
  live=$(
    { sed -n 's/^worktree //p' <<< "$list"; find "$root" -mindepth 1 -maxdepth 1 -type d
      find "$root" -mindepth 2 -maxdepth 3 -name .git -printf '%h\n'; } |
    while IFS= read -r p; do
      p=$(realpath -m "$p"); [[ $p == "$root"/* && -d $p ]] || continue
      dbname "${p#"$root"/}"; echo
    done)
  all=$(dblist 2>&1) || fail "список" "не прочитан: $all"
  rc=0
  # Сирота — только БД с меткой этого проекта (префикс не различает проекты), не шаблон и без живого worktree.
  while IFS= read -r line; do
    d=${line%%|*}
    [[ ${line#*|} == "$mark" && $d =~ ^[a-z0-9_]+$ && $d != "${kv[шаблон]}" ]] || continue
    grep -x -- "$d" <<< "$live" >/dev/null && continue
    if [ "$drop" = --drop ]; then
      if out=$(sql "DROP DATABASE IF EXISTS \"$d\" WITH (FORCE)" 2>&1 </dev/null); then echo "БД $d удалена (сирота)"
      else echo "$me: БД $d не удалена: $out" >&2; rc=3; fi
    else echo "$d"; fi
  done <<< "$all"
  exit $rc ;;
*) usage ;;
esac
