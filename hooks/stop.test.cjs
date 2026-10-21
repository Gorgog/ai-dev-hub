// node --test stop.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { doneGate } = require('./stop.cjs');

function repo() {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const r = path.join(hub, 'projects', 'demo', 'repo');
  fs.mkdirSync(r, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'a.txt'), '1'); git('add', '.'); git('commit', '-q', '-m', 'x');
  return { r, sha: git('rev-parse', '--short', 'HEAD') };
}

test('done-gate: «готово к пушу» needs a clean tree and the HEAD sha in the text', () => {
  const { r, sha } = repo();
  assert.strictEqual(doneGate({ cwd: r, last_assistant_message: `Готово к пушу: K-1 ${sha}` }), null);
  const noSha = doneGate({ cwd: r, last_assistant_message: 'Готово к пушу, всё проверено' });
  assert.strictEqual(noSha.decision, 'block');
  assert.match(noSha.reason, new RegExp(sha));
  fs.writeFileSync(path.join(r, 'b.txt'), 'dirty');
  const dirty = doneGate({ cwd: r, last_assistant_message: `Готово к пушу ${sha}` });
  assert.strictEqual(dirty.decision, 'block');
  assert.match(dirty.reason, /b\.txt/);
});

test('done-gate: silent without the phrase, on stop_hook_active and outside a hub project', () => {
  const { r } = repo();
  fs.writeFileSync(path.join(r, 'b.txt'), 'dirty');
  assert.strictEqual(doneGate({ cwd: r, last_assistant_message: 'сделал половину' }), null);
  assert.strictEqual(doneGate({ cwd: r, last_assistant_message: 'Готово к пушу', stop_hook_active: true }), null);
  assert.strictEqual(doneGate({ cwd: os.tmpdir(), last_assistant_message: 'Готово к пушу' }), null);
});
