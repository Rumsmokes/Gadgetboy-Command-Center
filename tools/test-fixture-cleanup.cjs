
const assert = require('node:assert/strict');
const { removeFixtureRows } = require('./fixture-cleanup.cjs');

const fixture = {
  customers: [{ id: 1, email: 'alex@example.com', phone: '803-100-0001' }],
  workOrders: [{ id: 1224, customerId: 1, customerName: 'Alex Moore', productDescription: 'PlayStation 5', problemInfo: 'No display' }],
  sales: [{ id: 1203, customerId: 1, itemDescription: 'USB-C Cable', total: 15 }],
};
const live = {
  _meta: { seedProfile: 'test-week' },
  customers: [{ id: 1, email: 'alex@example.com', phone: '803-100-0001' }, { id: 2, email: 'real@example.net' }],
  workOrders: [
    { id: 1224, customerId: 1, customerName: 'Alex Moore', productDescription: 'PlayStation 5', problemInfo: 'No display' },
    { id: 1225, customerId: 1, customerName: 'Real Client', productDescription: 'PS5 OG', problemInfo: 'No power' },
  ],
  sales: [{ id: 1203, customerId: 1, itemDescription: 'USB-C Cable', total: 15 }],
};
const { db, removedByCollection } = removeFixtureRows(live, fixture);
assert.equal(db.customers.length, 1);
assert.equal(db.workOrders.length, 1, 'real row with a reused customer ID remains');
assert.equal(db.workOrders[0].id, 1225);
assert.equal(db.sales.length, 0);
assert.deepEqual(removedByCollection, { customers: 1, workOrders: 1, sales: 1 });
console.log('Fixture cleanup identity matching passed.');
