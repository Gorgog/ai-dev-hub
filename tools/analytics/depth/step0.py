#!/usr/bin/env python3
"""Long sessions, step 0: does rule compliance fall with the depth of the context epoch? A number, no model runs.

    python3 tools/analytics/depth/step0.py --data ~/hub-data --out ~/hub-data/baseline/step0.json \
        [--perms 10000] [--seed 11] [--k 50] [--checks-since 2026-10-21]

Reads <data>/analytics/calls.db (the calls database of 06: epoch and number in it, the subagent's own count),
<data>/journals (only what the database has no column for: the text of «Готово к пушу/мержу» reports, Skill inputs,
edit bodies of the repeat cases) and <data>/hub/research/memory-proto/cases.json (the repeats of set 32).
Opportunities and violations - by the shell parser (shell-rules.cjs), never by substring; `cd` - its own line, out of
the measure. Rules: git-add-all, sed-in-place (Edit calls are its kept opportunities), no-verify, clean-x,
worktree-force, checkout-dot, and the process step checks-full: a report of the main thread since --checks-since
with no `checks … --full` (Bash or the checks skill) after the session's last git commit before it.
Writes the threshold of acceptance §4, per thread kind (main, subagents) the buckets, the slope and its permutation p,
the late/early ratio and the verdict, the K calls before / after each compaction, the depth of each repeat, tokens per
task session. The same copy and arguments give the same file, byte for byte.
"""
import argparse
import glob
import json
import os
import sqlite3
import statistics as st
import subprocess
import sys
from datetime import date, datetime, timezone

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import depth  # noqa: E402
from calls import epoch_s, is_report, journal_order, read_jsonl  # noqa: E402

THRESHOLD = ('acceptance.md §4, шаг 0 [П]: наклон нарушений на возможность по глубине эпохи значим (перестановочный '
             'тест по сессиям, односторонний p ≤ 0,1) и поздний бакет ≥ 1,3× раннего; `cd` не входит')
EDIT_TOOLS = ('Edit', 'MultiEdit')


def kind_of(agent):
    return 'main' if agent == '' else 'subagents'


def shell_rules(cmds):
    if not cmds:
        return []
    out = subprocess.run(['node', os.path.join(HERE, 'shell-rules.cjs')], input=json.dumps(cmds), capture_output=True,
                         text=True, check=True).stdout
    return json.loads(out)


def old_body(i):
    """The body column of the research extractor (extract_calls.py) that the repeat cases were cut from."""
    cmd = i.get('command') if isinstance(i.get('command'), str) else None
    p = i.get('file_path') or i.get('notebook_path') or i.get('path')
    body = i.get('new_string') or i.get('content') or i.get('prompt') or i.get('text') or ''
    if not isinstance(body, str):
        body = json.dumps(body, ensure_ascii=False)
    if not cmd and not p and not body:
        body = json.dumps(i, ensure_ascii=False)[:2000]
    return body[:4000]


def matches(case, name, inp, t):
    p = case['probe']
    if name != p['tool'] or abs((datetime.fromtimestamp(t, timezone.utc).date() - date.fromisoformat(case['date'])).days) > 1:
        return False
    if p.get('cmd'):
        return inp.get('command') == p['cmd']
    if p.get('path'):
        path = inp.get('file_path') or inp.get('notebook_path') or inp.get('path')
        return path == p['path'] and old_body(inp) == p.get('body', '')
    return old_body(inp) == p.get('body', '')


def is_checks_skill(name, inp):
    return name == 'Skill' and str(inp.get('skill') or '').split(':')[-1] == 'checks' and '--full' in str(inp.get('args') or '').split()


class Journals:
    """One pass over the journals: reports of the main threads with their depth, checks-skill calls, repeat cases.
    The main thread's epoch and number are counted as calls.py counts them and checked against the database."""

    def __init__(self, db, cases):
        self.db, self.cases = db, cases
        self.reports = []           # (session, epoch, depth, t, order)
        self.checks_ids = set()
        self.found = {}             # case id -> [tool ids]
        self.checked = self.mismatched = 0
        self.seen = set()

    def tool_use(self, name, inp, tid, t):
        if is_checks_skill(name, inp):
            self.checks_ids.add(tid)
        for c in self.cases:
            if matches(c, name, inp, t):
                ids = self.found.setdefault(c['id'], [])
                if tid not in ids:
                    ids.append(tid)

    def scan(self, path, sid, main):
        epoch, n = 0, 0
        for o in read_jsonl(path):
            typ, ts = o.get('type'), o.get('timestamp')
            if not isinstance(ts, str) or not ts:
                continue
            try:
                t = epoch_s(ts)
            except ValueError:
                continue
            uid = o.get('uuid')
            dup = isinstance(uid, str) and uid in self.seen
            if isinstance(uid, str):
                self.seen.add(uid)
            if typ == 'system' and o.get('subtype') == 'compact_boundary':
                epoch, n = epoch + 1, 0
                continue
            if typ != 'assistant' or (main and o.get('isSidechain')):
                continue
            content = (o.get('message') or {}).get('content')
            for b in content if isinstance(content, list) else []:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'text' and main and not dup and is_report(b.get('text')):
                    self.reports.append((sid, epoch, n, t, n + 0.5))
                if b.get('type') != 'tool_use':
                    continue
                n += 1
                name, inp, tid = str(b.get('name') or ''), b.get('input'), b.get('id')
                inp = inp if isinstance(inp, dict) else {}
                self.tool_use(name, inp, tid, t)
                if not main or dup:
                    continue
                row = self.db.get(tid)
                if row and row['session'] == sid and row['agent'] == '':
                    self.checked += 1
                    self.mismatched += (row['epoch'], row['n']) != (epoch, n)
                if (name == 'SendMessage' or name.endswith('send_message')) and is_report(str(inp.get('message') or '')):
                    self.reports.append((sid, epoch, n, t, n))

    def run(self, root):
        for f in journal_order(glob.glob(os.path.join(root, '*', '*.jsonl'))):
            sid = os.path.basename(f)[:-len('.jsonl')]
            self.scan(f, sid, True)
            for af in sorted(glob.glob(os.path.join(f[:-len('.jsonl')], 'subagents', '**', 'agent-*.jsonl'), recursive=True)):
                self.scan(af, sid, False)


def opportunities(rows, flags, j, checks_since):
    """(rule opportunities, cd opportunities): dicts with kind, stratum, rule, depth, v, session, agent, epoch."""
    rules, cds = [], []
    commits, checks = {}, {}  # session -> [(t, n, order in the command)]
    for r in rows:
        f = flags.get(r['id'])
        for i, e in enumerate(f['events'] if f else []):
            (commits if e == 'commit' else checks).setdefault(r['session'], []).append((r['t'], r['n'], i))
        if r['id'] in j.checks_ids:
            checks.setdefault(r['session'], []).append((r['t'], r['n'], 0))
        found = dict(f['rules']) if f else {}
        if r['tool'] in EDIT_TOOLS:
            found['sed-in-place'] = 0
        for rule, v in sorted(found.items()):
            o = {'kind': kind_of(r['agent']), 'stratum': f"{r['session']}/{r['agent']}|{rule}", 'rule': rule,
                 'depth': r['n'], 'v': v, 'session': r['session'], 'agent': r['agent'], 'epoch': r['epoch']}
            (cds if rule == 'cd' else rules).append(o)
    for sid, epoch, d, t, order in sorted(j.reports):
        if t < checks_since:
            continue
        key = (t, order, 0)
        last = max((c for c in commits.get(sid, []) if c < key), default=None)
        ok = any((last is None or c > last) and c < key for c in checks.get(sid, []))
        rules.append({'kind': 'main', 'stratum': f'{sid}/|checks-full', 'rule': 'checks-full', 'depth': d, 'v': 0 if ok else 1,
                      'session': sid, 'agent': '', 'epoch': epoch})
    return rules, cds


def around_compactions(opps, epoch_len, k):
    """Opportunities in the last k calls of an epoch of a main thread before a compaction and the first k after it."""
    before, after = [], []
    bounds = {(s, e) for (s, a, e) in epoch_len if a == '' and (s, '', e + 1) in epoch_len}
    for o in opps:
        if o['agent'] != '':
            continue
        s, e = o['session'], o['epoch']
        if (s, e) in bounds and o['depth'] > epoch_len[(s, '', e)] - k:
            before.append(o)
        if (s, e - 1) in bounds and o['depth'] <= k:
            after.append(o)
    return {'before': depth.counts(before), 'after': depth.counts(after), 'compactions': len(bounds)}


def repeats(cases, j, db, epoch_len):
    out = []
    for c in cases:
        ids = [i for i in j.found.get(c['id'], []) if i in db]
        row = {'id': c['id'], 'kind': c['kind'], 'date': c['date'], 'found': bool(ids), 'candidates': len(ids)}
        if ids:
            r = min((db[i] for i in ids), key=lambda r: (r['t'], r['n']))
            kind = kind_of(r['agent'])
            n = epoch_len[(r['session'], r['agent'], r['epoch'])]
            lo, hi = depth.BUCKETS[kind][depth.bucket(r['n'], kind)]
            row.update({'thread': kind, 'epoch': r['epoch'], 'depth': r['n'], 'epoch_len': n,
                        'position': round(r['n'] / n, 3), 'bucket': depth.label(lo, hi)})
        out.append(row)
    found = [r for r in out if r['found']]
    by = {}
    for r in found:
        by.setdefault(f"{r['thread']} {r['bucket']}", 0)
        by[f"{r['thread']} {r['bucket']}"] += 1
    return {'cases': out, 'total': {'real': len(out), 'found': len(found)}, 'by_bucket': dict(sorted(by.items())),
            'depth_median': st.median([r['depth'] for r in found]) if found else None,
            'position_median': st.median([r['position'] for r in found]) if found else None}


def tokens(con):
    rows = con.execute("select u.session, sum(u.output), sum(u.input + u.cache_create + u.cache_read) from usage u "
                       "join sessions s using(session) where s.kind='task' group by u.session").fetchall()
    return {'task_sessions': len(rows), 'output_median': st.median([r[1] for r in rows]) if rows else None,
            'input_median': st.median([r[2] for r in rows]) if rows else None,
            'how': 'task sessions with their subagents: output and input (with cache) tokens per session, median'}


def build(a):
    con = sqlite3.connect(a.db)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute('select id, t, session, agent, epoch, n, tool, cmd from calls order by t, rowid')]
    db = {r['id']: r for r in rows}
    epoch_len = {}
    for r in rows:
        key = (r['session'], r['agent'], r['epoch'])
        epoch_len[key] = max(epoch_len.get(key, 0), r['n'])
    bash = [r for r in rows if r['tool'] == 'Bash' and r['cmd'] is not None]
    flags = dict(zip([r['id'] for r in bash], shell_rules([r['cmd'] for r in bash])))
    cases = [c for c in json.load(open(a.cases, encoding='utf-8')) if not c.get('synthetic')] if os.path.exists(a.cases) else []
    j = Journals(db, cases)
    j.run(a.journals)
    rules, cds = opportunities(rows, flags, j, epoch_s(a.checks_since + 'T00:00:00Z'))

    threads = {}
    for kind in ('main', 'subagents'):
        s = depth.thread_stats([o for o in rules if o['kind'] == kind], kind, a.perms, a.seed)
        s['cd'] = depth.thread_stats([o for o in cds if o['kind'] == kind], kind, a.perms, a.seed)
        threads[kind] = s
    early = threads['main']['buckets'][0]
    comp_rules = around_compactions(rules, epoch_len, a.k)
    comp = {'k': a.k, 'rules': comp_rules, 'cd': around_compactions(cds, epoch_len, a.k),
            'early_rate_main': round(early['viol'] / early['opps'], 4) if early['opps'] else None,
            'rate_before': round(comp_rules['before']['viol'] / comp_rules['before']['opps'], 4) if comp_rules['before']['opps'] else None,
            'rate_after': round(comp_rules['after']['viol'] / comp_rules['after']['opps'], 4) if comp_rules['after']['opps'] else None}
    verdict = depth.overall([threads[k]['verdict'] for k in threads])
    out = {
        'threshold': {'text': THRESHOLD, 'p_max': depth.P_MAX, 'ratio_min': depth.RATIO_MIN, 'late_min': depth.LATE_MIN,
                      'buckets': {k: [depth.label(lo, hi) for lo, hi in v] for k, v in depth.BUCKETS.items()}},
        'verdict': verdict,
        'verdict_by_thread': {k: threads[k]['verdict'] for k in threads},
        'borderline': any(threads[k]['borderline'] for k in threads),
        'threads': threads,
        'compaction': comp,
        'repeats': repeats(cases, j, db, epoch_len),
        'tokens': tokens(con),
        'depth_check': {'checked': j.checked, 'mismatched': j.mismatched},
        'reports': {'found': len(j.reports), 'since': a.checks_since},
        'calls': len(rows),
        'command': 'python3 tools/analytics/depth/step0.py --data <data> --out <file>'
                   f' --perms {a.perms} --seed {a.seed} --k {a.k} --checks-since {a.checks_since}',
    }
    con.close()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--db')
    ap.add_argument('--journals')
    ap.add_argument('--cases')
    ap.add_argument('--perms', type=int, default=10000)
    ap.add_argument('--seed', type=int, default=11)
    ap.add_argument('--k', type=int, default=50)
    ap.add_argument('--checks-since', default='2026-10-21')
    a = ap.parse_args()
    data = os.path.expanduser(a.data)
    a.db = a.db or os.path.join(data, 'analytics', 'calls.db')
    a.journals = a.journals or os.path.join(data, 'journals')
    a.cases = a.cases or os.path.join(data, 'hub', 'research', 'memory-proto', 'cases.json')
    out = build(a)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')
    print(json.dumps({'verdict': out['verdict'], 'by_thread': out['verdict_by_thread'], 'borderline': out['borderline'],
                      'out': a.out}, ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
