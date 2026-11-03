#!/usr/bin/env bash
# Memory headroom and pressure before granting a heavy resource, plus dev-server port check (Linux).
# usage: bash headroom.sh [-Ports 3005,3001] [-MinGB 4] [-MinPhysGB 1] [-MaxPsiSome 10] [-MaxPsiFull 2] [-Worktrees <root>]
# exit: 0 - OK to grant; 2 - headroom (available + free swap) below MinGB;
#       5 - memory pressure (PSI): full avg10 >= MaxPsiFull or some avg60 >= MaxPsiSome - the kernel is already
#           stalling tasks on reclaim, do not grant even with GBs «free»;
#       3 - a port is busy or could not be checked;
#       4 - available PHYSICAL memory below MinPhysGB: heavy may go alone, do not grant medium alongside it.
#       (Pilot 2026-10-19: headroom stayed > 12 GB while free physical fell to 0.5 GB.)
#       Several reasons - the first of 2, 5, 3, 4 is the code; every line is printed anyway.
# Linux overcommits, so CommitLimit is not a ceiling: headroom = MemAvailable + SwapFree (zram included),
# physical = MemAvailable.
# -Worktrees <root>: who eats - Pss of processes whose cwd is inside each <root>/<worktree> (sessions, dev servers,
# test runs), plus the hub-* units of hub-run.sh with their current and peak memory.
# env HEADROOM_PSI_FILE - another PSI file instead of /proc/pressure/memory (tests).
set -uo pipefail
export LC_ALL=C
ports=''; min_gb=4; min_phys_gb=1; max_psi_some=10; max_psi_full=2; wt_root=''
while [ $# -gt 0 ]; do
  case "$1" in
    -Ports|--ports) ports=${2-}; shift 2 ;;
    -MinGB|--min-gb) min_gb=${2-}; shift 2 ;;
    -MinPhysGB|--min-phys-gb) min_phys_gb=${2-}; shift 2 ;;
    -MaxPsiSome|--max-psi-some) max_psi_some=${2-}; shift 2 ;;
    -MaxPsiFull|--max-psi-full) max_psi_full=${2-}; shift 2 ;;
    -Worktrees|--worktrees) wt_root=${2-}; shift 2 ;;
    *) sed -n 3,10p "$0"; exit 2 ;;
  esac
done
kb() { awk -v k="$1:" '$1 == k { print $2 }' /proc/meminfo; }
avail=$(kb MemAvailable); total=$(kb MemTotal); swap_free=$(kb SwapFree); swap_total=$(kb SwapTotal)
rc=0
read -r head_gb phys_gb line < <(awk -v a="$avail" -v t="$total" -v sf="$swap_free" -v st="$swap_total" 'BEGIN {
  g = 1024 * 1024; h = (a + sf) / g
  printf "%.1f %.1f MEMORY used %.1f of %.1f GB + swap %.1f of %.1f GB, headroom %.1f GB; available physical %.1f GB\n",
    h, a / g, (t - a) / g, t / g, (st - sf) / g, st / g, h, a / g }')
echo "$line"
lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }
if lt "$head_gb" "$min_gb"; then echo "DO NOT GRANT: headroom below $min_gb GB"; rc=2; fi

# PSI: share of time some / all non-idle tasks were stalled on memory (reclaim, swap-in, thrashing).
psi=${HEADROOM_PSI_FILE:-/proc/pressure/memory}
if [ -r "$psi" ]; then
  read -r psi_some psi_some60 psi_full < <(awk '
    { for (i = 2; i <= NF; i++) { split($i, kv, "="); v[$1 "_" kv[1]] = kv[2] } }
    END { print v["some_avg10"] + 0, v["some_avg60"] + 0, v["full_avg10"] + 0 }' "$psi")
  echo "PSI memory: some avg10 $psi_some% avg60 $psi_some60%, full avg10 $psi_full% (limits: some avg60 $max_psi_some, full avg10 $max_psi_full)"
  if ! lt "$psi_full" "$max_psi_full" || ! lt "$psi_some60" "$max_psi_some"; then
    echo "DO NOT GRANT: memory pressure - tasks are stalling on reclaim"; [ $rc -eq 0 ] && rc=5
  fi
else
  echo "PSI memory: $psi not readable - pressure not checked"
fi

for p in $(echo "$ports" | tr ',; ' '   '); do
  if ! [[ $p =~ ^[0-9]{1,5}$ ]] || [ "$p" -gt 65535 ]; then
    echo "port '$p' INVALID - not checked"; [ $rc -eq 0 ] && rc=3; continue
  fi
  l=$(ss -Hltnp "sport = :$p" 2>/dev/null | head -1)
  if [ -n "$l" ]; then
    # users:(("node",pid=1234,fd=20)) - only for own processes; root-owned listeners (docker-proxy) show no pid
    who=$(grep -o 'users:(("[^"]*",pid=[0-9]*' <<<"$l" | sed -E 's/users:\(\("([^"]*)",pid=([0-9]*)/PID \2 \1/')
    echo "port $p BUSY: ${who:-owner not visible (another user or docker)}"
    [ $rc -eq 0 ] && rc=3
  else
    echo "port $p free"
  fi
done
if [ $rc -eq 0 ] && lt "$phys_gb" "$min_phys_gb"; then
  echo "LOW PHYSICAL: available physical below $min_phys_gb GB - heavy may run alone, no medium alongside it"
  rc=4
fi

if [ -n "$wt_root" ]; then
  if root=$(realpath -e "$wt_root" 2>/dev/null); then
    echo "WORKTREES $root (Pss of processes whose cwd is inside):"
    # One find for every cwd link, one grep for every smaps_rollup: no spawns per process. grep, not awk: a process
    # gone in between is a missing file, and mawk stops at the first one. Pss splits shared pages between their
    # users, so the sums add up instead of counting a shared node twice.
    map=$(find /proc/[0-9]*/cwd -maxdepth 0 -printf '%p\t%l\n' 2>/dev/null |
      awk -F'\t' -v r="$root/" 'index($2 "/", r) == 1 && length($2) >= length(r) {
        w = substr($2, length(r) + 1); sub(/\/.*/, "", w); sub(/cwd$/, "smaps_rollup", $1); print $1 "\t" w }')
    if [ -z "$map" ]; then echo "  no processes inside"
    else
      # shellcheck disable=SC2046
      grep -H '^Pss:' $(cut -f1 <<<"$map") 2>/dev/null |
        awk -F'\t' -v map="$map" 'BEGIN { n = split(map, l, "\n"); for (i = 1; i <= n; i++) { split(l[i], f, "\t"); wt[f[1]] = f[2] } }
          { split($0, a, ":"); split(a[3], v, " "); s[wt[a[1]]] += v[1]; c[wt[a[1]]]++ }
          END { for (w in s) printf "%.2f %s %d\n", s[w] / 1048576, w, c[w] }' |
        sort -k1,1 -rn | awk '{ printf "  %-32s %6.2f GB  %d processes\n", $2, $1, $3 }'
    fi
  else
    echo "WORKTREES $wt_root: no such folder"
  fi
  echo "HUB-RUN units:"
  bash "$(dirname "$0")/hub-run.sh" --list 2>&1 | sed 's/^/  /'
fi
[ $rc -eq 0 ] && echo OK
exit $rc
