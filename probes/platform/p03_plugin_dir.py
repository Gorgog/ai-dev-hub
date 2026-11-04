#!/usr/bin/env python3
"""P3 (smoke check of a branch before merge): with `hub@hub` installed and enabled and
`claude --plugin-dir <worktree>/plugin` — which copy's hooks fire, are any doubled, are CLAUDE_PLUGIN_DATA apart?

Sandbox config dir: hub@hub installed from a marketplace made of `main`; the --plugin-dir copy is this branch's
HEAD. Each copy gets a logger hook (PreToolUse, SessionStart) naming itself. Passed: in the session only the branch
copy's hooks fire, or it is plainly visible whose; plugin data dirs are separate."""
import json
import shutil
import subprocess
from pathlib import Path

from common import save, workdir
from p17_sync_live import LOGGER, make_marketplace
from sandbox import Sandbox, git, read_jsonl

HUB = Path(__file__).resolve().parents[2]
LOGGER_DATA = LOGGER.replace("version, cmd:", "version, data: process.env.CLAUDE_PLUGIN_DATA || '', cmd:")


def branch_copy(dest):
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    tar = subprocess.run(['git', '-C', str(HUB), 'archive', 'HEAD', 'plugin'], check=True,
                         capture_output=True).stdout
    subprocess.run(['tar', '-x', '-C', str(dest)], input=tar, check=True)
    plug = dest / 'plugin'
    (plug / 'PROBE_VERSION').write_text('branch\n')
    (plug / 'hooks' / 'probe-version.cjs').write_text(LOGGER_DATA)
    hooks = json.loads((plug / 'hooks' / 'hooks.json').read_text())
    cmd = {'type': 'command', 'command': 'node', 'args': ['${CLAUDE_PLUGIN_ROOT}/hooks/probe-version.cjs']}
    for ev in ('PreToolUse', 'SessionStart'):
        hooks['hooks'].setdefault(ev, []).append({'hooks': [cmd]})
    (plug / 'hooks' / 'hooks.json').write_text(json.dumps(hooks, indent=2))
    return plug


def main():
    root = workdir('P3')
    m = root / 'marketplace'
    make_marketplace(m, 'main')
    (m / 'plugin' / 'hooks' / 'probe-version.cjs').write_text(LOGGER_DATA)
    (m / 'plugin' / 'PROBE_VERSION').write_text('installed\n')
    git(m, 'add', '-A')
    git(m, 'commit', '-q', '-m', 'installed marker')
    plug = branch_copy(root / 'branch')
    proj = root / 'proj'
    proj.mkdir(exist_ok=True)
    git(proj, 'init', '-q')
    sb = Sandbox(root / 'sb', {}, trust=[proj])
    plog = root / 'plugin-log.jsonl'
    plog.unlink(missing_ok=True)
    sb.start_mock({'scripts': [{'match': 'P3-', 'steps': [
        {'tool': 'Bash', 'input': {'command': 'echo one', 'description': 'x'}},
        {'tool': 'Bash', 'input': {'command': 'echo two', 'description': 'x'}}, {'text': 'P3 done'}]}]},
        root / 'mock.jsonl')
    try:
        setup = [sb.claude(['plugin', 'marketplace', 'add', str(m)], proj),
                 sb.claude(['plugin', 'install', 'hub@hub'], proj)]
        runs = {}
        for name, extra in (('installed-only', []), ('installed+plugin-dir', ['--plugin-dir', str(plug)])):
            n0 = len(read_jsonl(plog))
            r = sb.claude_p(f'P3-{name}', proj, extra, PROBE_LOG=plog)
            init = next((e for e in r['events'] if e.get('subtype') == 'init'), {})
            logs = read_jsonl(plog)[n0:]
            hook_names = [e.get('hook_name') for e in r['events'] if e.get('subtype') == 'hook_started']
            runs[name] = {
                'code': r['code'], 'plugins': init.get('plugins'), 'plugin_errors': init.get('plugin_errors'),
                'logger_by_copy': {v: sum(1 for x in logs if x['version'] == v) for v in
                                   sorted({x['version'] for x in logs})},
                'pretool_per_call': {c: sorted(x['version'] for x in logs if x.get('cmd') == c)
                                     for c in ('echo one', 'echo two')},
                'plugin_data': sorted({x.get('data', '') for x in logs}),
                'roots': sorted({x['root'] for x in logs}),
                'hook_names': sorted(set(hook_names)), 'hooks_started': len(hook_names),
                'stderr': r['stderr'][-300:]}
    finally:
        sb.stop_mock()
    both, alone = runs['installed+plugin-dir'], runs['installed-only']
    copies = set(both['logger_by_copy'])
    only_branch = copies == {'branch'}
    separate = bool(both['plugin_data']) and not set(both['plugin_data']) & set(alone['plugin_data'])
    numbers = {'copies_firing': ','.join(sorted(copies)) or '—',
               'pretool_per_call': ','.join('+'.join(v) for v in both['pretool_per_call'].values()),
               'plugin_data': ' vs '.join(Path(d).name for d in alone['plugin_data'] + both['plugin_data']),
               'hub_in_init': ','.join(f"{p.get('source')}" for p in both['plugins'] or [] if p.get('name') == 'hub')}
    # the control must show the installed copy alive on its own, else «only the branch fires» proves nothing
    installed_ok = all(x['code'] == 0 for x in setup) and alone['code'] == 0 and set(alone['logger_by_copy']) == {'installed'}
    numbers['control_installed_only'] = ','.join(sorted(alone['logger_by_copy'])) or '—'
    if not installed_ok:
        verdict = 'не решена'
    else:
        verdict = 'прошла' if only_branch and separate and both['code'] == 0 else 'не прошла'
    save('P3', verdict, numbers,
         'в сессии v2 срабатывают только хуки v2 или явно видно, чьи; данные плагина раздельны',
         {'setup': [{'code': s['code'], 'out': (s['stdout'] + s['stderr'])[-300:]} for s in setup], 'runs': runs,
          'work': str(root)},
         method='песочница CLAUDE_CONFIG_DIR: hub@hub из main установлен из маркетплейса-каталога, ветка — '
                '--plugin-dir копией HEAD; в обеих копиях хук-логгер с именем копии, CLAUDE_PLUGIN_DATA и корнем')


if __name__ == '__main__':
    main()
