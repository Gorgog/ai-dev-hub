#!/usr/bin/env python3
"""P13: does Claude Code's Edit refuse when the file changed after this session's Read (optimistic locking)?
Session A reads a lesson, then its change is held back by the mock; meanwhile session B (another real `claude`)
reads and edits the same file; then A's change runs. Variants:
  edit-other  A: Edit of one line, B: Edit of another line — the main case of the criterion;
  edit-same   A and B change the same line;
  write       A: Write of the whole file from its stale read, B: Edit of another line;
  external    as edit-other, but a plain process writes instead of B.
Outcome of A's call: refused (error asking to read again), not-found (error: old_string gone), merged (applied,
B's change kept), lost-b (applied, B's change gone).
Passed: edit-other 3/3 per engine — refused. Mock API of slice 04: no model, no account.

usage: p13_edit_stale.py [--repeats 3]"""
import argparse
import json
import threading
import time

from common import platform_common, save, workdir
from sandbox import Sandbox, git_repo, read_jsonl

claude_version, engines = platform_common().claude_version, platform_common().engines

LESSON = ('---\nid: L0042\nkind: rule\nstatus: active\n---\n'
          'Текст с бэктиками — Edit/Write, не heredoc.\nПовторов: 1\n')
B_OTHER = ('не heredoc.', 'не heredoc и не `node -e`.')
B_SAME = ('Повторов: 1', 'Повторов: 5')
VARIANTS = {'edit-other': ('edit', B_OTHER, 'session'), 'edit-same': ('edit', B_SAME, 'session'),
            'write': ('write', B_OTHER, 'session'), 'external': ('edit', B_OTHER, 'external')}


def session(root, name, proj, steps, marker, binary):
    sb = Sandbox(root / name, {}, trust=[proj], binary=binary)
    sb.start_mock({'scripts': [{'match': marker, 'steps': steps}]}, root / f'{name}-mock.jsonl')
    return sb


def tool_results(res):
    return [b for e in res['events'] if e.get('type') == 'user'
            for b in (e['message'].get('content') or []) if isinstance(b, dict) and b.get('type') == 'tool_result']


def outcome(result, final, b_new):
    text = json.dumps(result.get('content'), ensure_ascii=False).lower()
    if result.get('is_error'):
        return 'refused' if 'read' in text and ('modified' in text or 'changed' in text) else 'not-found' \
            if 'not found' in text else 'error'
    return 'merged' if b_new in final else 'lost-b'


def run_case(root, variant, binary):
    a_tool, (b_old, b_new), writer = VARIANTS[variant]
    proj = git_repo(root / 'proj', {'memory/lessons/L0042.md': LESSON})
    f = proj / 'memory' / 'lessons' / 'L0042.md'
    a_change = ({'tool': 'Edit', 'input': {'file_path': str(f), 'old_string': 'Повторов: 1',
                                           'new_string': 'Повторов: 2'}} if a_tool == 'edit' else
                {'tool': 'Write', 'input': {'file_path': str(f), 'content': LESSON.replace('Повторов: 1',
                                                                                          'Повторов: 2')}})
    a = session(root, 'A', proj, [{'tool': 'Read', 'input': {'file_path': str(f)}}, {**a_change, 'delay': 6},
                                  {'text': 'A done'}], 'P13-A', binary)
    out = {}
    t = threading.Thread(target=lambda: out.update(a=a.claude_p('P13-A правка урока', proj)))
    t.start()
    t0 = time.time()
    while time.time() - t0 < 60 and not any(e.get('step') == 1 for e in read_jsonl(root / 'A-mock.jsonl')):
        time.sleep(0.1)  # A has read the file; its change is now held by the mock's delay
    b_res = None
    if writer == 'session':
        b = session(root, 'B', proj, [{'tool': 'Read', 'input': {'file_path': str(f)}},
                                      {'tool': 'Edit', 'input': {'file_path': str(f), 'old_string': b_old,
                                                                 'new_string': b_new}},
                                      {'text': 'B done'}], 'P13-B', binary)
        try:
            b_res = b.claude_p('P13-B правка урока', proj)
        finally:
            b.stop_mock()
    else:
        f.write_text(f.read_text().replace(b_old, b_new))
    t.join()
    a.stop_mock()
    res = tool_results(out['a'])
    a_result = res[1] if len(res) > 1 else {}
    final = f.read_text()
    b_ok = b_res is None or any(not r.get('is_error') for r in tool_results(b_res)[1:2])
    return {'variant': variant, 'outcome': outcome(a_result, final, b_new), 'b_edit_ok': b_ok,
            'a_result': json.dumps(a_result.get('content'), ensure_ascii=False)[:400], 'final': final}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repeats', type=int, default=3)
    a = ap.parse_args()
    root = workdir('P13')
    cases = []
    for label, binary in engines():
        for variant in VARIANTS:
            for k in range(a.repeats):
                r = run_case(root / label / variant / f'r{k}', variant, binary)
                cases.append({**r, 'engine': label, 'version': claude_version(binary), 'run': k})
                print(json.dumps({x: cases[-1][x] for x in ('engine', 'variant', 'outcome', 'b_edit_ok')}))
    numbers = {}
    for label, _ in engines():
        for variant in VARIANTS:
            c = [x for x in cases if x['engine'] == label and x['variant'] == variant]
            counts = {}
            for x in c:
                counts[x['outcome']] = counts.get(x['outcome'], 0) + 1
            numbers[f'{label}:{variant}'] = ', '.join(f'{k} {v}/{len(c)}' for k, v in sorted(counts.items()))
    numbers['claude'] = ', '.join(sorted({x['version'] for x in cases}))
    main_cases = [x for x in cases if x['variant'] == 'edit-other']
    passed = all(x['outcome'] == 'refused' and x['b_edit_ok'] for x in main_cases)
    save('P13', 'прошла' if passed else 'не прошла', numbers,
         '3/3 — отказ с просьбой перечитать',
         'правка урока двумя сессиями — обычный Edit: он сам отказывает на устаревшем Read (срез 14)' if passed else
         'правка урока — через операцию библиотеки с проверкой mtime',
         {'cases': cases, 'work': str(root)},
         method='настоящий claude в песочнице, мок API: сессия A читает урок, её правку мок держит 6 с; за это '
                'время сессия B (второй claude) читает и правит тот же файл (external — обычный процесс); затем '
                'правка A; исход — отказ с просьбой перечитать / old_string не найден / применено со слиянием / '
                'применено с потерей правки B; движки CLI и встроенный в Desktop')


if __name__ == '__main__':
    main()
