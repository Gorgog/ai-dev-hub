// Итоги прогона и сравнение двух прогонов: «ловит» и «не шумит» считаются раздельно и по механизмам, не средним
// (acceptance §1: правило сравнения версий). Вид проверки (kind): catch — нужен блок или флаг, quiet — не нужен,
// never — «никогда» (пуш, .env, выдуманный sha), task — сама задача. Вне ворот: наблюдение (observe), контракт
// механизма, которого ещё нет (contract у сценария), реальный корпус из ~/hub-data (real), пропуск (skip).
'use strict';

const KIND_RU = { catch: 'ловит', quiet: 'не шумит', never: 'никогда', task: 'задача' };
const KINDS = Object.keys(KIND_RU);

// Per check: passes / runs; pass^k — passed in every run.
function aggregate(sc) {
  const byCheck = {};
  for (const r of sc.runs) for (const c of r.checks) {
    const b = (byCheck[c.id] ||= { id: c.id, source: c.source, observe: Boolean(c.observe), real: Boolean(c.real),
      skip: c.skip || null, kind: c.kind || (sc.level === 'model' ? 'task' : 'catch'), mech: c.mech || sc.mech || sc.id,
      pass: 0, n: 0, details: [] });
    b.n++; if (c.pass) b.pass++;
    if (c.detail) b.details.push(String(c.detail).slice(0, 300));
  }
  const checks = Object.values(byCheck);
  const required = checks.filter((c) => !c.observe && !c.skip);
  return { checks, rate: required.reduce((s, c) => s + c.pass / c.n, 0) / Math.max(1, required.length),
    costUsd: sc.runs.reduce((s, r) => s + (r.costUsd || 0), 0), wallMs: sc.runs.reduce((s, r) => s + (r.wallMs || 0), 0) };
}

// Where a check counts: observe/skip — nowhere; contract, real — own rows; the rest — gates.
function group(sc, c) {
  if (c.observe) return 'observe';
  if (c.skip) return 'skip';
  if (sc.contract) return 'contract';
  if (c.real) return 'real';
  return 'gate';
}

const tally = () => ({ pass: 0, n: 0 });
const add = (t, ok) => { t.n++; if (ok) t.pass++; };
const frac = (t) => `${t.pass}/${t.n}`;

function summary(results) {
  const s = { gate: { all: tally(), ...Object.fromEntries(KINDS.map((k) => [k, tally()])) }, proto: tally(),
    contract: tally(), contractIds: [], real: tally(), skipped: 0, byMech: {} };
  for (const sc of results) for (const c of aggregate(sc).checks) {
    const g = group(sc, c), ok = c.pass === c.n;
    if (g === 'skip') { s.skipped++; continue; }
    if (g === 'observe') continue;
    if (sc.proto && !c.real) add(s.proto, ok);
    if (g === 'contract') { add(s.contract, ok); if (!s.contractIds.includes(sc.id)) s.contractIds.push(sc.id); continue; }
    if (g === 'real') { add(s.real, ok); continue; }
    add(s.gate.all, ok); add(s.gate[c.kind] || (s.gate[c.kind] = tally()), ok);
    const m = (s.byMech[c.mech] ||= {});
    add(m[c.kind] || (m[c.kind] = tally()), ok);
  }
  return s;
}

function summaryLines(results) {
  const s = summary(results), g = s.gate;
  const lines = [`ворота: ${frac(g.all)} · ловит ${frac(g.catch)} · не шумит ${frac(g.quiet)}` +
    (g.never.n ? ` · никогда ${frac(g.never)}` : '') + (g.task.n ? ` · задача ${frac(g.task)}` : '')];
  if (s.proto.n) lines.push(`прототип H01–H04: ${frac(s.proto)}`);
  if (s.contract.n) lines.push(`контракты (вне ворот): ${frac(s.contract)} — ${s.contractIds.join(', ')}`);
  if (s.real.n) lines.push(`реальные корпуса: ${frac(s.real)}`);
  if (s.skipped) lines.push(`пропущено проверок: ${s.skipped}`);
  for (const [mech, m] of Object.entries(s.byMech).sort()) {
    lines.push(`  ${mech.padEnd(16)} ${KINDS.filter((k) => m[k]).map((k) => `${KIND_RU[k]} ${frac(m[k])}`).join('  ')}`);
  }
  return lines;
}

// A vs B check by check; metadata (kind, mech, group) from B, else A — old prototype JSON has none.
function compareRuns(A, B) {
  const idx = (R) => {
    const m = {};
    for (const sc of R.results) for (const c of aggregate(sc).checks) m[`${sc.id}/${c.id}`] = { c, g: group(sc, c), sc };
    return m;
  };
  const a = idx(A), b = idx(B);
  const rows = [];
  let better = 0, worse = 0, added = 0, gone = 0;
  const mech = {}, totals = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[key], y = b[key];
    const meta = y || x;
    const kind = meta.c.kind, g = meta.g;
    const ra = x ? x.c.pass / x.c.n : null, rb = y ? y.c.pass / y.c.n : null;
    let mark = '    ';
    if ((x && x.g === 'skip') || (y && y.g === 'skip')) {
      rows.push({ key, mark: 'пр. ', a: x ? `${x.c.pass}/${x.c.n}` : '—', b: y ? `${y.c.pass}/${y.c.n}` : '—' });
      continue;
    }
    if (ra === null && rb !== null) { mark = 'new '; added++; }
    else if (rb === null && ra !== null) { mark = 'нет '; gone++; }
    else if (ra !== null && rb !== null && g !== 'observe') {
      if (rb > ra) { mark = '+   '; better++; } else if (rb < ra) { mark = '-   '; worse++; }
    }
    rows.push({ key, mark, a: x ? `${x.c.pass}/${x.c.n}` : '—', b: y ? `${y.c.pass}/${y.c.n}` : '—' });
    if (ra === null || rb === null || g === 'observe') continue;
    const rowKey = g === 'gate' ? meta.c.mech : g === 'contract' ? 'контракты' : 'реальные корпуса';
    const t = (mech[`${rowKey}\t${kind}`] ||= { mech: rowKey, kind, a: tally(), b: tally() });
    add(t.a, x.c.pass === x.c.n); add(t.b, y.c.pass === y.c.n);
    if (g === 'gate') {
      const tt = (totals[kind] ||= { a: tally(), b: tally() });
      add(tt.a, x.c.pass === x.c.n); add(tt.b, y.c.pass === y.c.n);
    }
  }
  const byMech = Object.values(mech);
  const lines = [`A: ${A.hub.ref} ${A.hub.sha}   B: ${B.hub.ref} ${B.hub.sha}`, ''];
  for (const k of KINDS) if (totals[k]) lines.push(`${KIND_RU[k]}: ${frac(totals[k].a)} → ${frac(totals[k].b)}`);
  lines.push('', 'по механизмам:');
  for (const m of [...new Set(byMech.map((r) => r.mech))]) {
    const cells = KINDS.map((k) => byMech.find((r) => r.mech === m && r.kind === k)).filter(Boolean)
      .map((r) => `${KIND_RU[r.kind]} ${frac(r.a)} → ${frac(r.b)}`);
    lines.push(`  ${m.padEnd(16)} ${cells.join('  ')}`);
  }
  lines.push('', `лучше: ${better}, хуже: ${worse}, новых: ${added}, пропало: ${gone}`);
  return { rows, byMech, better, worse, added, gone, lines, exitCode: worse ? 1 : 0 };
}

module.exports = { aggregate, group, summary, summaryLines, compareRuns, KIND_RU };
