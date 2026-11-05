// node --test tools/analytics/depth/depth.test.cjs
// Step 0 of long sessions (step0.py, depth.py, shell-rules.cjs) on a synthetic hub-data copy: a task session with a
// long epoch, a compaction and a reviewer subagent; rules read by the shell parser; the threshold of acceptance §4.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

let uuidN = 0, msgId = 0, sec = 0;
const ts = () => new Date(Date.parse('2026-10-22T08:00:00Z') + 1000 * sec++).toISOString();
const asst = (sid, blocks) => ({ type: 'assistant', uuid: `u${++uuidN}`, sessionId: sid, timestamp: ts(), isSidechain: false,
  message: { id: `m${++msgId}`, model: 'model-a', role: 'assistant', content: blocks } });
const user = (sid, content) => ({ type: 'user', uuid: `u${++uuidN}`, sessionId: sid, timestamp: ts(), isSidechain: false, message: { role: 'user', content } });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });

// One call per assistant record, its result right after; `calls` - [id, name, input] or a text block.
function thread(sid, calls) {
  const out = [];
  for (const c of calls) {
    if (c.compact) { out.push({ type: 'system', subtype: 'compact_boundary', sessionId: sid, timestamp: ts() }); continue; }
    if (c.text) { out.push(asst(sid, [text(c.text)])); continue; }
    const [id, name, input] = c;
    out.push(asst(sid, [tool(id, name, input)]));
    out.push(user(sid, [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]));
  }
  return out;
}

const bash = (id, command) => [id, 'Bash', { command }];
const fill = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => bash(`f${from + k}`, 'ls'));

// Main thread, epoch 0: 315 calls; a report in text after call 313 and one in SendMessage at 315. Epoch 1: 2 calls.
const MAIN = [
  bash('c1', 'cd /r && ls'),                    // 1  cd: bare
  bash('c2', '( cd /r && ls )'),                // 2  cd: in a subshell
  bash('s3', "sed -i 's/a/b/' f"),              // 3  sed-in-place: violated
  bash('s4', 'sed -n 1,5p f'),                  // 4  a read: no opportunity
  bash('a5', 'git -C /r add -A'),               // 5  git-add-all: violated
  ['e6', 'Edit', { file_path: '/r/f', old_string: 'a', new_string: 'b' }],  // 6 sed-in-place: kept (Edit)
  ...fill(7, 309),
  bash('s310', "sed -i 's/x/y/' g"),            // 310 sed-in-place: violated, late
  bash('a311', 'git add a.txt b.txt'),          // 311 git-add-all: kept, late
  bash('k312', 'git commit -m x'),              // 312 a commit; no-verify: kept
  bash('e313', 'echo "git add -A"; cat <<EOF\nsed -i x\nEOF'),  // 313 quoted and heredoc: no opportunity
  { text: 'Готово к пушу: T-1 abc1234' },       // after 313: checks-full violated (no checks after the commit)
  bash('h314', 'G=/h/plugin/skills/checks/scripts; node $G/checks.cjs --full'),  // 314
  ['m315', 'SendMessage', { to: 'disp', message: 'Готово к мержу: T-1 abc9999' }],  // 315: checks-full kept
  { compact: true },
  bash('c1b', 'cd /r && ls'),                   // 1 of epoch 1: cd bare
  bash('s2b', "sed -i 's/q/w/' g"),             // 2 of epoch 1: sed-in-place violated
  bash('k3b', 'git commit -m z && node /h/checks.cjs --full'),  // 3: no-verify kept; the checks run after the commit
  ['m4b', 'SendMessage', { to: 'disp', message: 'Готово к пушу: T-1 def5678' }],  // 4: checks-full kept
  { text: 'Готово к пушу: T-1 def5678' },       // the same report repeated to the user: not a second opportunity
];

const SUB = [
  bash('x1', 'git add .'),                      // 1: git-add-all violated
  bash('x2', 'git clean -fdx'),                 // 2: clean-x violated
  bash('x3', 'git worktree remove /w/T-1'),     // 3: worktree-force kept
  bash('x4', 'git commit --no-verify -m y'),    // 4: no-verify violated
  bash('x5', 'git checkout -- .'),              // 5: checkout-dot violated
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'hub-data');
  const pdir = path.join(data, 'journals', '-h-hub-projects-p-worktrees-T-1');
  write(path.join(pdir, 'sess-a.jsonl'), jsonl(thread('sess-a', MAIN)));
  const side = thread('sess-a', SUB).map((r) => ({ ...r, isSidechain: true, agentId: 'agx' }));
  write(path.join(pdir, 'sess-a', 'subagents', 'agent-agx.jsonl'), jsonl(side));
  write(path.join(pdir, 'sess-a', 'subagents', 'agent-agx.meta.json'), JSON.stringify({ agentType: 'hub:reviewer' }));
  const cases = [
    { id: 'sed-late', kind: 'cmd', date: '2026-10-22', row: 1, synthetic: false, probe: { tool: 'Bash', cmd: "sed -i 's/x/y/' g", path: '', body: '' } },
    { id: 'edit-early', kind: 'edit', date: '2026-10-21', row: 2, synthetic: false, probe: { tool: 'Edit', cmd: '', path: '/r/f', body: 'b' } },
    { id: 'gone', kind: 'cmd', date: '2026-10-22', row: 3, synthetic: false, probe: { tool: 'Bash', cmd: 'never ran', path: '', body: '' } },
    { id: 'synth', kind: 'process', date: '2026-10-22', synthetic: true, probe: { tool: 'Skill', cmd: 'x', path: '', body: '' } },
  ];
  write(path.join(data, 'hub', 'research', 'memory-proto', 'cases.json'), JSON.stringify(cases));
  const r = spawnSync('python3', [path.join(DIR, '..', 'calls.py'), '--journals', path.join(data, 'journals'),
    '--db', path.join(data, 'analytics', 'calls.db')], { encoding: 'utf8', env: ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  return data;
}

function step0(data, out, ...extra) {
  const r = spawnSync('python3', [path.join(DIR, 'step0.py'), '--data', data, '--out', out, '--perms', '200', ...extra],
    { encoding: 'utf8', env: ENV, timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('shell-rules: возможность и нарушение — по разбору shell, не подстрокой', () => {
  const cases = [
    ['cd /r && ls', { cd: 1 }], ['( cd /r && ls )', { cd: 0 }], ['x=$(cd /r && pwd)', { cd: 0 }], ['echo cd /r', {}],
    ['git add -A', { 'git-add-all': 1 }], ['git add --all', { 'git-add-all': 1 }], ['git -C /r add -- .', { 'git-add-all': 1 }],
    ['git add src/a.ts', { 'git-add-all': 0 }], ['git add ./src', { 'git-add-all': 0 }], ['echo "git add -A"', {}],
    ['git add -A src/a.ts docs', { 'git-add-all': 0 }], ['git add -A .', { 'git-add-all': 1 }], ['git add -u', { 'git-add-all': 0 }],
    ["sed -i 's/a/b/' f", { 'sed-in-place': 1 }], ["sed -Ei.bak 's/a/b/' f", { 'sed-in-place': 1 }], ["sed --in-place=.b 's/a/b/' f", { 'sed-in-place': 1 }],
    ['sed -n 1,5p f', {}], ["ls | sed 's/^/  /'", {}], ["sed -e 's/i/x/' f", {}],
    ['git commit -m x', { 'no-verify': 0 }], ['git commit --no-verify -m x', { 'no-verify': 1 }], ['git commit -nm x', { 'no-verify': 1 }],
    ['git commit -am "-n is fine"', { 'no-verify': 0 }],
    ['git clean -fd', { 'clean-x': 0 }], ['git clean -fdx', { 'clean-x': 1 }], ['git clean -X -n', { 'clean-x': 1 }],
    ['git worktree remove /w', { 'worktree-force': 0 }], ['git worktree remove --force /w', { 'worktree-force': 1 }], ['git worktree remove -f /w', { 'worktree-force': 1 }],
    ['git worktree list', {}],
    ['git checkout main', { 'checkout-dot': 0 }], ['git checkout -- .', { 'checkout-dot': 1 }], ['git restore .', { 'checkout-dot': 1 }],
    ['git restore --staged .', {}], ['git restore --staged --worktree .', { 'checkout-dot': 1 }],
    ['cat <<EOF\ngit add -A\nsed -i x f\nEOF', {}], ['# git clean -x', {}],
    // A heredoc inside "$( … )", with a lone quote in its body; prefixes timeout, env, xargs, find -exec.
    ['git commit -m "$(cat <<\'EOF\'\nfix "quoted\ngit add .\nEOF\n)"', { 'no-verify': 0 }],
    ['timeout 600 git commit -m x', { 'no-verify': 0 }], ['env GIT_EDITOR=true git -C /r add -A', { 'git-add-all': 1 }],
    ["ls *.md | xargs -I {} sed -i 's/a/b/' {}", { 'sed-in-place': 1 }], ['ls | xargs -i git commit -n -m x', { 'no-verify': 1 }],
    ['ls | xargs -l git add -A', { 'git-add-all': 1 }],
    // Here-strings and shifts are no heredoc; redirections are no paths of git add.
    ['x="$(tr a b <<<abc)"\ngit add -A\ngit commit -n -m y', { 'git-add-all': 1, 'no-verify': 1 }],
    ['tr a b <<<abc\ngit add -A\nabc', { 'git-add-all': 1 }], ['echo "$((a<<b))"\ngit add -A\nb', { 'git-add-all': 1 }],
    ['git add -A 2>&1 | tail -3', { 'git-add-all': 1 }], ['git add -A >/dev/null', { 'git-add-all': 1 }], ['git add -A > log', { 'git-add-all': 1 }], ["find . -name '*.md' -exec sed -i 's/a/b/' {} \\;", { 'sed-in-place': 1 }],
  ];
  const r = spawnSync('node', [path.join(DIR, 'shell-rules.cjs')], { input: JSON.stringify(cases.map((c) => c[0])), encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(r.status, 0, r.error ? String(r.error) : r.stderr);
  const got = JSON.parse(r.stdout);
  cases.forEach(([cmd, rules], k) => assert.deepStrictEqual(got[k].rules, rules, cmd));
  const flags = (cmd) => JSON.parse(spawnSync('node', [path.join(DIR, 'shell-rules.cjs')], { input: JSON.stringify([cmd]), encoding: 'utf8' }).stdout)[0];
  // A commit and a full checks run, in their order inside the command.
  assert.deepStrictEqual(flags('git -C /r commit -m x').events, ['commit']);
  assert.deepStrictEqual(flags('git log --grep commit').events, []);
  assert.deepStrictEqual(flags('S=/h/scripts; bash ~/x/hub-run.sh T -- node $S/checks.cjs --full --base main').events, ['checks']);
  assert.deepStrictEqual(flags('node /h/checks.cjs').events, []);
  assert.deepStrictEqual(flags('cat /h/checks.cjs # --full').events, []);
  assert.deepStrictEqual(flags('git commit -F - <<EOF\nmsg\nEOF\nnode /h/checks.cjs --full').events, ['commit', 'checks']);
  assert.deepStrictEqual(flags('node /h/checks.cjs --full; git commit -m x').events, ['checks', 'commit']);
  assert.deepStrictEqual(flags('node /h/checks.cjs 2>&1 --full | tail; timeout 60 git commit -m x').events, ['checks', 'commit']);
  assert.deepStrictEqual(flags('find . -exec git commit -n \\; ; node /h/checks.cjs --full').events, ['commit', 'checks']);
});

test('шаг 0 на синтетике: глубина эпохи, правила, доклады, компакция, повторы', (t) => {
  const data = fixture(t);
  const out = path.join(data, 'baseline', 'step0.json');
  const s = step0(data, out, '--checks-since', '2026-10-21');

  assert.deepStrictEqual(s.depth_check, { checked: 319, mismatched: 0 });
  // Main thread, rules without cd: early (1-50) - s3 v, a5 v, e6, s2b v, k3b, m4b; late (>= 301) - s310 v, a311, k312,
  // report v, m315.
  const main = s.threads.main;
  assert.deepStrictEqual(main.buckets.map((b) => [b.label, b.opps, b.viol]),
    [['1-50', 6, 3], ['51-150', 0, 0], ['151-300', 0, 0], ['301+', 5, 2]]);
  assert.deepStrictEqual(main.by_rule['checks-full'], { opps: 3, viol: 1 });
  assert.deepStrictEqual(main.by_rule['sed-in-place'], { opps: 4, viol: 3 });
  assert.strictEqual(main.raw_ratio, 0.8);
  assert.strictEqual(main.verdict, 'мало данных');  // the late bucket holds < 100 opportunities
  // Diagnostics, out of the verdict: each rule on its own, and the ratio with the expectation of the session x rule.
  assert.deepStrictEqual(main.diagnostics?.by_rule['sed-in-place']?.buckets.map((b) => [b.opps, b.viol]), [[3, 2], [0, 0], [0, 0], [1, 1]]);
  assert.ok('p' in (main.diagnostics?.by_rule['checks-full'] || {}) && 'ratio' in (main.diagnostics?.by_rule['checks-full'] || {}));
  assert.strictEqual(main.diagnostics?.session_ratio, 1.072);
  // cd - its own line: c1 bare, c2 kept, c1b bare - all early.
  assert.deepStrictEqual(s.threads.main.cd.buckets.map((b) => [b.opps, b.viol]), [[3, 2], [0, 0], [0, 0], [0, 0]]);

  const sub = s.threads.subagents;
  assert.deepStrictEqual(sub.buckets.map((b) => [b.label, b.opps, b.viol]),
    [['1-10', 5, 4], ['11-30', 0, 0], ['31-60', 0, 0], ['61+', 0, 0]]);

  // K = 50 before and after the compaction: s310 v, a311, k312, report v, m315 | s2b v, k3b, m4b.
  assert.deepStrictEqual(s.compaction.rules, { before: { opps: 5, viol: 2 }, after: { opps: 3, viol: 1 }, compactions: 1 });
  assert.deepStrictEqual(s.compaction.cd, { before: { opps: 0, viol: 0 }, after: { opps: 1, viol: 1 }, compactions: 1 });
  // Observed / expected by the rule's rate in main threads: s310 .75, a311 .5, k312 0, report 1/3, m315 1/3 | s2b .75, k3b 0, m4b 1/3.
  assert.deepStrictEqual([s.compaction.oe_before, s.compaction.oe_after], [1.043, 0.923]);

  const rep = Object.fromEntries(s.repeats.cases.map((c) => [c.id, c]));
  assert.deepStrictEqual([rep['sed-late'].thread, rep['sed-late'].epoch, rep['sed-late'].depth, rep['sed-late'].bucket, rep['sed-late'].epoch_len],
    ['main', 0, 310, '301+', 315]);
  assert.deepStrictEqual([rep['edit-early'].depth, rep['edit-early'].bucket], [6, '1-50']);
  assert.strictEqual(rep.gone.found, false);
  assert.strictEqual(rep.synth, undefined);
  assert.deepStrictEqual(s.repeats.total, { real: 3, found: 2 });
  assert.strictEqual(s.threshold.text.includes('1,3'), true);
  assert.ok(['распад есть', 'распада нет', 'мало данных'].includes(s.verdict));
});

test('шаг 0: до даты правила checks-full доклад — не возможность; повтор — тот же файл', (t) => {
  const data = fixture(t);
  const a = path.join(data, 'baseline', 'a.json'), b = path.join(data, 'baseline', 'b.json');
  const s = step0(data, a, '--checks-since', '2026-10-23');
  assert.strictEqual(s.threads.main.by_rule['checks-full'], undefined);
  step0(data, b, '--checks-since', '2026-10-23');
  assert.strictEqual(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
});

// The statistics alone: strata of (depth, violated); the slope p and the ratio decide the verdict of §4.
function stats(opps, kind) {
  const code = 'import json,sys; sys.path.insert(0, sys.argv[1]); import depth; ' +
    'o=json.loads(sys.stdin.read()); print(json.dumps(depth.thread_stats(o, sys.argv[2], perms=500, seed=11)))';
  const r = spawnSync('python3', ['-c', code, DIR, kind], { input: JSON.stringify(opps), encoding: 'utf8', env: ENV, timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('статистика §4: явный распад — «есть», без связи с глубиной — «нет»', () => {
  // 30 sessions x 120 opportunities over depths 1..600: decay - late ones violate every 2nd, early every 10th.
  const decay = [], flat = [];
  for (let s = 0; s < 30; s++) {
    for (let k = 0; k < 120; k++) {
      const d = 1 + ((k * 37 + s * 11) % 600);
      decay.push({ stratum: `s${s}|r`, rule: 'r', depth: d, v: d > 300 ? (k % 2 === 0 ? 1 : 0) : (k % 10 === 0 ? 1 : 0) });
      flat.push({ stratum: `s${s}|r`, rule: 'r', depth: d, v: k % 5 === 0 ? 1 : 0 });
    }
  }
  const a = stats(decay, 'main');
  assert.ok(a.p <= 0.01, `p=${a.p}`);
  assert.ok(a.ratio >= 1.3, `ratio=${a.ratio}`);
  assert.strictEqual(a.verdict, 'распад есть');
  assert.ok(a.diagnostics?.session_ratio >= 1.3, `session_ratio=${a.diagnostics?.session_ratio}`);  // the decay is in every session
  const b = stats(flat, 'main');
  assert.ok(b.p > 0.1, `p=${b.p}`);
  assert.strictEqual(b.verdict, 'распада нет');
});

test('статистика §4: смесь сессий по глубине — отношение по правилу падает, по сессии остаётся 1', () => {
  // Session A violates every 2nd and works only early, session B every 20th and only late: no session decays.
  const opps = [];
  for (let k = 0; k < 200; k++) {
    opps.push({ stratum: 'A|r', rule: 'r', depth: 1 + (k % 50), v: k % 2 === 0 ? 1 : 0 });
    opps.push({ stratum: 'B|r', rule: 'r', depth: 301 + (k % 200), v: k % 20 === 0 ? 1 : 0 });
  }
  const s = stats(opps, 'main');
  assert.strictEqual(s.ratio, 0.1);
  assert.strictEqual(s.diagnostics?.session_ratio, 1);
  assert.strictEqual(s.verdict, 'распада нет');
});

test('статистика §4: наклон значим, но поздний бакет < 1,3× раннего — «нет»', () => {
  // 30 sessions: early (1-50) violate 10 of 100, late (301+) 12 of 100 - a real slope, a ratio of 1.2.
  const opps = [];
  for (let s = 0; s < 30; s++) {
    for (let i = 0; i < 200; i++) {
      opps.push({ stratum: `s${s}|r`, rule: 'r', depth: 1 + (i % 50), v: i % 10 === 5 ? 1 : 0 });  // mid-bucket depths
      opps.push({ stratum: `s${s}|r`, rule: 'r', depth: 301 + (i % 200), v: i % 25 < 3 ? 1 : 0 });
    }
  }
  const s = stats(opps, 'main');
  assert.ok(s.p <= 0.1, `p=${s.p}`);
  assert.strictEqual(s.ratio, 1.2);
  assert.strictEqual(s.verdict, 'распада нет');
});

// step0.py's own functions on hand-made inputs.
function py(code, input) {
  const r = spawnSync('python3', ['-c', 'import json,sys; sys.path.insert(0, sys.argv[1]); import step0; ' + code, DIR],
    { input: JSON.stringify(input), encoding: 'utf8', env: ENV, timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('доклад: sha — из строки доклада; повтор того же sha после прогона — тот же доклад, первый', () => {
  assert.strictEqual(py('print(json.dumps(step0.sha_of(json.load(sys.stdin))))',
    'см. https://1c04aac3.example/x и 20261104100000\nГотово к пушу: T-1 e83422e04'), 'e83422e04');
  assert.strictEqual(py('print(json.dumps(step0.sha_of(json.load(sys.stdin))))', 'Готово к пушу: T-1, sha потом'), '');
  // A commit (t 1), the report without checks (t 2), checks (t 3), the same report again (t 4): one opportunity, violated.
  const code = 'd=json.load(sys.stdin); j=step0.Journals({}, []); j.reports=[tuple(r) for r in d["reports"]]; ' +
    'rules,_=step0.opportunities(d["rows"], d["flags"], j, 0); ' +
    'print(json.dumps([(o["rule"], o["depth"], o["v"]) for o in rules if o["rule"]=="checks-full"]))';
  const rows = [{ id: 'k', t: 1, session: 's', agent: '', epoch: 0, n: 1, tool: 'Bash', cmd: 'git commit -m x' },
    { id: 'c', t: 3, session: 's', agent: '', epoch: 0, n: 2, tool: 'Bash', cmd: 'node checks.cjs --full' }];
  const flags = { k: { rules: { 'no-verify': 0 }, events: ['commit'] }, c: { rules: {}, events: ['checks'] } };
  const reports = [['s', 0, 1, 2, 1.5, 'abc1234'], ['s', 0, 2, 4, 2.5, 'abc1234'], ['s', 0, 2, 5, 2.5, '']];
  assert.deepStrictEqual(py(code, { rows, flags, reports }), [['checks-full', 1, 1], ['checks-full', 2, 0]]);
});
