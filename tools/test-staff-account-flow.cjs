const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const edge = read('supabase/functions/staff-account-admin/index.ts');
const login = read('src/auth/LoginScreen.tsx');
const technicians = read('src/components/TechniciansWindow.tsx');

assert.match(edge, /action !== "setup"/, 'Admin setup action must exist.');
assert.match(edge, /requireActiveStaff\(req, \{ roles: \["admin"\] \}\)/, 'Only an active admin may provision a staff login.');
assert.match(edge, /inviteUserByEmail/, 'Setup must use a Supabase invite link instead of collecting passwords in the POS.');
assert.match(edge, /action === "request-recovery"/, 'Email-only recovery action must exist.');
assert.match(edge, /status: "active"/, 'Only active technicians can receive setup or recovery links.');
assert.match(edge, /genericRecoveryResult/, 'Recovery must not reveal whether an account or staff record exists.');
assert.match(login, /Forgot ya Login\?/, 'The login screen must expose the requested recovery entry point.');
assert.match(technicians, /Set Up Login/, 'Technician management must expose a future login setup action.');

console.log('Staff account setup and recovery checks passed.');
