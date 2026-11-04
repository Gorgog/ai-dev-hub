#!/usr/bin/env python3
"""Snapshot of hub data into ~/hub-data: everything the baseline, the polygon, replay and the memory migration stand on.

    python3 tools/hub-data/snapshot.py [--dest ~/hub-data] [--journals ~/.claude/projects] [--hub <hub root>]
    python3 tools/hub-data/snapshot.py --verify ~/hub-data

Areas of the copy (dest is private: 700):
  journals/  session journals, whole; journals/MANIFEST.sha256
  hub/       research/, ideas/, local hub configs and every project folder (memory, configs, plan, hook and lock
             journals, grants) without its git checkouts; hub/MANIFEST.sha256
  bundles/   `git bundle create --all` of the hub repo and of every repo inside a project folder
  reports/<time>/report.md  what was new or changed, repos (status, stash, branches without upstream, dirty
             worktrees), git status before and after; secrets.tsv - kind, count, file: never the value
A repeat copies only new and changed files and reports only them; a file gone from the source stays in the copy.
Sources are only read: no fetch, no worktree add, git runs without optional locks (no index refresh).
--verify: each copy against its manifest (100% or exit 1), the copy against the source (a source changed after the
snapshot is only noted), `git bundle verify` of every bundle. Stdlib only.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

CHUNK = 1 << 20
MANIFEST = 'MANIFEST.sha256'
STATE = '.state.json'
SHOW = 50  # changed files printed per area; the report has all of them
# Project subfolders that are not data: checkouts of the project's code (bundled from the repo itself).
CHECKOUTS = {'repo', 'worktrees', 'wt'}
# Local, untracked hub files worth keeping: research, ideas, personal rules, the private names list.
HUB_EXTRAS = ['research', 'ideas', 'CLAUDE.local.md', '.githooks/private-patterns']
GIT_ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C'}
# Kinds of secrets. Only the kind and the count leave the scan.
SECRETS = [
    ('private-key', rb'-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----'),
    ('aws-key', rb'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),
    ('github-token', rb'\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{50,}'),
    ('gitlab-token', rb'\bglpat-[A-Za-z0-9_-]{20,}'),
    ('anthropic-key', rb'\bsk-ant-[A-Za-z0-9_-]{20,}'),
    ('openai-key', rb'\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}'),
    ('slack-token', rb'\bxox[abposr]-[A-Za-z0-9-]{10,}'),
    ('google-key', rb'\bAIza[0-9A-Za-z_-]{35}'),
    ('jwt', rb'\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
    # NAME=value, "name": "value", also JSON-escaped; placeholders ($X, <x>, {x}, %x, ***) are skipped.
    ('assignment', rb'(?i)(?:password|passwd|secret|token|api[_-]?key)(?:\\?["\'])?\s*[=:]\s*(?:\\?["\'])?'
                   rb'(?![$<{%*])[^\s"\'\\,;{}()<>]{8,}'),
]
SECRETS = [(kind, re.compile(rx)) for kind, rx in SECRETS]
NO_SCAN = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.webm', '.mov', '.zip', '.gz', '.pdf',
           '.woff', '.woff2', '.ttf', '.bundle'}


def die(msg):
    print(f'hub-data: {msg}', file=sys.stderr)
    sys.exit(2)


def git(cwd, *args, check=True):
    r = subprocess.run(['git', *args], cwd=cwd, env=GIT_ENV, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f'git {" ".join(args)} в {cwd}: {r.stderr.strip()}')
    return r


def sha_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def walk(base, rel_root):
    """Regular files under base as (rel, abs); rel is rel_root/... with '/'. Symlinks are not followed."""
    base = Path(base)
    if base.is_symlink():
        return
    if base.is_file():
        yield rel_root, base
        return
    for d, dirs, names in os.walk(base):
        dirs.sort()
        for n in sorted(names):
            p = Path(d, n)
            if p.is_file() and not p.is_symlink():
                yield (Path(rel_root, p.relative_to(base)).as_posix() if rel_root else p.relative_to(base).as_posix()), p


def is_repo(d):
    return (d / '.git').is_dir()


def journal_files(root):
    for rel, p in walk(root, ''):
        if rel != MANIFEST:
            yield rel, p


def hub_files(hub):
    for extra in HUB_EXTRAS:
        if (hub / extra).exists():
            yield from walk(hub / extra, extra)
    projects = hub / 'projects'
    for proj in sorted(projects.iterdir()) if projects.is_dir() else []:
        if not proj.is_dir() or proj.is_symlink():
            continue
        for entry in sorted(proj.iterdir()):
            if entry.name in CHECKOUTS or (entry.is_dir() and is_repo(entry) and entry.name != 'memory'):
                continue
            yield from walk(entry, f'projects/{proj.name}/{entry.name}')


def repos(hub):
    """(bundle name, path): the hub repo and every repo directly inside a project folder."""
    out = [('hub', hub)] if is_repo(hub) else []
    projects = hub / 'projects'
    for proj in sorted(projects.iterdir()) if projects.is_dir() else []:
        if proj.is_dir():
            # A linked worktree has a .git file, not a dir: it is in its repo's bundle already.
            out += [(f'{proj.name}--{d.name}', d) for d in sorted(proj.iterdir()) if d.is_dir() and is_repo(d)]
    return out


def copy_hashed(src, dst, tmpdir):
    """Copy src to dst through a temp file, hashing the very bytes written. Returns (stat before, sha)."""
    for _ in range(3):
        st = os.stat(src)
        h = hashlib.sha256()
        fd, tmp = tempfile.mkstemp(dir=tmpdir)
        with open(src, 'rb') as fi, os.fdopen(fd, 'wb') as fo:
            while chunk := fi.read(CHUNK):
                h.update(chunk)
                fo.write(chunk)
        os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(tmp, dst)
        now = os.stat(src)
        if (now.st_size, now.st_mtime_ns) == (st.st_size, st.st_mtime_ns):
            break
    # A file still growing keeps the stat taken before its last copy: the next run sees it changed and copies again.
    return st, h.hexdigest()


def sync_area(name, title, root, files, dest, state, tmpdir):
    area = state['areas'].setdefault(name, {'root': str(root), 'files': {}})
    area['root'] = str(root)
    known = area['files']
    out = dest / name
    new, changed, seen, errors = [], [], set(), []
    for rel, src in files:
        seen.add(rel)
        dst = out / rel
        try:
            st = os.stat(src)
            prev = known.get(rel)
            if prev and prev[:2] == [st.st_size, st.st_mtime_ns] and dst.is_file() and dst.stat().st_size == prev[0]:
                continue
            st, digest = copy_hashed(src, dst, tmpdir)
        except OSError as e:
            errors.append(f'{rel}: {e.strerror}')
            continue
        if not prev:
            new.append(rel)
        elif prev[2] != digest:
            changed.append(rel)
        known[rel] = [st.st_size, st.st_mtime_ns, digest]
    with open(out / MANIFEST, 'w') as f:
        f.writelines(f'{known[rel][2]}  {rel}\n' for rel in sorted(known))
    gone = sorted(set(known) - seen)
    return {'name': name, 'title': title, 'total': len(known), 'new': new, 'changed': changed, 'gone': gone,
            'errors': errors}


def area_line(s):
    if not s['new'] and not s['changed']:
        return f"{s['title']}: 0 новых, 0 изменённых (файлов {s['total']}, пропало в источнике {len(s['gone'])})"
    return (f"{s['title']}: файлов {s['total']}, новых {len(s['new'])}, изменённых {len(s['changed'])}, "
            f"пропало в источнике {len(s['gone'])}")


def area_list(s, limit=None):
    rows = [f'  + {r}' for r in s['new']] + [f'  ~ {r}' for r in s['changed']] + [f'  ! {e}' for e in s['errors']]
    if limit is not None and len(rows) > limit:
        rows = rows[:limit] + [f'  … ещё {len(rows) - limit} (полный список — в отчёте)']
    return rows


def git_status(path):
    r = git(path, 'status', '--porcelain=v1', '-b', check=False)
    return r.stdout if r.returncode == 0 else f'ошибка: {r.stderr.strip()}'


def worktrees(repo):
    """Linked worktrees (path, branch) of a repo, the main checkout excluded; gone ones skipped."""
    out, cur = [], {}
    for line in git(repo, 'worktree', 'list', '--porcelain', check=False).stdout.splitlines() + ['']:
        if not line:
            if cur:
                out.append(cur)
            cur = {}
        elif ' ' in line:
            k, v = line.split(' ', 1)
            cur[k] = v
    return [(Path(w['worktree']), w.get('branch', '(detached)').removeprefix('refs/heads/'))
            for w in out[1:] if Path(w['worktree']).is_dir()]


def statuses(repo_list):
    out = {}
    for _, path in repo_list:
        out[str(path)] = git_status(path)
        for wt, _ in worktrees(path):
            out[str(wt)] = git_status(wt)
    return out


def bundle_verify(bundle):
    with tempfile.TemporaryDirectory() as bare:
        git(bare, 'init', '-q', '--bare', '.')
        return git(bare, 'bundle', 'verify', '-q', str(bundle), check=False)


def snapshot_repo(name, path, bundles, tmpdir):
    info = {'name': name, 'path': str(path), 'ok': False}
    stash = git(path, 'stash', 'list').stdout.splitlines()
    refs = git(path, 'for-each-ref', '--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)',
               'refs/heads').stdout.splitlines()
    info['stash'] = stash
    info['no_upstream'] = [r.split('\t')[0] for r in refs if not r.split('\t')[1]]
    info['ahead'] = [f"{r.split(chr(9))[0]} {r.split(chr(9))[2]}" for r in refs if 'ahead' in r.split('\t')[2]]
    info['worktrees'] = [(str(wt), br, git_status(wt)) for wt, br in worktrees(path)]
    tmp = Path(tmpdir, f'{name}.bundle')
    r = git(path, 'bundle', 'create', '-q', str(tmp), '--all', check=False)
    if r.returncode != 0:
        info['error'] = 'пустой репозиторий' if 'empty bundle' in r.stderr else r.stderr.strip()
        info['empty'] = 'empty bundle' in r.stderr
        tmp.unlink(missing_ok=True)
        return info
    os.replace(tmp, bundles / f'{name}.bundle')
    v = bundle_verify(bundles / f'{name}.bundle')
    info['ok'] = v.returncode == 0
    if not info['ok']:
        info['error'] = v.stderr.strip()
    return info


def scan_secrets(path):
    if path.suffix.lower() in NO_SCAN:
        return {}
    data = path.read_bytes()
    found = {kind: len(rx.findall(data)) for kind, rx in SECRETS}
    return {k: n for k, n in found.items() if n}


def load_state(dest):
    try:
        return json.loads((dest / STATE).read_text())
    except (OSError, ValueError):
        return {'version': 1, 'areas': {}, 'secrets': {}, 'bundles': []}


def save_state(dest, state):
    tmp = dest / f'{STATE}.tmp'
    tmp.write_text(json.dumps(state))
    os.replace(tmp, dest / STATE)


def default_hub():
    r = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                       cwd=Path(__file__).resolve().parent, capture_output=True, text=True)
    if r.returncode != 0:
        die('не нашёл корень хаба: передай --hub')
    return Path(r.stdout.strip()).parent


def report_dir(dest):
    base = dest / 'reports' / datetime.now().strftime('%Y-%m-%dT%H%M%S')
    d, n = base, 1
    while d.exists():
        n += 1
        d = base.with_name(f'{base.name}-{n}')
    d.mkdir(parents=True)
    return d


def snapshot(dest, journals, hub):
    if not journals.is_dir():
        die(f'нет папки журналов {journals}')
    if not (hub / 'projects').is_dir():
        die(f'{hub} — не корень хаба (нет projects/)')
    os.umask(0o077)
    dest.mkdir(parents=True, exist_ok=True)
    dest.chmod(0o700)
    lock = open(dest / '.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        die(f'снимок в {dest} уже идёт')
    tmpdir = dest / '.tmp'
    shutil.rmtree(tmpdir, ignore_errors=True)
    tmpdir.mkdir()
    state = load_state(dest)
    repo_list = repos(hub)
    before = statuses(repo_list)

    areas = [sync_area('journals', 'журналы', journals, journal_files(journals), dest, state, tmpdir),
             sync_area('hub', 'хаб', hub, hub_files(hub), dest, state, tmpdir)]

    bundles = dest / 'bundles'
    bundles.mkdir(exist_ok=True)
    infos = []
    for name, path in repo_list:
        try:
            infos.append(snapshot_repo(name, path, bundles, tmpdir))
        except RuntimeError as e:  # a broken repo is reported, the rest of the snapshot goes on
            infos.append({'name': name, 'path': str(path), 'ok': False, 'error': str(e), 'stash': [],
                          'no_upstream': [], 'ahead': [], 'worktrees': []})
    state['bundles'] = sorted(set(state.get('bundles', [])) | {i['name'] for i in infos if i['ok']})
    after = statuses(repo_list)
    moved = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))

    secrets = state.setdefault('secrets', {})
    for s in areas:
        for rel in s['new'] + s['changed']:
            key = f"{s['name']}/{rel}"
            found = scan_secrets(dest / key)
            if found:
                secrets[key] = found
            else:
                secrets.pop(key, None)
    save_state(dest, state)
    shutil.rmtree(tmpdir, ignore_errors=True)

    rdir = report_dir(dest)
    tsv = sorted((kind, n, key) for key, kinds in secrets.items() for kind, n in kinds.items())
    (rdir / 'secrets.tsv').write_text(''.join(f'{k}\t{n}\t{key}\n' for k, n, key in tsv))
    ok_bundles = sum(i['ok'] for i in infos)
    real = [i for i in infos if not i.get('empty')]
    lines = []
    for s in areas:
        lines.append(area_line(s))
        lines += area_list(s, SHOW)
    lines.append(f'бандлы: {len(real)}, verify ok {ok_bundles} из {len(real)}')
    lines += [f"  ! {i['name']}: {i['error']}" for i in infos if not i['ok']]
    if moved:
        lines.append(f'источники: git status изменился у {len(moved)} из {len(before)} (живая работа?)')
        lines += [f'  ~ {p}' for p in moved]
    else:
        lines.append(f'источники: git status до и после совпадает ({len(before)} из {len(before)})')
    lines.append(f'секреты: файлов {len(secrets)} ({rdir.relative_to(dest)}/secrets.tsv)')

    rep = [f'# Снимок данных хаба — {datetime.now().isoformat(timespec="seconds")}', '',
           f'Журналы: `{journals}`. Хаб: `{hub}`. Копия: `{dest}`.', '']
    for s in areas:
        rep += [f"## {s['title'].capitalize()}", '', area_line(s)]
        rep += area_list(s) + [f'  - {r}' for r in s['gone']] + ['']
    rep += ['## Репозитории', '']
    for i in infos:
        rep += [f"### {i['name']} — `{i['path']}`", '',
                f"- бандл: `bundles/{i['name']}.bundle` — " + ('verify ok' if i['ok'] else f"нет: {i['error']}"),
                f"- stash: {len(i['stash'])}"] + [f'  - {x}' for x in i['stash']]
        rep += [f"- ветки без upstream: {', '.join(i['no_upstream']) or 'нет'}",
                f"- ветки впереди upstream: {', '.join(i['ahead']) or 'нет'}",
                '- git status:', '```', before.get(i['path'], '').rstrip(), '```']
        for wt, br, st in i['worktrees']:
            dirty = [x for x in st.splitlines() if not x.startswith('##')]
            rep.append(f'- worktree `{wt}` ({br}): ' + ('чисто' if not dirty else f'незакоммичено {len(dirty)}'))
            rep += [f'  - `{x}`' for x in dirty]
        rep.append('')
    rep += ['## Источники до и после', '',
            'git status не изменился.' if not moved else 'Изменился git status: ' + ', '.join(moved), '',
            '## Секреты', '', f'Файлов с находками: {len(secrets)} — `secrets.tsv` (вид, число, файл; без значений).', '']
    (rdir / 'report.md').write_text('\n'.join(rep))
    lines.append(f'отчёт: {rdir / "report.md"}')
    print('\n'.join(lines))
    failed = any(s['errors'] for s in areas) or any(not i['ok'] and not i.get('empty') for i in infos)
    return 1 if failed else 0


def verify_area(dest, name, title, area):
    out = dest / name
    rows, errors = [], []
    listed = {}
    try:
        for line in (out / MANIFEST).read_text().splitlines():
            digest, rel = line.split('  ', 1)
            listed[rel] = digest
    except OSError:
        return [f'{title}: нет манифеста {out / MANIFEST}'], True
    good = 0
    later, gone, same = [], [], 0
    root = Path(area['root']) if area else None
    for rel, digest in sorted(listed.items()):
        p = out / rel
        if not p.is_file():
            errors.append(f'  ! {rel}: нет в копии')
            continue
        if sha_of(p) != digest:
            errors.append(f'  ! {rel}: копия не совпадает с манифестом')
            continue
        good += 1
        if root is None:
            continue
        src = root / rel
        rec = area['files'].get(rel)
        try:
            st = os.stat(src)
        except OSError:
            gone.append(rel)
            continue
        if rec and rec[:2] != [st.st_size, st.st_mtime_ns]:
            later.append(rel)
        elif sha_of(src) != digest:
            errors.append(f'  ! {rel}: расходится с источником, хотя источник не менялся после снимка')
        else:
            same += 1
    on_disk = {p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()} - {MANIFEST}
    errors += [f'  ! {rel}: лишний файл в копии, нет в манифесте' for rel in sorted(on_disk - set(listed))]
    pct = 100 * good / len(listed) if listed else 100
    rows.append(f'{title}: манифест сходится {good} из {len(listed)} ({pct:.3g}%)')
    if root is not None:
        rows.append(f'{title}: с источником совпадает {same}, изменено в источнике после снимка {len(later)}, '
                    f'пропало в источнике {len(gone)}')
        rows += [f'  ~ {r}' for r in later[:SHOW]]
    return rows + errors, bool(errors)


def verify(dest):
    if not dest.is_dir():
        die(f'нет копии {dest}')
    state = load_state(dest)
    rows, failed = [], False
    for name, title in (('journals', 'журналы'), ('hub', 'хаб')):
        r, bad = verify_area(dest, name, title, state['areas'].get(name))
        rows += r
        failed |= bad
    names = state.get('bundles', [])
    bad_b = []
    for n in names:
        p = dest / 'bundles' / f'{n}.bundle'
        res = bundle_verify(p) if p.is_file() else None
        if res is None or res.returncode != 0:
            bad_b.append(f'  ! {n}: ' + ('нет файла' if res is None else res.stderr.strip()))
    rows.append(f'бандлы: verify ok {len(names) - len(bad_b)} из {len(names)}')
    rows += bad_b
    failed |= bool(bad_b)
    mode = dest.stat().st_mode & 0o777
    if mode != 0o700:
        rows.append(f'  ! права {dest}: {mode:o}, нужно 700')
        failed = True
    print('\n'.join(rows))
    return 1 if failed else 0


def main():
    ap = argparse.ArgumentParser(description='Снимок данных хаба в ~/hub-data')
    ap.add_argument('--verify', metavar='DEST', help='сверить копию с манифестами, источником и бандлы')
    ap.add_argument('--dest', default='~/hub-data')
    ap.add_argument('--journals', default='~/.claude/projects')
    ap.add_argument('--hub')
    a = ap.parse_args()
    if a.verify:
        return verify(Path(a.verify).expanduser())
    hub = Path(a.hub).expanduser().resolve() if a.hub else default_hub()
    return snapshot(Path(a.dest).expanduser(), Path(a.journals).expanduser(), hub)


if __name__ == '__main__':
    sys.exit(main())
