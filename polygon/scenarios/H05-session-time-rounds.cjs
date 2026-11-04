// Факт задачи по журналу сессии: два отрезка EST-START … EST-END одного ключа — сумма обоих, а не только первый;
// конец второго — строкой «⏱ EST-END» в сообщении диспетчеру (SendMessage), как его шлёт сессия под диспетчером.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const T0 = Date.parse('2026-10-01T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
let n = 0;
const said = (min, text) => ({ type: 'assistant', timestamp: at(min), uuid: `a${++n}`, message: { content: [{ type: 'text', text }] } });
const sent = (min, message) => ({ type: 'assistant', timestamp: at(min), uuid: `a${++n}`,
  message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'SendMessage', input: { to: 'dispatcher', message } }] } });
const human = (min, text) => ({ type: 'user', timestamp: at(min), uuid: `u${++n}`, message: { content: [{ type: 'text', text }] } });

module.exports = {
  id: 'H05', level: 'hook', mech: 'estimate', title: 'session-time: факт по всем отрезкам задачи',
  async run({ base, work }) {
    const script = path.join(base, 'plugin', 'skills', 'estimate', 'scripts', 'session-time.cjs');
    if (!fs.existsSync(script)) return [{ id: 'two-rounds-sum', pass: false, detail: 'нет session-time.cjs' }];
    const events = [
      said(0, 'Беру задачу.\nEST-START DEMO-5'), said(5, 'тест'), said(10, 'реализация'), said(15, 'проверки'),
      said(20, 'Готово к пушу: DEMO-5.\nEST-END DEMO-5'),
      human(60, 'Ревью вернуло замечания, доделай.'),
      said(61, 'Берусь за замечания.\nEST-START DEMO-5'), said(66, 'правка'), said(76, 'тесты'), said(86, 'ревью'),
      sent(91, 'готово к мержу: DEMO-5 abc1234\n⏱ EST-END DEMO-5'),
    ];
    const file = path.join(work, 'session.jsonl');
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = spawnSync(process.execPath, [script, 'file', file, '--key', 'DEMO-5'], { encoding: 'utf8', timeout: 30000 });
    const out = r.stdout || '';
    const active = Number((out.match(/TOTAL\s+active\s+(\d+)\s+min/) || [])[1]);
    return [
      { id: 'two-rounds-sum', source: 'аудит №7 (факт видел только первый доклад)', pass: active === 50,
        detail: `ждали 50 мин активного (20 + 30), вышло ${Number.isNaN(active) ? (r.stderr || out).slice(0, 120) : active}` },
      { id: 'end-in-sendmessage', source: 'коммит хаба f35b7c1 (метки EST-* из сообщений диспетчеру)',
        pass: r.status === 0 && !/no EST-END/.test(out), detail: out.split('\n')[0].slice(0, 160) },
    ];
  },
};
