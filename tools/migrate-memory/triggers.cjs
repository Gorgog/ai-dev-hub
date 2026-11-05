#!/usr/bin/env node
// The `when` of migrated lessons against real calls and the replay cases — a check of the map before the hooks of
// slice 21 exist; the real test 6 (replay through delivery) is theirs.
//   triggers.cjs --out <run of migrate.py> --calls <calls.db> [--cases <cases.json>] [--noisy-rate 0.01] [--json <file>]
// Noise: every call of a project (pdir of the project or its worktrees) against the live lessons with `when`; an item
// fires when each of its fields matches the call (tool, cmd, path; body/out — when the db has them), a lesson — when
// any item fires; a delivery — once per (session, agent, epoch, lesson), as the delivery module does. Reported: calls,
// deliveries, deliveries per 20 calls, median of distinct lessons per session, lessons firing on more than
// --noisy-rate of the calls. A field the db lacks (calls.db has no body/out) never matches — the lower bound; the
// upper bound counts it as a match, and the lessons that lean on it are named «unmeasured». Cases (cases.json of the memory prototype: {id, src: "<project prefix>:<line>", date,
// gold, probe: {tool, cmd, path, body, out}}): a hit — a lesson whose `when` fires on the probe, whose text or keys
// match gold, created on or before the case date.
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { parseLesson, compileWhen } = require('../../plugin/lib/memory/format.cjs');

const FIELDS = ['tool', 'cmd', 'path', 'body', 'out'];

function args(argv) {
  const a = { noisyRate: 0.01 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--calls') a.calls = argv[++i];
    else if (k === '--cases') a.cases = argv[++i];
    else if (k === '--json') a.json = argv[++i];
    else if (k === '--noisy-rate') a.noisyRate = Number(argv[++i]);
    else return null;
  }
  return a.out && (a.calls || a.cases) ? a : null;
}

function lessons(out, project) {
  const dir = path.join(out, 'projects', project, 'memory', 'lessons');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const { meta, body } = parseLesson(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: meta.id, status: meta.status, created: meta.created, text: [...body, ...(meta.keys || [])].join('\n'),
      items: compileWhen(meta.when).items };
  }).filter((l) => ['core', 'active'].includes(l.status) && l.items.length);
}

// `missing` — fields the db has not: as an empty string (the lower bound) or as a match (the upper bound)
const fires = (l, call, missing = null) => l.items.some((it) => Object.entries(it)
  .every(([f, re]) => (missing && missing.includes(f) ? true : re.test(call[f] || ''))));

const lessonsWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'урок'
  : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'урока' : 'уроков');

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r2 = (x) => Math.round(x * 100) / 100;

function noise(a, projects, byProject) {
  const db = new DatabaseSync(a.calls, { readOnly: true });
  const cols = db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name);
  const have = FIELDS.filter((f) => cols.includes(f));
  const missing = FIELDS.filter((f) => !have.includes(f));
  // the longest project name wins: «a-b» is not «a»
  const order = [...projects].sort((x, y) => y.length - x.length || x.localeCompare(y));
  const owner = (pdir) => order.find((p) => new RegExp(`-projects-${p.replace(/[^\w]/g, (c) => `\\${c}`)}(-|$)`).test(pdir || ''));
  const fresh = () => ({ deliveries: 0, sessions: {}, seen: new Set() });
  const st = Object.fromEntries(projects.map((p) => [p, { calls: 0, fired: {}, lo: fresh(), hi: fresh() }]));
  const deliver = (b, c, id) => {
    b.sessions[c.session] = b.sessions[c.session] || new Set();
    const key = `${c.session}\0${c.agent || ''}\0${c.epoch}\0${id}`;
    if (b.seen.has(key)) return;
    b.seen.add(key);
    b.deliveries++;
    b.sessions[c.session].add(id);
  };
  const q = db.prepare(`SELECT session, agent, epoch, pdir, ${have.join(', ')} FROM calls ORDER BY id`);
  for (const c of q.iterate()) {
    const p = owner(c.pdir);
    if (!p) continue;
    const s = st[p];
    s.calls++;
    for (const b of [s.lo, s.hi]) b.sessions[c.session] = b.sessions[c.session] || new Set();
    for (const l of byProject[p]) {
      if (fires(l, c)) {
        s.fired[l.id] = (s.fired[l.id] || 0) + 1;
        deliver(s.lo, c, l.id);
        deliver(s.hi, c, l.id);
      } else if (missing.length && fires(l, c, missing)) deliver(s.hi, c, l.id);
    }
  }
  db.close();
  return Object.fromEntries(projects.map((p) => {
    const s = st[p];
    const noisy = Object.entries(s.fired).filter(([, n]) => s.calls && n / s.calls > a.noisyRate)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([id, n]) => ({ id, calls: n, rate: r2((n / s.calls) * 100) }));
    const per20 = (b) => (s.calls ? r2((b.deliveries / s.calls) * 20) : 0);
    const med = (b) => median(Object.values(b.sessions).map((x) => x.size));
    // a lesson with an item on a field the db lacks is not fully measured: the noise is between the two bounds
    const unmeasured = byProject[p].filter((l) => l.items.some((it) => Object.keys(it).some((f) => missing.includes(f)))).length;
    return [p, { lessons_with_when: byProject[p].length, calls: s.calls, deliveries: s.lo.deliveries, per20: per20(s.lo),
      sessions: Object.keys(s.lo.sessions).length, median_lessons_per_session: med(s.lo), noisy, fields: have, unmeasured,
      deliveries_upper: s.hi.deliveries, per20_upper: per20(s.hi), median_lessons_per_session_upper: med(s.hi) }];
  }));
}

function replay(a, projects, byProject) {
  const cases = JSON.parse(fs.readFileSync(a.cases, 'utf8'));
  const list = cases.map((c) => {
    const prefix = String(c.src || '').split(':')[0];
    const cand = projects.filter((p) => p.startsWith(prefix));
    if (cand.length !== 1) return { id: c.id, result: `проект не определён по «${prefix}»` };
    let gold;
    try { gold = new RegExp(c.gold, 'i'); } catch (e) { return { id: c.id, result: `gold не компилируется: ${e.message}` }; }
    const got = byProject[cand[0]].filter((l) => fires(l, c.probe || {}) && gold.test(l.text));
    const before = got.filter((l) => String(l.created) <= String(c.date));
    if (before.length) return { id: c.id, result: `попал: ${before[0].id}`, hit: true };
    if (got.length) return { id: c.id, result: `урока ещё не было: ${got[0].id}` };
    return { id: c.id, result: 'нет урока с when под вызов и текстом gold' };
  });
  return { hits: list.filter((x) => x.hit).length, total: list.length, list: list.map(({ id, result }) => ({ id, result })) };
}

function main(argv) {
  const a = args(argv);
  if (!a) {
    process.stderr.write('triggers.cjs --out <прогон> --calls <calls.db> [--cases <cases.json>] [--noisy-rate 0.01] [--json <файл>]\n');
    return 2;
  }
  const projects = fs.readdirSync(path.join(a.out, 'projects')).sort();
  const byProject = Object.fromEntries(projects.map((p) => [p, lessons(a.out, p)]));
  const rep = {};
  const lines = [];
  if (a.calls) {
    rep.projects = noise(a, projects, byProject);
    for (const [p, s] of Object.entries(rep.projects)) {
      lines.push(`${p}: вызовов ${s.calls}, подач ${s.deliveries} (${s.per20} на 20), медиана уроков на сессию `
        + `${s.median_lessons_per_session}, уроков с when ${s.lessons_with_when}, сессий ${s.sessions}`);
      if (s.unmeasured) {
        lines.push(`  без ${FIELDS.filter((f) => !s.fields.includes(f)).join('/')} в базе: ${s.unmeasured} ${lessonsWord(s.unmeasured)} `
          + `не измерен${s.unmeasured === 1 ? '' : 'о'}; верхняя граница — подач ${s.deliveries_upper} (${s.per20_upper} на 20), `
          + `медиана ${s.median_lessons_per_session_upper}`);
      }
      for (const n of s.noisy) lines.push(`  шумный: ${n.id} — ${n.calls} вызовов (${n.rate} %)`);
    }
  }
  if (a.cases) {
    rep.cases = replay(a, projects, byProject);
    lines.push(`replay: ${rep.cases.hits}/${rep.cases.total}`);
    for (const c of rep.cases.list) if (!c.result.startsWith('попал')) lines.push(`  ${c.id}: ${c.result}`);
  }
  if (a.json) fs.writeFileSync(a.json, `${JSON.stringify(rep, null, 1)}\n`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
