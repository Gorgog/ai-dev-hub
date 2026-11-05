// test-output (handler done-gate): a Bash call that exited 0 (PostToolUse comes only then) whose output carries a
// test summary with failed or skipped tests — vitest and jest exit 0 that way, and so does any run behind `| tail` or
// `|| echo FAIL` — is a block with the summary line: the run is not green, whatever the exit code says.
// A summary counts only at the start of a line: a test file printed by cat or grep holds them inside string literals.
'use strict';

// [runner, regexp over one line, what the counted word means]
const RULES = [
  ['vitest', /^\s*(?:Test Files|Tests)\s+.*?\b(\d+) (failed|skipped|todo)\b.*\(\d+\)\s*$/],
  ['jest', /^(?:Test Suites|Tests):\s+.*?\b(\d+) (failed|skipped|todo)\b.*\d+ total\s*$/],
  ['node --test', /^[#ℹ] (fail|cancelled|skipped|todo) (\d+)\s*$/],
];
const FAILED = new Set(['failed', 'fail', 'cancelled']);

// [{runner, line, failed: bool}] of every summary line that counts something not green.
function scan(text) {
  const hits = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const [runner, re] of RULES) {
      const m = line.match(re);
      if (!m) continue;
      const [word, n] = runner === 'node --test' ? [m[1], m[2]] : [m[2], m[1]];
      if (Number(n) > 0) hits.push({ runner, line: line.trim(), failed: FAILED.has(word) });
    }
  }
  return hits;
}

const outputOf = (r) => (typeof r === 'string' ? r : r && typeof r === 'object' ? `${r.stdout || ''}\n${r.stderr || ''}` : '');

module.exports = {
  id: 'test-output',
  scan,
  run(ev) {
    if (ev.tool_name !== 'Bash') return null;
    const hits = scan(outputOf(ev.tool_response));
    if (!hits.length) return null;
    const failed = hits.some((h) => h.failed);
    const lines = [...new Set(hits.map((h) => `«${h.line}» (${h.runner})`))].slice(0, 4).join('; ');
    return { decision: 'block', reason: `Вывод тестов не зелёный, хотя команда вышла с кодом 0: ${failed ? 'тесты упали' : 'есть пропущенные'} — ${lines}. `
      + (failed ? 'Это провал: разбери упавшие, «тесты зелёные» по такому прогону не писать.'
        : 'Пропущенные — не пройденные: сними skip или назови их в докладе с причиной.') };
  },
};
