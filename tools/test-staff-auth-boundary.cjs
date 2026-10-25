const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const helper = read('supabase/functions/_shared/staff-auth.ts');
const qrStatus = read('supabase/functions/qr-status/index.ts');
const clientUpdates = read('supabase/functions/client-updates/index.ts');
const sendEmail = read('supabase/functions/send-pos-email/index.ts');

assert.match(helper, /requireActiveStaff/, 'Shared staff authorization helper must exist.');
assert.match(helper, /staff_profiles/, 'Staff authorization must load staff profiles server-side.');
assert.match(helper, /status[\s\S]{0,120}active/, 'Only active staff can pass staff authorization.');
assert.match(helper, /shop_id/, 'Staff authorization must resolve shop ownership.');
assert.match(qrStatus, /requireActiveStaff/, 'Staff QR requests must use the shared authorization helper.');
assert.match(qrStatus, /String\(staff\.shopId\)[\s\S]{0,180}String\(tokenRow\.shop_id\)/, 'Staff QR requests must verify the QR token belongs to the caller shop.');
assert.match(qrStatus, /select\("id,shop_id,record_type,legacy_record_id,expires_at"\)/, 'QR token lookup must not expose token data unnecessarily.');
assert.match(clientUpdates, /requireActiveStaff/, 'Client updates must use the shared authorization helper.');
assert.match(sendEmail, /requireActiveStaff/, 'POS email must use the shared authorization helper.');
assert.doesNotMatch(qrStatus, /\.select\("\*"\)/, 'QR status must not load a full ticket row using the service role.');

console.log('Staff authorization boundary checks passed.');
