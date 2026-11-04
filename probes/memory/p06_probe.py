#!/usr/bin/env python3
"""P6: migration of one theme (heredoc / `node -e`) by the mapping file — how long and how many manual edits.
Runs p06_migrate.py twice on the hub-data copy into two dirs and compares them byte for byte.
Passed: 100 % of the theme's records got an address (lesson / merge / archive), the two runs are byte-identical,
the time is recorded.

usage: p06_probe.py --started <epoch s> --mapping-edits N --schema-edits N [--errors <errors.md>] [--mapping <json>]
  --started        when the work on the theme began (selection of records); the time is up to this run
  --mapping-edits  edits of the mapping after its first draft (manual fixes after the script's complaints)
  --schema-edits   changes of the mapping schema the theme forced (each — a commit of p06_migrate.py)"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from common import DATA, HERE, biggest_errors_md, save


def tree_hash(d):
    h = hashlib.sha256()
    for p in sorted(Path(d).rglob('*')):
        if p.is_file():
            h.update(str(p.relative_to(d)).encode() + b'\0' + p.read_bytes())
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--started', type=float, required=True)
    ap.add_argument('--mapping-edits', type=int, required=True)
    ap.add_argument('--schema-edits', type=int, required=True)
    ap.add_argument('--errors', type=Path, default=None, help='default: project A — the largest errors.md')
    ap.add_argument('--mapping', type=Path, default=DATA / 'p6' / 'mapping.json')
    a = ap.parse_args()
    a.errors = a.errors or biggest_errors_md()
    out = a.mapping.parent
    runs = []
    for name in ('out-a', 'out-b'):
        t0 = time.perf_counter()
        p = subprocess.run([sys.executable, '-I', str(HERE / 'p06_migrate.py'), str(a.errors), str(a.mapping),
                            str(out / name)], capture_output=True, text=True)
        runs.append({'code': p.returncode, 'stdout': p.stdout.strip(), 'ms': round((time.perf_counter() - t0) * 1000)})
    same = all(r['code'] == 0 for r in runs) and tree_hash(out / 'out-a') == tree_hash(out / 'out-b')
    first = runs[0]['stdout'].splitlines()[0] if runs[0]['stdout'] else ''
    got, total = first.split(': ', 1)[1].split(' ', 1)[0].split('/') if first.startswith('тема:') else ('0', '?')
    addr = json.loads((out / 'out-a' / 'addresses.json').read_text()) if runs[0]['code'] == 0 else {}
    kinds = {}
    for places in addr.values():
        for x in places:
            kinds[x['to']] = kinds.get(x['to'], 0) + 1
    minutes = round((time.time() - a.started) / 60)
    numbers = {'theme': f'{got}/{total}', 'byte_identical': same, 'active_min': minutes,
               'mapping_edits': a.mapping_edits, 'schema_edits': a.schema_edits,
               'lessons': len(list((out / 'out-a' / 'lessons').glob('*.md'))) if runs[0]['code'] == 0 else 0,
               'to_lesson': kinds.get('lesson', 0), 'to_archive': kinds.get('archive', 0),
               'split_records': sum(1 for v in addr.values() if len(v) > 1), 'script_ms': runs[0]['ms']}
    passed = same and got == total and total != '0'
    save('P6', 'прошла' if passed else 'не прошла', numbers,
         '100 % записей темы получили адрес (урок/слияние/архив), два прогона побайтно равны; время записано',
         ('смета 23 по факту темы; схема файла соответствия — с разбиением записи на части (part)' if passed else
          'схема файла соответствия пересматривается до 13 (новый 23); смета 13 → L'),
         {'runs': runs, 'out': str(out), 'errors': str(a.errors), 'mapping': str(a.mapping),
          'time_note': 'минуты — по часам от отбора записей темы до этого прогона, включая чтение записей, схему '
                       '(красный тест + разбиение) и файл соответствия; фоновые прогоны других проб шли параллельно'},
         method='агент (эта сессия) читает записи темы и пишет файл соответствия запись → урок/слияние/архив с '
                'причиной; детерминированный p06_migrate.py собирает уроки v2 (frontmatter + 2–5 строк) и '
                'addresses.json; два прогона в разные папки, сравнение sha256 дерева')


if __name__ == '__main__':
    main()
