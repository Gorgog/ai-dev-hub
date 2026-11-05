// bare-push + push-slice: голый `git push` из папки диспетчера (repo/ проекта) и из worktree — deny; push-slice с
// квитанцией и parallel-check — проходит хук и кладёт проверенный sha в bare-origin; без квитанции или parallel-check
// push-slice отказывает и origin не меняется; упоминания пуша в тексте — тишина.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHub, gitRepo, sh } = require('../lib/hub.cjs');
const { runEvent, preToolVerdict } = require('../lib/hooks.cjs');

const SRC = 'план 18: «голый git push из папки диспетчера — deny»; acceptance §5 «пропуски ворот пуша — 0»';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function fixture(base, work) {
  const { hub, proj } = makeHub(base, work, { extra: { 'canary.json': JSON.stringify({ mechanisms: ['bare-push'] }) } });
  const repo = path.join(proj, 'repo');
  const git = gitRepo(repo, { 'src/a.js': 'module.exports = 1;\n', 'README.md': '# demo\n' });
  const origin = path.join(work, 'origin.git');
  sh('git', ['init', '-q', '--bare', origin]);
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  const wt = path.join(proj, 'worktrees', 'S-1');
  git('worktree', 'add', '-q', '-b', 'S-1', wt, 'main');
  fs.writeFileSync(path.join(wt, 'src/a.js'), 'module.exports = 2;\n');
  sh('git', ['-C', wt, 'commit', '-q', '-am', 'S-1: change']);
  const sha = sh('git', ['-C', wt, 'rev-parse', 'HEAD']).trim();
  const mem = path.join(proj, 'memory', 'S-1');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'checks-full.log'), `checks --full · HEAD ${sha}\nтесты · OK\n`);
  fs.writeFileSync(path.join(mem, 'review-1.md'), 'Блокирует: нет · CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 0\n');
  fs.writeFileSync(path.join(mem, 'shot.png'), PNG);
  const it = (object, observation, confirmation) => ({ object, observation, confirmation });
  const receipt = path.join(mem, 'ready.json');
  fs.writeFileSync(receipt, JSON.stringify({ branch: 'S-1', sha, outcome: 'ready', pauses: {
    checks: [it('checks --full', 'OK', { output: 'checks-full.log', head: sha })],
    review: [it('ревью', 'Блокирует: нет', { review: 'review-1.md' })],
    evidence: [it('Acceptance', 'скрин', { shot: 'shot.png' })],
  } }));
  return { hub, proj, repo, wt, origin, sha, receipt };
}

module.exports = {
  id: 'H34', level: 'hook', mech: 'bare-push', title: 'bare-push: голый git push — deny, push-slice — проходит',
  fixture,
  async run({ base, pluginDir, work }) {
    const fx = fixture(base, work);
    const script = path.join(pluginDir, 'skills', 'dispatch', 'scripts', 'push-slice.cjs');
    const verdict = (command, cwd = fx.repo) => preToolVerdict(runEvent(pluginDir, 'PreToolUse',
      { hook_event_name: 'PreToolUse', session_id: 'eval', cwd, tool_name: 'Bash', tool_input: { command } }, { AI_DEV_HUB: fx.hub }));
    const remote = () => sh('git', ['-C', fx.origin, 'for-each-ref', '--format=%(refname) %(objectname)']).trim();
    const ours = (v) => v.verdict === 'deny' && v.reasons.some((r) => r.includes('Хаб (bare-push)'));
    const caught = (id, command, cwd) => { const v = verdict(command, cwd); return { id, source: SRC, pass: ours(v), detail: `${v.verdict}: ${(v.reasons[0] || '').slice(0, 90)}` }; };
    const quiet = (id, command, cwd) => { const v = verdict(command, cwd); return { id, kind: 'quiet', source: SRC, pass: !ours(v), detail: v.verdict }; };
    const sliceCmd = (extra) => `node ${script} push ${fx.repo} S-1 ${fx.sha} --base main ${extra}`;
    const runSlice = (extra) => {
      const r = spawnSync('bash', ['-c', sliceCmd(extra)], { encoding: 'utf8', timeout: 60000, cwd: fx.repo });
      return { code: r.status, out: (r.stdout + r.stderr).trim().split('\n').slice(-1)[0] || '' };
    };
    const res = [
      caught('bare-push-repo', 'git push origin S-1'),
      caught('bare-push-git-C', `git -C ${fx.wt} push origin S-1`),
      caught('bare-push-worktree', 'git push -u origin S-1', fx.wt),
      caught('bare-push-subshell', 'bash -c "git push origin main"'),
      quiet('mention-commit-msg', 'git commit -m "git push после ревью"'),
      quiet('mention-grep', 'grep -rn "git push" docs'),
      quiet('dry-run', 'git push --dry-run origin S-1'),
      quiet('push-slice-hook', sliceCmd(`--receipt ${fx.receipt} --solo`)),
    ];
    // No script in the version under test (main before slice 18) — its refusals are not refusals.
    const has = fs.existsSync(script);
    const before = remote();
    const noReceipt = runSlice('--solo');
    res.push({ id: 'push-slice-no-receipt', source: SRC, pass: has && noReceipt.code === 1 && remote() === before, detail: `код ${noReceipt.code}: ${noReceipt.out.slice(0, 90)}` });
    const noCheck = runSlice(`--receipt ${fx.receipt}`);
    res.push({ id: 'push-slice-no-parallel-check', source: SRC, pass: has && noCheck.code !== 0 && remote() === before, detail: `код ${noCheck.code}: ${noCheck.out.slice(0, 90)}` });
    const ok = runSlice(`--receipt ${fx.receipt} --solo`);
    res.push({ id: 'push-slice-pushes', kind: 'quiet', source: SRC, pass: ok.code === 0 && remote().includes(`refs/heads/S-1 ${fx.sha}`), detail: `код ${ok.code}: ${ok.out.slice(0, 90)}` });
    return res;
  },
};
