// hub-run.sh: потолок памяти убивает только прогон (код 137), сосед вне прогона жив. Нужен systemd user-менеджер:
// без него у hub-run нет потолка, и пожиратель памяти съел бы машину — тогда проверки пропускаются.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SKIP = 'нет systemd user-менеджера или systemd-run: у hub-run нет потолка';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

module.exports = {
  id: 'H08', level: 'hook', mech: 'hub-run', title: 'hub-run: потолок убивает только прогон',
  async run({ base }) {
    const script = path.join(base, 'plugin', 'skills', 'dispatch', 'scripts', 'hub-run.sh');
    if (!fs.existsSync(script)) return [{ id: 'ceiling-kills-run', pass: false, detail: 'нет hub-run.sh' }];
    // Как has_systemd в hub-run.sh: и менеджер, и systemd-run — иначе hub-run уходит в фоллбэк без потолка.
    const systemd = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0 &&
      spawnSync('sh', ['-c', 'command -v systemd-run'], { stdio: 'ignore' }).status === 0;
    if (!systemd || process.env.HUB_RUN_NO_SYSTEMD === '1') {
      return ['ceiling-kills-run', 'neighbour-alive'].map((id) => ({ id, pass: false, skip: SKIP }));
    }
    const neighbour = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const hog = 'const a = []; for (;;) a.push(Buffer.alloc(1e7, 1));';
      const r = spawnSync('bash', [script, `polygon-H08-${process.pid}`, '-MemoryMax', '64M', '-Timeout', '60', '--',
        process.execPath, '-e', hog], { encoding: 'utf8', timeout: 90000 });
      const src = 'dispatch «Не ломать» №2 (потолок прогона)';
      return [
        { id: 'ceiling-kills-run', source: src, pass: r.status === 137, detail: `код ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}` },
        { id: 'neighbour-alive', source: src, pass: alive(neighbour.pid), detail: 'сосед вне прогона погиб' },
      ];
    } finally { neighbour.kill('SIGKILL'); }
  },
};
