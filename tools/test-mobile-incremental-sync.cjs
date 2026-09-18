const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'src/mobile/mobile-api.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/mobile/MobileApp.tsx'), 'utf8');

assert.match(api, /async function syncMobileCollection\(/, 'Mobile must expose an explicit incremental reconciliation boundary.');
assert.match(api, /cloudSyncCollection:\s*\(key:/, 'Mobile bridge must expose explicit collection sync.');
assert.match(api, /dbGet:\s*\(key:[^\n]+readCachedList/, 'Normal mobile reads must use the local cache.');
assert.match(api, /getWorkOrders:[^\n]+readCachedList/, 'Mobile work-order reads must not download the full cloud table.');
assert.doesNotMatch(api, /async function dbUpdate[\s\S]{0,450}cloudDbGet\(key\)/, 'Updating one row must not fetch its entire table first.');
assert.doesNotMatch(api, /async function dbFind[\s\S]{0,250}cloudDbGet\(key\)/, 'Local search must not fetch its entire table.');
assert.match(api, /payload\.eventType\s*===\s*'DELETE'/, 'Realtime deletes must remove the cached row directly.');
assert.match(api, /fromCloudRow\(key, payload\.new/, 'Realtime updates must patch the cached row directly.');
assert.match(app, /cloudSyncCollection/, 'Mobile startup must explicitly reconcile stale collections.');
assert.doesNotMatch(app, /setInterval\([^\n]+60_000\)/, 'Mobile must not run a one-minute polling loop.');

console.log('Mobile incremental sync contract checks passed.');
