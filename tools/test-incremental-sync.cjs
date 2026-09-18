const assert = require('node:assert/strict');

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' },
});

const {
  cursorAfterRows,
  isRowAfterCursor,
  mergeIncrementalRows,
  shouldReconcile,
  createChangeCoalescer,
} = require('../src/lib/incrementalSync.ts');

async function main() {
  const sameTime = '2026-09-17T12:00:00.000Z';
  const cursor = cursorAfterRows([
    { id: 'a', updated_at: sameTime },
    { id: 'c', updated_at: sameTime },
    { id: 'b', updated_at: sameTime },
  ]);
  assert.deepEqual(cursor, { updatedAt: sameTime, id: 'c' });
  assert.equal(isRowAfterCursor({ id: 'd', updated_at: sameTime }, cursor), true);
  assert.equal(isRowAfterCursor({ id: 'b', updated_at: sameTime }, cursor), false);

  const merged = mergeIncrementalRows(
    [
      { id: 1, value: 'cached', updated_at: '2026-09-17T10:00:00.000Z' },
      { id: 2, value: 'local pending', updated_at: '2026-09-17T10:00:00.000Z' },
      { id: 3, status: 'closed', updated_at: '2026-09-17T12:00:00.000Z' },
    ],
    [
      { id: 1, value: 'cloud newer', updated_at: '2026-09-17T11:00:00.000Z' },
      { id: 2, value: 'cloud ignored', updated_at: '2026-09-17T11:00:00.000Z' },
      { id: 3, status: 'open', updated_at: '2026-09-17T11:30:00.000Z' },
      { id: 4, value: 'new row', updated_at: '2026-09-17T11:00:00.000Z' },
    ],
    new Set(['2']),
    { terminal: (row) => row.status === 'closed' },
  );
  assert.equal(merged.find((row) => row.id === 1).value, 'cloud newer');
  assert.equal(merged.find((row) => row.id === 2).value, 'local pending');
  assert.equal(merged.find((row) => row.id === 3).status, 'closed');
  assert.equal(merged.find((row) => row.id === 4).value, 'new row');

  const now = Date.parse('2026-09-17T12:15:00.000Z');
  assert.equal(shouldReconcile(now, { lastSuccessAt: now - 16 * 60_000, staleAfterMs: 15 * 60_000 }, 'visible'), true);
  assert.equal(shouldReconcile(now, { lastSuccessAt: now - 5 * 60_000, staleAfterMs: 15 * 60_000 }, 'visible'), false);
  assert.equal(shouldReconcile(now, { lastSuccessAt: 0, staleAfterMs: 15 * 60_000 }, 'hidden'), false);

  const batches = [];
  const coalescer = createChangeCoalescer((changes) => batches.push(changes), 5);
  coalescer.push({ collection: 'workOrders', id: 44, event: 'UPDATE' });
  coalescer.push({ collection: 'workOrders', id: 44, event: 'UPDATE' });
  coalescer.push({ collection: 'sales', id: 9, event: 'INSERT' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [
    { collection: 'workOrders', id: 44, event: 'UPDATE' },
    { collection: 'sales', id: 9, event: 'INSERT' },
  ]);
  coalescer.dispose();

  console.log('Incremental sync primitive checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
