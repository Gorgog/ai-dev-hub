// Memory events (stub: the red commit of slice 14).
'use strict';
const MAX_LINE = 4096;
const appendEvent = () => '';
const readEvents = () => ({ events: [], problems: [] });
const foldEvents = () => ({});
module.exports = { appendEvent, readEvents, foldEvents, MAX_LINE };
