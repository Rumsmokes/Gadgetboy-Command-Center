const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });
const { buildCommandCenterModel } = require('../src/lib/commandCenter.ts');

const now = new Date('2026-09-27T15:00:00-04:00');
const model = buildCommandCenterModel({
  now,
  customers: [{ id: 7, firstName: 'Avery', lastName: 'Client' }],
  workOrders: [{ id: 44, customerId: 7, items: [{ repair: 'PS5 HDMI repair' }], payments: [
    { id: 'diag', at: '2026-09-27T09:00:00-04:00', applied: 25, paymentType: 'Diagnostic fee', paymentMethod: 'Cash' },
    { id: 'final', at: '2026-09-27T14:00:00-04:00', applied: 70, paymentType: 'Final repair payment', paymentMethod: 'Card' },
    { id: 'final', at: '2026-09-27T14:00:00-04:00', applied: 70, paymentType: 'Final repair payment', paymentMethod: 'Card' },
  ] }],
  sales: [{ id: 81, customerId: 0, quickCheckoutType: 'sale', amountPaid: 50 }],
});
assert.equal(model.collectedToday, 95);
assert.equal(model.collectedTodayTransactions.length, 2);
assert.deepEqual(model.collectedTodayTransactions.map(row => [row.invoiceLabel, row.amount]), [['WO #44', 70], ['WO #44', 25]]);
assert.equal(model.collectedTodayTransactions[0].clientLabel, 'Avery Client');
assert.equal(model.collectedTodayTransactions[0].paymentMethod, 'Card');
console.log('Collected Today transaction log checks passed.');
