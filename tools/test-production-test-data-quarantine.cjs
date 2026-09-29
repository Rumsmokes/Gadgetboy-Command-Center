
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
assert.equal(summary.removed, 9, 'removes generated records linked to a confirmed test customer without relying on old metadata.');
assert.equal(db.customers.length, 1);
assert.equal(db.workOrders.length, 1);
assert.equal(db.sales.length, 1, 'Sales linked to a confirmed test customer are quarantined with the rest of its fixture data.');
assert.equal(db.quotes.length, 1, 'Quotes linked to a confirmed test customer are quarantined with the fixture.');
assert.equal(db.calendarEvents.length, 1);
assert.equal(db.purchaseOrders.length, 1);
assert.equal(db.notifications.length, 1);
assert.equal(db.products.length, 1);
assert.equal(db.repairCategories.length, 1);
assert.equal(db._meta?.seedProfile, undefined, 'production DB must not retain the seed profile marker');
assert.deepEqual(db.workOrders[0], realWorkOrder, 'real work order is preserved');


const unmarkedSeedProfile = {
  customers: [fakeCustomer, realCustomer],
  workOrders: [fakeWorkOrder, realWorkOrder],
  sales: [{ id: 1231, customerId: 1 }, { id: 1600, customerId: 99 }],
};
const unmarkedResult = sanitizeAccidentalTestData(unmarkedSeedProfile);
assert.equal(unmarkedResult.db.customers.length, 1, 'A production cache must quarantine the deterministic test customer even after its old seed marker was cleared.');
assert.equal(unmarkedResult.db.workOrders.length, 1, 'A production cache must quarantine explicitly marked test work orders without relying on old metadata.');
assert.equal(unmarkedResult.db.sales.length, 1, 'Sales linked to a quarantined test customer must not survive as orphaned test data.');


const electronSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'electron', 'electron-main.ts'), 'utf8');
assert.match(electronSource, /const sanitized = sanitizeAccidentalTestData\(nextDb\);[\s\S]*writeDb\(sanitized\.db\);/, 'Cloud-to-local merges must pass through the generated-data quarantine before they reach the production cache.');

console.log('Production test-data quarantine behavior passed.');
