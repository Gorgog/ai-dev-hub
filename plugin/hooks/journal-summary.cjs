#!/usr/bin/env node
// Summary of rules-guard's journal (projects/<name>/memory/rules-guard.log): which memory rules fired, in which
// mode, how often, the last command. A log-mode rule that fires often is a candidate to raise to deny — if none of
// its hits were false. For /hub:wind-down (since the session start) and /hub:memory-gc (whole journal).
// usage: node journal-summary.cjs <project folder> [--since <ISO time>]
'use strict';
const fs = require('fs');
const path = require('path');

function summarize(projectDir, { since, candidateAt = 3 } = {}) {
  // A moment, not a string: «07:00+03:00» and «04:00Z» are the same time.
  const from = since ? Date.parse(since) : null;
  if (since && Number.isNaN(from)) throw new Error(`--since «${since}» — не время; формат ISO, например 2026-10-21T07:00+03:00`);
  let lines = [];
  try { lines = fs.readFileSync(path.join(projectDir, 'memory', 'rules-guard.log'), 'utf8').split(/\r?\n/); } catch { /* no journal */ }
  const by = new Map();
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e || !e.id || (from !== null && !(Date.parse(e.at) >= from))) continue;
    const k = `${e.id} · ${e.mode}`;
    const cur = by.get(k) || { id: e.id, mode: e.mode, n: 0, last: '' };
    cur.n++; cur.last = String(e.what || '').replace(/\s+/g, ' ').slice(0, 80);
    by.set(k, cur);
  }
  if (!by.size) return 'rules-guard: срабатываний нет';
  const rows = [...by.values()].sort((a, b) => b.n - a.n);
  const out = ['rules-guard: правило · режим · раз · последняя команда', ...rows.map((r) => `- ${r.id} · ${r.mode} · ×${r.n} · ${r.last}`)];
  const cand = rows.filter((r) => r.mode === 'log' && r.n >= candidateAt).map((r) => r.id);
  if (cand.length) out.push(`кандидат в deny: ${cand.join(', ')} — если среди срабатываний нет ложных (журнал: memory/rules-guard.log)`);
  return out.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--since');
  const since = i >= 0 ? args.splice(i, 2)[1] : undefined;
  if (!args[0]) { console.error('usage: node journal-summary.cjs <project folder> [--since <ISO>]'); process.exit(2); }
  try { console.log(summarize(args[0], { since })); } catch (e) { console.error(e.message); process.exit(2); }
}

module.exports = { summarize };
