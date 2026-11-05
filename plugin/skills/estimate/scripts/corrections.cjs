#!/usr/bin/env node
// Corrections of estimates, counted from the journal (projects/<name>/memory/estimates.md), not by eye.
// usage:
//   node corrections.cjs <estimates.md> [--json]                         the factor: median of fact ÷ middle of forecast
//   node corrections.cjs <estimates.md> --apply <min>–<max> [--complexity N] [--json]   the forecast times the factor
// A closed row has a forecast («30–60 мин», «1,5–3 ч», «120 мин» — the first range of the cell) and the active minutes
// of the fact (the first number of «Факт (акт / ожид)»). Not closed: no fact, retro rows («ретро» — forecast by eye
// after the fact) and cancelled ones («Попал» is «—»). Under MIN_ROWS closed rows there is no factor: the analogues
// lead (the journal template says so). Classes by complexity 1–3 / 4–6 / 7–10 get their own factor from MIN_CLASS rows;
// --apply takes the class factor when there is one, else the overall one.
'use strict';
const fs = require('fs');

const MIN_ROWS = 10;
const MIN_CLASS = 3;
const CLASSES = [['1–3', 1, 3], ['4–6', 4, 6], ['7–10', 7, 10]];

const num = (s) => Number(String(s).replace(',', '.'));
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

// Minutes of the first range (or single figure) with its unit in a forecast cell.
function forecastOf(cell) {
  const m = /(\d+(?:[.,]\d+)?)(?:\s*[–—-]\s*(\d+(?:[.,]\d+)?))?\s*(мин|ч)/.exec(cell);
  if (!m) return null;
  const k = m[3] === 'ч' ? 60 : 1;
  const min = Math.round(num(m[1]) * k), max = Math.round(num(m[2] ?? m[1]) * k);
  return min > 0 && max >= min ? { min, max } : null;
}

// Active minutes: the first number of the fact cell («45 / 4 мин», «≈25 мин», «56 мин / 15 мин ожидания», «≈ 5 ч»).
function activeOf(cell) {
  // \b is ASCII-only in JS: «ч» is followed by «not a Cyrillic letter», else «≈ 5 ч активно» reads as 5 minutes.
  const m = /^\s*≈?\s*(\d+(?:[.,]\d+)?)(?:\s*(ч)(?![а-яё]))?/i.exec(cell);
  return m ? Math.round(num(m[1]) * (m[2] ? 60 : 1)) : null;
}

// Rows of the table whose header names «Прогноз» and «Факт …»; columns are found by their header.
function parseJournal(text) {
  const lines = String(text).split('\n');
  const rows = [];
  let col = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) { col = null; continue; }
    const c = cells(line);
    if (!col) {
      const at = (f) => c.findIndex(f);
      const h = { key: at((x) => x === 'Ключ'), cx: at((x) => x.startsWith('Слож')), forecast: at((x) => x === 'Прогноз'),
        fact: at((x) => x.startsWith('Факт') && !x.includes('+')), hit: at((x) => x.startsWith('Попал')) };
      if (h.forecast >= 0 && h.fact >= 0) col = h;
      continue;
    }
    if (c.every((x) => /^:?-*:?$/.test(x))) continue;
    const get = (i) => (i >= 0 ? c[i] || '' : '');
    const forecast = forecastOf(get(col.forecast));
    const active = activeOf(get(col.fact));
    const retro = /ретро/i.test(get(col.cx)) || /ретро/i.test(get(col.forecast));
    const cancelled = /^[—-]$/.test(get(col.hit));
    const cx = /\d+/.exec(get(col.cx));
    rows.push({ key: get(col.key), complexity: cx ? Number(cx[0]) : null, forecast, active, retro,
      closed: !!forecast && active !== null && !retro && !cancelled });
  }
  return rows;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round2 = (x) => Math.round(x * 100) / 100;
const ratio = (r) => r.active / ((r.forecast.min + r.forecast.max) / 2);

// { n, factor | null, classes: { '1–3': { n, factor | null } } } — classes only when the overall factor exists.
function corrections(rows) {
  const closed = rows.filter((r) => r.closed);
  if (closed.length < MIN_ROWS) return { n: closed.length, factor: null, classes: {} };
  const classes = {};
  for (const [name, lo, hi] of CLASSES) {
    const xs = closed.filter((r) => r.complexity >= lo && r.complexity <= hi).map(ratio);
    if (xs.length) classes[name] = { n: xs.length, factor: xs.length >= MIN_CLASS ? round2(median(xs)) : null };
  }
  return { n: closed.length, factor: round2(median(closed.map(ratio))), classes };
}

// The forecast range times the factor of its class (from MIN_CLASS rows), else the overall one; unchanged without one.
function apply(c, { min, max }, complexity) {
  if (c.factor === null) return { min, max, factor: null, by: null };
  const cls = CLASSES.find(([, lo, hi]) => complexity >= lo && complexity <= hi);
  const own = cls && c.classes[cls[0]];
  const [factor, by] = own && own.factor !== null ? [own.factor, cls[0]] : [c.factor, 'все'];
  return { min: Math.round(min * factor), max: Math.round(max * factor), factor, by };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const die = (m) => { process.stderr.write(m + '\n'); process.exit(1); };
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const json = args.includes('--json') && !!args.splice(args.indexOf('--json'), 1);
  const range = opt('--apply');
  const cx = opt('--complexity');
  const [file] = args;
  if (!file) die('usage: corrections.cjs <estimates.md> [--json] [--apply <min>–<max> [--complexity N]]');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { die(`не прочитать ${file}: ${e.code || e.message}`); }
  let forecast = null;
  if (range !== undefined) {
    const m = /^(\d+)\s*[–—-]\s*(\d+)$/.exec(range.trim()) || /^(\d+)()$/.exec(range.trim());
    if (!m) die(`--apply: диапазон минут, например 30–60, а не «${range}»`);
    forecast = { min: Number(m[1]), max: Number(m[2] || m[1]) };
    if (forecast.max < forecast.min) die(`--apply: ${range} — максимум меньше минимума`);
  }
  if (cx !== undefined && !/^\d+$/.test(cx)) die(`--complexity: целое 1–10, а не «${cx}»`);
  const c = corrections(parseJournal(text));
  const applied = forecast && apply(c, forecast, cx === undefined ? undefined : Number(cx));
  if (json) {
    console.log(JSON.stringify({ ...c, ...(applied ? { applied } : {}) }));
  } else {
    if (c.factor === null) console.log(`поправки нет: закрытых строк ${c.n} < ${MIN_ROWS} — опора на аналоги`);
    else {
      console.log(`поправка ×${c.factor} (N = ${c.n}, медиана факт ÷ середина прогноза)`);
      for (const [name, v] of Object.entries(c.classes)) {
        console.log(`  сложность ${name}: ${v.factor === null ? `мало строк (N = ${v.n} < ${MIN_CLASS}) — общая` : `×${v.factor} (N = ${v.n})`}`);
      }
    }
    if (applied) {
      const r = `${forecast.min}–${forecast.max} мин`;
      console.log(applied.factor === null ? `прогноз ${r} — без поправки`
        : `прогноз ${r} × ${applied.factor} (${applied.by === 'все' ? 'все строки' : `класс ${applied.by}`}) = ${applied.min}–${applied.max} мин`);
    }
  }
}

module.exports = { parseJournal, corrections, apply, median, MIN_ROWS, MIN_CLASS };
