// Скриншоты доказательства — 16:9 (по умолчанию 1600×900): доклад «готово к пушу» со скриншотом другого формата
// останавливается с именем файла; доклад, где все 16:9, проходит. Механизм — проверка доклада на Stop.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent, stopVerdict } = require('../lib/hooks.cjs');

// A real (tiny) PNG of the given size: 1-bit grayscale, all black.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 1; ihdr[9] = 0;
  const raw = Buffer.alloc((1 + Math.ceil(w / 8)) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = {
  id: 'H11', level: 'hook', mech: 'done-gate', title: 'Скриншоты в докладе — 16:9',
  png,
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    const git = gitRepo(repo, { 'a.txt': '1\n' });
    const head = git('rev-parse', '--short', 'HEAD');
    const shots = (branch, sizes) => {
      const dir = path.join(proj, 'memory', branch, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      return Object.entries(sizes).map(([name, [w, h]]) => { fs.writeFileSync(path.join(dir, name), png(w, h)); return path.join(dir, name); });
    };
    const bad = shots('DEMO-11', { 'main.png': [1440, 900], 'form.png': [1600, 900] });
    const good = shots('DEMO-12', { 'main.png': [1600, 900], 'form.png': [1600, 900] });
    const report = (files) => `Готово к пушу: DEMO-11, HEAD ${head}, тесты 2/2, дерево чистое.\nСкриншоты:\n` +
      files.map((f) => `- ${f} — ${path.basename(f, '.png')}`).join('\n');
    const stop = (msg) => stopVerdict(runEvent(pluginDir, 'Stop', { hook_event_name: 'Stop', session_id: 'eval', cwd: repo,
      last_assistant_message: msg, stop_hook_active: false }, { AI_DEV_HUB: hub }));
    const a = stop(report(bad)), b = stop(report(good));
    const src = 'errors 10-29 case-12 (скрины 1440×900); CLAUDE.local 29.10 (16:9, 1600×900)';
    return [
      { id: 'non-16x9-named', source: src, pass: a.block && /main\.png/.test(a.reason),
        detail: `ждали блок с main.png, вышло ${a.block ? 'блок: ' + a.reason.slice(0, 100) : 'пропуск'}` },
      { id: 'all-16x9-pass', kind: 'quiet', source: src, pass: !b.block, detail: `ждали пропуск, вышло блок: ${b.reason.slice(0, 100)}` },
    ];
  },
};
