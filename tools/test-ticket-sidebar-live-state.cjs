const assert = require('node:assert/strict');
const fs = require('node:fs');

const sidebar = fs.readFileSync('src/workorders/WorkOrderSidebar.tsx', 'utf8');
const workOrderWindow = fs.readFileSync('src/workorders/NewWorkOrderWindow.tsx', 'utf8');
const saleWindow = fs.readFileSync('src/sales/SaleWindow.tsx', 'utf8');

assert.match(sidebar, /statusUpdatedAt/, 'The ticket sidebar must read the current status-update timestamp.');
assert.match(sidebar, /lastUpdateNote/, 'The ticket sidebar must read the saved update note.');
assert.match(sidebar, /statusUpdate/, 'The ticket sidebar must read the saved status update label.');
assert.match(sidebar, /onChange\(\{ status:/, 'Open and closed status must be switchable from the sidebar.');
assert.match(workOrderWindow, /ClientUpdatePanel[\s\S]*onUpdated=/, 'Work-order updates must return their saved record to the open work-order window.');
assert.match(saleWindow, /ClientUpdatePanel[\s\S]*onUpdated=/, 'Sale updates must return their saved record to the open sale window.');

console.log('Ticket sidebar live-state checks passed.');
