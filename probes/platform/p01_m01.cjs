#!/usr/bin/env node
// P1 bridge to the polygon prototype: one M01 run with the real model, the hub of this branch via --plugin-dir,
// the env variable under test and a PreToolUse(Bash) logger in the fixture's .claude/settings.local.json.
// usage: node p01_m01.cjs <hub-evals dir> <hub dir> <work dir> <ENV_NAME>   → last stdout line: JSON summary
'use strict';
const fs = require('fs');
const path = require('path');

async function main() {
  const [evals, hubDir, work, envName] = process.argv.slice(2);
  const { materialize } = require(path.join(evals, 'lib/hub.cjs'));
  const { runClaude } = require(path.join(evals, 'lib/claude.cjs'));
  const m01 = require(path.join(evals, 'scenarios/M01-bugfix-tdd-report.cjs'));
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const base = path.join(work, 'base');
  materialize(hubDir, 'HEAD', base);
  const st = await m01.setup({ base, work });
  const hookLog = path.join(work, 'bash-cwd.jsonl');
  const logger = path.join(work, 'log-bash.cjs');
  fs.writeFileSync(logger, `const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{` +
    `fs.appendFileSync(${JSON.stringify(hookLog)},JSON.stringify(JSON.parse(d))+'\\n')});\n`);
  const settings = { env: { [envName]: '1' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${logger}` }] }] } };
  fs.mkdirSync(path.join(st.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(st.cwd, '.claude', 'settings.local.json'), JSON.stringify(settings, null, 2));
  fs.appendFileSync(path.join(st.cwd, '.git', 'info', 'exclude'), '.claude/settings.local.json\n');
  const run = await runClaude({ cwd: st.cwd, prompt: st.prompt, pluginDir: path.join(base, 'plugin'),
    hubDir: st.hubDir, maxTurns: st.maxTurns, timeoutSec: st.timeoutSec,
    logFile: path.join(work, 'transcript.jsonl') });
  const checks = await m01.grade({ run, ...st });
  const agents = run.toolUses.filter((t) => t.name === 'Agent' || t.name === 'Task').map((t) => t.input.subagent_type);
  console.log(JSON.stringify({ cwd: st.cwd, hookLog, transcript: path.join(work, 'transcript.jsonl'), agents,
    turns: run.turns, code: run.code,
    checks: checks.map((c) => ({ id: c.id, pass: c.pass, detail: String(c.detail || '').slice(0, 160) })) }));
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
