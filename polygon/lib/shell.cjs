// Grader-side shell reading, independent of the hub's own regexps: is there a `cd` that changes the directory of
// the session's shell (top level, not inside `( … )` / `$( … )`, not in quotes or a heredoc body)?
'use strict';

function bareCd(cmd) {
  const s = String(cmd);
  let depth = 0, quote = null, atStart = true, heredoc = null, i = 0;
  const pendingHeredocs = [];
  while (i < s.length) {
    const c = s[i];
    if (heredoc) { // skip lines up to the terminator
      const end = s.indexOf('\n', i);
      const line = s.slice(i, end === -1 ? s.length : end);
      i = end === -1 ? s.length : end + 1;
      if (line.replace(/^\t+/, '') === heredoc) heredoc = pendingHeredocs.shift() || null;
      atStart = true;
      continue;
    }
    if (quote) { if (c === '\\' && quote === '"') { i += 2; continue; } if (c === quote) quote = null; i++; continue; }
    if (c === "'" || c === '"') { quote = c; atStart = false; i++; continue; }
    if (c === '\\') { i += 2; atStart = false; continue; }
    if (c === '#' && atStart) { const end = s.indexOf('\n', i); i = end === -1 ? s.length : end; continue; }
    const hd = s.slice(i).match(/^<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/);
    if (hd) { pendingHeredocs.push(hd[2]); i += hd[0].length; atStart = false; continue; }
    if (c === '\n') { if (pendingHeredocs.length) heredoc = pendingHeredocs.shift(); atStart = true; i++; continue; }
    if (c === '(') { depth++; atStart = true; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); atStart = false; i++; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '{') { atStart = true; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (atStart) {
      const w = s.slice(i).match(/^[^\s;|&()]+/)[0];
      if (w === 'cd' && depth === 0) return true;
      atStart = ['then', 'do', 'else', 'elif', '!', 'time'].includes(w) || /^\w+=\S*$/.test(w);
      i += w.length;
      continue;
    }
    i++;
  }
  return false;
}

module.exports = { bareCd };
