const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const build = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'lib', 'orderAccounting.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const moduleShim = { exports: {} };
new Function('module', 'exports', 'require', build.outputFiles[0].text)(moduleShim, moduleShim.exports, require);
const { allocateCheckoutAdditionalCosts, applyPurchaseQueueRemovalToItems, calculateSalesTax, collectOrderCartRows, filterLedgerBackedOrderCartRows, groupOrderCartRows } = moduleShim.exports;

const readSource = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const eodSource = readSource('src/components/EODWindow.tsx');
const workOrderItemsSource = readSource('src/workorders/ItemsTable.tsx');
const workOrderSource = readSource('src/workorders/NewWorkOrderWindow.tsx');
const saleItemsSource = readSource('src/sales/SaleItemsTable.tsx');
assert.doesNotMatch(eodSource, /<h3[^>]*>Purchasing Cart<\/h3>/, 'EOD must not repeat the cart section beneath the Cart button.');
assert.match(eodSource, /View Invoice/, 'Every linked cart row must provide a transaction drill-down action.');
assert.match(eodSource, /Warning: payment not taken/, 'Unpaid cart lines must display an explicit payment warning.');
assert.match(workOrderItemsSource, /Supplier item cost/, 'Work-order supplier cost must live in the line-item editor.');
assert.match(workOrderItemsSource, /Shipping and supplier tax are added during EOD checkout/, 'Work-order costs must exclude EOD checkout additions.');
assert.match(saleItemsSource, /Shipping and supplier tax are added during EOD checkout/, 'Sale costs must follow the same EOD checkout accounting rule.');
assert.doesNotMatch(workOrderItemsSource, /normalizePartInventoryTitle/, 'A supplier URL must not replace a custom work-order repair or device name.');
assert.doesNotMatch(saleItemsSource, /normalizePartInventoryTitle/, 'A supplier URL must not replace a custom sale item name.');
assert.doesNotMatch(workOrderItemsSource, /repair:\s*(?:meta\.title|normalizedTitle)/, 'Work-order URL autofill must preserve the technician-entered repair name.');
assert.doesNotMatch(workOrderSource, /repair:\s*meta\.title/, 'Parts Tracking URL autofill must preserve existing work-order item names.');
assert.doesNotMatch(saleItemsSource, /description:\s*(?:meta\.title|normalizedTitle)/, 'Sale URL autofill must preserve the technician-entered product name.');
assert.match(workOrderItemsSource, /parts: suggestedParts \?\? current\.parts/, 'Work-order URL pricing must apply supplier cost and markup to Parts charged.');
assert.match(saleItemsSource, /price == null \? \{\} : \{ price \}/, 'Sale URL pricing must apply supplier cost and markup to the customer price.');
assert.doesNotMatch(workOrderItemsSource, />Close<\/button>/, 'Work-order line-item editor must not duplicate a Close button above its fields.');
assert.doesNotMatch(saleItemsSource, />Close<\/button>/, 'Sale line-item editor must not duplicate a Close button above its fields.');
assert.match(workOrderItemsSource, />\s*Cancel\s*<\/button>[\s\S]*onCommit\?\.\(nextItems\);[\s\S]*setEditing\(null\);/, 'Work-order item Save must close the editor and Cancel must remain at the bottom.');
assert.match(saleItemsSource, />\s*Cancel\s*<\/button>[\s\S]*onCommit\?\.\(nextItems\);[\s\S]*setEditing\(null\);/, 'Sale item Save must close the editor and Cancel must remain at the bottom.');
assert.match(workOrderItemsSource, /onCommit\?\.\(nextItems\)/, 'Work-order item edits must commit immediately so EOD reads the saved cost.');
assert.match(saleItemsSource, /onCommit\?\.\(nextItems\)/, 'Sale item edits must commit immediately so EOD reads the saved cost.');
assert.match(eodSource, /Items arrive on different dates/, 'The EOD cart must support split delivery dates.');
assert.match(eodSource, /estimatedDelivery: deliveryForRow\(cartRow\)/, 'Checked-out cart lines must retain their selected estimated delivery date.');
assert.match(eodSource, /Send client update/, 'EOD checkout must offer an explicit client update choice.');
assert.match(eodSource, /sendClientUpdate = false/, 'EOD checkout must remain internal-only by default.');
assert.doesNotMatch(eodSource, /select every item in this distributor before applying shared shipping/, 'A distributor checkout must allow individually selected cart lines.');
assert.match(eodSource, /selected item.*purchased, removed from the cart, and synced to reporting/, 'Selective checkout must confirm cart removal and reporting sync.');
assert.doesNotMatch(workOrderSource, /<label[^>]*>Internal cost/, 'Parts Tracking must not own repair pricing fields.');
assert.doesNotMatch(workOrderSource, /<label[^>]*>Order URL<\/label>/, 'Parts Tracking must not duplicate the line-item order URL.');

assert.equal(calculateSalesTax(100, false, 8), 8, 'Non-exempt supplier purchases should add 8% South Carolina sales tax.');
assert.equal(calculateSalesTax(100, true, 8), 0, 'Tax-exempt supplier purchases must not add sales tax.');

const selectiveFeeRows = [
  { key: 'selected-a', hasCost: true, totalCost: 30 },
  { key: 'selected-b', hasCost: true, totalCost: 70 },
];
const selectiveFeeAllocation = allocateCheckoutAdditionalCosts(selectiveFeeRows, 10);
assert.equal(selectiveFeeAllocation.get('selected-a'), 3, 'Shared checkout costs must be allocated across the selected subset by supplier cost.');
assert.equal(selectiveFeeAllocation.get('selected-b'), 7, 'The selected subset must receive the full shared checkout cost without requiring the whole distributor cart.');
assert.equal(Array.from(selectiveFeeAllocation.values()).reduce((sum, value) => sum + value, 0), 10, 'Selective checkout allocation must preserve the exact entered checkout cost.');

const workOrders = [{
  id: 101,
  customerName: 'Test Client',
  checkInAt: '2025-01-01T12:00:00.000Z',
  amountPaid: 145,
  payments: [{ applied: 145, appliedParts: 120, appliedLabor: 25 }],
  items: [{
    id: 'part-1',
    repair: 'PS5 Power Supply',
    parts: 120,
    labor: 75,
    internalCost: 100,
    distributor: 'Phone LCD Parts',
    orderSourceUrl: 'https://www.phonelcdparts.com/parts/ps5-power-supply',
    requiresOrder: true,
    orderStatus: 'needed',
    estimatedDelivery: '2026-08-12',
  }, {
    id: 'removed-part',
    repair: 'Removed Purchasing Task',
    parts: 50,
    internalCost: 25,
    distributor: 'Other Source',
    requiresOrder: true,
    orderStatus: 'needed',
    purchaseQueueRemovedAt: '2026-08-05T12:00:00.000Z',
  }],
}, {
  id: 102,
  customerName: 'Missing Cost',
  amountPaid: 0,
  items: [{
    id: 'part-2',
    repair: 'Custom Screen',
    parts: 80,
    distributor: 'Other Source',
    requiresOrder: true,
    orderStatus: 'needed',
  }, {
    id: 'removed-product',
    description: 'Removed Sale Purchase',
    qty: 1,
    price: 30,
    internalCost: 15,
    distributor: 'Amazon',
    inStock: false,
    requiresOrder: true,
    purchaseQueueRemovedAt: '2026-08-05T12:00:00.000Z',
  }],
}];

const sales = [{
  id: 201,
  customerName: 'Paid Sale',
  amountPaid: 154,
  totals: { total: 154, remaining: 0 },
  items: [{
    id: 'product-1',
    description: 'USB-C Dock',
    qty: 2,
    price: 70,
    internalCost: 50,
    distributor: 'Amazon',
    productUrl: 'https://www.amazon.com/dp/example',
    inStock: false,
    requiresOrder: true,
    orderStatus: 'needed',
  }],
}, {
  id: 202,
  customerName: 'Partial Sale',
  amountPaid: 20,
  totals: { total: 100, remaining: 80 },
  items: [{
    id: 'product-2',
    description: 'Controller',
    qty: 1,
    price: 100,
    internalCost: 60,
    distributor: 'Other Source',
    productUrl: 'https://vendor.example/controller',
    inStock: false,
    requiresOrder: true,
  }],
}];

const purchaseOrders = [{
  id: 301,
  status: 'pending',
  sourceType: 'inventory',
  inventoryId: 88,
  itemType: 'Part',
  title: 'PS5 Power Supply',
  distributor: 'Phone LCD Parts',
  orderUrl: 'https://www.phonelcdparts.com/parts/ps5-power-supply',
  quantity: 3,
  unitCost: 40,
  sourceItemIndex: 2,
}, {
  id: 302,
  status: 'checked_out',
  sourceType: 'manual',
  title: 'Already purchased',
  distributor: 'Other Source',
  quantity: 1,
  unitCost: 20,
}];

const rows = collectOrderCartRows(workOrders, sales, purchaseOrders);
assert.equal(rows.length, 5, 'Every outstanding order-required source line should enter the cart, even when supplier cost is missing.');
assert.equal(rows.some(row => row.itemId === 'removed-part' || row.itemId === 'removed-product'), false, 'Deleted cart tasks must remain suppressed without deleting their source items.');

const sourceCartRows = rows.filter(row => !row.purchaseOrderId);
const twoCheckedOutRows = sourceCartRows.slice(0, 2).map((row, index) => ({ id: 400 + index, status: 'checked_out', sourceKey: row.key, totalCost: row.totalCost }));
const remainingAfterSelectiveCheckout = filterLedgerBackedOrderCartRows(rows, twoCheckedOutRows);
assert.equal(remainingAfterSelectiveCheckout.length, rows.length - 2, 'Checking out selected lines must remove exactly those lines from the cart.');
assert.equal(remainingAfterSelectiveCheckout.some(row => twoCheckedOutRows.some(record => record.sourceKey === row.key)), false, 'Purchased source keys must not reappear in the cart.');
assert.equal(twoCheckedOutRows.reduce((sum, record) => sum + record.totalCost, 0), sourceCartRows[0].totalCost + sourceCartRows[1].totalCost, 'Each selected checkout ledger record must retain its reporting cost.');
const pendingSourceLedger = [{ id: 499, status: 'pending', sourceKey: sourceCartRows[2].key }];
assert.equal(filterLedgerBackedOrderCartRows(rows, pendingSourceLedger).some(row => row.key === sourceCartRows[2].key), false, 'A pending ledger-backed purchase must continue to suppress its duplicate source row.');

const workOrder = rows.find(row => row.key === 'workOrder:101:part-1');
assert.equal(workOrder.totalCost, 100);
assert.equal(workOrder.totalCharge, 120);
assert.equal(workOrder.knownProfit, 20);
assert.equal(workOrder.paymentStatus, 'paid');
assert.equal(workOrder.estimatedDelivery, '2026-08-12', 'Saved line-item delivery dates must flow into the EOD cart.');

const taxedWorkOrder = collectOrderCartRows([{
  ...workOrders[0],
  id: 103,
  taxRate: 8,
  payments: [{ applied: 154.6, appliedParts: 129.6, appliedLabor: 25 }],
  items: [workOrders[0].items[0]],
}], [], [])[0];
assert.equal(taxedWorkOrder.baseTotalCharge, 120);
assert.equal(taxedWorkOrder.clientTax, 9.6);
assert.equal(taxedWorkOrder.totalCharge, 129.6, 'Cart Charged must include the saved client tax rate.');
assert.equal(taxedWorkOrder.knownProfit, 20, 'Client tax collected must not be treated as shop margin.');
assert.equal(taxedWorkOrder.paymentStatus, 'paid');

const quantityWorkOrder = collectOrderCartRows([{
  id: 105,
  customerName: 'Quantity Test',
  taxRate: 0,
  amountPaid: 110,
  payments: [{ applied: 110, appliedParts: 110 }],
  items: [{
    id: 'quantity-part',
    repair: 'HDMI Port',
    quantity: 2,
    parts: 55,
    labor: 100,
    internalCost: 45,
    distributor: 'Parts Vendor',
    orderSourceUrl: 'https://parts.example/hdmi-port',
    requiresOrder: true,
    orderStatus: 'needed',
  }],
}], [], [])[0];
assert.equal(quantityWorkOrder.totalCost, 90, 'Work-order supplier unit cost must be multiplied by quantity.');
assert.equal(quantityWorkOrder.baseTotalCharge, 110, 'Work-order client part charge must be multiplied by quantity.');
assert.equal(quantityWorkOrder.knownProfit, 20, 'Cart margin must compare the same quantity basis for cost and charge.');

const removedWorkOrder = applyPurchaseQueueRemovalToItems(workOrders[0].items, workOrder, '2026-08-05T15:00:00.000Z');
assert.equal(removedWorkOrder.matched, true);
assert.equal(removedWorkOrder.items.length, workOrders[0].items.length, 'Removing a cart task must retain every work-order line.');
assert.equal(removedWorkOrder.items[0].purchaseQueueRemovedAt, '2026-08-05T15:00:00.000Z');
assert.equal(removedWorkOrder.items[0].orderStatus, 'needed');
assert.equal(removedWorkOrder.items[0].trackingNumber, '');
assert.match(removedWorkOrder.items[0].purchaseQueueRemovalNotice, /Payment was recorded/);
assert.equal(collectOrderCartRows([{ ...workOrders[0], items: removedWorkOrder.items }], [], []).some(row => row.key === workOrder.key), false, 'A removed task must stay out of the EOD cart while its work-order item remains saved.');

const paidMissingCost = rows.find(row => row.key === 'workOrder:102:part-2');
assert.ok(paidMissingCost, 'Order-required items without supplier cost must remain in the EOD cart for audit and checkout.');
assert.equal(paidMissingCost.hasCost, false, 'Missing supplier cost must remain visible as a cart warning instead of hiding the item.');
assert.equal(collectOrderCartRows([{ id: 104, items: [{ repair: 'Reclaimed HDMI Port', internalCost: 0, requiresOrder: true, salvagedPart: true }] }], [], []).length, 0, 'Salvaged zero-cost parts must stay out of the purchasing cart after cloud round trips.');

const paidSale = rows.find(row => row.key === 'sale:201:product-1');
assert.equal(paidSale.totalCost, 100, 'Full unit cost must be multiplied by quantity.');
assert.equal(paidSale.totalCharge, 140);
assert.equal(paidSale.paymentStatus, 'paid');

const partialSale = rows.find(row => row.key === 'sale:202:product-2');
assert.equal(partialSale.paymentStatus, 'unverified', 'Partial sale payments must not be guessed at the product level.');

const restock = rows.find(row => row.key === 'purchaseOrder:301');
assert.equal(restock.sourceType, 'inventory');
assert.equal(restock.totalCost, 120);
assert.equal(restock.paymentStatus, 'not_required');
assert.equal(restock.itemIndex, 2, 'Pending purchase records must retain their source line index for safe removal updates.');
assert.equal(rows.some(row => row.key === 'purchaseOrder:302'), false, 'Verified purchases must not re-enter the pending cart.');

const groups = groupOrderCartRows(rows);
const phoneLcd = groups.find(group => group.distributor === 'Phone LCD Parts');
assert.equal(phoneLcd.checkoutLabel, 'Open cart');
assert.equal(phoneLcd.checkoutUrl, 'https://www.phonelcdparts.com/checkout/cart');
assert.equal(phoneLcd.paymentWarnings, 0, 'Inventory restocks do not require client-payment evidence.');
const amazon = groups.find(group => group.distributor === 'Amazon');
assert.equal(amazon.checkoutUrl, 'https://www.amazon.com/gp/cart/view.html');

const other = groups.find(group => group.distributor === 'Other Source');
assert.equal(other.paymentWarnings, 2, 'Every outstanding item without supplier cost must remain a payment warning.');
assert.equal(other.missingCost, 1, 'The missing supplier cost must remain visible in its distributor group.');

console.log('Order accounting and EOD cart checks passed.');
