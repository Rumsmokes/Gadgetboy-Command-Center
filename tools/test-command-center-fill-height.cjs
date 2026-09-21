const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles', 'command-center.css'), 'utf8');

assert.match(css, /\.command-center\{[^}]*height:100%[^}]*display:flex[^}]*flex-direction:column/, 'Command Center must be a full-height vertical layout.');
assert.match(css, /\.command-center-grid\{[^}]*flex:1 1 0[^}]*min-height:0[^}]*overflow:hidden/, 'The three-panel region must use only remaining Command Center height.');
assert.match(css, /\.command-center-section\{[^}]*display:flex[^}]*flex-direction:column[^}]*min-height:0/, 'Each Command Center panel must stretch as a vertical region.');
assert.match(css, /\.command-center-section-scroll\{[^}]*flex:1 1 auto[^}]*max-height:none/, 'Only each panel list may scroll after it fills the available panel height.');

console.log('Command Center fill-height checks passed.');
