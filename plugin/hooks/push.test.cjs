// bare-push (push.cjs + pretool.d/40-bare-push.cjs): a bare `git push` inside the hub — deny with the way through
// push-slice; push-slice itself, mentions in text and pushes outside the hub — quiet.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { barePush } = require('./push.cjs');

const HUB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bare-push-hub-')));
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bare-push-out-')));
for (const d of ['projects/demo/repo/src', 'projects/demo/worktrees/S-1', 'projects/demo/memory', 'plugin']) fs.mkdirSync(path.join(HUB, d), { recursive: true });
test.after(() => { fs.rmSync(HUB, { recursive: true, force: true }); fs.rmSync(OUT, { recursive: true, force: true }); });

const REPO = path.join(HUB, 'projects/demo/repo');
const WT = path.join(HUB, 'projects/demo/worktrees/S-1');
const ctx = { hub: HUB };
const bash = (command, cwd = REPO) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
const deny = (cmd, cwd) => {
  const res = barePush(bash(cmd, cwd), ctx);
  assert.ok(res && res.decision === 'deny', `${cmd} @ ${cwd || REPO}: ждали deny, вышло ${JSON.stringify(res)}`);
  assert.match(res.reason, /^Хаб \(bare-push\)/);
  assert.match(res.reason, /push-slice/);
  return res;
};
const quiet = (cmd, cwd) => assert.strictEqual(barePush(bash(cmd, cwd), ctx), null, `${cmd} @ ${cwd || REPO}`);

test('bare-push: git push from the dispatcher folders — project repo, hub root, a worktree — deny', () => {
  deny('git push origin main');
  deny('git push origin main', HUB);
  deny('git push -u origin S-1', WT);
  deny('git -C src push', REPO);
  deny(`git -C ${REPO} push origin HEAD:refs/heads/x`, OUT);
  deny(`cd ${REPO} && git push`, OUT);
  deny('git push --force-with-lease=main:abc origin main');
  deny('FOO=1 git -c push.default=current push');
  deny('bash -c "git push origin main"');
  deny('git fetch origin && git push origin main');
});

test('bare-push: what cannot be known before the run is judged by text — eval with push denies', () => {
  deny('eval "git push $REMOTE"');
  deny('git -C "$DIR" push origin main', REPO);
});

test('bare-push: push-slice, dry runs, mentions and other git — quiet', () => {
  quiet(`node ${HUB}/plugin/skills/dispatch/scripts/push-slice.cjs push ${REPO} S-1 abc --receipt r.json --solo --base main`);
  quiet('git push --dry-run origin main');
  quiet('git push -n origin main');
  quiet('git commit -m "git push later"');
  quiet('echo git push origin main');
  quiet('grep -n "git push" docs/*.md');
  quiet('git log origin/main..main');
  quiet('git fetch origin');
  quiet('git stash push -m "red tests" -- a.ts');
  quiet('git stash push -m "x $(date)" -- a.ts'); // a substitution — the text fallback must not read «stash push» as a push
  quiet("cat >> notes.md <<'EOF'\ngit push origin main\nEOF");
});

test('bare-push: outside the hub — quiet, whatever the command', () => {
  quiet('git push origin main', OUT);
  quiet(`git -C ${OUT} push origin main`, REPO);
  quiet(`cd ${OUT} && git push`, REPO);
});

test('bare-push: other tools are not looked at', () => {
  assert.strictEqual(barePush({ tool_name: 'Edit', cwd: REPO, tool_input: { file_path: path.join(REPO, 'a'), old_string: 'git push', new_string: '' } }, ctx), null);
});

test('bare-push: the command in the reason runs and prints push-slice usage', () => {
  const { reason } = barePush(bash('git push origin main'), ctx);
  const cmd = reason.match(/`(node [^`]*push-slice\.cjs --help)`/);
  assert.ok(cmd, reason);
  const r = spawnSync('bash', ['-c', cmd[1]], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /push-slice push <repo>/);
});

test('bare-push: through the runner — the module is in pretool.d with its registry record', () => {
  const rec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mechanisms', 'bare-push.json'), 'utf8'));
  assert.strictEqual(rec.file, 'pretool.d/40-bare-push.cjs');
  assert.strictEqual(rec.handler, 'push');
  assert.strictEqual(rec.stage, 'canary');
  const mod = require('./pretool.d/40-bare-push.cjs');
  assert.strictEqual(mod.id, 'bare-push');
  assert.strictEqual(mod.run(bash('git push origin main'), ctx).decision, 'deny');
});

// Review round 1 (05.11): forms that slipped through.
test('bare-push: subshell cd, cd -, popd, -o -n, aliases, --git-dir, GIT_DIR, env -C, subtree, send-pack — deny', () => {
  deny('(cd /tmp) && git push origin main');
  deny('bash -c "cd /tmp" && git push origin main');
  deny('cd /tmp; cd -; git push origin main');
  deny('pushd /tmp && popd && git push origin main');
  deny('git push -o -n origin main');
  deny('git push --push-option -n origin main');
  deny('git -c alias.p=push p origin main');
  deny(`git --git-dir=${REPO}/.git push origin main`, OUT);
  deny(`git --git-dir ${REPO}/.git push origin main`, OUT);
  deny(`GIT_DIR=${REPO}/.git git push origin main`, OUT);
  deny(`env -C ${REPO} git push origin main`, OUT);
  deny('git subtree push --prefix=lib origin lib');
  deny('git send-pack origin main');
  quiet('git push -un origin main');
  quiet('git push --dry-run -o ci.skip origin main');
});
