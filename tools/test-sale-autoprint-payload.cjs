const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const saleWindow = fs.readFileSync(path.join(root, 'src', 'sales', 'SaleWindow.tsx'), 'utf8');
const productForm = fs.readFileSync(path.join(root, 'src', 'sales', 'ProductFormWindow.tsx'), 'utf8');

const autoPrintPayload = saleWindow.slice(
  saleWindow.indexOf('if (initialSaleCheckoutForm)'),
  saleWindow.indexOf('if (saved && currentId && additionalPaid > 0)'),
);

assert.match(autoPrintPayload, /customerName:\s*recordToPersist\.customerName/, 'Automatic sale printing must pass the customer name using the Product Form field name.');
assert.match(autoPrintPayload, /customerPhone:\s*recordToPersist\.customerPhone/, 'Automatic sale printing must pass the phone using the Product Form field name.');
assert.match(autoPrintPayload, /customerEmail:\s*String\(\(recordToPersist as any\)\.customerEmail/, 'Automatic sale printing must pass the email using the Product Form field name.');
assert.match(productForm, /const printItems = Array\.isArray\(data\.items\)/, 'Product Form must render every printed sale line item.');
assert.match(productForm, /printItems\.map/, 'Product Form must render the supplied sale item list instead of a blank single-item fallback.');

console.log('Automatic sale print payload regression checks passed.');
