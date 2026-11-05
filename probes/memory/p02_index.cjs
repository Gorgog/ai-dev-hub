#!/usr/bin/env node
// P2: a stand-in for the memory hook — FTS5 (`unicode61`) index of memory/lessons/*.md in `node:sqlite`, rebuilt
// when the lessons changed (signature: count, newest mtime, total size), then one BM25 query.
//   node p02_index.cjs <memory-dir> [--rebuild]    stdin: {"query": "..."}  stdout: hook JSON + `_probe` timings
// The rebuild writes a temp file and renames it over index.db: readers and parallel rebuilds never see half an index.
'use strict';
const fs = require('fs');
const path = require('path');

const t0 = process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
const { DatabaseSync } = require('node:sqlite');

const [dir, flag] = process.argv.slice(2);
const lessons = path.join(dir, 'lessons');
const indexFile = path.join(dir, '.index.db');

function signature() {
  let n = 0, newest = 0, size = 0;
  for (const f of fs.readdirSync(lessons)) {
    if (!f.endsWith('.md')) continue;
    const st = fs.statSync(path.join(lessons, f), { bigint: true });
    n++; size += Number(st.size);
    if (st.mtimeNs > newest) newest = st.mtimeNs;
  }
  return `${n}:${newest}:${size}`;
}

function storedSignature() {
  if (!fs.existsSync(indexFile)) return null;
  const db = new DatabaseSync(indexFile, { readOnly: true });
  try { return db.prepare('SELECT v FROM meta WHERE k = ?').get('sig')?.v ?? null; } catch { return null; } finally { db.close(); }
}

function rebuild(sig) {
  const tmp = `${indexFile}.tmp-${process.pid}`;
  const db = new DatabaseSync(tmp);
  db.exec("CREATE VIRTUAL TABLE lessons USING fts5(id UNINDEXED, keys, body, tokenize = 'unicode61 remove_diacritics 2')");
  db.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO lessons (id, keys, body) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (const f of fs.readdirSync(lessons).sort()) {
    if (!f.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(lessons, f), 'utf8');
    const keys = (text.match(/^keys:\s*\[(.*)\]$/m) || [, ''])[1];
    ins.run(f.slice(0, -3), keys, text.replace(/^---[\s\S]*?\n---\n/, ''));
  }
  // A lesson changed while being read: keep the index, but mark it stale so the next search rebuilds again.
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('sig', signature() === sig ? sig : `stale:${sig}`);
  db.exec('COMMIT');
  db.close();
  fs.renameSync(tmp, indexFile);
}

// Words of the query as an OR of quoted terms: no FTS5 syntax from the input reaches the parser.
function ftsQuery(q) {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []).slice(0, 12);
  return words.map((w) => `"${w}"`).join(' OR ');
}

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const tSig = process.hrtime.bigint();
const sig = signature();
let rebuilt = false;
if (flag === '--rebuild' || storedSignature() !== sig) { rebuild(sig); rebuilt = true; }
const tQuery = process.hrtime.bigint();
const db = new DatabaseSync(indexFile, { readOnly: true });
const q = ftsQuery(input.query || '');
const hits = q ? db.prepare('SELECT id, bm25(lessons) AS score FROM lessons WHERE lessons MATCH ? ORDER BY score LIMIT 5').all(q) : [];
const tEnd = process.hrtime.bigint();
db.close();
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: hits.map((h) => h.id).join(', ') },
  _probe: { hits: hits.map((h) => h.id), rebuilt, startup_ms: ms(t0, tSig), check_ms: ms(tSig, tQuery),
    query_ms: ms(tQuery, tEnd), total_ms: ms(t0, tEnd) },
}) + '\n');
