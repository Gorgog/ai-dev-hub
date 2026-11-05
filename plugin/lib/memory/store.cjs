// The storage interface of memory v2 — the one door for hooks (21), skills (22), migration (23) and `recall`:
//   add (addLesson), repeat, shown, find, export (exportAll, exportV1), import (importAll);
//   status operations retire / merge / supersede, why, check, retirementCandidates.
// Source of truth — files: lessons/*.md, decisions/*.md, events/*.jsonl. Derived, rebuilt by signature (name, size,
// mtime of every source file) on every search, so a lesson another session wrote is seen without a restart:
//   .index.db       FTS5 (unicode61) in node:sqlite + the fold (entries and event counters); P2: query p95 2.6 ms,
//                   rebuild 60–160 ms — so never on PreToolUse; written to a temp file and renamed over.
//   .triggers.json  active and core lessons with compiled `when` — the only file the hot path reads.
// No node:sqlite or no FTS5 in it → the same search in JS (BM25 over the parsed files), nothing blocks.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseLesson, validateLesson, compileWhen, layer, STATUSES, KINDS } = require('./format.cjs');
const { appendEvent, readEvents, foldEvents, eventFiles } = require('./events.cjs');

const INDEX = '.index.db';
const TRIGGERS = '.triggers.json';
const INDEX_VERSION = '1';
const DIRS = ['lessons', 'decisions'];
const LIVE = ['core', 'active'];

// ---------- sources and signature ----------

const listMd = (memDir, dir) => {
  try { return fs.readdirSync(path.join(memDir, dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort(); } catch { return []; }
};

function signature(memDir, { events = true } = {}) {
  const parts = [];
  const add = (rel) => {
    try { const st = fs.statSync(path.join(memDir, rel), { bigint: true }); parts.push(`${rel}\t${st.size}\t${st.mtimeNs}`); } catch { /* gone meanwhile */ }
  };
  for (const d of DIRS) for (const f of listMd(memDir, d)) add(`${d}/${f}`);
  if (events) for (const f of eventFiles(memDir)) add(`events/${f}`);
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

// Every lesson and decision as read now. The id is the file name: a broken frontmatter still has an address.
function loadDocs(memDir) {
  const docs = [];
  for (const dir of DIRS) {
    for (const f of listMd(memDir, dir)) {
      let raw;
      try { raw = fs.readFileSync(path.join(memDir, dir, f)); } catch { continue; }
      const text = raw.toString('utf8').replace(/\u0000/g, '');
      const { meta, body } = parseLesson(text);
      const id = f.slice(0, -3);
      docs.push({
        id, dir, rel: `${dir}/${f}`, raw, meta, body,
        kind: KINDS.includes(meta.kind) ? meta.kind : null,
        status: STATUSES.includes(meta.status) ? meta.status : 'active',
        first: body[0] || '',
        keys: Array.isArray(meta.keys) ? meta.keys : [],
        sha: crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12),
      });
    }
  }
  return docs;
}

const entryOf = (d) => ({ id: d.id, dir: d.dir, kind: d.kind, status: d.status, first: d.first, sha: d.sha });
const byKey = (a, b) => (a.dir === b.dir ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.dir < b.dir ? -1 : 1);

// The fold the index must equal: entries of the files + counters of the events.
function fold(memDir) {
  return { entries: loadDocs(memDir).map(entryOf).sort(byKey), stats: foldEvents(readEvents(memDir).events) };
}

// ---------- words ----------

// Words of a query or a document: letters and digits, lower case, ё as е. A query word of 5+ letters is cut to a
// stem (Russian endings: «генерацию» finds «генерация»), shorter ones stay whole; both match as prefixes.
const words = (s) => (String(s).toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}_]+/gu) || []);
function terms(query) {
  const out = [];
  for (const w of words(query)) {
    if ([...w].length < 2) continue;
    const ch = [...w];
    const stem = ch.length >= 5 ? ch.slice(0, Math.max(4, ch.length - 2)).join('') : w;
    if (!out.includes(stem)) out.push(stem);
  }
  return out.slice(0, 16);
}
const docFields = (d) => ({ keys: `${d.id.replace(/-/g, ' ')} ${d.keys.join(' ')}`, first: d.first, body: d.body.slice(1).join(' ') });

// ---------- node:sqlite ----------

let sqliteCache;
function sqlite() {
  if (sqliteCache !== undefined) return sqliteCache;
  if (process.env.HUB_MEMORY_ENGINE === 'js') return (sqliteCache = null);
  // node 22 warns «SQLite is an experimental feature» on stderr — a hook's stderr must stay clean (P2).
  const orig = process.emitWarning;
  process.emitWarning = function (w, ...a) {
    const type = typeof a[0] === 'string' ? a[0] : a[0] && a[0].type;
    if (type === 'ExperimentalWarning' || (w && w.name === 'ExperimentalWarning')) return undefined;
    return orig.call(process, w, ...a);
  };
  try { sqliteCache = require('node:sqlite').DatabaseSync; } catch { sqliteCache = null; } finally { process.emitWarning = orig; }
  return sqliteCache;
}

function openIndex(memDir) {
  const DB = sqlite();
  const file = path.join(memDir, INDEX);
  if (!DB || !fs.existsSync(file)) return null;
  const db = new DB(file, { readOnly: true });
  return db;
}

// 'missing' | 'broken' | {sig} — what the index on disk says about itself.
function indexState(memDir) {
  if (!fs.existsSync(path.join(memDir, INDEX))) return 'missing';
  let db;
  try {
    db = openIndex(memDir);
    const get = (k) => (db.prepare('SELECT v FROM meta WHERE k = ?').get(k) || {}).v;
    if (get('version') !== INDEX_VERSION) return 'broken';
    return { sig: get('sig') };
  } catch { return 'broken'; } finally { try { db && db.close(); } catch { /* closed */ } }
}

function buildIndex(memDir, sig) {
  const DB = sqlite();
  const file = path.join(memDir, INDEX);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const docs = loadDocs(memDir);
  const stats = foldEvents(readEvents(memDir).events);
  const db = new DB(tmp);
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, keys, first, body, tokenize = 'unicode61 remove_diacritics 2');
      CREATE TABLE entries (dir TEXT, id TEXT, kind TEXT, status TEXT, first TEXT, sha TEXT, PRIMARY KEY (dir, id));
      CREATE TABLE stats (id TEXT PRIMARY KEY, shown INTEGER, "repeat" INTEGER, merged INTEGER, superseded INTEGER,
        retired INTEGER, last TEXT);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);`);
    db.exec('BEGIN');
    const insDoc = db.prepare('INSERT INTO docs (rowid, id, keys, first, body) VALUES (?, ?, ?, ?, ?)');
    const insEntry = db.prepare('INSERT INTO entries (rowid, dir, id, kind, status, first, sha) VALUES (?, ?, ?, ?, ?, ?, ?)');
    docs.forEach((d, i) => {
      const f = docFields(d);
      insDoc.run(i + 1, d.id, f.keys.replace(/ё/gi, 'е'), f.first.replace(/ё/gi, 'е'), f.body.replace(/ё/gi, 'е'));
      insEntry.run(i + 1, d.dir, d.id, d.kind, d.status, d.first, d.sha);
    });
    const insStat = db.prepare('INSERT INTO stats VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [id, s] of Object.entries(stats)) insStat.run(id, s.shown, s.repeat, s.merged, s.superseded, s.retired, s.last);
    // A source changed while it was read: keep this index, but let the next search rebuild it again.
    const now = signature(memDir);
    const meta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)');
    meta.run('sig', now === sig ? sig : `stale:${sig}`);
    meta.run('version', INDEX_VERSION);
    db.exec('COMMIT');
  } catch (e) {
    try { db.close(); } catch { /* closed */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  db.close();
  fs.renameSync(tmp, file);
}

let ftsBroken = false; // this node's SQLite has no FTS5 (or the disk refused): JS for the rest of the process

// Fresh index or a reason it is not used. {rebuilt, engine: 'fts5'|'js', ms, was: 'missing'|'broken'|'stale'|'fresh'}
function ensureIndex(memDir, { engine } = {}) {
  const t0 = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
  if (engine === 'js' || !sqlite() || ftsBroken) return { rebuilt: false, engine: 'js', ms: ms(), was: 'js' };
  const sig = signature(memDir);
  const st = indexState(memDir);
  if (typeof st === 'object' && st.sig === sig) return { rebuilt: false, engine: 'fts5', ms: ms(), was: 'fresh' };
  try { buildIndex(memDir, sig); } catch (e) {
    if (/no such module: fts5/i.test(String(e.message))) ftsBroken = true;
    return { rebuilt: false, engine: 'js', ms: ms(), was: typeof st === 'object' ? 'stale' : st, error: String(e.message) };
  }
  return { rebuilt: true, engine: 'fts5', ms: ms(), was: typeof st === 'object' ? 'stale' : st };
}

// The fold as the index holds it (null — no usable index).
function indexFold(memDir) {
  let db;
  try {
    db = openIndex(memDir);
    if (!db) return null;
    const entries = db.prepare('SELECT id, dir, kind, status, first, sha FROM entries').all().map((r) => ({ ...r })).sort(byKey);
    const stats = {};
    for (const r of db.prepare('SELECT * FROM stats').all()) {
      stats[r.id] = { shown: r.shown, repeat: r.repeat, merged: r.merged, superseded: r.superseded, retired: r.retired, last: r.last };
    }
    return { entries, stats };
  } catch { return null; } finally { try { db && db.close(); } catch { /* closed */ } }
}

// ---------- find ----------

const relFile = (memDir, dir, id) => `${path.basename(memDir)}/${dir}/${id}.md`;
const hitOf = (memDir, d, stats, score) => {
  const s = stats[d.id] || {};
  return { id: d.id, dir: d.dir, kind: d.kind, status: d.status, layer: layer(d), first: d.first,
    file: relFile(memDir, d.dir, d.id), shown: s.shown || 0, repeat: s.repeat || 0, score };
};

function findFts(memDir, ts, statuses, top) {
  const db = openIndex(memDir);
  try {
    const q = ts.map((t) => `"${t}"*`).join(' OR ');
    const rows = db.prepare(`SELECT e.id, e.dir, e.kind, e.status, e.first, bm25(docs, 0.0, 4.0, 2.0, 1.0) AS score
      FROM docs JOIN entries e ON e.rowid = docs.rowid
      WHERE docs MATCH ? AND e.status IN (${statuses.map(() => '?').join(', ')})
      ORDER BY score, e.id LIMIT ?`).all(q, ...statuses, top);
    const stat = db.prepare('SELECT shown, "repeat" FROM stats WHERE id = ?');
    return rows.map((r) => {
      const s = stat.get(r.id) || {};
      return { id: r.id, dir: r.dir, kind: r.kind, status: r.status, layer: layer(r), first: r.first,
        file: relFile(memDir, r.dir, r.id), shown: s.shown || 0, repeat: s.repeat || 0, score: -r.score };
    });
  } finally { db.close(); }
}

// BM25 over the files, the same fields and weights as the FTS5 query; a document word matches a term by prefix.
function findJs(memDir, ts, statuses, top) {
  const docs = loadDocs(memDir).filter((d) => statuses.includes(d.status));
  const stats = foldEvents(readEvents(memDir).events);
  const W = { keys: 4, first: 2, body: 1 };
  const bags = docs.map((d) => {
    const f = docFields(d);
    const bag = [];
    for (const [k, w] of Object.entries(W)) for (const x of words(f[k])) for (let i = 0; i < w; i++) bag.push(x);
    return bag;
  });
  const avg = bags.reduce((a, b) => a + b.length, 0) / Math.max(1, bags.length);
  const scores = docs.map((d, i) => {
    let s = 0;
    for (const t of ts) {
      const tf = bags[i].filter((x) => x.startsWith(t)).length;
      if (!tf) continue;
      const n = bags.filter((b) => b.some((x) => x.startsWith(t))).length;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      s += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * bags[i].length / avg));
    }
    return s;
  });
  return docs.map((d, i) => ({ d, s: scores[i] })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.d.id < b.d.id ? -1 : 1)).slice(0, top)
    .map((x) => hitOf(memDir, x.d, stats, x.s));
}

// Top-1..3 lessons and decisions for a query; the archive (retired, superseded) only with {archive: true}.
function find(memDir, query, { top = 3, archive = false, engine } = {}) {
  const ts = terms(query);
  const statuses = archive ? STATUSES : LIVE;
  const ix = ensureIndex(memDir, { engine });
  if (!ts.length) return { engine: ix.engine, hits: [], index: ix };
  if (ix.engine === 'fts5') {
    try { return { engine: 'fts5', hits: findFts(memDir, ts, statuses, top), index: ix }; } catch { /* JS below */ }
  }
  return { engine: 'js', hits: findJs(memDir, ts, statuses, top), index: ix };
}

// Near duplicates of a draft (wind-down dedup before writing a new lesson): the draft's own words as the query.
function similar(memDir, file, { top = 5 } = {}) {
  const { meta, body } = parseLesson(fs.readFileSync(file, 'utf8'));
  const self = path.basename(file, '.md');
  const q = [...(Array.isArray(meta.keys) ? meta.keys : []), ...body].join(' ');
  const r = find(memDir, q, { top: top + 1 });
  return { ...r, hits: r.hits.filter((h) => h.id !== self).slice(0, top) };
}

// ---------- write operations ----------

function lessonFile(memDir, id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id))) throw new Error(`id «${id}»: только a-z, 0-9 и дефис`);
  for (const d of DIRS) {
    const f = path.join(memDir, d, `${id}.md`);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`урок ${id} не найден в ${path.basename(memDir)}/lessons и decisions`);
}

function writeAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// One field line of the frontmatter replaced (a block list under it removed), every other byte kept.
function setField(file, key, value) {
  const text = fs.readFileSync(file, 'utf8');
  const end = text.indexOf('\n---', 4);
  if (!text.startsWith('---\n') || end < 0) throw new Error(`${path.basename(file)}: нет frontmatter`);
  const head = text.slice(0, end + 1).split('\n');
  const i = head.findIndex((l) => l.startsWith(`${key}:`));
  const line = `${key}: ${value}`;
  if (i < 0) head.splice(head.length - 1, 0, line);
  else {
    let j = i + 1;
    while (j < head.length && /^\s+\S/.test(head[j])) j++;
    head.splice(i, j - i, line);
  }
  writeAtomic(file, head.join('\n') + text.slice(end + 1));
}

const metaOf = (file) => parseLesson(fs.readFileSync(file, 'utf8')).meta;
const addr = (a = {}) => {
  const o = {};
  for (const k of ['at', 'session_id', 'agent_id', 'tool_use_id', 'epoch', 'model', 'mode', 'note']) if (a[k] !== undefined) o[k] = a[k];
  return o;
};

// add: the text is validated as the write hook would; the file is written whole (temp + rename) or not at all.
function addLesson(memDir, text, { dir = 'lessons' } = {}) {
  if (!DIRS.includes(dir)) throw new Error(`dir «${dir}»: lessons или decisions`);
  const { meta } = parseLesson(String(text));
  const id = String(meta.id || '');
  const file = path.join(memDir, dir, `${id}.md`);
  const problems = validateLesson(Buffer.from(String(text)), { file: `${path.basename(memDir)}/${dir}/${id}.md` });
  if (!problems.length && DIRS.some((d) => fs.existsSync(path.join(memDir, d, `${id}.md`)))) problems.push(`урок ${id} уже есть`);
  if (problems.length) return { ok: false, id, problems };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, String(text));
  return { ok: true, id, file, problems: [] };
}

const shown = (memDir, id, a) => appendEvent(memDir, { ...addr(a), kind: 'shown', lesson: id });
function repeat(memDir, id, a) { lessonFile(memDir, id); return appendEvent(memDir, { ...addr(a), kind: 'repeat', lesson: id }); }

function retire(memDir, id, a) {
  const f = lessonFile(memDir, id);
  if (metaOf(f).kind === 'once') throw new Error(`урок ${id} — класс «одного раза» (kind once): в отставку не уходит`);
  setField(f, 'status', 'retired');
  return appendEvent(memDir, { ...addr(a), kind: 'retired', lesson: id });
}

function absorb(memDir, old, neu, kind, a) {
  const fo = lessonFile(memDir, old), fn = lessonFile(memDir, neu);
  if (old === neu) throw new Error(`${old}: урок не сливается сам с собой`);
  const sup = metaOf(fn).supersedes;
  const list = Array.isArray(sup) ? sup : [];
  if (!list.includes(old)) setField(fn, 'supersedes', `[${[...list, old].join(', ')}]`);
  setField(fo, 'status', 'superseded');
  return appendEvent(memDir, { ...addr(a), kind, lesson: old, into: neu });
}
// merge: `from` goes into `into` (its text is the agent's Edit); supersede: `old` is replaced by the new lesson.
const merge = (memDir, from, into, a) => absorb(memDir, from, into, 'merged', a);
const supersede = (memDir, old, neu, a) => absorb(memDir, old, neu, 'superseded', a);

// why: the lesson, its file, and every event about it — when and to whom it was shown, repeats, where it went.
function why(memDir, id) {
  const f = lessonFile(memDir, id);
  const dir = path.basename(path.dirname(f));
  return { id, file: relFile(memDir, dir, id), lesson: parseLesson(fs.readFileSync(f, 'utf8')),
    events: readEvents(memDir).events.filter((e) => e.lesson === id) };
}

// ---------- triggers (the hot path's only file) ----------

function readTriggers(memDir) {
  try { return JSON.parse(fs.readFileSync(path.join(memDir, TRIGGERS), 'utf8')); } catch { return { version: 1, sig: null, lessons: [] }; }
}

function ensureTriggers(memDir) {
  const sig = signature(memDir, { events: false });
  const cur = readTriggers(memDir);
  if (cur.sig === sig) return { rebuilt: false, count: cur.lessons.length };
  const lessons = loadDocs(memDir)
    .filter((d) => d.dir === 'lessons' && LIVE.includes(d.status) && Array.isArray(d.meta.when) && d.meta.when.length)
    .filter((d) => !compileWhen(d.meta.when).problems.length)
    .map((d) => ({ id: d.id, kind: d.kind, layer: layer(d), first: d.first, when: d.meta.when }));
  const now = signature(memDir, { events: false });
  const file = path.join(memDir, TRIGGERS);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sig: now === sig ? sig : `stale:${sig}`, lessons })}\n`);
  fs.renameSync(tmp, file);
  return { rebuilt: true, count: lessons.length };
}

// ---------- check (SessionStart preflight, slice 21) ----------

// Every problem named with its file; nothing here throws or blocks: the index is rebuilt, broken lines are skipped.
function check(memDir) {
  const problems = [];
  const seen = new Map();
  for (const d of loadDocs(memDir)) {
    for (const p of validateLesson(d.raw, { file: `${path.basename(memDir)}/${d.rel}` })) problems.push(`${d.rel}: ${p}`);
    if (seen.has(d.id)) problems.push(`${d.rel}: id ${d.id} уже есть в ${seen.get(d.id)}`);
    seen.set(d.id, d.rel);
  }
  problems.push(...readEvents(memDir).problems);
  const st = indexState(memDir);
  const ix = ensureIndex(memDir);
  if (st === 'broken') problems.push(`индекс ${INDEX} битый — пересобран за ${Math.round(ix.ms)} мс`);
  else if (st === 'missing' && ix.rebuilt) problems.push(`индекса ${INDEX} не было — собран за ${Math.round(ix.ms)} мс`);
  if (ix.error) problems.push(`индекс не собран (${ix.error}) — поиск на JS`);
  let tr;
  try { tr = ensureTriggers(memDir); } catch (e) { problems.push(`${TRIGGERS} не записан: ${e.message}`); }
  return { problems, index: ix, triggers: tr };
}

// ---------- export / import ----------

const SOURCE_RE = /^(lessons|decisions|events)\/[^/\\]+$/;

function exportAll(memDir) {
  const files = [];
  for (const d of [...DIRS, 'events']) {
    let names = [];
    try { names = fs.readdirSync(path.join(memDir, d)).filter((f) => !f.startsWith('.')).sort(); } catch { continue; }
    for (const f of names) {
      const p = path.join(memDir, d, f);
      if (!fs.statSync(p).isFile()) continue;
      const buf = fs.readFileSync(p);
      let utf8 = true;
      try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { utf8 = false; }
      files.push({ path: `${d}/${f}`, enc: utf8 ? 'utf8' : 'base64', data: buf.toString(utf8 ? 'utf8' : 'base64') });
    }
  }
  return { format: 'hub-memory/1', files };
}

function importAll(memDir, bundle) {
  if (!bundle || bundle.format !== 'hub-memory/1' || !Array.isArray(bundle.files)) throw new Error('не экспорт памяти hub-memory/1');
  for (const f of bundle.files) {
    if (!SOURCE_RE.test(String(f.path)) || String(f.path).includes('..')) throw new Error(`недопустимый путь в экспорте: ${f.path}`);
    if (!['utf8', 'base64'].includes(f.enc)) throw new Error(`${f.path}: кодировка ${f.enc}`);
  }
  for (const f of bundle.files) {
    const p = path.join(memDir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeAtomic(p, Buffer.from(f.data, f.enc));
  }
  return { files: bundle.files.length };
}

// v1 format — the rollback path and the double write: errors.md (one record per lesson, every status),
// errors-index.md (live lessons: «Ядро» and «По касанию» sections, lines ≤ 160, ≤ 150 lines), decisions.md.
const cut = (s, n) => ([...s].length <= n ? s : `${[...s].slice(0, n - 1).join('')}…`);
function exportV1(memDir, { name = 'проект' } = {}) {
  const docs = loadDocs(memDir).sort((a, b) => String(a.meta.created).localeCompare(String(b.meta.created)) || (a.id < b.id ? -1 : 1));
  const tag = (d) => (LIVE.includes(d.status) ? '' : `, ${d.status}`);
  const rec = (d) => `- ${d.body.join(' ')} (${d.meta.created || '—'}, урок ${d.id}${tag(d)})`;
  const errors = [`# Ошибки — ${name} (экспорт памяти v2)`, '', ...docs.filter((d) => d.dir === 'lessons').map(rec), ''].join('\n');
  const decisions = [`# Решения — ${name} (экспорт памяти v2)`, '', ...docs.filter((d) => d.dir === 'decisions').map(rec), ''].join('\n');
  const sections = [['Ядро', docs.filter((d) => d.dir === 'lessons' && d.status === 'core')],
    ['По касанию', docs.filter((d) => d.dir === 'lessons' && d.status === 'active')]];
  const idx = [`# Индекс правил из ошибок — ${name}`, '',
    '<!-- экспорт памяти v2 (recall export-v1): уроки правятся в memory/lessons/, не здесь -->', ''];
  for (const [title, list] of sections) {
    if (!list.length) continue;
    let head = `## ${title} — ключи:`;
    for (const k of [...new Set(list.flatMap((d) => d.keys))]) {
      const next = `${head}${head.endsWith(':') ? ' ' : ', '}\`${k}\``;
      if ([...next].length > 160) break;
      head = next;
    }
    idx.push(head);
    for (const d of list) {
      const date = String(d.meta.created || '').slice(5);
      idx.push(`- ${cut(d.first, 160 - 5 - date.length)} (${date})`);
    }
    idx.push('');
  }
  if (idx.length > 150) {
    const rest = idx.length - 148;
    idx.splice(148, idx.length, `- … ещё ${rest} строк — memory/errors.md`, '');
  }
  return { 'errors.md': errors, 'errors-index.md': idx.join('\n'), 'decisions.md': decisions };
}

// ---------- maintenance ----------

// Retirement by the lesson's own condition: a rule (active, with or without a trigger) that has not been shown or
// repeated for `days`. Class «once», core, decisions and the archive never retire on their own.
function retirementCandidates(memDir, { days = 30, now = new Date() } = {}) {
  const stats = foldEvents(readEvents(memDir).events);
  const edge = new Date(now.getTime() - days * 864e5).toISOString();
  return loadDocs(memDir)
    .filter((d) => d.dir === 'lessons' && d.kind === 'rule' && d.status === 'active')
    .filter((d) => {
      const last = (stats[d.id] && stats[d.id].last) || (/^\d{4}-\d\d-\d\d$/.test(d.meta.created) ? `${d.meta.created}T00:00:00.000Z` : null);
      return last && last < edge;
    })
    .map((d) => d.id).sort();
}

// The memory of the hub project a cwd is in: {dir, newFormat} (newFormat — memory/lessons/ exists), or null.
function memoryDir(cwd, hub) {
  const { findProject } = require('../../hooks/lib/hub.cjs');
  const proj = hub === undefined ? findProject(cwd) : findProject(cwd, hub);
  if (!proj) return null;
  const dir = path.join(proj.dir, 'memory');
  return { dir, newFormat: fs.existsSync(path.join(dir, 'lessons')) };
}

module.exports = {
  addLesson, repeat, shown, find, similar, exportAll, importAll, exportV1,
  retire, merge, supersede, why, check, retirementCandidates,
  ensureIndex, indexFold, fold, signature, ensureTriggers, readTriggers, memoryDir, terms, INDEX, TRIGGERS,
};
