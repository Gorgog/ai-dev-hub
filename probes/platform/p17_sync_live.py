#!/usr/bin/env python3
"""P17: after a sync (new commit of the hub → `claude plugin marketplace update hub` + `claude plugin update
hub@hub`, what install.cjs does) do live sessions keep working on the old plugin cache without hook errors,
and do new sessions take the new one?

All in the sandbox config dir: the hub plugin of `main` is installed from a local directory marketplace (a git
repo, so the cache dir is named by commit), each version carries a logger hook that records its
CLAUDE_PLUGIN_ROOT and version. A live session (`claude -p`, mock API) runs a few tool calls, sleeps while the
sync happens, then makes 20 more; a new session started after the sync reports its version.
Passed (3/3 rounds): the live session — 0 hook errors in 20 calls after sync; the new one — version = new HEAD."""
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

from common import save, workdir
from sandbox import Sandbox, git, read_jsonl

HUB = Path(__file__).resolve().parents[2]
LOGGER = r'''// probe P17: which copy of the plugin answered
const fs = require('fs'), path = require('path');
let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => {
  const e = JSON.parse(d || '{}');
  const root = process.env.CLAUDE_PLUGIN_ROOT || '';
  const version = fs.readFileSync(path.join(__dirname, '..', 'PROBE_VERSION'), 'utf8').trim();
  fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ ev: e.hook_event_name, sid: e.session_id, root,
    version, cmd: (e.tool_input || {}).command, t: Date.now() }) + '\n');
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


def main():
    root = workdir('P17')
    m = root / 'marketplace'
    sha = make_marketplace(m, 'main')
    proj = root / 'proj'
    proj.mkdir(exist_ok=True)
    git(proj, 'init', '-q')
    sb = Sandbox(root / 'sb', {}, trust=[proj])
    plog = root / 'plugin-log.jsonl'
    plog.unlink(missing_ok=True)
    steps = [{'tool': 'Bash', 'input': {'command': f'echo before-{i}', 'description': 'x'}} for i in range(3)]
    steps += [{'tool': 'Bash', 'input': {'command': 'sleep 25', 'description': 'sync window', 'timeout': 60000}}]
    steps += [{'tool': 'Bash', 'input': {'command': f'echo after-{i}', 'description': 'x'}} for i in range(AFTER)]
    sb.start_mock({'scripts': [{'match': 'P17-LIVE', 'steps': steps + [{'text': 'live done'}]},
                               {'match': 'P17-NEW', 'steps': [{'tool': 'Bash', 'input': {'command': 'echo new'}},
                                                              {'text': 'new done'}]}]}, root / 'mock.jsonl')
    cli = lambda *a: sb.claude(list(a), proj, PROBE_LOG=plog)  # noqa: E731
    setup = [cli('plugin', 'marketplace', 'add', str(m)), cli('plugin', 'install', 'hub@hub')]
    rounds = []
    try:
        for n in range(1, 4):
            installed = json.loads((sb.config / 'plugins' / 'installed_plugins.json').read_text())
            old_path = installed['plugins']['hub@hub'][0]['installPath']
            box = {}
            live = threading.Thread(target=lambda: box.update(
                sb.claude_p(f'P17-LIVE round {n}', proj, PROBE_LOG=plog, PROBE_TAG=f'live{n}', timeout=300)))
            live.start()
            time.sleep(12)  # the live session is in `sleep 25`
            new_sha = commit_version(m, f'v{n + 1}')
            sync = [cli('plugin', 'marketplace', 'update', 'hub'), cli('plugin', 'update', 'hub@hub')]
            live.join()
            new = sb.claude_p('P17-NEW check', proj, PROBE_LOG=plog, PROBE_TAG=f'new{n}')
            installed = json.loads((sb.config / 'plugins' / 'installed_plugins.json').read_text())
            new_path = installed['plugins']['hub@hub'][0]['installPath']
            lsid = next(e['session_id'] for e in box['events'] if e.get('subtype') == 'init')
            nsid = next(e['session_id'] for e in new['events'] if e.get('subtype') == 'init')
            logs = read_jsonl(plog)
            live_after = [x for x in logs if x['sid'] == lsid and (x.get('cmd') or '').startswith('echo after-')]
            new_logs = [x for x in logs if x['sid'] == nsid]
            errs = hook_errors(box['events'])
            rounds.append({
                'round': n, 'old_path': old_path, 'new_path': new_path, 'new_sha': new_sha[:12],
                'old_cache_kept': Path(old_path).exists(),
                'live_calls_after_sync': len(live_after),
                'live_versions_after_sync': sorted({x['version'] for x in live_after}),
                'live_hook_errors': len(errs), 'live_errors': errs[:5], 'live_exit': box['code'],
                'new_versions': sorted({x['version'] for x in new_logs}),
                'new_roots': sorted({x['root'] for x in new_logs}),
                'new_hook_errors': len(hook_errors(new['events'])),
                'sync': [{'code': s['code'], 'out': (s['stdout'] + s['stderr'])[-200:]} for s in sync]})
    finally:
        sb.stop_mock()
    ok_rounds = [r for r in rounds if r['live_calls_after_sync'] == AFTER and r['live_hook_errors'] == 0
                 and r['new_versions'] == [f"v{r['round'] + 1}"] and r['new_path'] != r['old_path']]
    numbers = {'rounds_ok': f'{len(ok_rounds)}/3',
               'live_errors_after_sync': ','.join(str(r['live_hook_errors']) for r in rounds),
               'live_calls_after_sync': ','.join(str(r['live_calls_after_sync']) for r in rounds),
               'live_versions_after_sync': ';'.join(','.join(r['live_versions_after_sync']) for r in rounds),
               'new_session_versions': ';'.join(','.join(r['new_versions']) for r in rounds),
               'old_cache_kept': ','.join('да' if r['old_cache_kept'] else 'нет' for r in rounds)}
    save('P17', 'прошла' if len(ok_rounds) == 3 else 'не прошла', numbers,
         '3/3: живая сессия после sync — 0 ошибок хуков за 20 вызовов, новая — версия = новый HEAD',
         {'base_sha': sha, 'setup': [{'code': s['code'], 'out': (s['stdout'] + s['stderr'])[-300:]} for s in setup],
          'rounds': rounds, 'work': str(root)},
         method='песочница CLAUDE_CONFIG_DIR: плагин hub из main ставится из локального маркетплейса-каталога '
                '(git) как у install.cjs; sync = коммит + `plugin marketplace update hub` + `plugin update hub@hub` '
                'во время живой сессии `claude -p` (мок API); у каждой версии хук-логгер с версией и корнем')


if __name__ == '__main__':
    main()
