#!/usr/bin/env python3
"""P14: `flock` + git commit of the memory from a Stop hook — how long, and what happens when the lock is busy.
A memory git with 250 lessons and some history; before each Stop 1–3 lessons change and an event line is appended.
Passed: p95 of the whole hook process < 300 ms on 250 lessons; with the lock held by another process every Stop
skips without waiting (no commit, well under the normal time).

usage: p14_flock_git.py [--lessons 250] [--runs 40] [--history 200]"""
import argparse
import json
import os
import random
import signal
import subprocess
import time

from common import HERE, NODE, pct, save, workdir

HOOK = HERE / 'p14_stop.cjs'


def git(mem, *a):
    return subprocess.run(['git', '-C', str(mem), *a], check=True, capture_output=True, text=True).stdout.strip()


def make_memory(mem, n, history, rnd):
    (mem / 'lessons').mkdir(parents=True)
    (mem / 'events').mkdir()
    git(mem, 'init', '-q', '-b', 'main')
    for k, v in (('user.email', 'probe@example.test'), ('user.name', 'probe'), ('commit.gpgsign', 'false')):
        git(mem, 'config', k, v)
    for i in range(n):
        (mem / 'lessons' / f'L{i:04d}.md').write_text(
            f'---\nid: L{i:04d}\nkind: rule\nwhen: [PreToolUse:Bash]\nkeys: [k{i % 40}]\nstatus: active\n'
            f'source: probe\ncreated: 2026-11-05\n---\nУрок {i}: синтетический текст правила для пробы. ' * 3 + '\n')
    git(mem, 'add', '-A')
    git(mem, 'commit', '-q', '-m', 'init')
    for h in range(history):
        touch(mem, rnd, h)
        git(mem, 'add', '-A')
        git(mem, 'commit', '-q', '-m', f'history {h}')


def touch(mem, rnd, k):
    for p in rnd.sample(sorted((mem / 'lessons').glob('*.md')), rnd.choice((1, 2, 3))):
        p.write_text(p.read_text() + f'правка {k}\n')
    with (mem / 'events' / '2026-11.jsonl').open('a') as f:
        f.write(json.dumps({'kind': 'shown', 'k': k}) + '\n')


def stop(mem, session):
    t0 = time.perf_counter()
    p = subprocess.run([NODE, str(HOOK), str(mem)], input=json.dumps({'session_id': session}), capture_output=True,
                       text=True)
    out = json.loads(p.stdout)['_probe'] if p.stdout.startswith('{') else {'result': 'crash', 'stderr': p.stderr}
    return {**out, 'wall_ms': (time.perf_counter() - t0) * 1000}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lessons', type=int, default=250)
    ap.add_argument('--runs', type=int, default=40)
    ap.add_argument('--history', type=int, default=200)
    a = ap.parse_args()
    rnd = random.Random(14)
    root = workdir('P14')
    mem = root / 'memory'
    make_memory(mem, a.lessons, a.history, rnd)

    commits = []
    for k in range(a.runs):
        touch(mem, rnd, 1000 + k)
        commits.append(stop(mem, f's{k}'))
    nothing = [stop(mem, f'idle{k}') for k in range(10)]
    clean = git(mem, 'status', '--porcelain') == ''
    count_before = int(git(mem, 'rev-list', '--count', 'HEAD'))

    # its own process group: flock forks `sleep`, and the child keeps the lock if only flock dies
    holder = subprocess.Popen(['flock', str(mem / '.git' / 'hub-memory.lock'), 'sleep', '30'],
                              start_new_session=True)
    time.sleep(0.3)
    busy = []
    for k in range(10):
        touch(mem, rnd, 2000 + k)
        busy.append(stop(mem, f'busy{k}'))
    os.killpg(holder.pid, signal.SIGKILL)
    holder.wait()
    count_busy = int(git(mem, 'rev-list', '--count', 'HEAD'))
    after = stop(mem, 'after')  # the lock is free again: the skipped changes go in now

    ok_commits = sum(1 for r in commits if r['result'] == 'committed')
    p95 = pct([r['wall_ms'] for r in commits], 95)
    busy_skips = sum(1 for r in busy if r['result'] == 'busy')
    busy_max = max(r['wall_ms'] for r in busy)
    numbers = {'lessons': a.lessons, 'history': a.history + 1, 'commit_p95_ms': round(p95, 1),
               'commit_max_ms': round(max(r['wall_ms'] for r in commits), 1),
               'commit_p50_ms': round(pct([r['wall_ms'] for r in commits], 50), 1),
               'nothing_p95_ms': round(pct([r['wall_ms'] for r in nothing], 95), 1),
               'commits': f'{ok_commits}/{a.runs}', 'busy_skipped': f'{busy_skips}/10',
               'busy_max_ms': round(busy_max, 1), 'busy_new_commits': count_busy - count_before,
               'after_busy': after['result']}
    passed = (p95 < 300 and ok_commits == a.runs and busy_skips == 10 and count_busy == count_before
              and busy_max < p95 and all(r['result'] == 'nothing' for r in nothing) and clean
              and after['result'] == 'committed')
    save('P14', 'прошла' if passed else 'не прошла', numbers,
         'p95 < 300 мс на 250 уроках; занято → пропуск без ожидания',
         'коммит памяти — Stop-хук под flock -n (срез 21)' if passed else
         'коммит памяти — на SessionStart следующей сессии',
         {'errors': [r for r in commits + nothing + busy if r['result'] in ('error', 'crash')][:3],
          'work': str(root)},
         method=f'git памяти с {a.lessons} уроками и {a.history} коммитами истории; хук-заглушка p14_stop.cjs на '
                'node: flock -n -E 75 → git add -A lessons events → commit, если индекс изменился; перед каждым из '
                f'{a.runs} Stop правятся 1–3 урока и дописывается событие; время — весь процесс хука; занятый замок '
                '— flock … sleep в соседнем процессе, 10 Stop')


if __name__ == '__main__':
    main()
