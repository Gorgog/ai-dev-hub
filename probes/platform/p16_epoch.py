#!/usr/bin/env python3
"""P16: an epoch-of-context counter kept by a hook in a file, keyed by (session_id, agent_id) — does it survive
compaction and `resume` and agree with the transcript?

Hook rule under test (what slice 08/12 would do): SessionStart startup|clear|compact → epoch + 1 for
(session, main); resume → unchanged; SubagentStart → (session, agent_id) = 1. Every PreToolUse logs the epoch it
sees with tool_use_id. Truth: the transcript — epoch of a main-thread tool call = 1 + compact boundaries before
it; of a subagent call = 1 (+ its own boundaries). Passed: every logged call agrees, on 3 sessions with compaction.

Sessions (mock API; compaction — `/compact` between resumes: the mock cannot make Claude Code auto-compact,
a reported 990k-token context is ignored by the engine):
  A: calls, /compact, resume, calls;
  B: /compact twice between resumes;
  C: a subagent before and another after a compaction of the main thread.
Auto-compaction is checked on the real journals instead (`real_sessions`, counts only): every compact_boundary of a
session that has SessionStart hooks must be followed by SessionStart:compact before the next boundary, and none
without one — so «epoch + 1 on SessionStart compact» holds for auto compaction too."""
import json
import os
from pathlib import Path

from common import save, workdir
from sandbox import Sandbox, git_repo, read_jsonl

HOOK = r'''import json,os,sys,fcntl
d=json.load(sys.stdin); ev=d.get("hook_event_name"); sid=d.get("session_id"); aid=d.get("agent_id") or "main"
st=sys.argv[1]; log=sys.argv[2]
with open(st+".lock","a") as lk:
    fcntl.flock(lk,fcntl.LOCK_EX)
    s=json.load(open(st)) if os.path.exists(st) else {}
    k=sid+"|"+aid
    if ev=="SessionStart":
        src=d.get("source")
        if src=="resume": s.setdefault(k,1)
        else: s[k]=s.get(k,0)+1
    elif ev=="SubagentStart":
        s[sid+"|"+d.get("agent_id","?")]=1
    json.dump(s,open(st,"w"))
    rec={"ev":ev,"sid":sid,"aid":aid,"source":d.get("source"),"trigger":d.get("trigger"),
         "tool_use_id":d.get("tool_use_id"),"epoch":s.get(k),"agent_type":d.get("agent_type"),
         "cmd":(d.get("tool_input") or {}).get("command")}
    open(log,"a").write(json.dumps(rec)+"\n")
'''

def bash(tag):
    return {'tool': 'Bash', 'input': {'command': f'echo {tag}', 'description': tag}}


def scenario():
    after = [bash(f'after-compact-{i}') for i in range(3)] + [{'text': 'P16 continued'}]
    return {
        'compact': '<summary>P16-SUMMARY earlier probe calls ran.</summary>',
        'scripts': [
            {'match': 'P16-SUMMARY', 'steps': after},
            {'match': 'P16-A1', 'steps': [bash('a1-0'), bash('a1-1'), bash('a1-2'), {'text': 'a1 done'}]},
            {'match': 'P16-A2', 'steps': [bash('a2-0'), bash('a2-1'), {'text': 'a2 done'}]},
            {'match': 'P16-B1', 'steps': [bash('b1-0'), bash('b1-1'), {'text': 'b1 done'}]},
            {'match': 'P16-B2', 'steps': [bash('b2-0'), {'text': 'b2 done'}]},
            {'match': 'P16-B3', 'steps': [bash('b3-0'), bash('b3-1'), {'text': 'b3 done'}]},
            {'match': 'P16-C1', 'steps': [bash('c1-0'),
                                          {'tool': 'Agent', 'input': {'subagent_type': 'general-purpose',
                                                                      'description': 'probe sub',
                                                                      'prompt': 'P16-SUB run two commands'}},
                                          bash('c1-1'), {'text': 'c1 done'}]},
            {'match': 'P16-SUB', 'steps': [bash('sub-0'), bash('sub-1'), {'text': 'sub done'}]},
            {'match': 'P16-C2', 'steps': [bash('c2-0'),
                                          {'tool': 'Agent', 'input': {'subagent_type': 'general-purpose',
                                                                      'description': 'probe sub 2',
                                                                      'prompt': 'P16-SUB run again'}},
                                          bash('c2-1'), {'text': 'c2 done'}]},
        ]}


def transcript_epochs(config, sid):
    """{tool_use_id: (agent, epoch)} from the stored transcripts of session sid (main + subagents)."""
    out = {}
    files = list(config.glob(f'projects/*/{sid}.jsonl'))
    files += list(config.glob(f'projects/*/{sid}/subagents/*.jsonl'))
    for f in files:
        epoch = 1
        agent = 'main' if f.name == f'{sid}.jsonl' else f.stem
        for e in read_jsonl(f):
            if e.get('type') == 'system' and e.get('subtype') == 'compact_boundary':
                epoch += 1
            msg = e.get('message') or {}
            if e.get('type') == 'assistant' and isinstance(msg.get('content'), list):
                for b in msg['content']:
                    if b.get('type') == 'tool_use':
                        out[b['id']] = (agent, epoch)
    return out, [str(f) for f in files]


def real_sessions(projects=Path.home() / '.claude' / 'projects'):
    """Auto compaction on real journals: per session with SessionStart hooks, boundaries vs SessionStart:compact."""
    out = {'sessions': 0, 'boundaries': 0, 'auto': 0, 'followed': 0, 'stray_starts': 0, 'max_per_session': 0}
    for f in projects.glob('*/*.jsonl'):
        seq, auto, hooked = [], 0, False
        with open(f, errors='replace') as fh:
            for line in fh:
                if 'SessionStart:' in line:
                    hooked = True
                if 'compact_boundary' not in line and 'SessionStart:compact' not in line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get('subtype') == 'compact_boundary':
                    seq.append('B')
                    auto += (e.get('compactMetadata') or {}).get('trigger') == 'auto'
                elif 'SessionStart:compact' in line and seq:
                    seq.append('S')
                elif 'SessionStart:compact' in line:
                    out['stray_starts'] += 1
        if not hooked or 'B' not in seq:
            continue
        chunks = ''.join(seq).split('B')[1:]
        out['sessions'] += 1
        out['boundaries'] += len(chunks)
        out['auto'] += auto
        out['followed'] += sum(1 for c in chunks if c.startswith('S'))
        out['max_per_session'] = max(out['max_per_session'], len(chunks))
    return out


def main():
    root = workdir('P16')
    proj = git_repo(root / 'proj', {'README.md': 'p16\n'})
    hook = root / 'epoch-hook.py'
    hook.write_text(HOOK)
    state, log = root / 'epochs.json', root / 'hook.jsonl'
    for f in (state, log):
        f.unlink(missing_ok=True)
    cmd = f'python3 -I {hook} {state} {log}'
    events = ['SessionStart', 'SubagentStart', 'PreToolUse', 'PreCompact']
    settings = {'hooks': {ev: [{'hooks': [{'type': 'command', 'command': cmd}]}] for ev in events}}
    sb = Sandbox(root / 'sb', settings, trust=[proj])
    sb.start_mock(scenario(), root / 'mock.jsonl')
    runs = []

    def p(prompt, resume=None):
        extra = ['--resume', resume] if resume else []
        r = sb.claude_p(prompt, proj, extra)
        init = next((e for e in r['events'] if e.get('subtype') == 'init'), {})
        runs.append({'prompt': prompt, 'code': r['code'], 'session_id': init.get('session_id'),
                     'stderr': r['stderr'][-300:]})
        return init.get('session_id')

    try:
        a = p('P16-A1 work')
        p('/compact', a)
        p('P16-A2 more', a)
        b = p('P16-B1 work')
        p('/compact', b)
        p('P16-B2 more', b)
        p('/compact', b)
        p('P16-B3 more', b)
        c = p('P16-C1 work')
        p('/compact', c)
        p('P16-C2 more', c)
    finally:
        sb.stop_mock()

    hooklog = read_jsonl(log)
    sessions = {}
    for name, sid in (('A', a), ('B', b), ('C', c)):
        truth, files = transcript_epochs(sb.config, sid)
        calls = [h for h in hooklog if h['ev'] == 'PreToolUse' and h['sid'] == sid]
        agree = [h for h in calls if h['tool_use_id'] in truth and truth[h['tool_use_id']][1] == h['epoch']]
        boundaries = max((t[1] for t in truth.values() if t[0] == 'main'), default=1) - 1
        starts = [(h['source'], h['epoch']) for h in hooklog if h['ev'] == 'SessionStart' and h['sid'] == sid]
        subs = sorted({h['aid'] for h in calls if h['aid'] != 'main'})
        sessions[name] = {'sid': sid, 'calls': len(calls), 'agree': len(agree), 'in_transcript': len(truth),
                          'compactions': boundaries, 'session_starts': starts, 'subagents': subs,
                          'transcripts': files,
                          'disagree': [h for h in calls if h not in agree][:5]}
    real = real_sessions() if os.environ.get('P16_REAL', '1') == '1' else None
    ok = all(s['calls'] and s['agree'] == s['calls'] == s['in_transcript'] and s['compactions'] >= 1
             for s in sessions.values()) and (real is None or real['followed'] == real['boundaries'] > 0)
    numbers = {k: f"{s['agree']}/{s['calls']} (компакций {s['compactions']})" for k, s in sessions.items()}
    if real:
        numbers['real_auto'] = (f"{real['followed']}/{real['boundaries']} границ с SessionStart:compact, "
                                f"{real['sessions']} сессий, авто {real['auto']}, до {real['max_per_session']} на сессию")
    numbers['resume_same_sid'] = all(len({r['session_id'] for r in runs if r['session_id'] == s['sid']}) == 1
                                      for s in sessions.values())
    save('P16', 'прошла' if ok else 'не прошла', numbers,
         'на 3 длинных сессиях с компакцией — совпадение границ эпох с транскриптом',
         {'sessions': sessions, 'runs': runs, 'real_sessions': real, 'work': str(root)},
         method='настоящий claude в песочнице, мок API, /compact между resume (3 сессии, одна с субагентами до и '
                'после компакции); хук ведёт эпоху в файле по (session_id, agent_id), сверка — по tool_use_id с '
                'compact_boundary в сохранённом транскрипте; авто-компакция — по реальным журналам ~/.claude/projects '
                '(только счётчики): за каждой границей — SessionStart:compact')


if __name__ == '__main__':
    main()
