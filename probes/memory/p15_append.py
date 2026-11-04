#!/usr/bin/env python3
"""P15: 7 processes append event lines (O_APPEND, one write per event) to one jsonl while being killed with -9.
A killed writer is restarted from its last whole event in the file, until each has 2000.
Passed: 0 torn lines (a line that is not one whole JSON event) in 7 × 2000 events.

usage: p15_append.py [--events 2000] [--life-ms 15 45] [--gap-ms 0.5] [--node <node>]"""
import argparse
import json
import random
import signal
import subprocess
import time
from collections import Counter

from common import HERE, NODE, node_version, save, workdir

WRITER = HERE / 'p15_writer.cjs'
W = 7


class Progress:
    """worker → highest seq of a whole event, read incrementally (a full re-read per restart stalls the killing);
    torn lines are skipped."""

    def __init__(self, path):
        self.path, self.pos, self.seqs = path, 0, {}

    def update(self):
        with open(self.path, 'rb') as f:
            f.seek(self.pos)
            chunk = f.read()
        end = chunk.rfind(b'\n') + 1
        self.pos += end
        for raw in chunk[:end].splitlines():
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            self.seqs[e['w']] = max(self.seqs.get(e['w'], -1), e['seq'])
        return self.seqs


def check(path, events):
    whole, torn, sizes_torn = Counter(), [], Counter()
    data = path.read_bytes()
    lines = data.split(b'\n')
    tail = lines.pop()  # after the last newline: must be empty
    for i, raw in enumerate(lines):
        try:
            e = json.loads(raw)
            whole[(e['w'], e['seq'])] += 1
        except (ValueError, KeyError, TypeError):
            torn.append({'line': i, 'bytes': len(raw), 'head': raw[:80].decode('utf-8', 'replace')})
            sizes_torn['>4K' if len(raw) > 4096 else '<=4K'] += 1
    missing = [(w, s) for w in range(W) for s in range(events) if (w, s) not in whole]
    dups = sum(c - 1 for c in whole.values() if c > 1)
    return {'lines': len(lines), 'whole': sum(whole.values()), 'unique': len(whole), 'torn': len(torn),
            'torn_by_size': dict(sizes_torn), 'torn_examples': torn[:5], 'tail_bytes': len(tail),
            'missing': len(missing), 'dups': dups, 'bytes': len(data)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--events', type=int, default=2000)
    ap.add_argument('--life-ms', type=float, nargs=2, default=(15, 45), help='a writer lives this long, then -9')
    ap.add_argument('--gap-ms', type=float, default=0.5, help='pause between events of one writer')
    ap.add_argument('--node', default=NODE)
    a = ap.parse_args()
    root = workdir('P15')
    path = root / 'events.jsonl'
    path.touch()
    rnd = random.Random(15)
    procs, deadline, began, kills, starts, mid = {}, {}, {}, Counter(), Counter(), Counter()
    progress = Progress(path)

    def start(w, frm):
        procs[w] = subprocess.Popen([a.node, str(WRITER), str(path), str(w), str(frm), str(a.events), str(a.gap_ms)])
        began[w] = frm
        deadline[w] = time.time() + rnd.uniform(a.life_ms[0], a.life_ms[1]) / 1000  # killed mid-writing
        starts[w] += 1

    t0 = time.time()
    for w in range(W):
        start(w, 0)
    while procs:
        time.sleep(0.005)
        for w, p in procs.items():
            if p.poll() is None and time.time() >= deadline[w]:
                p.send_signal(signal.SIGKILL)
                p.wait()
                kills[w] += 1
        done = {w: p for w, p in procs.items() if p.poll() is not None}
        if done:
            seqs = progress.update()
            for w, p in done.items():
                frm = seqs.get(w, -1) + 1
                if p.returncode == -signal.SIGKILL and frm > began[w]:
                    mid[w] += 1  # killed after it had written: the kill fell into the stream of writes
                if frm < a.events:
                    start(w, frm)
                else:
                    del procs[w]
    wall = time.time() - t0
    r = check(path, a.events)
    numbers = {'node': node_version(a.node), 'events': f'{r["unique"]}/{W * a.events}', 'torn': r['torn'],
               'kills': sum(kills.values()), 'kills_mid_stream': sum(mid.values()), 'restarts': sum(starts.values()) - W, 'missing': r['missing'],
               'dups': r['dups'], 'mb': round(r['bytes'] / 1e6, 1)}
    passed = r['torn'] == 0 and r['missing'] == 0 and r['tail_bytes'] == 0
    save('P15', 'прошла' if passed else 'не прошла', numbers,
         '0 рваных строк на 7 × 2000 событий',
         'журнал событий — дозапись O_APPEND строкой за один вызов (срезы 08, 12)' if passed else
         'запись через временный файл + rename на процесс, слияние при чтении',
         {**r, 'kills_per_worker': dict(kills), 'wall_s': round(wall, 1), 'work': str(root)},
         method=f'7 процессов node (p15_writer.cjs) дописывают события appendFileSync — один write на событие, '
                f'пауза {a.gap_ms:g} мс между событиями, '
                f'размеры 150–600 Б, каждое 25-е ~6 КБ, каждое 200-е ~70 КБ; каждый процесс живёт '
                f'случайно {a.life_ms[0]:g}–{a.life_ms[1]:g} мс, получает kill -9 и перезапускается с последнего целого события; проверка — каждая строка '
                'файла разбирается как JSON, все 7 × N событий есть')


if __name__ == '__main__':
    main()
