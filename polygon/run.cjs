#!/usr/bin/env node
// Полигон хаба: прогон сценариев против версии хаба и сравнение двух прогонов.
//   node run.cjs [--hub <dir>] [--ref <git-ref>] [--only <regex>] [--level hook|model] [--repeats 3] [-j 1]
//                [--model <m>] [--work <dir>] [--out <file.json>]
//   node run.cjs compare <a.json> <b.json>
//   node run.cjs regrade <results.json>   — пересчитать проверки по сохранённым транскриптам, без модели
// --ref не задан — живое рабочее дерево хаба. Хуки — 1 прогон (детерминированы), модельные — --repeats.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { materialize, tmpdir } = require('./lib/hub.cjs');
const { runClaude, summarize } = require('./lib/claude.cjs');

function parseArgs(argv) {
  const a = { hub: path.resolve(__dirname, '..'), ref: null, only: null, level: null, repeats: 3, j: 1,
    model: null, work: path.join(os.tmpdir(), 'hub-polygon'), out: null, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--hub') a.hub = path.resolve(v());
    else if (k === '--ref') a.ref = v();
    else if (k === '--only') a.only = new RegExp(v());
    else if (k === '--level') a.level = v();
    else if (k === '--repeats') a.repeats = Number(v());
    else if (k === '-j') a.j = Number(v());
    else if (k === '--model') a.model = v();
    else if (k === '--work') a.work = path.resolve(v());
    else if (k === '--out') a.out = path.resolve(v());
    else a._.push(k);
  }
  return a;
}

function loadScenarios(a) {
  const dir = path.join(__dirname, 'scenarios');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).sort()
    .map((f) => require(path.join(dir, f)))
    .filter((s) => (!a.only || a.only.test(s.id)) && (!a.level || s.level === a.level));
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (next < items.length) { const i = next++; res[i] = await fn(items[i], i); }
  }));
  return res;
}

async function runScenario(s, a, base, runRoot) {
  if (s.level === 'hook') {
    const work = tmpdir(runRoot, `${s.id}-`);
    const t0 = Date.now();
    let checks;
    try { checks = await s.run({ base, pluginDir: path.join(base, 'plugin'), work }); }
    catch (e) { checks = [{ id: 'crash', pass: false, detail: String(e.stack || e).slice(0, 500) }]; }
    return { id: s.id, level: s.level, title: s.title, runs: [{ checks, wallMs: Date.now() - t0, costUsd: 0 }] };
  }
  const reps = Array.from({ length: s.repeats || a.repeats }, (_, i) => i);
  const runs = await pool(reps, a.j, async (rep) => {
    const work = tmpdir(runRoot, `${s.id}-r${rep}-`);
    const st = await s.setup({ base, work });
    const pluginDir = path.join(st.hubDir, 'plugin');
    const run = await runClaude({ cwd: st.cwd, prompt: st.prompt, pluginDir, hubDir: st.hubDir, model: a.model || s.model,
      maxTurns: st.maxTurns, maxBudgetUsd: st.maxBudgetUsd, timeoutSec: st.timeoutSec, logFile: path.join(work, 'transcript.jsonl') });
    let checks;
    try { checks = await s.grade({ run, ...st }); }
    catch (e) { checks = [{ id: 'grader-crash', pass: false, detail: String(e.stack || e).slice(0, 500) }]; }
    const pluginLoaded = (run.init.plugins || []).map((p) => p.name);
    process.stderr.write(`  ${s.id} r${rep}: ${checks.filter((c) => c.pass).length}/${checks.length} · $${run.costUsd.toFixed(2)} · ${run.turns} ходов · ${Math.round(run.wallMs / 1000)} с\n`);
    return { checks, costUsd: run.costUsd, turns: run.turns, wallMs: run.wallMs, model: run.init.model, plugins: pluginLoaded,
      subtype: run.subtype, transcript: path.join(work, 'transcript.jsonl'), ctx: st.ctx, finalText: run.finalText.slice(0, 1500) };
  });
  return { id: s.id, level: s.level, title: s.title, runs };
}

// Per check: passes / runs; pass^k — passed in every run.
function aggregate(sc) {
  const byCheck = {};
  for (const r of sc.runs) for (const c of r.checks) {
    const b = (byCheck[c.id] ||= { id: c.id, source: c.source, observe: Boolean(c.observe), pass: 0, n: 0, details: [] });
    b.n++; if (c.pass) b.pass++;
    if (c.detail) b.details.push(String(c.detail).slice(0, 300));
  }
  const checks = Object.values(byCheck);
  const required = checks.filter((c) => !c.observe);
  return { checks, rate: required.reduce((s, c) => s + c.pass / c.n, 0) / Math.max(1, required.length),
    costUsd: sc.runs.reduce((s, r) => s + (r.costUsd || 0), 0), wallMs: sc.runs.reduce((s, r) => s + (r.wallMs || 0), 0) };
}

function printTable(results) {
  for (const sc of results) {
    const ag = aggregate(sc);
    console.log(`\n${sc.id} [${sc.level}] ${sc.title} — ${(ag.rate * 100).toFixed(0)}%` +
      (sc.level === 'model' ? ` · $${ag.costUsd.toFixed(2)} · ${Math.round(ag.wallMs / 60000)} мин` : ''));
    for (const c of ag.checks) console.log(`  ${c.pass === c.n ? 'ok  ' : 'FAIL'} ${c.id}${c.observe ? ' (наблюдение)' : ''}: ${c.pass}/${c.n}` +
      (c.pass !== c.n && c.details.length ? ` — ${c.details[0]}` : ''));
  }
}

function compare(fa, fb) {
  const A = JSON.parse(fs.readFileSync(fa, 'utf8')), B = JSON.parse(fs.readFileSync(fb, 'utf8'));
  console.log(`A: ${A.hub.ref} ${A.hub.sha}   B: ${B.hub.ref} ${B.hub.sha}`);
  const idx = (R) => Object.fromEntries(R.results.flatMap((sc) => aggregate(sc).checks.map((c) => [`${sc.id}/${c.id}`, c])));
  const a = idx(A), b = idx(B);
  let better = 0, worse = 0;
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const ra = a[k] ? a[k].pass / a[k].n : null, rb = b[k] ? b[k].pass / b[k].n : null;
    const mark = ra === null || rb === null ? 'new ' : rb > ra ? '+   ' : rb < ra ? '-   ' : '    ';
    if (mark.trim() === '+') better++; if (mark.trim() === '-') worse++;
    console.log(`${mark}${k}: ${a[k] ? `${a[k].pass}/${a[k].n}` : '—'} → ${b[k] ? `${b[k].pass}/${b[k].n}` : '—'}`);
  }
  console.log(`\nлучше: ${better}, хуже: ${worse}`);
  process.exitCode = worse ? 1 : 0;
}

// Re-grade model runs from their saved transcripts and fixtures — fixing a grader costs no model calls.
async function regrade(file) {
  const R = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = Object.fromEntries(loadScenarios({}).map((s) => [s.id, s]));
  for (const sc of R.results) {
    if (sc.level !== 'model' || !byId[sc.id]) continue;
    for (const r of sc.runs) {
      const events = fs.readFileSync(r.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const run = { events, ...summarize(events) };
      r.checks = await byId[sc.id].grade({ run, ctx: r.ctx || (byId[sc.id].ctxFromWork && byId[sc.id].ctxFromWork(path.dirname(r.transcript))) });
    }
  }
  R.regradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(R, null, 1));
  printTable(R.results);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a._[0] === 'compare') return compare(a._[1], a._[2]);
  if (a._[0] === 'regrade') return regrade(a._[1]);
  const runRoot = tmpdir(a.work, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-`);
  const base = path.join(runRoot, 'base');
  const hub = materialize(a.hub, a.ref, base);
  const scenarios = loadScenarios(a);
  console.error(`хаб ${hub.ref} ${hub.sha}; сценариев ${scenarios.length}; работа — ${runRoot}`);
  const results = [];
  for (const s of scenarios) results.push(await runScenario(s, a, base, runRoot));
  printTable(results);
  const total = results.reduce((s, r) => s + aggregate(r).costUsd, 0);
  console.log(`\nстоимость (оценка CLI): $${total.toFixed(2)}`);
  const out = a.out || path.join(os.homedir(), 'hub-data', 'polygon', 'results', `${hub.sha}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), hub, results }, null, 1));
  console.log(`результат: ${out}`);
  const failed = results.some((r) => aggregate(r).checks.some((c) => !c.observe && c.pass < c.n));
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(3); });
