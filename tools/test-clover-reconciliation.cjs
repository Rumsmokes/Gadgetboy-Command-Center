const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });

const { buildCommandCenterModel } = require('../src/lib/commandCenter.ts');
const now = new Date('2026-09-25T14:00:00.000Z');
const model = buildCommandCenterModel({
  now,
  workOrders: [{ id: 'wo-1', status: 'open', payments: [{ id: 'p-1', at: now.toISOString(), applied: 80 }] }],
  sales: [{ id: 'sale-1', status: 'closed', items: [{ description: 'Cable' }], payments: [{ id: 'p-2', at: now.toISOString(), applied: 20 }] }],
  cloverDailyTotals: { '2026-09-25': 125.50 },
});

assert.deepEqual(model.cloverReconciliation, {
  date: '2026-09-25',
  cloverTotal: 125.50,
  posTotal: 100,
  variance: 25.50,
  reconciled: false,
});
assert.ok(model.globalAttention.some(issue => issue.code === 'clover-variance' && issue.amount === 25.50), 'A Clover/POS mismatch must be an auditable Needs Attention issue.');

const matched = buildCommandCenterModel({
  now,
  workOrders: [{ id: 'wo-2', status: 'open', payments: [{ id: 'p-3', at: now.toISOString(), applied: 100 }] }],
  cloverDailyTotals: { '2026-09-25': 100 },
});
assert.equal(matched.cloverReconciliation.reconciled, true, 'Matching Clover and POS totals must be reconciled.');
assert.equal(matched.globalAttention.length, 0, 'A matching total must not create an audit alert.');

console.log('Clover daily reconciliation behavior passed.');
