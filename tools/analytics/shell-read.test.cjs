// node --test tools/analytics/shell-read.test.cjs
// The analytics read shell with the lock's reader (plugin/skills/dispatch/scripts/shell.cjs): shell-flags.cjs (06) and
// depth/shell-rules.cjs (11) keep no tokenizer of their own; a heredoc inside "$( … )" is data in both; a command
// from a journal is read without the disk (the script it named then is not the file there now).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const run = (file, cmds) => {
  const r = spawnSync('node', [file], { input: JSON.stringify(cmds), encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(r.status, 0, r.error ? String(r.error) : r.stderr);
  return JSON.parse(r.stdout);
};
const FLAGS = path.join(DIR, 'shell-flags.cjs');
const RULES = path.join(DIR, 'depth', 'shell-rules.cjs');

test('shell-flags: heredoc внутри "$( … )" — данные, пуш и grant в его теле не считаются', () => {
  const cases = [
    // a lone quote in the body used to close the outer quote: the rest of the body was read as commands
    ['git commit -m "$(cat <<\'EOF\'\nfix "quoted\ngit push\nEOF\n)"', 0, 0],
    ['git commit -m "$(cat <<EOF\nnote "x\nnode /h/grant.cjs /p grant heavy T-1 30\nEOF\n)"', 0, 0],
    // the command after the substitution is still read
    ['git commit -m "$(cat <<\'EOF\'\nfix "quoted\nEOF\n)" && git push origin T-1', 1, 0],
  ];
  const got = run(FLAGS, cases.map((c) => c[0]));
  cases.forEach(([cmd, push, grant], k) => assert.deepStrictEqual([got[k].push, got[k].grant], [push, grant], cmd));
});

test('разбор shell аналитики — один: shell-flags и shell-rules читают через shell.cjs замка', () => {
  for (const f of [FLAGS, RULES]) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(/require\([^)]*shell-read\.cjs/.test(src), `${path.basename(f)}: читает через shell-read.cjs`);
    assert.ok(!/function simpleCommands/.test(src), `${path.basename(f)}: своего токенизатора нет`);
  }
  const src = fs.readFileSync(path.join(DIR, 'shell-read.cjs'), 'utf8');
  assert.match(src, /dispatch[\\/'", ]+scripts[\\/'", ]+shell\.cjs/);
});

test('команда из журнала читается без диска: скрипт, названный в ней, не открывается', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'ship.sh');
  fs.writeFileSync(script, '#!/bin/bash\ngit add -A\ngit push origin x\n');
  fs.chmodSync(script, 0o755);
  const flags = run(FLAGS, [`bash ${script}`, script, `source ${script}`]);
  flags.forEach((f) => assert.strictEqual(f.push, 0));
  const rules = run(RULES, [`bash ${script}`, script]);
  rules.forEach((r) => assert.deepStrictEqual(r.rules, {}));
});
