// Hub version under test and the fixture mini-hub it runs in.
// The base of the hub (CLAUDE.md, plugin/, templates/) is taken from a git ref by `git archive` — no checkout, no
// branch switch — or from the live working tree. Everything else (projects, memory, repos) is synthetic.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_PATHS = ['CLAUDE.md', 'plugin', 'templates'];

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// Materialise the hub base into dest. ref === null → the working tree of hubDir as is.
function materialize(hubDir, ref, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (!ref) {
    for (const p of BASE_PATHS) {
      const src = path.join(hubDir, p);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, p), { recursive: true });
    }
    return { ref: 'worktree', sha: sh('git', ['-C', hubDir, 'rev-parse', '--short', 'HEAD']).trim() + '+wt' };
  }
  const sha = sh('git', ['-C', hubDir, 'rev-parse', '--short', ref]).trim();
  const present = BASE_PATHS.filter((p) => {
    try { sh('git', ['-C', hubDir, 'cat-file', '-e', `${ref}:${p}`]); return true; } catch { return false; }
  });
  const tar = execFileSync('git', ['-C', hubDir, 'archive', ref, ...present], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dest], { input: tar });
  return { ref, sha };
}

function tmpdir(root, prefix) {
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

// A git repo with a fixed identity; files: {relPath: content}. Returns a small git helper.
function gitRepo(dir, files = {}, message = 'init') {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => sh('git', ['-C', dir, ...a]).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'eval@example.test');
  git('config', 'user.name', 'eval');
  git('config', 'commit.gpgsign', 'false');
  writeFiles(dir, files);
  if (Object.keys(files).length) { git('add', '--', ...Object.keys(files)); git('commit', '-q', '-m', message); }
  return git;
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
}

// Fixture mini-hub: <root>/hub = base of the version under test + synthetic CLAUDE.local.md and projects/<name>/.
// project: { claude, memory: {file: content}, extra: {relPath: content} } — memory falls back to the version's template.
function makeHub(baseDir, root, { name = 'demo', claude, memory = {}, extra = {} } = {}) {
  const hub = path.join(root, 'hub');
  fs.cpSync(baseDir, hub, { recursive: true });
  fs.writeFileSync(path.join(hub, 'CLAUDE.local.md'),
    '# Личное (синтетика полигона)\n\nПользователь хаба — Georgy. Отвечай по-русски.\n');
  const proj = path.join(hub, 'projects', name);
  const tmpl = path.join(hub, 'templates', 'project');
  fs.mkdirSync(path.join(proj, 'memory', 'sessions'), { recursive: true });
  if (fs.existsSync(path.join(tmpl, 'memory'))) fs.cpSync(path.join(tmpl, 'memory'), path.join(proj, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), claude || `# Проект: ${name}\n\nСинтетический проект полигона.\n`);
  writeFiles(path.join(proj, 'memory'), memory);
  writeFiles(proj, extra);
  return { hub, proj };
}

module.exports = { materialize, makeHub, gitRepo, writeFiles, tmpdir, sh, os };
