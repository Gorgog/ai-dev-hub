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
// The critical section takes a millisecond: a lock older than LOCK_STALE_MS has a dead owner, and the wait is longer
// than that, so a hook killed a moment ago costs a wait, not a lost update.
const LOCK_WAIT_MS = 1200, LOCK_STALE_MS = 1000;
const V = 1;

const freshAgent = (epoch) => ({ epoch, counts: { lesson: 0, reminder: 0 }, calls: 0, recent: [], shown: {}, once: {}, detectors: {}, pending: [] });
const freshState = () => ({ v: V, model: null, agents: {} });
const agentOf = (ev) => (ev && ev.agent_id) || 'main';
// The agent's state in st, created or completed with the fields a reader of this version expects.
function agentIn(st, id) {
  const a = st.agents[id];
  st.agents[id] = a && typeof a === 'object' && !Array.isArray(a) ? { ...freshAgent(Number(a.epoch) || 1), ...a } : freshAgent(1);
  return st.agents[id];
}

// The id comes from the event: only [A-Za-z0-9_.-], no leading dots — it cannot leave sessions/.
const safe = (sid) => String(sid || 'unknown').replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 128);
const file = (sid, dir = dataDir()) => path.join(dir, 'sessions', `${safe(sid)}.json`);

// A missing, broken or foreign file (another schema version too) reads as a fresh state: the delivery then shows
// again, never less.
function read(sid, dir = dataDir()) {
  try {
    const st = JSON.parse(fs.readFileSync(file(sid, dir), 'utf8'));
    if (st && st.v === V && st.agents && typeof st.agents === 'object' && !Array.isArray(st.agents)) return st;
  } catch { /* fresh */ }
  return freshState();
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// fn(state) under the lock of the session's file; what fn returns is returned. Throws when the lock is not taken in
// LOCK_WAIT_MS or the folder is not writable: the caller falls back to the delivery of 08. The lock holds a token of
// its owner: a stale one is moved aside and removed only if it is still the one judged stale (a fresh lock taken in
// between is put back), and the owner removes only its own.
function update(sid, fn, dir = dataDir()) {
  const f = file(sid, dir);
  const lock = `${f}.lock`;
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.writeFileSync(lock, token, { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let seen, age;
      // The token first, the age second: a lock replaced in between is judged by its own (fresh) mtime.
      try { seen = fs.readFileSync(lock, 'utf8'); age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) {
        const aside = `${lock}.${token}.stale`;
        try { fs.renameSync(lock, aside); } catch { continue; }
        let moved = null;
        try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* gone */ }
        if (moved !== seen) { try { fs.linkSync(aside, lock); } catch { /* the place is taken: its owner goes on */ } }
        try { fs.unlinkSync(aside); } catch { /* gone */ }
        continue;
      }
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
    try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* gone */ }
  }
}

const modelOf = (m) => (typeof m === 'string' ? m : (m && (m.id || m.display_name)) || null);

// Windows of an agent at the end of its epoch, as events — by default all expired; the delivery passes its own rule.
const expireAll = (a) => {
  const out = a.pending.map((p) => ({ kind: 'expired', lesson: p.lesson, detector: p.detector, calls: a.calls - p.n }));
  a.pending = [];
  return out;
};

// SessionStart / SubagentStart on a state (inside update): the epoch of the agent after the event, the events of the
// windows of the epoch it closes (close(agent) → events, with agent_id and epoch added) and the model of the session.
// resume and a continued subagent (its agent_id is known) keep the epoch: their context is still there.
function openEpoch(st, ev, close = expireAll) {
  const sub = ev.hook_event_name === 'SubagentStart';
  const agent = sub ? agentOf(ev) : 'main';
  if (!sub && modelOf(ev.model)) st.model = modelOf(ev.model);
  const known = st.agents[agent] ? agentIn(st, agent) : null;
  if (known && (sub || ev.source === 'resume')) return { epoch: known.epoch, expired: [], model: st.model };
  const expired = known ? close(known).map((e) => ({ ...e, agent_id: agent, epoch: known.epoch })) : [];
  st.agents[agent] = freshAgent(known ? known.epoch + 1 : 1);
  return { epoch: st.agents[agent].epoch, expired, model: st.model };
}

function startEpoch(ev, dir = dataDir(), close = expireAll) {
  if (!ev || !ev.session_id) return { epoch: null, expired: [], model: null };
  return update(ev.session_id, (st) => openEpoch(st, ev, close), dir);
}

// SessionEnd: the windows of every agent of the session close (close(agent) → events).
function endSession(sid, dir = dataDir(), close = expireAll) {
  return update(sid, (st) => {
    const out = [];
    for (const id of Object.keys(st.agents)) {
      const a = agentIn(st, id);
      out.push(...close(a).map((e) => ({ ...e, agent_id: id, epoch: a.epoch })));
    }
    return { events: out, model: st.model };
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

module.exports = { freshAgent, agentOf, agentIn, file, read, update, openEpoch, startEpoch, endSession, sweep };
