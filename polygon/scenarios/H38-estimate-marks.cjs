// Метки оценки ловит Stop (срез 19): «⏱ EST-START» в сообщении диспетчеру посреди хода и «⏱ EST-END» в последнем
// сообщении попадают в индекс проекта memory/est-marks.jsonl; `session-time.cjs key --index-only` по индексу находит
// отрезок задачи, даже когда журнала нет среди просканированных (--root пустой). Без канарейки механизма — тишина.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const T0 = Date.parse('2026-10-01T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
let n = 0;
const said = (min, text) => ({ type: 'assistant', timestamp: at(min), uuid: `a${++n}`, message: { content: [{ type: 'text', text }] } });
const sent = (min, message) => ({ type: 'assistant', timestamp: at(min), uuid: `a${++n}`,
  message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'SendMessage', input: { to: 'dispatcher', message } }] } });
const human = (min, text) => ({ type: 'user', timestamp: at(min), uuid: `u${++n}`, message: { content: [{ type: 'text', text }] } });

const SRC = 'аудит №7, платформа A6 (метки ищут grep-ом по всем журналам; EST в сообщениях диспетчеру — коммит f35b7c1)';

function stand(base, work, name, canary) {
  const { hub, proj } = makeHub(base, path.join(work, name), canary ? { extra: { 'canary.json': JSON.stringify({ mechanisms: ['estimate'] }) } } : {});
  const wt = path.join(proj, 'worktrees', 'DEMO-5');
  fs.mkdirSync(wt, { recursive: true });
  const tr = path.join(work, name, 'session.jsonl');
  const events = [human(0, 'бриф'), sent(1, 'принял бриф\n⏱ EST-START DEMO-5'), said(10, 'тест'), said(25, 'реализация'),
    said(31, 'готово к мержу: DEMO-5 abc1234\n⏱ EST-END DEMO-5')];
  fs.writeFileSync(tr, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const ev = { hook_event_name: 'Stop', session_id: 'eval', cwd: wt, transcript_path: tr, stop_hook_active: false,
    last_assistant_message: 'готово к мержу: DEMO-5 abc1234\n⏱ EST-END DEMO-5' };
  const res = runEvent(path.join(hub, 'plugin'), 'Stop', ev, { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, name, 'log') });
  const marks = path.join(proj, 'memory', 'est-marks.jsonl');
  const lines = fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { hub, marks, lines, res };
}

module.exports = {
  id: 'H38', level: 'hook', mech: 'estimate', title: 'Метки EST ловит Stop: индекс меток → факт задачи',
  async run({ base, work }) {
    const on = stand(base, work, 'on', true);
    const off = stand(base, work, 'off', false);
    const kinds = on.lines.map((l) => { try { const o = JSON.parse(l); return `${o.kind} ${o.key}`; } catch { return l.slice(0, 40); } });
    const script = path.join(base, 'plugin', 'skills', 'estimate', 'scripts', 'session-time.cjs');
    const empty = path.join(work, 'empty-root');
    fs.mkdirSync(empty, { recursive: true });
    const r = spawnSync(process.execPath, [script, 'key', 'DEMO-5', '--root', empty, '--marks', on.marks, '--index-only'], { encoding: 'utf8', timeout: 30000 });
    const active = Number(((r.stdout || '').match(/TOTAL\s+active\s+(\d+)\s+min/) || [])[1]);
    const silent = on.res.every((x) => !x.stdout.trim() && x.code === 0);
    return [
      { id: 'marks-from-stop', source: SRC, pass: kinds.join(',') === 'START DEMO-5,END DEMO-5' && silent,
        detail: `индекс: ${kinds.join(', ') || 'пусто'}; вывод хука: ${on.res.map((x) => `${x.code}:${x.stdout.trim().slice(0, 60)}`).join(' ') || 'нет хуков Stop'}` },
      { id: 'key-by-index', source: SRC, pass: active === 30 && /source: marks only/.test(r.stdout || ''),
        detail: `ждали 30 мин по индексу, вышло: ${(r.stdout || r.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 160)}` },
      { id: 'no-canary-quiet', kind: 'quiet', source: 'стадия canary: механизм только в проектах из canary.json', pass: off.lines.length === 0,
        detail: `без канарейки строк индекса: ${off.lines.length}` },
    ];
  },
};
