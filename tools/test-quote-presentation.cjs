const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const quote = fs.readFileSync(path.join(root, 'src/components/QuoteGeneratorWindow.tsx'), 'utf8');
const options = fs.readFileSync(path.join(root, 'src/components/QuoteOptionViewer.tsx'), 'utf8');

assert.match(quote, />Show Preview<\/button>/, 'Quote Generator must expose the customer-facing preview action.');
assert.match(quote, />Option Viewer<\/button>/, 'Quote Generator must expose the image-only option viewer.');
assert.match(quote, /requestFullscreen/, 'Quote preview must support fullscreen presentation.');
assert.match(quote, /quote-customer-preview/, 'Quote preview must use the responsive customer-display layout.');
assert.match(options, /onDrop=/, 'Option Viewer must accept dragged images.');
assert.match(options, /accept="image\/\*"/, 'Option Viewer must accept uploaded image files.');
assert.match(options, /requestFullscreen/, 'Option Viewer presentation must support fullscreen.');
assert.match(options, />Show Preview<\/button>/, 'Option Viewer must provide its own presentation action.');
assert.match(options, /reader\.readAsDataURL\(file\)/, 'Option Viewer must retain selected image media locally for Electron-safe previewing.');

assert.match(quote, /window\.api\?\.setFullScreen/, 'Quote Preview must use native window fullscreen for the client display.');
assert.match(options, /window\.api\?\.setFullScreen/, 'Option Viewer must use native window fullscreen for the client display.');
assert.match(quote, /aria-label="Browse quote item images"/, 'Each quote item needs an accessible Browse/drop image control.');
const main = fs.readFileSync(path.join(root, 'app/electron/electron-main.ts'), 'utf8');
assert.match(main, /email:testConnection/, 'Email configuration must expose a real SMTP verification action.');

console.log('Quote customer presentation and Option Viewer checks passed.');
