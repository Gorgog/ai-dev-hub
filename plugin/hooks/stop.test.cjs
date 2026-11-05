// node --test stop.test.cjs — the Stop modules of the done-gate (stop.d/10-done-gate.cjs, 11-done-facts.cjs).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gate = require('./stop.d/10-done-gate.cjs');
const factsMod = require('./stop.d/11-done-facts.cjs');
// Temp folders of this file, removed after its tests.
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function repo() {
  const hub = mkdtemp('st-');
  const project = { dir: path.join(hub, 'projects', 'demo'), name: 'demo' };
  const r = path.join(project.dir, 'repo');
  fs.mkdirSync(r, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'a.txt'), '1'); git('add', '.'); git('commit', '-q', '-m', 'x');
  return { hub, r, project, sha: git('rev-parse', '--short', 'HEAD'), full: git('rev-parse', 'HEAD') };
}
const stop = (mod, project, cwd, msg, extra = {}) => mod.run({ cwd, last_assistant_message: msg, ...extra }, { project });

test('done-gate: a report needs a clean tree and the HEAD sha in the text', () => {
  const { r, project, sha } = repo();
  assert.strictEqual(stop(gate, project, r, `Готово к пушу: K-1 ${sha}`), null);
  const noSha = stop(gate, project, r, 'Готово к пушу, всё проверено');
  assert.strictEqual(noSha.decision, 'block');
  assert.match(noSha.reason, new RegExp(sha));
  fs.writeFileSync(path.join(r, 'a.txt'), 'changed');
  const dirty = stop(gate, project, r, `Готово к пушу: ${sha}`);
  assert.strictEqual(dirty.decision, 'block');
  assert.match(dirty.reason, /не чистое: a\.txt/);
  assert.match(stop(gate, project, r, 'Готово к мержу: K-1').reason, /«Готово к мержу»/);
});

test('done-gate: silent on a mention, «не готово к пушу», stop_hook_active, in the project folder and outside the hub', () => {
  const { r, project } = repo();
  fs.writeFileSync(path.join(r, 'b.txt'), 'dirty');
  assert.strictEqual(stop(gate, project, r, 'сделал половину'), null);
  assert.strictEqual(stop(gate, project, r, 'Ещё не готово к пушу: жду ревью'), null);
  assert.strictEqual(stop(gate, project, r, 'Статус: ревью | Дальше: доклад «готово к пушу» с sha'), null);
  assert.strictEqual(stop(gate, project, r, 'Готово к пушу', { stop_hook_active: true }), null);
  assert.strictEqual(stop(gate, project, path.dirname(r), 'Готово к пушу: K-1 abc1234'), null);
  assert.strictEqual(stop(gate, null, os.tmpdir(), 'Готово к пушу'), null);
});

test('done-facts: with checks.json a report needs a green full run of the final HEAD; the reason says how', () => {
  const { r, project, full } = repo();
  fs.writeFileSync(path.join(project.dir, 'checks.json'), '{"full": []}');
  const res = stop(factsMod, project, r, `Готово к пушу: K-1 ${full.slice(0, 7)}`);
  assert.strictEqual(res.decision, 'block');
  assert.match(res.reason, /checks\.cjs --full/);
  const file = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hub/last-full.json'], { cwd: r, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sha: full, code: 0, clean: true }));
  assert.strictEqual(stop(factsMod, project, r, `Готово к пушу: K-1 ${full.slice(0, 7)}`), null);
  assert.strictEqual(stop(factsMod, project, r, 'Готово к пушу: K-1', { stop_hook_active: true }), null);
  assert.strictEqual(stop(factsMod, null, r, 'Готово к пушу: K-1'), null);
});
