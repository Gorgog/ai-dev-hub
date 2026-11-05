// node --test polygon/lib/claude.test.cjs — запуск модели полигона без модели: фейковый `claude` на PATH пишет свой
// argv и отвечает одной строкой result. Денежного лимита и подсчёта денег нет (решение 05.11), ходы и таймаут — есть.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClaude, summarize } = require('./claude.cjs');

test('runClaude: argv без --max-budget-usd, --max-turns на месте; итог без денег', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'polygon-claude-'));
  const bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  const argvFile = path.join(d, 'argv.json');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n` +
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n` +
    `console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.42, result: 'ok' }));\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const run = await runClaude({ cwd: d, prompt: 'x', maxTurns: 7, maxBudgetUsd: 3, timeoutSec: 30, logFile: path.join(d, 't.jsonl') });
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    assert.ok(!argv.includes('--max-budget-usd'), argv.join(' '));
    assert.strictEqual(argv[argv.indexOf('--max-turns') + 1], '7');
    assert.strictEqual(run.turns, 2);
    assert.ok(!('costUsd' in run), 'денег в итоге прогона нет');
    assert.ok(!('costUsd' in summarize([])));
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(d, { recursive: true, force: true });
  }
});
