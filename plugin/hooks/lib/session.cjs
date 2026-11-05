// State file of a session (slice 12): per agent — the main thread is «main», a subagent its agent_id — the epoch of
// context and the marks of the delivery in it: what was shown, the deny-once keys, the open «prevented» windows, the
// calls seen. P16: SessionStart startup | clear | compact opens an epoch of the main thread, resume keeps it,
// SubagentStart opens the subagent's own. One small JSON per session in <data>/sessions/ (data — the folder of the
// hook journal), written under a lock file through a temporary file and rename: a reader never sees half of it.
// Only the hooks of this session write it; globally the delivery only appends events (events.cjs).
'use strict';
const fs = require('fs');
const path = require('path');
const { dir: dataDir } = require('./journal.cjs');

const SWEEP_DAYS = 30;
const LOCK_WAIT_MS = 500, LOCK_STALE_MS = 2000;

const freshAgent = (epoch) => ({ epoch, count: 0, calls: 0, recent: [], shown: {}, once: {}, detectors: {}, pending: [] });
const freshState = () => ({ v: 1, model: null, agents: {} });
const agentOf = (ev) => (ev && ev.agent_id) || 'main';

// The id comes from the event: only [A-Za-z0-9_.-], no leading dots — it cannot leave sessions/.
const safe = (sid) => String(sid || 'unknown').replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 128);
const file = (sid, dir = dataDir()) => path.join(dir, 'sessions', `${safe(sid)}.json`);

// A missing, broken or foreign file reads as a fresh state: the delivery then shows again, never less.
function read(sid, dir = dataDir()) {
  try {
    const st = JSON.parse(fs.readFileSync(file(sid, dir), 'utf8'));
    if (st && typeof st === 'object' && st.agents && typeof st.agents === 'object' && !Array.isArray(st.agents)) return st;
  } catch { /* fresh */ }
  return freshState();
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// fn(state) under the lock of the session's file; what fn returns is returned. Throws when the lock is not taken in
// LOCK_WAIT_MS or the folder is not writable: the caller falls back to the delivery of 08.
function update(sid, fn, dir = dataDir()) {
  const f = file(sid, dir);
  const lock = `${f}.lock`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock left by a killed hook: the critical section takes a millisecond, two seconds is a dead owner.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`замок ${lock} не взят за ${LOCK_WAIT_MS} мс`);
      pause(1 + Math.floor(Math.random() * 3));
    }
  }
  try {
    const st = read(sid, dir);
    const out = fn(st);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, f);
    return out;
  } finally {
    try { fs.unlinkSync(lock); } catch { /* gone */ }
  }
}

const modelOf = (m) => (typeof m === 'string' ? m : (m && (m.id || m.display_name)) || null);

// SessionStart / SubagentStart: the epoch of the agent after the event, the open windows of the epoch it closes
// (as «expired» events) and the model of the session.
function startEpoch(ev, dir = dataDir()) {
  if (!ev || !ev.session_id) return { epoch: null, expired: [], model: null };
  const sub = ev.hook_event_name === 'SubagentStart';
  const agent = sub ? agentOf(ev) : 'main';
  return update(ev.session_id, (st) => {
    if (!sub && modelOf(ev.model)) st.model = modelOf(ev.model);
    const cur = st.agents[agent];
    if (!sub && ev.source === 'resume' && cur) return { epoch: cur.epoch, expired: [], model: st.model };
    const expired = cur ? (cur.pending || []).map((p) => ({ kind: 'expired', lesson: p.lesson, detector: p.detector,
      calls: cur.calls - p.n, agent_id: agent, epoch: cur.epoch })) : [];
    st.agents[agent] = freshAgent(cur ? cur.epoch + 1 : 1);
    return { epoch: st.agents[agent].epoch, expired, model: st.model };
  }, dir);
}

// State files untouched for SWEEP_DAYS, and their leftovers (a lock or a temporary file of a killed hook).
function sweep(dir = dataDir()) {
  const d = path.join(dir, 'sessions');
  const old = Date.now() - SWEEP_DAYS * 864e5;
  let names = [];
  try { names = fs.readdirSync(d); } catch { return; }
  for (const n of names) {
    const f = path.join(d, n);
    try { if (fs.statSync(f).mtimeMs < old) fs.unlinkSync(f); } catch { /* raced */ }
  }
}

module.exports = { freshAgent, agentOf, file, read, update, startEpoch, sweep };
