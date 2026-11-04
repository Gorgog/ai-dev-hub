// Реальные корпуса полигона — только на машине, вне git: $HUB_DATA/polygon/corpus/<сценарий>.json (по умолчанию
// ~/hub-data). В git — синтетика и обезличенные случаи; реальные строки из журналов (dispatch-guard.log, ложные
// стоп-блоки) подхватываются, если файл есть. Случай реального корпуса — та же запись, что в CORPUS сценария, в виде
// объекта; его проверка получает id `real:<id>` и в итоги ворот не входит (своя строка).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const hubDataDir = (env = process.env) => env.HUB_DATA || path.join(os.homedir(), 'hub-data');
const corpusDir = (hubData) => path.join(hubData, 'polygon', 'corpus');

function realCorpus(id, hubData = hubDataDir()) {
  const f = path.join(corpusDir(hubData), `${id}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')).map((c) => ({ ...c, id: `real:${c.id}`, real: true }));
}

// A scenario's own extra file next to its corpus (H02 — правила замка живого проекта), or null.
function realFile(name, hubData = hubDataDir()) {
  const f = path.join(corpusDir(hubData), name);
  return fs.existsSync(f) ? f : null;
}

function realCorporaStatus(hubData = hubDataDir()) {
  const dir = corpusDir(hubData);
  if (!fs.existsSync(dir)) return `реальные корпуса пропущены: нет ${dir}`;
  const found = fs.readdirSync(dir).filter((f) => /^[A-Z]\d+\.json$/.test(f)).sort()
    .map((f) => `${f.slice(0, -5)} (${JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).length})`);
  return found.length ? `реальные корпуса: ${found.join(', ')}` : `реальные корпуса пропущены: ${dir} пуст`;
}

module.exports = { hubDataDir, realCorpus, realFile, realCorporaStatus };
