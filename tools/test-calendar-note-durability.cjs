const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mobileApi = fs.readFileSync(path.join(root, 'src/mobile/mobile-api.ts'), 'utf8');
const calendarWindow = fs.readFileSync(path.join(root, 'src/components/CalendarWindow.tsx'), 'utf8');

assert.match(mobileApi, /queuePending\(\{ op: 'upsert', key, item \}\);/, 'Failed writes must remain queued for retry.');
assert.match(
  mobileApi,
  /key === 'calendarNotes'[\s\S]{0,360}upsertLocalOnly\(key, \{ \.\.\.item, pendingSync: true/,
  'Calendar notes must remain locally visible when a direct cloud write fails.'
);
assert.match(
  calendarWindow,
  /saved\?\.pendingSync/,
  'The calendar window must explain when a note is saved locally and awaiting sync.'
);

console.log('Calendar note durability checks passed.');
