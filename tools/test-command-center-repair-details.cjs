const assert = require('node:assert/strict');

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' },
});

const { repairPresentationFor, shouldOpenAttentionPanel, isExpeditedWorkOrder, compareRepairQueuePriority, partEtaFor, buildAttentionAudit } = require('../src/lib/commandCenterPresentation.ts');

const current = repairPresentationFor({
  id: 417,
  productCategory: 'Game Console',
  productDescription: 'PlayStation 5',
  model: 'CFI-1215A Disc Edition',
  serial: 'AJ1234567',
  problemInfo: 'No video after a power surge; HDMI port feels loose.',
  items: [{ repair: 'Diagnostic' }],
});

assert.deepEqual(current, {
  deviceLabel: 'PlayStation 5 - CFI-1215A Disc Edition',
  deviceCategory: 'Game Console',
  model: 'CFI-1215A Disc Edition',
  serial: 'AJ1234567',
  problem: 'No video after a power surge; HDMI port feels loose.',
});

const legacy = repairPresentationFor({
  productCategory: 'Laptop',
  items: [{ repair: 'Diagnostic' }],
});

assert.equal(legacy.deviceLabel, 'Laptop');
assert.equal(legacy.problem, 'Problem not entered');
assert.notEqual(legacy.deviceLabel, 'Diagnostic');

assert.equal(shouldOpenAttentionPanel(4, 4), false, 'A data refresh must not reopen Needs Attention.');
assert.equal(shouldOpenAttentionPanel(4, 5), true, 'A new explicit request must open Needs Attention.');
assert.equal(shouldOpenAttentionPanel(0, 0), false);

assert.equal(isExpeditedWorkOrder({ items: [{ repair: 'Expedited Service Fee', labor: 49 }] }), true);
assert.equal(isExpeditedWorkOrder({ items: [{ repair: 'Diagnostic', labor: 50 }] }), false);
assert.ok(compareRepairQueuePriority({ expedited: true, activityAt: '2026-09-10' }, { expedited: false, activityAt: '2026-09-01' }) < 0, 'Expedited work must sort before older standard work.');
assert.ok(compareRepairQueuePriority({ stage:'Testing', activityAt: '2026-09-10' }, { expedited:false, quickTurnaround:true, activityAt:'2026-09-01' }) < 0, 'Diagnosing and testing work must sort before quick-turnaround work.');
assert.ok(compareRepairQueuePriority({ quickTurnaround: true, activityAt: '2026-09-10' }, { stagnant:true, promisedAt: '2026-09-11', activityAt: '2026-09-01' }) < 0, 'Historically quick repairs must sort before stagnant work.');
assert.ok(compareRepairQueuePriority({ stagnant:true, activityAt:'2026-09-10' }, { promisedAt: '2026-09-11', activityAt: '2026-09-01' }) < 0, 'Stagnant repairs must sort before ordinary timed work.');
assert.ok(compareRepairQueuePriority({ promisedAt: '2026-09-11', activityAt: '2026-09-10' }, { activityAt: '2026-09-01' }) < 0, 'Timed repairs must sort before work with no timing data.');
assert.equal(partEtaFor({ repairStatus: 'Waiting on Part Delivery', estimatedDate: '2026-09-18', partsEstDelivery: '2026-09-17' }), '2026-09-17');
assert.equal(partEtaFor({ repairStatus: 'Customer Promise Scheduled', estimatedDate: '2026-09-18' }), '', 'A customer promise must not become a part ETA.');

const attentionAudit = buildAttentionAudit([
  { id: 1, activityAt: '2026-08-31T23:59:59', source: { createdAt: '2026-08-31T23:59:59' }, attentionReasons: [{ code: 'missing-device', label: 'Device information is missing' }] },
  { id: 2, activityAt: '2026-09-01T00:00:00', source: { createdAt: '2026-09-01T00:00:00' }, attentionReasons: [{ code: 'part-missing-eta', label: 'Ordered part needs an ETA' }] },
  { id: 3, activityAt: '2026-09-02T00:00:00', source: { createdAt: '2026-09-02T00:00:00' }, attentionReasons: [{ code: 'client-reply-unread', label: 'Unread client reply' }, { code: 'technician-unassigned', label: 'Technician assignment is missing' }] },
]);
assert.deepEqual(attentionAudit.entries.map(entry => entry.record.id), [2, 3], 'Needs Attention must exclude invoices before September 1.');
assert.equal(attentionAudit.entries.find(entry => entry.record.id === 3).reasons.length, 2, 'Multiple issues must stay together on one audit entry.');
assert.equal(attentionAudit.entries.find(entry => entry.record.id === 2).group, 'Money & inventory review');

console.log('Command Center device-first repair presentation checks passed.');
