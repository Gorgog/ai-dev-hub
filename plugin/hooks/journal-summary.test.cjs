// node --test journal-summary.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { summarize } = require('./journal-summary.cjs');

function journal(lines) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'js-'));
  fs.mkdirSync(path.join(p, 'memory'));
  fs.writeFileSync(path.join(p, 'memory', 'rules-guard.log'), lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  return p;
}
const at = (h) => `2026-10-21T${String(h).padStart(2, '0')}:00:00.000Z`;

test('summary: per rule and mode, count, last command; only since the given time; a log rule hit often is a deny candidate', () => {
  const p = journal([
    { at: at(1), id: 'cd-no-subshell', mode: 'log', what: 'cd a' },
    { at: at(2), id: 'cd-no-subshell', mode: 'log', what: 'cd b' },
    { at: at(3), id: 'cd-no-subshell', mode: 'log', what: 'cd c' },
    { at: at(3), id: 'push', mode: 'ask', what: 'git push' },
    { at: at(0), id: 'old', mode: 'log', what: 'x' },
  ]);
  const s = summarize(p, { since: at(1), candidateAt: 3 });
  assert.match(s, /cd-no-subshell · log · ×3 · cd c/);
  assert.match(s, /push · ask · ×1/);
  assert.doesNotMatch(s, /old/);
  assert.match(s, /кандидат в deny: cd-no-subshell/);
});

test('summary: no journal or nothing since — one quiet line', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'js-'));
  assert.match(summarize(p, {}), /срабатываний нет/);
});
