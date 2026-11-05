#!/usr/bin/env node
// migrate.py's door to the memory library (slice 14): lesson/decision files are written by its formatLesson and
// checked by its validateLesson, so the migration can never write what the write hook would refuse.
//   stdin:  [{file: 'projects/<p>/memory/lessons/<id>.md', meta: {...}, body: ['line', ...]}, ...]
//   stdout: [{file, text, problems: ['<id>.md: …']}, ...] in the same order
// A `when` item that is not a block of fields is written as is, so the validator names it (the map's mistake).
// After the write the file is read back: a field that comes back different (a key with a comma, a regex in quotes) is
// a problem too — it would not survive the file.
'use strict';
const path = require('path');
const { formatLesson, parseLesson, validateLesson } = require('../../plugin/lib/memory/format.cjs');

function render(meta, body) {
  const when = Array.isArray(meta.when) ? meta.when : [];
  if (when.every((w) => w && typeof w === 'object')) return formatLesson(meta, body);
  const lines = formatLesson({ ...meta, when: [] }, body).split('\n');
  const items = when.flatMap((w) => (w && typeof w === 'object'
    ? Object.entries(w).map(([f, rx], j) => `${j ? '    ' : '  - '}${f}: ${rx}`)
    : [`  - ${w}`]));
  lines.splice(lines.indexOf('when: []'), 1, 'when:', ...items);
  return lines.join('\n');
}

function survives(meta, text) {
  const back = parseLesson(text).meta;
  const out = [];
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'when' && Array.isArray(v) && v.some((w) => !w || typeof w !== 'object')) continue;
    if (JSON.stringify(back[k]) !== JSON.stringify(v)) out.push(`${meta.id}: ${k} ${JSON.stringify(v)} не переживает запись в файл (читается как ${JSON.stringify(back[k])})`);
  }
  return out;
}

// --validate: stdin — a JSON list of file paths of a live memory; stdout — [{file, problems}] by validateLesson.
const fs = require('fs');
const VALIDATE = process.argv[2] === '--validate';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (VALIDATE) {
    const out = JSON.parse(input).map((file) => {
      let buf;
      try { buf = fs.readFileSync(file); } catch (e) { return { file, problems: [`не читается — ${e.code || e.message}`] }; }
      return { file, problems: validateLesson(buf, { file }) };
    });
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
    return;
  }
  const docs = JSON.parse(input);
  const out = docs.map(({ file, meta, body }) => {
    const text = render(meta, body);
    const name = path.basename(file);
    const problems = [...validateLesson(Buffer.from(text, 'utf8'), { file }).map((p) => `${name}: ${p}`),
      ...survives(meta, text)];
    return { file, text, problems };
  });
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
});
