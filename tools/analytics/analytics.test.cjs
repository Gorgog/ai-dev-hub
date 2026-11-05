// node --test tools/analytics/analytics.test.cjs
// Calls database and v1 baseline (calls.py, metrics.py, baseline.py) on a synthetic hub-data copy: a task session
// with a compaction and a reviewer subagent, a dispatcher session, a hub repo bundle, project memory and a lock log.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DIR = __dirname;
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const git = (cwd, env, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

const T = (hm) => `2026-10-20T${hm}.000Z`;
let msgId = 0;
let uuidN = 0;  // every record has its own uuid; a fork copies records with theirs
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 };
const asst = (sid, ts, model, blocks) =>
  ({ type: 'assistant', uuid: `u${++uuidN}`, sessionId: sid, timestamp: ts, isSidechain: false, message: { id: `m${++msgId}`, model, role: 'assistant', content: blocks, usage } });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });
const user = (sid, ts, content, extra = {}) => ({ type: 'user', uuid: `u${++uuidN}`, sessionId: sid, timestamp: ts, isSidechain: false, message: { role: 'user', content }, ...extra });
const result = (sid, ts, id, out, extra = {}) => user(sid, ts, [{ type: 'tool_result', tool_use_id: id, content: out }], extra);
const attach = (sid, ts, a) => ({ type: 'attachment', uuid: `u${++uuidN}`, sessionId: sid, timestamp: ts, attachment: a });

// The task session: 6 main calls in two epochs, a reviewer subagent with 2 calls.
function taskJournal(sid) {
  return [
    attach(sid, T('09:59:59'), { type: 'instructions', files: [{ path: '/h/CLAUDE.md', content: 'X'.repeat(1000) }] }),
    attach(sid, T('09:59:59'), { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'Y'.repeat(200) }),
    user(sid, T('10:00:00'), 'Задача T-1'),
    asst(sid, T('10:01:00'), 'model-a', [text('Статус: старт | Ждёт: — | Дальше: x'), tool('b1', 'Bash', { command: 'cd /r && ls' })]),
    // Brought in later in epoch 0 (a resume, a nested CLAUDE.md): not the context of the start.
    attach(sid, T('10:01:30'), { type: 'instructions', files: [{ path: '/r/CLAUDE.md', content: 'Z'.repeat(5000) }] }),
    result(sid, T('10:02:00'), 'b1', 'ok'),
    attach(sid, T('10:02:30'), { type: 'hook_success', hookName: 'SessionStart:resume', hookEvent: 'SessionStart', content: 'R'.repeat(900) }),
    asst(sid, T('10:03:00'), 'model-a', [tool('b2', 'Bash', { command: '( cd /r && ls )' })]),
    result(sid, T('10:04:00'), 'b2', 'ok', { permissionDecision: { decision: 'accept', source: 'user_temporary' } }),
    asst(sid, T('10:05:00'), 'model-a', [text('Статус: жду | Ждёт: разрешение тяжёлого | Дальше: jest'),
      tool('s1', 'SendMessage', { to: 'disp', message: 'Прошу тяжёлое на ~5 мин: jest' })]),
    result(sid, T('10:05:30'), 's1', 'sent'),
    user(sid, T('10:15:30'), '<cross-session-message from="disp" name="Диспетчер">Разрешаю тяжёлое</cross-session-message>'),
    asst(sid, T('10:16:00'), 'model-a', [tool('b3', 'Bash', { command: 'npx jest apps/x' })]),
    user(sid, T('10:20:00'), [{ type: 'tool_result', tool_use_id: 'b3', content: 'Exit code 137\nKilled', is_error: true }]),
    { type: 'system', subtype: 'compact_boundary', sessionId: sid, timestamp: T('10:21:00'), content: 'Conversation compacted' },
    user(sid, T('10:22:00'), 'This session is being continued from a previous conversation.'),
    asst(sid, T('10:23:00'), 'model-b', [tool('a1', 'Agent', { subagent_type: 'hub:reviewer', description: 'review T-1', prompt: 'ревью' })]),
    result(sid, T('10:24:00'), 'a1', 'launched', { toolUseResult: { agentId: 'agx', description: 'review T-1' } }),
    user(sid, T('10:30:00'), '<agent-message from="agx">вердикт: чисто</agent-message>'),
    asst(sid, T('10:31:00'), 'model-b', [text('**Готово к пушу** — T-1 abc1234'), tool('b4', 'Bash', { command: 'git push origin T-1' })]),
    result(sid, T('10:32:00'), 'b4', 'pushed'),
    attach(sid, T('10:32:30'), { type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop', blockingError: { blockingError: 'нет проверок' } }),
    // A status that mentions the report and a sha is not a report: the stop-hook block after it is false.
    asst(sid, T('10:40:00'), 'model-b', [text('Статус: правка abc1234 | Дальше: доклад «готово к пушу»')]),
    attach(sid, T('10:40:30'), { type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop', blockingError: { blockingError: 'нет проверок' } }),
  ];
}

function subJournal(sid) {
  const side = (r) => ({ ...r, isSidechain: true, agentId: 'agx' });
  return [
    side(user(sid, T('10:24:30'), 'Полный круг ревью')),
    side(asst(sid, T('10:25:00'), 'model-c', [tool('r1', 'Read', { file_path: '/r/a.js' })])),
    side(result(sid, T('10:25:10'), 'r1', "how: 'tool results with «exit code 137»'")),  // a file about OOM is no OOM
    side(asst(sid, T('10:26:00'), 'model-c', [tool('r2', 'Bash', { command: 'git diff main' })])),
    side(result(sid, T('10:26:10'), 'r2', 'x')),
  ];
}

function dispJournal(sid) {
  return [
    user(sid, T('09:00:00'), 'будь диспетчером'),
    asst(sid, T('09:01:00'), 'model-a', [tool('d1', 'Bash', { command: 'N=/c/nvm/node.exe; "$N" /h/grant.cjs /p grant heavy T-1 30' })]),
    result(sid, T('09:02:00'), 'd1', 'ok'),
    asst(sid, T('09:03:00'), 'model-a', [tool('q1', 'AskUserQuestion', { questions: [{ header: 'Пуш', options: [] }, { header: 'Ревью', options: [] }] })]),
    result(sid, T('09:05:00'), 'q1', 'answered'),
    asst(sid, T('09:06:00'), 'model-a', [tool('d2', 'Bash', { command: 'bash /h/parallel-check.sh /r main T-1' })]),
    result(sid, T('09:07:00'), 'd2', 'ok'),
    asst(sid, T('09:08:00'), 'model-a', [tool('d3', 'Bash', { command: 'git push origin main' })]),
    result(sid, T('09:09:00'), 'd3', 'ok'),
    asst(sid, T('09:10:00'), 'model-a', [tool('q2', 'AskUserQuestion', { questions: [{ header: 'Мерж', options: [] }] })]),
    result(sid, T('09:11:00'), 'q2', 'answered'),
    asst(sid, T('09:12:00'), 'model-a', [tool('d5', 'Bash', { command: 'git stash push -u -m wip-x' })]),  // not a push
    result(sid, T('09:13:00'), 'd5', 'ok'),
  ];
}

// hub-data copy: journals/, bundles/hub.bundle (c1 19.10, c2 20.10 10:10Z), hub/projects/*/memory.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'hub-data');
  const J = path.join(data, 'journals');
  write(path.join(J, '-h-hub-projects-p-worktrees-T-1', 'sess-task.jsonl'), jsonl(taskJournal('sess-task')));
  const sub = path.join(J, '-h-hub-projects-p-worktrees-T-1', 'sess-task', 'subagents');
  write(path.join(sub, 'agent-agx.jsonl'), jsonl(subJournal('sess-task')));
  write(path.join(sub, 'agent-agx.meta.json'), JSON.stringify({ agentType: 'hub:reviewer', description: 'review T-1' }));
  // A workflow agent lives one level deeper: subagents/workflows/<run>/agent-<id>.jsonl
  write(path.join(sub, 'workflows', 'wf_1', 'agent-wfa.jsonl'), jsonl([
    { ...asst('sess-task', T('10:27:00'), 'model-c', [tool('w1', 'Grep', { pattern: 'x' })]), isSidechain: true, agentId: 'wfa' }]));
  write(path.join(sub, 'workflows', 'wf_1', 'agent-wfa.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
  const disp = dispJournal('sess-disp');
  write(path.join(J, '-h-hub', 'sess-disp.jsonl'), jsonl(disp));
  // A fork, as Claude Code writes it: the dispatcher's records copied as they are (same uuids, same times, the
  // original's sessionId), then its own call, which only reads the lock's script. Its file name sorts first.
  const fork = [...disp.slice(0, 5),
    asst('a-fork', T('09:20:00'), 'model-a', [tool('f1', 'Bash', { command: 'wc -l /h/plugin/skills/dispatch/scripts/grant.cjs' })]),
    result('a-fork', T('09:21:00'), 'f1', '42')];
  write(path.join(J, '-h-hub', 'a-fork.jsonl'), jsonl(fork));
  // A fork of the fork: its first records are the root's, then the fork's own (f1 stays the fork's).
  write(path.join(J, '-h-hub', '0-fork2.jsonl'), jsonl([...fork,
    asst('0-fork2', T('09:40:00'), 'model-a', [tool('g1', 'Read', { file_path: '/h/x' })]), result('0-fork2', T('09:41:00'), 'g1', 'x')]));
  // The lock's own probe worktree is no task.
  write(path.join(J, '-h-hub-projects-p-worktrees-guard-probe', 'sess-probe.jsonl'), jsonl([user('sess-probe', T('09:30:00'), 'проба')]));

  const repo = path.join(root, 'hub-repo');
  fs.mkdirSync(repo);
  git(repo, {}, 'init', '-q', '-b', 'main');
  git(repo, {}, 'config', 'user.email', 't@t'); git(repo, {}, 'config', 'user.name', 't');
  const shas = [];
  for (const [n, when] of [['c1', '2026-10-19T12:00:00Z'], ['c2', '2026-10-20T10:10:00Z']]) {
    write(path.join(repo, n), n);
    git(repo, {}, 'add', n);
    git(repo, { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, 'commit', '-q', '-m', n);
    shas.push(git(repo, {}, 'rev-parse', '--short=7', 'HEAD').trim());
  }
  fs.mkdirSync(path.join(data, 'bundles'), { recursive: true });
  git(repo, {}, 'bundle', 'create', '-q', path.join(data, 'bundles', 'hub.bundle'), '--all');

  const mem = path.join(data, 'hub', 'projects', 'p', 'memory');
  write(path.join(mem, 'errors.md'), [
    '- Правило один. (2026-09-26) · повторов: 2 (2026-10-10, T-0)',
    '- Правило два. (2026-10-03) · повторов: 1',
    '- Правило три. (2026-10-10) · повторов: 0',
    '- Дата из примера, не настоящая: 2025-02-30.',  // the real memory has one: not a date, not a crash
    '- Пример в тексте урока: `new Date(\'2019-01-01\')` - не штамп записи (2026-10-03).',
  ].join('\n') + '\n');
  write(path.join(mem, 'broken.md'), 'урок\u0000обрезан\n');
  write(path.join(mem, 'T-1', 'shots', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));  // binary, not corrupt
  write(path.join(mem, 'dispatch-guard.log'), jsonl([
    { at: T('10:06:00'), worktree: 'T-1', decision: 'blocked', kind: 'heavy', rule: 'jest', tool: 'Bash', what: 'cat >> errors.md <<EOF\njest\nEOF' },
    { at: T('10:07:00'), worktree: 'T-1', decision: 'blocked', kind: 'heavy', rule: 'jest', tool: 'Bash', what: 'npx jest apps/x' },
    { at: T('10:15:00'), worktree: 'T-1', decision: 'granted', kind: 'heavy', rule: 'jest', tool: 'Bash', what: 'npx jest apps/x' },
  ]));
  return { root, data, shas };
}

const py = (script, args) => spawnSync('python3', [path.join(DIR, script), ...args], { encoding: 'utf8' });
function baseline(data, out, ...extra) {
  const r = py('baseline.py', ['--data', data, '--out', out, '--since', '2026-10-01', ...extra]);
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}
const sql = (db, q) => JSON.parse(execFileSync('python3', ['-c',
  'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2]).fetchall()))', db, q], { encoding: 'utf8' }));

test('база вызовов: сессия, агент, эпоха, номер в эпохе, модель, версия хаба, cd без подоболочки', (t) => {
  const { data, shas } = fixture(t);
  const v = baseline(data, path.join(data, 'baseline', 'v1.json'));
  assert.deepStrictEqual(v.copy, { files: 7, sessions: 5, calls: 17, epochs: 6, compactions: 1, subagents: 2 });
  const db = path.join(data, 'analytics', 'calls.db');
  const rows = sql(db, 'select id, session, agent, agent_type, epoch, n, model, hub_version, bare_cd from calls order by ts, id');
  const by = Object.fromEntries(rows.map((r) => [r[0], r.slice(1)]));
  assert.deepStrictEqual(by.b1, ['sess-task', '', '', 0, 1, 'model-a', shas[0], 1]);
  assert.deepStrictEqual(by.b2, ['sess-task', '', '', 0, 2, 'model-a', shas[0], 0]);
  assert.deepStrictEqual(by.b3, ['sess-task', '', '', 0, 4, 'model-a', shas[1], 0]);
  assert.deepStrictEqual(by.a1, ['sess-task', '', '', 1, 1, 'model-b', shas[1], null]);
  assert.deepStrictEqual(by.b4, ['sess-task', '', '', 1, 2, 'model-b', shas[1], 0]);
  assert.deepStrictEqual(by.r2, ['sess-task', 'agx', 'hub:reviewer', 0, 2, 'model-c', shas[1], 0]);
  assert.deepStrictEqual(by.w1, ['sess-task', 'wfa', 'general-purpose', 0, 1, 'model-c', shas[1], null]);
  assert.strictEqual(by.f1[0], 'a-fork');
  assert.strictEqual(by.g1[0], '0-fork2');
  assert.deepStrictEqual(by.d1, ['sess-disp', '', '', 0, 1, 'model-a', shas[0], 0]);
  assert.deepStrictEqual(sql(db, 'select session, kind from sessions order by session'), [['0-fork2', 'other'], ['a-fork', 'other'], ['sess-disp', 'dispatcher'], ['sess-probe', 'other'], ['sess-task', 'task']]);
  assert.deepStrictEqual(sql(db, "select start from sessions where session='sess-disp'"), [[Date.parse(T('09:00:00')) / 1000]]);
});

test('метрики §3 v1 на синтетике', (t) => {
  const { data } = fixture(t);
  const m = baseline(data, path.join(data, 'baseline', 'v1.json')).metrics;
  const val = (k) => m[k].value;
  assert.strictEqual(val('touches_per_day'), 6);               // 3 вопроса + 1 разрешение + 2 пуша за 1 день
  assert.strictEqual(val('question_interval_min'), 7);          // медиана промежутка между вопросами: 09:03 → 09:10
  assert.strictEqual(val('answer_median_min'), 1.5);
  assert.strictEqual(val('longest_no_touch_min'), 36);          // от разрешения 10:04 до конца 10:40
  assert.strictEqual(val('heavy_queue_share_pct'), 25);         // 10 из 40 мин сессии задачи
  assert.strictEqual(val('request_to_grant_sum_min'), 10.5);
  assert.deepStrictEqual(m.request_to_grant_sum_min.by_template, { 'bash:jest': 1 });
  assert.strictEqual(val('review_rounds_per_session'), 1);
  assert.strictEqual(val('first_ready_median_min'), 31);
  assert.strictEqual(val('repeats_per_week'), 1.5);             // 3 повтора за 2 недели записей
  assert.strictEqual(val('corrupt_memory_files'), 1);
  assert.strictEqual(val('start_context_kb'), 1.2);
  assert.strictEqual(val('false_blocks_per_day'), 2);           // стоп-хук на упоминании + замок на heredoc
  assert.strictEqual(val('push_gate_skips'), 0);
  assert.strictEqual(val('oom_kills'), 1);
  assert.strictEqual(val('tokens_per_task_output'), 50);        // 10 ответов по 5
  for (const k of Object.keys(m)) assert.match(m[k].command, /metrics\.py .*--metric /, k);
});

test('повтор на той же копии — тот же файл; «с даты» и «по версии»; расхождения с исследованием', (t) => {
  const { data, shas } = fixture(t);
  const a = path.join(data, 'baseline', 'a.json'), b = path.join(data, 'baseline', 'b.json');
  baseline(data, a); baseline(data, b);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));

  assert.strictEqual(baseline(data, b, '--since', '2026-10-20T10:10:00Z').window_counts.calls, 6);
  assert.strictEqual(baseline(data, b, '--from-version', shas[1]).window_counts.calls, 6);
  assert.strictEqual(baseline(data, b, '--to-version', shas[1]).window_counts.calls, 11);

  // A session that started before the window still counts whole: the path to its report is not cut at --since.
  assert.strictEqual(baseline(data, b, '--since', '2026-10-20T10:10:00Z').metrics.first_ready_median_min.value, 31);
  // The user's name comes from the copy's config (or --user-re), never from the code: a «Ждёт:» naming them is theirs.
  assert.strictEqual(baseline(data, b, '--user-re', 'разрешени').metrics.heavy_queue_share_pct.value, 0);
  write(path.join(data, 'analytics', 'user.json'), JSON.stringify({ user_re: 'разрешени' }));
  assert.strictEqual(baseline(data, b).metrics.heavy_queue_share_pct.value, 0);
  fs.rmSync(path.join(data, 'analytics', 'user.json'));

  write(path.join(data, 'baseline', 'research-2026-11-04.json'),
    JSON.stringify({ review_rounds_per_session: { value: 2.5, source: 'review_cycles.py' } }));
  const d = baseline(data, b).discrepancies;
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].metric, 'review_rounds_per_session');
  assert.strictEqual(d[0].research, 2.5);
  assert.strictEqual(d[0].recomputed, 1);
  assert.match(d[0].command, /--metric review_rounds_per_session/);
});

test('shell-flags: пуш и запуск grant.cjs — по разбору shell, без зависаний', () => {
  const cases = [
    ['git push origin T-1', 1, 0], ['cd /r && git -C /r push', 1, 0], ['( git push )', 1, 0], ['A=1 git -c x=y push', 1, 0],
    ['git stash push -u -m x', 0, 0], ['git -C /r add a/push-gate.md', 0, 0], ['git commit -m "fix push gate"', 0, 0],
    ['git config --get push.default', 0, 0], ['echo "git push later"', 0, 0], ['cat <<EOF\ngit push\nEOF', 0, 0], ['# git push', 0, 0],
    ['node /h/grant.cjs /p grant heavy T-1 30', 0, 1], ['N=/c/node.exe; "$N" /h/grant.cjs a', 0, 1], ['head -40 grant.cjs', 0, 0],
    ['G=/h/grant.cjs; P=/p; node $G $P release heavy T-1', 0, 1], ['G="node /h/grant.cjs /p"; $G release heavy T-1', 0, 1], ['G=/h/grant.cjs; node ${G} a', 0, 1],
    ['G=/h/grant.cjs; head -5 $G', 0, 0], ['node --check grant.cjs', 0, 0], ['node --check --trace-warnings grant.cjs', 0, 0], ['wc -l /h/grant.cjs', 0, 0],
  ];
  const r = spawnSync('node', [path.join(DIR, 'shell-flags.cjs')], { input: JSON.stringify(cases.map((c) => c[0])), encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(r.status, 0, r.error ? String(r.error) : r.stderr);
  const got = JSON.parse(r.stdout);
  cases.forEach(([cmd, push, grant], k) => assert.deepStrictEqual([got[k].push, got[k].grant], [push, grant], cmd));
});
