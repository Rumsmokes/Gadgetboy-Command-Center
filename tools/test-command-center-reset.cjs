const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });

const { buildCommandCenterModel } = require('../src/lib/commandCenter.ts');
const fs = require('node:fs');
const path = require('node:path');

const now = new Date('2026-11-11T16:00:00.000Z');
const resetAt = '2026-11-11T15:00:00.000Z';
const preReset = {
  id: 41,
  status: 'open',
  workflowStage: 'Checked in',
  productDescription: 'PS5 Slim',
  checkInAt: '2026-11-10T09:00:00.000Z',
  activityAt: '2026-11-10T09:00:00.000Z',
  payments: [{ id: 'diagnostic-25', at: '2026-11-11T14:30:00.000Z', amount: 25, paymentType: 'Diagnostic fee' }],
  items: [],
};

const cleared = buildCommandCenterModel({
  now,
  commandCenterResetAt: resetAt,
  workOrders: [preReset],
  customers: [],
  technicians: [],
});
assert.equal(cleared.records.length, 0, 'A reset must hide pre-reset tickets from Command Center records.');
assert.equal(cleared.activeWorkOrders.length, 0, 'A reset must hide pre-reset tickets from Active Work Orders.');
assert.equal(cleared.needsAttention.length, 0, 'A reset must hide pre-reset audit entries from Needs Attention.');
assert.equal(cleared.collectedToday, 25, 'A reset must never remove today\'s payment total.');
assert.equal(cleared.paymentsToday, 1, 'A reset must retain today\'s payment-event count.');
assert.equal(preReset.status, 'open', 'Reset filtering must not mutate source ticket status.');
assert.equal(preReset.workflowStage, 'Checked in', 'Reset filtering must not reroute or close the source ticket.');

const clearedReconciliation = buildCommandCenterModel({
  now,
  commandCenterResetAt: resetAt,
  workOrders: [preReset],
  customers: [],
  technicians: [],
  cloverDailyTotals: { '2026-11-11': 25 },
});
assert.equal(clearedReconciliation.globalAttention.length, 0, 'A reset must also clear global Needs Attention entries until new activity occurs.');

const reactivated = buildCommandCenterModel({
  now,
  commandCenterResetAt: resetAt,
  workOrders: [{
    ...preReset,
    workflowStage: 'Testing',
    repairStatus: 'Testing In Progress',
    workflowUpdatedAt: '2026-11-11T15:01:00.000Z',
    activityAt: '2026-11-11T15:01:00.000Z',
    updatedAt: '2026-11-11T15:01:00.000Z',
  }],
  customers: [],
  technicians: [],
});
assert.deepEqual(reactivated.stages.Testing.map(row => row.id), [41], 'A post-reset QR/status update must return a ticket to its live stage.');

const commandCenterSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/CommandCenter.tsx'), 'utf8');
const toolbarSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/Toolbar.tsx'), 'utf8');
const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/App.tsx'), 'utf8');
assert.match(commandCenterSource, /Reset Command Center/, 'Command Center must expose a Reset Command Center action.');
assert.match(commandCenterSource, /commandCenterResetAt/, 'Command Center must persist and reload the shared reset timestamp.');
assert.match(commandCenterSource, /dbUpdate\?\.\('settings', data\.settingsRecord\.id, settings\)/, 'Reset must persist only the routing baseline in settings.');
assert.doesNotMatch(commandCenterSource.slice(commandCenterSource.indexOf('const resetCommandCenter'), commandCenterSource.indexOf('const markProductsDelivered')), /dbUpdate\?\.\('(workOrders|sales|customers|payments)'/, 'Reset must never edit saved POS records.');
assert.match(commandCenterSource, /onSettingsChanged/, 'A shared reset must refresh other open Command Centers.');
assert.match(appSource, /\['settings', 'settings'\]/, 'Supabase realtime must relay shared settings changes to open desktop installs.');
assert.match(toolbarSource, /\bCart\b/, 'Top toolbar must expose a distinct Cart action beside EOD.');

console.log('Command Center reset checks passed.');
