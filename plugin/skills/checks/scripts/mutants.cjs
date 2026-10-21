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

function runMutants(cfg, { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-')) } = {}) {
  const results = [];
  const originals = new Map();
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
      fs.writeFileSync(file, src.replace(m.find, m.replace));
      const [r] = runSteps([step(`mutant-${m.id}`)], { repo: cfg.cwd, files: [], scratch });
      results.push({ id: m.id, status: r.status === 'OK' ? 'SURVIVED' : 'KILLED', log: r.log });
    } finally {
      fs.writeFileSync(file, src);
    }
  }
  const notRestored = [...originals].filter(([f, src]) => fs.readFileSync(f, 'utf8') !== src).map(([f]) => f);
  const n = (s) => results.filter((r) => r.status === s).length;
  const text = [
    `мутанты: убито ${n('KILLED')} · выжило ${n('SURVIVED')} · пропущено ${n('SKIP') + n('ERROR')}`,
    ...results.filter((r) => r.status === 'SURVIVED').map((r) => `  выжил: ${r.id} — нужен тест, который его ловит`),
    ...results.filter((r) => r.status === 'SKIP' || r.status === 'ERROR').map((r) => `  ${r.status === 'SKIP' ? 'пропущен' : 'ошибка'}: ${r.id} — ${r.why}`),
    ...notRestored.map((f) => `  НЕ ВОЗВРАЩЁН ФАЙЛ: ${f} — git diff и откат руками`),
  ].join('\n');
  return { results, notRestored, text };
}

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('usage: node mutants.cjs <mutants.json>'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  cfg.cwd = path.resolve(path.dirname(f), cfg.cwd || '.');
  const res = runMutants(cfg);
  console.log(res.text);
  process.exit(res.notRestored.length ? 3 : res.results.some((r) => r.status === 'SURVIVED') ? 1 : 0);
}

module.exports = { runMutants };
