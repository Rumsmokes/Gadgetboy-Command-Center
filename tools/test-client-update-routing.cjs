const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('supabase/functions/client-updates/index.ts', 'utf8');
const commandCenter = fs.readFileSync('src/components/CommandCenter.tsx', 'utf8');

assert.match(source, /workflow_stage/, 'QR updates must persist a workflow stage for Command Center routing.');
assert.match(source, /workflow_updated_at/, 'QR updates must persist a routing timestamp so sync accepts the new stage.');
assert.match(source, /repair_complete.*Pickup|Pickup.*repair_complete/s, 'Ready-for-pickup action must map to Pickup.');
assert.match(commandCenter, /command-center-live-work-orders/, 'Command Center must directly subscribe to live work-order changes.');

console.log('Client update routing checks passed.');
