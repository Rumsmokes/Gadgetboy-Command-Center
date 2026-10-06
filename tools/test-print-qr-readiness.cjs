const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('app/electron/electron-main.ts');
const receipt = read('src/workorders/CustomerReceiptWindow.tsx');
const consult = read('src/sales/ConsultSheetWindow.tsx');
const releaseWindow = read('src/workorders/ReleaseFormWindow.tsx');
const releasePrint = read('src/workorders/releasePrint.ts');
const salePrint = read('src/sales/salePrint.ts');

assert.match(main, /const SILENT_PRINT_RENDERER_READY_TIMEOUT_MS = 7000;/,
  'Silent printing must allow enough time for a cloud-backed QR to be created and rendered.');
assert.equal(
  (main.match(/setTimeout\(startSilentPrint, SILENT_PRINT_RENDERER_READY_TIMEOUT_MS\)/g) || []).length,
  1,
  'Work-order and sales receipts must never force-print before the required QR is ready.',
);
assert.match(releaseWindow, /if \(!logoSrc \|\| !qrReady \|\| !qrDataUrl\) return;/,
  'The work-order release window must wait for both the logo and required QR before printing.');
assert.doesNotMatch(releaseWindow, /100ms fallback[\s\S]{0,500}window\.print/,
  'The work-order release window must not use the old logo-only fallback that prints before QR generation finishes.');
assert.match(releaseWindow, /await Promise\.all\(\[logoImgRef\.current, qrImgRef\.current\]/,
  'The release form must wait for the QR image itself to decode before invoking print.');
assert.match(releasePrint, /throw new Error\('Printing stopped because the work-order QR code could not be created\.'/,
  'The legacy work-order print path must stop instead of intentionally printing without a QR.');
assert.match(releasePrint, /if \(recordId <= 0\)[\s\S]{0,300}throw new Error\(message\)/,
  'An unsaved work order must not print a release form without a QR.');
assert.doesNotMatch(releasePrint, /QR generation failed[^\n]*print without it/,
  'No work-order print path may silently omit a failed QR.');
assert.match(salePrint, /Printing stopped because the sales-ticket QR code could not be created/,
  'The legacy sales-ticket print path must stop instead of printing without a QR.');
assert.doesNotMatch(salePrint, /print without QR/,
  'No sales-ticket print path may silently omit a failed QR.');
assert.doesNotMatch(receipt, /QRCode\.toDataURL/,
  'Customer receipts must not generate any QR code.');
assert.doesNotMatch(receipt, /Google Review QR|SCAN ME|GOOGLE_REVIEW_URL/,
  'Customer receipts must not render a review or internal QR destination.');
assert.doesNotMatch(receipt, /notifyCustomerReceiptQrFailed/,
  'Customer receipts must not gate silent printing on QR creation.');
assert.doesNotMatch(main, /customer-receipt:qr-failed/,
  'Silent customer-receipt printing must not retain a QR-failure branch.');
assert.match(releasePrint, /const columnCount = 1;/,
  'Long repair item lists must flow across pages instead of being split into clipped columns.');
assert.match(releasePrint, /items-section/,
  'The long item list must be allowed to paginate independently of totals and acknowledgements.');
assert.match(releaseWindow, /page-break-inside: avoid;/,
  'Each printed repair line should remain intact when a long form carries onto another page.');
assert.match(consult, /QR status URL timed out[\s\S]{0,80}5000/,
  'Consultation QR lookup must have the same bounded failure path.');
assert.equal(
  (consult.match(/if \(consultationRequiresQr && !qrSrc\) return;/g) || []).length,
  2,
  'Manual and silent consultation printing must not signal readiness without the required QR image.',
);

const productForm = read('src/sales/ProductFormWindow.tsx');
assert.match(productForm, /qrGetStatusUrl\?\.\('sale', saleId\)/,
  'Automatic sales-form printing must request a sale-specific status QR.');
assert.match(productForm, /alt=\"Sales update QR\"/,
  'Automatic sales forms must render their technician update QR.');
assert.match(productForm, /saleRequiresQr && !qrSrc/,
  'Automatic sales printing must wait until its required QR has rendered.');

console.log('Print QR readiness checks passed.');
