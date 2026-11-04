#!/usr/bin/env python3
"""Verdicts of the platform probes (slice 04) as one table + the before/after check of the global settings.

  report.py <data>                 table from <data>/platform/P*.json; exit 1 if a probe is missing or malformed,
                                   or the global settings changed between global-before.json and global-after.json
  report.py snapshot <out.json>    hashes of ~/.claude/settings.json, the plugin install and the plugin cache list
"""
import hashlib
import json
import re
import sys
from pathlib import Path

EXPECTED = ['P1', 'P3', 'P5', 'P7', 'P8', 'P16', 'P17']  # P11 снята по решению пользователя (05.11)
VERDICTS = {'прошла', 'не прошла', 'не решена'}
WATCHED = ['settings.json', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json']


def snapshot(out):
    claude = Path.home() / '.claude'
    snap = {}
    for rel in WATCHED:
        p = claude / rel
        snap[rel] = hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
    cache = claude / 'plugins' / 'cache'
    dirs = sorted(str(p.relative_to(cache)) for p in cache.glob('*/*/*') if p.is_dir()) if cache.exists() else []
    snap['plugins/cache'] = dirs
    Path(out).write_text(json.dumps(snap, indent=2) + '\n')


def numbers_text(n):
    return ', '.join(f'{k}={v}' for k, v in n.items())


def report(data):
    plat = Path(data) / 'platform'
    probes, problems = {}, []
    for f in plat.glob('P*.json'):
        if re.fullmatch(r'P\d+', f.stem):
            try:
                probes[f.stem] = json.loads(f.read_text())
            except ValueError as e:
                problems.append(f'{f.stem}: файл не читается ({e})')
                probes[f.stem] = {}
    problems += [f'нет пробы: {p}' for p in EXPECTED if p not in probes]
    rows = ['| P | вердикт | цифры | критерий |', '|---|---|---|---|']
    for p in sorted(probes, key=lambda s: int(s[1:])):
        d = probes[p]
        verdict, numbers = d.get('verdict'), d.get('numbers') or {}
        if verdict not in VERDICTS:
            problems.append(f'{p}: вердикт «{verdict}» — нужен один из: {", ".join(sorted(VERDICTS))}')
        if not numbers:
            problems.append(f'{p}: нет цифр')
        rows.append(f'| {p} | {verdict} | {numbers_text(numbers)} | {d.get("criterion", "")} |')
    print('\n'.join(rows))
    print()
    before, after = plat / 'global-before.json', plat / 'global-after.json'
    if not before.exists() or not after.exists():
        problems.append(f'нет снимка {before.name if not before.exists() else after.name}')
    else:
        b, a = json.loads(before.read_text()), json.loads(after.read_text())
        changed = [k for k in sorted(set(b) | set(a)) if b.get(k) != a.get(k)]
        if changed:
            problems.append('глобальные настройки ИЗМЕНИЛИСЬ: ' + ', '.join(changed))
        else:
            print('глобальные настройки: без изменений (' + ', '.join(sorted(b)) + ')')
    for line in problems:
        print(line)
    return 1 if problems else 0


def main(argv):
    if argv and argv[0] == 'snapshot':
        snapshot(argv[1])
        return 0
    if len(argv) != 1:
        print(__doc__)
        return 2
    return report(argv[0])


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
