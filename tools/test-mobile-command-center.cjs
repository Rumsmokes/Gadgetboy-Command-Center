const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/mobile/MobileApp.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/mobile/mobile.css'), 'utf8');
const commandCenter = fs.readFileSync(path.join(root, 'src/components/CommandCenter.tsx'), 'utf8');

assert.match(source, /import CommandCenter from ['"]\.\.\/components\/CommandCenter['"]/);
assert.match(source, /homeView.*'command'.*'invoices'/);
assert.match(source, /<CommandCenter[\s\S]*onOpenInvoices=/);
assert.match(source, /loadedOnceRef\.current/);
assert.doesNotMatch(source, /const loadCore = useCallback\(async \(\) => \{\s*setLoading\(true\)/);
assert.match(css, /\.mobile-command-center[\s\S]*\.command-center-stages/);
assert.match(css, /\.command-center-panel thead[\s\S]*display:\s*none/);
assert.doesNotMatch(commandCenter, /onOpenFilters|>Filters</, 'Command Center must not expose the invoice-only Filters control.');
assert.match(commandCenter, /onContextMenu=\{event => openRecordMenu\(event, record\)\}/, 'Command Center records must expose right-click actions.');
assert.match(commandCenter, /EOD\s*\/\s*Checkout Cart/, 'Command Center must expose a direct EOD / Checkout Cart action on mobile.');
assert.match(commandCenter, /onOpenModal\('eod'\)/, 'The EOD / Checkout Cart action must open the existing EOD modal route.');

console.log('Mobile Command Center integration checks passed.');
