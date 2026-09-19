const assert = require('node:assert/strict');
const fs = require('node:fs');

const helper = fs.readFileSync('src/lib/inventoryLabels.ts', 'utf8');
const inventory = fs.readFileSync('src/components/InventoryWindow.tsx', 'utf8');
const mobile = fs.readFileSync('src/mobile/MobileApp.tsx', 'utf8');
const styles = fs.readFileSync('src/styles/index.css', 'utf8');

assert.match(helper, /inventoryId/);
assert.match(helper, /2\.25 × 1\.25 in/);
assert.match(inventory, /Inventory Label Preview/);
assert.match(inventory, /SKU \/ Item #/);
assert.match(inventory, /VITE_PUBLIC_APP_URL/);
assert.match(inventory, /inventoryReorderQuantity\(editing\)/, 'scan view must default to the item MOQ');
assert.match(inventory, /Full Supplier Cost/);
assert.match(inventory, /Added .* to the EOD purchasing cart/);
assert.match(inventory, /Ordered Online/, 'Inventory must let staff mark an item as ordered online.');
assert.match(inventory, /Locally Acquired/, 'Inventory must let staff mark an item as locally acquired.');
assert.match(inventory, /isOrderedOnline/, 'Inventory must derive the acquisition choice from the saved order URL.');
assert.match(inventory, /Order URL/, 'Online inventory must retain the Order URL action.');
assert.match(mobile, /inventoryDeepLink/);
assert.match(mobile, /initialWindow=\{inventoryDeepLink \? 'inventory' : ''\}/);
assert.match(inventory, /classList\.add\('gb-printing-inventory-label'\)/, 'label printing must opt into isolated print CSS');
assert.match(inventory, /classList\.remove\('gb-printing-inventory-label'\)/, 'label print mode must always be removed');
assert.match(styles, /body\.gb-printing-inventory-label \*/, 'inventory-only visibility rules must be scoped to label print mode');
assert.doesNotMatch(styles, /@media print\s*\{\s*body \*\s*\{\s*visibility:\s*hidden/, 'ordinary consultation, work-order, and sale printouts must not be globally hidden');
console.log('Inventory label and scanner checks passed.');
