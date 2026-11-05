#!/usr/bin/env node
// Hook spine: one node process per hook event. usage (hooks.json): node run.cjs <Event>, the event JSON on stdin.
// Behaviour lives in modules — plugin/hooks/<event>.d/*.cjs, run in file-name order, each with a record in
// plugin/mechanisms/<id>.json (stage, failure policy). Contract of a module:
//   module.exports = { id, run(ev, ctx) }  ctx = { event, hub, project, worktree, stage, version, epoch }
//   run returns null or { decision?: 'block' | 'deny' | 'ask', reason?, once?, lesson?, detector?, items?: [{ text,
//   priority?, key?, lesson?, rule?, detector?, source? }] }, may be async, never writes to stdout: only this runner
//   speaks to Claude, items and decisions go through lib/deliver.cjs (slice 12: limits, «already shown» per epoch,
//   the event journal; its stage is the stage of the record «delivery», off — the delivery of 08).
// A block or deny ends the chain; a deny-once (`once: <key>`) already used in the epoch is dropped and the chain goes
// on, and without the delivery's state it becomes the lesson's text (fail-open). Failure policy: a module that throws
// or breaks the contract is journaled; with onError "closed" inside its failScope (a protection: the lock,
// rules-guard) the call is denied with the reason, otherwise (delivery, reminders) it is skipped. The switch HUB_OFF=1
// or <hub>/.hub-off silences everything, no restart needed. SessionStart also runs the health check (lib/health.cjs).
'use strict';
const fs = require('fs');
const path = require('path');

const DECISIONS = new Set(['block', 'deny', 'ask']);

// A result outside the contract is a broken module: the message says what is wrong.
function contractError(res) {
  if (res == null) return null;
  if (typeof res !== 'object' || Array.isArray(res)) return `результат не объект: ${JSON.stringify(res)}`.slice(0, 200);
  if (res.decision != null && !DECISIONS.has(res.decision)) return `decision «${res.decision}» — ожидается block | deny | ask`;
  if (res.decision != null && (typeof res.reason !== 'string' || !res.reason.trim())) return `decision ${res.decision} без reason`;
  if (res.items != null && (!Array.isArray(res.items) || res.items.some((it) => !it || typeof it.text !== 'string'))) return 'items — не массив { text }';
  return null;
}

async function main(event) {
  const hubLib = require('./lib/hub.cjs');
  if (hubLib.isOff()) return;
  const { EVENTS, loadRegistry, unregistered } = require('./lib/registry.cjs');
  const dirName = EVENTS[event];
  if (!dirName) return;
  const dir = path.join(__dirname, dirName);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.c?js$/.test(f) && !/\.test\.c?js$/.test(f)).sort(); } catch { /* no folder */ }
  // An event without modules costs one process start and a readdir; SessionStart still has the health check.
  if (!files.length && event !== 'SessionStart') return;

  let ev;
  try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const { journal, file: journalFile } = require('./lib/journal.cjs');
  const { version } = require('./lib/version.cjs');
  const { deliver, open: openDelivery } = require('./lib/deliver.cjs');
  const plugin = hubLib.PLUGIN_ROOT;
  const project = hubLib.findProject(ev.cwd);
  const ctx = { event, hub: hubLib.HUB_ROOT, project, worktree: hubLib.worktreeOf(ev.cwd, project), epoch: null, version: version(plugin) };
  const registry = loadRegistry(plugin);
  const items = [];
  const fired = [];
  let final = null;

  // A canary lists mechanisms or their handlers: «delivery» turns on every module of the delivery at once.
  const canary = (rec) => {
    if (!project) return false;
    try { return (JSON.parse(fs.readFileSync(path.join(project.dir, 'canary.json'), 'utf8')).mechanisms || []).some((m) => m === rec.id || m === rec.handler); } catch { return false; }
  };
  // The delivery with memory — only where its record is on (or canary here); no record — the delivery of 08.
  const dRec = [...registry.byFile.values()].find((r) => r && r.id === 'delivery');
  const dl = dRec && (dRec.stage === 'on' || (dRec.stage === 'canary' && canary(dRec))) ? openDelivery(event, ev) : null;
  if (dl) ctx.epoch = dl.epoch();

  if (event === 'SessionStart') {
    let problems;
    try { problems = require('./lib/health.cjs').health({ plugin, hub: ctx.hub, registryProblems: [...registry.problems, ...unregistered(plugin, registry.byFile)] }); } catch (e) {
      problems = [`проверка здоровья упала: ${String(e.message).split('\n')[0]}`];
    }
    journal({ type: 'health', event, hub: ctx.version, cwd: ev.cwd, problems });
    if (problems.length) items.push({ text: `Здоровье хаба (${ctx.version}):\n${problems.map((p) => `- ${p}`).join('\n')}`, priority: 'reminder', key: 'health', module: 'health' });
  }

  for (const f of files) {
    const rel = `${dirName}/${f}`;
    const rec = registry.byFile.get(rel);
    // No record or a broken one: run it as «on», failure closed inside the hub's projects (pre-commit refuses this).
    const stage = rec && ['off', 'canary', 'on'].includes(rec.stage) ? rec.stage : 'on';
    if (stage === 'off' || (stage === 'canary' && !canary(rec))) continue;
    const policy = rec && rec.onError === 'open' ? 'open' : 'closed';
    const scope = rec && ['any', 'project', 'worktree'].includes(rec.failScope) ? rec.failScope : 'project';

    let res, error = null, wrote = '';
    const realWrite = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => { wrote += String(chunk); const cb = rest.find((r) => typeof r === 'function'); if (cb) cb(); return true; };
    try {
      const mod = require(path.join(dir, f));
      if (!mod || typeof mod.run !== 'function') throw new Error('модуль без run()');
      res = await mod.run(ev, { ...ctx, stage });
      error = contractError(res);
    } catch (e) {
      error = String((e && e.message) || e).split('\n')[0];
    } finally {
      process.stdout.write = realWrite;
    }
    if (wrote) journal({ type: 'stdout', event, module: rel, hub: ctx.version, text: wrote.slice(0, 200) });

    if (error) {
      const inScope = scope === 'any' || (scope === 'project' && project) || (scope === 'worktree' && ctx.worktree);
      const closed = policy === 'closed' && inScope && (event === 'PreToolUse' || (event === 'Stop' && !ev.stop_hook_active));
      journal({ type: 'error', event, module: rel, id: rec && rec.id, hub: ctx.version, cwd: ev.cwd, error, policy: closed ? 'closed' : 'open' });
      if (closed) {
        final = { decision: event === 'PreToolUse' ? 'deny' : 'block', reason: `Хаб: модуль ${rel} сломан (${error}) — защита закрыта, вызов не пропущен. `
          + `Починить модуль или выключить хаб: файл ${path.join(ctx.hub, '.hub-off')} (действует сразу) или HUB_OFF=1 при запуске сессии. `
          + `Журнал: ${journalFile()}` };
        break;
      }
      continue;
    }
    if (dl && (event === 'SessionStart' || event === 'SubagentStart')) ctx.epoch = dl.epoch(true);
    if (!res) continue;
    const owner = rec ? rec.id : rel;
    if (res.once != null && (res.decision === 'block' || res.decision === 'deny')) {
      const claim = dl ? dl.claimOnce(String(res.once)) : null;
      if (claim === false) {
        if (res.detector) fired.push({ detector: res.detector, lesson: res.lesson });
        res = { items: res.items };
      } else if (claim === null) {
        res = { items: [...(res.items || []), { text: res.reason, priority: 'lesson', key: `once:${res.once}`, lesson: res.lesson, detector: res.detector }] };
      }
    }
    if (res.items) items.push(...res.items.map((it) => ({ ...it, module: it.module || owner })));
    if (res.decision) res = { ...res, module: owner };
    if (res.decision === 'block' || res.decision === 'deny') { final = res; break; }
    if (res.decision === 'ask' && !final) final = res;
  }

  // What can reach Claude after the decision: a deny / block carries only its reason, a PreToolUse ask — nothing else.
  const reaches = (f) => {
    if (event === 'PreToolUse') return !f;
    if (event === 'PostToolUse' || event === 'PostToolUseFailure') return !f || f.decision === 'ask';
    return event === 'SessionStart' || event === 'SubagentStart';
  };
  let text;
  if (dl) ({ text, final } = dl.finish({ items, final, fired, reaches }));
  else text = deliver(items);
  // Every write is awaited: the runner exits right after main(), and a write still queued in a pipe (more than its
  // capacity — 64 KB, 4 KB when pipe pages run short) would be cut, a cut JSON deny is no decision at all.
  const emit = (stream, s) => new Promise((resolve) => stream.write(s, () => resolve()));
  const out = (o) => emit(process.stdout, JSON.stringify(o));
  if (event === 'PreToolUse') {
    if (final && final.decision === 'block') { process.exitCode = 2; return emit(process.stderr, final.reason); }
    if (final) return out({ hookSpecificOutput: { hookEventName: event, permissionDecision: final.decision, permissionDecisionReason: final.reason } });
    if (text) return out({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
  } else if (event === 'Stop' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (final && final.decision !== 'ask') return out({ decision: 'block', reason: final.reason });
    if (text && event !== 'Stop') return out({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
  } else if (event === 'SessionStart') {
    if (text) return emit(process.stdout, text + '\n');
  } else if (event === 'SubagentStart') {
    if (text) return out({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
  }
}

// The command-line entry, also of the v1 files kept for live sessions. Explicit exit, as v1 did: the natural
// teardown of node costs several ms on every tool call; main() resolves only after its output is written.
const cli = (event) => main(event).catch(() => { /* never break a session */ }).then(() => process.exit());

if (require.main === module) cli(process.argv[2]);

module.exports = { main, cli };
