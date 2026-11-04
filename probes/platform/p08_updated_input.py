#!/usr/bin/env python3
"""P8: PreToolUse `updatedInput` for Bash — do rewritten commands run as rewritten (bug #79321)?
The mock model asks for 10 commands `echo ORIG-n >> orig.txt`; the hook rewrites each to
`echo REWRITTEN-n >> rewritten.txt`. Passed: 10/10 lines in rewritten.txt, none in orig.txt — in every variant
of how the hook answers and in which permission mode the session runs."""
import json
from pathlib import Path

from common import save, workdir
from sandbox import Sandbox, git_repo

N = 10
HOOK = r'''import json,re,sys
d=json.load(sys.stdin)
c=d.get("tool_input",{}).get("command","")
m=re.fullmatch(r"echo ORIG-(\d+) >> orig.txt",c)
if not m: sys.exit(0)
out={"hookEventName":"PreToolUse","updatedInput":{"command":"echo REWRITTEN-%s >> rewritten.txt"%m.group(1)}}
mode=sys.argv[1]
if mode=="allow": out["permissionDecision"]="allow"; out["permissionDecisionReason"]="probe rewrite"
print(json.dumps({"hookSpecificOutput":out}))
'''

VARIANTS = [
    # (name, hook mode, claude permission args)
    ('allow+bypass', 'allow', ['--permission-mode', 'bypassPermissions']),
    ('bare+bypass', 'bare', ['--permission-mode', 'bypassPermissions']),
    ('allow+default', 'allow', ['--permission-mode', 'default']),
    ('bare+allowedTools', 'bare', ['--permission-mode', 'default', '--allowedTools', 'Bash']),
]


def run_variant(root, name, mode, perm):
    proj = git_repo(root / name / 'proj', {'README.md': 'p8\n'})
    hook = root / name / 'rewrite.py'
    hook.write_text(HOOK)
    settings = {'hooks': {'PreToolUse': [{'matcher': 'Bash', 'hooks': [
        {'type': 'command', 'command': f'python3 -I {hook} {mode}'}]}]}}
    sb = Sandbox(root / name / 'sb', settings, trust=[proj])
    steps = [{'tool': 'Bash', 'input': {'command': f'echo ORIG-{i} >> orig.txt', 'description': f'probe {i}'}}
             for i in range(1, N + 1)] + [{'text': 'P8 done'}]
    sb.start_mock({'scripts': [{'match': 'P8-PROBE', 'steps': steps}]}, root / name / 'mock.jsonl')
    try:
        r = sb.claude(['-p', 'P8-PROBE run the commands', '--output-format', 'stream-json', '--verbose',
                       '--model', 'claude-sonnet-4-5', *perm], proj)
    finally:
        sb.stop_mock()
    (root / name / 'transcript.jsonl').write_text(r['stdout'])
    lines = lambda f: (proj / f).read_text().split() if (proj / f).exists() else []  # noqa: E731
    rewritten, orig = lines('rewritten.txt'), lines('orig.txt')
    denied = [e for e in map(json.loads, filter(None, r['stdout'].splitlines()))
              if e.get('type') == 'result'][-1:]
    return {'variant': name, 'rewritten': len(rewritten), 'orig': len(orig), 'exit': r['code'],
            'ok': len(rewritten) == N and not orig and rewritten == [f'REWRITTEN-{i}' for i in range(1, N + 1)],
            'permission_denials': len((denied[0] if denied else {}).get('permission_denials') or []),
            'stderr': r['stderr'][-400:]}


def main():
    root = workdir('P8')
    res = [run_variant(root, *v) for v in VARIANTS]
    for x in res:
        print(json.dumps(x, ensure_ascii=False))
    numbers = {v['variant']: f"{v['rewritten']}/{N}" + (f" (orig {v['orig']})" if v['orig'] else '') for v in res}
    verdict = 'прошла' if all(v['ok'] for v in res) else 'не прошла'
    save('P8', verdict, numbers, '10/10 переписанных команд выполнились как переписаны',
         {'variants': res, 'work': str(root)},
         method='настоящий claude в песочнице, мок API: 10 Bash-вызовов `echo ORIG-n`, хук PreToolUse отдаёт '
                'updatedInput `echo REWRITTEN-n`; 4 варианта (ответ хука с allow / без; режим bypass / default / '
                'allowedTools) — прошла, только если все 4 дали 10/10')


if __name__ == '__main__':
    main()
