// node --test wt-db.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DIR = __dirname;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// A fake `docker` on PATH: logs every call and keeps the databases of the "container" in a file, one
// `name|comment` per line (the comment is COMMENT ON DATABASE — the owner mark).
// Understands exactly the SQL the scripts send through `docker exec <c> psql … -c <sql>`.
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
down() { echo 'Error response from daemon: container pg_sbx is not running' >&2; exit 1; }
[ -z "\${FAKE_DOCKER_DOWN-}" ] || down
# FAKE_DOCKER_DOWN_AFTER=N — the container stops after N answered calls.
if [ -n "\${FAKE_DOCKER_DOWN_AFTER-}" ]; then
  n=$(( $(cat "$FAKE_DOCKER_LOG.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_DOCKER_LOG.n"
  [ "$n" -le "$FAKE_DOCKER_DOWN_AFTER" ] || down
fi
sql=\${@: -1}
has() { cut -d'|' -f1 "$FAKE_DOCKER_DBS" | grep -qx -- "$1"; }
without() { awk -F'|' -v d="$1" '$1 != d' "$FAKE_DOCKER_DBS" > "$FAKE_DOCKER_DBS.new"; mv "$FAKE_DOCKER_DBS.new" "$FAKE_DOCKER_DBS"; }
case "$sql" in
  "SELECT datname || '|' || coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database") cat "$FAKE_DOCKER_DBS" ;;
  "CREATE DATABASE "*)
    [ -z "\${FAKE_DOCKER_FAIL-}" ] || { echo 'ERROR:  source database "tpl" is being accessed by other users' >&2; exit 1; }
    db=$(printf '%s' "$sql" | sed -E 's/^CREATE DATABASE "([^"]+)".*/\\1/')
    tpl=$(printf '%s' "$sql" | sed -E 's/.* TEMPLATE "([^"]+)".*/\\1/')
    has "$tpl" || { echo "ERROR:  template database \\"$tpl\\" does not exist" >&2; exit 1; }
    has "$db" && { echo "ERROR:  database \\"$db\\" already exists" >&2; exit 1; }
    echo "$db|" >> "$FAKE_DOCKER_DBS"; echo 'CREATE DATABASE' ;;
  "COMMENT ON DATABASE "*)
    [ -z "\${FAKE_DOCKER_NOCOMMENT-}" ] || { echo 'server closed the connection unexpectedly' >&2; exit 2; }
    db=$(printf '%s' "$sql" | sed -E 's/^COMMENT ON DATABASE "([^"]+)" IS .*/\\1/')
    c=$(printf '%s' "$sql" | sed -E "s/^[^']*'(.*)'$/\\\\1/; s/''/'/g")
    has "$db" || { echo "ERROR:  database \\"$db\\" does not exist" >&2; exit 1; }
    without "$db"; echo "$db|$c" >> "$FAKE_DOCKER_DBS"; echo 'COMMENT' ;;
  "DROP DATABASE IF EXISTS "*)
    [ -z "\${FAKE_DOCKER_NODROP-}" ] || { echo 'ERROR:  database is being accessed by other users' >&2; exit 1; }
    db=$(printf '%s' "$sql" | sed -E 's/^DROP DATABASE IF EXISTS "([^"]+)".*/\\1/')
    without "$db"; echo 'DROP DATABASE' ;;
  *) echo "fake docker: unknown call: $*" >&2; exit 9 ;;
esac
`;

const SECTION = `
## Тестовая БД
- контейнер: \`pg_sbx\`
- пользователь: \`sbx\`
- шаблон: \`sbx\`
- переменная: \`DATABASE_URL\`
- адрес: \`postgresql://sbx:secret@127.0.0.1:5544/{db}\`
- префикс: \`wt_\`
- тесты: \`node -e "console.log('TESTS ' + process.env.DATABASE_URL)"\`
`;

// The hub layout the scripts rely on: <hub>/projects/<name>/{repo,worktrees,dispatch-profile.md}, plus a bare origin.
// `dbs` — names already in the container (a leftover of this project: h.addDb(name, h.mark)). h.project() adds a
// second project to the same hub and the same container.
function hub(t, { section = true, dbs = ['postgres', 'sbx'], name = 'p' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtdb-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  const log = path.join(root, 'docker.log'), dbFile = path.join(root, 'dbs');
  fs.writeFileSync(log, '');
  fs.writeFileSync(dbFile, dbs.map((d) => `${d}|\n`).join(''));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, FAKE_DOCKER_DBS: dbFile };
  const sh = (script, args, extra = {}) =>
    spawnSync('bash', [path.join(DIR, script), ...args], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 30000 });
  const project = (pname, profile = section ? SECTION : '') => {
    const proj = path.join(root, 'hub', 'projects', pname);
    const repo = path.join(proj, 'repo'), wts = path.join(proj, 'worktrees'), origin = path.join(root, `${pname}.git`);
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(proj, 'dispatch-profile.md'), `# Профиль диспетчера — ${pname}\n\n## Пути\n- repo: x\n${profile}\n## Лимиты\n- 7\n`);
    git(root, 'init', '-q', '--bare', origin);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, '.env.test'), 'DATABASE_URL="postgresql://sbx:secret@127.0.0.1:5544/sbx"\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', 'origin', 'main');
    return { repo, wts, mark: `hub-wt:${wts}`, newWt: (br) => sh('wt-new.sh', [repo, wts, br, 'main']) };
  };
  return {
    ...project(name), sh, project,
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    dbs: () => fs.readFileSync(dbFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')[0]),
    owner: (db) => (fs.readFileSync(dbFile, 'utf8').split('\n').find((l) => l.startsWith(`${db}|`)) || '').split('|')[1],
    addDb: (db, mark = '') => fs.appendFileSync(dbFile, `${db}|${mark}\n`),
  };
}

test('wt-db: without the profile section wt-new and wt-remove never call docker and say nothing about a database', (t) => {
  const h = hub(t, { section: false });
  const made = h.newWt('TASK-1');
  assert.strictEqual(made.status, 0, made.stdout + made.stderr);
  assert.doesNotMatch(made.stdout + made.stderr, /БД|wt-db/);
  const gone = h.sh('wt-remove.sh', [h.repo, path.join(h.wts, 'TASK-1')]);
  assert.strictEqual(gone.status, 0, gone.stdout + gone.stderr);
  assert.doesNotMatch(gone.stdout + gone.stderr, /БД|wt-db/);
  assert.deepStrictEqual(h.calls(), []);
  assert.ok(!fs.existsSync(path.join(h.wts, 'TASK-1')));
});

test('wt-db: without the section run passes the command through untouched; orphans is a no-op', (t) => {
  const h = hub(t, { section: false });
  h.newWt('TASK-1');
  const r = h.sh('wt-db.sh', ['run', path.join(h.wts, 'TASK-1'), '--', 'node', '-e', 'console.log(process.env.DATABASE_URL ?? "unset"); process.exit(5)'],
    { DATABASE_URL: '' });
  assert.strictEqual(r.status, 5, r.stderr);
  assert.strictEqual(r.stdout, '\n');
  const o = h.sh('wt-remove.sh', ['--orphans', h.repo, h.wts]);
  assert.strictEqual(o.status, 0, o.stdout + o.stderr);
  assert.deepStrictEqual(h.calls(), []);
});

test('wt-db: a full cycle — wt-new creates the database from the template, run points the tests at it, wt-remove drops it', (t) => {
  const h = hub(t);
  const wt = path.join(h.wts, 'TASK-7');
  const made = h.newWt('TASK-7');
  assert.strictEqual(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /БД wt_task_7 создана из шаблона sbx/);
  assert.deepStrictEqual(h.dbs(), ['postgres', 'sbx', 'wt_task_7']);
  assert.match(h.calls().find((c) => c.includes('CREATE')), /^exec pg_sbx psql -U sbx -d postgres .*CREATE DATABASE "wt_task_7" TEMPLATE "sbx"$/);

  // An explicit command: the variable carries the worktree's database whatever the caller had set.
  const r = h.sh('wt-db.sh', ['run', wt, '--', 'node', '-e', 'console.log(process.env.DATABASE_URL)'],
    { DATABASE_URL: 'postgresql://sbx:secret@127.0.0.1:5544/sbx' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'postgresql://sbx:secret@127.0.0.1:5544/wt_task_7\n');
  assert.match(r.stderr, /DATABASE_URL → postgresql:\/\/sbx:\*\*\*@127\.0\.0\.1:5544\/wt_task_7/);
  assert.doesNotMatch(r.stderr, /secret/);
  // No command: the profile's test command, run inside the worktree.
  const d = h.sh('wt-db.sh', ['run', wt]);
  assert.strictEqual(d.status, 0, d.stderr);
  assert.strictEqual(d.stdout, 'TESTS postgresql://sbx:secret@127.0.0.1:5544/wt_task_7\n');

  const gone = h.sh('wt-remove.sh', [h.repo, wt]);
  assert.strictEqual(gone.status, 0, gone.stdout + gone.stderr);
  assert.match(gone.stdout, /БД wt_task_7 удалена/);
  assert.deepStrictEqual(h.dbs(), ['postgres', 'sbx']);
  assert.match(h.calls().at(-1), /DROP DATABASE IF EXISTS "wt_task_7" WITH \(FORCE\)$/);
  // The project's repository is untouched by the whole cycle.
  assert.strictEqual(git(h.repo, 'status', '--porcelain'), '');
});

test('wt-db: run creates a missing database (a worktree made before the section existed), and does not recreate an existing one', (t) => {
  const h = hub(t, { section: false });
  h.newWt('TASK-2');
  fs.appendFileSync(path.join(path.dirname(h.wts), 'dispatch-profile.md'), SECTION);
  const wt = path.join(h.wts, 'TASK-2');
  const once = h.sh('wt-db.sh', ['run', wt, '--', 'true']);
  assert.strictEqual(once.status, 0, once.stderr);
  assert.deepStrictEqual(h.dbs(), ['postgres', 'sbx', 'wt_task_2']);
  const twice = h.sh('wt-db.sh', ['run', wt, '--', 'true']);
  assert.strictEqual(twice.status, 0, twice.stderr);
  assert.strictEqual(h.calls().filter((c) => c.includes('CREATE DATABASE')).length, 1);
  assert.strictEqual(h.calls().filter((c) => c.includes('DROP DATABASE')).length, 0);
});

test('wt-db: a leftover database of the same worktree name is recreated from the template on wt-new', (t) => {
  const h = hub(t);
  h.addDb('wt_task_3', h.mark);
  const made = h.newWt('TASK-3');
  assert.strictEqual(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /пересоздана/);
  const sql = h.calls().map((c) => c.replace(/^.* -[A-Za-z]*c /, ''));
  assert.deepStrictEqual(sql.filter((s) => !s.includes('FROM pg_database')),
    ['DROP DATABASE IF EXISTS "wt_task_3" WITH (FORCE)', 'CREATE DATABASE "wt_task_3" TEMPLATE "sbx"',
      `COMMENT ON DATABASE "wt_task_3" IS '${h.mark}'`]);
  assert.strictEqual(h.owner('wt_task_3'), h.mark);
});

test('wt-db: a database of the same name owned by another project (or by nobody) is never dropped or used', (t) => {
  const h = hub(t);
  const q = h.project('q');
  assert.strictEqual(h.newWt('TASK-1').status, 0);
  const made = q.newWt('TASK-1');
  assert.strictEqual(made.status, 3, made.stdout + made.stderr);
  assert.match(made.stdout + made.stderr, /другого проекта|чужая/);
  for (const cmd of ['create', 'drop', 'run']) {
    const r = h.sh('wt-db.sh', [cmd, path.join(q.wts, 'TASK-1'), '--', 'true']);
    assert.strictEqual(r.status, 3, `${cmd}: ${r.stdout}${r.stderr}`);
  }
  h.addDb('wt_task_2'); // made by hand, no mark
  q.newWt('TASK-2');
  assert.deepStrictEqual(h.calls().filter((c) => c.includes('DROP')), []);
  assert.strictEqual(h.owner('wt_task_1'), h.mark);
  assert.strictEqual(h.owner('wt_task_2'), '');
});

test('wt-db: orphans of one project never touch another project in the same container, whatever the prefixes', (t) => {
  const h = hub(t, { name: 'shop', section: false });
  fs.appendFileSync(path.join(path.dirname(h.wts), 'dispatch-profile.md'), SECTION.replace(/^- префикс:.*\n/m, ''));
  const m = h.project('shop-admin', SECTION.replace(/^- префикс:.*\n/m, ''));
  assert.strictEqual(m.newWt('TASK-1').status, 0);
  assert.strictEqual(m.newWt('feat/x').status, 0);
  assert.ok(h.dbs().includes('wt_shop_admin_task_1') && h.dbs().includes('wt_shop_admin_feat_x'), h.dbs().join(' '));
  const list = h.sh('wt-db.sh', ['orphans', h.repo, h.wts]);
  assert.strictEqual(list.stdout, '', list.stderr);
  const drop = h.sh('wt-remove.sh', ['--orphans', h.repo, h.wts]);
  assert.strictEqual(drop.status, 0, drop.stdout + drop.stderr);
  assert.deepStrictEqual(h.calls().filter((c) => c.includes('DROP')), []);
});

test('wt-db: orphans with a working but wrong repo keeps the live worktrees of a branch with a slash', (t) => {
  const h = hub(t);
  const q = h.project('q');
  assert.strictEqual(h.newWt('feat/x').status, 0);
  const r = h.sh('wt-db.sh', ['orphans', q.repo, h.wts]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
});

test('wt-db: a failed create keeps the worktree, exits 3 and names the cause and the retry', (t) => {
  const h = hub(t);
  const made = h.sh('wt-new.sh', [h.repo, h.wts, 'TASK-4', 'main'], { FAKE_DOCKER_FAIL: '1' });
  assert.strictEqual(made.status, 3, made.stdout + made.stderr);
  assert.match(made.stdout + made.stderr, /being accessed by other users/);
  assert.match(made.stdout + made.stderr, /wt-db\.sh create /);
  assert.ok(fs.existsSync(path.join(h.wts, 'TASK-4', '.env.test')));
});

test('wt-db: orphans drops only this project\'s marked databases with no worktree — never the template, a live worktree, an unmarked one or another prefix', (t) => {
  const h = hub(t, { dbs: ['postgres', 'sbx', 'wt_foreign', 'wtx_other', 'app'] });
  h.addDb('wt_task_1', h.mark); h.addDb('wt_gone', h.mark);
  h.newWt('TASK-1'); // recreates the leftover wt_task_1: it has a worktree now
  const list = h.sh('wt-db.sh', ['orphans', h.repo, h.wts]);
  assert.strictEqual(list.status, 0, list.stderr);
  assert.strictEqual(list.stdout, 'wt_gone\n');
  assert.ok(h.dbs().includes('wt_gone'), 'listing alone drops nothing');
  const drop = h.sh('wt-remove.sh', ['--orphans', h.repo, h.wts]);
  assert.strictEqual(drop.status, 0, drop.stdout + drop.stderr);
  assert.deepStrictEqual(h.dbs().sort(), ['app', 'postgres', 'sbx', 'wt_foreign', 'wt_task_1', 'wtx_other']);
});

test('wt-db: a template under the prefix is never an orphan', (t) => {
  const h = hub(t, { dbs: ['postgres', 'wt_template'] });
  h.addDb('wt_gone', h.mark);
  fs.writeFileSync(path.join(path.dirname(h.wts), 'dispatch-profile.md'), SECTION.replace('шаблон: `sbx`', 'шаблон: `wt_template`'));
  const drop = h.sh('wt-remove.sh', ['--orphans', h.repo, h.wts]);
  assert.strictEqual(drop.status, 0, drop.stdout + drop.stderr);
  assert.deepStrictEqual(h.dbs(), ['postgres', 'wt_template']);
});

test('wt-db: a section without a required key or with an empty prefix is refused before any docker call', (t) => {
  for (const [what, profile] of [
    ['no address', SECTION.replace(/^- адрес:.*\n/m, '')],
    ['address without {db}', SECTION.replace('/{db}', '/sbx')],
    ['empty prefix', SECTION.replace('префикс: `wt_`', 'префикс: ``')],
    ['prefix with a quote', SECTION.replace('префикс: `wt_`', 'префикс: `w"t`')],
  ]) {
    const h = hub(t, { section: false });
    h.newWt('TASK-5');
    fs.appendFileSync(path.join(path.dirname(h.wts), 'dispatch-profile.md'), profile);
    const r = h.sh('wt-db.sh', ['create', path.join(h.wts, 'TASK-5')]);
    assert.strictEqual(r.status, 2, `${what}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Тестовая БД/, what);
    assert.deepStrictEqual(h.calls(), [], what);
  }
});

test('wt-db: the database name is the prefix plus the worktree folder, lower-cased, [a-z0-9_], at most 63 chars', (t) => {
  const h = hub(t);
  const long = `Feat.X-${'y'.repeat(80)}`;
  const n = h.sh('wt-db.sh', ['name', path.join(h.wts, long)]);
  assert.strictEqual(n.status, 0, n.stderr);
  const name = n.stdout.trim();
  assert.match(name, /^wt_feat_x_y+$/);
  assert.strictEqual(name.length, 63);
});

// --- review round 1 ---
const TEMPLATE = path.join(DIR, '..', '..', '..', '..', 'templates', 'project', 'dispatch-profile.md');
const profileOf = (h) => path.join(path.dirname(h.wts), 'dispatch-profile.md');
const drops = (h) => h.calls().filter((c) => c.includes('DROP'));

test('wt-db: the profile template as /hub:new-project copies it keeps the mechanism off', (t) => {
  const h = hub(t, { section: false });
  fs.copyFileSync(TEMPLATE, profileOf(h));
  const made = h.newWt('TASK-1');
  assert.strictEqual(made.status, 0, made.stdout + made.stderr);
  const gone = h.sh('wt-remove.sh', [h.repo, path.join(h.wts, 'TASK-1')]);
  assert.strictEqual(gone.status, 0, gone.stdout + gone.stderr);
  assert.deepStrictEqual(h.calls(), []);
});

test('wt-db: the template enabled as it says (heading renamed, placeholders filled, notes kept) parses to the values', (t) => {
  const h = hub(t, { section: false });
  const fill = { контейнер: 'pg_sbx', пользователь: 'sbx', шаблон: 'sbx', переменная: 'DATABASE_URL',
    адрес: 'postgresql://sbx:secret@127.0.0.1:5544/{db}', тесты: 'node -e "console.log(1)"' };
  const lines = fs.readFileSync(TEMPLATE, 'utf8').split('\n');
  const head = lines.findIndex((l) => l.startsWith('## Тестовая БД'));
  assert.ok(head >= 0, 'the template has the section, switched off');
  assert.notStrictEqual(lines[head].trim(), '## Тестовая БД', 'switched off by its heading');
  lines[head] = '## Тестовая БД';
  const out = lines.map((l) => l.replace(/^- ([^:]+): `[^`]*`/, (m, k) => (k in fill ? `- ${k}: \`${fill[k]}\`` : m)));
  fs.writeFileSync(profileOf(h), out.join('\n'));
  const made = h.newWt('TASK-1');
  assert.strictEqual(made.status, 0, made.stdout + made.stderr);
  assert.match(h.calls().find((c) => c.includes('CREATE')), /^exec pg_sbx psql -U sbx -d postgres .*CREATE DATABASE "wt_p_task_1" TEMPLATE "sbx"$/);
  const r = h.sh('wt-db.sh', ['run', path.join(h.wts, 'TASK-1'), '--', 'node', '-e', 'console.log(process.env.DATABASE_URL)']);
  assert.strictEqual(r.stdout, 'postgresql://sbx:secret@127.0.0.1:5544/wt_p_task_1\n', r.stderr);
});

test('wt-db: an enabled section with a placeholder left is refused before any docker call', (t) => {
  const h = hub(t, { section: false });
  h.newWt('TASK-1');
  fs.appendFileSync(profileOf(h), SECTION.replace('`pg_sbx`', '`<имя тестового контейнера postgres>`'));
  const r = h.sh('wt-db.sh', ['create', path.join(h.wts, 'TASK-1')]);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /контейнер/);
  assert.deepStrictEqual(h.calls(), []);
});

test('wt-db: orphans with a wrong repo or a folder that is not <project>/worktrees drops nothing and fails', (t) => {
  const h = hub(t, { dbs: ['postgres', 'sbx', 'wt_gone'] });
  h.newWt('TASK-1');
  for (const args of [[h.repo + 'x', h.wts], [h.repo, h.repo]]) {
    const r = h.sh('wt-remove.sh', ['--orphans', ...args]);
    assert.notStrictEqual(r.status, 0, `${args}: ${r.stdout}${r.stderr}`);
    assert.deepStrictEqual(drops(h), [], `${args}`);
  }
  assert.ok(h.dbs().includes('wt_task_1') && h.dbs().includes('wt_gone'));
});

test('wt-db: a worktree deleted with rm -rf (git still lists it as prunable) leaves an orphan that is found', (t) => {
  const h = hub(t);
  h.newWt('TASK-2');
  fs.rmSync(path.join(h.wts, 'TASK-2'), { recursive: true, force: true });
  const r = h.sh('wt-db.sh', ['orphans', h.repo, h.wts]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'wt_task_2\n');
});

test('wt-db: run changes only the variable — the locale of the command is the caller\'s', (t) => {
  const h = hub(t);
  h.newWt('TASK-1');
  const env = { LANG: 'ru_RU.UTF-8' };
  const r = h.sh('wt-db.sh', ['run', path.join(h.wts, 'TASK-1'), '--', 'node', '-e', 'console.log(String(process.env.LC_ALL), process.env.LANG)'], env);
  assert.strictEqual(r.stdout, 'undefined ru_RU.UTF-8\n', r.stderr);
});

test('wt-db: two worktrees with one database name, or a name equal to the template, are refused — nothing is dropped', (t) => {
  const h = hub(t);
  h.newWt('TASK-1');
  fs.mkdirSync(path.join(h.wts, 'task_1'));
  const twin = h.sh('wt-db.sh', ['create', path.join(h.wts, 'task_1')]);
  assert.strictEqual(twin.status, 3, twin.stdout + twin.stderr);
  assert.match(twin.stderr, /TASK-1/);
  const dropTwin = h.sh('wt-db.sh', ['drop', path.join(h.wts, 'task_1')]);
  assert.strictEqual(dropTwin.status, 3, dropTwin.stdout + dropTwin.stderr);
  fs.writeFileSync(profileOf(h), SECTION.replace('шаблон: `sbx`', 'шаблон: `wt_template`'));
  fs.mkdirSync(path.join(h.wts, 'template'));
  for (const cmd of ['create', 'drop', 'run']) {
    const r = h.sh('wt-db.sh', [cmd, path.join(h.wts, 'template'), '--', 'true']);
    assert.strictEqual(r.status, 2, `${cmd}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /шаблон/, cmd);
  }
  assert.deepStrictEqual(drops(h), []);
  assert.ok(h.dbs().includes('wt_task_1'));
});

test('wt-db: run on a worktree folder that does not exist fails without creating a database', (t) => {
  const h = hub(t);
  const r = h.sh('wt-db.sh', ['run', path.join(h.wts, 'TASK-9')]);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.deepStrictEqual(h.calls(), []);
});

test('wt-db: the password is masked in the run line whatever its form', (t) => {
  for (const [addr, secret] of [['postgresql://u:p@ss@127.0.0.1:5544/{db}', 'p@ss'], ['postgresql://127.0.0.1:5544/{db}?user=u&password=s3cr3t', 's3cr3t']]) {
    const h = hub(t, { section: false });
    h.newWt('TASK-1');
    fs.appendFileSync(profileOf(h), SECTION.replace('postgresql://sbx:secret@127.0.0.1:5544/{db}', addr));
    const r = h.sh('wt-db.sh', ['run', path.join(h.wts, 'TASK-1'), '--', 'true']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /DATABASE_URL → /);
    assert.ok(!r.stderr.includes(secret), r.stderr);
  }
});

test('wt-db: a branch with a slash gets its database too (the worktree is <worktrees>/feat/x)', (t) => {
  const h = hub(t);
  const made = h.newWt('feat/x');
  assert.strictEqual(made.status, 0, made.stdout + made.stderr);
  assert.ok(h.dbs().includes('wt_feat_x'), made.stdout);
  const gone = h.sh('wt-remove.sh', [h.repo, path.join(h.wts, 'feat', 'x')]);
  assert.strictEqual(gone.status, 0, gone.stdout + gone.stderr);
  assert.ok(!h.dbs().includes('wt_feat_x'));
});

test('wt-db: the default prefix carries the project folder, so two projects in one container keep apart', (t) => {
  const h = hub(t);
  fs.writeFileSync(profileOf(h), SECTION.replace(/^- префикс:.*\n/m, ''));
  const n = h.sh('wt-db.sh', ['name', path.join(h.wts, 'TASK-1')]);
  assert.strictEqual(n.stdout, 'wt_p_task_1\n', n.stderr);
});

// --- review round 3 ---
test('wt-db: a stopped container is reported as such, with the retry — not as a database of another project', (t) => {
  const h = hub(t);
  assert.strictEqual(h.newWt('TASK-1').status, 0);
  for (const cmd of ['create', 'drop', 'run']) {
    const r = h.sh('wt-db.sh', [cmd, path.join(h.wts, 'TASK-1'), '--', 'true'], { FAKE_DOCKER_DOWN: '1' });
    assert.strictEqual(r.status, 3, `${cmd}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /not running/, cmd);
    assert.match(r.stderr, new RegExp(`повтор: bash .*wt-db\\.sh ${cmd} `), cmd);
    assert.doesNotMatch(r.stderr, /чужая/, cmd);
  }
});

test('wt-db: a failed owner mark drops the database it has just created, so a retry goes through', (t) => {
  const h = hub(t);
  const made = h.sh('wt-new.sh', [h.repo, h.wts, 'TASK-1', 'main'], { FAKE_DOCKER_NOCOMMENT: '1' });
  assert.strictEqual(made.status, 3, made.stdout + made.stderr);
  assert.match(made.stderr, /повтор: bash .*wt-db\.sh create /);
  assert.ok(!h.dbs().includes('wt_task_1'), 'no unmarked leftover');
  const again = h.sh('wt-db.sh', ['create', path.join(h.wts, 'TASK-1')]);
  assert.strictEqual(again.status, 0, again.stdout + again.stderr);
  assert.strictEqual(h.owner('wt_task_1'), h.mark);
});

// --- extra check after round 3 ---
test('wt-db: a container that stops between the owner check and the drop is a failure, not «already gone»', (t) => {
  const h = hub(t);
  assert.strictEqual(h.newWt('TASK-1').status, 0);
  const r = h.sh('wt-db.sh', ['drop', path.join(h.wts, 'TASK-1')], { FAKE_DOCKER_DOWN_AFTER: '1' });
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /уже нет/);
  assert.match(r.stderr, /не прочитан/);
  assert.ok(h.dbs().includes('wt_task_1'));
});

test('wt-db: mark and drop both failing says the database is left and offers no retry that cannot work', (t) => {
  const h = hub(t);
  const r = h.sh('wt-new.sh', [h.repo, h.wts, 'TASK-1', 'main'], { FAKE_DOCKER_NOCOMMENT: '1', FAKE_DOCKER_NODROP: '1' });
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /убрана/);
  assert.match(r.stderr, /снять руками: DROP DATABASE "wt_task_1"/);
  assert.doesNotMatch(r.stderr, /^повтор:/m);
});

test('wt-db: the retry line repeats the whole run command, quoted', (t) => {
  const h = hub(t);
  assert.strictEqual(h.newWt('TASK-1').status, 0);
  const r = h.sh('wt-db.sh', ['run', path.join(h.wts, 'TASK-1'), '--', 'echo', 'R A N'], { FAKE_DOCKER_DOWN: '1' });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /^повтор: bash \S*wt-db\.sh run \S*TASK-1 -- echo R\\ A\\ N$/m);
});

test('wt-db: wt-remove drops the database only after the worktree is gone; a refused removal keeps both', (t) => {
  const h = hub(t);
  const wt = path.join(h.wts, 'TASK-6');
  h.newWt('TASK-6');
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x');
  const r = h.sh('wt-remove.sh', [h.repo, wt]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(h.dbs().includes('wt_task_6'));
  assert.strictEqual(h.calls().filter((c) => c.includes('DROP')).length, 0);
});
