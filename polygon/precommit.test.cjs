// node --test polygon/precommit.test.cjs — проверка pre-commit.d/20-polygon.sh во временном репозитории из HEAD:
// main = HEAD, коммит правит базу хаба; хуже main — отказ, не хуже — проход; без ~/hub-data — строка о пропуске.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, '.githooks', 'pre-commit.d', '20-polygon.sh');

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'polygon-precommit-'));
  execFileSync('tar', ['-x', '-C', d], { input: execFileSync('git', ['-C', ROOT, 'archive', 'HEAD']) });
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'eval@example.test'); git('config', 'user.name', 'eval'); git('config', 'commit.gpgsign', 'false');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'slice');
  // The script under test is the working copy one: a red test before the file exists.
  if (fs.existsSync(SCRIPT)) {
    fs.mkdirSync(path.join(d, '.githooks', 'pre-commit.d'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(d, '.githooks', 'pre-commit.d', '20-polygon.sh'));
  }
  return { d, git };
}
const hook = (d, env = {}) => spawnSync('bash', [path.join(d, '.githooks', 'pre-commit.d', '20-polygon.sh')], { cwd: d, encoding: 'utf8',
  timeout: 120000, env: { ...process.env, HUB_DATA: path.join(d, 'no-hub-data'), ...env } });

test('20-polygon: правка базы без регрессии — проход, время и строка о пропуске реальных корпусов', () => {
  assert.ok(fs.existsSync(SCRIPT), 'нет .githooks/pre-commit.d/20-polygon.sh');
  const { d, git } = repo();
  fs.appendFileSync(path.join(d, 'plugin', 'agents', 'tester.md'), '\n');
  git('add', 'plugin/agents/tester.md');
  const r = hook(d);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /реальные корпуса пропущены/);
  assert.match(r.stdout + r.stderr, /polygon: .*\d+(\.\d)? s/);
});

test('20-polygon: проверка стала хуже main — отказ со строкой сравнения', () => {
  assert.ok(fs.existsSync(SCRIPT), 'нет .githooks/pre-commit.d/20-polygon.sh');
  const { d, git } = repo();
  const f = path.join(d, 'plugin', 'hooks', 'base-rules.json');
  fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')).filter((r) => r.id !== 'push'), null, 2) + '\n');
  git('add', 'plugin/hooks/base-rules.json');
  const r = hook(d);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /-\s+H03\/push: 1\/1 → 0\/1/);
});

test('20-polygon: коммит без базы хаба и полигона — полигон не гоняется', () => {
  assert.ok(fs.existsSync(SCRIPT), 'нет .githooks/pre-commit.d/20-polygon.sh');
  const { d, git } = repo();
  fs.appendFileSync(path.join(d, 'README.md'), '\n');
  git('add', 'README.md');
  const r = hook(d);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /реальные корпуса/);
});
