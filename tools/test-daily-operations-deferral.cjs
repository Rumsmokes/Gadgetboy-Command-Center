const assert = require('node:assert/strict');
const fs = require('node:fs');

const gate = fs.readFileSync('src/App.tsx', 'utf8');
const windowSource = fs.readFileSync('src/components/DailyOperationsWindow.tsx', 'utf8');

assert.match(gate, /dailyOperationsChecklistDeferrals/, 'The required checklist gate must read saved one-time reminders.');
assert.match(gate, /isDeferred\('opening'\)/, 'A future opening reminder must suppress the required prompt until its chosen time.');
assert.match(windowSource, /Remind me later/, 'Required checklists must offer a visible one-time reminder action.');
assert.match(windowSource, /dailyOperationsChecklistDeferrals/, 'The reminder must persist across app restarts.');
assert.match(windowSource, /Clear all/, 'The missed-checklist panel must allow acknowledgement of every visible prior miss.');
assert.match(windowSource, /dailyOperationsClearedMisses/, 'Cleared misses must be retained as acknowledgements rather than fake submissions.');
assert.match(windowSource, /Operating days/, 'Checklist settings must expose operating-day controls.');
assert.match(gate, /operatingDays\.includes\(current\.getDay\(\)\)/, 'Closed days must not trigger a required checklist.');

console.log('Daily operations deferral checks passed.');
