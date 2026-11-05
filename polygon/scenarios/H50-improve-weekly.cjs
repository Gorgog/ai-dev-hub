// improve (срез 24): недельный цикл улучшения стартует со старта сессии — в фоне, старт не ждёт; готовый итог недели
// подаётся один раз; не по неделе — молчит; копия данных чужого хаба (полигон, тест) не трогается никогда. Цикл здесь —
// подставной скрипт (HUB_IMPROVE_WEEKLY): настоящий обновлял бы снимок данных, полигону это не нужно.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'план 24: «раз в неделю хаб сам прогоняет аудит… пользователю — недельный итог одним сообщением»';
const FAKE = `import sys, json, os
a = sys.argv[1:]
out = a[a.index('--out') + 1]
with open(os.environ['IMPROVE_RUNS'], 'a') as f:
    f.write(' '.join(a) + '\\n')
with open(out + '.tmp', 'w') as f:
    json.dump({'summary': 'Недельный итог хаба · синтетика полигона'}, f)
os.replace(out + '.tmp', out)
`;

function stand(base, work, { canary = true, copyOf = ['demo'] } = {}) {
  const { hub, proj } = makeHub(base, work, { extra: canary ? { 'canary.json': JSON.stringify({ mechanisms: ['improve'] }) } : {} });
  const hd = path.join(work, 'hub-data');
  fs.mkdirSync(path.join(hd, 'analytics'), { recursive: true });
  fs.writeFileSync(path.join(hd, 'analytics', 'calls.db'), '');
  for (const p of copyOf) fs.mkdirSync(path.join(hd, 'hub', 'projects', p), { recursive: true });
  const fake = path.join(work, 'weekly-fake.py');
  fs.writeFileSync(fake, FAKE);
  const runs = path.join(work, 'runs.log');
  const data = path.join(work, 'hook-data');
  const env = { AI_DEV_HUB: hub, HUB_DATA: hd, HUB_IMPROVE_WEEKLY: fake, IMPROVE_RUNS: runs, HUB_LOG_DIR: data, HUB_RUN_NO_SYSTEMD: '1' };
  return { hub, proj, env, runs, data, report: path.join(data, 'improve', 'week.json') };
}

const start = (pluginDir, s, source = 'startup') => {
  const t = Date.now();
  const res = runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source, session_id: `eval-${source}`, cwd: s.proj }, s.env);
  const text = res.map((r) => r.stdout + (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : '')).join('\n');
  return { text, ms: Date.now() - t, code: res.map((r) => r.code) };
};
const runsOf = (s) => (fs.existsSync(s.runs) ? fs.readFileSync(s.runs, 'utf8').trim().split('\n').filter(Boolean).length : 0);

async function waitFor(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

module.exports = {
  id: 'H50', level: 'hook', mech: 'improve', title: 'improve: недельный цикл в фоне со старта, итог — один раз',
  async run({ base, pluginDir, work }) {
    const s = stand(base, path.join(work, 'on'));
    const first = start(pluginDir, s);
    const wrote = await waitFor(() => fs.existsSync(s.report));
    const compact = start(pluginDir, s, 'compact');
    const second = start(pluginDir, s);
    const third = start(pluginDir, s);
    const args = fs.existsSync(s.runs) ? fs.readFileSync(s.runs, 'utf8') : '';

    const foreign = stand(base, path.join(work, 'foreign'), { copyOf: ['other'] });
    const f = start(pluginDir, foreign);
    const off = stand(base, path.join(work, 'off'), { canary: false });
    const o = start(pluginDir, off);
    await new Promise((r) => setTimeout(r, 1500));
    return [
      { id: 'starts-in-background', source: SRC, pass: wrote && first.ms < 5000 && !/Недельный итог/.test(first.text),
        detail: `старт ${first.ms} мс, итог ${wrote ? 'дописан' : 'не дописан за 15 с'}, текст старта: ${first.text.slice(0, 120)}` },
      { id: 'applies-with-refresh', source: SRC, pass: /--apply/.test(args) && /--refresh/.test(args) && /--events/.test(args),
        detail: `аргументы цикла: ${args.trim().slice(0, 300)}` },
      { id: 'summary-once', source: SRC, pass: /Недельный итог хаба · синтетика полигона/.test(second.text) && !/Недельный итог/.test(third.text),
        detail: `второй старт: ${second.text.slice(0, 160)} / третий: ${third.text.slice(0, 160)}` },
      { id: 'weekly-not-every-start', kind: 'quiet', source: SRC, pass: runsOf(s) === 1, detail: `запусков цикла: ${runsOf(s)} вместо 1` },
      { id: 'compact-silent', kind: 'quiet', source: 'модуль: только startup | clear основного потока', pass: !/Недельный итог/.test(compact.text),
        detail: `после компакции: ${compact.text.slice(0, 160)}` },
      { id: 'foreign-copy-untouched', kind: 'quiet', source: 'модуль: снимок данных — только копия этого хаба', pass: runsOf(foreign) === 0 && !fs.existsSync(path.join(foreign.data, 'improve')) && !/Недельный итог/.test(f.text),
        detail: `копия чужого хаба: запусков ${runsOf(foreign)}` },
      { id: 'canary-only', kind: 'quiet', source: 'реестр: стадия canary — только в проектах из canary.json', pass: runsOf(off) === 0 && !/Недельный итог/.test(o.text),
        detail: `без канарейки: запусков ${runsOf(off)}` },
      { id: 'not-blocked', kind: 'quiet', source: SRC, pass: [first, second, third, compact, f, o].every((r) => r.code.every((c) => c === 0)),
        detail: 'SessionStart вышел не с кодом 0' },
    ];
  },
};
