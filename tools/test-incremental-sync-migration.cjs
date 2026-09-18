const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260917203457_incremental_sync_indexes.sql'), 'utf8');
for (const table of ['customers', 'staff_profiles', 'work_orders', 'sales', 'calendar_events', 'calendar_notes', 'purchase_orders', 'shop_settings', 'products', 'product_categories', 'device_categories', 'repair_categories', 'part_sources']) {
  assert.match(migration, new RegExp(`on public\\.${table} \\(shop_id, updated_at, id\\)`, 'i'), `${table} needs the incremental cursor index.`);
}
assert.equal((migration.match(/create index if not exists/gi) || []).length, 13);
console.log('Incremental sync migration checks passed.');
