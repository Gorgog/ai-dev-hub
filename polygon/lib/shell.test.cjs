// node --test polygon/lib/shell.test.cjs — свой разбор shell полигона (общий с аналитикой 06 и замком 15).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bareCd } = require('./shell.cjs');

test('bareCd: cd меняет папку сессии только на верхнем уровне', () => {
  for (const cmd of ['cd /r && ls', 'export A=1\ncd /r', 'true; cd /r', 'if true; then cd /r; fi', 'A=1 cd /r'])
    assert.strictEqual(bareCd(cmd), true, cmd);
  for (const cmd of ['( cd /r && ls )', '( date; cd /r && ls )', 'x=$( cd /r && pwd )', 'echo "cd /r"', "echo 'cd /r'",
    "cat >> n.md <<'EOF'\ncd apps && npm test\nEOF", '# cd /r', 'git -C /r status', 'abcd /r'])
    assert.strictEqual(bareCd(cmd), false, cmd);
});

test('bareCd: после heredoc разбор продолжается', () => {
  assert.strictEqual(bareCd("cat > a <<EOF\ntext\nEOF\ncd /r"), true);
});
