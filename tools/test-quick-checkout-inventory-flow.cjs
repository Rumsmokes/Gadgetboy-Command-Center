const assert = require('node:assert/strict');
const fs = require('node:fs');

const quickCheckout = fs.readFileSync('src/components/QuickSaleWindow.tsx', 'utf8');
const saleItems = fs.readFileSync('src/sales/SaleItemsTable.tsx', 'utf8');
const commandCenter = fs.readFileSync('src/lib/commandCenter.ts', 'utf8');

assert.match(quickCheckout, /quickCheckout/, 'Quick Checkout must opt into the inventory-only item flow.');
assert.doesNotMatch(quickCheckout, /setEditRequestId\(row\.id\)/, 'Saved repair catalog selections must not open the custom-item editor in Quick Checkout.');
assert.match(saleItems, /itemsRef/, 'Inventory picks must append against the latest list, not a stale picker closure.');
assert.match(saleItems, /setEditing\(null\);/, 'Quick Checkout must not open normal item-detail fields for inventory picks.');
assert.doesNotMatch(saleItems, /setEditing\(quickCheckout \? null : \(layout === 'split' \? lastRow : null\)\)/, 'Saved inventory picks must not open the custom-item editor in sales or Quick Checkout.');
assert.match(commandCenter, /quickCheckoutType/, 'Quick Checkout records must be recognized before client-attention checks.');

console.log('Quick Checkout inventory flow checks passed.');
