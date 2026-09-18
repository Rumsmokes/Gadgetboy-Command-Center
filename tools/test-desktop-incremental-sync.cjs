const assert = require('node:assert/strict');
const fs = require('node:fs');

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' },
});

const { synchronizeIncrementalCollection } = require('../src/lib/incrementalCloudSync.ts');

async function main() {
  let saved = null;
  let requestedCursor = null;
  const result = await synchronizeIncrementalCollection({
    collection: 'workOrders',
    existing: [{ id: 1, status: 'open', updated_at: '2026-09-17T10:00:00.000Z' }],
    cursor: { updatedAt: '2026-09-17T10:00:00.000Z', id: '1' },
    pendingIds: new Set(),
    terminal: (row) => row.status === 'closed',
    fetchChanged: async (cursor) => {
      requestedCursor = cursor;
      return [
        { id: 1, status: 'closed', updated_at: '2026-09-17T11:00:00.000Z' },
        { id: 2, status: 'open', updated_at: '2026-09-17T11:00:00.000Z' },
      ];
    },
    persist: async (rows) => { saved = rows; },
  });
  assert.deepEqual(requestedCursor, { updatedAt: '2026-09-17T10:00:00.000Z', id: '1' });
  assert.deepEqual(saved.map((row) => [row.id, row.status]), [[1, 'closed'], [2, 'open']]);
  assert.equal(result.rowsReceived, 2);
  assert.equal(result.changedRows.length, 2);
  assert.deepEqual(result.cursor, { updatedAt: '2026-09-17T11:00:00.000Z', id: '2' });
  assert.ok(result.approximateBytes > 0);

  const mainSource = fs.readFileSync(require.resolve('../app/electron/electron-main.ts'), 'utf8');
  const preloadSource = fs.readFileSync(require.resolve('../app/electron/preload.ts'), 'utf8');
  assert.match(mainSource, /ipcMain\.handle\('cloud:syncCollection'/, 'Desktop main must expose explicit incremental collection synchronization.');
  assert.match(mainSource, /ipcMain\.handle\('cloud:getSyncStatus'/, 'Desktop main must expose truthful sync diagnostics.');
  assert.match(preloadSource, /cloudSyncCollection:/, 'Renderer bridge must expose incremental synchronization.');
  assert.match(preloadSource, /cloudGetSyncStatus:/, 'Renderer bridge must expose synchronization status.');

  console.log('Desktop incremental cloud sync checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
