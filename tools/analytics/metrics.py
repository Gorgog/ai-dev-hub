#!/usr/bin/env python3
"""Day metrics of acceptance §3 from the calls database (calls.py), the project memory and the lock journals.

    python3 tools/analytics/metrics.py --db ~/hub-data/analytics/calls.db --hub-projects ~/hub-data/hub/projects \
        [--metric NAME] [--since DATE] [--until DATE] [--from-version SHA] [--to-version SHA]

Window: --since / --until - a date (UTC midnight) or an ISO time; --from-version SHA - from the moment that hub
commit became main's, --to-version SHA - before it (a version is a time span of main, so "before / after a release"
is two windows of one script). Without a window - the whole copy. Each metric: value, its details, how it is counted
(`how`) and the command that recomputes it. Memory metrics are of the snapshot as a whole: the window does not apply.
Task sessions - journals of worktree folders; dispatchers - sessions that ran grant.cjs or the dispatch skill.
"""
import argparse
import glob
import json
import os
import re
import shlex
import sqlite3
import statistics as st
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from calls import PROBE_RE  # noqa: E402

# agg2.py of the 04.11 research: what an idle session waited for, by its last «Ждёт: …» line. Sessions name the user
# in it: --user-re (or <data>/analytics/user.json) adds a first rule, so the name is in the copy, not in the code.
WAIT_RULES = [
    ('resource', r'тяж[её]л|средн|окн[оа]|стенд|разреш|очеред|слот|тест-?БД|тестов\w* БД|освобо|jest для|Docker'),
    ('user', r'[Пп]ользовател|решени|ответ|развилк|вопрос|слов[ао]|одобрен|согласи|выбор|макет'),
    ('merge-seq', r'мерж|ребейз|после мержа|сигнал|бриф|старт|волн|int\b|итоги проверки|проб[аы] волны'),
    ('review', r'ревью|ревьюер'),
    ('background', r'прогон|парти|jest|фон|мутант|окончани|vitest|e2e|checks|tsc|npm ci|субагент|разведчик'),
    ('senior', r'сеньор|замечани'),
    ('push', r'пуш|MR'),
    ('parked', r'^\s*(—|-|ничего|нет)\s*$'),
]
# guardlog.py of the 04.11 research: a lock block on a command that runs nothing heavy.
FALSE_BLOCK_RE = re.compile(r'^\s*(ls|cat|grep|command grep|head|tail|echo|git (commit|log|show|diff|status)|node --check'
                            r'|sed -n)|cat >>|<<.?EOF')
REPEAT_RE = re.compile(r'повтор\w*:\s*(\d+)')
DATE_RE = re.compile(r'\((20\d\d-\d\d-\d\d)\b')  # an entry's own stamp «(2026-10-03, …»; dates in lesson text are not
MEMORY_TEXT = ('.md', '.json', '.jsonl', '.log', '.txt')  # memory proper; shots and attachments are binary by nature
SELF_REPEAT_RE = re.compile(r'\(повтор|повторил', re.I)
KB = 1024


def to_t(s):
    """A date or an ISO time -> unix seconds (UTC when no offset)."""
    d = datetime.fromisoformat(s.replace('Z', '+00:00'))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def valid_date(s):
    """A YYYY-MM-DD that is a real date, else None (memory text holds examples like 2025-02-30)."""
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def r1(x):
    return None if x is None else round(x, 1)


def med(xs):
    return r1(st.median(xs)) if xs else None


def wait_kind(w, cls, rules=WAIT_RULES):
    if 'subagent' in cls:
        return 'review' if 'review' in cls else 'subagent'
    if ':bg:' in cls:
        return 'background'
    if cls.endswith(':compact'):
        return 'compact'
    if cls.endswith(':stop-hook'):
        return 'stop-hook'
    if not w:
        return 'unlabeled:' + cls.split(':', 1)[1]
    best = None
    for n, p in rules:
        m = re.search(p, w, re.I)
        if m and (best is None or m.start() < best[1]):
            best = (n, m.start())
    return best[0] if best else 'other'


class Window:
    def __init__(self, db, since=None, until=None, from_version=None, to_version=None, user_re=None):
        lo, hi = -1e18, 1e18
        if since:
            lo = max(lo, to_t(since))
        if until:
            hi = min(hi, to_t(until))
        if from_version:
            lo = max(lo, self.version_t(db, from_version))
        if to_version:
            hi = min(hi, self.version_t(db, to_version))
        self.lo, self.hi = lo, hi
        self.args = {'since': since, 'until': until, 'from_version': from_version, 'to_version': to_version}
        self.user_re = user_re

    @staticmethod
    def version_t(db, rev):
        rows = db.execute('select sha, t from versions where sha like ?', (rev[:7] + '%',)).fetchall()
        if len(rows) != 1:
            raise SystemExit(f'version {rev}: {len(rows)} matches among hub main commits')
        return rows[0][1]

    def where(self, col='t'):
        return f'{col} >= {self.lo!r} and {col} < {self.hi!r}'

    def cli(self):
        args = {**self.args, 'user_re': self.user_re}
        return ''.join(f' --{k.replace("_", "-")} {shlex.quote(v)}' for k, v in args.items() if v)


class Metrics:
    def __init__(self, db, hub_projects, window):
        self.db, self.hp, self.w = db, hub_projects, window
        self.rules = ([('user', window.user_re)] if window.user_re else []) + WAIT_RULES

    def q(self, sql, *args):
        return self.db.execute(sql, args).fetchall()

    def kind(self, k):
        return f"session in (select session from sessions where kind='{k}')"

    def days(self):
        rows = self.q(f"select distinct date(t, 'unixepoch') from calls where agent='' and {self.w.where()} and "
                      f"session in (select session from sessions where kind in ('task', 'dispatcher'))")
        return len(rows)

    def segments(self, kind):
        return self.q(f'select session, t, cls, min, wait from segments where {self.kind(kind)} and {self.w.where()} '
                      'order by session, t, rowid')

    def whole_segments(self, sessions):
        """All segments of these sessions, the window aside: a path that began before --since is not cut."""
        rows = self.q('select session, t, cls, min, wait from segments order by session, t, rowid')
        return [r for r in rows if r[0] in sessions]

    # --- metrics; each returns (value, details, how)

    def touches_per_day(self):
        qn = self.q(f'select coalesce(sum(questions), 0), count(*) from asks where {self.w.where()}')[0]
        perms = self.q(f'select count(*) from perms where {self.w.where()}')[0][0]
        pushes = self.q(f"select count(*) from calls where push=1 and agent='' and {self.w.where()}")[0][0]
        days = self.days()
        total = qn[0] + perms + pushes
        return (r1(total / days) if days else None,
                {'questions': qn[0], 'ask_calls': qn[1], 'permissions': perms, 'pushes': pushes, 'days': days},
                'AskUserQuestion questions + permission prompts answered by the user + git push calls (shell-parsed, '
                'main threads), all sessions, '
                'per day with task or dispatcher calls (UTC)')

    def question_interval_min(self):
        work = sum(m for _, _, cls, m, _ in self.segments('dispatcher') if cls == 'model' or cls.startswith('tool:'))
        asked = sorted(t - a * 60 for t, a in self.q(f"select t, answer_min from asks where {self.kind('dispatcher')} "
                                                     f"and {self.w.where()}"))
        gaps = [(b - a) / 60 for a, b in zip(asked, asked[1:])]
        return (med(gaps), {'ask_calls': len(asked), 'gaps_under_15_min': sum(1 for g in gaps if g < 15),
                            'work_min_per_call': r1(work / len(asked)) if asked else None},
                'median minutes between consecutive AskUserQuestion calls of all dispatchers on one timeline '
                '(asks.py); work_min_per_call - dispatcher model + tool minutes per call')

    def answer_median_min(self):
        xs = [m for (m,) in self.q(f"select answer_min from asks where {self.kind('dispatcher')} and {self.w.where()}")]
        return (med(xs), {'n': len(xs), 'over_10_min': sum(1 for x in xs if x > 10)},
                'median minutes from AskUserQuestion to its answer, dispatchers')

    def longest_no_touch_min(self):
        sessions = {s for (s,) in self.q(f"select session from sessions where kind='task' and {self.w.where('start')}")}
        touches = {}
        for s, t in self.q('select session, t from perms union all select session, t from asks'):
            touches.setdefault(s, set()).add(t)
        best = {}
        acc = {}
        for s, t, cls, m, _ in self.whole_segments(sessions):
            if cls == 'pause':
                continue
            acc[s] = acc.get(s, 0) + m
            if cls.endswith(':human') or t in touches.get(s, ()):
                best[s] = max(best.get(s, 0), acc[s])
                acc[s] = 0
        for s, a in acc.items():
            best[s] = max(best.get(s, 0), a)
        xs = list(best.values())
        return (med(xs), {'sessions': len(xs), 'max': r1(max(xs)) if xs else None},
                'per task session the longest active stretch (no pause) between touches - a human message, an '
                'answered question, a permission prompt; median over sessions started in the window, each whole')

    def heavy_queue_share_pct(self):
        work = idle = res = 0.0
        for _, _, cls, m, w in self.segments('task'):
            if cls == 'pause':
                continue
            if cls.startswith('idle'):
                idle += m
                if wait_kind(w, cls, self.rules) == 'resource':
                    res += m
            else:
                work += m
        return (r1(100 * res / (work + idle)) if work + idle else None,
                {'resource_min': r1(res), 'idle_min': r1(idle), 'work_min': r1(work)},
                'idle minutes of task sessions waiting for a resource (by «Ждёт:») / their wall time without pause')

    def request_to_grant_sum_min(self):
        rows = self.q(f"select min, template from requests where {self.kind('task')} and {self.w.where()}")
        xs = sorted(m for m, _ in rows)
        by = {}
        for _, tpl in rows:
            by[tpl or 'none'] = by.get(tpl or 'none', 0) + 1
        return (r1(sum(xs)) if xs else 0, {'n': len(xs), 'median': med(xs),
                                           'p75': r1(xs[int(0.75 * len(xs))]) if xs else None,
                                           'by_template': dict(sorted(by.items()))},
                '«Прошу …» (SendMessage of a task session) -> next dispatcher message with «Разрешаю», < 3 h; '
                'by_template - the first Bash call after the grant, by category (for setup-permissions)')

    def review_rounds_per_session(self):
        rows = self.q(f"select session, count(*) from reviews where kind='L' and {self.kind('task')} and "
                      f"{self.w.where()} group by session")
        rounds = sorted(n for _, n in rows)
        return (r1(sum(rounds) / len(rounds)) if rounds else None, {'sessions': len(rounds), 'rounds': sum(rounds),
                                                                     'dist': rounds},
                'reviewer launches (subagent result with «review» in description or prompt) per task session with one')

    def first_ready_median_min(self):
        ready = dict(self.q(f"select session, first_ready from sessions where kind='task' and first_ready is not null "
                            f"and {self.w.where('first_ready')}"))
        acc = {}
        for s, t, cls, m, _ in self.whole_segments(set(ready)):
            if cls != 'pause' and t <= ready[s]:
                acc[s] = acc.get(s, 0) + m
        xs = [acc.get(s, 0) for s in ready]
        return (med(xs), {'sessions': len(xs)},
                'task sessions whose first «готово к пушу» with a sha is in the window: minutes without pause from '
                'their start to it')

    def memory_files(self, name):
        return sorted(glob.glob(os.path.join(self.hp, '*', 'memory', name)))

    def repeats_per_week(self):
        counters, dates, self_marked = 0, [], 0
        for f in self.memory_files('errors.md'):
            txt = open(f, encoding='utf-8', errors='replace').read()
            counters += sum(int(x) for x in REPEAT_RE.findall(txt))
            self_marked += len(SELF_REPEAT_RE.findall(txt))
            dates += [d for d in map(valid_date, DATE_RE.findall(txt)) if d]
        weeks = None
        if dates:
            span = (max(dates) - min(dates)).days
            weeks = span / 7 if span else None
        return (r1(counters / weeks) if weeks else None,
                {'counters': counters, 'self_marked': self_marked, 'weeks': r1(weeks), 'window': 'snapshot'},
                'sum of «повторов: N» counters in errors.md of all projects / weeks between the first and last entry stamp «(date»')

    def corrupt_memory_files(self):
        bad = 0
        for f in sorted(glob.glob(os.path.join(self.hp, '*', 'memory', '**', '*'), recursive=True)):
            if os.path.isfile(f) and f.endswith(MEMORY_TEXT):
                with open(f, 'rb') as h:
                    if b'\0' in h.read():
                        bad += 1
        return bad, {'window': 'snapshot'}, 'text files (md, json, jsonl, log, txt) with a NUL byte in project memory (the snapshot, not their age)'

    def start_context_kb(self):
        xs = [b / KB for (b,) in self.q(f"select bytes from starts join sessions using(session) where kind='task' and "
                                        f"epoch=0 and {self.w.where('start')}")]
        return (med(xs), {'sessions': len(xs)},
                'task sessions, epoch 0: CLAUDE.md and other instruction files + SessionStart hook output, KB, median')

    def guard_blocks(self):
        rows = []
        for f in self.memory_files('dispatch-guard.log'):
            for line in open(f, encoding='utf-8', errors='replace'):
                try:
                    o = json.loads(line)
                    t = to_t(o['at'])
                except (ValueError, KeyError, TypeError):
                    continue
                if o.get('decision') == 'blocked' and not PROBE_RE.search(str(o.get('worktree', ''))) \
                        and self.w.lo <= t < self.w.hi:
                    rows.append(o)
        return rows

    def false_blocks_per_day(self):
        stop = self.q(f'select coalesce(sum(false_block), 0), count(*) from stops where {self.w.where()}')[0]
        guard = self.guard_blocks()
        lock_false = sum(1 for o in guard if FALSE_BLOCK_RE.search(str(o.get('what', ''))))
        days = self.days()
        return (r1((stop[0] + lock_false) / days) if days else None,
                {'stop_false': stop[0], 'stop_blocks': stop[1], 'lock_false': lock_false, 'lock_blocks': len(guard),
                 'days': days},
                'stop-hook blocks after a text that is no report + lock blocks on commands that run nothing heavy '
                '(dispatch-guard.log), per day')

    def push_gate_skips(self):
        rows = self.q(f"select session, t, cmd, push from calls where agent='' and tool in ('Bash', 'PowerShell') and "
                      f"{self.kind('dispatcher')} and {self.w.where()} order by session, t, rowid")
        checked, skips, pushes = {}, 0, 0
        for s, t, c, push in rows:
            if 'parallel-check' in (c or ''):
                checked[s] = True
            elif push:
                pushes += 1
                skips += 0 if checked.get(s) else 1
        return skips, {'pushes': pushes}, 'git push of a dispatcher with no parallel-check earlier in that session'

    def oom_kills(self):
        n = self.q(f'select count(*) from calls where oom=1 and {self.w.where()}')[0][0]
        return n, {}, 'Bash results that open with exit code 137 or carry hub-run\'s «код 137» (killed at a ceiling)'

    def tokens_per_task_output(self):
        rows = self.q("select u.session, sum(u.output), sum(u.input + u.cache_create + u.cache_read) from usage u "
                      "join sessions s using(session) where s.kind='task' and "
                      f"{self.w.where('s.start')} group by u.session")
        return (med([r[1] for r in rows]), {'sessions': len(rows), 'input_median': med([r[2] for r in rows])},
                'task sessions with their subagents: output tokens per session, median (input - with cache)')

    NAMES = ['touches_per_day', 'question_interval_min', 'answer_median_min', 'longest_no_touch_min',
             'heavy_queue_share_pct', 'request_to_grant_sum_min', 'review_rounds_per_session', 'first_ready_median_min',
             'repeats_per_week', 'corrupt_memory_files', 'start_context_kb', 'false_blocks_per_day', 'push_gate_skips',
             'oom_kills', 'tokens_per_task_output']

    def one(self, name, db_arg, hp_arg):
        value, details, how = getattr(self, name)()
        cmd = f'python3 tools/analytics/metrics.py --db {db_arg} --hub-projects {hp_arg} --metric {name}{self.w.cli()}'
        return {'value': value, **details, 'how': how, 'command': cmd}

    def window_counts(self):
        w = self.w.where()
        by = lambda col: dict(self.q(f"select coalesce({col}, 'none'), count(*) from calls where {w} group by 1 order by 1"))
        return {
            'pushes': self.q(f"select count(*) from calls where push=1 and agent='' and {w}")[0][0],
            'calls': self.q(f'select count(*) from calls where {w}')[0][0],
            'sessions': dict(self.q(f'select kind, count(*) from sessions where session in '
                                    f'(select session from calls where {w}) group by kind order by kind')),
            'epochs': self.q(f"select count(*) from epochs where agent='' and {w}")[0][0],
            'subagents': self.q(f"select count(distinct session || '/' || agent) from calls where agent != '' and {w}")[0][0],
            'bare_cd': self.q(f'select count(*) from calls where bare_cd=1 and {w}')[0][0],
            'bash': self.q(f"select count(*) from calls where tool in ('Bash', 'PowerShell') and {w}")[0][0],
            'by_model': by('model'),
            'by_hub_version': by('hub_version'),
        }


def compute(db_path, hub_projects, window_args, names=None, db_arg=None, hp_arg=None):
    db = sqlite3.connect(db_path)
    w = Window(db, **window_args)
    m = Metrics(db, hub_projects, w)
    out = {n: m.one(n, db_arg or db_path, hp_arg or hub_projects) for n in (names or Metrics.NAMES)}
    counts = m.window_counts()
    db.close()
    return out, counts


def add_window_args(ap):
    ap.add_argument('--since')
    ap.add_argument('--until')
    ap.add_argument('--from-version')
    ap.add_argument('--to-version')
    ap.add_argument('--user-re', help='how sessions name the user in «Ждёт:» lines (a regexp)')


def window_of(a):
    return {'since': a.since, 'until': a.until, 'from_version': a.from_version, 'to_version': a.to_version,
            'user_re': a.user_re}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--db', required=True)
    ap.add_argument('--hub-projects', required=True)
    ap.add_argument('--metric', choices=Metrics.NAMES)
    add_window_args(ap)
    a = ap.parse_args()
    out, counts = compute(a.db, a.hub_projects, window_of(a), [a.metric] if a.metric else None)
    print(json.dumps(out if a.metric else {'metrics': out, 'window_counts': counts}, ensure_ascii=False, indent=1,
                     sort_keys=True))


if __name__ == '__main__':
    sys.exit(main())
