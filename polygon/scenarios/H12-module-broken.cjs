// Контракт хребта хуков (срез 08): «модуль сломан». Модули — файлы `plugin/hooks/<событие>.d/`; модуль, который
// падает при загрузке, не роняет событие так, как не надо: подача (бриф SessionStart) — fail-open, хук выходит с 0;
// защита (замок PreToolUse) — fail-closed, тяжёлое без гранта получает отказ с причиной. Сценарий ломает модули в
// копии плагина версии. Заготовка: 08 уточняет имена каталогов и модулей вместе со сценарием.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent, preToolVerdict } = require('../lib/hooks.cjs');

const BROKEN = "throw new Error('polygon: модуль сломан');\n";
const SRC = 'plan.md: политика отказа (подача fail-open, защита fail-closed); acceptance §1 «модуль сломан»';

// Copy of the plugin with every matching module of <event>.d/ replaced by one that throws; null — no such modules.
function breakModules(pluginDir, work, dirName, pick) {
  const copy = path.join(work, `plugin-${dirName}`);
  fs.cpSync(pluginDir, copy, { recursive: true });
  const dir = path.join(copy, 'hooks', dirName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /\.(c|m)?js$/.test(f) && pick(f));
  if (!files.length) return null;
  for (const f of files) fs.writeFileSync(path.join(dir, f), BROKEN);
  return copy;
}

module.exports = {
  id: 'H12', level: 'hook', mech: 'spine', contract: true, title: 'Модуль сломан: подача fail-open, защита fail-closed (контракт 08)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const checks = [];

    const brief = breakModules(pluginDir, work, 'sessionstart.d', () => true);
    if (!brief) checks.push({ id: 'delivery-fail-open', kind: 'quiet', source: SRC, pass: false, detail: 'нет модулей hooks/sessionstart.d (хребет 08)' });
    else {
      const res = runEvent(brief, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'eval', cwd: repo }, { AI_DEV_HUB: hub });
      checks.push({ id: 'delivery-fail-open', kind: 'quiet', source: SRC, pass: res.length > 0 && res.every((r) => r.code === 0),
        detail: `коды выхода: ${res.map((r) => r.code).join(',') || 'хук не запущен'}` });
    }

    const lock = breakModules(pluginDir, work, 'pretool.d', (f) => /guard|lock|замок/i.test(f));
    if (!lock) checks.push({ id: 'protect-fail-closed', source: SRC, pass: false, detail: 'нет модуля замка в hooks/pretool.d (хребет 08)' });
    else {
      fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'dispatch-rules.json'), path.join(proj, 'dispatch-rules.json'));
      const v = preToolVerdict(runEvent(lock, 'PreToolUse', { hook_event_name: 'PreToolUse', session_id: 'eval',
        cwd: path.join(proj, 'worktrees', 'DEMO-5'), tool_name: 'Bash', tool_input: { command: 'npx jest src/a.spec.ts' } }, { AI_DEV_HUB: hub }));
      checks.push({ id: 'protect-fail-closed', source: SRC, pass: v.verdict === 'deny' && v.reasons.join('').trim() !== '',
        detail: `ждали отказ с причиной, вышло ${v.verdict}` });
    }
    return checks;
  },
};
