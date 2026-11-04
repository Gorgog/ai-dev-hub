// One headless run of Claude Code inside a fixture: the plugin of the version under test via --plugin-dir, user
// settings (and so the installed `hub` plugin, other plugins, MCP) cut off, stream-json transcript kept on disk.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function runClaude({ cwd, prompt, pluginDir, hubDir, model, maxTurns = 30, maxBudgetUsd = 3, timeoutSec = 900,
  allowedTools = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Agent', 'Skill'], logFile }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--setting-sources', 'project,local', '--strict-mcp-config', '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--allowedTools', allowedTools.join(','),
    '--disallowedTools', 'WebFetch,WebSearch',
    '--max-turns', String(maxTurns), '--max-budget-usd', String(maxBudgetUsd)];
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  if (model) args.push('--model', model);
  const env = { ...process.env, AI_DEV_HUB: hubDir || '', CLAUDE_PLUGIN_DATA: path.join(path.dirname(logFile), 'plugin-data') };
  delete env.CLAUDECODE; // a nested `claude` must not think it runs inside this session
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(logFile);
    let buf = '', err = '';
    p.stdout.on('data', (d) => { out.write(d); buf += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutSec * 1000);
    p.on('close', (code) => {
      clearTimeout(timer); out.end();
      const events = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ code, stderr: err.slice(-2000), events, wallMs: Date.now() - t0, ...summarize(events) });
    });
  });
}

// Everything the graders read from a transcript.
function summarize(events) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') || {};
  const result = [...events].reverse().find((e) => e.type === 'result') || {};
  const toolUses = [];
  const texts = [];
  for (const e of events) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'tool_use') toolUses.push({ name: b.name, input: b.input || {}, sub: Boolean(e.parent_tool_use_id) });
      if (b.type === 'text' && !e.parent_tool_use_id) texts.push(b.text);
    }
  }
  const hookEvents = events.filter((e) => e.type === 'system' && /hook/.test(e.subtype || ''));
  return {
    init: { model: init.model, plugins: init.plugins, pluginErrors: init.plugin_errors, skills: init.skills },
    toolUses, texts, hookEvents,
    finalText: result.result || texts[texts.length - 1] || '',
    allText: texts.join('\n\n'),
    costUsd: result.total_cost_usd || 0, turns: result.num_turns || 0, durationMs: result.duration_ms || 0,
    subtype: result.subtype, isError: result.is_error,
  };
}

module.exports = { runClaude, summarize };
