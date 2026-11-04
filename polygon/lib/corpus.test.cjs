// node --test polygon/lib/corpus.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function need() {
  try { return require('./corpus.cjs'); } catch (e) { assert.fail(`нет polygon/lib/corpus.cjs: ${e.message.split('\n')[0]}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'polygon-corpus-'));

test('hubDataDir: HUB_DATA из окружения, иначе ~/hub-data', () => {
  const { hubDataDir } = need();
  assert.strictEqual(hubDataDir({ HUB_DATA: '/x/data' }), '/x/data');
  assert.strictEqual(hubDataDir({}), path.join(os.homedir(), 'hub-data'));
});

test('realCorpus: нет файла — null; есть — случаи с пометкой real и префиксом id', () => {
  const { realCorpus } = need();
  const d = tmp();
  assert.strictEqual(realCorpus('H02', d), null);
  fs.mkdirSync(path.join(d, 'polygon', 'corpus'), { recursive: true });
  fs.writeFileSync(path.join(d, 'polygon', 'corpus', 'H02.json'),
    JSON.stringify([{ id: 'fp-x', tool: 'Bash', input: { command: 'ls' }, expect: false, source: 'журнал' }]));
  const c = realCorpus('H02', d);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].id, 'real:fp-x');
  assert.strictEqual(c[0].real, true);
});

test('realCorporaStatus: без каталога — «реальные корпуса пропущены», с ним — список с числом случаев', () => {
  const { realCorporaStatus } = need();
  const d = tmp();
  assert.match(realCorporaStatus(d), /реальные корпуса пропущены/);
  fs.mkdirSync(path.join(d, 'polygon', 'corpus'), { recursive: true });
  fs.writeFileSync(path.join(d, 'polygon', 'corpus', 'H03.json'), JSON.stringify([{ id: 'a' }, { id: 'b' }]));
  fs.writeFileSync(path.join(d, 'polygon', 'corpus', 'H02-rules.json'), '{}');
  assert.match(realCorporaStatus(d), /реальные корпуса: H03 \(2\)$/);
});
