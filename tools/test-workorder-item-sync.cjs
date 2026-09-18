const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const workOrder = read('src/workorders/NewWorkOrderWindow.tsx');
const items = read('src/workorders/ItemsTable.tsx');
const sale = read('src/sales/SaleWindow.tsx');
const sidebar = read('src/workorders/WorkOrderSidebar.tsx');
const desktop = read('app/electron/electron-main.ts');
const mobile = read('src/mobile/mobile-api.ts');
const desktopCss = read('src/styles/index.css');
const mobileCss = read('src/mobile/mobile.css');
const ticketAccounting = read('src/lib/ticketAccounting.ts');

assert.match(workOrder, /mappedItems:[\s\S]*\.\.\.it,[\s\S]*orderSourceUrl:[\s\S]*internalCost:[\s\S]*quantity:/, 'Reopening a work order must preserve its complete Supabase line-item ordering payload.');
assert.match(workOrder, /const items = wo\.items\.map\(row => \(\{[\s\S]*\.\.\.row,[\s\S]*qty: workOrderItemQuantity\(row\)/, 'Shared work-order records must retain ordering metadata and quantity.');
assert.match(workOrder, /onCommit=\{handleItemsCommit\}/, 'The work-order item editor must use the durable commit callback.');
assert.match(workOrder, /handleItemsCommit[\s\S]*dbUpdate\('workOrders', id, payload\)/, 'Line-item Save must immediately persist the complete work order.');
assert.match(workOrder, /calculateWorkOrderItemAmounts[\s\S]*discountedWorkOrderItemAmounts\(item\)/, 'Work-order totals must route every row through shared discount accounting.');
assert.match(ticketAccounting, /partsGross[\s\S]*Number\(input\.parts\)[\s\S]*quantity/, 'Shared accounting must multiply the client part charge by quantity.');
assert.match(items, /await onCommit\?\.\(nextItems\);[\s\S]*onChange\(nextItems\);[\s\S]*setEditing\(null\)/, 'The editor must wait for persistence before closing or accepting the updated row.');
assert.doesNotMatch(items, /repair:\s*(?:meta\.title|normalizedTitle)/, 'Supplier autofill must not overwrite a technician-entered repair title.');
assert.match(items, /internalCost,[\s\S]*parts: suggestedParts \?\? current\.parts/, 'Supplier cost and marked-up client charge must be kept together.');

for (const source of [desktop, mobile]) {
  assert.match(source, /items:\s*toCloudArray\(item\.items\)/, 'Supabase writes must include complete work-order items JSON.');
  assert.match(source, /items:\s*cloudArray\(row\.items\)/, 'Supabase reads must restore complete work-order items JSON.');
}
assert.match(desktop, /queueCloudWriteForBackgroundSync\('upsert', key, updatedItem\)/, 'Desktop updates must durably queue Supabase synchronization before reporting success.');
assert.match(desktop, /async function synchronizeDesktopCollection[\s\S]*persist: async \(rows\)[\s\S]*writeDb\(nextDb\)/, 'Explicit cloud synchronization must cache records locally before desktop Update can persist them.');
assert.match(desktop, /ipcMain\.handle\('db-find'[\s\S]*const db = readDb\(\);[\s\S]*return list\.filter/, 'Desktop Find must query the durable local cache without downloading its cloud table.');
assert.match(desktop, /pendingIds,[\s\S]*terminal: key === 'workOrders'/, 'Incremental reads must preserve queued local writes and terminal work-order state.');

assert.match(workOrder, /missingRequired\.includes\('assignedTo'\)[\s\S]*cannot be saved or checked out/, 'Work orders must hard-block Save and Checkout without a technician.');
assert.match(workOrder, /createWorkOrderPromiseRef/, 'Concurrent autosave, print, and checkout paths must share one work-order creation request.');
assert.match(workOrder, /createWorkOrderOnce/, 'Every new-work-order path must reuse the saved identity instead of creating duplicates.');
assert.match(sale, /missingRequired\.includes\('assignedTo'\)[\s\S]*cannot be saved or checked out/, 'Sales must hard-block Save and Checkout without a technician.');
assert.match(sidebar, /headerControl/, 'The work-order sidebar must host the desktop details menu.');
assert.match(desktopCss, /\.gb-wo-sidebar-header[\s\S]*\.gb-wo-mobile-details-menu/, 'Desktop work-order header placement styles are missing.');
assert.match(mobileCss, /\.gbpos-mobile \.gb-wo-top-row[\s\S]*grid-template-columns: auto minmax\(0, 1fr\)/, 'Mobile must keep the menu left of the wider technician field.');

console.log('Work-order item persistence, Supabase parity, cart input, and assignment checks passed.');
