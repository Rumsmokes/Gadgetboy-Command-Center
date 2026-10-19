const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });

const { storageFeeAccrual } = require('../src/lib/workOrderLifecycle.ts');
const fs = require('node:fs');

const started = storageFeeAccrual({}, new Date('2026-10-19T10:00:00Z'));
assert.deepEqual(started, { amount: 25, days: 1, started: true }, 'Starting the fee reminder must add only the first $25 day.');
assert.deepEqual(storageFeeAccrual({ storageFeeLastAccruedAt: '2026-10-19T10:00:00Z' }, new Date('2026-10-19T23:59:59Z')), { amount: 0, days: 0, started: false }, 'The same calendar day cannot add a second fee.');
assert.deepEqual(storageFeeAccrual({ storageFeeLastAccruedAt: '2026-10-19T10:00:00Z' }, new Date('2026-10-20T10:00:01Z')), { amount: 25, days: 1, started: false }, 'One elapsed day adds exactly $25.');
assert.deepEqual(storageFeeAccrual({ storageFeeLastAccruedAt: '2026-10-19T10:00:00Z' }, new Date('2026-10-23T10:00:01Z')), { amount: 100, days: 4, started: false }, 'Each missed day accrues one $25 increment, never the entire pre-reminder wait.');
const edge = fs.readFileSync('supabase/functions/client-updates/index.ts', 'utf8');
const desktopSync = fs.readFileSync('app/electron/electron-main.ts', 'utf8');
const mobileSync = fs.readFileSync('src/mobile/mobile-api.ts', 'utf8');
const updatePanel = fs.readFileSync('src/workorders/ClientUpdatePanel.tsx', 'utf8');
assert.match(edge, /storage_fee_last_accrued_at/);
assert.match(edge, /days\*25/);
assert.doesNotMatch(edge, /days-7/);
for (const source of [desktopSync, mobileSync, updatePanel]) {
  assert.match(source, /storage_fee_last_accrued_at/, 'Every client must retain the server accrual watermark after sync.');
}
console.log('Storage fee accrual checks passed.');
