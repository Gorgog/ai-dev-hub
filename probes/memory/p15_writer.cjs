#!/usr/bin/env node
// P15 writer: appends events seq <from>..<to>-1 of worker <w> to <file>, one appendFileSync (O_APPEND) per event —
// as a hook process does. Sizes: mostly 150–600 bytes, every 25th ~6 KB, every 200th ~70 KB (Cyrillic padding).
// <gap-ms> between events spreads the writes over time, so the kills land among them, not in node's start-up.
// <mode>: one — the event in one write (the mechanism); split — in two writes with the gap between the halves (the
// control: a kill between them must tear the line); large — every event ~256 KB in one write (a kill inside a
// many-page write is the one way the kernel may cut it short).
//   node p15_writer.cjs <file> <w> <from> <to> [gap-ms] [one|split|large]
'use strict';
const fs = require('fs');

const [file, w, from, to, gap = '0', mode = 'one'] = process.argv.slice(2);
const pause = new Int32Array(new SharedArrayBuffer(4));
const wait = () => { if (Number(gap)) Atomics.wait(pause, 0, 0, Number(gap)); };
for (let seq = Number(from); seq < Number(to); seq++) {
  const size = mode === 'large' ? 256000
    : seq % 200 === 0 ? 70000 : seq % 25 === 0 ? 6000 : 150 + ((seq * 37 + Number(w) * 101) % 450);
  const ev = { w: Number(w), seq, kind: 'shown', lesson: `L${seq % 97}`, session: `s-${w}`, pad: '' };
  const base = Buffer.byteLength(JSON.stringify(ev));
  ev.pad = 'ж'.repeat(Math.max(0, Math.floor((size - base) / 2)));
  const line = Buffer.from(JSON.stringify(ev) + '\n');
  if (mode === 'split') {
    const half = Math.floor(line.length / 2);
    fs.appendFileSync(file, line.subarray(0, half));
    wait();
    fs.appendFileSync(file, line.subarray(half));
  } else {
    fs.appendFileSync(file, line);
  }
  wait();
}
