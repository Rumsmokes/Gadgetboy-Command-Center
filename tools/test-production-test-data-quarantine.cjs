
const assert = require('node:assert/strict');
const { sanitizeAccidentalTestData } = require('../dist-main/app/electron/test-data-quarantine.js');

const fakeCustomer = { id: 1, email: 'alex.moore@example.com', phone: '803-100-0079', createdAt: '2026-09-22T23:49:29.201Z' };
const realCustomer = { id: 99, email: 'real@example.net', phone: '803-555-0199', createdAt: '2026-09-01T12:00:00.000Z' };
const fakeWorkOrder = { id: 1225, customerId: 1, intakeSource: 'Test Environment', serial: 'TEST-SERIAL' };
const realWorkOrder = { id: 1520, customerId: 99, productDescription: 'iPhone 15' };

const source = {
  _meta: { seedProfile: 'test-week', seededAt: '2026-09-22T23:49:29.201Z' },
  customers: [fakeCustomer, realCustomer],
  workOrders: [fakeWorkOrder, realWorkOrder],
  sales: [{ id: 1231, customerId: 1 }, { id: 1600, customerId: 99 }],
  quotes: [{ id: 1, customerId: 1 }, { id: 9, customerId: 99 }],
  calendarEvents: [{ id: 1, customerId: 1, workOrderId: 1225 }, { id: 99, customerId: 99, workOrderId: 1520 }],
  purchaseOrders: [{ id: 'po-test-1', customerId: 1, workOrderId: 1225 }, { id: 'po-real', customerId: 99, workOrderId: 1520 }],
  notifications: [{ id: 1, workOrderId: 1225 }, { id: 2, workOrderId: 1520 }],
  products: [{ id: 3, createdAt: '2026-09-22T23:49:29.201Z' }, { id: 19, createdAt: '2026-09-01T12:00:00.000Z' }],
  repairCategories: [{ id: 'rc-1', createdAt: '2026-09-22T23:49:29.201Z' }, { id: 'real', createdAt: '2026-09-01T12:00:00.000Z' }],
};

const { db, summary } = sanitizeAccidentalTestData(source);
assert.equal(summary.removed, 7, 'removes explicitly marked generated records without inferring by reused customer IDs');
assert.equal(db.customers.length, 1);
assert.equal(db.workOrders.length, 1);
assert.equal(db.sales.length, 2, 'unmarked sales remain for a fixture-specific cleanup pass');
assert.equal(db.quotes.length, 2, 'unmarked quotes remain for a fixture-specific cleanup pass');
assert.equal(db.calendarEvents.length, 1);
assert.equal(db.purchaseOrders.length, 1);
assert.equal(db.notifications.length, 1);
assert.equal(db.products.length, 1);
assert.equal(db.repairCategories.length, 1);
assert.equal(db._meta?.seedProfile, undefined, 'production DB must not retain the seed profile marker');
assert.deepEqual(db.workOrders[0], realWorkOrder, 'real work order is preserved');
console.log('Production test-data quarantine behavior passed.');
