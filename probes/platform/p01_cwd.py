#!/usr/bin/env python3
"""P1: does CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 keep the working dir for subagents (hub:reviewer, Explore),
not only for the main session? Drift = a Bash call that starts outside the project dir because an earlier call
did `cd` (measured by where calls start, not by counting bare `cd`).

  --mock    mechanism, no model: in the sandbox the mock makes the session and two subagents (general-purpose,
            Explore) run `cd sub` then `pwd`, with and without the variable (settings env); drift is read from
            the `pwd` output. Shows the measure sees drift at all.
  --model <hub-evals dir> [--repeats 3]
            the criterion: scenario M01 of the hub polygon prototype × 3 with the real model, the variable in the
            fixture's settings and a PreToolUse logger; drift = Bash calls whose start dir (hook `cwd`) is not the
            project dir — for the session and for every subagent (the reviewer included).
Results merge into P1.json: verdict comes from --model; --mock alone gives «не решена»."""
import json
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import DATA, claude_version, save, workdir
from sandbox import Sandbox, git_repo, hook_logger, read_jsonl

ENV = 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR'
HERE = Path(__file__).resolve().parent


BARE_CD = re.compile(r'(^|&&|;|\|\||\n)\s*cd\s', re.M)
SUBSHELL = re.compile(r'\([^()]*\)')


def bare_cd(cmd):
    """A `cd` outside a subshell: `cd x && …`, `a; cd x`, a cd on its own line — not `( cd x && … )`."""
    s = cmd or ''
    while SUBSHELL.search(s):  # drop (…) groups, innermost first
        s = SUBSHELL.sub(' ', s)
    return bool(BARE_CD.search(s))


def cd_pwd(tag, sub):
    return [{'tool': 'Bash', 'input': {'command': f'cd {sub}', 'description': f'{tag} cd'}},
            {'tool': 'Bash', 'input': {'command': 'pwd', 'description': f'{tag} pwd'}}]


def mock_run(root, keep):
    """Each subagent cds into its own dir; the session cds only after them, so drift seen in a subagent is its
    own, and the session's `pwd` right after the subagents shows whether their cd leaked into it."""
    name = 'keep' if keep else 'nokeep'
    shutil.rmtree(root / name, ignore_errors=True)
    subs = {'gp': 'general-purpose', 'ex': 'Explore', 'rev': 'hub:reviewer'}
    proj = git_repo(root / name / 'proj', {'README.md': 'p1\n', 'sub-main/README.md': 'x\n',
                                           **{f'sub-{t}/README.md': 'x\n' for t in subs}})
    log = root / name / 'hook.jsonl'
    settings = {'hooks': {'PreToolUse': [{'matcher': 'Bash', 'hooks': [
        {'type': 'command', 'command': hook_logger(log)}]}]}}
    if keep:
        settings['env'] = {ENV: '1'}
    sb = Sandbox(root / name / 'sb', settings, trust=[proj])
    agent = lambda t, p: {'tool': 'Agent', 'input': {'subagent_type': t, 'description': p,  # noqa: E731
                                                     'prompt': f'{p} run cd then pwd', 'run_in_background': False}}
    main_steps = [agent(t, f'P1-SUB-{tag.upper()}') for tag, t in subs.items()]
    main_steps += [{'tool': 'Bash', 'input': {'command': 'pwd', 'description': 'after-subagents pwd'}}]
    main_steps += cd_pwd('main', 'sub-main') + [{'text': 'P1 done'}]
    scripts = [{'match': 'P1-MAIN', 'steps': main_steps}]
    scripts += [{'match': f'P1-SUB-{tag.upper()}', 'steps': cd_pwd(tag, f'sub-{tag}') + [{'text': f'{tag} done'}]}
                for tag in subs]
    sb.start_mock({'scripts': scripts}, root / name / 'mock.jsonl')
    try:  # hub:reviewer comes from this branch's plugin
        r = sb.claude_p('P1-MAIN go', proj, ['--plugin-dir', str(HERE.parents[1] / 'plugin')])
    finally:
        sb.stop_mock()
    (root / name / 'transcript.jsonl').write_text(r['stdout'])
    uses, results = {}, {}
    for e in r['events']:
        for b in (e.get('message') or {}).get('content') or []:
            if not isinstance(b, dict):
                continue
            if b.get('type') == 'tool_use' and b.get('name') == 'Bash':
                uses[b['id']] = b['input'].get('description', '')
            if b.get('type') == 'tool_result' and b.get('tool_use_id') in uses:
                c = b.get('content')
                results[b['tool_use_id']] = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c or [])
    pwds = {uses[i].replace(' pwd', ''): results.get(i, '').strip() for i in uses if uses[i].endswith('pwd')}
    drift = {k: v != str(proj) for k, v in pwds.items()}
    hooks = read_jsonl(log)
    return {'keep': keep, 'code': r['code'], 'pwd': pwds, 'drift': drift, 'hook_calls': len(hooks),
            'hook_cwd_off_project': sum(1 for h in hooks if h.get('cwd') != str(proj)),
            'hook_cwds': [(h.get('agent_type') or 'main', h.get('cwd'), (h.get('tool_input') or {}).get('command'))
                          for h in hooks], 'engine': claude_version()}


def analyze(hook_log, proj):
    """Per agent: Bash calls, calls that start off the project dir (drift), and calls that come after a bare cd
    of the same agent (chances to drift — without them «drift 0» says little)."""
    by_agent, seen_cd = {}, set()
    for h in read_jsonl(hook_log):
        a = h.get('agent_type') or ('main' if not h.get('agent_id') else 'subagent')
        key = (a, h.get('agent_id'))
        d = by_agent.setdefault(a, {'calls': 0, 'drift': 0, 'after_bare_cd': 0, 'examples': []})
        d['calls'] += 1
        d['after_bare_cd'] += key in seen_cd
        cmd = (h.get('tool_input') or {}).get('command', '')
        if os.path.realpath(h.get('cwd') or '') != os.path.realpath(proj):
            d['drift'] += 1
            d['examples'].append([h.get('cwd'), cmd[:80]])
        if bare_cd(cmd):
            seen_cd.add(key)
    return by_agent


def model_runs(root, evals, repeats):
    """M01 × repeats in parallel (one process each, the real model, user auth from ~/.claude)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(('CLAUDE', 'ANTHROPIC'))}

    def one(n):
        return n, subprocess.run(['node', str(HERE / 'p01_m01.cjs'), str(evals), str(HERE.parents[1]),
                                  str(root / f'm01-r{n}'), ENV], env=env, capture_output=True, text=True,
                                 timeout=2400)
    with ThreadPoolExecutor(repeats) as pool:
        done = list(pool.map(one, range(1, repeats + 1)))
    out = []
    for n, r in done:
        if r.returncode != 0:
            out.append({'run': n, 'error': (r.stdout + r.stderr)[-800:]})
            continue
        res = json.loads(r.stdout.splitlines()[-1])
        out.append({'run': n, 'hook_log': res['hookLog'], 'cwd': res['cwd'], 'checks': res['checks'],
                    'agents': res['agents'], 'turns': res['turns'],
                    'transcript': res['transcript']})
    return out


def main():
    root = workdir('P1', fresh=False)
    prev = DATA / 'P1.json'
    details = json.loads(prev.read_text())['details'] if prev.exists() else {}
    if '--mock' in sys.argv:
        details['mock'] = [mock_run(root, True), mock_run(root, False)]
        for m in details['mock']:
            print(json.dumps({k: m[k] for k in ('keep', 'code', 'pwd', 'hook_cwd_off_project')}, ensure_ascii=False))
    if '--model' in sys.argv:
        evals = Path(sys.argv[sys.argv.index('--model') + 1])
        rep = int(sys.argv[sys.argv.index('--repeats') + 1]) if '--repeats' in sys.argv else 3
        details['model'] = model_runs(root, evals, rep)
        details['model_repeats'] = rep
        details['model_engine'] = claude_version()
    for m in details.get('model', []):  # re-read the hook logs: the analysis may change after the runs
        if 'hook_log' not in m and m.get('transcript'):
            m['hook_log'] = str(Path(m['transcript']).with_name('bash-cwd.jsonl'))
        if m.get('hook_log') and Path(m['hook_log']).exists():
            m['by_agent'] = analyze(m['hook_log'], m.get('cwd') or Path(m['hook_log']).parent.joinpath(
                'hub/projects/demo/repo'))
        print(json.dumps({k: m.get(k) for k in ('run', 'by_agent', 'agents', 'error')}, ensure_ascii=False))
    numbers = {}
    for m in details.get('mock', []):
        numbers[f"mock_{'env' if m['keep'] else 'no_env'}_drift"] = \
            ','.join(f'{k}:{int(v)}' for k, v in m['drift'].items())
    runs = [m for m in details.get('model', []) if 'by_agent' in m]
    verdict = 'не решена'
    if runs:
        sub_calls = sum(d['calls'] for m in runs for a, d in m['by_agent'].items() if a != 'main')
        rev_calls = sum(d['calls'] for m in runs for a, d in m['by_agent'].items() if 'reviewer' in a)
        drift_main = sum(m['by_agent'].get('main', {}).get('drift', 0) for m in runs)
        drift_sub = sum(d['drift'] for m in runs for a, d in m['by_agent'].items() if a != 'main')
        rep = details.get('model_repeats', 3)
        chance = lambda pred: sum(d['after_bare_cd'] for m in runs for a, d in m['by_agent'].items()  # noqa: E731
                                  if pred(a))
        numbers.update({'m01_runs': f'{len(runs)}/{rep}', 'drift_session': drift_main, 'drift_subagents': drift_sub,
                        'bash_session': sum(m['by_agent'].get('main', {}).get('calls', 0) for m in runs),
                        'bash_subagents': sub_calls, 'bash_reviewer': rev_calls,
                        'after_bare_cd_session': chance(lambda a: a == 'main'),
                        'after_bare_cd_reviewer': chance(lambda a: 'reviewer' in a)})
        reviewer_every_run = all(any('reviewer' in a for a in m['by_agent']) for m in runs)
        if drift_main or drift_sub:
            verdict = 'не прошла'
        elif len(runs) == rep >= 3 and reviewer_every_run:
            verdict = 'прошла'
    save('P1', verdict, numbers or {'runs': 0},
         'M01 × 3: дрейф cwd 0 и у сессии, и у ревьюера (мерить дрейф, а не голый cd; env — в настройках фикстуры)',
         details,
         method='мок (без модели): субагенты general-purpose, Explore и hub:reviewer (плагин ветки) делают cd в '
                'свою папку и pwd, потом сессия pwd (утечка cd субагента) и свой cd/pwd — с переменной и без; '
                'модель: M01 полигона × 3, переменная в .claude/settings.local.json фикстуры, хук-логгер '
                'PreToolUse(Bash) пишет cwd старта каждого вызова и agent_type; after_bare_cd — сколько вызовов '
                'шло после голого cd того же агента (шансов на дрейф)')


if __name__ == '__main__':
    main()
