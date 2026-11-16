const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('src/App.tsx', 'utf8');

assert.match(
  source,
  /const preserveRenderedWorkspace = Boolean\(cloudSessionInitializedRef\.current && staffProfile\?\.shop_id\);/,
  'A token refresh must identify an already-connected POS workspace before changing cloud state.',
);
assert.match(
  source,
  /if \(!preserveRenderedWorkspace\) setCloudReady\(false\);/,
  'Only the initial cloud connection may replace an active POS window with the loading screen.',
);

console.log('Session refresh workspace-preservation checks passed.');
