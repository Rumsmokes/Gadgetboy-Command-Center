const assert = require('node:assert/strict');
const fs = require('node:fs');

const operations = fs.readFileSync('src/components/DailyOperationsWindow.tsx', 'utf8');
const app = fs.readFileSync('src/App.tsx', 'utf8');
const toolbar = fs.readFileSync('src/components/Toolbar.tsx', 'utf8');
const center = fs.readFileSync('src/components/CommandCenter.tsx', 'utf8');
const mobile = fs.readFileSync('src/mobile/MobileApp.tsx', 'utf8');

assert.match(operations, /openingTime.*10:00/);
assert.match(operations, /closingTime.*18:50/);
assert.match(operations, /Collect and Send Cart total/);
assert.match(operations, /Check Orders/);
assert.match(operations, /OpeningChecklistSettings/);
assert.match(operations, /required/);
assert.match(operations, /onSubmitted/);
assert.match(operations, /trackingStartedOn/);
assert.match(operations, /Missing checklists/);
assert.match(operations, /Rectifying/);
assert.match(app, /ScheduledDailyOperationsGate/);
assert.match(app, /dailyOperationsSettings/);
assert.match(toolbar, /Opening \/ Closing Checklist/);
assert.match(mobile, /dailyOperationsSettings/);
assert.doesNotMatch(center, /command-center-checklist-button/);
assert.doesNotMatch(center, /DailyOperationsWindow/);
console.log('Scheduled daily operations checklist checks passed.');
