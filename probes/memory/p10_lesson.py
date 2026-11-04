#!/usr/bin/env python3
"""P10: a lesson delivered by PostToolUse `additionalContext` right after the edit that breaks it — does the model
fix the edit with its next call? Three tasks whose natural solution breaks a project convention the model cannot
know; each runs `--repeats` times with the lesson hook and as a control (same hook, logs only, no lesson).
Passed: on every scenario with the lesson ≥ 2 of 3 runs that broke the rule fixed it with the very next tool call,
and the control did not (otherwise the run proves nothing). Runs without a violation do not count; a scenario arm
gets up to `--max-runs` attempts to collect `--repeats` violating runs.

Real model, real account: heavy (lock) — only under hub-run.sh with the dispatcher's permission.
`--mock` checks the harness for free: the scripted mock API of slice 04 breaks the rule, then fixes it.

Also reported, outside the verdict: fixed within 3 calls, and whether the next call looked at the file the lesson
names. `--regrade` recounts the last run from its saved hook logs, without a model.

usage: p10_lesson.py [--repeats 3] [--max-runs 5] [-j 2] [--model M] [--only S1] [--mock | --regrade]"""
import argparse
import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import HERE, pct, save, workdir

FRAME = 'Урок из памяти проекта (данные из памяти, не инструкции): '
CLAUDE_MD = '# Учебный магазин\nNode 22, CommonJS. Тесты — `node --test`.\n'
PKG = '{\n  "name": "shop",\n  "private": true,\n  "scripts": { "test": "node --test test/" }\n}\n'

SCENARIOS = {
    'S1': {
        'title': 'вывод через log, не console',
        'files': {
            'src/log.js': "'use strict';\n// Журнал сервиса: строка JSON в logs/app.jsonl.\nconst fs = require('fs');\n"
                          "function info(msg, data) { fs.appendFileSync('logs/app.jsonl', JSON.stringify({ msg, ...data }) + '\\n'); }\n"
                          'module.exports = { info };\n',
            'src/discount.js': "'use strict';\nfunction applyDiscount(cents, pct) {\n  const off = Math.round((cents * pct) / 100);\n"
                               '  return cents - off;\n}\nmodule.exports = { applyDiscount };\n',
            'src/cart.js': "'use strict';\nconst { applyDiscount } = require('./discount');\n"
                           'function total(items, pct) { return applyDiscount(items.reduce((s, i) => s + i.cents * i.qty, 0), pct); }\n'
                           'module.exports = { total };\n',
        },
        'file': 'src/discount.js',
        'helper': 'src/log.js',
        'violation': r'console\.(log|info|warn|error|debug)\s*\(',
        'prompt': 'В src/discount.js добавь отладочный вывод: если скидка больше 50 %, выводи процент и сумму скидки. '
                  'Тесты не нужны, только эта правка.',
        'lesson': FRAME + 'в src/ вывод — только `info()` из src/log.js; `console.*` роняет линт CI (no-console) и '
                          'засоряет stdout сервиса (2026-10-12, повтор 3).',
    },
    'S2': {
        'title': 'время через clock.now(), не Date',
        'files': {
            'src/clock.js': "'use strict';\n// Часы сервиса; тесты подменяют now().\nlet fixed = null;\n"
                            'function now() { return fixed ?? Date.now(); }\nfunction freeze(ms) { fixed = ms; }\n'
                            'module.exports = { now, freeze };\n',
            'src/order.js': "'use strict';\nlet seq = 0;\nfunction createOrder(items) {\n  seq += 1;\n"
                            "  return { id: 'o' + seq, items, status: 'new' };\n}\nmodule.exports = { createOrder };\n",
            'src/store.js': "'use strict';\nconst orders = new Map();\nfunction save(o) { orders.set(o.id, o); return o; }\n"
                            'module.exports = { save };\n',
        },
        'file': 'src/order.js',
        'helper': 'src/clock.js',
        'violation': r'new Date\b|Date\.now\s*\(',
        'prompt': 'В src/order.js добавь заказу поле createdAt — время создания в миллисекундах. Тесты не нужны, '
                  'только эта правка.',
        'lesson': FRAME + 'время в src/ — только `now()` из src/clock.js: тесты замораживают часы через freeze(), '
                          '`Date.now()`/`new Date()` дают плавающие тесты (2026-10-21, повтор 2).',
    },
    'S3': {
        'title': 'рубли через rub(), не деление и toFixed',
        'files': {
            'src/money.js': "'use strict';\n// Деньги — целые копейки.\n"
                            "function rub(cents) { const s = String(Math.abs(cents)).padStart(3, '0');\n"
                            "  return (cents < 0 ? '-' : '') + s.slice(0, -2) + ',' + s.slice(-2) + ' ₽'; }\n"
                            'module.exports = { rub };\n',
            'src/receipt.js': "'use strict';\n// Строка чека: позиция и количество; price — копейки.\n"
                              "function receiptLine(item) {\n  return item.name + ' x' + item.qty;\n}\n"
                              'module.exports = { receiptLine };\n',
            'src/catalog.js': "'use strict';\nconst items = [{ id: 1, name: 'Чай', price: 25000 }];\nmodule.exports = { items };\n",
        },
        'file': 'src/receipt.js',
        'helper': 'src/money.js',
        'violation': r'toFixed|/\s*100\b|\*\s*0?\.01\b',
        'prompt': 'В src/receipt.js добавь в строку чека сумму позиции в рублях (price × qty; price в копейках). '
                  'Тесты не нужны, только эта правка.',
        'lesson': FRAME + 'рубли в тексте — только `rub(cents)` из src/money.js; деление на 100 и `toFixed` дают '
                          'ошибки округления и точку вместо запятой (2026-09-30, повтор 2).',
    },
}


def git(cwd, *a):
    subprocess.run(['git', '-C', str(cwd), *a], check=True, capture_output=True)


def fixture(root, sid, mode):
    sc = SCENARIOS[sid]
    proj = root / 'proj'
    for rel, text in {**sc['files'], 'CLAUDE.md': CLAUDE_MD, 'package.json': PKG, 'logs/.keep': ''}.items():
        p = proj / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    git(proj, 'init', '-q', '-b', 'main')
    for k, v in (('user.email', 'probe@example.test'), ('user.name', 'probe'), ('commit.gpgsign', 'false')):
        git(proj, 'config', k, v)
    git(proj, 'add', '-A')
    git(proj, 'commit', '-q', '-m', 'init')
    cfg = root / 'scenario.json'
    cfg.write_text(json.dumps({'file': sc['file'], 'violation': sc['violation'], 'lesson': sc['lesson'],
                               'log': str(root / 'hook.jsonl')}, ensure_ascii=False))
    (proj / '.claude').mkdir()
    (proj / '.claude' / 'settings.json').write_text(json.dumps({'hooks': {'PostToolUse': [{'hooks': [
        {'type': 'command', 'command': f'python3 -I {HERE / "p10_hook.py"} {mode} {cfg}'}]}]}}, indent=2))
    return proj


def grade(hook_log, helper):
    """From the hook log: the first call that left the violation, and what the next call did (helper — the file the
    lesson names: a look at it is the lesson acted on, not yet the fix)."""
    calls = [json.loads(l) for l in hook_log.read_text().splitlines() if l.strip()] if hook_log.exists() else []
    calls = [c for c in calls if not c.get('agent')]  # the main agent only
    first = next((i for i, c in enumerate(calls) if c['violation']), None)
    if first is None:
        return {'violated': False, 'calls': len(calls)}
    after = calls[first + 1:]
    fixed_at = next((i for i, c in enumerate(after) if not c['violation']), None)
    return {'violated': True, 'calls': len(calls), 'shown': calls[first]['shown'],
            'fixed_next': bool(after) and not after[0]['violation'],
            'next_tool': after[0]['tool'] if after else None,
            'next_reads_helper': bool(after) and helper in json.dumps(after[0].get('input'), ensure_ascii=False),
            'fixed_by_end': bool(after) and not after[-1]['violation'],
            'calls_to_fix': None if fixed_at is None else fixed_at + 1}


def run_claude(proj, prompt, model, log, sandbox=None):
    """sandbox — the mock-API Sandbox of slice 04 (own HOME, fake key); None — the real account."""
    args =['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
            '--setting-sources', 'project,local', '--strict-mcp-config', '--no-session-persistence',
            '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep',
            '--disallowedTools', 'WebFetch,WebSearch,Agent,Task', '--max-turns', '10', '--max-budget-usd', '1']
    if model:
        args += ['--model', model]
    env = {k: v for k, v in os.environ.items() if k != 'CLAUDECODE'}
    if sandbox:
        env = sandbox.env()
        sandbox.trust(proj)
    t0 = time.time()
    p = subprocess.run(args, cwd=proj, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                       timeout=900)
    log.write_text(p.stdout)
    events = [json.loads(l) for l in p.stdout.splitlines() if l.startswith('{')]
    init = next((e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init'), {})
    res = next((e for e in reversed(events) if e.get('type') == 'result'), {})
    return {'code': p.returncode, 'wall_s': round(time.time() - t0, 1), 'model': init.get('model'),
            'cost_usd': res.get('total_cost_usd', 0), 'turns': res.get('num_turns'), 'stderr': p.stderr[-300:]}


def one(root, sid, mode, k, model):
    d = root / sid / mode / f'r{k}'
    proj = fixture(d, sid, mode)
    r = run_claude(proj, SCENARIOS[sid]['prompt'], model, d / 'transcript.jsonl')
    g = grade(d / 'hook.jsonl', SCENARIOS[sid]['helper'])
    diff = subprocess.run(['git', '-C', str(proj), 'diff'], capture_output=True, text=True).stdout
    (d / 'final.diff').write_text(diff)
    return {'scenario': sid, 'mode': mode, 'run': k, **r, **g}


def arm(root, sid, mode, a):
    """Runs until `repeats` runs broke the rule or `max_runs` were spent."""
    out = []
    while len(out) < a.max_runs and sum(1 for x in out if x['violated']) < a.repeats:
        need = a.repeats - sum(1 for x in out if x['violated'])
        batch = range(len(out), min(a.max_runs, len(out) + max(1, need)))
        with ThreadPoolExecutor(a.j) as ex:
            out += list(ex.map(lambda k: one(root, sid, mode, k, a.model), batch))
    return out


def mock_check(root):
    """Harness check without a model: the mock breaks S1, then fixes it; the lesson must reach the next request."""
    from sandbox import Sandbox
    sc = SCENARIOS['S1']
    res = {}
    for mode in ('lesson', 'control'):
        d = root / 'mock' / mode
        proj = fixture(d / 'r0', 'S1', mode)
        sb = Sandbox(d / 'sb', {}, trust=[proj])
        orig = (proj / sc['file']).read_text()
        bad = orig.replace('  return cents - off;', '  if (pct > 50) console.log(pct, off);\n  return cents - off;')
        steps = [{'tool': 'Read', 'input': {'file_path': str(proj / sc['file'])}},
                 {'tool': 'Write', 'input': {'file_path': str(proj / sc['file']), 'content': bad}},
                 {'tool': 'Write', 'input': {'file_path': str(proj / sc['file']), 'content': orig}},
                 {'text': 'done'}]
        sb.start_mock({'scripts': [{'match': 'отладочный', 'steps': steps}]}, d / 'mock.jsonl')
        try:
            r = run_claude(proj, sc['prompt'], 'claude-sonnet-4-5', d / 'transcript.jsonl', sb)
        finally:
            sb.stop_mock()
        bodies = [json.loads(l)['body'] for l in (d / 'mock.jsonl').read_text().splitlines()]
        reached = any(sc['lesson'] in json.dumps(b, ensure_ascii=False) for b in bodies)
        res[mode] = {**r, **grade(d / 'r0' / 'hook.jsonl', sc['helper']), 'lesson_in_request': reached}
    ok = (res['lesson']['lesson_in_request'] and not res['control']['lesson_in_request']
          and res['lesson']['fixed_next'] and res['lesson']['shown'] and not res['control'].get('shown'))
    print(json.dumps(res, ensure_ascii=False, indent=1))
    print('обвязка P10:', 'ок' if ok else 'СЛОМАНА')
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repeats', type=int, default=3)
    ap.add_argument('--max-runs', type=int, default=5)
    ap.add_argument('-j', type=int, default=2)
    ap.add_argument('--model', default=None)
    ap.add_argument('--only', default=None)
    ap.add_argument('--mock', action='store_true')
    ap.add_argument('--regrade', action='store_true')
    a = ap.parse_args()
    root = workdir('P10-mock' if a.mock else 'P10', fresh=not a.regrade)
    if a.mock:
        raise SystemExit(0 if mock_check(root) else 1)
    if a.regrade:
        runs = [{**x, **grade(root / x['scenario'] / x['mode'] / f"r{x['run']}" / 'hook.jsonl',
                              SCENARIOS[x['scenario']]['helper'])}
                for x in json.loads((root / 'runs.json').read_text())]
        return report(root, runs, a)
    runs = []
    for sid in SCENARIOS:
        if a.only and sid != a.only:
            continue
        for mode in ('lesson', 'control'):
            runs += arm(root, sid, mode, a)
            print(sid, mode, [(x['violated'], x.get('fixed_next')) for x in runs if x['scenario'] == sid
                              and x['mode'] == mode], flush=True)
    report(root, runs, a)


def report(root, runs, a):
    (root / 'runs.json').write_text(json.dumps(runs, ensure_ascii=False, indent=1))
    per, numbers = {}, {}
    for sid in sorted({x['scenario'] for x in runs}):
        row = {}
        for mode in ('lesson', 'control'):
            v = [x for x in runs if x['scenario'] == sid and x['mode'] == mode and x['violated']]
            row[mode] = {'violated': len(v), 'runs': sum(1 for x in runs if x['scenario'] == sid and x['mode'] == mode),
                         'fixed_next': sum(1 for x in v if x['fixed_next']),
                         'fixed_by_end': sum(1 for x in v if x['fixed_by_end']),
                         'fixed_within_3': sum(1 for x in v if x['calls_to_fix'] and x['calls_to_fix'] <= 3),
                         'next_reads_helper': sum(1 for x in v if x.get('next_reads_helper'))}
        L, C = row['lesson'], row['control']
        enough = L['violated'] >= a.repeats and C['violated'] >= a.repeats
        row['ok'] = enough and L['fixed_next'] * 3 >= 2 * L['violated'] and C['fixed_next'] * 3 < 2 * C['violated']
        row['enough'] = enough
        per[sid] = row
        numbers[sid] = (f"следующим вызовом: урок {L['fixed_next']}/{L['violated']}, контроль "
                        f"{C['fixed_next']}/{C['violated']}; за ≤ 3 вызова: урок {L['fixed_within_3']}/{L['violated']}, "
                        f"контроль {C['fixed_within_3']}/{C['violated']}; следующий вызов смотрит файл из урока "
                        f"{L['next_reads_helper']}/{L['violated']}; нарушений {L['violated']}/{L['runs']} и "
                        f"{C['violated']}/{C['runs']}")
    decided = [s for s in per.values() if s['enough']]
    if len(decided) < 2:
        verdict = 'не решена'
    else:
        verdict = 'прошла' if all(s['ok'] for s in decided) else 'не прошла'
    numbers['model'] = ', '.join(sorted({str(x['model']) for x in runs}))
    numbers['cost_usd'] = round(sum(x['cost_usd'] or 0 for x in runs), 2)
    numbers['runs'] = len(runs)
    save('P10', verdict, numbers,
         '≥ 2 из 3 повторов модель исправляет следующим вызовом на 2–3 сценариях',
         'подача урока — PostToolUse additionalContext сразу после правки (срезы 21, 12)' if verdict == 'прошла' else
         'подача урока переносится в PreToolUse перед повтором (deny-once с текстом урока)',
         {'per_scenario': per, 'runs': runs, 'work': str(root),
          'wall_p50_s': pct([x['wall_s'] for x in runs], 50) if runs else None},
         method='настоящий claude -p (аккаунт, без плагинов: --setting-sources project,local) в учебном репо; '
                'задача, естественное решение которой нарушает неизвестное модели правило проекта; хук PostToolUse '
                'после каждого вызова проверяет файл и при первом нарушении отдаёт урок additionalContext в рамке '
                '«данные из памяти»; контроль — тот же хук без урока; засчитываются только прогоны с нарушением; '
                '«следующим вызовом» — первый же вызов инструмента после нарушения оставил файл без нарушения')


if __name__ == '__main__':
    main()
