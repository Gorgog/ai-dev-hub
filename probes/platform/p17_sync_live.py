#!/usr/bin/env python3
"""P17: after a sync (new commit of the hub → `claude plugin marketplace update hub` + `claude plugin update
hub@hub`, what install.cjs does) do live sessions keep working on the old plugin cache without hook errors,
and do new sessions take the new one?

All in the sandbox config dir: the hub plugin of `main` is installed from a local directory marketplace (a git
repo, so the cache dir is named by commit), each version carries a logger hook that records its
CLAUDE_PLUGIN_ROOT and version. A live session (`claude -p`, mock API) runs a few tool calls, sleeps while the
sync happens, then makes 20 more; a new session started after the sync reports its version.
Passed (3/3 rounds): the live session — 0 hook errors in 20 calls after sync; the new one — version = new HEAD.
Extra rounds (not in the criterion): `dirty` — a file of the marketplace dir changed with no commit and no sync;
`rename` — a new version moves a hook script to another file (as a rewrite of the hooks would), committed and
synced while the session is live. Both engines: the CLI and the one bundled with Desktop."""
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

from common import claude_version, engines, save, workdir
from sandbox import Sandbox, git, read_jsonl

HUB = Path(__file__).resolve().parents[2]
LOGGER = r'''// probe P17: which copy of the plugin answered
const fs = require('fs'), path = require('path');
let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => {
  const e = JSON.parse(d || '{}');
  const root = process.env.CLAUDE_PLUGIN_ROOT || '';
  const version = fs.readFileSync(path.join(__dirname, '..', 'PROBE_VERSION'), 'utf8').trim();
  fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ ev: e.hook_event_name, sid: e.session_id, root,
    dir: path.dirname(__dirname), version, cmd: (e.tool_input || {}).command, t: Date.now() }) + '\n');
});
'''
AFTER = 20


def make_marketplace(dest, ref):
    """Hub marketplace layout from a commit of the hub, + the logger hook; a git repo of its own."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    tar = subprocess.run(['git', '-C', str(HUB), 'archive', ref, '.claude-plugin', 'plugin'], check=True,
                         capture_output=True).stdout
    subprocess.run(['tar', '-x', '-C', str(dest)], input=tar, check=True)
    (dest / 'plugin' / 'hooks' / 'probe-version.cjs').write_text(LOGGER)
    hooks = json.loads((dest / 'plugin' / 'hooks' / 'hooks.json').read_text())
    cmd = {'type': 'command', 'command': 'node', 'args': ['${CLAUDE_PLUGIN_ROOT}/hooks/probe-version.cjs']}
    for ev in ('PreToolUse', 'SessionStart'):
        hooks['hooks'].setdefault(ev, []).append({'hooks': [cmd]})
    (dest / 'plugin' / 'hooks' / 'hooks.json').write_text(json.dumps(hooks, indent=2))
    git(dest, 'init', '-q', '-b', 'main')
    for k, v in (('user.email', 'probe@example.test'), ('user.name', 'probe'), ('commit.gpgsign', 'false')):
        git(dest, 'config', k, v)
    return commit_version(dest, 'v1')


def commit_version(m, label):
    (m / 'plugin' / 'PROBE_VERSION').write_text(label + '\n')
    git(m, 'add', '-A')
    git(m, 'commit', '-q', '-m', label)
    return git(m, 'rev-parse', 'HEAD')


def hook_errors(events):
    """Hook responses that failed: non-zero exit or an error outcome, from --include-hook-events."""
    bad = []
    for e in events:
        if e.get('type') == 'system' and e.get('subtype') == 'hook_response':
            if e.get('exit_code') not in (0, None) or e.get('outcome') in ('error', 'non_blocking_error'):
                bad.append({k: e.get(k) for k in ('hook_name', 'hook_event', 'exit_code', 'outcome', 'stderr')})
    return bad


def change(m, kind, n):
    """The version change of one round; returns the new HEAD (or None when nothing is committed)."""
    if kind == 'dirty':
        (m / 'plugin' / 'PROBE_VERSION').write_text(f'dirty{n}\n')
        return None
    if kind == 'rename':
        hooks_dir = m / 'plugin' / 'hooks'
        (hooks_dir / 'probe-version.cjs').rename(hooks_dir / 'probe-version-2.cjs')
        hj = hooks_dir / 'hooks.json'
        hj.write_text(hj.read_text().replace('probe-version.cjs', 'probe-version-2.cjs'))
    return commit_version(m, f'v{n}')


def one_engine(root, binary):
    m = root / 'marketplace'
    sha = make_marketplace(m, 'main')
    proj = root / 'proj'
    proj.mkdir(parents=True, exist_ok=True)
    git(proj, 'init', '-q')
    sb = Sandbox(root / 'sb', {}, trust=[proj], binary=binary)
    plog = root / 'plugin-log.jsonl'
    steps = [{'tool': 'Bash', 'input': {'command': f'echo before-{i}', 'description': 'x'}} for i in range(3)]
    # the answer after the 3rd call comes 25 s late: the change happens while the live session waits for the model
    steps += [{'tool': 'Bash', 'input': {'command': f'echo after-{i}', 'description': 'x'},
               **({'delay': 25} if i == 0 else {})} for i in range(AFTER)]
    sb.start_mock({'scripts': [{'match': 'P17-LIVE', 'steps': steps + [{'text': 'live done'}]},
                               {'match': 'P17-NEW', 'steps': [{'tool': 'Bash', 'input': {'command': 'echo new'}},
                                                              {'text': 'new done'}]}]}, root / 'mock.jsonl')
    cli = lambda *a: sb.claude(list(a), proj, PROBE_LOG=plog)  # noqa: E731
    setup = [cli('plugin', 'marketplace', 'add', str(m)), cli('plugin', 'install', 'hub@hub')]
    rounds = []
    try:
        for n, kind in enumerate(['sync', 'sync', 'sync', 'dirty', 'rename'], start=2):
            installed = json.loads((sb.config / 'plugins' / 'installed_plugins.json').read_text())
            old_path = installed['plugins']['hub@hub'][0]['installPath']
            box = {}
            live = threading.Thread(target=lambda: box.update(
                sb.claude_p(f'P17-LIVE round {n}', proj, PROBE_LOG=plog, timeout=300)))
            live.start()
            time.sleep(12)  # the live session waits for the delayed answer
            t_change = time.time() * 1000
            new_sha = change(m, kind, n)
            sync = [cli('plugin', 'marketplace', 'update', 'hub'), cli('plugin', 'update', 'hub@hub')] \
                if new_sha else []
            live.join()
            new = sb.claude_p('P17-NEW check', proj, PROBE_LOG=plog)
            installed = json.loads((sb.config / 'plugins' / 'installed_plugins.json').read_text())
            new_path = installed['plugins']['hub@hub'][0]['installPath']
            lsid = next(e['session_id'] for e in box['events'] if e.get('subtype') == 'init')
            nsid = next(e['session_id'] for e in new['events'] if e.get('subtype') == 'init')
            logs = read_jsonl(plog)
            live_after = [x for x in logs if x['sid'] == lsid and (x.get('cmd') or '').startswith('echo after-')
                          and x['t'] > t_change]
            new_logs = [x for x in logs if x['sid'] == nsid]
            errs = [e for e in hook_errors(box['events'])]
            want = f'v{n}' if new_sha else f'dirty{n}'
            rounds.append({
                'round': n, 'kind': kind, 'want': want, 'old_path': old_path, 'new_path': new_path,
                'new_sha': (new_sha or '')[:12], 'old_cache_kept': Path(old_path).exists(),
                'live_calls_after_change': len(live_after),
                'live_versions_after_change': sorted({x['version'] for x in live_after}),
                'live_hook_errors': len(errs), 'live_errors': errs[:3], 'live_exit': box['code'],
                'live_script_dirs': sorted({x['dir'] for x in logs if x['sid'] == lsid}),
                'new_versions': sorted({x['version'] for x in new_logs}),
                'new_script_dirs': sorted({x['dir'] for x in new_logs}),
                'new_hook_errors': len(hook_errors(new['events'])),
                'sync': [{'code': s['code'], 'out': (s['stdout'] + s['stderr'])[-200:]} for s in sync]})
    finally:
        sb.stop_mock()
    return {'engine': claude_version(binary), 'base_sha': sha, 'rounds': rounds,
            'setup': [{'code': s['code'], 'out': (s['stdout'] + s['stderr'])[-300:]} for s in setup]}


def main():
    top = workdir('P17')
    per = {label: one_engine(top / label, binary) for label, binary in engines()}
    numbers, ok = {}, True
    for label, res in per.items():
        sync = [r for r in res['rounds'] if r['kind'] == 'sync']
        good = [r for r in sync if r['live_calls_after_change'] == AFTER and r['live_hook_errors'] == 0
                and r['new_versions'] == [r['want']]]
        ok = ok and len(good) == 3
        live_code = sorted({v for r in sync for v in r['live_versions_after_change']})
        extra = {r['kind']: r for r in res['rounds'] if r['kind'] != 'sync'}
        numbers.update({
            f'{label}:rounds_ok': f'{len(good)}/3',
            f'{label}:live_errors_after_sync': ','.join(str(r['live_hook_errors']) for r in sync),
            f'{label}:live_runs_version': ','.join(live_code) + ' (новая — код читается из каталога маркетплейса)',
            f'{label}:new_session_versions': ','.join(','.join(r['new_versions']) for r in sync),
            f'{label}:dirty_no_commit_live_sees': ','.join(extra['dirty']['live_versions_after_change']) or '—',
            f'{label}:rename_live_errors': extra['rename']['live_hook_errors'],
        })
    save('P17', 'прошла' if ok else 'не прошла', numbers,
         '3/3: живая сессия после sync — 0 ошибок хуков за 20 вызовов, новая — версия = новый HEAD',
         {'engines': per, 'work': str(top)},
         method='песочница CLAUDE_CONFIG_DIR, движки CLI и Desktop: плагин hub из main ставится из локального '
                'маркетплейса-каталога (git) как у install.cjs; sync = коммит + `plugin marketplace update hub` + '
                '`plugin update hub@hub`, пока живая сессия `claude -p` ждёт ответа мока; у версии хук-логгер с '
                'версией, корнем и путём своего файла; доп. раунды: правка без коммита, переименование файла хука')


if __name__ == '__main__':
    main()
