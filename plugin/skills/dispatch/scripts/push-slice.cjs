#!/usr/bin/env node
// push-slice — the only way the dispatcher pushes (slice 18); a bare `git push` inside the hub is denied by the
// bare-push hook. Pushes the verified sha, never a moving branch, and only through the gates:
//   receipt   — the session's ready.json: three pause points (checks, review, evidence), 1–7 items each,
//               «object → observation → confirmation», every confirmation a trail the script checks on disk and in git;
//               outcome «anomaly» is a legal report («Остановлено: аномалия») — exit 4, nothing pushed;
//   branch    — its tip is the sha, its worktree is clean;
//   parallel-check — against the other branches of the wave (--wave) or, alone, against the base (--solo);
//   history   — a fast-forward of the remote branch (after a rebase — --lease <its tip>, the user's answer), no foreign authors (--foreign-ok), every commit covered by a
//               receipt (merges pass, a squash by its patch-id), no private name in any commit or its message;
//   risk      — a diff into CI, deploy, dependencies, network or secrets needs its own consent (--risk-ok <cats>).
// `verify` is the session's own check of its receipt before the report: it prints only the mismatches.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const USAGE = `usage: push-slice verify <repo> <branch> --receipt <ready.json>
       push-slice push <repo> <branch> <sha> --receipt <ready.json> [--receipt …] --base <ref> (--wave <branch>[,…] | --solo)
                  [--remote origin] [--to <remote branch>] [--risk-ok ci,deploy,deps,net,secrets] [--foreign-ok]
                  [--patterns <file>] [--lease <remote tip>] [--integration] [--dry-run]
--lease — after a rebase, by the user's own answer: replaces the remote branch only while it is still that commit.
--integration — the base branch itself after a wave (main): its own receipt not required, every new commit must be
  in a receipt's branch, a merge, or a squash of one; only for the branch --base names (origin/main → main).
exit: 0 — ok / pushed; 1 — a gate refused; 2 — usage; 3 — could not read (git failed); 4 — the receipt says
«Остановлено: аномалия».
receipt (ready.json): {"branch", "sha", "outcome": "ready" | "anomaly", "anomaly"?: "<what>",
  "pauses": {"checks": [...], "review": [...], "evidence": [...]}}, item: {"object", "observation", "confirmation"};
  confirmation — one of {"sha"}, {"file", "sha256"?}, {"output", "head"}, {"shot"}, {"review"}, {"last-full"};
  paths are relative to the receipt. checks needs a trail bound to HEAD (output+head or last-full), review — a
  reviewer report whose verdict line is «Блокирует: нет».`;

const POINTS = ['checks', 'review', 'evidence'];
const KINDS = ['sha', 'file', 'output', 'shot', 'review', 'last-full'];
const MAX_ITEMS = 7;

// Network is judged by what runs, not by the word: a line of a comment or a name in data is not a call. Docs and tests —
// never. Every kind of file: a network API, curl/wget/nc at the place of a command. Shell (scripts, CI steps,
// Dockerfile, Makefile, a file without extension) and any other file (json, conf): also a string that starts with the
// command and its arguments ('curl -fsSL …' of a YAML step, sh "curl …") and the exec form ["curl", "-…" or a URL];
// shell — # comment lines skipped. Code: also the command string of an exec/spawn/subprocess call on the line; comment
// lines skipped, code after a closed /* … */ is read. A bare name (`- curl` of a package list, "curl" in a lock file) is data, not a call.
const NET = {
  skip: /\.(md|txt|rst|adoc)$|(^|\/)(tests?|__tests__|fixtures?)\/|\.(test|spec)\.[^/]+$/,
  shell: /\.(sh|bash|zsh|ksh|fish|mk|ya?ml)$|(^|\/)(Makefile|GNUmakefile|Dockerfile[^/]*|[^/]*\.Dockerfile|Jenkinsfile|Procfile)$|(^|\/)[^/.]+$/,
  code: /\.([cm]?[jt]sx?|py|pyw|rb|go|rs|java|kts?|php|pl|pm|lua|swift|cs|scala|exs?|groovy)$/,
  hash: /\.(py|pyw|rb|pl|pm|exs?|php)$/,
  slash: /\.([cm]?[jt]sx?|go|rs|java|kts?|php|swift|cs|scala|groovy)$/,
  api: /\bfetch\s*\(|\baxios\b|\brequire\(\s*['"](node:)?(https?|http2|net|tls|dgram)['"]\s*\)|\bfrom\s+['"](node:)?(https?|http2|net|tls|dgram)['"]|\bnew\s+WebSocket\b|\brequests\.(get|post|put|patch|delete)\b|\burllib\b/,
  cmd: /(^|[\s;|&(`/!{])(curl|wget|nc|ncat)\s/,
  str: /['"`]([^'"`\s]*\/)?(curl|wget|nc|ncat)(['"`]|\s)/,
  strArgs: /['"`]([^'"`\s]*\/)?(curl|wget|nc|ncat)\s/,
  execForm: /\[\s*['"]([^'"\s]*\/)?(curl|wget|nc|ncat)['"]\s*,\s*['"](-|https?:)/,
  exec: /\b(exec|execSync|execFile|execFileSync|execa|execaSync|spawn|spawnSync|system|popen|Popen|run|call|check_call|check_output|getoutput|getstatusoutput)\s*\(/,
};
// A line of code without its leading closed comments, or null when the rest is a comment: //, an open /*, a JSDoc
// line « * …» (not a generator method «*items()»); a line opening with «*/» is read after it.
function codeLine(file, s) {
  if (NET.hash.test(file) && /^\s*#/.test(s)) return null;
  if (!NET.slash.test(file)) return s;
  let t = s.replace(/^\s*\*\//, '');
  for (let m; (m = /^\s*\/\*.*?\*\//.exec(t));) t = t.slice(m[0].length);
  return /^\s*(\/\/|\/\*)/.test(t) || /^\s*\*(\s|$)/.test(t) ? null : t;
}
function netCall(file, s) {
  if (NET.skip.test(file)) return false;
  const any = (t) => NET.api.test(t) || NET.cmd.test(t);
  if (NET.shell.test(file)) return !/^\s*#/.test(s) && (any(s) || NET.strArgs.test(s) || NET.execForm.test(s));
  if (NET.code.test(file)) { const t = codeLine(file, s); return t !== null && (any(t) || (NET.exec.test(t) && NET.str.test(t))); }
  return any(s) || NET.strArgs.test(s) || NET.execForm.test(s);
}

// Risk categories of a diff: by path, by added lines (line — a regexp, added — a function of the file and the line).
const RISK = {
  ci: { ru: 'ci', path: /(^|\/)\.gitlab-ci\.ya?ml$|^\.gitlab\/ci\/|^\.github\/workflows\/|^\.circleci\/|(^|\/)Jenkinsfile$|(^|\/)\.drone\.ya?ml$/ },
  deploy: { ru: 'деплой', path: /(^|\/)(Dockerfile[^/]*|[^/]*\.Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Procfile|nginx[^/]*\.conf)$|(^|\/)(deploy|k8s|kubernetes|helm|charts|ansible|terraform)\/|\.tf$/ },
  deps: { ru: 'зависимости', path: /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|requirements[^/]*\.txt|Pipfile(\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|[^/]+\.csproj)$/ },
  net: { ru: 'сеть', added: netCall },
  secrets: { ru: 'секреты', path: /(^|\/)\.env(?!\.(example|sample|template|dist)$)(\.[^/]*)?$|\.(pem|p12|pfx|key)$|(^|\/)id_(rsa|ecdsa|ed25519)$/,
    line: /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bglpat-[A-Za-z0-9_-]{20}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk_(live|test)_[A-Za-z0-9]{10,}|(api[_-]?key|secret|token|passw(or)?d)['"]?\s*[:=]\s*['"][^'"\s]{8,}['"]/i },
};
const RISK_ALIAS = Object.fromEntries(Object.entries(RISK).flatMap(([k, v]) => [[k, k], [v.ru, k]]));

class Exit extends Error { constructor(code, text) { super(text); this.code = code; } }
const fail = (text) => { throw new Exit(1, text); };
const cannot = (text) => { throw new Exit(3, `не смог: ${text}`); };

// git in the repo; the caller's GIT_DIR (a git hook up the stack) must not redirect it. Only the variables that say
// where the repository is are dropped: GIT_SSH_COMMAND, GIT_ASKPASS and the like are how the remote is reached.
const REPO_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_NAMESPACE'];
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !REPO_VARS.includes(k)));
function gitRaw(repo, args, input) {
  return spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', env: ENV, input, maxBuffer: 256 * 1024 * 1024 });
}
function git(repo, ...args) {
  const r = gitRaw(repo, args);
  if (r.status !== 0) cannot(`git ${args.join(' ')}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout.replace(/\n$/, '');
}
const commitOf = (repo, ref) => { const r = gitRaw(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]); return r.status === 0 ? r.stdout.trim() : null; };
// 0 — yes, 1 — no, anything else — git could not tell: «не смог», never «нет».
function isAncestor(repo, a, b) {
  const r = gitRaw(repo, ['merge-base', '--is-ancestor', a, b]);
  if (r.status === 0 || r.status === 1) return r.status === 0;
  return cannot(`git merge-base --is-ancestor ${short(a)} ${short(b)}: ${(r.stderr || '').trim().split('\n')[0]}`);
}
const short = (s) => String(s).slice(0, 7);

function parseArgs(argv) {
  const a = { _: [], receipts: [], wave: null, solo: false, remote: 'origin', to: null, riskOk: [], foreignOk: false, patterns: null, dryRun: false, base: null, lease: null, integration: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Exit(2, `${k} без значения\n${USAGE}`); return argv[++i]; };
    if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--receipt') a.receipts.push(path.resolve(v()));
    else if (k === '--wave') a.wave = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--solo') a.solo = true;
    else if (k === '--base') a.base = v();
    else if (k === '--remote') a.remote = v();
    else if (k === '--to') a.to = v();
    else if (k === '--risk-ok') a.riskOk.push(...v().split(',').map((s) => s.trim()).filter(Boolean));
    else if (k === '--foreign-ok') a.foreignOk = true;
    else if (k === '--patterns') a.patterns = path.resolve(v());
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--lease') a.lease = v().toLowerCase();
    else if (k === '--integration') a.integration = true;
    else if (k.startsWith('-')) throw new Exit(2, `незнакомый флаг ${k}\n${USAGE}`);
    else a._.push(k);
  }
  return a;
}

// ---- receipt ----

function readReceipt(file) {
  if (!fs.existsSync(file)) fail(`квитанция ${file} не найдена: нет доклада «готово к пушу» со следом — пушить нечего`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`квитанция ${file} не читается как JSON: ${e.message}`); }
}

// One confirmation → a mismatch text or null.
function confirm(repo, c, sha, dir) {
  const kinds = KINDS.filter((k) => c && Object.prototype.hasOwnProperty.call(c, k));
  if (kinds.length !== 1) return `подтверждение — ровно одно из ${KINDS.join(', ')}, а не ${JSON.stringify(c)}`;
  const kind = kinds[0];
  const val = c[kind];
  if (typeof val !== 'string' || !val) return `${kind}: пустое значение`;
  if (kind === 'sha') {
    const full = commitOf(repo, val);
    if (!full) return `коммита ${val} нет в репозитории`;
    return isAncestor(repo, full, sha) ? null : `коммит ${short(val)} не входит в ветку до ${short(sha)}`;
  }
  const f = path.resolve(dir, val);
  if (!fs.existsSync(f)) return `${kind}: файла ${val} нет`;
  const buf = fs.readFileSync(f);
  if (kind === 'file') {
    if (!c.sha256) return null;
    const got = require('crypto').createHash('sha256').update(buf).digest('hex');
    return got === String(c.sha256).toLowerCase() ? null : `file: ${val} изменился (sha256 ${got.slice(0, 12)}…, в квитанции ${String(c.sha256).slice(0, 12)}…)`;
  }
  if (kind === 'shot') {
    const png = buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    return png || jpg ? null : `shot: ${val} — не PNG/JPEG`;
  }
  const text = buf.toString('utf8');
  if (kind === 'output') {
    if (!c.head) return null;
    if (!sha.startsWith(String(c.head).toLowerCase()) || String(c.head).length < 7) return `output: ${val} снят на HEAD ${short(c.head)}, а квитанция на ${short(sha)} — прогон не на итоговом HEAD`;
    if (!text.includes(String(c.head).slice(0, 7))) return `output: в ${val} нет HEAD ${short(c.head)}`;
    // Red: FAIL/FAILED, TAP «not ok», ✖, «N failed/failing/error(s)», pytest ERROR and «Interrupted»; a line of a
    // passed test (✔, ✓, TAP «ok») is not a summary, whatever its name says. A counter is judged by its number: a zero
    // one («FAIL: 0», «fail 0 ·», «Errors: 0,») is dropped before the check — only when no number of its own stands in
    // front («1 failed 0 passed» stays) and the zero ends the counter («FAIL 0 of 2», «FAIL 0 x.test.js», «FAIL 0,5»
    // stay); a non-zero one («ℹ fail 2», «# fail 1», «Errors: 1», «1 fail») is red.
    const red = text.split('\n').find((raw) => {
      if (/^\s*(✔|✓|ok\b)/.test(raw)) return false;
      const l = raw.replace(/(?<!\d\s*)\b(fail(ed|ures?|ing)?|errors?)\b(\s*[:=]\s*0+(?![\w.\-/]|,\d)|\s+0+(?=\s*($|[·|;)\]]|,(?!\d))))/gi, '');
      return /(^|[\s·|=])FAIL(ED)?\b|^not ok\b|^\s*✖|(^|[^\d])[1-9]\d*\s+(fail|failed|failing|failures?|errors?)\b|^ERROR\b|\bInterrupted:/.test(l) ||
        /\bfail(ed|ures?|ing)?\b\s*[:=]?\s*[1-9]\d*(?![\w.])/i.test(l) || /\berrors?\b\s*[:=]\s*[1-9]/i.test(l);
    });
    return red ? `output: в ${val} прогон не зелёный — «${red.trim().slice(0, 80)}»` : null;
  }
  if (kind === 'review') {
    const verdicts = text.split('\n').filter((l) => /Блокирует:\s*(да|нет)/.test(l));
    if (!verdicts.length) return `review: в ${val} нет строки «Блокирует: да/нет»`;
    return /Блокирует:\s*нет/.test(verdicts[verdicts.length - 1]) ? null : `review: ${val} — «${verdicts[verdicts.length - 1].trim()}»: ревью блокирует`;
  }
  // last-full: the checks --full stamp of slice 16 ({sha, at, code, clean, base, steps}; `git rev-parse --git-path
  // hub/last-full.json` of the worktree). Valid only for the full sha of HEAD, code 0, a tree clean before the run.
  // TODO after slice 16 is merged: read it with plugin/lib/done-gate.cjs (lastFullPath, facts), not here.
  let j;
  try { j = JSON.parse(text); } catch { return `last-full: ${val} не JSON`; }
  if (!j || typeof j.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(j.sha)) return `last-full: в ${val} нет полного sha`;
  if (j.sha.toLowerCase() !== sha) return `last-full: checks --full снят на ${short(j.sha)}, а квитанция на ${short(sha)}`;
  if (j.code !== 0) return `last-full: checks --full с кодом ${JSON.stringify(j.code)}, не 0`;
  if (j.clean !== true) return 'last-full: дерево не было чистым до прогона (clean ≠ true)';
  return null;
}

// The receipt against the repo: { receipt, sha, anomaly, problems }.
function verifyReceipt(repo, file) {
  const r = readReceipt(file);
  const problems = [];
  const name = path.basename(path.dirname(file)) + '/' + path.basename(file);
  if (!r || typeof r !== 'object') return { receipt: r, sha: null, anomaly: null, problems: [`${name}: не объект`] };
  if (typeof r.branch !== 'string' || !r.branch) problems.push(`${name}: нет branch`);
  const sha = typeof r.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(r.sha) ? commitOf(repo, r.sha) : null;
  if (!sha) problems.push(`${name}: sha ${JSON.stringify(r.sha)} — нет такого коммита`);
  if (r.outcome === 'anomaly') return { receipt: r, sha, anomaly: String(r.anomaly || 'причина не названа'), problems };
  if (r.outcome !== 'ready') problems.push(`${name}: outcome ${JSON.stringify(r.outcome)} — ждём ready или anomaly`);
  if (!sha) return { receipt: r, sha, anomaly: null, problems };
  const dir = path.dirname(file);
  const pauses = r.pauses && typeof r.pauses === 'object' ? r.pauses : {};
  for (const p of POINTS) {
    const items = pauses[p];
    if (!Array.isArray(items) || !items.length) { problems.push(`${p}: точки паузы нет`); continue; }
    if (items.length > MAX_ITEMS) problems.push(`${p}: ${items.length} пунктов, больше ${MAX_ITEMS}`);
    items.forEach((it, i) => {
      const at = `${p}[${i + 1}]${it && it.object ? ` «${String(it.object).slice(0, 60)}»` : ''}`;
      if (!it || typeof it !== 'object') return problems.push(`${at}: не объект`);
      for (const f of ['object', 'observation']) if (typeof it[f] !== 'string' || !it[f].trim()) problems.push(`${at}: нет ${f}`);
      const bad = confirm(repo, it.confirmation, sha, dir);
      if (bad) problems.push(`${at}: ${bad}`);
    });
  }
  const has = (p, ok) => (pauses[p] || []).some((it) => it && it.confirmation && ok(it.confirmation));
  if (Array.isArray(pauses.checks) && !has('checks', (c) => (c.output && c.head) || c['last-full'])) problems.push('checks: нет следа прогона на итоговом HEAD (output с head или last-full)');
  if (Array.isArray(pauses.review) && !has('review', (c) => c.review)) problems.push('review: нет отчёта ревьюера (review)');
  return { receipt: r, sha, anomaly: null, problems };
}

// ---- gates of push ----

function worktreeOf(repo, branch) {
  let cur = null;
  for (const l of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
    if (l.startsWith('worktree ')) cur = l.slice(9);
    else if (l === `branch refs/heads/${branch}`) return cur;
  }
  return null;
}

function parallelGate(a, repo, branch, sha) {
  if (a.wave && a.wave.length) {
    const others = a.wave.filter((b) => b !== branch);
    if (others.length) {
      const r = spawnSync('bash', [path.join(__dirname, 'parallel-check.sh'), repo, a.base, branch, ...others], { encoding: 'utf8', env: ENV });
      const text = (r.stdout + r.stderr).trim();
      if (r.status === 1 && /^ошибка merge-tree/m.test(text)) cannot(`parallel-check: ${text}`);
      if (r.status === 1) fail(`parallel-check: ветки волны не сливаются:\n${text}`);
      if (r.status !== 0 && r.status !== 3) cannot(`parallel-check (код ${r.status}): ${text}`);
      return text;
    }
  }
  const r = gitRaw(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a.base, sha]);
  if (r.status === 1) fail(`parallel-check: КОНФЛИКТ ${branch} с ${a.base}:\n${r.stdout.trim().split('\n').slice(1).map((l) => `  ${l}`).join('\n')}`);
  if (r.status !== 0) cannot(`git merge-tree ${a.base} ${short(sha)}: ${(r.stderr || '').trim()}`);
  return `чисто ${branch} × ${a.base}`;
}

// Lines of private patterns (ERE, case-insensitive, # comments): --patterns, else .githooks/private-patterns of the
// working tree or beside git-common-dir (a worktree reads the main copy's list, as the pre-commit does).
function patternList(a, repo) {
  const top = git(repo, 'rev-parse', '--show-toplevel');
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const file = a.patterns || [path.join(top, '.githooks/private-patterns'), path.join(path.dirname(common), '.githooks/private-patterns')].find((f) => fs.existsSync(f));
  if (!file) return { file: null, res: [] };
  if (!fs.existsSync(file)) fail(`список имён ${file} не найден`);
  const res = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l)).map((l) => {
    try { return new RegExp(l, 'i'); } catch { return new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  });
  return { file, res };
}

function patchId(repo, from, to) {
  const diff = gitRaw(repo, ['diff', '--no-color', '--no-ext-diff', from, to]);
  if (diff.status !== 0) return null;
  const r = gitRaw(repo, ['patch-id', '--stable'], diff.stdout);
  return r.status === 0 ? (r.stdout.split(' ')[0] || null) : null;
}

// Paths a commit touches, from `git show` headers: a/ and b/ sides (a deletion of .gitlab-ci.yml is a CI change too).
const headerPaths = (l) => { const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l); return m ? [m[1], m[2]] : []; };

// What the push sends: commits not reachable from any head on the remote (known here). From a base the caller names
// it would miss local commits of the base that are not on the remote yet.
function historyGate(a, repo, branch, sha, to, receipts) {
  const notes = [];
  const ls = gitRaw(repo, ['ls-remote', '--heads', a.remote]);
  if (ls.status !== 0) cannot(`git ls-remote ${a.remote}: ${(ls.stderr || '').trim().split('\n')[0]}`);
  const heads = ls.stdout.split('\n').filter(Boolean).map((l) => l.split(/\s+/));
  const tip = (heads.find(([, ref]) => ref === `refs/heads/${to}`) || [])[0] || null;
  let lease = null;
  if (tip) {
    if (!commitOf(repo, tip)) fail(`история: ${a.remote}/${to} = ${short(tip)}, такого коммита здесь нет — кто-то пушил; git fetch и разобраться, не fast-forward`);
    if (!isAncestor(repo, tip, sha)) {
      if (!(a.lease && a.lease.length >= 7 && tip.startsWith(a.lease))) {
        fail(`история: ${short(sha)} — не fast-forward ${a.remote}/${to} (${short(tip)})${a.lease ? `, а --lease ${short(a.lease)} — не его вершина` : ''}; ` +
          `заменить ветку на remote (ребейз) — только по ответу пользователя: --lease ${short(tip)}`);
      }
      lease = tip;
      notes.push(`замена ${a.remote}/${to}: ${short(tip)} → ${short(sha)} (--lease)`);
    }
  }
  const known = heads.map(([h]) => h).filter((h) => commitOf(repo, h));
  const range = git(repo, 'rev-list', '--reverse', sha, ...(known.length ? ['--not', ...known] : [])).split('\n').filter(Boolean);
  if (!range.length) return { range, notes, lease, risks: [] };
  if (!a.integration) {
    // origin/main does not see unpushed commits of local main: its local branch counts as the base too.
    const local = a.base.replace(new RegExp(`^(refs/remotes/)?${a.remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '');
    const bases = [a.base, ...(local !== a.base && commitOf(repo, `refs/heads/${local}`) ? [`refs/heads/${local}`] : [])];
    const base = range.filter((c) => bases.some((b) => isAncestor(repo, c, b)));
    if (base.length) fail(`история: база ${a.base} опережает ${a.remote} — её коммиты ушли бы с веткой без своей проверки; сначала пуш базы:\n  ` +
      base.slice(0, 10).map((c) => `${short(c)} «${git(repo, 'show', '-s', '--format=%s', c)}»`).join('\n  '));
  }
  const me = (gitRaw(repo, ['config', 'user.email']).stdout || '').trim().toLowerCase();
  if (!me) cannot('user.email не задан — чужие коммиты не отличить');
  const foreign = [], uncovered = [], names = [];
  const found = {};
  const addRisk = (k, what) => { (found[k] ||= new Set()).add(what); };
  const squash = new Map();
  const { file: patFile, res: pats } = patternList(a, repo);
  for (const c of range) {
    const [email, parents, subject] = git(repo, 'show', '-s', '--format=%ae%x09%P%x09%s', c).split('\t');
    if (email.toLowerCase() !== me) foreign.push(`${short(c)} ${email} «${subject}»`);
    const nParents = parents.split(' ').filter(Boolean).length;
    const merge = nParents > 1;
    // --remerge-diff skips an octopus merge with a bare warning: its content would go unread.
    if (nParents > 2) fail(`история: ${short(c)} «${subject}» — октопус-мерж (3+ родителей): его содержимое скрипт не читает; мерж по одной ветке`);
    if (!merge && !receipts.some((r) => isAncestor(repo, c, r.sha))) {
      const pid = patchId(repo, `${c}^`, c);
      const hit = pid && receipts.find((r) => {
        if (!squash.has(r.sha)) { const mb = gitRaw(repo, ['merge-base', `${c}^`, r.sha]).stdout.trim(); squash.set(r.sha, mb ? patchId(repo, mb, r.sha) : null); }
        return squash.get(r.sha) === pid;
      });
      if (!hit) uncovered.push(`${short(c)} «${subject}»`);
    }
    // One read per commit: message, author, committer, file paths and lines; a merge — what it adds beyond the
    // automatic merge of its parents (--remerge-diff): its parents' content is read in their own commits.
    const show = git(repo, 'show', '--format=%an <%ae>%n%cn <%ce>%n%B', '-U0', '--no-color', '--no-renames', ...(merge ? ['--remerge-diff'] : []), c).split('\n');
    let file = null, inDiff = false;
    for (const l of show) {
      if (l.startsWith('diff --git ')) {
        inDiff = true;
        const ps = headerPaths(l);
        file = ps[1] || null;
        for (const pth of ps) for (const [k, r] of Object.entries(RISK)) if (r.path && r.path.test(pth)) addRisk(k, pth);
        if (pats.length && ps.some((pth) => pats.some((p) => p.test(pth)))) names.push(`${short(c)} «${subject}»: путь ${ps[1]}`);
        continue;
      }
      if (inDiff && /^(index |--- |\+\+\+ |@@ |new file|deleted file|old mode|new mode|similarity|rename |Binary files)/.test(l)) continue;
      if (inDiff && l.startsWith('-')) continue;
      if (pats.length && pats.some((p) => p.test(l))) names.push(`${short(c)} «${subject}»: ${l.trim().slice(0, 100)}`);
      // The line without its «+»: a command from column 0 starts the line.
      if (inDiff && l.startsWith('+') && file) for (const [k, r] of Object.entries(RISK)) if (r.added ? r.added(file, l.slice(1)) : r.line && r.line.test(l.slice(1))) addRisk(k, file);
    }
  }
  if (foreign.length && !a.foreignOk) fail(`история: чужие коммиты (автор не ${me}) — назвать пользователю и спросить, затем --foreign-ok:\n  ${foreign.join('\n  ')}`);
  if (foreign.length) notes.push(`чужие коммиты (--foreign-ok): ${foreign.length}`);
  if (uncovered.length) fail(`история: коммиты без квитанции «готово к пушу» (ни в ветке квитанции, ни её сквошем):\n  ${uncovered.join('\n  ')}`);
  if (names.length) fail(`история: имя из ${patFile} в коммите, его тексте или пути — хаб публичный: мерж сквошем, промежуточные коммиты не пушить:\n  ${names.join('\n  ')}`);
  if (!patFile) notes.push('скан имён пропущен: списка private-patterns нет (--patterns <файл>)');
  return { range, notes, lease, risks: riskLines(a, found) };
}

function riskLines(a, found) {
  const ok = new Set(a.riskOk.map((x) => RISK_ALIAS[x] || x));
  const unknown = a.riskOk.filter((x) => !RISK_ALIAS[x]);
  if (unknown.length) throw new Exit(2, `--risk-ok: неизвестные категории ${unknown.join(', ')} (есть: ${Object.keys(RISK).join(', ')})`);
  const lines = Object.entries(found).map(([k, s]) => `риск: ${RISK[k].ru} — ${[...s].slice(0, 5).join(', ')}${s.size > 5 ? ` и ещё ${s.size - 5}` : ''}${ok.has(k) ? ' (согласие есть)' : ''}`);
  const missing = Object.keys(found).filter((k) => !ok.has(k));
  if (missing.length) fail(`${lines.join('\n')}\nрискованный дифф — отдельный вопрос о пуше пользователю, не волной; согласие — --risk-ok ${missing.join(',')}`);
  return lines;
}

// ---- commands ----

function cmdVerify(a) {
  const [repo, branch] = a._;
  if (!repo || !branch || a.receipts.length !== 1) throw new Exit(2, USAGE);
  const v = verifyReceipt(repo, a.receipts[0]);
  if (v.anomaly) throw new Exit(4, `Остановлено: аномалия: ${v.anomaly}`);
  const problems = [...v.problems];
  if (!v.receipt || typeof v.receipt !== 'object') fail(problems.map((p) => `расхождение: ${p}`).join('\n'));
  if (v.receipt.branch !== branch) problems.push(`квитанция ветки ${v.receipt.branch}, а не ${branch}`);
  const tip = commitOf(repo, `refs/heads/${branch}`);
  if (!tip) problems.push(`ветки ${branch} нет`);
  else if (v.sha && v.sha !== tip) problems.push(`квитанция на sha ${short(v.sha)}, вершина ${branch} — ${short(tip)}: квитанция не на итоговом HEAD`);
  if (problems.length) fail(problems.map((p) => `расхождение: ${p}`).join('\n'));
  const n = POINTS.reduce((s, p) => s + v.receipt.pauses[p].length, 0);
  return `квитанция сходится: ${branch} ${short(v.sha)} · пунктов ${n}`;
}

function cmdPush(a) {
  const [repo, branch, shaArg] = a._;
  if (!repo || !branch || !shaArg || !a.base) throw new Exit(2, USAGE);
  if (!a.solo && !a.wave) throw new Exit(2, 'нужен parallel-check: --wave <ветки волны через запятую> или --solo (ветка одна — проверка слияния с --base)');
  if (!a.receipts.length) fail('нет квитанции (--receipt <ready.json>): пуш — только после доклада «готово к пушу» со следом');
  const to = a.to || branch;
  const sha = commitOf(repo, shaArg);
  if (!sha) fail(`коммита ${shaArg} нет в ${repo}`);
  if (!commitOf(repo, a.base)) fail(`--base ${a.base}: нет такой ссылки`);
  if (a.integration && a.base.replace(new RegExp(`^(refs/remotes/)?${a.remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '') !== to) {
    throw new Exit(2, `--integration — только для ветки, которую называет --base (${a.base}), а не ${to}`);
  }
  const receipts = [];
  for (const f of a.receipts) {
    const v = verifyReceipt(repo, f);
    const rb = v.receipt && typeof v.receipt === 'object' ? v.receipt.branch : null;
    if (v.anomaly) throw new Exit(4, `Остановлено: аномалия (${rb || f}): ${v.anomaly}`);
    if (rb === branch && v.sha !== sha) fail(`квитанция ${branch} на sha ${v.sha ? short(v.sha) : v.receipt.sha}, а пушим ${short(sha)} — доклад не на итоговом HEAD`);
    if (v.problems.length) fail(`квитанция ${f} не сходится:\n${v.problems.map((p) => `  ${p}`).join('\n')}`);
    receipts.push(v);
  }
  if (!a.integration && !receipts.some((v) => v.receipt.branch === branch)) {
    fail(`нет квитанции ветки ${branch}: квитанции ${receipts.map((v) => v.receipt.branch).join(', ')} — чужие; пуш среза — только по его докладу`);
  }
  const tip = commitOf(repo, `refs/heads/${branch}`);
  if (tip !== sha) fail(`вершина ${branch} — ${tip ? short(tip) : 'нет ветки'}, а пушим ${short(sha)}: ветка ушла после доклада`);
  const wt = worktreeOf(repo, branch);
  if (wt) {
    const st = gitRaw(wt, ['status', '--porcelain']);
    if (st.status !== 0) cannot(`git status в ${wt}`);
    if (st.stdout.trim()) fail(`worktree ${wt} не чист:\n${st.stdout.trim().split('\n').slice(0, 10).map((l) => `  ${l}`).join('\n')}`);
  }
  const pc = parallelGate(a, repo, branch, sha);
  const h = historyGate(a, repo, branch, sha, to, receipts);
  if (!h.range.length) return [pc, `нечего пушить: ${a.remote}/${to} уже ${short(sha)}`].join('\n');
  const head = [pc, ...h.notes, ...h.risks];
  if (a.dryRun) return [...head, `ворота пройдены, --dry-run: не пушу ${short(sha)} → ${a.remote}/${to} (${h.range.length} коммитов)`].join('\n');
  const p = gitRaw(repo, ['push', ...(h.lease ? [`--force-with-lease=refs/heads/${to}:${h.lease}`] : []), a.remote, `${sha}:refs/heads/${to}`]);
  if (p.status !== 0) cannot(`git push: ${(p.stderr || '').trim()}`);
  return [...head, `запушено ${short(sha)} → ${a.remote}/${to} (${h.range.length} коммитов)`].join('\n');
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.help) return { code: 0, out: USAGE };
  const cmd = a._.shift();
  if (cmd === 'verify') return { code: 0, out: cmdVerify(a) };
  if (cmd === 'push') return { code: 0, out: cmdPush(a) };
  throw new Exit(2, USAGE);
}

if (require.main === module) {
  let res;
  try { res = main(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof Exit)) { process.stderr.write(`push-slice: ${e.stack || e}\n`); process.exitCode = 3; return; }
    res = { code: e.code, err: e.message };
  }
  if (res.out) process.stdout.write(res.out + '\n');
  if (res.err) process.stderr.write(res.err + '\n');
  process.exitCode = res.code;
}

module.exports = { verifyReceipt, RISK, main };
