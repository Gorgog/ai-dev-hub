#!/usr/bin/env bash
# Memory headroom before granting a heavy resource, plus dev-server port check (Linux).
# usage: bash headroom.sh [-Ports 3005,3001] [-MinGB 4] [-MinPhysGB 1]
# exit: 0 - OK to grant; 2 - headroom (available + free swap) below MinGB; 3 - a port is busy or could not be checked;
#       4 - available PHYSICAL memory below MinPhysGB: heavy may go alone, do not grant medium alongside it.
#       (Pilot 2026-10-19: headroom stayed > 12 GB while free physical fell to 0.5 GB.)
# Linux overcommits, so CommitLimit is not a ceiling: headroom = MemAvailable + SwapFree, physical = MemAvailable.
set -uo pipefail
ports=''; min_gb=4; min_phys_gb=1
while [ $# -gt 0 ]; do
  case "$1" in
    -Ports|--ports) ports=${2-}; shift 2 ;;
    -MinGB|--min-gb) min_gb=${2-}; shift 2 ;;
    -MinPhysGB|--min-phys-gb) min_phys_gb=${2-}; shift 2 ;;
    *) sed -n 3,5p "$0"; exit 2 ;;
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
[ $rc -eq 0 ] && echo OK
exit $rc
