const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
for (const file of ['src/mobile/mobile-api.ts', 'app/electron/electron-main.ts']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const fallbackStart = source.indexOf("if (res.error && key === 'calendarNotes' && /attachments|schema cache|column/i.test");
  assert.notEqual(fallbackStart, -1, `${file} must identify the calendar-note attachments schema mismatch.`);
  const fallback = source.slice(fallbackStart, fallbackStart + 900);
  assert.ok(fallback.includes('delete fallbackRow.attachments;'), `${file} must remove attachments in the compatibility retry.`);
  assert.ok(/\.(?:insert|upsert)\(fallbackRow/.test(fallback), `${file} must retry the calendar-note write with the compatibility row.`);
}

console.log('Calendar note attachment fallback checks passed.');
