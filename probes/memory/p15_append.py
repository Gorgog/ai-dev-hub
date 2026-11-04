#!/usr/bin/env python3
"""P15: 7 processes append event lines (O_APPEND, one write per event) to one jsonl while being killed with -9.
A killed writer is restarted from its last whole event in the file, until each has N. Three arms, on the disk the
memory lives on (ext4 under ~/hub-data, not tmpfs /tmp):
  one    the mechanism: the event in one write — the criterion is on this arm;
  split  the control: the event in two writes with a pause between — a kill there must tear a line, or the probe
         could not fail at all (then «не решена»);
  large  aimed: every event ~256 KB in one write, so many kills land inside a many-page write (the only place the
         kernel may cut a write short) — reported apart, it is not the criterion.
Passed: 0 torn lines in 7 × 2000 events of `one`, and the control tore.

usage: p15_append.py [--events 2000] [--large-events 300] [--life-ms 15 45] [--gap-ms 0.5] [--dir D] [--node N]"""
import argparse
import json
import random
import signal
import subprocess
import time
from collections import Counter
from pathlib import Path

from common import DATA, HERE, NODE, node_version, save

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


def run_arm(path, mode, events, gap_ms, a, rnd):
    """Writers of one arm until each has `events`; kills at random lifetimes. → check() + kill counts."""
    path.unlink(missing_ok=True)
    path.touch()
    procs, deadline, began, kills, starts, mid = {}, {}, {}, Counter(), Counter(), Counter()
    progress = Progress(path)

    def start(w, frm):
        procs[w] = subprocess.Popen([a.node, str(WRITER), str(path), str(w), str(frm), str(events), str(gap_ms),
                                     mode])
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
                if frm < events:
                    start(w, frm)
                else:
                    del procs[w]
    r = check(path, events)
    path.unlink()  # up to ~100 MB of synthetic events: the numbers are what stays
    return {**r, 'kills': sum(kills.values()), 'kills_mid_stream': sum(mid.values()),
            'restarts': sum(starts.values()) - W, 'wall_s': round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--events', type=int, default=2000)
    ap.add_argument('--large-events', type=int, default=300, help='no pause: a kill mid-stream is inside a write')
    ap.add_argument('--life-ms', type=float, nargs=2, default=(15, 45), help='a writer lives this long, then -9')
    ap.add_argument('--gap-ms', type=float, default=0.5, help='pause between events (and halves, in split)')
    ap.add_argument('--dir', type=Path, default=DATA / 'p15-work', help='a dir on the disk the memory lives on')
    ap.add_argument('--node', default=NODE)
    a = ap.parse_args()
    a.dir.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(15)
    arms = {mode: run_arm(a.dir / f'{mode}.jsonl', mode, a.large_events if mode == 'large' else a.events,
                          0 if mode == 'large' else a.gap_ms, a, rnd)
            for mode in ('one', 'split', 'large')}
    a.dir.rmdir()
    one, ctl, big = arms['one'], arms['split'], arms['large']
    numbers = {'node': node_version(a.node), 'events': f'{one["unique"]}/{W * a.events}', 'torn': one['torn'],
               'kills': one['kills'], 'kills_mid_stream': one['kills_mid_stream'], 'missing': one['missing'],
               'dups': one['dups'], 'control_torn': ctl['torn'], 'control_kills': ctl['kills'],
               'large_torn': big['torn'], 'large_events': f'{big["unique"]}/{W * a.large_events}',
               'large_kills_mid_stream': big['kills_mid_stream']}
    whole = one['torn'] == 0 and one['missing'] == 0 and one['tail_bytes'] == 0
    verdict = 'не решена' if ctl['torn'] == 0 else 'прошла' if whole else 'не прошла'
    save('P15', verdict, numbers,
         '0 рваных строк на 7 × 2000 событий',
         ('журнал событий — дозапись O_APPEND строкой за один вызов (срезы 08, 12)' +
          ('' if big['torn'] == 0 else '; событие — небольшое: строки ~256 КБ рвались при kill -9')) if verdict == 'прошла'
         else 'запись через временный файл + rename на процесс, слияние при чтении',
         {'arms': arms, 'dir': str(a.dir), 'fs': 'ext4 (~/hub-data)'},
         method=f'7 процессов node (p15_writer.cjs) дописывают события appendFileSync, пауза {a.gap_ms:g} мс между '
                f'событиями; каждый процесс живёт случайно {a.life_ms[0]:g}–{a.life_ms[1]:g} мс, получает kill -9 и '
                'перезапускается с последнего целого события; плечи: one — событие одним write (размеры 150–600 Б, '
                'каждое 25-е ~6 КБ, каждое 200-е ~70 КБ; критерий), split — контроль: событие двумя write с паузой '
                'между половинами, large — прицельно: каждое событие ~256 КБ одним write без пауз (убийство посреди потока — внутри write); проверка — каждая строка '
                'файла разбирается как JSON, все 7 × N событий есть; файлы на ext4, не tmpfs')


if __name__ == '__main__':
    main()
