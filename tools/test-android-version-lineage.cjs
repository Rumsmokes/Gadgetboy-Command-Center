const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');

assert.match(
  gradle,
  /def gbposVersionCode = 100000 \+ \(gbposVersionParts\[0\] \* 10000\) \+ \(gbposVersionParts\[1\] \* 100\) \+ gbposVersionParts\[2\]/,
  'Android version codes must remain above the former 0.6.x release line after the visible version reset.',
);

const codeFor = ([major, minor, patch]) => 100000 + (major * 10000) + (minor * 100) + patch;
assert.ok(codeFor([0, 1, 0]) > 6099, 'v0.1.0 must install as newer than the old v0.6.99 Android build.');
assert.ok(codeFor([0, 1, 1]) > codeFor([0, 1, 0]), 'patch releases must increase Android versionCode.');

console.log('Android release-line versionCode checks passed.');
