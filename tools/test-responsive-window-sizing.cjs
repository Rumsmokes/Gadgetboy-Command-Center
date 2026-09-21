const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'electron', 'electron-main.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles', 'index.css'), 'utf8');

assert.match(main, /function displayAwareWindowSize\([\s\S]*?fillAvailable = false/, 'Window sizing must support a fill-available mode.');
assert.match(main, /const width = fillAvailable \? availableWidth : Math\.min\(preferred\.width, availableWidth\)/, 'Fill mode must use usable display width.');
assert.match(main, /const height = fillAvailable \? availableHeight : Math\.min\(preferred\.height, availableHeight\)/, 'Fill mode must use usable display height.');
assert.match(main, /\{ width: 1180, height: 840 \},\s*\{ width: 880, height: 620 \},\s*24,\s*false/, 'Quick Checkout must preserve its preferred window width while shrinking only when the display requires it.');
assert.match(main, /app\.on\('browser-window-created',[\s\S]*?fitWindowIntoWorkArea\(win\)/, 'Every daughter window must be fitted to its display when created.');
assert.match(styles, /@media \(max-width: 767px\)[\s\S]*?\.gb-quick-checkout-totals/, 'Quick Checkout must have a narrow-screen layout.');
assert.match(styles, /@media \(max-width: 767px\)[\s\S]*?\.command-center/, 'Command Center must have a narrow-screen layout.');
assert.match(styles, /@media \(max-width: 767px\)[\s\S]*?\.gb-ticket-item-dialog/, 'Ticket item dialogs must have a narrow-screen layout.');
assert.match(styles, /\.gb-quick-checkout-layout\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/, 'Quick Checkout content must be constrained to the height left below its header.');
assert.match(styles, /\.gb-quick-checkout \.gb-sale-items-split-layout\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/, 'Quick Checkout’s split item area must be constrained to the available checkout height.');
assert.match(styles, /\.gb-quick-checkout \.gb-sale-items-list-pane\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/, 'Quick Checkout’s list pane must be contained by the item area.');
assert.match(styles, /\.gb-quick-checkout-layout > \.gb-sale-items\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/, 'Quick Checkout item content must not grow beyond its grid row.');
assert.match(styles, /\.gb-quick-checkout \.gb-sale-items-empty-editor\s*\{[^}]*min-height:\s*0/, 'Quick Checkout editor must be allowed to shrink within the available window height.');

console.log('Responsive window sizing checks passed.');
