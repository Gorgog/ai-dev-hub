// parallel-check.sh диспетчера: текстовый конфликт двух веток — код 1, общая горячая точка (миграции, модели) без
// конфликта — код 3, независимые ветки — 0. Без checkout, ничего не меняет в репозитории.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { gitRepo } = require('../lib/hub.cjs');

const MODEL = Array.from({ length: 12 }, (_, i) => `  field${i} Int`).join('\n');

module.exports = {
  id: 'H07', level: 'hook', mech: 'parallel-check', title: 'parallel-check: конфликт и горячая точка',
  async run({ base, work }) {
    const script = path.join(base, 'plugin', 'skills', 'dispatch', 'scripts', 'parallel-check.sh');
    if (!fs.existsSync(script)) return [{ id: 'text-conflict', pass: false, detail: 'нет parallel-check.sh' }];
    const repo = path.join(work, 'repo');
    const git = gitRepo(repo, { 'a.txt': 'one\ntwo\nthree\n', 'prisma/models/order.prisma': `model Order {\n${MODEL}\n}\n`, 'b.txt': '1\n', 'c.txt': '1\n' });
    const branch = (name, file, edit) => {
      git('checkout', '-q', '-b', name, 'main');
      const f = path.join(repo, file);
      fs.writeFileSync(f, edit(fs.readFileSync(f, 'utf8')));
      git('commit', '-q', '-am', name);
    };
    branch('t-a', 'a.txt', (s) => s.replace('two', 'two-A'));
    branch('t-b', 'a.txt', (s) => s.replace('two', 'two-B'));
    branch('h-a', 'prisma/models/order.prisma', (s) => s.replace('field1 Int', 'field1 BigInt'));
    branch('h-b', 'prisma/models/order.prisma', (s) => s.replace('field10 Int', 'field10 String'));
    branch('c-a', 'b.txt', () => '2\n');
    branch('c-b', 'c.txt', () => '2\n');
    git('checkout', '-q', 'main');
    const check = (a, b) => {
      const r = spawnSync('bash', [script, repo, 'main', a, b], { encoding: 'utf8', timeout: 30000 });
      return { code: r.status, out: (r.stdout + r.stderr).trim().split('\n')[0] };
    };
    const conflict = check('t-a', 't-b'), hot = check('h-a', 'h-b'), clean = check('c-a', 'c-b');
    const src = 'dispatch «Не ломать» №1–2; чек-лист «готово к пушу» 11-04';
    return [
      { id: 'text-conflict', source: src, pass: conflict.code === 1, detail: `код ${conflict.code}: ${conflict.out}` },
      { id: 'hot-spot', source: src, pass: hot.code === 3, detail: `код ${hot.code}: ${hot.out}` },
      { id: 'independent', kind: 'quiet', source: src, pass: clean.code === 0, detail: `код ${clean.code}: ${clean.out}` },
    ];
  },
};
