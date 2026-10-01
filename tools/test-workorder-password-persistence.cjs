const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
for (const file of ['app/electron/electron-main.ts', 'src/mobile/mobile-api.ts']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(source, /work_order_private_credentials/, `${file} must use the private work-order credentials table.`);
  assert.match(source, /credentialsByWorkOrderId/, `${file} must hydrate passwords by the cloud work-order ID.`);
  assert.match(source, /credentialsByLegacyId/, `${file} must hydrate passwords by the POS work-order number.`);
  assert.match(source, /device_password:\s*String\(item\.password/, `${file} must preserve entered passwords in the private credential record.`);
}

const release = fs.readFileSync(path.join(root, 'src/workorders/ReleaseFormWindow.tsx'), 'utf8');
for (const label of ['Password / PIN', 'Unlock Pattern', 'Accessories', 'Assigned Technician', 'Check-In']) {
  assert.ok(release.includes(label), `Automatic release form must include ${label}.`);
}

console.log('Work-order password persistence and release intake checks passed.');
