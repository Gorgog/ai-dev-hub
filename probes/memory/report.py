#!/usr/bin/env python3
"""Verdicts of the memory probes (slice 07) as one table.

  report.py <data>    table from <data>/memory/P*.json; exit 1 if a probe is missing or malformed,
                      or P6 has no recorded time (numbers.active_min)
"""
import json
import re
import sys
from pathlib import Path

EXPECTED = ['P2', 'P6', 'P10', 'P13', 'P14', 'P15']
VERDICTS = {'прошла', 'не прошла', 'не решена'}


def numbers_text(n):
    return ', '.join(f'{k}={v}' for k, v in n.items())


def report(data):
    mem = Path(data) / 'memory'
    probes, problems = {}, []
    for f in mem.glob('P*.json'):
        if re.fullmatch(r'P\d+', f.stem):
            try:
                probes[f.stem] = json.loads(f.read_text())
                if not isinstance(probes[f.stem], dict):
                    raise ValueError(f'не объект, а {type(probes[f.stem]).__name__}')
            except ValueError as e:
                problems.append(f'{f.stem}: файл не читается ({e})')
                probes[f.stem] = {}
    problems += [f'нет пробы: {p}' for p in EXPECTED if p not in probes]
    rows = ['| P | вердикт | цифры | критерий | путь |', '|---|---|---|---|---|']
    for p in sorted(probes, key=lambda s: int(s[1:])):
        d = probes[p]
        verdict, numbers = d.get('verdict'), d.get('numbers') or {}
        if verdict not in VERDICTS:
            problems.append(f'{p}: вердикт «{verdict}» — нужен один из: {", ".join(sorted(VERDICTS))}')
        if not numbers:
            problems.append(f'{p}: нет цифр')
        elif p == 'P6' and 'active_min' not in numbers:
            problems.append('P6: не записано время (active_min)')
        rows.append(f'| {p} | {verdict} | {numbers_text(numbers)} | {d.get("criterion", "")} | {d.get("path", "")} |')
    print('\n'.join(rows))
    print()
    for line in problems:
        print(line)
    return 1 if problems else 0


def main(argv):
    if len(argv) != 1:
        print(__doc__)
        return 2
    return report(argv[0])


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
