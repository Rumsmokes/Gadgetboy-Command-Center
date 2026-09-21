const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbpos-command-center-test-'));
process.env.GBPOS_SEED_TEST_DATA = '1';
process.env.GBPOS_SEED_TEST_DATA_RESET = '1';
const { seedTestDataIfNeeded } = require(path.join(root, 'dist-main/app/electron/seed-test-data.js'));
const seeded = seedTestDataIfNeeded(tempRoot);
assert.equal(seeded.ok, true);
const db = JSON.parse(fs.readFileSync(path.join(tempRoot, 'gbpos-db.json'), 'utf8'));

const stages = new Set((db.workOrders || []).map((row) => row.workflowStage));
for (const stage of ['Diagnosing', 'Approval', 'Parts', 'Repair', 'Testing', 'Pickup']) assert(stages.has(stage), `missing ${stage} fixture`);
assert((db.purchaseOrders || []).some((order) => order.workOrderId && (db.workOrders || []).some((wo) => wo.id === order.workOrderId)), 'purchase order must link to its work order');
assert((db.calendarEvents || []).some((event) => event.category === 'task' && event.workOrderId), 'today task must link to a work order');
assert((db.calendarNotes || []).some((note) => note.workOrderId), 'calendar note must link to a work order');
assert((db.clientResponses || []).some((reply) => reply.legacy_record_id && (db.workOrders || []).some((wo) => wo.id === reply.legacy_record_id)), 'client reply must link to a work order');
assert((db.sales || []).some((sale) => (sale.items || []).some((item) => item.requiresOrder && item.orderStatus === 'ordered')), 'product delivery must originate from an ordered sale item');

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('Connected Command Center test data checks passed.');
