#!/usr/bin/env node
// Полигон хаба: прогон сценариев против версии хаба и сравнение двух прогонов.
//   node polygon/run.cjs [--hub <dir>] [--ref <git-ref>] [--only <regex>] [--level hook|model] [--repeats 3] [-j 1]
//                        [--model <m>] [--work <dir>] [--out <file.json>] [--quiet] [--strict] [--keep]
//   node polygon/run.cjs compare <a.json> <b.json> [--all]   — код 1, если хоть одна проверка стала хуже
//   node polygon/run.cjs regrade <results.json>   — пересчитать проверки по сохранённым транскриптам, без модели
// --ref не задан — живое рабочее дерево хаба; задан — ревизия через git archive во временную папку (без checkout).
// Хуки — 1 прогон (детерминированы), модельные — --repeats (тяжёлое: `claude -p`, только по разрешению замка).
// Код выхода прогона — 0, если прогон прошёл (красные проверки — это данные); --strict — 1 при красной проверке ворот.
// Результат по умолчанию — $HUB_DATA/polygon/results/ (вне git). --quiet — без таблицы, только итоги.
'use strict';
// Called from a git hook, the runner inherits GIT_DIR / GIT_INDEX_FILE: every `git -C <fixture>` would then act on the
// calling repository (review 05.11: a pre-commit in a worktree switched its branch and set core.bare). The hub itself
// is always addressed by `git -C <hub>`, so none of them is needed.
for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_NAMESPACE']) delete process.env[k];
const fs = require('fs');
const os = require('os');
const path = require('path');
const { materialize, tmpdir } = require('./lib/hub.cjs');
const { runClaude, summarize } = require('./lib/claude.cjs');
const { aggregate, group, summaryLines, compareRuns } = require('./lib/report.cjs');
const { hubDataDir, realCorporaStatus } = require('./lib/corpus.cjs');

const USAGE = `usage: node polygon/run.cjs [--hub <dir>] [--ref <git-ref>] [--only <regex>] [--level hook|model] [--repeats 3] [-j 1]
                           [--model <m>] [--work <dir>] [--out <file.json>] [--quiet] [--strict] [--keep]
       node polygon/run.cjs compare <a.json> <b.json> [--all]
       node polygon/run.cjs regrade <results.json>
без --level hook гоняет и модельные сценарии (тяжёлое).`;

// A flag the runner does not know (--help included) must not fall through to «run everything»: without --level that
// is the model scenarios, heavy. Anything off — usage, exit 2, before any work.
function usage(why) {
  process.stderr.write(`run.cjs: ${why}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const a = { hub: path.resolve(__dirname, '..'), ref: null, only: null, level: null, repeats: 3, j: 1,
    model: null, work: path.join(os.tmpdir(), 'hub-polygon'), out: null, quiet: false, strict: false, all: false, keep: false, _: [] };
  const count = (k, x) => (/^[1-9]\d*$/.test(x) ? Number(x) : usage(`${k} ждёт целое > 0, а не «${x}»`));
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => (i + 1 < argv.length ? argv[++i] : usage(`${k} без значения`));
    if (k === '--hub') a.hub = path.resolve(v());
    else if (k === '--ref') a.ref = v();
    else if (k === '--only') { const x = v(); try { a.only = new RegExp(x); } catch (e) { usage(`--only: ${e.message}`); } }
    else if (k === '--level') { a.level = v(); if (!['hook', 'model'].includes(a.level)) usage(`--level ${a.level} — ожидается hook | model`); }
    else if (k === '--repeats') a.repeats = count(k, v());
    else if (k === '-j') a.j = count(k, v());
    else if (k === '--model') a.model = v();
    else if (k === '--work') a.work = path.resolve(v());
    else if (k === '--out') a.out = path.resolve(v());
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--strict') a.strict = true;
    else if (k === '--all') a.all = true;
    else if (k === '--keep') a.keep = true;
    else if (k.startsWith('-')) usage(`незнакомый флаг ${k}`);
    else a._.push(k);
  }
  const [cmd, ...rest] = a._;
  if (cmd === 'compare' && rest.length !== 2) usage('compare ждёт два файла');
  if (cmd === 'regrade' && rest.length !== 1) usage('regrade ждёт один файл');
  if (cmd && !['compare', 'regrade'].includes(cmd)) usage(`лишнее слово «${cmd}» (сценарии выбирает --only)`);
  return a;
}

// A scenario file exports one scenario or an array of them (variants of one idea, as M04).
function loadScenarios(a) {
  const dir = path.join(__dirname, 'scenarios');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs')).sort()
    .flatMap((f) => [].concat(require(path.join(dir, f))))
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

// Scenario metadata travels with the result: compare and the summary read it from the JSON alone.
const head = (s) => ({ id: s.id, level: s.level, title: s.title, mech: s.mech || s.id, proto: Boolean(s.proto),
  contract: Boolean(s.contract) });
// Every check carries its kind and mechanism; a check without kind is a «catch» of a hook or the «task» of a model run.
const tag = (s, checks) => checks.map((c) => ({ ...c, kind: c.kind || (s.level === 'model' ? 'task' : 'catch'), mech: c.mech || s.mech || s.id }));

async function runScenario(s, a, base, runRoot) {
  if (s.level === 'hook') {
    const work = tmpdir(runRoot, `${s.id}-`);
    const t0 = Date.now();
    let checks;
    try { checks = await s.run({ base, pluginDir: path.join(base, 'plugin'), work }); }
    catch (e) { checks = [{ id: 'crash', pass: false, detail: String(e.stack || e).slice(0, 500) }]; }
    return { ...head(s), runs: [{ checks: tag(s, checks), wallMs: Date.now() - t0 }] };
  }
  const reps = Array.from({ length: s.repeats || a.repeats }, (_, i) => i);
  const runs = await pool(reps, a.j, async (rep) => {
    const work = tmpdir(runRoot, `${s.id}-r${rep}-`);
    const st = await s.setup({ base, work });
    const pluginDir = path.join(st.hubDir, 'plugin');
    const run = await runClaude({ cwd: st.cwd, prompt: st.prompt, pluginDir, hubDir: st.hubDir, model: a.model || s.model,
      maxTurns: st.maxTurns, timeoutSec: st.timeoutSec, logFile: path.join(work, 'transcript.jsonl') });
    let checks;
    try { checks = await s.grade({ run, ...st }); }
    catch (e) { checks = [{ id: 'grader-crash', pass: false, detail: String(e.stack || e).slice(0, 500) }]; }
    const pluginLoaded = (run.init.plugins || []).map((p) => p.name);
    process.stderr.write(`  ${s.id} r${rep}: ${checks.filter((c) => c.pass).length}/${checks.length} · ${run.turns} ходов · ${Math.round(run.wallMs / 1000)} с\n`);
    return { checks: tag(s, checks), turns: run.turns, wallMs: run.wallMs, model: run.init.model, plugins: pluginLoaded,
      subtype: run.subtype, transcript: path.join(work, 'transcript.jsonl'), ctx: st.ctx, finalText: run.finalText.slice(0, 1500) };
  });
  return { ...head(s), runs };
}

function printTable(results) {
  for (const sc of results) {
    const ag = aggregate(sc);
    console.log(`\n${sc.id} [${sc.level}${sc.contract ? ', контракт' : ''}] ${sc.title} — ${(ag.rate * 100).toFixed(0)}%` +
      (sc.level === 'model' ? ` · ${Math.round(ag.wallMs / 60000)} мин` : ''));
    for (const c of ag.checks) {
      const state = c.skip ? 'пр. ' : c.pass === c.n ? 'ok  ' : 'FAIL';
      console.log(`  ${state} ${c.id}${c.observe ? ' (наблюдение)' : ''}: ${c.skip ? c.skip : `${c.pass}/${c.n}`}` +
        (!c.skip && c.pass !== c.n && c.details.length ? ` — ${c.details[0]}` : ''));
    }
  }
}

function compare(fa, fb, all) {
  const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = compareRuns(load(fa), load(fb));
  const [title, ...rest] = c.lines;
  console.log(title);
  for (const r of c.rows) if (all || r.mark.trim()) console.log(`${r.mark}${r.key}: ${r.a} → ${r.b}`);
  console.log(rest.join('\n'));
  process.exitCode = c.exitCode;
}

// Re-grade model runs from their saved transcripts and fixtures — fixing a grader costs no model calls.
async function regrade(file) {
  const R = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = Object.fromEntries(loadScenarios({}).map((s) => [s.id, s]));
  for (const sc of R.results) {
    const s = byId[sc.id];
    if (sc.level !== 'model' || !s) continue;
    for (const r of sc.runs) {
      const events = fs.readFileSync(r.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const run = { events, ...summarize(events) };
      r.checks = tag(s, await s.grade({ run, ctx: r.ctx || (s.ctxFromWork && s.ctxFromWork(path.dirname(r.transcript))) }));
    }
  }
  R.regradedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(R, null, 1));
  printTable(R.results);
  console.log(`\n${summaryLines(R.results).join('\n')}`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a._[0] === 'compare') return compare(a._[1], a._[2], a.all);
  if (a._[0] === 'regrade') return regrade(a._[1]);
  const runRoot = tmpdir(a.work, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-`);
  const base = path.join(runRoot, 'base');
  const hub = materialize(a.hub, a.ref, base);
  const scenarios = loadScenarios(a);
  console.error(`хаб ${hub.ref} ${hub.sha}; сценариев ${scenarios.length}; работа — ${runRoot}`);
  console.error(realCorporaStatus());
  const results = [];
  for (const s of scenarios) results.push(await runScenario(s, a, base, runRoot));
  if (!a.quiet) printTable(results);
  console.log(`\n${summaryLines(results).join('\n')}`);
  const out = a.out || path.join(hubDataDir(), 'polygon', 'results', `${hub.sha}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), hub, results }, null, 1));
  console.log(`результат: ${out}`);
  // Фикстуры хук-прогона не нужны после него; у модельных — транскрипты для regrade, их оставляем.
  if (!a.keep && !results.some((r) => r.level === 'model')) fs.rmSync(runRoot, { recursive: true, force: true });
  if (a.strict) {
    const red = results.some((sc) => aggregate(sc).checks.some((c) => group(sc, c) === 'gate' && c.pass < c.n));
    process.exitCode = red ? 1 : 0;
  }
}

main().catch((e) => { console.error(e); process.exit(3); });
