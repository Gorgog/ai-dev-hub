#!/usr/bin/env python3
"""The weekly improvement cycle (slice 24): the week's process audit from the calls database and the hub's journals,
the effectiveness of lessons and rules («prevented»), failure clusters, the dispatcher's push-gate skips (condition 27,
H09), optionally the hook-level polygon; then the reversible actions by rule and the questions on the irreversible,
and one message for the user.

    python3 tools/process-audit/weekly.py --data ~/hub-data --dry-run [--json]
    python3 tools/process-audit/weekly.py --data ~/hub-data --hub ~/ai-dev-hub --events <hooks data> --apply \
        [--refresh] [--polygon] [--out FILE]
    python3 tools/process-audit/weekly.py --data ~/hub-data --hub ~/ai-dev-hub --events <hooks data> --revert ID

Reads <data>/analytics/calls.db (06; --refresh first renews the copy: tools/hub-data/snapshot.py and calls.py),
<hub>/projects/*/ (rules.json, memory: errors.md of v1, lessons/ and events/ of v2; default <hub> - the copy
<data>/hub) and the delivery's event journal <events>/events/*.jsonl (12; the hooks' data folder). Window: --days
(7) up to --until (default: the last call of the copy).

Audit: metrics of acceptance §3 for the window (metrics.py), rule violations by the shell parser (shell-rules.cjs),
failure clusters - failed tool calls grouped by what ran (a wrapper is not the program), push gates - each push of a
dispatcher's main thread: through push-slice (gated), or a bare `git push`, a skip when no parallel-check ran before it
in that session. Effectiveness: rules-guard rules replayed over the window (hub-io.cjs: a reminder's window is the next
3 calls of the epoch), the delivery journal's counter, v2 lesson shows and repeats.

Actions by rule (reversible; --apply applies, each is an event of the journal with an id, --revert ID undoes):
  promote    a rule of a project one step up the ladder log → deny-once → deny when it had >= 5 windows and
             prevented < 50 %; the step to deny when the rule fires > 1 time in 100 Bash calls is a question instead
             (narrow it or ask - the project's threshold). Windows before the rule's last promotion do not count.
  retire     a v2 lesson past its own retirement condition (not shown or repeated for 30 days; never class «once»)
  candidate  polygon: a v1 lesson with «механизм: нет» that repeated - a scenario stub in <data>/process-audit/
             candidates/; rule: a 2nd similar episode (v1: повторов >= 2 with no mechanism, v2: a knowledge lesson
             that repeated) - rule 7. A candidate is new once: seen in the journal - not again.
Questions (irreversible, only asked): the deny step above; a lesson of class «once» that repeated - it needs a mechanism.
--dry-run (the default without --apply / --revert) writes nothing. --apply also adds the week's metrics to
<data>/process-audit/trend.jsonl (the summary shows the change against the previous row) and, with --out, the report.
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'analytics'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'analytics', 'depth'))
import metrics  # noqa: E402
from step0 import shell_rules  # noqa: E402

LADDER = ['log', 'deny-once', 'deny']
MIN_WINDOWS = 5
RATE_BELOW = 0.5
DENY_PER100 = 1.0
TOP = 5
NO_PROJECT = '(без проекта)'
ENTRY_RE = re.compile(r'^- \(')
TITLE_RE = re.compile(r'\*\*(.+?)\*\*')
REPEATS_RE = re.compile(r'повтор\w*:\s*(\d+)')
MECH_RE = re.compile(r'механизм:\s*([^·\n]+)')
SUMMARY_METRICS = [('touches_per_day', 'касаний/день'), ('first_ready_median_min', 'до «готово», мин'),
                   ('review_rounds_per_session', 'круги ревью'), ('heavy_queue_share_pct', 'очередь тяжёлого, %'),
                   ('false_blocks_per_day', 'ложные блоки/день'), ('repeats_per_week', 'повторы ошибок/нед')]


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def ident(*parts):
    return hashlib.sha1(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:12]


def hub_io(req):
    r = subprocess.run(['node', os.path.join(HERE, 'hub-io.cjs')], input=json.dumps(req), capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr.strip() or f'hub-io: код {r.returncode}')
    return json.loads(r.stdout)


def projects_of(hub):
    d = os.path.join(hub, 'projects')
    return sorted(p for p in os.listdir(d) if os.path.isdir(os.path.join(d, p))) if os.path.isdir(d) else []


def project_of(pdir, projects):
    """The journal folder (the session's cwd with / as -) → the hub project it is in: the longest name that follows
    «-projects-» and ends there or at a «-»."""
    best = None
    for p in projects:
        k = (pdir or '').find(f'-projects-{p}')
        end = k + len(f'-projects-{p}')
        if k != -1 and (end == len(pdir) or pdir[end] == '-') and (best is None or len(p) > len(best)):
            best = p
    return best


def read_jsonl(f):
    """Objects of a jsonl file; a torn or foreign line is skipped."""
    out = []
    if not os.path.exists(f):
        return out
    for line in open(f, encoding='utf-8', errors='replace'):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict):
            out.append(e)
    return out


def improve_events(events_dir):
    """The cycle's own events of the delivery's journal: what it did, asked and found in earlier weeks."""
    d = os.path.join(events_dir or '', 'events')
    if not events_dir or not os.path.isdir(d):
        return []
    return [e for f in sorted(os.listdir(d)) if re.match(r'^\d{4}-\d\d\.jsonl$', f)
            for e in read_jsonl(os.path.join(d, f)) if e.get('mode') == 'improve']


def v1_entries(hub, project):
    """errors.md of v1: one entry per «- (date, task) …» item, continuation lines joined."""
    f = os.path.join(hub, 'projects', project, 'memory', 'errors.md')
    if not os.path.exists(f):
        return []
    items, cur = [], None
    for line in open(f, encoding='utf-8', errors='replace'):
        if ENTRY_RE.match(line):
            cur = [line.strip()]
            items.append(cur)
        elif cur is not None and line.startswith((' ', '\t')) and line.strip():
            cur.append(line.strip())
        else:
            cur = None
    out = []
    for it in items:
        text = ' '.join(it)
        title, rep, mech = TITLE_RE.search(text), REPEATS_RE.search(text), MECH_RE.search(text)
        if title and rep and mech:
            out.append({'title': title.group(1).strip(), 'repeats': int(rep.group(1)), 'mechanism': mech.group(1).strip()})
    return out


def stub(project, title, cid):
    return (f"// Кандидат-сценарий полигона (цикл улучшения, {cid}): урок «{title}» проекта {project} повторялся, механизма нет.\n"
            "// Перенести в polygon/scenarios/H<NN>-<имя>.cjs своего диапазона, описать вход и проверку; данные — синтетика.\n"
            "'use strict';\n\nmodule.exports = {\n  id: 'H??', level: 'hook', contract: true,\n"
            f"  title: {json.dumps(title, ensure_ascii=False)},\n"
            "  async run() {\n    return [{ id: 'todo', kind: 'catch', pass: false, detail: 'кандидат: проверка не описана' }];\n  },\n};\n")


def gates(rows, flags):
    checked, res = {}, {'pushes': 0, 'bare': 0, 'via_push_slice': 0, 'skips': 0, 'list': []}
    for c in rows:
        f = flags[c['id']]
        s = c['session']
        if f['parallel_check']:
            checked[s] = True
        if f['push_slice']:
            res['pushes'] += 1
            res['via_push_slice'] += 1
            res['list'].append({'session': s, 'at': iso(c['t']), 'via': 'push-slice', 'skip': False})
        elif f['push']:
            skip = not checked.get(s)
            res['pushes'] += 1
            res['bare'] += 1
            res['skips'] += skip
            res['list'].append({'session': s, 'at': iso(c['t']), 'via': 'git push', 'skip': skip})
    return res


def clusters(rows, flags):
    by = {}
    for c in rows:
        if not c['is_error']:
            continue
        k = flags[c['id']]['sig']
        b = by.setdefault(k, {'key': k, 'count': 0, 'sessions': set()})
        b['count'] += 1
        b['sessions'].add(c['session'])
    out = [{'key': b['key'], 'count': b['count'], 'sessions': len(b['sessions'])} for b in by.values()]
    return sorted(out, key=lambda b: (-b['count'], b['key']))[:10]


def violations(rows):
    bash = [c for c in rows if c['tool'] == 'Bash' and c['cmd']]
    out = {}
    for c, f in zip(bash, shell_rules([c['cmd'] for c in bash])):
        for rule, v in f['rules'].items():
            if rule == 'cd':
                continue
            s = out.setdefault(rule, {'opps': 0, 'viol': 0})
            s['opps'] += 1
            s['viol'] += v
    return dict(sorted(out.items()))


def week_metrics(db_path, hub, since, until):
    db = sqlite3.connect(db_path)
    w = metrics.Window(db, since=since, until=until)
    m = metrics.Metrics(db, os.path.join(hub, 'projects'), w)
    out = {}
    for name in metrics.Metrics.NAMES:
        try:
            out[name] = m.one(name, db_path, os.path.join(hub, 'projects'))['value']
        except Exception as e:  # one metric that cannot be read on this copy does not stop the week
            out[name] = None
            out.setdefault('_errors', {})[name] = str(e).split('\n')[0][:200]
    db.close()
    return out


def plan(rep, entries, until, hub, data, seen):
    actions, questions = [], []
    seen_ids = {e.get('id') for e in seen}
    for p, rules in sorted(rep['effect']['rules'].items()):
        if p == NO_PROJECT:
            continue
        for rid, s in sorted(rules.items()):
            if s['mode'] not in LADDER[:-1] or s['windows'] < MIN_WINDOWS or s['rate'] is None or s['rate'] >= RATE_BELOW:
                continue
            to = LADDER[LADDER.index(s['mode']) + 1]
            why = f"окон {s['windows']}, предотвратил {s['prevented']}, повторов {s['repeat']}"
            if to == 'deny' and (s['per100'] or 0) > DENY_PER100:
                questions.append({'kind': 'question', 'id': ident('question', p, rid, to, until), 'project': p, 'rule': rid,
                                  'text': f"правило {rid} ({p}) не действует в режиме {s['mode']} ({why}), но срабатывает "
                                          f"{s['per100']} раза на 100 вызовов: deny будет мешать — сузить правило или ask?"})
                continue
            actions.append({'kind': 'promote', 'id': ident('promote', p, rid, s['mode'], to, until), 'project': p, 'rule': rid,
                            'from': s['mode'], 'to': to, 'reason': why})
    for r in rep['retire']:
        actions.append({'kind': 'retire', 'id': ident('retire', r['project'], r['lesson'], until), **r,
                        'reason': 'не показан и не повторялся 30 дней'})
    for p, lessons in sorted(rep['effect']['lessons'].items()):
        for lid, s in sorted(lessons.items()):
            if s['kind'] == 'once' and s['repeat']:
                questions.append({'kind': 'question', 'id': ident('question', p, lid, until), 'project': p, 'lesson': lid,
                                  'text': f"урок «одного раза» {lid} ({p}) повторился {s['repeat']} раз за неделю — "
                                          f"нужен механизм (правило хука или сценарий полигона)?"})
    cand = []
    for p, items in sorted(entries.items()):
        for e in items:
            if e['mechanism'] != 'нет':
                continue
            if e['repeats'] >= 1:
                cand.append({'what': 'polygon', 'project': p, 'title': e['title']})
            if e['repeats'] >= 2:
                cand.append({'what': 'rule', 'project': p, 'title': e['title']})
    for k in rep['knowledge']:
        cand.append({'what': 'rule', 'project': k['project'], 'lesson': k['lesson']})
    for c in cand:
        cid = ident('candidate', c['what'], c['project'], c.get('title') or c.get('lesson'))
        a = {'kind': 'candidate', 'id': cid, **c, 'reason': 'повтор без механизма' if c['what'] == 'polygon' else 'второй похожий эпизод (правило 7)'}
        if c['what'] == 'polygon':
            a['file'] = os.path.join(data, 'process-audit', 'candidates', f"{c['project']}-{cid}.cjs")
            a['stub'] = stub(c['project'], c['title'], cid)
        actions.append(a)
    return [a for a in actions if a['id'] not in seen_ids], [q for q in questions if q['id'] not in seen_ids]


def pct(x):
    return '—' if x is None else f'{round(100 * x)} %'


def summary(rep, prev):
    w = rep['window']
    lo, hi = w['since'][:10], w['until'][:10]
    lines = [f"Недельный итог хаба · {lo} – {hi} ({w['days']} дн.)"]
    m = rep['audit']['metrics']
    parts = []
    for name, label in SUMMARY_METRICS:
        v = m.get(name)
        if v is None:
            continue
        d = ''
        if prev and isinstance(prev.get(name), (int, float)) and isinstance(v, (int, float)):
            delta = round(v - prev[name], 1)
            d = f" ({'+' if delta > 0 else ''}{delta})" if delta else ' (=)'
        parts.append(f'{label} {v}{d}')
    lines.append('Метрики §3: ' + ('; '.join(parts) if parts else 'нет данных в окне'))
    g = rep['gates']
    lines.append(f"Ворота пуша: пушей диспетчера {g['pushes']} (через push-slice {g['via_push_slice']}), "
                 f"пропусков ворот пуша: {g['skips']} — условие 27")
    rules = [(p, rid, s) for p, rs in rep['effect']['rules'].items() for rid, s in rs.items() if s['windows']]
    rules.sort(key=lambda x: (-x[2]['windows'], x[0], x[1]))
    if rules:
        lines.append('Напоминания rules-guard (предотвратил / окон): ' + '; '.join(
            f"{rid} ({p}) {pct(s['rate'])} из {s['windows']}" for p, rid, s in rules[:TOP]))
    d = rep['effect']['delivery']
    if d is None:
        lines.append('Уроки, подача: не мерится (нет журнала событий подачи)')
    else:
        t = d['total']
        lines.append(f"Уроки, подача: показов {t['shown']}, с детектором {t['measured']}, предотвратил {t['prevented']}, "
                     f"повторов в окне {t['repeat']} ({pct(t['rate'])})")
    c = rep['clusters']
    lines.append('Провалы: ' + ('; '.join(f"{x['key']} ×{x['count']}" for x in c[:TOP]) if c else 'нет'))
    pg = rep.get('polygon')
    if pg:
        lines.append(f"Полигон (hook): {pg['green']} из {pg['scenarios']} зелёные" + (f"; красные: {', '.join(pg['red'])}" if pg['red'] else ''))
    acts = rep['actions']
    if acts:
        n = lambda k: sum(1 for a in acts if a['kind'] == k)  # noqa: E731
        lines.append(f"Сделано сам (обратимо): повышено правил {n('promote')}, в отставку {n('retire')}, кандидатов {n('candidate')}"
                     f" — откат: weekly.py --revert <id>")
        for a in [a for a in acts if a['kind'] in ('promote', 'retire')][:TOP]:
            what = f"{a['rule']}: {a['from']} → {a['to']}" if a['kind'] == 'promote' else f"урок {a['lesson']} в отставку"
            lines.append(f"  · {what} ({a['project']}; {a['reason']}) [{a['id']}]")
    if rep['questions']:
        lines.append('Вопросы (необратимое):')
        for k, q in enumerate(rep['questions'][:TOP], 1):
            lines.append(f'  {k}. {q["text"]}')
    else:
        lines.append('Вопросов нет.')
    return '\n'.join(lines)


def polygon(data, until):
    out = os.path.join(data, 'polygon', f'weekly-{until[:10]}.json')
    subprocess.run(['node', os.path.join(ROOT, 'polygon', 'run.cjs'), '--level', 'hook', '--out', out, '--quiet'],
                   capture_output=True, text=True)
    return polygon_result(out)


def polygon_result(f):
    try:
        res = json.load(open(f, encoding='utf-8'))['results']
    except (OSError, ValueError, KeyError):
        return None
    red = sorted({r['id'] for r in res if not r.get('contract') and any(not ch.get('pass') for run in r.get('runs', [])
                                                                        for ch in run.get('checks', []))})
    return {'scenarios': len(res), 'green': len(res) - len(red), 'red': red, 'file': f}


def refresh(data, hub):
    subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'hub-data', 'snapshot.py'), '--dest', data, '--hub', hub],
                   check=True, capture_output=True)
    import calls  # noqa: E402
    calls.build(os.path.join(data, 'journals'), os.path.join(data, 'analytics', 'calls.db'),
                os.path.join(data, 'bundles', 'hub.bundle'))


def write_atomic(f, text):
    os.makedirs(os.path.dirname(os.path.abspath(f)), exist_ok=True)
    tmp = f'{f}.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        fh.write(text)
    os.replace(tmp, f)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', required=True)
    ap.add_argument('--hub')
    ap.add_argument('--events')
    ap.add_argument('--until')
    ap.add_argument('--days', type=int, default=7)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--revert', metavar='ID')
    ap.add_argument('--json', action='store_true', help='the report as JSON on stdout (else the summary)')
    ap.add_argument('--out')
    ap.add_argument('--refresh', action='store_true')
    ap.add_argument('--polygon', action='store_true')
    ap.add_argument('--polygon-result')
    a = ap.parse_args()
    data = os.path.abspath(os.path.expanduser(a.data))
    hub = os.path.abspath(os.path.expanduser(a.hub)) if a.hub else os.path.join(data, 'hub')
    events = os.path.abspath(os.path.expanduser(a.events)) if a.events else None
    base_rules = os.path.join(hub, 'plugin', 'hooks', 'base-rules.json')
    if not os.path.exists(base_rules):
        base_rules = os.path.join(ROOT, 'plugin', 'hooks', 'base-rules.json')

    if a.revert:
        if not events:
            raise SystemExit('--revert: нужен --events (журнал событий, где записано действие)')
        print(json.dumps(hub_io({'op': 'revert', 'hub': hub, 'base_rules': base_rules, 'events_dir': events, 'id': a.revert}),
                         ensure_ascii=False))
        return 0
    if a.apply and a.refresh:
        refresh(data, hub)

    db_path = os.path.join(data, 'analytics', 'calls.db')
    if not os.path.exists(db_path):
        raise SystemExit(f'нет базы вызовов {db_path}: сначала tools/analytics/baseline.py или --refresh')
    db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    hi = metrics.to_t(a.until) if a.until else (db.execute('select max(t) from calls').fetchone()[0] or 0)
    lo = (datetime.fromtimestamp(hi, timezone.utc) - timedelta(days=a.days)).timestamp()
    since, until = iso(lo), iso(hi)
    projects = projects_of(hub)
    kinds = dict(db.execute('select session, kind from sessions').fetchall())
    cols = ['id', 't', 'session', 'agent', 'epoch', 'n', 'pdir', 'tool', 'cmd', 'path', 'is_error']
    rows = [dict(zip(cols, r)) for r in db.execute(
        f"select {', '.join(cols)} from calls where t >= ? and t < ? order by session, agent, epoch, n, rowid", (lo, hi))]
    db.close()
    for c in rows:
        c['project'] = project_of(c['pdir'], projects)

    seen = improve_events(events)
    rules_since = {}
    for e in seen:
        if e.get('kind') in ('promote', 'revert') and e.get('rule') and isinstance(e.get('at'), str):
            k = f"{e.get('project')}/{e['rule']}"
            rules_since[k] = max(rules_since.get(k, 0), metrics.to_t(e['at']))
    io = hub_io({'op': 'read', 'hub': hub, 'base_rules': base_rules, 'events_dir': events, 'projects': projects,
                 'since': since, 'until': until, 'rules_since': rules_since,
                 'calls': [{k: c[k] for k in ('id', 't', 'session', 'agent', 'epoch', 'n', 'project', 'tool', 'cmd', 'path')}
                           for c in rows]})
    flags = io['calls']
    disp = [c for c in rows if c['agent'] == '' and kinds.get(c['session']) == 'dispatcher' and c['tool'] in ('Bash', 'PowerShell')]
    disp.sort(key=lambda c: (c['session'], c['t']))
    rep = {
        'window': {'since': since, 'until': until, 'days': a.days},
        'audit': {'metrics': week_metrics(db_path, hub, since, until), 'violations': violations(rows), 'calls': len(rows)},
        'gates': gates(disp, flags),
        'effect': {'rules': io['rules'], 'delivery': io['delivery'], 'lessons': io['lessons']},
        'clusters': clusters(rows, flags),
        'retire': io['retire'], 'knowledge': io['knowledge'],
    }
    if a.polygon_result:
        rep['polygon'] = polygon_result(a.polygon_result)
    elif a.polygon and a.apply:
        rep['polygon'] = polygon(data, until)
    entries = {p: v1_entries(hub, p) for p in projects}
    rep['actions'], rep['questions'] = plan(rep, entries, until, hub, data, seen)
    for k in ('retire', 'knowledge'):
        rep.pop(k)

    trend_file = os.path.join(data, 'process-audit', 'trend.jsonl')
    trend = read_jsonl(trend_file)
    earlier = [r for r in trend if r.get('until', '') < until]
    prev = earlier[-1].get('metrics') if earlier else None
    rep['summary'] = summary(rep, prev)

    if a.apply:
        stubs = [x for x in rep['actions'] if x.get('stub')]
        res = hub_io({'op': 'apply', 'hub': hub, 'base_rules': base_rules, 'events_dir': events,
                      'actions': rep['actions'] + rep['questions']}) if events else {'applied': 0, 'failed': [], 'note': 'нет --events'}
        rep['applied'] = res
        for x in stubs:
            x.pop('stub', None)
        if not any(r.get('until') == until for r in trend):  # one row per week: a rerun of the week adds none
            os.makedirs(os.path.dirname(trend_file), exist_ok=True)
            row = {'until': until, 'metrics': {k: v for k, v in rep['audit']['metrics'].items() if not k.startswith('_')}}
            with open(trend_file, 'a', encoding='utf-8') as fh:
                fh.write(json.dumps(row, sort_keys=True) + '\n')
    else:
        for x in rep['actions']:
            x.pop('stub', None)
    if a.out:
        write_atomic(a.out, json.dumps(rep, ensure_ascii=False, indent=1, sort_keys=True) + '\n')
    print(json.dumps(rep, ensure_ascii=False, sort_keys=True) if a.json else rep['summary'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
