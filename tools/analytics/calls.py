#!/usr/bin/env python3
"""Claude Code session journals -> calls database (SQLite): every tool call with its session, agent, context epoch,
number in the epoch, model and hub version, plus the timeline facts the day metrics stand on.

    python3 tools/analytics/calls.py --journals ~/hub-data/journals --bundle ~/hub-data/bundles/hub.bundle \
        --db ~/hub-data/analytics/calls.db [--glob '*/*.jsonl']

Journals: <journals>/<project dir>/<session>.jsonl - the main thread; <session>/subagents/agent-<id>.jsonl (+ .meta.json
with agentType) - a subagent, subagents/workflows/<run>/agent-<id>.jsonl - a workflow's agent. Epoch: 0 from the start, +1 at each compaction (system/compact_boundary); a subagent
counts its own. Hub version: the first-parent commit of the hub's main in effect at the call's time (commit time);
calls before the first commit have none. Bash commands are read by a shell parser (shell-flags.cjs: cd - the polygon's own).
A dispatcher - a session that ran grant.cjs or loaded the dispatch skill.

Tables (t - unix seconds, ts - the journal's ISO time):
  calls(id, t, ts, session, agent, agent_type, epoch, n, model, hub_version, pdir, tool, cmd, path, is_error, oom,
        bare_cd, push, grant_run)
  sessions(session, pdir, kind, start, end, first_ready)   kind: dispatcher | task | other
  epochs(session, agent, epoch, t, trigger)   starts(session, epoch, bytes) - context brought in at the epoch start
  segments(session, t, cls, min, wait)  - the main thread's time, one class per gap between events (as the 04.11
        speed research: model / tool:<cat> / idle:<what woke it> / ask-human / pause beyond the caps)
  asks(session, t, questions, answer_min)   perms(session, t, source)   stops(session, t, false_block)
  requests(session, t, grant_t, min, template)   reviews(session, t, kind)  - L launch, B hand-back
  usage(session, agent, msg, model, input, output, cache_create, cache_read)   versions(sha, t)   files(path, kind)
Stdlib only. A fork copies its parent's records with their uuids and sessionId: originals go first (by that
sessionId), and a record seen before is not stored again in any table. kind: a probe worktree of the lock (guard-probe…) is no task.
"""
import argparse
import bisect
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime

CAP_IDLE = 60 * 60      # s: a longer idle is pause (night, away)
CAP_TOOL = 3 * 60 * 60  # s: a longer tool run is pause (a hanging permission prompt, a sleeping machine)
CAP_COMPACT = 5 * 60    # s: compaction counts at most this
GRANT_MAX_MIN = 180     # a request answered later than this is not a request -> grant pair

BASH_CATS = [
    ('guard-grant', r'grant\.cjs'),
    ('headroom', r'headroom\.sh'),
    ('wait-loop', r'\bsleep\b|\buntil\b|while .*sleep|\bwait\b\s*$'),
    ('jest-full', r'backend-all-batches|checks.*--full|--full\b'),
    ('jest', r'\bjest\b|test:db|test:seed|e2e\.spec|\.e2e|hub-run\.sh[^|;]*-(jest|e2e|be-|batch|unit)'),
    ('vitest', r'\bvitest\b'),
    ('playwright', r'playwright|proof|shots|screens?hot|\.cjs"?\s*>|snippets/.*\.cjs'),
    ('tsc', r'\btsc\b'),
    ('npm-ci', r'npm ci|npm install|npm i\b'),
    ('kubb', r'\bkubb\b'),
    ('prisma', r'prisma'),
    ('mutants', r'mutant|stryker|мутант'),
    ('lint-format', r'prettier|eslint|\blint\b'),
    ('hub-run-other', r'hub-run\.sh'),
    ('git-rebase', r'git[^|;&]*\b(rebase|merge|cherry-pick|merge-tree)\b'),
    ('git', r'\bgit\b'),
    ('checks', r'checks'),
    ('session-time', r'session-time'),
    ('read-search', r'^\s*(cat|head|tail|sed -n|grep|command grep|rg|ls|find|wc|awk|jq|diff)\b'),
]
BASH_RE = [(n, re.compile(p, re.I | re.M)) for n, p in BASH_CATS]
DISP_KINDS = [
    ('push', r'запушен|пуш сделан|пуш и MR сделаны'),
    ('grant', r'Разрешаю|разрешение (на|выдан)|окно (твоё|тебе|открыто)|грант'),
    ('decision', r'Пользователь:|ответ[ыи]? (на|по)|решени|выбрал|«[АБВГ]»|план .*принят'),
    ('queue', r'очеред|ты \d+-я|обошла|делай л[её]гкое|освободи|жди'),
    ('winddown', r'wind-down'),
    ('brief', r'бриф|EST-START|Задача:|Срез'),
    ('status', r'статус|как дела|жив[аы]?\?|квитанц'),
]
DISP_RE = [(n, re.compile(p, re.I)) for n, p in DISP_KINDS]
REMINDER_RE = re.compile(r'<system-reminder>.*?</system-reminder>\s*', re.S)
READY_RE = re.compile(r'[Гг]отово к пушу')
SHA_RE = re.compile(r'\b[0-9a-f]{7,40}\b')
NOT_READY_RE = re.compile(r'не готово к пушу|до «?готово к пушу')
REPORT_RE = re.compile(r'(?m)^[\s*#>_-]*[Гг]отово к (пушу|мержу)[*_\s]*[:—–(-]')
REQUEST_RE = re.compile(r'Прошу (тяж|сред|стенд|окно|тест|jest|разреш)', re.I)
GRANT_RE = re.compile(r'[Рр]азрешаю')
DISPATCH_SKILL_RE = re.compile(r'(^|:)dispatch$')
# Bash results only: the tool's own «Exit code 137» at the start of the output, or hub-run's report of a kill.
OOM_RE = re.compile(r'\A\s*Exit code 137\b|^hub-run: .*· код 137\b', re.M)
PROBE_RE = re.compile(r'^[A-Z]+-1-\d+$|guard-probe|^x$|^t\d')  # the lock's own probe worktrees and test entries


def bash_cat(cmd):
    for n, r in BASH_RE:
        if r.search(cmd or ''):
            return n
    return 'bash-other'


def tool_cat(name, inp):
    if name in ('Bash', 'PowerShell'):
        return 'bash:' + bash_cat(inp.get('command', ''))
    if name in ('Agent', 'Task'):
        return 'agent:' + str(inp.get('subagent_type') or 'general')
    if name in ('Read', 'Grep', 'Glob'):
        return 'read'
    if name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
        return 'edit'
    if 'Browser' in name or 'claude-in-chrome' in name:
        return 'browser'
    if name in ('AskUserQuestion', 'ExitPlanMode'):
        return 'ask-human'
    if name == 'SendMessage' or name.endswith('send_message'):
        return 'send-message'
    if name in ('Skill', 'ToolSearch'):
        return 'skill-load'
    if name.startswith('mcp__ccd'):
        return 'app-tools'
    if 'gitlab' in name or 'tracker' in name:
        return 'gitlab-tracker'
    if name == 'Monitor':
        return 'monitor'
    return 'other:' + name


def text_of(c):
    if isinstance(c, str):
        return c
    return '\n'.join(b.get('text') or '' for b in c or [] if isinstance(b, dict) and b.get('type') == 'text')


def is_ready(txt):
    """A report «готово к пушу» with a sha, not a mention of it."""
    return bool(txt and READY_RE.search(txt) and SHA_RE.search(txt) and not NOT_READY_RE.search(txt))


def is_report(txt):
    """The report itself: a line that starts with «Готово к пушу:» (stop-hook judging). A status, a plan or a story
    that mentions it - even with a sha nearby - is not; is_ready() stays the 04.11 method for the first-report path."""
    return bool(txt and REPORT_RE.search(txt))


def epoch_s(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()


def classify_trigger(txt):
    """What woke the session after an idle gap; None - transparent (reminders, skill bodies, commands)."""
    txt = REMINDER_RE.sub('', txt).strip()
    if not txt:
        return None, None
    if txt.startswith('<task-notification'):
        m = re.search(r'<tool-use-id>([^<]+)', txt)
        return 'bg-task', (m.group(1) if m else None)
    if 'cross-session-message' in txt:
        m = re.search(r'(?:from-)?name="([^"]*)"', txt)
        name = m.group(1) if m else ''
        body = txt.split('>', 1)[1] if '>' in txt else txt
        if 'испетчер' in name or body.lstrip().startswith('Диспетчер'):
            for n, r in DISP_RE:
                if r.search(body[:600]):
                    return 'dispatcher:' + n, None
            return 'dispatcher:other', None
        return 'session-msg', None
    if '<agent-message' in txt or 'Subagent hand-back' in txt:
        m = re.search(r'agent-message from="([^"]+)"', txt)
        return 'subagent', (m.group(1) if m else None)
    if txt.startswith('Stop hook feedback'):
        return 'stop-hook', None
    if txt.startswith('This session is being continued'):
        return 'compact', None
    if txt.startswith('Base directory for this skill') or txt.startswith('<command-') or txt.startswith('Caveat:'):
        return None, None
    if 'Paused until' in txt:
        return 'app-pause', None
    return 'human', None


def read_jsonl(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if isinstance(o, dict):
                yield o


def hub_versions(bundle):
    """[(commit time, short sha)] of the hub's main, first parent, oldest first; [] without a bundle."""
    if not bundle or not os.path.exists(bundle):
        return []
    with tempfile.TemporaryDirectory() as d:
        env = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C'}
        subprocess.run(['git', 'clone', '-q', '--bare', bundle, d + '/h.git'], check=True, env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        heads = subprocess.run(['git', '-C', d + '/h.git', 'branch', '--list', 'main'], capture_output=True,
                               text=True, env=env).stdout.strip()
        out = subprocess.run(['git', '-C', d + '/h.git', 'log', '--first-parent', '--format=%ct %H',
                              'main' if heads else 'HEAD'], capture_output=True, text=True, check=True, env=env).stdout
    rows = [(int(ct), sha[:7]) for ct, sha in (line.split() for line in out.splitlines() if line.strip())]
    return sorted(rows)


class Session:
    """One main journal: calls, epochs and timeline facts of the main thread."""

    def __init__(self, db, versions, pdir, sid, seen):
        self.db, self.pdir, self.sid, self.seen = db, pdir, sid, seen
        self.vt = [v[0] for v in versions]
        self.vs = [v[1] for v in versions]
        self.bash = []  # (call id, command) for the shell parser
        self.dispatcher = False

    def version(self, t):
        i = bisect.bisect_right(self.vt, t)
        return self.vs[i - 1] if i else None

    def scan(self, path, agent='', agent_type=''):
        """Calls, epochs, context at epoch starts, usage, permissions, stop blocks; returns timeline events.
        A record whose uuid an earlier journal already had (a fork's copied history) moves the epoch and the number
        in it, as it is in the fork's context, but is not stored again."""
        db, sid = self.db, self.sid
        main = agent == ''
        epoch, n, started = 0, 0, False
        start_bytes = {}
        answered = set()  # epochs with an assistant reply: what comes in after it is not the start's context
        names = {}        # tool_use id -> tool name, for its result
        seen_msg = set()
        last_text = ''
        events = []
        for o in read_jsonl(path):
            typ, ts = o.get('type'), o.get('timestamp')
            if not isinstance(ts, str) or not ts:
                continue
            try:
                t = epoch_s(ts)
            except ValueError:
                continue
            uid = o.get('uuid')
            dup = isinstance(uid, str) and uid in self.seen
            if isinstance(uid, str):
                self.seen.add(uid)
            if not started:
                db.execute('insert into epochs values(?,?,?,?,?)', (sid, agent, 0, t, 'start'))
                started = True
            if typ == 'system' and o.get('subtype') == 'compact_boundary':
                epoch, n = epoch + 1, 0
                if not dup:
                    db.execute('insert into epochs values(?,?,?,?,?)', (sid, agent, epoch, t, 'compact'))
                continue
            if typ == 'attachment' and main:
                a = o.get('attachment') or {}
                at = a.get('type')
                if dup:
                    pass
                elif at == 'instructions' and epoch not in answered:
                    size = sum(len(str(f.get('content') or '').encode()) for f in a.get('files') or [] if isinstance(f, dict))
                    start_bytes[epoch] = start_bytes.get(epoch, 0) + size
                elif a.get('hookEvent') == 'SessionStart' and at in ('hook_success', 'hook_additional_context') \
                        and epoch not in answered and not str(a.get('hookName') or '').endswith(':resume'):
                    c = a.get('content')
                    c = '\n'.join(map(str, c)) if isinstance(c, list) else str(c or '')
                    start_bytes[epoch] = start_bytes.get(epoch, 0) + len(c.encode())
                elif at == 'hook_blocking_error' and a.get('hookEvent') == 'Stop':
                    db.execute('insert into stops values(?,?,?)', (sid, t, 0 if is_report(last_text) else 1))
                continue
            if typ not in ('user', 'assistant') or (main and o.get('isSidechain')):
                continue
            msg = o.get('message') or {}
            content = msg.get('content')
            blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
            if typ == 'assistant':
                answered.add(epoch)
                model = msg.get('model')
                u = msg.get('usage')
                mid = msg.get('id') or uid
                if isinstance(u, dict) and mid not in seen_msg and not dup:
                    seen_msg.add(mid)
                    db.execute('insert into usage values(?,?,?,?,?,?,?,?)', (
                        sid, agent, mid, model, u.get('input_tokens') or 0, u.get('output_tokens') or 0,
                        u.get('cache_creation_input_tokens') or 0, u.get('cache_read_input_tokens') or 0))
                txt = text_of(content)
                for b in blocks:
                    if b.get('type') == 'tool_use' and (b.get('name') == 'SendMessage' or str(b.get('name')).endswith('send_message')):
                        txt += '\n' + str((b.get('input') or {}).get('message') or '')
                if txt.strip():
                    last_text = txt
                for b in blocks:
                    if b.get('type') != 'tool_use':
                        continue
                    n += 1
                    name, inp = str(b.get('name') or ''), b.get('input') or {}
                    names[b.get('id')] = name
                    if dup:
                        continue
                    if not isinstance(inp, dict):
                        inp = {}
                    cmd = inp.get('command') if isinstance(inp.get('command'), str) else None
                    p = inp.get('file_path') or inp.get('notebook_path') or inp.get('path')
                    cur = db.execute('insert or ignore into calls values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
                        b.get('id'), t, ts, sid, agent, agent_type, epoch, n, model, self.version(t), self.pdir, name,
                        cmd, p if isinstance(p, str) else None, None, 0, None, None, None))
                    if cur.rowcount and name in ('Bash', 'PowerShell') and cmd is not None:
                        self.bash.append((b.get('id'), cmd))
                    if main and name == 'Skill' and DISPATCH_SKILL_RE.search(str(inp.get('skill') or '')):
                        self.dispatcher = True
            elif not dup:
                for b in blocks:
                    if b.get('type') != 'tool_result':
                        continue
                    out = text_of(b.get('content')) if not isinstance(b.get('content'), str) else b.get('content')
                    oom = names.get(b.get('tool_use_id')) in ('Bash', 'PowerShell') and bool(OOM_RE.search(out or ''))
                    db.execute('update calls set is_error=?, oom=? where id=?',
                               (1 if b.get('is_error') else 0, 1 if oom else 0, b.get('tool_use_id')))
                pd = o.get('permissionDecision')
                if main and isinstance(pd, dict) and str(pd.get('source') or '').startswith('user'):
                    db.execute('insert into perms values(?,?,?)', (sid, t, pd.get('source')))
            if main and not dup:
                events.append((t, len(events), o))
        for e, size in sorted(start_bytes.items()):
            db.execute('insert into starts values(?,?,?)', (sid, e, size))
        return events

    def timeline(self, events):
        """The 04.11 speed method on the main thread: segments, asks, requests, reviews, first report."""
        db, sid = self.db, self.sid
        events.sort(key=lambda e: (e[0], e[1]))
        uses, agents, bg, launched = {}, {}, {}, set()
        prev = None
        ready = False
        waits_for = ''
        first_ready = None
        req = None
        want_template = None
        for t, _, o in events:
            c = (o.get('message') or {}).get('content')
            blocks = [b for b in c if isinstance(b, dict)] if isinstance(c, list) else []
            cls = None
            wait = None
            if o['type'] == 'assistant':
                for b in blocks:
                    if b.get('type') != 'tool_use':
                        continue
                    inp = b.get('input') or {}
                    if not isinstance(inp, dict):
                        inp = {}
                    name = str(b.get('name') or '')
                    cat = tool_cat(name, inp)
                    uses[b.get('id')] = (cat, inp, t)
                    if inp.get('run_in_background') and name in ('Bash', 'PowerShell'):
                        bg[b.get('id')] = cat
                    if (name == 'SendMessage' or name.endswith('send_message')) and req is None \
                            and REQUEST_RE.search(str(inp.get('message') or '')):
                        req = t
                    if want_template is not None and name in ('Bash', 'PowerShell'):
                        db.execute('update requests set template=? where rowid=?', (cat, want_template))
                        want_template = None
                cls = 'model'
                atxt = text_of(c)
                for b in blocks:
                    if b.get('type') == 'tool_use' and (b.get('name') == 'SendMessage' or str(b.get('name')).endswith('send_message')):
                        atxt = (atxt or '') + '\n' + str((b.get('input') or {}).get('message') or '')
                if atxt:
                    m = re.search(r'Ждёт:\s*([^|\n]*)', atxt)
                    if m:
                        waits_for = m.group(1).strip()[:120]
                    if is_ready(atxt):
                        ready = True
                        if first_ready is None:
                            first_ready = t
            else:
                tur = o.get('toolUseResult')
                if isinstance(tur, dict) and tur.get('agentId') and \
                        'review' in (str(tur.get('description', '')) + str(tur.get('prompt', ''))[:200]).lower():
                    launched.add(tur['agentId'])
                    db.execute('insert into reviews values(?,?,?)', (sid, t, 'L'))
                results = [b for b in blocks if b.get('type') == 'tool_result']
                if results:
                    b = results[0]
                    u = uses.get(b.get('tool_use_id'))
                    cat = u[0] if u else 'tool:?'
                    rtxt = text_of(b.get('content')) if not isinstance(b.get('content'), str) else b.get('content')
                    if isinstance(tur, dict) and tur.get('agentId') and u:
                        agents[tur['agentId']] = u[1].get('subagent_type') or 'general'
                    if rtxt and 'Заблокировано замком диспетчера' in rtxt:
                        cat = 'blocked-by-guard'
                    cls = 'ask-human' if cat == 'ask-human' else 'tool:' + cat
                    for r in results:
                        u2 = uses.get(r.get('tool_use_id'))
                        if u2 and u2[0] == 'ask-human' and isinstance(u2[1].get('questions'), list):
                            db.execute('insert into asks values(?,?,?,?)',
                                       (sid, t, len(u2[1]['questions']), (t - u2[2]) / 60))
                else:
                    txt = text_of(c)
                    m = re.search(r'agent-message from="([^"]+)"', txt or '')
                    if m and m.group(1) in launched:
                        db.execute('insert into reviews values(?,?,?)', (sid, t, 'B'))
                    if req is not None and 'cross-session-message' in (txt or '') and GRANT_RE.search(txt):
                        d = (t - req) / 60
                        if d < GRANT_MAX_MIN:
                            cur = db.execute('insert into requests values(?,?,?,?,?)', (sid, req, t, d, None))
                            want_template = cur.lastrowid
                        req = None
                    trig, ref = classify_trigger(txt or '')
                    if trig is None:
                        continue
                    if trig == 'bg-task':
                        trig = 'bg:' + bg.pop(ref).split(':', 1)[-1] if ref in bg else 'bg:?'
                    if trig == 'subagent' and ref in agents:
                        trig = 'subagent:' + agents.pop(ref)
                    cls = ('idle-after-ready:' if ready else 'idle:') + trig
                    wait = waits_for
                    if trig.startswith('dispatcher') or trig == 'human':
                        ready = False
            if prev is not None:
                gap = max(0.0, t - prev)
                cap = None
                if cls.startswith('idle') or cls == 'ask-human' or cls == 'model':
                    cap = CAP_IDLE
                elif cls.startswith('tool:'):
                    cap = CAP_TOOL
                if cls.endswith(':compact'):
                    cap = CAP_COMPACT
                if cap is not None and gap > cap:
                    db.execute('insert into segments values(?,?,?,?,?)', (sid, t, 'pause', (gap - cap) / 60, None))
                    gap = cap
                db.execute('insert into segments values(?,?,?,?,?)', (sid, t, cls, gap / 60, wait))
            prev = t
        start = events[0][0] if events else None
        end = events[-1][0] if events else None
        return start, end, first_ready


SCHEMA = '''
create table calls(id primary key, t, ts, session, agent, agent_type, epoch, n, model, hub_version, pdir, tool, cmd,
                   path, is_error, oom, bare_cd, push, grant_run);
create table sessions(session, pdir, kind, start, end, first_ready);
create table epochs(session, agent, epoch, t, trigger);
create table starts(session, epoch, bytes);
create table segments(session, t, cls, min, wait);
create table asks(session, t, questions, answer_min);
create table perms(session, t, source);
create table stops(session, t, false_block);
create table requests(session, t, grant_t, min, template);
create table reviews(session, t, kind);
create table usage(session, agent, msg, model, input, output, cache_create, cache_read);
create table versions(sha, t);
create table files(path, kind);
'''


SESSION_ID_RE = re.compile(r'"sessionId"\s*:\s*"([^"]+)"')


def head(path):
    """(first timestamp, parent): a fork's records copied from its parent keep their sessionId, so the parent is the
    last sessionId in the journal other than its own (a fork of a fork copies the root's records first, then the
    fork's). Raw lines are enough for the id: the full parse is the scan's job."""
    own = os.path.basename(path)[:-len('.jsonl')]
    t, parent = None, None
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if t is None:
                try:
                    o = json.loads(line)
                    t = epoch_s(o['timestamp']) if isinstance(o, dict) and isinstance(o.get('timestamp'), str) else None
                except (ValueError, KeyError):
                    t = None
            for sid in SESSION_ID_RE.findall(line):
                if sid != own:
                    parent = sid
    return (float('inf') if t is None else t), parent


def journal_order(files):
    """Originals before their forks (fork depth by the copied sessionId), then by first time, then by path."""
    info = {f: head(f) for f in files}
    by_sid = {os.path.basename(f)[:-len('.jsonl')]: f for f in files}

    def depth(f):
        seen = {f}
        n = 0
        while True:
            parent = by_sid.get(info[f][1])
            if parent is None or parent in seen:
                return n
            seen.add(parent)
            f, n = parent, n + 1
    return sorted(files, key=lambda f: (depth(f), info[f][0], f))


def shell_flags(cmds):
    """bare_cd (the polygon's shell parser) and push (a git push simple command) per command."""
    if not cmds:
        return []
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shell-flags.cjs')
    out = subprocess.run(['node', helper], input=json.dumps(cmds), capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def build(journals, db_path, bundle=None, pattern='*/*.jsonl'):
    """Rebuild the database from the journals; returns the copy counts."""
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    tmp = db_path + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.execute('pragma journal_mode=off')
    db.executescript(SCHEMA)
    versions = hub_versions(bundle)
    db.executemany('insert into versions values(?,?)', [(sha, t) for t, sha in versions])
    root = os.path.expanduser(journals)
    mains = journal_order(glob.glob(os.path.join(root, pattern)))
    bash = []
    seen = set()
    for f in mains:
        pdir = os.path.basename(os.path.dirname(f))
        sid = os.path.basename(f)[:-len('.jsonl')]
        s = Session(db, versions, pdir, sid, seen)
        db.execute('insert into files values(?,?)', (os.path.relpath(f, root), 'main'))
        events = s.scan(f)
        start, end, first_ready = s.timeline(events)
        for af in sorted(glob.glob(os.path.join(f[:-len('.jsonl')], 'subagents', '**', 'agent-*.jsonl'), recursive=True)):
            agent = os.path.basename(af)[len('agent-'):-len('.jsonl')]
            meta = af[:-len('.jsonl')] + '.meta.json'
            try:
                agent_type = json.load(open(meta, encoding='utf-8')).get('agentType') or ''
            except (OSError, ValueError, AttributeError):
                agent_type = ''
            db.execute('insert into files values(?,?)', (os.path.relpath(af, root), 'subagent'))
            s.scan(af, agent, agent_type)
        worktree = pdir.split('-worktrees-', 1)[1] if '-worktrees-' in pdir else None
        kind = 'dispatcher' if s.dispatcher else ('task' if worktree and not PROBE_RE.search(worktree) else 'other')
        db.execute('insert into sessions values(?,?,?,?,?,?)', (sid, pdir, kind, start, end, first_ready))
        bash += s.bash
    flags = shell_flags([c for _, c in bash])
    db.executemany('update calls set bare_cd=?, push=?, grant_run=? where id=?',
                   [(fl['bare_cd'], fl['push'], fl['grant'], i) for (i, _), fl in zip(bash, flags)])
    # A dispatcher ran the lock's grant.cjs (shell-parsed) or loaded the dispatch skill.
    db.execute("update sessions set kind='dispatcher' where session in "
               "(select session from calls where agent='' and grant_run=1)")
    db.commit()
    counts = copy_counts(db)
    db.close()
    os.replace(tmp, db_path)
    return counts


def copy_counts(db):
    one = lambda q: db.execute(q).fetchone()[0]
    return {
        'files': one('select count(*) from files'),
        'sessions': one("select count(*) from files where kind='main'"),
        'calls': one('select count(*) from calls'),
        'epochs': one("select count(*) from epochs where agent=''"),
        'compactions': one("select count(*) from epochs where agent='' and trigger='compact'"),
        'subagents': one("select count(*) from files where kind='subagent'"),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--journals', required=True)
    ap.add_argument('--db', required=True)
    ap.add_argument('--bundle')
    ap.add_argument('--glob', default='*/*.jsonl', help='main journals under --journals')
    a = ap.parse_args()
    print(json.dumps(build(a.journals, a.db, a.bundle, a.glob), sort_keys=True))


if __name__ == '__main__':
    sys.exit(main())
