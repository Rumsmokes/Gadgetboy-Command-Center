import {
  cursorAfterRows,
  isRowAfterCursor,
  mergeIncrementalRows,
  type CloudCursor,
  type IncrementalRow,
} from './incrementalSync';

export type IncrementalSyncResult<T> = {
  collection: string;
  rows: T[];
  changedRows: T[];
  rowsReceived: number;
  approximateBytes: number;
  cursor: CloudCursor | null;
  syncedAt: string;
};

export async function synchronizeIncrementalCollection<T extends IncrementalRow>(input: {
  collection: string;
  existing: T[];
  cursor?: CloudCursor | null;
  pendingIds?: Set<string>;
  terminal?: (row: T) => boolean;
  fetchChanged: (cursor: CloudCursor | null) => Promise<T[]>;
  persist: (rows: T[]) => Promise<void> | void;
  now?: Date;
}): Promise<IncrementalSyncResult<T>> {
  const fetched = await input.fetchChanged(input.cursor || null);
  const changedRows = (Array.isArray(fetched) ? fetched : []).filter((row) => isRowAfterCursor(row, input.cursor));
  const rows = mergeIncrementalRows(
    input.existing || [],
    changedRows,
    input.pendingIds || new Set<string>(),
    { terminal: input.terminal },
  );
  await input.persist(rows);
  return {
    collection: input.collection,
    rows,
    changedRows,
    rowsReceived: changedRows.length,
    approximateBytes: Buffer.byteLength(JSON.stringify(changedRows), 'utf8'),
    cursor: cursorAfterRows(changedRows) || input.cursor || null,
    syncedAt: (input.now || new Date()).toISOString(),
  };
}
