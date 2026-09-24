const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile', 'mobile.css'), 'utf8');
const start = css.indexOf('@media (max-width: 820px)');
const end = css.indexOf('@media (max-width: 1024px) and (orientation: landscape)');
assert.ok(start >= 0 && end > start, 'Expected the portrait Android mobile stylesheet block.');
const portrait = css.slice(start, end);

assert.match(portrait, /\.gbpos-mobile \.gb-calendar-header\s*\{[\s\S]*?gap:\s*0\.25rem;/, 'Portrait calendar needs a compact header gap.');
assert.match(portrait, /\.gbpos-mobile \.gb-calendar-title-actions\s*\{[\s\S]*?display:\s*flex\s*!important;[\s\S]*?flex-wrap:\s*nowrap\s*!important;/, 'Calendar title actions must remain a single compact row on Android.');
assert.match(portrait, /\.gbpos-mobile \.gb-calendar-controls\s*\{[\s\S]*?display:\s*flex\s*!important;[\s\S]*?overflow-x:\s*auto\s*!important;[\s\S]*?flex-wrap:\s*nowrap\s*!important;/, 'Calendar controls must use one horizontally swipeable Android action rail instead of stacking vertically.');
assert.match(portrait, /\.gbpos-mobile \.gb-calendar-content-schedule\s*\{[\s\S]*?grid-column:\s*auto\s*!important;/, 'Content schedule must stay in the compact action rail.');
assert.match(portrait, /\.gbpos-mobile \.gb-calendar-timeoff-button\s*\{[\s\S]*?width:\s*2\.35rem;/, 'Time off must remain reachable as a compact touch target.');

console.log('Mobile calendar compact-header regression checks passed.');