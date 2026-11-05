// node --test tools/process-audit/process-audit.test.cjs
// The weekly improvement cycle (weekly.py) on a synthetic hub-data copy: project A (multi-session: rules.json, v1
// memory, a dispatcher) and project B (small: v2 memory). The week's audit — effectiveness of lessons and rules,
// failure clusters, push-gate skips — and the reversible actions by rule: applied with --apply, seen in the event
// journal, undone with --revert; the irreversible only as questions. --dry-run changes nothing.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..', '..');
const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const DAY = 86400;
const UNTIL = Date.parse('2026-10-28T12:00:00Z') / 1000;
const PD_A = '-home-u-hub-projects-proj-a-worktrees-T-1';
const PD_AD = '-home-u-hub-projects-proj-a';
const PD_B = '-home-u-hub-projects-proj-b';
const HUBRUN = '/home/u/hub/plugin/skills/dispatch/scripts';

// Calls: [session, agent, epoch, tool, cmd, path, is_error]; t grows by a minute, n counts per (session, agent, epoch).
function calls() {
  const rows = [];
  let t = UNTIL - 3 * DAY;
  const n = {};
  const add = (session, pdir, tool, cmd, { agent = '', epoch = 0, file = null, err = 0, push = 0 } = {}) => {
    const k = `${session}/${agent}/${epoch}`;
    n[k] = (n[k] || 0) + 1;
    rows.push({ id: `c${rows.length}`, t: t += 60, session, agent, epoch, n: n[k], pdir, tool, cmd, path: file, is_error: err, push });
  };
  // demo-rm (log) in task session s1: 5 windows — 4 repeats inside 3 calls, 1 prevented.
  for (let w = 0; w < 4; w++) { add('s1', PD_A, 'Bash', 'rm -rf build'); add('s1', PD_A, 'Bash', 'ls'); add('s1', PD_A, 'Bash', 'rm -rf dist'); add('s1', PD_A, 'Bash', 'ls'); add('s1', PD_A, 'Bash', 'ls'); add('s1', PD_A, 'Bash', 'ls'); }
  add('s1', PD_A, 'Bash', 'rm -rf out'); add('s1', PD_A, 'Bash', 'ls'); add('s1', PD_A, 'Bash', 'ls'); add('s1', PD_A, 'Bash', 'ls');
  // demo-chmod (deny-once): 5 windows, all repeats, in a short session: a deny would block > 1 call in 100.
  for (let w = 0; w < 5; w++) { add('s2', PD_A, 'Bash', 'chmod -R 777 a'); add('s2', PD_A, 'Bash', 'chmod -R 777 b'); add('s2', PD_A, 'Bash', 'ls'); add('s2', PD_A, 'Bash', 'ls'); add('s2', PD_A, 'Bash', 'ls'); }
  // failures: npx jest ×3 (one behind a wrapper), Edit ×2, git push ×1
  add('s1', PD_A, 'Bash', 'npx jest a', { err: 1 });
  add('s1', PD_A, 'Bash', 'timeout 600 npx jest b', { err: 1 });
  add('s1', PD_A, 'Bash', 'cd /w && npx jest c 2>&1 | tail -5', { err: 1, agent: 'r1' });
  add('s1', PD_A, 'Edit', null, { file: '/w/a.ts', err: 1 });
  add('s1', PD_A, 'Edit', null, { file: '/w/b.ts', err: 1 });
  // dispatcher d1: a bare push with no gate (skip), parallel-check then a bare push, a push through push-slice
  add('d1', PD_AD, 'Bash', 'git -C worktrees/T-1 push origin T-1', { push: 1, err: 1 });
  add('d1', PD_AD, 'Bash', `bash ${HUBRUN}/parallel-check.sh worktrees/T-2`);
  add('d1', PD_AD, 'Bash', 'git -C worktrees/T-2 push origin T-2', { push: 1 });
  add('d1', PD_AD, 'Bash', `node ${HUBRUN}/push-slice.cjs T-3`);
  // a push of a task session is no dispatcher's push; a call before the window is not counted
  add('s1', PD_A, 'Bash', 'git push origin T-1', { push: 1 });
  rows.push({ id: 'old', t: UNTIL - 30 * DAY, session: 's0', agent: '', epoch: 0, n: 1, pdir: PD_A, tool: 'Bash', cmd: 'npx jest z', path: null, is_error: 1, push: 0 });
  // project B: a few plain calls
  for (let k = 0; k < 3; k++) add('b1', PD_B, 'Bash', 'ls');
  return rows;
}

const FIXTURE_PY = `
import json, sqlite3, sys
sys.path.insert(0, sys.argv[3])
from calls import SCHEMA
db = sqlite3.connect(sys.argv[1])
db.executescript(SCHEMA)
spec = json.load(open(sys.argv[2]))
for c in spec['calls']:
    db.execute('insert into calls values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (c['id'], c['t'], '', c['session'], c['agent'],
        'reviewer' if c['agent'] else '', c['epoch'], c['n'], 'model-a', None, c['pdir'], c['tool'], c['cmd'], c['path'],
        c['is_error'], 0, 0, c['push'], 0))
for s in spec['sessions']:
    db.execute('insert into sessions values (?,?,?,?,?,?)', s)
db.commit()
`;

const lesson = (id, kind, created, extra = '') => `---\nid: ${id}\nkind: ${kind}\nwhen:\n  - tool: ^Bash$\n    cmd: ${id}\nkeys: [${id}]\nstatus: active\nsupersedes: []\nsource: модель (тест)\ncreated: ${created}\n---\nУрок ${id}: не делать так.\nИначе повтор.${extra}\n`;

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'process-audit-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, 'hub-data');
  const hub = path.join(data, 'hub');
  const rows = calls();
  const spec = path.join(base, 'spec.json');
  write(spec, JSON.stringify({ calls: rows, sessions: [
    ['s1', PD_A, 'task', UNTIL - 3 * DAY, UNTIL, null], ['s2', PD_A, 'task', UNTIL - 3 * DAY, UNTIL, null],
    ['d1', PD_AD, 'dispatcher', UNTIL - 3 * DAY, UNTIL, null], ['b1', PD_B, 'other', UNTIL - 3 * DAY, UNTIL, null],
    ['s0', PD_A, 'task', UNTIL - 30 * DAY, UNTIL - 30 * DAY, null]] }));
  fs.mkdirSync(path.join(data, 'analytics'), { recursive: true });
  write(path.join(base, 'fixture.py'), FIXTURE_PY);
  const r = spawnSync('python3', [path.join(base, 'fixture.py'), path.join(data, 'analytics', 'calls.db'), spec, path.join(ROOT, 'tools', 'analytics')], { encoding: 'utf8', env: ENV });
  assert.strictEqual(r.status, 0, r.stderr);

  // Project A: two rules of its own, one already at deny-once; v1 memory with counters.
  write(path.join(hub, 'projects', 'proj-a', 'rules.json'), JSON.stringify({ rules: [
    { id: 'demo-rm', tools: '^Bash$', commands: '\\brm\\s+-rf\\b', text: 'rm -rf — только по списку путей' },
    { id: 'demo-chmod', tools: '^Bash$', commands: '\\bchmod\\s+-R\\b', text: 'chmod -R — поимённо' },
  ], modes: { 'demo-chmod': 'deny-once' } }, null, 1));
  write(path.join(hub, 'projects', 'proj-a', 'memory', 'errors.md'), [
    '# Ошибки', '',
    '- (2026-10-01, T-1) **Один повтор без механизма.** Было → правило. стоило: ~5 мин · повторов: 1 · механизм: нет · Ключи: `a`',
    '- (2026-10-02, T-2) **Два повтора без механизма.** Было → правило,',
    '  на две строки. стоило: ~5 мин · повторов: 2 · механизм: нет · Ключи: `b`',
    '- (2026-10-03, T-3) **С механизмом.** Было → правило. стоило: ~5 мин · повторов: 3 · механизм: rules.json demo-rm · Ключи: `c`',
    '- (2026-10-04, T-4) **Без повторов.** Было → правило. стоило: ~5 мин · повторов: 0 · механизм: нет · Ключи: `d`', ''].join('\n'));
  // Project B: v2 memory — a stale rule, a «once» lesson that repeated, knowledge that repeated once.
  const mem = path.join(hub, 'projects', 'proj-b', 'memory');
  write(path.join(mem, 'lessons', 'old-rule.md'), lesson('old-rule', 'rule', '2026-08-01'));
  write(path.join(mem, 'lessons', 'once-x.md'), lesson('once-x', 'once', '2026-10-01'));
  write(path.join(mem, 'lessons', 'k-one.md'), lesson('k-one', 'knowledge', '2026-10-01'));
  const at = (d) => new Date((UNTIL - d * DAY) * 1000).toISOString();
  write(path.join(mem, 'events', '2026-10.jsonl'), jsonl([
    { at: at(2), kind: 'shown', lesson: 'once-x', session_id: 'b1' }, { at: at(2), kind: 'repeat', lesson: 'once-x', session_id: 'b1' },
    { at: at(1), kind: 'repeat', lesson: 'once-x', session_id: 'b1' }, { at: at(1), kind: 'repeat', lesson: 'k-one', session_id: 'b1' },
    { at: at(1), kind: 'shown', lesson: 'k-one', session_id: 'b1' }]));
  // The delivery's event journal (12): L1 — one window prevented, one repeated; an event before the window.
  const events = path.join(base, 'hook-data');
  write(path.join(events, 'events', '2026-10.jsonl'), jsonl([
    { at: at(3), kind: 'shown', lesson: 'L1', detector: 'd1', session_id: 's1' }, { at: at(3), kind: 'prevented', lesson: 'L1', session_id: 's1' },
    { at: at(2), kind: 'shown', lesson: 'L1', detector: 'd1', session_id: 's1' }, { at: at(2), kind: 'repeat', lesson: 'L1', window: true, session_id: 's1' },
    { at: at(20), kind: 'shown', lesson: 'L2', detector: 'd2', session_id: 's0' }]));
  return { base, data, hub, events };
}

function weekly(fx, ...args) {
  const r = spawnSync('python3', [path.join(DIR, 'weekly.py'), '--data', fx.data, '--hub', fx.hub, '--events', fx.events, '--until', '2026-10-28T12:00:00Z', ...args],
    { encoding: 'utf8', env: ENV, timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  return r;
}

// Every file under dir with its sha256: a dry run must leave them as they were.
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const find = (list, pred) => list.find(pred);

test('недельный аудит на снимке: действенность, кластеры, пропуски ворот; --dry-run ничего не меняет', (t) => {
  const fx = fixture(t);
  const before = tree(fx.base);
  const r = weekly(fx, '--dry-run', '--json');
  assert.deepStrictEqual(tree(fx.base), before, 'dry-run не пишет ни файла');
  const w = JSON.parse(r.stdout);

  assert.strictEqual(w.window.until, '2026-10-28T12:00:00Z');
  assert.strictEqual(w.window.days, 7);
  // rules-guard rules replayed over the window, «prevented» by a window of 3 calls of the same epoch
  assert.deepStrictEqual(w.effect.rules['proj-a']['demo-rm'], { mode: 'log', hits: 9, windows: 5, prevented: 1, repeat: 4, expired: 0, rate: 0.2, per100: w.effect.rules['proj-a']['demo-rm'].per100 });
  assert.deepStrictEqual(w.effect.rules['proj-a']['demo-chmod'].windows, 5);
  assert.deepStrictEqual(w.effect.rules['proj-a']['demo-chmod'].repeat, 5);
  assert.ok(w.effect.rules['proj-a']['demo-chmod'].per100 > 1);
  // the delivery's journal (12), the window only
  assert.deepStrictEqual(w.effect.delivery.lessons.L1, { shown: 2, prevented: 1, repeat: 1, late: 0, expired: 0, measured: true });
  assert.strictEqual(w.effect.delivery.lessons.L2, undefined);
  // v2 lessons: shows and repeats in the window
  assert.deepStrictEqual(w.effect.lessons['proj-b']['once-x'], { kind: 'once', shown: 1, repeat: 2 });

  // failures clustered by what ran: a wrapper, a cd before it and a filter after it are not the program; the
  // subagent's failure counts too
  assert.deepStrictEqual(w.clusters[0], { key: 'Bash: npx jest', count: 3, sessions: 1 });
  assert.deepStrictEqual(find(w.clusters, (c) => c.key === 'Edit'), { key: 'Edit', count: 2, sessions: 1 });

  // push gates of the dispatcher (condition 27, H09): a bare push without parallel-check before it is a skip
  assert.deepStrictEqual({ ...w.gates, list: undefined }, { pushes: 3, bare: 2, via_push_slice: 1, skips: 1, list: undefined });
  assert.deepStrictEqual(w.gates.list.filter((g) => g.skip).map((g) => g.session), ['d1']);

  // reversible actions by rule
  assert.ok(find(w.actions, (a) => a.kind === 'promote' && a.project === 'proj-a' && a.rule === 'demo-rm' && a.from === 'log' && a.to === 'deny-once'));
  assert.ok(!find(w.actions, (a) => a.rule === 'demo-chmod'), 'deny при > 1 срабатывания на 100 вызовов — не действие');
  assert.ok(find(w.actions, (a) => a.kind === 'retire' && a.project === 'proj-b' && a.lesson === 'old-rule'));
  assert.ok(!find(w.actions, (a) => a.kind === 'retire' && a.lesson === 'once-x'));
  const cand = w.actions.filter((a) => a.kind === 'candidate').map((a) => `${a.what}:${a.project}:${a.title || a.lesson}`).sort();
  assert.deepStrictEqual(cand, ['polygon:proj-a:Два повтора без механизма.', 'polygon:proj-a:Один повтор без механизма.',
    'rule:proj-a:Два повтора без механизма.', 'rule:proj-b:k-one']);
  assert.ok(w.actions.every((a) => /^[0-9a-f]{12}$/.test(a.id)), 'у действия — id для отката');
  // irreversible — questions only
  assert.ok(find(w.questions, (q) => q.rule === 'demo-chmod' && /сузить|ask/.test(q.text)));
  assert.ok(find(w.questions, (q) => q.lesson === 'once-x' && /механизм/.test(q.text)));

  // one message for the user
  assert.match(w.summary, /Недельный итог/);
  assert.match(w.summary, /пропусков ворот пуша: 1/);
  assert.match(w.summary, /Вопросы/);
  assert.ok(w.summary.split('\n').length <= 20, 'итог — одно сообщение, не простыня');
});

test('--apply: обратимое применено и видно в журнале событий, повтор не дублирует, --revert откатывает', (t) => {
  const fx = fixture(t);
  const out = path.join(fx.data, 'process-audit', 'week.json');
  weekly(fx, '--apply', '--out', out);
  const w = JSON.parse(fs.readFileSync(out, 'utf8'));
  const rulesA = () => JSON.parse(fs.readFileSync(path.join(fx.hub, 'projects', 'proj-a', 'rules.json'), 'utf8'));
  assert.strictEqual(rulesA().modes['demo-rm'], 'deny-once');
  assert.strictEqual(rulesA().modes['demo-chmod'], 'deny-once', 'вопрос не применяется');
  assert.strictEqual(rulesA().rules.length, 2);
  const lessonB = (id) => fs.readFileSync(path.join(fx.hub, 'projects', 'proj-b', 'memory', 'lessons', `${id}.md`), 'utf8');
  assert.match(lessonB('old-rule'), /^status: retired$/m);
  assert.match(lessonB('once-x'), /^status: active$/m);
  const memEv = fs.readFileSync(path.join(fx.hub, 'projects', 'proj-b', 'memory', 'events', `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8');
  assert.match(memEv, /"kind":"retired","lesson":"old-rule"/);

  const evFile = () => fs.readdirSync(path.join(fx.events, 'events')).flatMap((f) => fs.readFileSync(path.join(fx.events, 'events', f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  const mine = () => evFile().filter((e) => e.mode === 'improve');
  const kinds = mine().map((e) => e.kind).sort();
  assert.deepStrictEqual(kinds, ['candidate', 'candidate', 'candidate', 'candidate', 'promote', 'question', 'question', 'retire']);
  const promote = mine().find((e) => e.kind === 'promote');
  assert.deepStrictEqual([promote.rule, promote.project, promote.from, promote.to], ['demo-rm', 'proj-a', 'log', 'deny-once']);
  assert.ok(w.actions.some((a) => a.id === promote.id));
  // a polygon scenario stub per new «механизм: нет» candidate, outside git
  assert.strictEqual(fs.readdirSync(path.join(fx.data, 'process-audit', 'candidates')).filter((f) => f.endsWith('.cjs')).length, 2);
  // the trend: one row per applied week
  assert.strictEqual(fs.readFileSync(path.join(fx.data, 'process-audit', 'trend.jsonl'), 'utf8').trim().split('\n').length, 1);

  // the same week again: the promoted rule has no windows since its promotion, candidates are not new
  weekly(fx, '--apply', '--out', out);
  assert.deepStrictEqual(mine().map((e) => e.kind).sort(), kinds);
  assert.strictEqual(rulesA().modes['demo-rm'], 'deny-once');

  // undo by the action's id
  weekly(fx, '--revert', promote.id);
  assert.strictEqual(rulesA().modes['demo-rm'], undefined);
  assert.strictEqual(rulesA().modes['demo-chmod'], 'deny-once');
  const retire = mine().find((e) => e.kind === 'retire');
  weekly(fx, '--revert', retire.id);
  assert.match(lessonB('old-rule'), /^status: active$/m);
  assert.ok(mine().filter((e) => e.kind === 'revert').length === 2);
});

test('нет журнала подачи и памяти v2 — «не мерится», а не ноль и не падение', (t) => {
  const fx = fixture(t);
  fs.rmSync(fx.events, { recursive: true, force: true });
  fs.rmSync(path.join(fx.hub, 'projects', 'proj-b'), { recursive: true, force: true });
  const w = JSON.parse(weekly(fx, '--dry-run', '--json').stdout);
  assert.strictEqual(w.effect.delivery, null);
  assert.match(w.summary, /подача: не мерится/);
});

const weeklyRaw = (fx, ...args) => spawnSync('python3', [path.join(DIR, 'weekly.py'), '--data', fx.data, '--hub', fx.hub, '--events', fx.events,
  '--until', '2026-10-28T12:00:00Z', ...args], { encoding: 'utf8', env: ENV, timeout: 120000 });
const improveEvents = (fx) => fs.readdirSync(path.join(fx.events, 'events')).flatMap((f) => fs.readFileSync(path.join(fx.events, 'events', f), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse)).filter((e) => e.mode === 'improve');

test('--projects (канарейка): действия и вопросы — только в названных проектах, аудит — по всем', (t) => {
  const fx = fixture(t);
  const w = JSON.parse(weekly(fx, '--dry-run', '--json', '--projects', 'proj-b').stdout);
  assert.ok(w.effect.rules['proj-a'], 'аудит видит все проекты');
  assert.deepStrictEqual([...new Set([...w.actions, ...w.questions].map((a) => a.project))], ['proj-b']);
  weekly(fx, '--apply', '--projects', 'proj-b');
  const rules = JSON.parse(fs.readFileSync(path.join(fx.hub, 'projects', 'proj-a', 'rules.json'), 'utf8'));
  assert.strictEqual(rules.modes['demo-rm'], undefined, 'проект вне канарейки не тронут');
});

test('откат урока с CRLF возвращает статус и обновляет триггеры', (t) => {
  const fx = fixture(t);
  const f = path.join(fx.hub, 'projects', 'proj-b', 'memory', 'lessons', 'old-rule.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
  weekly(fx, '--apply');
  assert.match(fs.readFileSync(f, 'utf8'), /^status: retired\r$/m);
  const retire = improveEvents(fx).find((e) => e.kind === 'retire');
  weekly(fx, '--revert', retire.id);
  assert.match(fs.readFileSync(f, 'utf8'), /^status: active\r$/m);
  const triggers = JSON.parse(fs.readFileSync(path.join(fx.hub, 'projects', 'proj-b', 'memory', '.triggers.json'), 'utf8'));
  assert.ok(JSON.stringify(triggers).includes('old-rule'), 'урок вернулся в горячий путь');
});

test('откат повышения — только если режим сейчас тот, что записал цикл', (t) => {
  const fx = fixture(t);
  weekly(fx, '--apply');
  const promote = improveEvents(fx).find((e) => e.kind === 'promote');
  const file = path.join(fx.hub, 'projects', 'proj-a', 'rules.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.modes['demo-rm'] = 'deny';  // the user changed it by hand since
  fs.writeFileSync(file, JSON.stringify(j));
  const r = weeklyRaw(fx, '--revert', promote.id);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /deny/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).modes['demo-rm'], 'deny');
  assert.ok(!improveEvents(fx).some((e) => e.kind === 'revert'));
});

test('частота для deny — по всем вызовам проекта: проект без Bash в окне — вопрос, не deny', (t) => {
  const fx = fixture(t);
  // a path rule on Edit at deny-once in project B (no Bash calls of B carry it): 5 windows, all repeats
  write(path.join(fx.hub, 'projects', 'proj-b', 'rules.json'), JSON.stringify({ rules: [
    { id: 'demo-path', tools: '^Edit$', path: '\\.lock$', text: 'лок-файл не править' }], modes: { 'demo-path': 'deny-once' } }));
  const db = path.join(fx.data, 'analytics', 'calls.db');
  const py = `import sqlite3,sys\ndb=sqlite3.connect(sys.argv[1])\nt=${UNTIL - DAY}\nfor w in range(5):\n  for k,p in enumerate(['/w/a.lock','/w/b.lock','/w/c.ts','/w/d.ts','/w/e.ts']):\n    t+=60\n    db.execute("insert into calls values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(f'e{w}{k}',t,'','b2','','',0,w*5+k+1,'m',None,'${PD_B}','Edit',None,p,0,0,0,0,0))\ndb.commit()\n`;
  write(path.join(fx.base, 'more.py'), py);
  assert.strictEqual(spawnSync('python3', [path.join(fx.base, 'more.py'), db], { encoding: 'utf8' }).status, 0);
  const w = JSON.parse(weekly(fx, '--dry-run', '--json').stdout);
  const s = w.effect.rules['proj-b']['demo-path'];
  assert.strictEqual(s.windows, 5);
  // 10 hits over 28 calls of B in the window (3 Bash + 25 Edit), not over its 3 Bash calls
  assert.strictEqual(s.per100, 35.714);
  assert.ok(!w.actions.some((a) => a.rule === 'demo-path'));
  assert.ok(w.questions.some((q) => q.rule === 'demo-path'));
});

test('сбой действия: итог не называет его сделанным, кандидат после сбоя предлагается снова', (t) => {
  const fx = fixture(t);
  // the candidates folder cannot be made: a file stands in its way
  write(path.join(fx.data, 'process-audit', 'candidates'), 'not a folder');
  const out = path.join(fx.base, 'week.json');
  weekly(fx, '--apply', '--out', out);
  const w = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.match(w.summary, /не удалось: 2/);
  assert.match(w.summary, /кандидатов 2\b/);
  assert.ok(improveEvents(fx).filter((e) => e.kind === 'failed').every((e) => !e.id && e.action_id));
  fs.rmSync(path.join(fx.data, 'process-audit', 'candidates'));
  const again = JSON.parse(weekly(fx, '--dry-run', '--json').stdout);
  assert.strictEqual(again.actions.filter((a) => a.kind === 'candidate' && a.what === 'polygon').length, 2);
});

test('dry-run: «сделал бы», не «сделано»', (t) => {
  const fx = fixture(t);
  const w = JSON.parse(weekly(fx, '--dry-run', '--json').stdout);
  assert.match(w.summary, /Сделал бы \(dry-run\)/);
  assert.doesNotMatch(w.summary, /Сделано сам/);
});
