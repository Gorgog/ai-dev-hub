#!/usr/bin/env python3
"""P6: v1 errors.md records → v2 lessons by a mapping file (the agent writes the mapping once, this script applies it
deterministically: same input — same bytes).

  p06_migrate.py <errors.md> <mapping.json> <out-dir>

mapping.json: {"theme": "<regex: records that must get an address>",
  "lessons": [{"id", "kind", "when": [], "keys": [], "created", "supersedes"?: [], "from": [sha | {sha, part}, ...],
               "text": ["2–5 lines, the first ≤ 160 chars"]}],
  "archive": [{"sha", "reason", "part"?}]}
sha — v1mem.records()[...]['sha']: 12 hex of the record text. A lesson from several records — a merge. A record that
holds two rules is split: each of its claims names its own `part`, and only then may the sha be claimed again; a lone
part is an error (the record's other rule went nowhere).
Output: <out>/lessons/<id>.md (v2 frontmatter) and <out>/addresses.json (sha → [where it went]). Exit 1 and nothing
written on: an unknown or twice-mapped sha, a theme record without an address (orphan), a lesson out of the limits.
"""
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from v1mem import records  # noqa: E402

SOURCE = 'модель (миграция)'
FIELDS = ('id', 'kind', 'when', 'keys', 'created', 'from', 'text')


def flow(items):
    return '[' + ', '.join(items) + ']'


def lesson_md(l):
    head = [f'id: {l["id"]}', f'kind: {l["kind"]}', f'when: {flow(l["when"])}', f'keys: {flow(l["keys"])}',
            'status: active', f'supersedes: {flow(l.get("supersedes", []))}', f'source: {SOURCE}',
            f'created: {l["created"]}']
    return '---\n' + '\n'.join(head) + '\n---\n' + '\n'.join(l['text']) + '\n'


def plan(errors_text, mp):
    recs = records(errors_text)
    by_sha = {r['sha']: r for r in recs}
    problems, addr, parts = [], {}, {}

    def claim(sha, part):
        """A sha may be claimed again only when every claim of it names its part."""
        if sha not in by_sha:
            problems.append(f'нет в источнике: {sha}')
            return False
        if sha in parts and (part is None or None in parts[sha]):
            problems.append(f'дважды: {sha}')
            return False
        if part is not None and part in parts.get(sha, []):
            problems.append(f'дважды: {sha} (часть «{part}»)')
            return False
        parts.setdefault(sha, []).append(part)
        return True

    def put(sha, part, **where):
        a = {'line': by_sha[sha]['line'], **where}
        if part is not None:
            a['part'] = part
        addr.setdefault(sha, []).append(a)

    for l in mp.get('lessons', []):
        lid = l.get('id', '?')
        missing = [f for f in FIELDS if f not in l]
        if missing:
            problems.append(f'{lid}: нет полей {", ".join(missing)}')
            continue
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', lid):
            problems.append(f'{lid}: id — латиница, цифры и дефис')
        if not 2 <= len(l['text']) <= 5:
            problems.append(f'{lid}: строк {len(l["text"])}, нужно 2–5')
        if not l['from']:
            problems.append(f'{lid}: урок ни из чего (from пуст)')
        if l['text'] and len(l['text'][0]) > 160:
            problems.append(f'{lid}: первая строка {len(l["text"][0])} знаков > 160')
        for f in l['from']:
            sha, part = (f['sha'], f.get('part')) if isinstance(f, dict) else (f, None)
            if claim(sha, part):
                put(sha, part, to='lesson', id=lid, merged=len(l['from']))
    ids = [l.get('id') for l in mp.get('lessons', [])]
    problems += [f'id дважды: {i}' for i in sorted({i for i in ids if ids.count(i) > 1})]
    for a in mp.get('archive', []):
        if not a.get('reason'):
            problems.append(f'архив без причины: {a.get("sha")}')
        if claim(a.get('sha'), a.get('part')):
            put(a['sha'], a.get('part'), to='archive', reason=a.get('reason'))
    # A part implies a split: a record with a single named part lost its other rule somewhere.
    problems += [f'одна часть: {sha} — разбитой записи нужны все её части'
                 for sha, ps in sorted(parts.items()) if len(ps) == 1 and ps[0] is not None]
    theme = re.compile(mp['theme'], re.I)
    in_theme = [r for r in recs if theme.search(r['text'])]
    orphans = [r for r in in_theme if r['sha'] not in addr]
    problems += [f'сирота: строка {r["line"]} {r["sha"]}' for r in orphans]
    return addr, problems, len(in_theme) - len(orphans), len(in_theme)


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    errors, mapping, out = Path(argv[0]), Path(argv[1]), Path(argv[2])
    mp = json.loads(mapping.read_text(encoding='utf-8'))
    addr, problems, got, total = plan(errors.read_text(encoding='utf-8'), mp)
    print(f'тема: {got}/{total} записей получили адрес; уроков {len(mp.get("lessons", []))}, '
          f'в архив {len(mp.get("archive", []))}; разбито записей: {sum(1 for a in addr.values() if len(a) > 1)}')
    for p in problems:
        print(p)
    if problems:
        return 1
    if out.exists():
        shutil.rmtree(out)
    (out / 'lessons').mkdir(parents=True)
    for l in sorted(mp['lessons'], key=lambda x: x['id']):
        (out / 'lessons' / f'{l["id"]}.md').write_text(lesson_md(l), encoding='utf-8')
    (out / 'addresses.json').write_text(json.dumps(dict(sorted(addr.items())), ensure_ascii=False, indent=1) + '\n',
                                        encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
