#!/usr/bin/env node
// Fast feedback ladder: run the project's checks only on own files while working, the full set once on the final
// HEAD. Config — projects/<name>/checks.json of the hub, found by walking up from the working folder (repo/ or
// worktrees/<branch>). See ../SKILL.md for the format.
// usage: node checks.cjs [--full] [--base <ref>] [--config <checks.json>]
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

function filterOwn(output, files) {
  const own = files.map((f) => f.replace(/\\/g, '/'));
  return output.split(/\r?\n/).filter((l) => own.some((f) => l.replace(/\\/g, '/').includes(f)));
}

function runSteps(steps, { repo, files, scratch }) {
  return steps.map((step) => {
    const sel = selectFiles(files, step);
    const log = path.join(scratch, `${step.name}.log`);
    if ((step.glob || /\{files\}/.test(step.cmd)) && !sel.length) return { name: step.name, status: 'SKIP', ms: 0, log: '' };
    const t0 = Date.now();
    const r = spawnSync(render(step.cmd, { files: sel, scratch }), {
      shell: true, cwd: path.join(repo, step.cwd || ''), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? String(r.error) : ''}`;
    fs.writeFileSync(log, out);
    let status, lines;
    if (step.filterOwn) {
      lines = filterOwn(out, step.glob ? sel : selectFiles(files, { cwd: step.cwd }));
      status = lines.length ? 'FAIL' : 'OK';
    } else {
      // failOn: a runner whose exit code lies (vitest from Git Bash exits 0 on failures) — trust its output.
      const failed = step.failOn ? out.split(/\r?\n/).filter((l) => new RegExp(step.failOn).test(l)) : [];
      status = r.status === 0 && !failed.length ? 'OK' : 'FAIL';
      lines = failed.length ? failed : status === 'FAIL' ? out.split(/\r?\n/).filter((l) => l.trim()).slice(-ERR_LINES) : [];
    }
    return { name: step.name, status, ms: Date.now() - t0, log, lines };
  });
}

function summarize(results) {
  const out = [];
  for (const r of results) {
    out.push(`${r.name} · ${r.status} · ${Math.round(r.ms / 1000)} с · ${r.log}`);
    if (r.status === 'FAIL') for (const l of (r.lines || []).slice(0, ERR_LINES)) out.push(`  ${l}`);
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
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const count = execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: repo, encoding: 'utf8' }).trim();
  console.log(`checks ${full ? 'full' : 'fast'} · своих файлов ${files.length} · HEAD ${head} · коммитов от ${base}: ${count}`);
  const s = summarize(runSteps((full ? cfg.full : cfg.fast) || [], { repo, files, scratch }));
  console.log(s.text);
  process.exit(s.code);
}

module.exports = { findConfig, matchGlob, ownFiles, selectFiles, render, filterOwn, runSteps, summarize };
