#!/usr/bin/env python3
"""Baseline of the hub's day metrics (acceptance §3) from a hub-data copy: rebuilds the calls database and writes the
metrics, the copy counts and the gaps against the 04.11 research to one JSON file.

    python3 tools/analytics/baseline.py --data ~/hub-data --out ~/hub-data/baseline/v1.json \
        [--since 2026-10-19] [--until 2026-11-04T21:55:00Z] [--from-version SHA] [--to-version SHA] [--user-re RE]
        [--reference FILE]

Reads <data>/journals, <data>/bundles/hub.bundle (hub versions), <data>/hub/projects/*/memory; writes
<data>/analytics/calls.db and --out. The default window is v1: from the first hub commit (19.10, the dispatcher era)
to the first session of the v2 rebuild (04.11 21:55 UTC). "After" a release - the same script with --from-version
<its merge>. --user-re (default: "user_re" of <data>/analytics/user.json) - how sessions name the user in «Ждёт:».
The same copy and the same arguments give the same file, byte for byte (no run time inside).
--reference (default <data>/baseline/research-2026-11-04.json): {metric: {value, source}} - numbers of the 04.11
research; each becomes a line of `discrepancies` with the recomputed value and the command next to it.
"""
import argparse
import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calls  # noqa: E402
import metrics  # noqa: E402

V1_SINCE, V1_UNTIL = '2026-10-19', '2026-11-04T21:55:00Z'


def discrepancies(ref, got):
    out = []
    for name in sorted(ref):
        r = ref[name] if isinstance(ref[name], dict) else {'value': ref[name]}
        m = got.get(name)
        if m is None:
            continue
        rv, mv = r.get('value'), m['value']
        delta = None
        if isinstance(rv, (int, float)) and isinstance(mv, (int, float)) and rv:
            delta = round(100 * (mv - rv) / rv, 1)
        out.append({'metric': name, 'research': rv, 'recomputed': mv, 'delta_pct': delta,
                    'source': r.get('source'), 'note': r.get('note'), 'command': m['command']})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--reference')
    metrics.add_window_args(ap)
    ap.set_defaults(since=V1_SINCE, until=V1_UNTIL)
    a = ap.parse_args()
    data = a.data
    db = os.path.join(data, 'analytics', 'calls.db')
    hp = os.path.join(data, 'hub', 'projects')
    user = os.path.join(data, 'analytics', 'user.json')
    if a.user_re is None and os.path.exists(user):
        a.user_re = json.load(open(user, encoding='utf-8')).get('user_re')
    copy = calls.build(os.path.join(data, 'journals'), db, os.path.join(data, 'bundles', 'hub.bundle'))
    window = metrics.window_of(a)
    got, counts = metrics.compute(db, hp, window)
    ref_path = a.reference or os.path.join(data, 'baseline', 'research-2026-11-04.json')
    ref = json.load(open(ref_path, encoding='utf-8')) if os.path.exists(ref_path) else {}
    res = {'window': window, 'copy': copy, 'window_counts': counts, 'metrics': got,
           'discrepancies': discrepancies(ref, got)}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(json.dumps(res, ensure_ascii=False, indent=1, sort_keys=True) + '\n')
    os.replace(tmp, a.out)
    print(json.dumps({'out': a.out, 'copy': copy, 'calls_in_window': counts['calls']}, sort_keys=True))


if __name__ == '__main__':
    sys.exit(main())
