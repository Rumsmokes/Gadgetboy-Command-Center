const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const accountingBuild = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/lib/reportingAccounting.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const accountingModule = { exports: {} };
new Function('module', 'exports', 'require', accountingBuild.outputFiles[0].text)(accountingModule, accountingModule.exports, require);
const { collectReportingPayments } = accountingModule.exports;

const mergedPayments = collectReportingPayments({
  amountPaid: 75,
  payments: [{ id: 'diagnostic', applied: 25, at: '2026-10-11T10:00:00.000Z' }],
  paymentHistory: [{ id: 'labor', applied: 50, at: '2026-10-11T15:00:00.000Z' }],
  paymentLogs: [{ id: 'labor', applied: 50, at: '2026-10-11T15:00:00.000Z' }],
});
assert.equal(mergedPayments.reduce((sum, payment) => sum + payment.applied, 0), 75,
  'All unique checkout events must be counted once even when old and new payment ledgers coexist.');
assert.equal(mergedPayments.length, 2,
  'Duplicate copies of a payment event must not inflate Collected Today or EOD.');
assert.ok(mergedPayments.some(payment => payment.id === 'labor'),
  'The later checkout event must keep its real timestamp and identity instead of becoming a synthetic fallback.');

const checkout = fs.readFileSync(path.join(root, 'src/workorders/CheckoutWindow.tsx'), 'utf8');
const workOrder = fs.readFileSync(path.join(root, 'src/workorders/NewWorkOrderWindow.tsx'), 'utf8');
const release = fs.readFileSync(path.join(root, 'src/workorders/ReleaseFormWindow.tsx'), 'utf8');
const legacyRelease = fs.readFileSync(path.join(root, 'src/workorders/releasePrint.ts'), 'utf8');
const quote = fs.readFileSync(path.join(root, 'src/components/QuoteGeneratorWindow.tsx'), 'utf8');
const options = fs.readFileSync(path.join(root, 'src/components/QuoteOptionViewer.tsx'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');

assert.match(checkout, /Print release form/, 'Checkout must offer a manual release-form print option.');
assert.match(workOrder, /printReleaseForm/, 'Work-order checkout must honor the manual release-form print selection.');
assert.match(workOrder, /diagnosticSelection/, 'Automatic release-form printing must be limited to diagnostic-fee intake.');
assert.match(release, /Diagnostic fee/, 'Diagnostic-only release forms must identify the diagnostic that was paid.');
assert.match(legacyRelease, /Diagnostic fee/, 'The fallback release printer must identify a diagnostic-only intake.');
assert.match(release, /Check-In:\s*\{checkInDisplay\}/, 'Check-in date/time belongs in the release-form header.');
assert.doesNotMatch(release, />Check-In<\/div>/, 'Device intake must not duplicate the check-in field.');
assert.match(quote, /exitFullscreen/, 'Quote preview must handle exiting only its presentation fullscreen state.');
assert.match(options, /exitFullscreen/, 'Option Viewer must handle exiting only its presentation fullscreen state.');
assert.match(options, /OPTION \{String\(index \+ 1\)\.padStart\(2, '0'\)\}/, 'Option Viewer presentation must label customer-facing option cards.');
assert.match(app, /getFullScreen[\s\S]*setFullScreen\(false\)/, 'Escape must leave a native customer-display fullscreen view before closing its modal.');

console.log('Approved release-form, payment-ledger, and customer-display checks passed.');
