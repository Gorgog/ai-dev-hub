// Registry of mechanisms: plugin/mechanisms/<id>.json, one per hook module — event, module file, logical handler,
// stage (off / canary / on), failure policy, the state files it keeps, the polygon scenarios that prove it, what it
// replaces, a review date. The spine reads it on every event (stage, policy); the pre-commit check
// (.githooks/pre-commit.d/30-mechanisms.sh) runs `node registry.cjs check <root>` over the staged snapshot.
// usage: node registry.cjs check <root> [--today YYYY-MM-DD]
'use strict';
const fs = require('fs');
const path = require('path');

// Event of Claude Code → folder of its modules in plugin/hooks/.
const EVENTS = { PreToolUse: 'pretool.d', PostToolUse: 'posttool.d', PostToolUseFailure: 'posttoolfailure.d', Stop: 'stop.d',
  SessionStart: 'sessionstart.d', SessionEnd: 'sessionend.d', SubagentStart: 'subagentstart.d' };
const STAGES = ['off', 'canary', 'on'];
const ON_ERROR = ['open', 'closed'];
const SCOPES = ['any', 'project', 'worktree'];
// Budget (05.11, raised from 6): ≤ 10 logical handlers, ≤ 10 kinds of state files.
const BUDGET = { handlers: 10, state: 10 };
const REQUIRED = ['id', 'event', 'file', 'handler', 'stage', 'onError', 'failScope', 'state', 'reads', 'polygon', 'replaces', 'review'];

// [{name, rec}] or [{name, error}] for every *.json in <plugin>/mechanisms.
function readRecords(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  return names.map((name) => {
    try { return { name, rec: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }; } catch (e) {
      return { name, error: String(e.message).split('\n')[0] };
    }
  });
}

// Defects of one record that the spine itself cares about — and the pre-commit check on top.
function fieldErrors(name, rec) {
  const err = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return [`${name}: не объект`];
  const missing = REQUIRED.filter((k) => !(k in rec));
  if (missing.length) err.push(`${name}: нет полей ${missing.join(', ')}`);
  if ('id' in rec && rec.id !== name.replace(/\.json$/, '')) err.push(`${name}: id «${rec.id}» не совпадает с именем файла`);
  if ('stage' in rec && !STAGES.includes(rec.stage)) err.push(`${name}: stage «${rec.stage}» — ожидается ${STAGES.join(' | ')}`);
  if ('onError' in rec && !ON_ERROR.includes(rec.onError)) err.push(`${name}: onError «${rec.onError}» — ожидается ${ON_ERROR.join(' | ')}`);
  if ('failScope' in rec && !SCOPES.includes(rec.failScope)) err.push(`${name}: failScope «${rec.failScope}» — ожидается ${SCOPES.join(' | ')}`);
  if ('event' in rec && !EVENTS[rec.event]) err.push(`${name}: event «${rec.event}» — ожидается ${Object.keys(EVENTS).join(' | ')}`);
  if (typeof rec.file === 'string') {
    const dir = rec.file.split('/')[0];
    const owner = Object.keys(EVENTS).find((e) => EVENTS[e] === dir);
    if (!owner) err.push(`${name}: file ${rec.file} — не в каталоге события (${Object.values(EVENTS).join(', ')})`);
    else if (EVENTS[rec.event] && owner !== rec.event) err.push(`${name}: file ${rec.file} — каталог события ${owner}, а event ${rec.event}`);
  } else if ('file' in rec) err.push(`${name}: file не строка`);
  for (const k of ['state', 'reads', 'polygon']) if (k in rec && !Array.isArray(rec[k])) err.push(`${name}: ${k} не массив`);
  if ('review' in rec && !/^\d{4}-\d{2}-\d{2}$/.test(String(rec.review))) err.push(`${name}: review «${rec.review}» — дата ГГГГ-ММ-ДД`);
  return err;
}

// For the spine: module file → record, and every defect as a problem for the health check.
function loadRegistry(pluginDir) {
  const byFile = new Map();
  const problems = [];
  for (const { name, rec, error } of readRecords(path.join(pluginDir, 'mechanisms'))) {
    if (error) { problems.push(`mechanisms/${name} не разбирается (${error}) — модуль идёт по умолчанию: on, отказ закрытый в проектах`); continue; }
    problems.push(...fieldErrors(name, rec).map((e) => `mechanisms/${e}`));
    if (rec && typeof rec.file === 'string') byFile.set(rec.file, rec);
  }
  return { byFile, problems };
}

// The pre-commit check: list = [{name, rec | error}], modules = 'pretool.d/10-x.cjs' paths, scenarios = ids.
function checkRecords(list, { modules, scenarios, today }) {
  const errors = [], warnings = [];
  const files = new Set();
  const owners = new Map();
  const handlers = new Set(), state = new Set();
  for (const { name, rec, error } of list) {
    if (error) { errors.push(`${name}: не разбирается — ${error}`); continue; }
    errors.push(...fieldErrors(name, rec));
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.file === 'string') {
      files.add(rec.file);
      owners.set(rec.file, [...(owners.get(rec.file) || []), name]);
      if (!modules.includes(rec.file)) errors.push(`${name}: модуля plugin/hooks/${rec.file} нет`);
    }
    if (Array.isArray(rec.polygon)) {
      if (!rec.polygon.length) errors.push(`${name}: нет сценария полигона (polygon: [])`);
      for (const id of rec.polygon) if (!scenarios.includes(id)) errors.push(`${name}: сценария полигона ${id} нет (polygon/scenarios/${id}-*.cjs)`);
    }
    if (rec.handler) handlers.add(String(rec.handler));
    if (Array.isArray(rec.state)) rec.state.forEach((s) => state.add(String(s)));
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(rec.review)) && rec.review < today) warnings.push(`${name}: пересмотр ${rec.review} истёк — пересмотреть механизм или продлить дату`);
  }
  for (const [file, names] of owners) if (names.length > 1) errors.push(`модуль plugin/hooks/${file} — в нескольких записях: ${names.join(', ')}`);
  for (const m of modules) if (!files.has(m)) errors.push(`модуль plugin/hooks/${m} без записи реестра (plugin/mechanisms/<id>.json с file: "${m}")`);
  const sorted = (s) => [...s].sort().join(', ');
  if (handlers.size > BUDGET.handlers) errors.push(`бюджет: логических обработчиков ${handlers.size} > ${BUDGET.handlers} — ${sorted(handlers)}; новый механизм — вместо старого`);
  if (state.size > BUDGET.state) errors.push(`бюджет: видов состояния ${state.size} > ${BUDGET.state} — ${sorted(state)}`);
  return { errors, warnings };
}

// Folders *.d of plugin/hooks that belong to no event: a typo (pretools.d) — its modules would never run.
function unknownDirs(hooksDir) {
  let names = [];
  try { names = fs.readdirSync(hooksDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const known = new Set(Object.values(EVENTS));
  return names.filter((n) => n.endsWith('.d') && !known.has(n)).sort();
}

// For the health check: modules on disk that no record names (the pre-commit refuses them, a working tree may not).
function unregistered(pluginDir, byFile) {
  const hooks = path.join(pluginDir, 'hooks');
  return [
    ...listModules(hooks).filter((m) => !byFile.has(m)).map((m) => `модуль hooks/${m} без записи реестра — идёт как on, отказ закрытый в проектах`),
    ...unknownDirs(hooks).map((d) => `каталог hooks/${d}/ — не каталог события, его модули не запускаются`),
  ];
}

// Module files of every event folder under <plugin>/hooks, as 'pretool.d/10-x.cjs'.
function listModules(hooksDir) {
  const out = [];
  for (const dir of Object.values(EVENTS)) {
    let names = [];
    try { names = fs.readdirSync(path.join(hooksDir, dir)); } catch { continue; }
    for (const f of names.sort()) if (/\.c?js$/.test(f) && !/\.test\.c?js$/.test(f)) out.push(`${dir}/${f}`);
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--today');
  const today = i >= 0 ? args.splice(i, 2)[1] : new Date().toISOString().slice(0, 10);
  if (args[0] !== 'check' || !args[1]) { console.error('usage: node registry.cjs check <root> [--today YYYY-MM-DD]'); process.exit(2); }
  const root = args[1];
  let scenarios = [];
  try { scenarios = fs.readdirSync(path.join(root, 'polygon', 'scenarios')).filter((f) => f.endsWith('.cjs')).map((f) => f.split('-')[0]); } catch { /* none */ }
  const { errors, warnings } = checkRecords(readRecords(path.join(root, 'plugin', 'mechanisms')), {
    modules: listModules(path.join(root, 'plugin', 'hooks')), scenarios, today });
  for (const d of unknownDirs(path.join(root, 'plugin', 'hooks'))) errors.push(`каталог plugin/hooks/${d}/ — не каталог события (${Object.values(EVENTS).join(', ')}), его модули не запускаются`);
  for (const w of warnings) console.error(`mechanisms: предупреждение — ${w}`);
  for (const e of errors) console.error(`mechanisms: ${e}`);
  process.exit(errors.length ? 1 : 0);
}

module.exports = { EVENTS, BUDGET, readRecords, loadRegistry, checkRecords, listModules, unknownDirs, unregistered };
