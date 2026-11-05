// improve (slice 24): the weekly improvement cycle, started by a session start. A week since the last run and none
// running → tools/process-audit/weekly.py of the hub starts detached under hub-run (memory ceiling, timeout) with
// --refresh --apply --polygon and the call returns at once; a finished week not shown yet → its summary, once, as one
// item (the user's weekly digest: actions taken, questions on the irreversible). Main thread, startup | clear only.
// The data folder: HUB_DATA, else ~/hub-data — and only when it is a copy of THIS hub (every project of the hub is in
// its hub/projects) with a calls database: a polygon or a test hub never refreshes the real copy.
// State: <data of the hooks>/improve/state.json {started_at, pid, report, shown}; report — improve/week.json.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { dir: dataDir } = require('../lib/journal.cjs');

const WEEK = 7 * 864e5;
const STALE = 6 * 3600e3; // a run older than this with its pid gone or reused is over
const PLUGIN = path.resolve(__dirname, '..', '..');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function writeState(f, s) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, f);
}

// ~/hub-data of this hub, or null: the copy names every project of the hub and has the calls database.
function hubData(hub) {
  const d = process.env.HUB_DATA || path.join(os.homedir(), 'hub-data');
  if (!fs.existsSync(path.join(d, 'analytics', 'calls.db'))) return null;
  let mine, copy;
  try {
    mine = fs.readdirSync(path.join(hub, 'projects'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    copy = new Set(fs.readdirSync(path.join(d, 'hub', 'projects')));
  } catch { return null; }
  return mine.length && mine.every((p) => copy.has(p)) ? d : null;
}

// What this start does: 'show' a finished week, 'failed' — a run that ended with no report (said once), 'run' the
// cycle, or nothing. Pure but for the pid check — the test drives it.
function decide(state, report, now) {
  const s = state || {};
  const t0 = s.started_at ? Date.parse(s.started_at) : null;
  const fresh = Boolean(report) && (t0 === null || report.mtime > t0); // written by the last run
  const running = Boolean(s.pid) && t0 !== null && !fresh && now - t0 < STALE && alive(s.pid);
  if (running) return null;
  if (fresh && report.summary && report.mtime !== s.shown) return 'show';
  if (t0 !== null && !fresh && s.failed !== s.started_at) return 'failed';
  if (t0 === null || now - t0 >= WEEK) return 'run';
  return null;
}

function start(hub, data, out, stateFile, state, now) {
  const weekly = process.env.HUB_IMPROVE_WEEKLY || path.join(hub, 'tools', 'process-audit', 'weekly.py');
  if (!fs.existsSync(weekly)) return null;
  const args = [weekly, '--data', data, '--hub', hub, '--events', dataDir(), '--apply', '--refresh', '--polygon', '--out', out];
  const hubRun = path.join(PLUGIN, 'skills', 'dispatch', 'scripts', 'hub-run.sh');
  const [cmd, argv] = fs.existsSync(hubRun)
    ? ['bash', [hubRun, 'improve-weekly', '-MemoryMax', '2G', '-Timeout', '3600', '--', 'python3', ...args]]
    : ['python3', args];
  const child = spawn(cmd, argv, { cwd: hub, detached: true, stdio: 'ignore', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  child.on('error', () => { /* journaled by the next start: the state shows a run with no report */ });
  child.unref();
  writeState(stateFile, { ...state, started_at: new Date(now).toISOString(), pid: child.pid, report: out });
  return child.pid;
}

module.exports = {
  id: 'improve',
  decide,
  run(ev, ctx) {
    if (!['startup', 'clear'].includes(ev.source) || ev.agent_id) return null;
    const hub = ctx.hub;
    const data = hub && hubData(hub);
    if (!data) return null;
    const stateFile = path.join(dataDir(), 'improve', 'state.json');
    const out = path.join(dataDir(), 'improve', 'week.json');
    const state = readJson(stateFile) || {};
    let report = null;
    try { report = { ...readJson(out), mtime: fs.statSync(out).mtimeMs }; } catch { /* no week yet */ }
    const now = Date.now();
    const what = decide(state, report, now);
    if (what === 'run') { start(hub, data, out, stateFile, state, now); return null; }
    if (what === 'failed') {
      writeState(stateFile, { ...state, pid: null, failed: state.started_at });
      return { items: [{ text: `Недельный цикл улучшения (запуск ${state.started_at}) не дописал итог ${out}: следующий — через неделю от запуска; ход — \`hub-run.sh --list\`.`, priority: 'info', key: 'improve' }] };
    }
    if (what !== 'show') return null;
    writeState(stateFile, { ...state, pid: null, shown: report.mtime });
    return { items: [{ text: `${report.summary}\n(подробно: ${out})`, priority: 'info', key: 'improve' }] };
  },
};
