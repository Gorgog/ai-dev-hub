// Event journal of the delivery (slice 12) — skeleton: the tests come first.
'use strict';

const append = () => {};
const files = () => [];
const read = () => ({ events: [], torn: 0 });
const stats = () => ({ lessons: {}, rules: {}, total: {} });

module.exports = { append, files, read, stats };
