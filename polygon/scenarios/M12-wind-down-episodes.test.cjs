// node --test polygon/scenarios/M12-wind-down-episodes.test.cjs — грейдер M12 на синтетике, без модели: правильное
// действие (как сделал бы агент: черновик Write-ом и episode.cjs, Edit урока) — зелёное; бездействие, правило с первого
// раза, Bash-запись в память, v2 в проекте старого формата — красное.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const variants = require('./M12-wind-down-episodes.cjs');
const V = Object.fromEntries(variants.map((v) => [v.id, v]));
const ROOT = path.join(__dirname, '..', '..');

function base() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm12-base-'));
  fs.cpSync(path.join(ROOT, 'plugin'), path.join(d, 'plugin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'templates'), path.join(d, 'templates'), { recursive: true });
  return d;
}
const work = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm12-work-'));
async function fixture(id) { return V[id].setup({ base: base(), work: work() }); }
const episode = (st, ...args) => {
  const r = spawnSync(process.execPath, [path.join(st.hubDir, 'plugin', 'skills', 'wind-down', 'scripts', 'episode.cjs'), '--memory', st.ctx.mem, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
};
const draft = (st, id, kind, lines, status = 'active') => {
  const f = path.join(path.dirname(st.ctx.mem), `${id}.draft.md`);
  fs.writeFileSync(f, ['---', `id: ${id}`, `kind: ${kind}`, 'when: []', 'keys: [порт]', `status: ${status}`, 'supersedes: []',
    'source: пользователь', 'created: 2026-11-05', '---', ...lines, ''].join('\n'));
  return f;
};
const bash = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } });
const run = ({ extra = [] } = {}) => ({ turns: 4, costUsd: 0.2, events: [...extra,
  { type: 'result', usage: { input_tokens: 10, cache_read_input_tokens: 2000, output_tokens: 300 } }] });
const failed = (checks) => checks.filter((c) => !c.pass && !c.observe).map((c) => `${c.id}: ${c.detail}`);
const PORT = ['Дев-сервер apps/web слушает порт 3000 — проверять вёрстку на localhost:3000.', 'Смотрели 8080 и 15 минут искали несуществующий баг.'];

test('M12: четыре варианта — M12-episode, -repeat, -once, -v1', () => {
  assert.deepStrictEqual(variants.map((v) => v.id), ['M12-episode', 'M12-repeat', 'M12-once', 'M12-v1']);
});

test('M12-episode: knowledge через episode.cjs — зелёное; ничего, правило сразу, Bash-запись — красное', async () => {
  const st = await fixture('M12-episode');
  assert.ok(failed(await V['M12-episode'].grade({ run: run(), ctx: st.ctx })).length > 0);
  episode(st, 'add', draft(st, 'dev-port-3000', 'knowledge', PORT));
  assert.deepStrictEqual(failed(await V['M12-episode'].grade({ run: run(), ctx: st.ctx })), []);
  const heredoc = run({ extra: [bash("cat >> ../memory/errors.md <<'EOF'\n- порт 3000\nEOF")] });
  assert.ok(failed(await V['M12-episode'].grade({ run: heredoc, ctx: st.ctx })).some((f) => /no-bash-memory-write/.test(f)));

  const st2 = await fixture('M12-episode');
  episode(st2, 'add', draft(st2, 'dev-port-3000', 'rule', PORT), '--user-said');
  assert.ok(failed(await V['M12-episode'].grade({ run: run(), ctx: st2.ctx })).some((f) => /episode-not-rule/.test(f)));
});

test('M12-repeat: repeat + Edit до правила с when — зелёное; только repeat — красное', async () => {
  const st = await fixture('M12-repeat');
  episode(st, 'repeat', 'vitest-from-package', '--note', 'снова из корня');
  assert.ok(failed(await V['M12-repeat'].grade({ run: run(), ctx: st.ctx })).some((f) => /promoted-to-rule|rule-trigger/.test(f)));
  const f = path.join(st.ctx.mem, 'lessons', 'vitest-from-package.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('kind: knowledge', 'kind: rule')
    .replace('when: []', 'when:\n  - tool: ^Bash$\n    cmd: \\bvitest\\b'));
  assert.deepStrictEqual(failed(await V['M12-repeat'].grade({ run: run(), ctx: st.ctx })), []);
});

test('M12-once: once через episode.cjs — зелёное; knowledge — красное', async () => {
  const st = await fixture('M12-once');
  episode(st, 'add', draft(st, 'no-push-without-consent', 'once', ['Пуш в main — только с явного согласия пользователя.',
    'Сессия чуть не выполнила его сама.'], 'core'));
  assert.deepStrictEqual(failed(await V['M12-once'].grade({ run: run(), ctx: st.ctx })), []);
  const st2 = await fixture('M12-once');
  episode(st2, 'add', draft(st2, 'no-push-without-consent', 'knowledge', ['Пуш в main — только с явного согласия пользователя.',
    'Сессия чуть не выполнила его сама.']));
  assert.ok(failed(await V['M12-once'].grade({ run: run(), ctx: st2.ctx })).some((f) => /once-at-once/.test(f)));
});

test('M12-v1: запись v1 в errors.md — зелёное; lessons/ в проекте старого формата — красное', async () => {
  const st = await fixture('M12-v1');
  assert.ok(!fs.existsSync(path.join(st.ctx.mem, 'lessons')));
  fs.appendFileSync(path.join(st.ctx.mem, 'errors.md'), '- (2026-11-05, DEMO-1) **Порт дев-сервера.** Смотрели 8080 → проверять на 3000. '
    + 'стоило: ~15 мин · повторов: 0 · механизм: нет · Ключи: `порт`\n');
  assert.deepStrictEqual(failed(await V['M12-v1'].grade({ run: run(), ctx: st.ctx })), []);
  fs.mkdirSync(path.join(st.ctx.mem, 'lessons'));
  assert.ok(failed(await V['M12-v1'].grade({ run: run(), ctx: st.ctx })).some((f) => /no-v2-created/.test(f)));
});

test('bashMemoryWrites: запись в память Bash-ом — да; запуск episode.cjs и чтение — нет', () => {
  const { bashMemoryWrites } = variants;
  const ev = (c) => [bash(c)];
  assert.strictEqual(bashMemoryWrites(ev("cat >> memory/errors.md <<'EOF'\nx\nEOF")).length, 1);
  assert.strictEqual(bashMemoryWrites(ev('echo "- x" >> ../memory/errors.md')).length, 1);
  assert.strictEqual(bashMemoryWrites(ev('node -e "fs.writeFileSync(\'memory/lessons/a.md\', t)"')).length, 1);
  assert.strictEqual(bashMemoryWrites(ev('node episode.cjs add /tmp/draft.md')).length, 0);
  assert.strictEqual(bashMemoryWrites(ev('grep -n vitest ../memory/errors.md 2>/dev/null')).length, 0);
  assert.strictEqual(bashMemoryWrites(ev('ls memory/lessons/ && tail -3 memory/errors.md')).length, 0);
});
