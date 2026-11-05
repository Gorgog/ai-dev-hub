#!/usr/bin/env node
// Fast feedback ladder: run the project's checks only on own files while working, the full set once on the final
// HEAD. Config — projects/<name>/checks.json of the hub, found by walking up from the working folder (repo/ or
// worktrees/<branch>). See ../SKILL.md for the format.
// usage: node checks.cjs [--full | --record-baseline] [--base <ref>] [--config <checks.json>]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const MAX_LINES = 10;
const ERR_LINES = 4;
// Every step runs in its own cgroup scope through hub-run.sh: a timeout or a memory ceiling stops the whole tree
// (sh, npx, node, jest workers), not just the shell. Without a systemd user manager hub-run kills the process group.
const HUB_RUN = path.join(__dirname, '..', '..', 'dispatch', 'scripts', 'hub-run.sh');
// The memory ceiling of a step without `memory`: none in fast (own files, seconds), FULL_MEMORY in --full and
// --record-baseline — a whole-project tsc or test run that runs away must not take the desktop and the other sessions.
const FULL_MEMORY = '6G';

function findConfig(start) {
  let d = path.resolve(start);
  for (;;) {
    const f = path.join(d, 'checks.json');
    if (path.basename(path.dirname(d)) === 'projects' && fs.existsSync(f)) return { file: f, project: path.basename(d), dir: d };
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, j).split(',').map(escape).join('|') + ')'; i = j; }
    else re += escape(c);
  }
  return new RegExp('^' + re + '$');
}
const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

function matchGlob(file, glob) {
  return !glob || globToRegex(glob).test(file);
}

function gitLines(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
}

// Files of this branch: committed since the base, changed in the working tree, untracked. Deleted ones are left out.
function ownFiles(repo, base) {
  const set = new Set([
    ...gitLines(repo, ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]),
    ...gitLines(repo, ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
    ...gitLines(repo, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...set].filter((f) => fs.existsSync(path.join(repo, f)));
}

function selectFiles(files, step) {
  const prefix = step.cwd ? step.cwd.replace(/\/?$/, '/') : '';
  return files
    .filter((f) => matchGlob(f, step.glob) && f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
}

// {hub} and {project} — absolute paths of the hub and of projects/<name>: checks.json does not depend on the machine.
function render(cmd, { files = [], scratch = '', hub = '', project = '' }) {
  return cmd.replace(/\{files\}/g, files.map((f) => `"${f}"`).join(' ')).replace(/\{scratch\}/g, scratch)
    .replace(/\{hub\}/g, hub).replace(/\{project\}/g, project);
}

// Lines that name an own file as a whole path (src/index.ts does not catch src/index.tsx or xsrc/index.ts):
// relative, ./ or absolute.
function filterOwn(output, files) {
  const own = files.map((f) => new RegExp(`(^|[^\\w-])${escape(f)}(?![\\w.])`));
  return output.split(/\r?\n/).filter((l) => own.some((re) => re.test(l)));
}

// An error line without its position: the same background error moves when lines above it change.
const ERROR_LINE = /error/i;
const normalizeError = (l) => l.replace(/\(\d+,\d+\)|:\d+:\d+/g, '').trim();
const NOT_RAN = /command not found|команда не найдена|^sh: \d+: .*: not found$/im;

// Stopped from outside: a timeout or a kill (memory ceiling, OOM killer, a signal) — never the checker's verdict.
// hub-run.sh exits 124 on its timeout and 137 at MemoryMax and says which in a «hub-run: …» line.
function killReason(r, hubLines, timeoutSec) {
  if (r.error && r.error.code === 'ETIMEDOUT') return `таймаут ${timeoutSec} с`;
  if (r.signal) return `убит сигналом ${r.signal} (лимит памяти, OOM или снаружи)`;
  const said = hubLines.find((l) => /убит|таймаут/.test(l));
  if (r.status === 124) return said ? said.replace(/^hub-run: /, '') : `таймаут ${timeoutSec} с`;
  if (r.status === 137) return said ? said.replace(/^hub-run: /, '') : 'убит SIGKILL (лимит памяти или OOM)';
  return null;
}

// The command did not run at all — a filterOwn step must not turn that into a silent OK.
function launchFailure(r, cwd, out) {
  if (!fs.existsSync(cwd)) return `нет папки ${cwd}`;
  if (r.error) return String(r.error.code || r.error.message);
  if (r.status === 127 || NOT_RAN.test(out)) return 'команда не найдена';
  if (r.status !== 0 && !out.trim()) return `код ${r.status} без вывода`;
  // A checker that exits non-zero prints error lines; a shell that could not start it (localized, garbled
  // message) does not.
  if (r.status !== 0 && !out.split(/\r?\n/).some((l) => ERROR_LINE.test(l))) return `код ${r.status} без строк ошибок — команда не отработала`;
  return null;
}

// One step through hub-run.sh in scope «<label>-checks-<step>»: `hub-run.sh --stop <worktree>` stops it too.
// `out` is the command's own output; hub-run's lines (peak, kill reason) go to the log only.
function runStep(step, cmd, { cwd, label = '', memory = null }) {
  const timeoutSec = step.timeoutSec || 1800;
  const args = [HUB_RUN, `${label ? `${label}-` : ''}checks-${step.name}`, '-MemoryMax', String(step.memory || memory || 'infinity'), '-Timeout', String(timeoutSec)];
  if (step.cpuWeight) args.push('-CPUWeight', String(step.cpuWeight));
  args.push('--', 'sh', '-c', cmd);
  // The outer timeout is a backstop only: hub-run stops the scope itself; SIGTERM lets it stop the unit.
  const r = spawnSync('bash', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: (timeoutSec + 30) * 1000, killSignal: 'SIGTERM' });
  const all = `${r.stdout || ''}${r.stderr || ''}${r.error ? String(r.error) : ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = all.split(/\r?\n/);
  const hubLines = lines.filter((l) => l.startsWith('hub-run: '));
  const out = lines.filter((l) => !l.startsWith('hub-run: ')).join('\n');
  return { r, all, out, killed: killReason(r, hubLines, timeoutSec) };
}

function runSteps(steps, { repo, files, scratch, baselineDir, hub, project, label, memory }) {
  return steps.map((step) => {
    const sel = selectFiles(files, step);
    const log = path.join(scratch, `${step.name}.log`);
    if ((step.glob || /\{files\}/.test(step.cmd)) && !sel.length) return { name: step.name, status: 'SKIP', ms: 0, log: '' };
    const t0 = Date.now();
    const cwd = path.join(repo, step.cwd || '');
    const done = (status, lines) => ({ name: step.name, status, ms: Date.now() - t0, log, lines });
    if (!fs.existsSync(cwd)) { fs.writeFileSync(log, `нет папки ${cwd}\n`); return done('FAIL', [`нет папки ${cwd}`]); }
    const { r, all, out, killed } = runStep(step, render(step.cmd, { files: sel, scratch, hub, project }), { cwd, label, memory });
    fs.writeFileSync(log, all);
    if (killed) return done('FAIL', [killed]);
    const failure = launchFailure(r, cwd, out);
    if (failure && (step.filterOwn || r.error)) return done('FAIL', [failure]);
    let status, lines;
    if (step.filterOwn) {
      lines = filterOwn(out, step.glob ? sel : selectFiles(files, { cwd: step.cwd }));
      status = lines.length ? 'FAIL' : 'OK';
      if (step.baseline) {
        const bfile = path.join(baselineDir || '', `${step.name}.txt`);
        if (baselineDir && fs.existsSync(bfile)) {
          const known = new Set(fs.readFileSync(bfile, 'utf8').split(/\r?\n/).filter(Boolean));
          const fresh = out.split(/\r?\n/).filter((l) => ERROR_LINE.test(l) && !known.has(normalizeError(l)));
          lines = [...new Set([...lines, ...fresh])];
          status = lines.length ? 'FAIL' : 'OK';
        } else if (!lines.length) {
          status = 'WARN';
          lines = ['нет фона: чужие поломки от своих правок не видны — `checks.cjs --record-baseline` на базе'];
        }
      }
    } else {
      // A runner whose exit code lies either way (0 with failed tests, 1 on a noisy plugin with all tests green) —
      // trust its output: failOn marks a failure, okOn a success.
      const failed = step.failOn ? out.split(/\r?\n/).filter((l) => new RegExp(step.failOn).test(l)) : [];
      const ok = step.okOn ? new RegExp(step.okOn, 'm').test(out) : r.status === 0;
      status = ok && !failed.length ? 'OK' : 'FAIL';
      lines = failed.length ? failed : status === 'FAIL' ? out.split(/\r?\n/).filter((l) => l.trim()).slice(-ERR_LINES) : [];
    }
    return done(status, lines);
  });
}

// A background recorded on a branch would hide that branch's own breakage — only a clean checkout of the base.
function baselineRefusal({ head, base, own }) {
  if (head !== base) return `HEAD ${head} не база ${base}: фон пишется только на чистом checkout базы`;
  if (own) return `есть свои правки (${own} файлов): фон пишется только на чистом checkout базы`;
  return null;
}

// Background errors of the base: run on a clean checkout of the base, once per base move.
function recordBaseline(steps, { repo, scratch, baselineDir, hub, project, label, memory }) {
  fs.mkdirSync(baselineDir, { recursive: true });
  return steps.filter((s) => s.baseline).map((step) => {
    const { out, killed } = runStep(step, render(step.cmd, { files: [], scratch, hub, project }), { cwd: path.join(repo, step.cwd || ''), label, memory });
    if (killed) return `${step.name}: фон НЕ записан — ${killed}`;
    const lines = [...new Set(out.split(/\r?\n/).filter((l) => ERROR_LINE.test(l)).map(normalizeError))];
    fs.writeFileSync(path.join(baselineDir, `${step.name}.txt`), lines.join('\n') + '\n');
    return `${step.name}: фон ${lines.length} строк`;
  });
}

function summarize(results) {
  const out = [];
  for (const r of results) {
    out.push(`${r.name} · ${r.status} · ${Math.round(r.ms / 1000)} с · ${r.log}`);
    if (r.status === 'FAIL' || r.status === 'WARN') for (const l of (r.lines || []).slice(0, ERR_LINES)) out.push(`  ${l}`);
  }
  const text = out.length > MAX_LINES ? [...out.slice(0, MAX_LINES - 1), '  … остальное — в логах'].join('\n') : out.join('\n');
  return { code: results.some((r) => r.status === 'FAIL') ? 1 : 0, text };
}

// The fact of a full run for the stop hook (plugin/lib/done-gate.cjs): last-full.json in the git dir of this worktree
// (per worktree, gone with it, never in the tree). Written for a red run too: the hook names the failed steps.
function writeLastFull(repo, data) {
  const file = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hub/last-full.json'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const full = args.includes('--full');
  const cfgPath = opt('--config');
  const found = cfgPath
    ? findConfig(path.dirname(path.resolve(cfgPath))) || { file: path.resolve(cfgPath), project: 'custom', dir: path.dirname(path.resolve(cfgPath)) }
    : findConfig(process.cwd());
  if (!found) { console.error('checks.json не найден: нужен projects/<имя>/checks.json хаба выше папки или --config'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(found.file, 'utf8'));
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  // The background is one per project: it is recorded only against the project base, never a branch's --base.
  const baseArg = opt('--base');
  const base = (args.includes('--record-baseline') ? null : baseArg) || cfg.base || 'origin/main';
  const files = ownFiles(repo, base);
  // Logs per project and worktree (parallel worktrees must not overwrite each other's logs), on disk, not in /tmp
  // (tmpfs: RAM). The main copy is «<project>-repo».
  const label = path.basename(repo);
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const scratch = path.join(cache, 'hub', 'checks', `${found.project}-${label}`);
  fs.mkdirSync(scratch, { recursive: true });
  // projects/<name> -> the hub two levels up; a custom --config outside projects/ has no hub of its own.
  const ctx = { hub: found.project === 'custom' ? '' : path.dirname(path.dirname(found.dir)), project: found.dir,
    label: label === 'repo' ? `${found.project}-repo` : label };
  const baselineDir = path.join(path.dirname(found.file), 'checks-baseline');
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const baseSha = execFileSync('git', ['rev-parse', '--short', base], { cwd: repo, encoding: 'utf8' }).trim();
  const stamp = path.join(baselineDir, 'BASE');
  if (args.includes('--record-baseline')) {
    const refusal = baselineRefusal({ head, base: baseSha, own: files.length });
    if (refusal) { console.error(refusal); process.exit(1); }
    console.log(recordBaseline(cfg.full || [], { repo, scratch, baselineDir, ...ctx, memory: FULL_MEMORY }).join('\n'));
    fs.writeFileSync(stamp, `${baseSha}\n`);
    console.log(`фон записан с базы ${base} = ${baseSha}`);
    process.exit(0);
  }
  const count = execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: repo, encoding: 'utf8' }).trim();
  console.log(`checks ${full ? 'full' : 'fast'} · своих файлов ${files.length} · HEAD ${head} · коммитов от ${base}: ${count}`);
  if (full && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() !== baseSha) {
    console.log(`  фон снят с ${fs.readFileSync(stamp, 'utf8').trim()}, база уже ${baseSha}: возможен ложный FAIL — фон перепишет тот, кто на чистой базе`);
  }
  // The tree before the run: a full run of uncommitted changes is not a run of HEAD (the stop hook asks for clean).
  // HEAD is taken at the same moment: a commit during a background run must not be recorded as checked.
  const clean = full && !gitLines(repo, ['status', '--porcelain']).length;
  const ranSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const results = runSteps((full ? cfg.full : cfg.fast) || [], { repo, files, scratch, baselineDir, ...ctx, memory: full ? FULL_MEMORY : null });
  const s = summarize(results);
  console.log(s.text);
  if (full) writeLastFull(repo, { sha: ranSha, at: new Date().toISOString(),
    code: s.code, clean, base, steps: results.map((r) => ({ name: r.name, status: r.status })) });
  process.exit(s.code);
}

module.exports = { findConfig, matchGlob, ownFiles, selectFiles, render, filterOwn, runSteps, summarize, baselineRefusal, writeLastFull };
