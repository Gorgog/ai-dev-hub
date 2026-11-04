#!/usr/bin/env python3
"""P7 (CLI part): does closing an interactive CLI session give SessionEnd, and does a handler finish in 1.5 s?
Interactive `claude` runs in a pseudo-terminal of the sandbox; it is closed three ways — `/exit`, Ctrl+C twice,
terminal hang-up (SIGHUP) — and its SessionEnd hook writes a stub at once and a second line after a delay
(0 / 1.0 / 1.4 / 2.5 s) to find how long a handler may take. The Desktop part (archiving) needs the app —
3 Desktop sessions are opened and archived in ~/hub-data/probes/platform/p7-desktop (hooks there log
events.jsonl); merged by `--desktop <events.jsonl>`."""
import json
import os
import pty
import select
import signal
import subprocess
import sys
import time

from common import save, workdir
from sandbox import Sandbox, git_repo, read_jsonl

HOOK = r'''import json,sys,time,os
d=json.load(sys.stdin); log=sys.argv[1]; delay=float(sys.argv[2])
open(log,"a").write(json.dumps({"phase":"stub","t":time.time(),"reason":d.get("reason"),"sid":d.get("session_id"),"tag":os.environ.get("PROBE_TAG")})+"\n")
time.sleep(delay)
open(log,"a").write(json.dumps({"phase":"after-delay","t":time.time(),"delay":delay,"tag":os.environ.get("PROBE_TAG")})+"\n")
'''
CLOSES = ['exit', 'ctrl-c', 'sighup']
DELAYS = [0, 1.0, 1.4, 2.5]


def drain(fd, secs):
    out, end = b'', time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    return out


def session(sb, proj, how, tag):
    master, slave = pty.openpty()
    env = sb.env(PROBE_TAG=tag, TERM='xterm-256color')
    p = subprocess.Popen(['claude'], cwd=proj, env=env, stdin=slave, stdout=slave, stderr=slave,
                         start_new_session=True)
    os.close(slave)
    screen = drain(master, 8)  # startup, SessionStart
    t_close = time.time()
    if how == 'exit':
        os.write(master, b'/exit')
        screen += drain(master, 1)
        os.write(master, b'\r')
    elif how == 'ctrl-c':
        os.write(master, b'\x03')
        screen += drain(master, 0.5)
        os.write(master, b'\x03')
    elif how == 'sighup':
        os.killpg(p.pid, signal.SIGHUP)
    screen += drain(master, 6)
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
    os.close(master)
    return t_close, p.returncode, screen.decode(errors='replace')[-1500:]


def desktop_result(events):
    """events.jsonl of the Desktop sandbox (p7-desktop/end-hook.py): sessions started vs ended by archiving."""
    started = [e['sid'] for e in events if e['ev'] == 'SessionStart']
    started = list(dict.fromkeys(started))
    ends = {e['sid']: e for e in events if e['ev'] == 'SessionEnd' and e['phase'] == 'stub'}
    late = {e['sid'] for e in events if e['ev'] == 'SessionEnd' and e['phase'] == 'after-1s'}
    got = [s for s in started if s in ends]
    # every archived session must end with the stub; N is reported as is (the plan asked for 3)
    return {'ok': bool(started) and len(got) == len(started),
            'numbers': f'{len(got)}/{len(started)} (причины: ' +
                       ','.join(sorted({ends[s].get('reason') or '—' for s in got})) +
                       f'; дописали после 1 с: {len(late & set(got))})',
            'sessions': started, 'ends': list(ends.values())}


def main():
    root = workdir('P7')
    proj = git_repo(root / 'proj', {'README.md': 'p7\n'})
    hook = root / 'end-hook.py'
    hook.write_text(HOOK)
    log = root / 'end.jsonl'
    log.unlink(missing_ok=True)
    cases = []
    for delay in DELAYS:
        settings = {'hooks': {'SessionEnd': [{'hooks': [{'type': 'command',
                                                         'command': f'python3 -I {hook} {log} {delay}'}]}]}}
        sb = Sandbox(root / f'sb-{delay}', settings, trust=[proj])
        sb.start_mock({'fallback': 'ok'}, root / f'mock-{delay}.jsonl')
        try:
            for how in CLOSES if delay in (0, 1.0) else ['exit']:
                tag = f'{how}-{delay}'
                t_close, code, screen = session(sb, proj, how, tag)
                time.sleep(delay + 1)
                recs = [r for r in read_jsonl(log) if r.get('tag') == tag]
                stub = next((r for r in recs if r['phase'] == 'stub'), None)
                done = next((r for r in recs if r['phase'] == 'after-delay'), None)
                cases.append({'close': how, 'delay': delay, 'exit': code, 'stub': bool(stub),
                              'reason': stub and stub.get('reason'), 'finished': bool(done),
                              'stub_after_close_s': round(stub['t'] - t_close, 2) if stub else None,
                              'screen_tail': screen[-400:]})
        finally:
            sb.stop_mock()
    for c in cases:
        print(json.dumps({k: v for k, v in c.items() if k != 'screen_tail'}, ensure_ascii=False))
    closes = [c for c in cases if c['delay'] == 0]
    got = sum(c['stub'] for c in closes)
    budget = max((c['delay'] for c in cases if c['finished']), default=None)
    numbers = {'cli_closes': f'{got}/{len(closes)} (' + ', '.join(f"{c['close']}:{c['reason'] or '—'}"
                                                                 for c in closes) + ')',
               'handler_finishes_with_delay_s': ', '.join(f"{c['delay']}:{'да' if c['finished'] else 'нет'}"
                                                         for c in cases if c['close'] == 'exit'),
               'desktop_archive': 'не проверено'}
    desktop = None
    if '--desktop' in sys.argv:
        desktop = desktop_result(read_jsonl(sys.argv[sys.argv.index('--desktop') + 1]))
        numbers['desktop_archive'] = desktop['numbers']
    cli_ok = got == len(closes)
    desktop_ok = desktop and desktop.get('ok')
    verdict = 'прошла' if cli_ok and desktop_ok else ('не прошла' if not cli_ok or desktop is not None
                                                       else 'не решена')
    save('P7', verdict, numbers, '3/3 случая — событие пришло, заглушка записана',
         {'cases': cases, 'desktop': desktop, 'handler_budget_s': budget, 'work': str(root)},
         method='CLI: интерактивный claude в pty песочницы, закрытие /exit, Ctrl+C×2, SIGHUP; хук SessionEnd пишет '
                'заглушку сразу и строку после задержки 0/1/1,4/2,5 с. Desktop: 3 сессии в песочнице p7-desktop с хуками SessionStart/SessionEnd, их архивируют')


if __name__ == '__main__':
    main()
