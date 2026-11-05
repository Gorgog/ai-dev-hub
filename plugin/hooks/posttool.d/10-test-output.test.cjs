// node --test 10-test-output.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mod = require('./10-test-output.cjs');

const bash = (stdout, stderr = '') => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test | tail -20' },
  tool_response: { stdout, stderr, interrupted: false, isImage: false } });

const VITEST_FAIL = ` ❯ src/a.test.ts (3 tests | 1 failed) 12ms
   × sums > adds 5ms

 Test Files  1 failed | 4 passed (5)
      Tests  1 failed | 41 passed (42)
   Start at  10:00:01
   Duration  1.20s`;
const VITEST_SKIP = ` Test Files  5 passed | 1 skipped (6)
      Tests  41 passed | 2 skipped (43)
   Duration  1.10s`;
const VITEST_OK = ` Test Files  5 passed (5)
      Tests  42 passed (42)
   Duration  1.00s`;
const JEST_FAIL = `FAIL src/a.test.ts
Test Suites: 1 failed, 3 passed, 4 total
Tests:       2 failed, 30 passed, 32 total
Snapshots:   0 total
Time:        3.1 s`;
const JEST_SKIP = `Test Suites: 1 skipped, 3 passed, 3 of 4 total
Tests:       4 skipped, 30 passed, 34 total
Time:        2.0 s`;
const JEST_OK = `Test Suites: 4 passed, 4 total
Tests:       32 passed, 32 total
Time:        2.9 s`;
const NODE_FAIL = `# tests 3\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0`;
const NODE_SPEC_SKIP = `ℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0`;
const NODE_OK = `# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0`;

test('test-output: exit 0 with failed tests is a block naming the runner line (vitest, jest, node --test)', () => {
  for (const [out, re] of [[VITEST_FAIL, /Tests\s+1 failed/], [JEST_FAIL, /Tests:\s+2 failed/], [NODE_FAIL, /fail 1/]]) {
    const r = mod.run(bash(out));
    assert.strictEqual(r && r.decision, 'block', out);
    assert.match(r.reason, re);
    assert.match(r.reason, /упал/);
  }
});

test('test-output: skipped tests in a «green» run are a block too', () => {
  for (const out of [VITEST_SKIP, JEST_SKIP, NODE_SPEC_SKIP]) {
    const r = mod.run(bash(out));
    assert.strictEqual(r && r.decision, 'block', out);
    assert.match(r.reason, /пропущ/);
  }
});

test('test-output: the summary on stderr counts as well (jest prints there)', () => {
  assert.strictEqual(mod.run(bash('', JEST_FAIL)).decision, 'block');
});

test('test-output: a green run, a quoted fixture, a non-Bash tool, an odd response — silent', () => {
  for (const out of [VITEST_OK, JEST_OK, NODE_OK, '', 'nothing to see']) assert.strictEqual(mod.run(bash(out)), null, out);
  // cat of a test file: the summaries sit inside string literals, not at the start of a line.
  assert.strictEqual(mod.run(bash("const JEST = 'Tests:       2 failed, 30 passed, 32 total';\nassert.match(out, /# fail 1/);")), null);
  assert.strictEqual(mod.run(bash('src/a.ts:3:Tests:       2 failed, 30 passed, 32 total')), null, 'grep output');
  assert.strictEqual(mod.run({ tool_name: 'Edit', tool_response: { stdout: JEST_FAIL } }), null);
  assert.strictEqual(mod.run({ tool_name: 'Bash', tool_response: JEST_FAIL }).decision, 'block', 'a plain string response');
  assert.strictEqual(mod.run({ tool_name: 'Bash' }), null);
});

test('review 1: colored output (ANSI codes) is read as plain; the reason does not push to «fix» an intended red run', () => {
  const r = mod.run(bash('\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m | 4 passed (5)'));
  assert.strictEqual(r && r.decision, 'block');
  assert.match(r.reason, /намеренно красн/);
});
