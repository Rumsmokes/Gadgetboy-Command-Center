const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifications = fs.readFileSync(path.resolve(__dirname, '..', 'src/lib/notifications.ts'), 'utf8');
const migration = fs.readFileSync(path.resolve(__dirname, '..', 'supabase/migrations/20261112045043_push_notification_devices.sql'), 'utf8');
const eventMigration = fs.readFileSync(path.resolve(__dirname, '..', 'supabase/migrations/20261112150000_push_notification_events.sql'), 'utf8');
const capacitor = fs.readFileSync(path.resolve(__dirname, '..', 'capacitor.config.ts'), 'utf8');
const sender = fs.readFileSync(path.resolve(__dirname, '..', 'supabase/functions/send-push-notification/index.ts'), 'utf8');
const mobileApp = fs.readFileSync(path.resolve(__dirname, '..', 'src/mobile/MobileApp.tsx'), 'utf8');

assert.match(notifications, /registerPushToken/, 'Android push registration must be available to authenticated staff.');
assert.match(notifications, /push_notification_devices/, 'Push tokens must be stored in the secured staff device table.');
assert.match(notifications, /notificationTap/, 'Notification actions must retain a destination for ticket routing.');
assert.match(notifications, /send-push-notification/, 'Record notifications must call the secured remote sender.');
assert.match(mobileApp, /registerPushToken/, 'The Android shell must register an authenticated staff device for push delivery.');
assert.match(migration, /create table public\.push_notification_devices/i, 'Push-device table must be created by migration.');
assert.match(migration, /enable row level security/i, 'Push-device rows must enforce RLS.');
assert.match(migration, /auth\.uid\(\)/i, 'Push-device writes must be tied to the authenticated staff user.');
assert.match(migration, /is_active_shop_staff/i, 'Push devices must be confined to active shop staff.');
assert.match(capacitor, /PushNotifications/, 'Capacitor must configure push notification support.');
assert.match(sender, /FIREBASE_SERVICE_ACCOUNT_JSON/, 'The push sender must read Firebase credentials only from an Edge Function secret.');
assert.match(sender, /push_notification_devices/, 'The push sender must target registered shop devices.');
assert.match(sender, /push_notification_events/, 'The push sender must reserve each event to prevent duplicate device blasts.');
assert.match(sender, /shop_id/, 'The push sender must scope delivery to the originating shop.');
assert.match(sender, /authClient/, 'The sender must authenticate the caller using their JWT.');
assert.match(sender, /adminClient/, 'The sender must use a privileged server-only client for the cross-device lookup.');
assert.match(sender, /SUPABASE_SECRET_KEYS/, 'The sender must support current Supabase server secret configuration.');
assert.match(eventMigration, /unique \(shop_id, event_key\)/i, 'Push events must be idempotent per shop.');
assert.match(eventMigration, /enable row level security/i, 'The idempotency ledger must not be client-readable.');

console.log('FCM notification security contract checks passed.');
