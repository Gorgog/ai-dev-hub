// Приёмочный тест памяти 6 (срез 21): replay 32 повторов через подачу. Реальный корпус — только на машине:
// $HUB_DATA/polygon/corpus/H44-replay.json (35 случаев прототипа памяти 04.11 с моментом повтора и золотыми уроками,
// 312 уроков с `when`, 25 сессий шума из calls.db); нет файла — проверки пропущены.
// Попадание: урок-родитель (датированный до повтора) подан в момент повтора — модуль memory-lessons после вызова, через
// подачу 12 (лимит 3 на вызов, порядок модуля), в свежей эпохе; вызов вне матчера PostToolUse из hooks.json хук не
// видит — промах. Шум: те же модули и подача на всех вызовах 25 сессий по порядку (эпохи и агенты из calls.db): подачи
// уроков (shown + deny) на вызов и разных уроков на сессию. Функции модулей и подачи версии зовутся в процессе (13 тыс.
// запусков раннера — минуты), состояние и журнал подачи — во временной папке, как у раннера.
// Два варианта уроков: «как есть» (312 записей v1 с дублями: 18 про heredoc, 6 про `cd`, 8 про prettier) и «семейства
// слиты» — уроки, которые связывают золотые списки, одним уроком (как их сольёт миграция 23): `when` — объединение
// `when` членов, датированных до момента, дата — самого раннего.
// Решение 05.11 по тесту 6: здесь проверка — попадание (≥ 17/32); шум и «разных уроков на сессию» на памяти v1 — база
// (наблюдение), их порог — на мигрированной копии (срез 23); подача урока на настоящем нарушении шумом не считается
// (вторая цифра: голый `cd` по отметке bare_cd из calls.db и урок о нём, метка violation корпуса).
// Тело (Write/Edit, вход прочих инструментов) и вывод вызовов сессий шума корпус берёт из журналов (~/hub-data/journals).
// Параметры (окружение): HUB_REPLAY_CORPUS — файл корпуса (по умолчанию $HUB_DATA/polygon/corpus/H44-replay.json);
// HUB_REPLAY_MEMORY — папка памяти v2 (например, мигрированная копия 23): уроки и их `when` — из её .triggers.json, дата —
// `created` файла урока, вариант «как есть» заменяется ею; HUB_REPLAY_GOLD — JSON «id урока v1 (evo:N) → id урока
// памяти» (строка или список): по нему золото случаев и метка violation переходят на уроки этой памяти.
'use strict';
const fs = require('fs');
const path = require('path');
const { realFile } = require('../lib/corpus.cjs');

const SRC = 'acceptance §2 тест 6 [П]: «попадание ≥ 17/32 при шуме ≤ 1 подачи на 20 вызовов и медиане ≤ 10 разных уроков на сессию; цель 22/32»';
// The corpus with its lessons taken from a memory v2 folder: gold and violation marks carried over by the map v1 → id.
function fromMemory(corpus, memDir, goldFile) {
  const t = JSON.parse(fs.readFileSync(path.join(memDir, '.triggers.json'), 'utf8'));
  const map = goldFile ? JSON.parse(fs.readFileSync(goldFile, 'utf8')) : {};
  const to = (id) => [].concat(map[id] || []);
  const created = (id) => {
    try { return (/^created:\s*(\S+)/m.exec(fs.readFileSync(path.join(memDir, 'lessons', `${id}.md`), 'utf8')) || [])[1] || '0000-00-00'; } catch { return '0000-00-00'; }
  };
  const violation = new Set(corpus.lessons.filter((l) => l.violation).flatMap((l) => to(l.id)));
  const lessons = (t.lessons || []).map((l) => ({ id: l.id, date: created(l.id), first: l.first, when: l.when || [], ...(violation.has(l.id) ? { violation: 'cd' } : {}) }));
  const cases = corpus.cases.map((c) => ({ ...c, gold: [...new Set(c.gold.flatMap(to))] }));
  return { ...corpus, lessons, cases, families: [] };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

function replay(pluginDir, work, corpus, { merged = false } = {}) {
  const L = (rel) => require(path.join(pluginDir, rel));
  const mh = L('hooks/memory-hooks.cjs'), deliver = L('hooks/lib/deliver.cjs'), session = L('hooks/lib/session.cjs'), events = L('hooks/lib/events.cjs');
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const matcher = (ev) => new RegExp(`^(?:${(hooks[ev] || [{}])[0].matcher || '$^'})$`);
  const preM = matcher('PreToolUse'), postM = matcher('PostToolUse');
  const proj = path.join(work, `replay-${merged ? 'merged' : 'raw'}`, 'projects', 'demo');
  const mem = path.join(proj, 'memory');
  fs.mkdirSync(path.join(mem, 'lessons'), { recursive: true });
  const ctx0 = { project: { dir: proj, name: 'demo' }, delivery: true };
  // The lessons live before a moment (cutoff), families merged or not; famOf — a lesson's id → the id it is delivered as.
  const famOf = new Map();
  for (const fam of merged ? corpus.families || [] : []) for (const id of fam) famOf.set(id, fam);
  const liveAt = (cutoff) => {
    const live = corpus.lessons.filter((l) => l.date < cutoff);
    if (!merged) return live;
    const out = [], seen = new Map();
    for (const l of [...live].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))) {
      const fam = famOf.get(l.id);
      if (!fam) { out.push(l); continue; }
      const head = seen.get(fam);
      if (head) head.when = [...head.when, ...l.when];
      else { const m = { ...l, when: [...l.when] }; seen.set(fam, m); out.push(m); }
    }
    return out;
  };
  const deliveredAs = (id, live) => { const fam = famOf.get(id); return fam ? (live.find((l) => fam.includes(l.id)) || {}).id : id; };
  const all = liveAt('~');
  const setTriggers = (list) => fs.writeFileSync(path.join(mem, '.triggers.json'),
    JSON.stringify({ version: 1, sig: 'replay', lessons: list.map((l) => ({ id: l.id, kind: 'rule', layer: 'touch', first: l.first, when: l.when })) }));
  const skipped = all.filter((l) => l.when.length && l.when.every((w) => mh.compileItem(w).error)).length;
  const shownIn = (text) => [...String(text || '').matchAll(/Урок памяти \(([^)]+)\)/g)].map((m) => m[1]);
  const evOf = (sid, id, c, agent) => ({ session_id: sid, tool_use_id: id, cwd: proj, permission_mode: 'default', ...(agent ? { agent_id: agent } : {}),
    tool_name: c.tool, tool_input: { command: c.cmd || undefined, file_path: c.path || undefined, content: c.body || undefined },
    tool_response: { stdout: c.out || '', stderr: '' } });

  // One call as the runner runs it: Pre (deny-once of a repeat), then Post (lessons after the call) if not denied.
  function step(sid, id, c, agent) {
    let denied = null;
    if (preM.test(c.tool)) {
      const ev = { ...evOf(sid, id, c, agent), hook_event_name: 'PreToolUse' };
      const dl = deliver.open('PreToolUse', ev);
      const res = mh.repeatBefore(ev, { ...ctx0, epoch: dl.epoch() });
      let final = null;
      const fired = [];
      if (res) {
        const claim = dl.claimOnce(res.once);
        if (claim === false) fired.push({ detector: res.detector, lesson: res.lesson });
        else final = res;
      }
      const r = dl.finish({ items: [], final, fired, reaches: (f) => !f });
      if (r.final) denied = r.final.lesson;
    }
    if (denied || !postM.test(c.tool)) return { shown: [], denied };
    const ev = { ...evOf(sid, id, c, agent), hook_event_name: 'PostToolUse' };
    const dl = deliver.open('PostToolUse', ev);
    const res = mh.lessonsAfter(ev, { ...ctx0, epoch: dl.epoch() });
    const r = dl.finish({ items: res ? res.items : [], final: null, fired: [], reaches: (f) => !f || f.decision === 'ask' });
    return { shown: shownIn(r.text), denied };
  }

  const cases = corpus.cases.filter((c) => c.gold.length);
  const rows = cases.map((c, i) => {
    const cutoff = c.date + (c.sameDay ? '~' : '');
    const live = liveAt(cutoff);
    setTriggers(live);
    const gold = new Set(c.gold.filter((g) => corpus.lessons.some((l) => l.id === g && l.date < cutoff)).map((g) => deliveredAs(g, live)));
    const sid = `case-${i}`;
    session.startEpoch({ hook_event_name: 'SessionStart', session_id: sid, source: 'startup' });
    const r = step(sid, 'probe', c.probe);
    return { id: c.id, kind: c.kind, hit: r.shown.some((s) => gold.has(s)), shown: r.shown.length, seen: postM.test(c.probe.tool) };
  });

  setTriggers(all);
  const violation = new Set(all.filter((l) => l.violation).map((l) => l.id));
  const per = corpus.sessions.map((s, si) => {
    const sid = `noise-${si}`;
    const last = {};
    for (let i = 0; i < s.calls.length; i++) {
      const c = s.calls[i];
      const agent = c.agent || null;
      const key = agent || 'main';
      if (last[key] !== c.epoch) {
        if (!agent) session.startEpoch({ hook_event_name: 'SessionStart', session_id: sid, source: last[key] === undefined ? 'startup' : 'compact' });
        else session.startEpoch({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agent });
        last[key] = c.epoch;
      }
      step(sid, `c${i}`, c, agent);
    }
    const ev = events.files().flatMap((f) => events.read(f).events).filter((e) => e.session_id === sid && e.lesson && (e.kind === 'shown' || e.kind === 'deny'));
    // A delivery on a real violation: the call is marked (bare_cd) and the lesson is about that violation.
    const real = (e) => { const c = s.calls[Number(String(e.tool_use_id).slice(1))]; return Boolean(c && c.bare_cd && violation.has(e.lesson)); };
    const noisy = ev.filter((e) => !real(e));
    return { calls: s.calls.length, deliveries: ev.length, lessons: new Set(ev.map((e) => e.lesson)).size,
      noisy: noisy.length, noisyLessons: new Set(noisy.map((e) => e.lesson)).size };
  });
  const sum = (k) => per.reduce((a, p) => a + p[k], 0);
  const calls = sum('calls'), deliveries = sum('deliveries');
  return { rows, hits: rows.filter((r) => r.hit).length, n: rows.length, unseen: rows.filter((r) => !r.seen).length, skipped,
    noise: deliveries / calls, deliveries, calls, median: median(per.map((p) => p.lessons)), max: Math.max(...per.map((p) => p.lessons)),
    noisy: sum('noisy'), noiseTrue: sum('noisy') / calls, medianTrue: median(per.map((p) => p.noisyLessons)) };
}

module.exports = {
  id: 'H44', level: 'hook', mech: 'memory-hooks', title: 'Replay 32 повторов через подачу: попадание и шум (21)',
  async run({ pluginDir, work }) {
    const file = process.env.HUB_REPLAY_CORPUS || realFile('H44-replay.json');
    if (!file || !fs.existsSync(file)) {
      return [{ id: 'real:hit', real: true, source: SRC, pass: false, skip: 'нет корпуса (HUB_REPLAY_CORPUS или $HUB_DATA/polygon/corpus/H44-replay.json)', detail: 'корпус не найден' }];
    }
    if (!fs.existsSync(path.join(pluginDir, 'hooks', 'memory-hooks.cjs'))) {
      return [{ id: 'real:hit', real: true, source: SRC, pass: false, detail: 'в версии нет модулей памяти (memory-hooks.cjs)' }];
    }
    const memDir = process.env.HUB_REPLAY_MEMORY;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const corpus = memDir ? fromMemory(raw, memDir, process.env.HUB_REPLAY_GOLD) : raw;
    const saved = process.env.HUB_LOG_DIR;
    const t0 = Date.now();
    let r1, rm;
    try {
      process.env.HUB_LOG_DIR = path.join(work, 'data');
      r1 = replay(pluginDir, work, corpus);
      process.env.HUB_LOG_DIR = path.join(work, 'data-merged');
      rm = memDir ? r1 : replay(pluginDir, work, corpus, { merged: true });
    } finally {
      if (saved === undefined) delete process.env.HUB_LOG_DIR; else process.env.HUB_LOG_DIR = saved;
    }
    const kinds = (r) => {
      const byKind = {};
      for (const x of r.rows) { const k = (byKind[x.kind] ||= [0, 0]); k[0] += x.hit; k[1]++; }
      return Object.entries(byKind).map(([k, [h, n]]) => `${k} ${h}/${n}`).join(', ');
    };
    const misses = (r) => r.rows.filter((x) => !x.hit).map((x) => `${x.id}${x.seen ? '' : '(вне матчера)'}`).join(', ');
    const noise = (r) => `${r.deliveries} подач на ${r.calls} вызовов (1 на ${(1 / Math.max(r.noise, 1e-9)).toFixed(0)}), разных уроков на сессию — медиана ${r.median}, макс ${r.max}`;
    const NOISE = 'acceptance §2 тест 6, порог шума (1 подача на 20 вызовов, медиана ≤ 10) — по решению 05.11 база на памяти v1, порог — на копии 23';
    const own = memDir ? `память ${memDir}` : 'как есть';
    const base = (r, label) => `${label}: ${noise(r)}; без подач на настоящих нарушениях — ${r.noisy} (1 на ${(1 / Math.max(r.noiseTrue, 1e-9)).toFixed(0)}), медиана ${r.medianTrue}`;
    return [
      { id: 'real:hit', real: true, source: SRC, pass: r1.hits >= 17, detail: `${own}: попадание ${r1.hits}/${r1.n} (${kinds(r1)}); вне матчера PostToolUse ${r1.unseen}; промахи: ${misses(r1)}` },
      { id: 'noise-base', observe: true, source: NOISE, pass: r1.noiseTrue <= 1 / 20 && r1.medianTrue <= 10, detail: base(r1, own) },
      ...(memDir ? [] : [
        { id: 'merged-base', observe: true, source: NOISE, pass: rm.hits >= 17 && rm.noiseTrue <= 1 / 20 && rm.medianTrue <= 10,
          detail: `семейства слиты: попадание ${rm.hits}/${rm.n}; ${base(rm, 'шум')}` },
      ]),
      { id: 'goal-22', observe: true, source: SRC, pass: r1.hits >= 22, detail: memDir ? `цель 22/32: ${own} ${r1.hits}` : `цель 22/32: как есть ${r1.hits}, слиты ${rm.hits}` },
      { id: 'skipped-when', observe: true, source: 'горячий путь: `when` с вложенным повтором не берётся', pass: true,
        detail: `уроков без единого годного when: ${r1.skipped} из ${corpus.lessons.length}; прогон ${Date.now() - t0} мс` },
    ];
  },
};
