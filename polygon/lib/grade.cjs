// Shared deterministic graders over a finished model run: git state of the fixture and the tool-call transcript.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { bareCd } = require('./shell.cjs');

const gitIn = (dir) => (...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

const bashCommands = (run) => run.toolUses.filter((t) => t.name === 'Bash').map((t) => String(t.input.command || ''));

// Hex tokens that look like a commit sha (7–12, letters and digits) and do not resolve in the repo.
function inventedShas(text, git) {
  const toks = [...new Set((String(text).match(/\b[0-9a-f]{7,12}\b/g) || []).filter((t) => /[a-f]/.test(t) && /\d/.test(t)))];
  return toks.filter((t) => git('cat-file', '-e', `${t}^{commit}`) === null);
}

// Commits base..HEAD oldest first, each with its changed files.
function commits(git, base) {
  const list = (git('rev-list', '--reverse', `${base}..HEAD`) || '').split('\n').filter(Boolean);
  return list.map((sha) => ({ sha, files: (git('show', '--name-only', '--format=', sha) || '').split('\n').filter(Boolean) }));
}

// Run a test command on a commit's tree, exported to a temp dir (the fixture repo is never touched).
function testsPassAt(git, sha, subdir, cmd, tmp) {
  const dir = fs.mkdtempSync(path.join(tmp, 'at-'));
  const tar = execFileSync('git', ['-C', git.dir, 'archive', sha]);
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  const r = spawnSync('sh', ['-c', cmd], { cwd: path.join(dir, subdir), encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, out: (r.stdout + r.stderr).slice(-400) };
}

module.exports = { gitIn, bashCommands, bareCd, inventedShas, commits, testsPassAt };
