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
  return !glob || globToRegex(glob).test(file.replace(/\\/g, '/'));
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
  const prefix = step.cwd ? step.cwd.replace(/\\/g, '/').replace(/\/?$/, '/') : '';
  return files
    .filter((f) => matchGlob(f, step.glob) && f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
}

function render(cmd, { files = [], scratch = '' }) {
  return cmd.replace(/\{files\}/g, files.map((f) => `"${f}"`).join(' ')).replace(/\{scratch\}/g, scratch);
}

// Lines that name an own file as a whole path (src/index.ts does not catch src/index.tsx), whatever the slash.
function filterOwn(output, files) {
  const own = files.map((f) => new RegExp(`(^|[^\\w./-])${escape(f.replace(/\\/g, '/'))}(?![\\w.])`));
  return output.split(/\r?\n/).filter((l) => own.some((re) => re.test(l.replace(/\\/g, '/'))));
}

// An error line without its position: the same background error moves when lines above it change.
const ERROR_LINE = /error/i;
const normalizeError = (l) => l.replace(/\\/g, '/').replace(/\(\d+,\d+\)|:\d+:\d+/g, '').trim();
const NOT_RAN = /is not recognized as an internal or external command|command not found|не является внутренней или внешней/i;

// The command did not run at all — a filterOwn step must not turn that into a silent OK.
function launchFailure(r, cwd, out) {
  if (!fs.existsSync(cwd)) return `нет папки ${cwd}`;
  if (r.error) return String(r.error.code || r.error.message);
  if (r.status === null) return 'прервано (таймаут)';
  if (r.status === 127 || r.status === 9009 || NOT_RAN.test(out)) return 'команда не найдена';
  if (r.status !== 0 && !out.trim()) return `код ${r.status} без вывода`;
  // A checker that exits non-zero prints error lines; a shell that could not start it (localized, garbled
  // message) does not.
  if (r.status !== 0 && !out.split(/\r?\n/).some((l) => ERROR_LINE.test(l))) return `код ${r.status} без строк ошибок — команда не отработала`;
  return null;
}

function runSteps(steps, { repo, files, scratch, baselineDir }) {
  return steps.map((step) => {
    const sel = selectFiles(files, step);
    const log = path.join(scratch, `${step.name}.log`);
    if ((step.glob || /\{files\}/.test(step.cmd)) && !sel.length) return { name: step.name, status: 'SKIP', ms: 0, log: '' };
    const t0 = Date.now();
    const cwd = path.join(repo, step.cwd || '');
    const r = fs.existsSync(cwd)
      ? spawnSync(render(step.cmd, { files: sel, scratch }), {
        shell: true, cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: (step.timeoutSec || 1800) * 1000,
      })
      : { status: null };
    const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? String(r.error) : ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    fs.writeFileSync(log, out);
    const done = (status, lines) => ({ name: step.name, status, ms: Date.now() - t0, log, lines });
    const failure = launchFailure(r, cwd, out);
    if (failure && (step.filterOwn || r.status === null || r.error)) return done('FAIL', [failure]);
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
      // A runner whose exit code lies either way (vitest: 0 on failures from Git Bash, 1 on a noisy plugin with all
      // tests green) — trust its output: failOn marks a failure, okOn a success.
      const failed = step.failOn ? out.split(/\r?\n/).filter((l) => new RegExp(step.failOn).test(l)) : [];
      const ok = step.okOn ? new RegExp(step.okOn, 'm').test(out) : r.status === 0;
      status = ok && !failed.length ? 'OK' : 'FAIL';
      lines = failed.length ? failed : status === 'FAIL' ? out.split(/\r?\n/).filter((l) => l.trim()).slice(-ERR_LINES) : [];
    }
    return done(status, lines);
  });
}

// Background errors of the base: run on a clean checkout of the base, once per base move.
function recordBaseline(steps, { repo, scratch, baselineDir }) {
  fs.mkdirSync(baselineDir, { recursive: true });
  return steps.filter((s) => s.baseline).map((step) => {
    const r = spawnSync(render(step.cmd, { files: [], scratch }), {
      shell: true, cwd: path.join(repo, step.cwd || ''), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
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

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const full = args.includes('--full');
  const cfgPath = opt('--config');
  const found = cfgPath ? { file: path.resolve(cfgPath), project: 'custom' } : findConfig(process.cwd());
  if (!found) { console.error('checks.json не найден: нужен projects/<имя>/checks.json хаба выше папки или --config'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(found.file, 'utf8'));
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const base = opt('--base') || cfg.base || 'origin/main';
  const files = ownFiles(repo, base);
  const scratch = path.join(os.tmpdir(), `checks-${found.project}`);
  fs.mkdirSync(scratch, { recursive: true });
  const baselineDir = path.join(path.dirname(found.file), 'checks-baseline');
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  if (args.includes('--record-baseline')) {
    const baseSha = execFileSync('git', ['rev-parse', '--short', base], { cwd: repo, encoding: 'utf8' }).trim();
    console.log(`фон с HEAD ${head} (база ${base} = ${baseSha})${head === baseSha && !files.length ? '' : ' — ВНИМАНИЕ: HEAD не база или есть свои правки'}`);
    console.log(recordBaseline(cfg.full || [], { repo, scratch, baselineDir }).join('\n'));
    process.exit(0);
  }
  const count = execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: repo, encoding: 'utf8' }).trim();
  console.log(`checks ${full ? 'full' : 'fast'} · своих файлов ${files.length} · HEAD ${head} · коммитов от ${base}: ${count}`);
  const s = summarize(runSteps((full ? cfg.full : cfg.fast) || [], { repo, files, scratch, baselineDir }));
  console.log(s.text);
  process.exit(s.code);
}

module.exports = { findConfig, matchGlob, ownFiles, selectFiles, render, filterOwn, runSteps, summarize };
