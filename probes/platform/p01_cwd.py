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
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import DATA, save, workdir
from sandbox import Sandbox, git_repo, hook_logger, read_jsonl

ENV = 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR'
HERE = Path(__file__).resolve().parent


def cd_pwd(tag):
    return [{'tool': 'Bash', 'input': {'command': 'cd sub', 'description': f'{tag} cd'}},
            {'tool': 'Bash', 'input': {'command': 'pwd', 'description': f'{tag} pwd'}}]


def mock_run(root, keep):
    name = 'keep' if keep else 'nokeep'
    shutil.rmtree(root / name, ignore_errors=True)
    proj = git_repo(root / name / 'proj', {'sub/README.md': 'x\n', 'README.md': 'p1\n'})
    log = root / name / 'hook.jsonl'
    log.unlink(missing_ok=True)
    settings = {'hooks': {'PreToolUse': [{'matcher': 'Bash', 'hooks': [
        {'type': 'command', 'command': hook_logger(log)}]}]}}
    if keep:
        settings['env'] = {ENV: '1'}
    sb = Sandbox(root / name / 'sb', settings, trust=[proj])
    agent = lambda t, p: {'tool': 'Agent', 'input': {'subagent_type': t, 'description': p,  # noqa: E731
                                                     'prompt': f'{p} run cd then pwd'}}
    sb.start_mock({'scripts': [
        {'match': 'P1-MAIN', 'steps': cd_pwd('main') + [agent('general-purpose', 'P1-SUB-GP'),
                                                         agent('Explore', 'P1-SUB-EX'),
                                                         {'tool': 'Bash', 'input': {'command': 'pwd',
                                                                                    'description': 'main pwd 2'}},
                                                         {'text': 'P1 done'}]},
        {'match': 'P1-SUB-GP', 'steps': cd_pwd('gp') + [{'text': 'gp done'}]},
        {'match': 'P1-SUB-EX', 'steps': cd_pwd('ex') + [{'text': 'ex done'}]}]}, root / name / 'mock.jsonl')
    try:
        r = sb.claude_p('P1-MAIN go', proj)
    finally:
        sb.stop_mock()
    (root / name / 'transcript.jsonl').write_text(r['stdout'])
    uses, results = {}, {}
    for e in r['events']:
        for b in (e.get('message') or {}).get('content') or []:
            if not isinstance(b, dict):
                continue
            if b.get('type') == 'tool_use' and b.get('name') == 'Bash':
                uses[b['id']] = (b['input'].get('description', ''), e.get('parent_tool_use_id'))
            if b.get('type') == 'tool_result' and b.get('tool_use_id') in uses:
                c = b.get('content')
                results[b['tool_use_id']] = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c or [])
    pwds = {uses[i][0]: results.get(i, '').strip() for i in uses if uses[i][0].endswith('pwd') or 'pwd' in uses[i][0]}
    drift = {k: v != str(proj) for k, v in pwds.items()}
    hooks = read_jsonl(log)
    hook_cwd_drift = sum(1 for h in hooks if h.get('cwd') != str(proj))
    return {'keep': keep, 'code': r['code'], 'pwd': pwds, 'drift': drift, 'hook_calls': len(hooks),
            'hook_cwd_off_project': hook_cwd_drift,
            'hook_cwds': [(h.get('agent_id') or 'main', h.get('cwd'), (h.get('tool_input') or {}).get('command'))
                          for h in hooks]}


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
        hooks = read_jsonl(res['hookLog'])
        proj = res['cwd']
        by_agent = {}
        for h in hooks:
            a = h.get('agent_type') or ('main' if not h.get('agent_id') else 'subagent')
            d = by_agent.setdefault(a, {'calls': 0, 'drift': 0, 'examples': []})
            d['calls'] += 1
            if os.path.realpath(h.get('cwd') or '') != os.path.realpath(proj):
                d['drift'] += 1
                d['examples'].append([h.get('cwd'), (h.get('tool_input') or {}).get('command', '')[:80]])
        out.append({'run': n, 'by_agent': by_agent, 'checks': res['checks'], 'agents': res['agents'],
                    'cost': res['cost'], 'turns': res['turns'], 'transcript': res['transcript']})
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
        for m in details['model']:
            print(json.dumps({k: m.get(k) for k in ('run', 'by_agent', 'agents', 'cost', 'error')},
                             ensure_ascii=False))
    numbers = {}
    for m in details.get('mock', []):
        numbers[f"mock_{'env' if m['keep'] else 'no_env'}_drift"] = \
            ','.join(f"{k.replace(' pwd', '').replace(' ', '')}:{int(v)}" for k, v in m['drift'].items())
    runs = [m for m in details.get('model', []) if 'by_agent' in m]
    verdict = 'не решена'
    if runs:
        sub_calls = sum(d['calls'] for m in runs for a, d in m['by_agent'].items() if a != 'main')
        rev_calls = sum(d['calls'] for m in runs for a, d in m['by_agent'].items() if 'reviewer' in a)
        drift_main = sum(m['by_agent'].get('main', {}).get('drift', 0) for m in runs)
        drift_sub = sum(d['drift'] for m in runs for a, d in m['by_agent'].items() if a != 'main')
        numbers.update({'m01_runs': f'{len(runs)}/3', 'drift_session': drift_main, 'drift_subagents': drift_sub,
                        'bash_session': sum(m['by_agent'].get('main', {}).get('calls', 0) for m in runs),
                        'bash_subagents': sub_calls, 'bash_reviewer': rev_calls})
        if drift_main or drift_sub:
            verdict = 'не прошла'
        elif len(runs) == 3 and rev_calls:
            verdict = 'прошла'
    save('P1', verdict, numbers or {'runs': 0},
         'M01 × 3: дрейф cwd 0 и у сессии, и у ревьюера (мерить дрейф, а не голый cd; env — в настройках фикстуры)',
         details,
         method='мок (без модели): cd sub → pwd у сессии и у субагентов general-purpose/Explore, с переменной и '
                'без; модель: M01 полигона × 3, переменная в .claude/settings.local.json фикстуры, хук-логгер '
                'PreToolUse(Bash) пишет cwd старта каждого вызова и agent_type')


if __name__ == '__main__':
    main()
