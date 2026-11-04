#!/usr/bin/env python3
"""P2: FTS5 + `unicode61` in `node:sqlite` of the node the hooks run (~/.local/bin/node).
Corpus — every record of the largest errors.md in the hub-data copy (project A, ~700) as lessons/<id>.md.
Passed: query < 5 ms and the whole hook process < 50 ms (p95 of warm runs), no ExperimentalWarning in the hook
output, and after 7 parallel rebuilds (× rounds, with readers running) the index is whole: integrity checks pass,
row count = corpus, the same query gives the same hits.

usage: p02_fts5.py [--memory <errors.md>] [--runs 60] [--rounds 10]"""
import argparse
import json
import random
import re
import subprocess
import time
from pathlib import Path

from common import HERE, NODE, node_version, pct, save, workdir
from v1mem import records

HOOK = HERE / 'p02_index.cjs'
HUB_COPY = Path.home() / 'hub-data' / 'hub' / 'projects'


def biggest_errors_md():
    return max(HUB_COPY.glob('*/memory/errors.md'), key=lambda p: p.stat().st_size)


def write_corpus(mem, src):
    lessons = mem / 'lessons'
    lessons.mkdir(parents=True)
    recs = records(src.read_text(encoding='utf-8', errors='replace'))
    for i, r in enumerate(recs):
        keys = ', '.join(sorted(set(re.findall(r'`([^`]{2,40})`', r['text'])))[:6])
        (lessons / f'L{i:04d}.md').write_text(
            f'---\nid: L{i:04d}\nkind: rule\nkeys: [{keys}]\nstatus: active\nsource: probe\n---\n{r["text"]}\n')
    return recs


def queries(recs, n, seed=7):
    rnd = random.Random(seed)
    words = [w for r in recs for w in re.findall(r'[A-Za-zА-Яа-яЁё][\w-]{3,}', r['text'])]
    return [' '.join(rnd.sample(words, rnd.choice((1, 2, 3)))) for _ in range(n)]


def hook(mem, query, *flags, node=NODE):
    t0 = time.perf_counter()
    p = subprocess.run([node, str(HOOK), str(mem), *flags], input=json.dumps({'query': query}),
                       capture_output=True, text=True)
    wall = (time.perf_counter() - t0) * 1000
    out = json.loads(p.stdout) if p.returncode == 0 and p.stdout.startswith('{') else {}
    return {'code': p.returncode, 'wall_ms': wall, 'stderr': p.stderr, 'stdout': p.stdout,
            'probe': out.get('_probe', {})}


def integrity(mem, n):
    """sqlite integrity, FTS5 integrity-check and the row count — via the same node."""
    js = ("const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);"
          "const r={ic:d.prepare('PRAGMA integrity_check').get().integrity_check,"
          "rows:d.prepare('SELECT count(*) c FROM lessons').get().c};"
          "try{d.exec(\"INSERT INTO lessons(lessons) VALUES('integrity-check')\");r.fts='ok'}catch(e){r.fts=e.message}"
          "console.log(JSON.stringify(r))")
    p = subprocess.run([NODE, '-e', js, str(mem / '.index.db')], capture_output=True, text=True)
    r = json.loads(p.stdout) if p.returncode == 0 else {'error': p.stderr[-300:]}
    r['ok'] = r.get('ic') == 'ok' and r.get('fts') == 'ok' and r.get('rows') == n
    return r


def parallel_rebuilds(mem, n, rounds, probe_q, expect):
    res = []
    for k in range(rounds):
        procs = [subprocess.Popen([NODE, str(HOOK), str(mem), '--rebuild'], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(7)]
        for p in procs:
            p.stdin.write(json.dumps({'query': probe_q}))
            p.stdin.close()
        readers = [hook(mem, probe_q) for _ in range(5)]  # read while the 7 rebuild
        outs = [(p.wait(), p.stdout.read(), p.stderr.read()) for p in procs]
        ok_writers = sum(1 for code, out, err in outs if code == 0 and not err)
        ok_readers = sum(1 for r in readers if r['code'] == 0 and r['probe'].get('hits') == expect)
        check = integrity(mem, n)
        same = hook(mem, probe_q)['probe'].get('hits') == expect
        leftovers = sorted(p.name for p in mem.glob('.index.db.tmp-*'))
        res.append({'round': k, 'writers_ok': ok_writers, 'readers_ok': ok_readers, 'integrity': check,
                    'same_hits': same, 'tmp_left': leftovers,
                    'errors': [err[-300:] for code, out, err in outs if code or err]})
    return res


def warning_check(mem, node):
    r = hook(mem, 'heredoc', node=node)
    return {'node': node_version(node), 'warning': 'ExperimentalWarning' in r['stderr'] + r['stdout'],
            'stderr': r['stderr'][:200], 'wall_ms': round(r['wall_ms'], 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--memory', type=Path, default=None)
    ap.add_argument('--runs', type=int, default=60)
    ap.add_argument('--rounds', type=int, default=10)
    a = ap.parse_args()
    src = a.memory or biggest_errors_md()
    root = workdir('P2')
    mem = root / 'memory'
    recs = write_corpus(mem, src)
    n = len(recs)
    qs = queries(recs, a.runs)

    cold = hook(mem, qs[0])
    warm = [hook(mem, q) for q in qs]
    lesson = sorted((mem / 'lessons').glob('*.md'))[n // 2]
    stale = []
    for i in range(10):  # a lesson changed → the next search rebuilds
        lesson.write_text(lesson.read_text() + f'edit {i}\n')
        stale.append(hook(mem, qs[i]))
    expect = hook(mem, 'heredoc node кавычки')['probe'].get('hits')
    par = parallel_rebuilds(mem, n, a.rounds, 'heredoc node кавычки', expect)

    all_runs = [cold, *warm, *stale]
    warnings = [r for r in all_runs if 'ExperimentalWarning' in r['stderr'] + r['stdout']]
    stderr_any = [r['stderr'][:200] for r in all_runs if r['stderr']]
    bad = [r for r in all_runs if r['code'] != 0]
    q95 = pct([r['probe']['query_ms'] for r in warm], 95)
    w95 = pct([r['wall_ms'] for r in warm], 95)
    rebuilt_warm = sum(1 for r in warm if r['probe'].get('rebuilt'))
    par_ok = sum(1 for x in par if x['writers_ok'] == 7 and x['readers_ok'] == 5 and x['integrity']['ok']
                 and x['same_hits'] and not x['tmp_left'])
    other = [warning_check(mem, str(p)) for p in sorted(Path.home().glob('.nvm/versions/node/v*/bin/node'))]

    numbers = {
        'node': node_version(), 'lessons': n, 'query_p95_ms': round(q95, 2), 'hook_p95_ms': round(w95, 1),
        'hook_max_ms': round(max(r['wall_ms'] for r in warm), 1),
        'rebuild_hook_p95_ms': round(pct([r['wall_ms'] for r in stale], 95), 1),
        'cold_build_ms': round(cold['wall_ms'], 1), 'warnings': len(warnings),
        'parallel_rounds_ok': f'{par_ok}/{len(par)}', 'hits_expected': len(expect or []),
    }
    passed = (q95 < 5 and w95 < 50 and not warnings and not stderr_any and not bad and par_ok == len(par)
              and rebuilt_warm == 0 and all(r['probe'].get('rebuilt') for r in stale) and expect)
    save('P2', 'прошла' if passed else 'не прошла', numbers,
         'запрос < 5 мс, хук целиком < 50 мс, без ExperimentalWarning в выводе хука, 7 параллельных пересборок — '
         'индекс цел',
         'индекс памяти (срез 14) — FTS5 в node:sqlite, пересборка во временный файл + rename' if passed else
         'BM25 на JS по .triggers.json для recall; горячий путь не меняется',
         {'corpus': f'{n} записей errors.md проекта A (копия hub-data)', 'warm_rebuilt': rebuilt_warm,
          'stale_rebuilt': sum(1 for r in stale if r['probe'].get('rebuilt')), 'stderr': stderr_any[:3],
          'failed_runs': [r['stderr'][-300:] for r in bad[:3]], 'parallel': par, 'other_nodes': other,
          'warm_breakdown_p95_ms': {k: round(pct([r['probe'][k] for r in warm], 95), 2)
                                    for k in ('startup_ms', 'check_ms', 'query_ms', 'total_ms')},
          'work': str(root)},
        method=f'хук-заглушка p02_index.cjs на {NODE}: подпись уроков (число, mtime, размер) → пересборка FTS5 '
               f'во временный файл + rename → BM25-запрос; {a.runs} тёплых вызовов процесса со случайными '
               f'запросами по словам корпуса, 10 вызовов после правки урока, {a.rounds} раундов по 7 параллельных '
               'пересборок и 5 читателей; целостность — PRAGMA integrity_check, FTS5 integrity-check, число строк')


if __name__ == '__main__':
    main()
