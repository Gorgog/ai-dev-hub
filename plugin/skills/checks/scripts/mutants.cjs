#!/usr/bin/env node
// Targeted mutants: one replacement at a time, the given test command, the file put back in finally. Proves that a
// test catches the risk it was written for (rights, guards, races, counters) — 5–15 mutants, not a full run.
// Config (JSON): {cwd, cmd, okOn?, failOn?, timeoutSec?, mutants: [{id, file, find, replace}]}; paths from cwd.
// A mutant: SKIP if its file has uncommitted edits (never mutate unsaved work), ERROR if `find` is not found exactly
// once, KILLED if the tests failed, SURVIVED if they passed. usage: node mutants.cjs <mutants.json>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runSteps } = require('./checks.cjs');

function dirty(cwd, file) {
  try { return execFileSync('git', ['status', '--porcelain', '--', file], { cwd, encoding: 'utf8' }).trim() !== ''; } catch { return true; }
}

// A killed process (tool timeout, KillShell) never reaches finally: the original goes to disk before the mutant does,
// and the next run puts it back first. The backup lives in the repo's .git, not in the working tree.
function pendingFile(cwd) {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim();
  return path.join(gitDir, 'mutants-pending.json');
}

function recoverPending(cwd) {
  const pend = pendingFile(cwd);
  if (!fs.existsSync(pend)) return [];
  const list = JSON.parse(fs.readFileSync(pend, 'utf8'));
  for (const p of list) fs.writeFileSync(p.file, p.original);
  fs.unlinkSync(pend);
  return list.map((p) => p.file);
}

function runMutants(cfg, { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-')) } = {}) {
  const results = [];
  const originals = new Map();
  const recovered = recoverPending(cfg.cwd);
  const pend = pendingFile(cfg.cwd);
  const step = (name) => ({ name, cmd: cfg.cmd, okOn: cfg.okOn, failOn: cfg.failOn, timeoutSec: cfg.timeoutSec });
  // Green without mutants first: otherwise every mutant would count as killed by a suite that is simply red.
  const [base] = runSteps([step('mutants-baseline')], { repo: cfg.cwd, files: [], scratch });
  if (base.status !== 'OK') {
    const why = `без мутантов тесты красные (${base.log}) — сначала починить прогон`;
    const all = (cfg.mutants || []).map((m) => ({ id: m.id, status: 'ERROR', why }));
    return { results: all, notRestored: [], text: `мутанты: не запускались — ${why}` };
  }
  for (const m of cfg.mutants || []) {
    const file = path.join(cfg.cwd, m.file);
    if (dirty(cfg.cwd, m.file)) { results.push({ id: m.id, status: 'SKIP', why: 'незакоммиченные правки в файле' }); continue; }
    const src = fs.readFileSync(file, 'utf8');
    const count = src.split(m.find).length - 1;
    if (count !== 1) { results.push({ id: m.id, status: 'ERROR', why: `find встречается ${count} раз(а)` }); continue; }
    if (!originals.has(file)) originals.set(file, src);
    try {
      fs.writeFileSync(pend, JSON.stringify([{ file, original: src }]));
      fs.writeFileSync(file, src.replace(m.find, () => m.replace)); // a function: «$» in replace stays literal
      const [r] = runSteps([step(`mutant-${m.id}`)], { repo: cfg.cwd, files: [], scratch });
      results.push({ id: m.id, status: r.status === 'OK' ? 'SURVIVED' : 'KILLED', log: r.log });
    } finally {
      fs.writeFileSync(file, src);
      fs.rmSync(pend, { force: true });
    }
  }
  const notRestored = [...originals].filter(([f, src]) => fs.readFileSync(f, 'utf8') !== src).map(([f]) => f);
  const n = (s) => results.filter((r) => r.status === s).length;
  const text = [
    ...recovered.map((f) => `восстановлен после обрыва: ${f} — прошлый прогон убит на мутанте`),
    `мутанты: убито ${n('KILLED')} · выжило ${n('SURVIVED')} · пропущено ${n('SKIP') + n('ERROR')}`,
    ...results.filter((r) => r.status === 'SURVIVED').map((r) => `  выжил: ${r.id} — нужен тест, который его ловит`),
    ...results.filter((r) => r.status === 'SKIP' || r.status === 'ERROR').map((r) => `  ${r.status === 'SKIP' ? 'пропущен' : 'ошибка'}: ${r.id} — ${r.why}`),
    ...notRestored.map((f) => `  НЕ ВОЗВРАЩЁН ФАЙЛ: ${f} — git diff и откат руками`),
  ].join('\n');
  return { results, notRestored, text };
}

// Exit codes: 0 — every mutant killed, 1 — a mutant survived, 2 — the run itself failed (config, paths), 3 — a file
// was not put back.
if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('usage: node mutants.cjs <mutants.json>'); process.exit(2); }
  let res;
  try {
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    cfg.cwd = path.resolve(path.dirname(f), cfg.cwd || '.');
    res = runMutants(cfg);
  } catch (e) {
    console.error(`mutants: прогон не состоялся — ${String(e.message || e).split('\n')[0]}`);
    process.exit(2);
  }
  console.log(res.text);
  process.exit(res.notRestored.length ? 3 : res.results.some((r) => r.status === 'SURVIVED') ? 1 : 0);
}

module.exports = { runMutants, pendingFile };
