const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const build = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'lib', 'reportingAccounting.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const moduleShim = { exports: {} };
new Function('module', 'exports', 'require', build.outputFiles[0].text)(moduleShim, moduleShim.exports, require);
const { buildReportingLedger, collectReportingPayments, reportingRecordKind, verifiedPurchaseTotal } = moduleShim.exports;
const reportingSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ReportingWindow.tsx'), 'utf8');
const eodSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'EODWindow.tsx'), 'utf8');
const electronSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'electron', 'electron-main.ts'), 'utf8');
const mobileSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile', 'mobile-api.ts'), 'utf8');
assert.match(reportingSource, /onWorkOrdersChanged\?\.\(\(\) => \{ void loadRecords\(false\); \}\)/, 'Reporting must refresh after a work-order checkout.');
assert.match(reportingSource, /onSalesChanged\?\.\(\(\) => \{ void loadRecords\(false\); \}\)/, 'Reporting must refresh after a sale checkout.');
assert.match(reportingSource, /new Date\(`\$\{value\}T00:00:00`\)/, 'Date filters must use local-day boundaries.');
assert.match(eodSource, /const accountingLedger = useMemo/, 'EOD must derive financial totals from the payment ledger.');
assert.match(eodSource, /const rawRecords = \[\.\.\.\(workOrders \|\| \[\]\), \.\.\.\(sales \|\| \[\]\)\]/, 'EOD payment totals must scan all tickets, including tickets created before the selected day.');
for (const [label, source] of [['Windows', electronSource], ['Android', mobileSource]]) {
  assert.match(source, /payments:\s*cloudArray\(row\.payments\)/, `${label} must restore the Supabase payment ledger.`);
  assert.match(source, /payments:\s*toCloudArray\(item\.payments\)/, `${label} must save the payment ledger to Supabase.`);
}

const workOrder = {
  id: 101,
  kind: 'repair',
  laborCost: 100,
  partCosts: 100,
  taxRate: 8,
  amountPaid: 183,
  items: [{ repair: 'PS5 Power Supply', parts: 100, internalCost: 60 }],
  payments: [
    { applied: 25, appliedLabor: 25, appliedParts: 0, paymentType: 'Card', at: '2026-08-16T14:00:00.000Z' },
    { applied: 108, appliedLabor: 0, appliedParts: 108, paymentType: 'Card', at: '2026-08-17T14:00:00.000Z' },
    { applied: 50, appliedLabor: 50, appliedParts: 0, paymentType: 'Cash', at: '2026-08-17T15:00:00.000Z' },
  ],
};

const entries = buildReportingLedger([workOrder]);
assert.equal(entries.length, 3, 'Every checkout must produce one reporting ledger event.');
const today = entries.filter(entry => entry.date.toISOString().startsWith('2026-08-17'));
assert.equal(today.reduce((sum, entry) => sum + entry.collected, 0), 158, 'Only payments taken today belong in today reporting.');
assert.equal(today.reduce((sum, entry) => sum + entry.partsCharged, 0), 100, 'Gross parts payment must be separated from client tax.');
assert.equal(today.reduce((sum, entry) => sum + entry.taxCollected, 0), 8, 'Client sales tax must be reported exactly.');
assert.equal(today.reduce((sum, entry) => sum + entry.laborCharged, 0), 50, 'Remaining-balance labor checkout must increase labor charged.');
assert.equal(today.reduce((sum, entry) => sum + entry.internalCost, 0), 60, 'Internal cost must be recognized once as its related parts are collected.');
assert.equal(today.reduce((sum, entry) => sum + entry.profitExcludingTax, 0), 90, 'Profit must equal net client charges minus internal cost.');

const legacy = {
  id: 102,
  kind: 'repair',
  laborCost: 75,
  partCosts: 0,
  amountPaid: 50,
  checkoutDate: '2026-08-17T18:00:00.000Z',
};
const normalized = collectReportingPayments(legacy);
assert.equal(normalized.length, 1, 'Legacy paid tickets need a synthetic payment event.');
assert.equal(normalized[0].applied, 50);
assert.equal(buildReportingLedger([legacy])[0].laborCharged, 50, 'Legacy partial payments must remain reportable.');

const singletonPayment = {
  id: 103,
  kind: 'repair',
  laborCost: 25,
  amountPaid: 25,
  payments: { applied: 25, amount: 25, appliedLabor: 25, paymentType: 'Card', at: '2026-09-28T14:30:00.000Z' },
};
const singletonLedger = buildReportingLedger([singletonPayment]);
assert.equal(singletonLedger.length, 1, 'A legacy singleton payment entry must become one ledger event.');
assert.equal(singletonLedger[0].collected, 25, 'A remaining labor checkout stored as one payment object must count in daily collection.');
assert.equal(singletonLedger[0].date.toISOString(), '2026-09-28T14:30:00.000Z', 'A singleton payment must retain its checkout timestamp.');

const partialSale = {
  id: 201,
  kind: 'sale',
  taxRate: 8,
  amountPaid: 54,
  payments: [{ applied: 54, paymentType: 'Card', at: '2026-08-17T19:00:00.000Z' }],
  items: [{ description: 'Controller', qty: 2, price: 50, internalCost: 30 }],
};
const saleEntry = buildReportingLedger([partialSale])[0];
assert.equal(saleEntry.partsCharged, 50);
assert.equal(saleEntry.taxCollected, 4);
assert.equal(saleEntry.internalCost, 30, 'Half-collected sale must recognize half of total product cost.');
assert.equal(saleEntry.profitExcludingTax, 20);

const quickRepair = {
  id: 202,
  kind: 'sale',
  quickCheckoutType: 'repair',
  partCosts: 150,
  amountPaid: 150,
  payments: [{ applied: 150, at: '2026-08-17T19:30:00.000Z' }],
  items: [{ description: '1TB SSD Install', category: 'Repair', qty: 1, price: 150, internalCost: 70 }],
};
assert.equal(reportingRecordKind(quickRepair), 'repair', 'Quick repair checkouts must never become product-sale commission lines.');
assert.equal(buildReportingLedger([quickRepair])[0].kind, 'repair');
assert.match(reportingSource, /kind: reportingRecordKind\(\{ \.\.\.s, kind: 'sale', items \}\)/, 'Reporting must classify repair checkouts before building the monthly product ledger.');

const zeroCostUsedPart = buildReportingLedger([{
  id: 103,
  kind: 'repair',
  partCosts: 40,
  amountPaid: 40,
  payments: [{ applied: 40, appliedParts: 40, at: '2026-08-17T20:00:00.000Z' }],
  items: [{ repair: 'Reclaimed HDMI Port', parts: 40, internalCost: 0 }],
}])[0];
assert.equal(zeroCostUsedPart.internalCost, 0);
assert.equal(zeroCostUsedPart.missingInternalCost, 0, 'An explicit zero-cost reclaimed part is known cost, not missing data.');

const observedOldTicket = {
  id: 1014,
  kind: 'repair',
  checkInAt: '2026-07-30T21:31:58.645Z',
  laborCost: 100,
  partCosts: 75,
  taxRate: 8,
  amountPaid: 181,
  items: [{ repair: 'Repair Part', parts: 75, internalCost: 45 }],
  payments: [
    { applied: 131, amount: 131, inferred: true, at: '2026-07-30T21:31:58.645Z' },
    { applied: 50, amount: 50, appliedLabor: 0, appliedParts: 50, paymentType: 'Card', at: '2026-08-18T14:31:52.532Z' },
  ],
};
const observedLedger = buildReportingLedger([observedOldTicket]);
assert.equal(observedLedger.filter(entry => entry.date.toISOString().startsWith('2026-07-30')).reduce((sum, entry) => sum + entry.collected, 0), 131, 'A historical manual payment must stay on its historical date.');
assert.equal(observedLedger.filter(entry => entry.date.toISOString().startsWith('2026-08-18')).reduce((sum, entry) => sum + entry.collected, 0), 50, 'A checkout today must count today even when its ticket was created earlier.');

const observedDayLedger = buildReportingLedger([
  observedOldTicket,
  { id: 1154, kind: 'repair', laborCost: 50, amountPaid: 50, payments: [{ applied: 50, amount: 50, at: '2026-08-18T15:00:00.000Z' }] },
  { id: 1153, kind: 'repair', laborCost: 25, amountPaid: 25, payments: [{ applied: 25, amount: 25, at: '2026-08-18T15:15:00.000Z' }] },
  { id: 1155, kind: 'sale', amountPaid: 6.48, items: [{ description: 'Product', qty: 1, price: 6.48, internalCost: 3 }], payments: [{ applied: 6.48, amount: 6.48, at: '2026-08-18T15:30:00.000Z' }] },
]);
assert.equal(observedDayLedger.filter(entry => entry.date.toISOString().startsWith('2026-08-18')).reduce((sum, entry) => sum + entry.collected, 0), 131.48, 'The audited August 18 checkouts must reconcile to $131.48, not $81.48.');

const manualHistoricalCorrection = buildReportingLedger([{
  id: 1015,
  kind: 'repair',
  checkInAt: '2026-07-30T16:00:00.000Z',
  laborCost: 131,
  amountPaid: 131,
}]);
assert.equal(manualHistoricalCorrection.length, 1);
assert.equal(manualHistoricalCorrection[0].date.toISOString(), '2026-07-30T16:00:00.000Z', 'A manually restored paid amount must not fabricate revenue on the current day.');

assert.equal(verifiedPurchaseTotal({ itemCost: 100, supplierTax: 8, additionalCost: 5, taxExempt: false }), 113,
  'Legacy non-exempt purchases must include supplier tax and checkout costs.');
assert.equal(verifiedPurchaseTotal({ itemCost: 100, supplierTax: 8, additionalCost: 5, taxExempt: true }), 105,
  'Tax-exempt purchases must not include stale supplier tax values.');
assert.equal(verifiedPurchaseTotal({ totalCost: 113, itemCost: 100, supplierTax: 8, additionalCost: 5 }), 113,
  'Recorded full cost must remain authoritative and must not be double-counted.');

console.log('Reporting payment ledger checks passed.');
