#!/usr/bin/env python3
"""Memory v1 → v2: errors, decisions and recipes of every project of a snapshot become lessons and decisions of the
v2 format (slice 14) by a map the agent writes once; this script only applies it, deterministically.

    migrate.py --snapshot <dir with projects/> --map <map.json> --out <dir> [--check-twice]
    migrate.py --snapshot <dir with projects/> --list [--project <name>]

Sources: projects/<p>/memory/{errors.md, errors-index.md, recipes.md, decisions.md}, cut into records by records.py;
a record's ref is `<file>#<sha12>`. The map (schema — README.md, sample — example/map.json):
  {"version": 1, "projects": {"<p>": {"lessons": [...], "decisions": [...], "archive": [...]}}}
  lesson:   {id, kind: rule|once|knowledge, status?: active|core, created, when: [{tool|cmd|path|body|out: regex}],
             keys: [...], supersedes?: [...], from: [ref | {ref, part}], text: ["2–5 lines, the first ≤ 160"]}
  decision: {id, created, keys, supersedes?, from, text}  — kind decision, when [], in memory/decisions/
  archive:  {ref, part?, reason}
Every record of every source gets an address: a lesson or decision `from` it (several records — a merge), or the
archive with a reason. A record holding two rules is split: each claim names its `part`, a lone part is an error.
Output: <out>/projects/<p>/memory/{lessons,decisions}/<id>.md (source «модель (миграция)», written and checked by the
memory library through render.cjs), <out>/addresses.json (record → where it went), <out>/anchor.json (source hashes,
counts, orphans). On any problem — exit 1, the problems listed, nothing written and an earlier --out untouched.
--out is replaced whole, so it must be empty, absent or an earlier run, and must not hold or sit in the inputs.
--check-twice: the whole run twice from the inputs, the two trees compared byte by byte, one kept.
--list: every record as a JSON line {project, ref, file, line, unit, head, text} — what the map is written from.
Codes: 0 done, 1 refused, 2 usage. Stdlib only; node (HUB_NODE, else ~/.local/bin/node, else node) for render.cjs.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from records import records  # noqa: E402

HERE = Path(__file__).resolve().parent
SOURCES = ('errors.md', 'errors-index.md', 'recipes.md', 'decisions.md')
SOURCE = 'модель (миграция)'
LESSON_FIELDS = ('id', 'kind', 'created', 'when', 'keys', 'from', 'text')
DECISION_FIELDS = ('id', 'created', 'keys', 'from', 'text')
LESSON_KINDS = ('rule', 'once', 'knowledge')
LESSON_STATUSES = ('active', 'core')


def node():
    if os.environ.get('HUB_NODE'):
        return os.environ['HUB_NODE']
    local = Path.home() / '.local' / 'bin' / 'node'
    return str(local) if local.exists() else 'node'


def snapshot(snap):
    """{project: {'sources': {file: sha256}, 'records': [...]}} for every projects/<p>/memory of the snapshot."""
    out = {}
    root = Path(snap) / 'projects'
    for p in sorted(x.name for x in root.iterdir() if (x / 'memory').is_dir()):
        srcs, recs = {}, []
        for name in SOURCES:
            f = root / p / 'memory' / name
            if not f.is_file():
                continue
            raw = f.read_bytes()
            srcs[name] = hashlib.sha256(raw).hexdigest()
            recs += records(raw.decode('utf-8'), name)
        out[p] = {'sources': srcs, 'records': recs}
    return out


def plan(snap, mp):
    """→ (docs to render, addresses, counts, problems)"""
    problems, docs, addr = [], [], {}
    merged = 0
    if mp.get('version') != 1 or not isinstance(mp.get('projects'), dict):
        return [], {}, {}, ['файл соответствия: нужен {"version": 1, "projects": {...}}']
    problems += [f'проекта нет в снимке: {p}' for p in sorted(set(mp['projects']) - set(snap))]
    for p, s in snap.items():
        pm = mp['projects'].get(p, {})
        by_ref = {r['ref']: r for r in s['records']}
        parts = {}

        def claim(ref, part, where):
            key = f'{p}/{ref}'
            if ref not in by_ref:
                problems.append(f'нет в снимке: {key}')
                return
            if ref in parts and (part is None or None in parts[ref]):
                problems.append(f'дважды: {key}')
                return
            if part is not None and part in parts.get(ref, []):
                problems.append(f'дважды: {key} (часть «{part}»)')
                return
            parts.setdefault(ref, []).append(part)
            a = {'line': by_ref[ref]['line'], 'unit': by_ref[ref]['unit'], **where}
            if part is not None:
                a['part'] = part
            addr.setdefault(key, []).append(a)

        def froms(doc):
            for f in doc['from']:
                ref, part = (f.get('ref'), f.get('part')) if isinstance(f, dict) else (f, None)
                yield ref, part

        ids = []
        for kind, items, fields in (('lesson', pm.get('lessons', []), LESSON_FIELDS),
                                    ('decision', pm.get('decisions', []), DECISION_FIELDS)):
            for d in items:
                lid = d.get('id', '?')
                ids.append(lid)
                missing = [f for f in fields if f not in d]
                if missing:
                    problems.append(f'{lid}: нет полей {", ".join(missing)}')
                    continue
                bad = shape(d, kind)
                if bad:
                    problems += [f'{lid}: {b}' for b in bad]
                    continue
                if not d['from']:
                    problems.append(f'{lid}: урок ни из чего (from пуст)')
                merged += len(d['from']) > 1
                for ref, part in froms(d):
                    claim(ref, part, {'to': kind, 'id': lid, 'merged': len(d['from'])})
                meta = {'id': lid, 'kind': d['kind'] if kind == 'lesson' else 'decision',
                        'when': d['when'] if kind == 'lesson' else [], 'keys': d['keys'],
                        'status': d.get('status', 'active'), 'supersedes': d.get('supersedes', []),
                        'source': SOURCE, 'created': d['created']}
                sub = 'lessons' if kind == 'lesson' else 'decisions'
                docs.append({'file': f'projects/{p}/memory/{sub}/{lid}.md', 'meta': meta, 'body': d['text']})
        problems += [f'id дважды: {p}/{i}' for i in sorted({i for i in ids if ids.count(i) > 1})]
        for a in pm.get('archive', []):
            if not a.get('reason'):
                problems.append(f'архив без причины: {p}/{a.get("ref")}')
            claim(a.get('ref'), a.get('part'), {'to': 'archive', 'reason': a.get('reason')})
        problems += [f'одна часть: {p}/{ref} — разбитой записи нужны все её части'
                     for ref, ps in sorted(parts.items()) if len(ps) == 1 and ps[0] is not None]
        problems += [f'сирота: {p}/{r["ref"]} (строка {r["line"]})' for r in s['records'] if r['ref'] not in parts]
    every = [r for s in snap.values() for r in s['records']]
    flat = [a for v in addr.values() for a in v]
    counts = {
        'records': len(every), 'addressed': len(addr), 'orphans': len(every) - len(addr),
        'to_lesson': sum(1 for a in flat if a['to'] == 'lesson'),
        'to_decision': sum(1 for a in flat if a['to'] == 'decision'),
        'to_archive': sum(1 for a in flat if a['to'] == 'archive'),
        'lessons': sum(1 for d in docs if '/lessons/' in d['file']),
        'decisions': sum(1 for d in docs if '/decisions/' in d['file']),
        'split': sum(1 for v in addr.values() if len(v) > 1),
        'merged': merged,
    }
    return docs, addr, counts, problems


def shape(d, kind):
    """Types of a map entry the validator cannot see (it reads the written file, not the map)."""
    bad = []
    if kind == 'lesson':
        if d['kind'] not in LESSON_KINDS:
            bad.append(f'kind «{d["kind"]}»: урок — {", ".join(LESSON_KINDS)} (решения — в decisions)')
        if d.get('status', 'active') not in LESSON_STATUSES:
            bad.append(f'status «{d.get("status")}»: миграция пишет active или core (архив — в archive с причиной)')
        if not isinstance(d['when'], list):
            bad.append('when: нужен список')
    for f in ('keys', 'text', 'from') + (('supersedes',) if 'supersedes' in d else ()):
        if not isinstance(d[f], list):
            bad.append(f'{f}: нужен список')
    if isinstance(d['text'], list) and not all(isinstance(t, str) and '\n' not in t for t in d['text']):
        bad.append('text: строки без переводов строки')
    if not isinstance(d['created'], str):
        bad.append('created: нужна строка ГГГГ-ММ-ДД')
    return bad


def render(docs):
    r = subprocess.run([node(), str(HERE / 'render.cjs')], input=json.dumps(docs, ensure_ascii=False),
                       capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        raise SystemExit(f'render.cjs: код {r.returncode}\n{r.stderr}')
    return json.loads(r.stdout)


def build(snap_dir, map_file):
    """The whole run from the inputs → ({relpath: bytes}, counts, problems)."""
    snap = snapshot(snap_dir)
    raw_map = Path(map_file).read_bytes()
    docs, addr, counts, problems = plan(snap, json.loads(raw_map.decode('utf-8')))
    files = {}
    if docs:
        for r in render(docs):
            problems += r['problems']
            files[r['file']] = r['text'].encode('utf-8')
    anchor = {'version': 1, 'map_sha256': hashlib.sha256(raw_map).hexdigest(),
              'sources': {f'{p}/{n}': {'sha256': h, 'records': sum(1 for r in s['records'] if r['file'] == n)}
                          for p, s in snap.items() for n, h in s['sources'].items()},
              **counts}
    dump = lambda x: (json.dumps(x, ensure_ascii=False, indent=1, sort_keys=True) + '\n').encode('utf-8')
    files['addresses.json'] = dump(addr)
    files['anchor.json'] = dump(anchor)
    return files, counts, problems


def tree_sha(files):
    h = hashlib.sha256()
    for k in sorted(files):
        h.update(k.encode() + b'\0' + hashlib.sha256(files[k]).digest())
    return h.hexdigest()


RUN_ENTRIES = {'addresses.json', 'anchor.json', 'projects'}


def out_problem(out, snap, map_file):
    """Why --out may not be replaced, or None. The whole folder is swapped, so it must be an earlier run (only what a
    run writes, anchor.json among it) or empty, and must neither hold the inputs nor lie inside the snapshot."""
    o, s, m = (Path(x).resolve() for x in (out, snap, map_file))
    if o == s or o in s.parents or o in m.parents or s in o.parents:
        return f'--out {out}: совпадает со снимком, содержит входы или лежит внутри снимка'
    if o.exists():
        if not o.is_dir():
            return f'--out {out}: это файл, а не папка прежнего прогона'
        names = {p.name for p in o.iterdir()}
        if names and (not names <= RUN_ENTRIES or 'anchor.json' not in names):
            return f'--out {out}: непустая папка — не прежний прогон ({", ".join(sorted(names - RUN_ENTRIES)[:5]) or "нет anchor.json"})'
    return None


def write(out, files):
    """Into a sibling temp dir, then swapped in: a reader never sees half a tree."""
    out = Path(out)
    tmp = out.with_name(f'.{out.name}.tmp-{os.getpid()}')
    shutil.rmtree(tmp, ignore_errors=True)
    for rel, data in files.items():
        f = tmp / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
    old = out.with_name(f'.{out.name}.old-{os.getpid()}')
    if out.exists():
        out.rename(old)
    tmp.rename(out)
    shutil.rmtree(old, ignore_errors=True)


def main(argv):
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--snapshot', required=True)
    ap.add_argument('--map')
    ap.add_argument('--out')
    ap.add_argument('--check-twice', action='store_true')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--project')
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    if a.list:
        for p, s in snapshot(a.snapshot).items():
            if a.project in (None, p):
                for r in s['records']:
                    print(json.dumps({'project': p, **{k: r[k] for k in ('ref', 'file', 'line', 'unit', 'head', 'text')}},
                                     ensure_ascii=False))
        return 0
    if not a.map or not a.out:
        print('нужны --map и --out (или --list)\n' + __doc__, file=sys.stderr)
        return 2
    bad_out = out_problem(a.out, a.snapshot, a.map)
    if bad_out:
        print(f'отказ: {bad_out}; ничего не записано')
        return 1
    files, c, problems = build(a.snapshot, a.map)
    print(f'записей {c.get("records", 0)}: в уроки {c.get("to_lesson", 0)}, в решения {c.get("to_decision", 0)}, '
          f'в архив {c.get("to_archive", 0)}; сирот {c.get("orphans", 0)} · уроков {c.get("lessons", 0)}, '
          f'решений {c.get("decisions", 0)}; разбито записей {c.get("split", 0)}, слияний {c.get("merged", 0)}')
    for p in problems:
        print(p)
    if problems:
        print(f'отказ: проблем {len(problems)}, ничего не записано')
        return 1
    if a.check_twice:
        again, _, _ = build(a.snapshot, a.map)
        if again != files:
            diff = sorted(k for k in set(files) | set(again) if files.get(k) != again.get(k))
            print(f'два прогона: различаются {len(diff)} файлов: {", ".join(diff[:10])}')
            return 1
        print(f'два прогона: побайтно равны (файлов {len(files)}, дерево {tree_sha(files)})')
    write(a.out, files)
    print(f'записано: {a.out} (файлов {len(files)}, дерево {tree_sha(files)})')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
