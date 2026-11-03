#!/usr/bin/env bash
# Run a heavy or medium job in its own cgroup (systemd user scope): a memory ceiling that kills only this job, lower
# CPU weight than the desktop and the sessions, an optional timeout, and one handle to stop the whole process tree.
# usage:
#   hub-run.sh <name> [-MemoryMax 4G] [-MemorySwapMax <1/4 of max>] [-MemoryHigh <none>] [-CPUWeight 50]
#              [-Timeout <sec>] -- <command...>
#   hub-run.sh --list                     hub-* units: state, memory now / peak / max, CPU, run time
#   hub-run.sh --stop <name-or-prefix>    stop every unit hub-<prefix>-* (the whole tree) and forget failed ones
# <name> - <worktree>-<what> (TASK-7-jest): the unit is hub-<name>-<pid>, so --stop <worktree> stops all of its runs.
# MemoryHigh is off by default: it throttles instead of killing, and a job that grows into it stalls in reclaim
# (a probe at MemoryHigh 75M / MemoryMax 100M hung in D state for minutes) - set it only with swap room to spare.
# exit: the command's own code; 137 - killed at MemoryMax (or by the OOM killer); 124 - timeout; 2 - usage.
# Without a systemd user manager: setsid + a watchdog that kills the process group on timeout, NO memory ceiling.
# env HUB_RUN_NO_SYSTEMD=1 forces that fallback (tests).
set -uo pipefail
# C numbers in awk (1.5G, not 1,5G) without exporting LC_ALL=C to the job itself.
awk() { LC_ALL=C command awk "$@"; }
die() { echo "hub-run: $*" >&2; exit 2; }
usage() { sed -n 4,14p "$0" >&2; exit 2; }
sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_' | cut -c1-100; }
# 4G / 512M / 1.5G / 1073741824 -> bytes; infinity stays.
bytes() {
  [ "$1" = infinity ] && { echo infinity; return; }
  awk -v s="$1" 'BEGIN { if (s !~ /^[0-9]+(\.[0-9]+)?[KMGTkmgt]?$/) exit 1
    u = toupper(substr(s, length(s))); n = s + 0; m = 1
    if (u == "K") m = 1024; else if (u == "M") m = 1024 ^ 2; else if (u == "G") m = 1024 ^ 3; else if (u == "T") m = 1024 ^ 4
    printf "%.0f\n", n * m }'
}
human() { awk -v b="$1" 'BEGIN { if (b !~ /^[0-9]+$/) { print "-"; exit }
  if (b >= 1024 ^ 3) printf "%.1fG\n", b / 1024 ^ 3; else printf "%.0fM\n", b / 1024 ^ 2 }'; }
has_systemd() { [ "${HUB_RUN_NO_SYSTEMD-}" != 1 ] && command -v systemd-run >/dev/null && systemctl --user show-environment >/dev/null 2>&1; }

list() {
  has_systemd || die "нет systemd user-менеджера: unit-ов нет (фоллбэк-прогоны видны только как процессы)"
  local units
  units=$(systemctl --user list-units --type=scope --all --plain --no-legend 'hub-*' | awk '{ print $1 }')
  [ -n "$units" ] || { echo "hub-run: прогонов нет"; return 0; }
  local up; up=$(cut -d' ' -f1 /proc/uptime)
  # One `show` for all units: blocks of KEY=VALUE separated by blank lines.
  # shellcheck disable=SC2086
  systemctl --user show $units -p Id -p ActiveState -p Result -p MemoryCurrent -p MemoryPeak -p MemoryMax \
    -p CPUUsageNSec -p ActiveEnterTimestampMonotonic |
  awk -F= -v up="$up" '
    function h(b) { if (b !~ /^[0-9]+$/) return "-"; return b >= 1024 ^ 3 ? sprintf("%.1fG", b / 1024 ^ 3) : sprintf("%.0fM", b / 1024 ^ 2) }
    function dur(s) { s = int(s); return s >= 3600 ? sprintf("%dч%02dм", s / 3600, (s % 3600) / 60) : sprintf("%dм%02dс", s / 60, s % 60) }
    function flush() { if (!id) return
      st = v["ActiveState"]; if (v["Result"] != "success" && v["Result"] != "") st = st "/" v["Result"]
      cpu = v["CPUUsageNSec"] ~ /^[0-9]+$/ ? sprintf("%.0fс", v["CPUUsageNSec"] / 1e9) : "-"
      t = v["ActiveEnterTimestampMonotonic"] > 0 ? dur(up - v["ActiveEnterTimestampMonotonic"] / 1e6) : "-"
      printf "%-44s %-16s mem %6s пик %6s из %6s  cpu %6s  %s\n", id, st, h(v["MemoryCurrent"]), h(v["MemoryPeak"]), h(v["MemoryMax"]), cpu, t
      id = ""; delete v }
    /^$/ { flush(); next }
    { k = $1; sub(/^[^=]*=/, ""); v[k] = $0; if (k == "Id") id = $0 }
    END { flush() }'
}

stop() {
  has_systemd || die "нет systemd user-менеджера: гасить фоллбэк-прогон — kill -- -<PGID> из ps"
  local p; p=$(sanitize "$1")
  [ -n "$p" ] || usage
  local units
  units=$(systemctl --user list-units --type=scope --all --plain --no-legend "hub-$p-*" | awk '{ print $1 }')
  [ -n "$units" ] || { echo "hub-run: нет unit-ов hub-$p-*" >&2; return 1; }
  # shellcheck disable=SC2086
  systemctl --user stop $units 2>/dev/null
  # shellcheck disable=SC2086
  systemctl --user reset-failed $units 2>/dev/null
  echo "$units" | sed 's/^/остановлен /'
}

case "${1-}" in
  --list|-List) list; exit $? ;;
  --stop|-Stop) [ $# -eq 2 ] || usage; stop "$2"; exit $? ;;
  ''|-*) usage ;;
esac
name=$(sanitize "$1"); shift
mem_max=4G; mem_high=''; swap_max=''; cpu_weight=50; timeout=''
while [ $# -gt 0 ]; do
  case "$1" in
    -MemoryMax|--memory-max) mem_max=${2-}; shift 2 ;;
    -MemoryHigh|--memory-high) mem_high=${2-}; shift 2 ;;
    -MemorySwapMax|--memory-swap-max) swap_max=${2-}; shift 2 ;;
    -CPUWeight|--cpu-weight) cpu_weight=${2-}; shift 2 ;;
    -Timeout|--timeout) timeout=${2-}; shift 2 ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
[ $# -gt 0 ] || usage
max_b=$(bytes "$mem_max") || die "MemoryMax '$mem_max' — нужно число с K/M/G или infinity"
if [ "$max_b" = infinity ]; then high_b=${mem_high:-infinity}; swap_b=${swap_max:-infinity}
else
  high_b=$(bytes "${mem_high:-infinity}") || die "MemoryHigh '$mem_high' — нужно число с K/M/G"
  swap_b=$(bytes "${swap_max:-$((max_b / 4))}") || die "MemorySwapMax '$swap_max' — нужно число с K/M/G"
fi
[[ $cpu_weight =~ ^[0-9]+$ ]] || die "CPUWeight '$cpu_weight' — нужно число 1..10000"
[ -z "$timeout" ] || [[ $timeout =~ ^[0-9]+$ ]] || die "Timeout '$timeout' — нужно число секунд"
unit="hub-$name-$$.scope"

if ! has_systemd; then
  echo "hub-run: ВНИМАНИЕ: нет systemd user-менеджера — без лимита памяти, только таймаут и убийство группы" >&2
  mark=$(mktemp); trap 'rm -f "$mark"' EXIT
  setsid "$@" & pid=$!
  dog=''
  if [ -n "$timeout" ]; then
    # Detached from our stdout/stderr: a sleep left behind never holds the caller's pipe open.
    ( trap 'kill "$s" 2>/dev/null; exit 0' TERM
      sleep "$timeout" & s=$!; wait "$s"
      echo t > "$mark"; kill -TERM -- -"$pid" ) >/dev/null 2>&1 &
    dog=$!
  fi
  trap 'kill -TERM -- -"$pid" 2>/dev/null; sleep 1; kill -KILL -- -"$pid" 2>/dev/null' INT TERM
  wait "$pid"; rc=$?
  [ -n "$dog" ] && kill "$dog" 2>/dev/null
  if [ -s "$mark" ]; then
    # Like timeout -k 10: the rest of the group gets 10 s after TERM, then KILL.
    for _ in $(seq 20); do kill -0 -- -"$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- -"$pid" 2>/dev/null
    echo "hub-run: $name — таймаут ${timeout} с: группа процессов убита" >&2; exit 124
  fi
  # The command is gone, its children may live on in the group: kill them, as the scope would.
  kill -KILL -- -"$pid" 2>/dev/null
  exit "$rc"
fi

props=(-p OOMPolicy=stop -p "MemoryMax=$max_b" -p "MemoryHigh=$high_b" -p "MemorySwapMax=$swap_b" -p "CPUWeight=$cpu_weight")
[ -n "$timeout" ] && props+=(-p "RuntimeMaxSec=$timeout")
# Not --collect: a scope killed at MemoryMax or on timeout stays «failed» until reset-failed, so its Result and
# MemoryPeak can be read below; the script collects it itself. OOMScoreAdjust is not a scope property: the wrapper
# raises its own score (children inherit it) so the kernel, short of memory, kills a job before the desktop.
# The wrapper stays in the scope after the command: it prints the peak of a run that ended on its own. Its own
# stderr is muted (bash's «Killed "$@"»), the command's goes to the caller via fd 3.
# The subshell keeps bash's «Terminated <command line>» note (a job killed by a signal) off the user's stderr.
t0=$SECONDS
trap 'systemctl --user stop "$unit" 2>/dev/null' INT TERM HUP
( systemd-run --user --scope -q --expand-environment=no --unit="$unit" "${props[@]}" -- bash -c '
  exec 3>&2 2>/dev/null
  echo 500 > /proc/self/oom_score_adj
  "$@" 2>&3 3>&-; rc=$?
  cg=$(sed -n "s/^0:://p" /proc/self/cgroup)
  peak=$(cat "/sys/fs/cgroup$cg/memory.peak" 2>/dev/null)
  [ -n "$peak" ] && printf "hub-run: %s · код %s · пик %s\n" "${cg##*/}" "$rc" "$(LC_ALL=C awk -v b="$peak" "BEGIN { g = 1024 ^ 3; if (b >= g) printf \"%.1fG\", b / g; else printf \"%.0fM\", b / 1024 ^ 2 }")" >&3
  exit $rc' hub-run "$@" 2>&3
  exit $? ) 3>&2 2>/dev/null
rc=$?
trap - INT TERM HUP
mapfile -t st < <(systemctl --user show "$unit" -p Result -p MemoryPeak --value 2>/dev/null)
result=${st[0]-}; peak=${st[1]-}
case "$result" in
  oom-kill)
    echo "hub-run: $name — убит: MemoryMax $mem_max (пик $(human "$peak")), остальное не тронуто" >&2
    rc=137 ;;
  timeout)
    echo "hub-run: $name — таймаут ${timeout} с ($((SECONDS - t0)) с): прогон остановлен целиком" >&2
    rc=124 ;;
esac
# A scope that ended on its own is already gone; a failed one stays until this.
[ -n "$result" ] && [ "$result" != success ] && systemctl --user reset-failed "$unit" 2>/dev/null
exit "$rc"
