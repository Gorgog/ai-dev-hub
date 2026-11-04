#!/usr/bin/env python3
"""P5: does `.claude/rules/<topic>.md` with `paths:` load in the hub layout projects/<name>/worktrees/<branch>
(and in projects/<name>/repo) when a matching file is touched? Trace — an InstructionsLoaded hook; cross-check —
the rule's marker in the next request the model gets.

Rules are placed at four levels to see which ones Claude Code finds: inside the repo (committed, so the worktree
has it too), in projects/<name>/ (ancestor of both), in the hub root and in the user's ~/.claude/rules. Passed: the repo-level rule is loaded
on touching src/** — in the worktree and in repo/ — and not on touching a non-matching file."""
import json

from common import claude_version, engines, save, workdir
from sandbox import Sandbox, git, git_repo, hook_logger, read_jsonl

RULE = '---\npaths:\n  - "src/**/*.js"\n---\n# {name}\nRULE-MARKER-{name}: probe rule for src.\n'


def run_in(sb, root, cwd, tag):
    files = {'touch': cwd / 'src' / 'app.js', 'other': cwd / 'docs' / 'notes.md'}
    sc = {'scripts': [
        {'match': f'P5-{tag}-OTHER', 'steps': [{'tool': 'Read', 'input': {'file_path': str(files['other'])}},
                                              {'text': 'read other'}]},
        {'match': f'P5-{tag}-TOUCH', 'steps': [{'tool': 'Read', 'input': {'file_path': str(files['touch'])}},
                                              {'tool': 'Bash', 'input': {'command': 'true', 'description': 'x'}},
                                              {'text': 'read src'}]}]}
    out = {}
    for kind in ('OTHER', 'TOUCH'):  # other first: a rule loaded later can only come from the touch
        mock = root / f'mock-{tag}-{kind}.jsonl'
        sb.start_mock(sc, mock)
        try:
            log0 = len(read_jsonl(root / 'hook.jsonl'))
            r = sb.claude_p(f'P5-{tag}-{kind} read the file', cwd, PROBE_TAG=f'{tag}-{kind}')
        finally:
            sb.stop_mock()
        loads = read_jsonl(root / 'hook.jsonl')[log0:]
        reqs = read_jsonl(mock)
        seen = sorted({n for n in ('repo', 'project', 'hub', 'user') for q in reqs
                       if f'RULE-MARKER-{n}' in json.dumps(q['body'], ensure_ascii=False)})
        out[kind] = {'code': r['code'], 'loads': [{k: l.get(k) for k in ('file_path', 'load_reason', 'memory_type',
                                                                          'trigger_file_path', 'globs')}
                                                  for l in loads],
                     'marker_in_requests': seen, 'stderr': r['stderr'][-300:]}
    return out


def main():
    top = workdir('P5')
    res_all, numbers, ok = {}, {}, True
    for label, binary in engines():
        res, nums, good = one_engine(top / label, binary)
        res_all[label] = {**res, 'engine': claude_version(binary)}
        numbers.update({f'{label}:{k}': v for k, v in nums.items()})
        ok = ok and good
    save('P5', 'прошла' if ok else 'не прошла', numbers,
         'журнал InstructionsLoaded показывает загрузку при касании пути, в worktree и в repo/',
         {'runs': res_all, 'work': str(top)},
         method='в песочнице на двух движках — CLI и встроенный в Desktop; мок API читает src/app.js (и для '
                'контроля docs/notes.md); правило с paths: в repo/.claude/rules, в projects/<имя>/.claude/rules, в '
                'корне хаба и в ~/.claude/rules; след — хук InstructionsLoaded и маркер правила в теле следующего запроса к модели')


def one_engine(root, binary):
    hub = root / 'hub'
    proj = hub / 'projects' / 'demo'
    repo = git_repo(proj / 'repo', {'src/app.js': 'module.exports = 1;\n', 'docs/notes.md': '# notes\n',
                                    '.claude/rules/topic.md': RULE.format(name='repo')})
    wt = proj / 'worktrees' / 'DEMO-1'
    git(repo, 'worktree', 'add', '-q', '-b', 'DEMO-1', str(wt))
    for d, name in ((proj, 'project'), (hub, 'hub')):
        (d / '.claude' / 'rules').mkdir(parents=True, exist_ok=True)
        (d / '.claude' / 'rules' / f'{name}.md').write_text(RULE.format(name=name))
    (root / 'hook.jsonl').unlink(missing_ok=True)
    settings = {'hooks': {'InstructionsLoaded': [{'hooks': [{'type': 'command',
                                                             'command': hook_logger(root / 'hook.jsonl')}]}]}}
    sb = Sandbox(root / 'sb', settings, trust=[wt, repo], binary=binary)
    (sb.config / 'rules').mkdir()
    (sb.config / 'rules' / 'user.md').write_text(RULE.format(name='user'))  # ~/.claude/rules of the sandbox
    res = {'worktree': run_in(sb, root, wt, 'WT'), 'repo': run_in(sb, root, repo, 'REPO')}

    def rule_loaded(r, name):  # the repo-level rule is rules/topic.md, the others are named after their level
        fname = 'topic' if name == 'repo' else name
        return any(f'/rules/{fname}.md' in (l['file_path'] or '') for l in r['loads'])

    numbers, ok = {}, True
    for where, r in res.items():
        on_touch = rule_loaded(r['TOUCH'], 'repo') and not rule_loaded(r['OTHER'], 'repo')
        ok = ok and on_touch and 'repo' in r['TOUCH']['marker_in_requests']
        numbers[where] = ('по касанию' if on_touch else 'нет') + \
            f"; маркер в запросе: {','.join(r['TOUCH']['marker_in_requests']) or '—'}"
        numbers[f'{where}_others'] = ','.join(n for n in ('project', 'hub', 'user')
                                                 if rule_loaded(r['TOUCH'], n) or rule_loaded(r['OTHER'], n)) or 'не грузятся'
    return res, numbers, ok

if __name__ == '__main__':
    main()
