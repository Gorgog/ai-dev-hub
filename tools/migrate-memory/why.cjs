#!/usr/bin/env node
// «Почему так решили» on a migrated copy (acceptance §2, test 7): each question goes to the memory search of the
// library (the `recall find` path) over a copy of the project's memory; a hit — an expected decision in the top N.
//   why.cjs --out <run of migrate.py> --set <why.json> [--top 3] [--min 15] [--max 20] [--threshold 80]
// why.json: {"version": 1, "questions": [{"project", "q", "expect": "<id>" | ["<id>", …], "answer": "…"}]}
// The search builds index files next to the memory, so it runs on a copy: the run stays byte for byte as written.
// Codes: 0 — at or above the threshold, 1 — below it or a bad set, 2 — usage.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../plugin/lib/memory/store.cjs');

function args(argv) {
  const a = { top: 3, min: 15, max: 20, threshold: 80 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (['out', 'set'].includes(k)) a[k] = argv[++i];
    else if (['top', 'min', 'max', 'threshold'].includes(k)) a[k] = Number(argv[++i]);
    else return null;
  }
  return a.out && a.set ? a : null;
}

function main(argv) {
  const a = args(argv);
  if (!a) {
    process.stderr.write('why.cjs --out <прогон> --set <why.json> [--top 3] [--min 15] [--max 20] [--threshold 80]\n');
    return 2;
  }
  const set = JSON.parse(fs.readFileSync(a.set, 'utf8'));
  const qs = set.questions || [];
  const problems = [];
  if (qs.length < a.min || qs.length > a.max) problems.push(`вопросов ${qs.length}, а нужно ${a.min}–${a.max}`);
  const copies = {};
  const mem = (p) => {
    if (!copies[p]) {
      copies[p] = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-why-')), 'memory');
      fs.cpSync(path.join(a.out, 'projects', p, 'memory'), copies[p], { recursive: true });
    }
    return copies[p];
  };
  let hits = 0;
  const lines = [];
  try {
    for (const q of qs) {
      const expect = [].concat(q.expect);
      for (const id of expect) {
        if (!fs.existsSync(path.join(a.out, 'projects', q.project, 'memory', 'decisions', `${id}.md`))) {
          problems.push(`нет решения ${q.project}/${id} в прогоне`);
        }
      }
      if (!fs.existsSync(path.join(a.out, 'projects', q.project, 'memory'))) continue;
      const got = S.find(mem(q.project), q.q, { top: a.top }).hits.map((h) => h.id);
      const ok = got.some((id) => expect.includes(id));
      hits += ok;
      lines.push(`${ok ? '✓' : '✗'} ${q.project}: ${q.q} → ${got.join(', ') || '—'}${ok ? '' : ` (ждали ${expect.join(' | ')})`}`);
    }
  } finally {
    for (const c of Object.values(copies)) fs.rmSync(path.dirname(c), { recursive: true, force: true });
  }
  const pct = qs.length ? Math.round((hits / qs.length) * 100) : 0;
  const pass = pct >= a.threshold && !problems.length;
  lines.push(`почему так решили: ${hits}/${qs.length} (${pct} %), порог ${a.threshold} % — ${pass ? 'прошло' : 'не прошло'}`);
  process.stdout.write(`${[...lines, ...problems].join('\n')}\n`);
  return pass ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
