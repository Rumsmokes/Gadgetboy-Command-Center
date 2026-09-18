const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });

const {
  commandCenterMoveOptions,
  commandCenterMoveFields,
  buildCommandCenterMoveRequest,
} = require('../src/lib/commandCenterMove.ts');

const source = {
  id: 1219,
  status: 'open',
  workflowStage: 'Checked in',
  items: [
    { description: 'HDMI port', requiresOrder: true, orderStatus: 'ordered' },
    { description: 'Labor', isLabor: true, requiresOrder: true, orderStatus: 'ordered' },
  ],
};

assert.deepEqual(
  commandCenterMoveOptions(source).map((option) => option.key),
  ['diagnosis', 'repair_approval', 'waiting_part', 'part_delivered', 'testing_in_progress', 'repair_complete', 'not_possible'],
  'Move To must expose only operational client-facing destinations.',
);
assert.ok(!commandCenterMoveOptions(source).some((option) => ['manual_update', 'picked_up', 'technician_progress'].includes(option.key)));

assert.deepEqual(commandCenterMoveFields('diagnosis'), [], 'Diagnosis should move immediately without an unnecessary form.');
assert.deepEqual(commandCenterMoveFields('waiting_part'), ['orderDate', 'estimatedDate', 'notes']);
assert.deepEqual(commandCenterMoveFields('part_delivered'), ['itemIndexes', 'deliveredDate', 'notes']);
assert.deepEqual(commandCenterMoveFields('repair_approval'), ['partsEstimate', 'laborEstimate', 'estimatedDate', 'notes']);

const approval = buildCommandCenterMoveRequest(source, 'repair_approval', {
  partsEstimate: '79.99', laborEstimate: '120', estimatedDate: '2026-09-22', notes: 'Allow 2–3 business days.',
}, 'fixed-key');
assert.deepEqual(approval, {
  recordType: 'repair', recordId: 1219, statusKey: 'repair_approval', estimatedDate: '2026-09-22',
  notes: 'Parts: $79.99\nLabor: $120.00\nEstimated total: $199.99\nAllow 2–3 business days.',
  deliveryMode: 'email', idempotencyKey: 'fixed-key',
});

assert.throws(
  () => buildCommandCenterMoveRequest(source, 'waiting_part', { orderDate: '2026-09-18', notes: 'Ordered' }, 'fixed-key'),
  /expected delivery date/i,
  'Awaiting Parts must not send an incomplete update.',
);
assert.deepEqual(
  buildCommandCenterMoveRequest(source, 'waiting_part', { orderDate: '2026-09-18', estimatedDate: '2026-09-22', notes: 'Tracking pending.' }, 'fixed-key'),
  { recordType: 'repair', recordId: 1219, statusKey: 'part_ordered', estimatedDate: '2026-09-22', notes: 'Ordered: 2026-09-18\nTracking pending.', deliveryMode: 'email', idempotencyKey: 'fixed-key' },
  'Awaiting Parts must preserve both the actual order date and expected delivery date.',
);
assert.throws(
  () => buildCommandCenterMoveRequest(source, 'part_delivered', { deliveredDate: '2026-09-18', itemIndexes: [1] }, 'fixed-key'),
  /ordered part or product/i,
  'Labor rows must never be accepted as delivered parts.',
);
assert.deepEqual(
  buildCommandCenterMoveRequest(source, 'part_delivered', { deliveredDate: '2026-09-18', itemIndexes: [0], notes: 'Shipment received.' }, 'fixed-key'),
  {
    recordType: 'repair', recordId: 1219, statusKey: 'items_delivered',
    notes: 'Delivered: 2026-09-18\nShipment received.', itemIndexes: [0], deliveryMode: 'email', idempotencyKey: 'fixed-key',
  },
  'Delivered parts must use the item-aware QR workflow action.',
);

console.log('Command Center Move To workflow tests passed.');
