const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('app/electron/electron-main.ts');
const workOrder = read('src/workorders/NewWorkOrderWindow.tsx');
const sale = read('src/sales/SaleWindow.tsx');
const emails = read('src/lib/automaticClientEmail.ts');

assert.match(main, /function testEnvironmentDataRoot\(\).*GB POS Test Environment/s, 'test mode must use a dedicated local data root');
assert.match(main, /if \(IS_TEST_ENVIRONMENT\) return testEnvironmentDataRoot\(\);/, 'test mode must never inherit the production data location');
assert.match(main, /open-release-form[\s\S]*autoPrint[\s\S]*silent[\s\S]*scheduleSilentPrint/s, 'release-form IPC must support silent default-printer output');
assert.match(main, /open-product-form[\s\S]*autoPrint[\s\S]*silent[\s\S]*scheduleSilentPrint/s, 'sale-form IPC must support silent default-printer output');
assert.match(workOrder, /openReleaseForm\?\.\(\{\s*workOrderId: effectiveId,\s*autoPrint: true,\s*silent: true/s, 'first qualifying work-order checkout must silently print the release form');
assert.match(sale, /printSaleReleaseForm\([\s\S]*autoPrint: true,[\s\S]*silent: true/s, 'first qualifying sale checkout must silently print the sale form');
assert.match(emails, /Leave us a Review/, 'completion emails must include a review action');
assert.match(emails, /linktr\.ee\/gadgetboysc/, 'completion emails must include the GadgetBoy Linktree action');

console.log('Checkout completion experience regression checks passed.');
