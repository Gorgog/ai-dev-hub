#!/usr/bin/env node
// P15 writer: appends events seq <from>..<to>-1 of worker <w> to <file>, one appendFileSync (O_APPEND) per event —
// as a hook process does. Sizes: mostly 150–600 bytes, every 25th ~6 KB, every 200th ~70 KB (Cyrillic padding).
// <gap-ms> between events spreads the writes over time, so the kills land among them, not in node's start-up.
//   node p15_writer.cjs <file> <w> <from> <to> [gap-ms]
'use strict';
const fs = require('fs');

const [file, w, from, to, gap = '0'] = process.argv.slice(2);
const pause = new Int32Array(new SharedArrayBuffer(4));
for (let seq = Number(from); seq < Number(to); seq++) {
  const size = seq % 200 === 0 ? 70000 : seq % 25 === 0 ? 6000 : 150 + ((seq * 37 + Number(w) * 101) % 450);
  const ev = { w: Number(w), seq, kind: 'shown', lesson: `L${seq % 97}`, session: `s-${w}`, pad: '' };
  const base = Buffer.byteLength(JSON.stringify(ev));
  ev.pad = 'ж'.repeat(Math.max(0, Math.floor((size - base) / 2)));
  fs.appendFileSync(file, JSON.stringify(ev) + '\n');
  if (Number(gap)) Atomics.wait(pause, 0, 0, Number(gap));
}
