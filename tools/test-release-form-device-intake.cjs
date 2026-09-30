const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/workorders/ReleaseFormWindow.tsx'), 'utf8');

assert.match(source, /id="release-device-intake"/, 'The device information area needs a stable print-layout section.');
for (const label of ['Device Category', 'Device Name', 'Model', 'Serial #', 'Password / PIN', 'Unlock Pattern', 'Accessories', 'Reported Problem']) {
  assert.ok(source.includes(label), `Release form must show ${label}.`);
}
const intakeStart = source.indexOf('id="release-device-intake"');
const repairsStart = source.indexOf('>Repairs<', intakeStart);
const intake = source.slice(intakeStart, repairsStart);
assert.doesNotMatch(intake, />Customer<|>Phone<|>Alt Phone<|>Email</, 'Client contact details belong in the top-right header, not the device section.');

console.log('Release-form device intake checks passed.');
