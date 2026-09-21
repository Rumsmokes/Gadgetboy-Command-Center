const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'electron', 'electron-main.ts'), 'utf8');

assert.match(
  mainSource,
  /show:\s*IS_TEST_ENVIRONMENT,/,
  'The test app must create its main window visibly instead of relying on the asynchronous reveal path.',
);
assert.match(
  mainSource,
  /if \(!\(IS_TEST_ENVIRONMENT \|\| app\.requestSingleInstanceLock\(\)\)\)/,
  'An isolated test app must be launchable beside the production POS.',
);

console.log('Test environment visible-window check passed.');
