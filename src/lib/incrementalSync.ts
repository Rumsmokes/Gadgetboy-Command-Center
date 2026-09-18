export type CloudCursor = {
  updatedAt: string;
  id: string;
};

export type IncrementalRow = {
  id: string | number;
  updated_at?: string | null;
  cloudUpdatedAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
};

export type CollectionChange = {
  collection: string;
  id: string | number;
  event: string;
  row?: unknown;
};

function rowUpdatedAt(row: IncrementalRow): string {
  return String(row.updated_at || row.cloudUpdatedAt || row.updatedAt || '');
}

function compareRowPosition(a: IncrementalRow, b: IncrementalRow): number {
  const timeCompare = rowUpdatedAt(a).localeCompare(rowUpdatedAt(b));
  if (timeCompare !== 0) return timeCompare;
  return String(a.id).localeCompare(String(b.id));
}

export function cursorAfterRows(rows: IncrementalRow[]): CloudCursor | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const latest = rows.reduce((current, row) => compareRowPosition(row, current) > 0 ? row : current);
  const updatedAt = rowUpdatedAt(latest);
  return updatedAt ? { updatedAt, id: String(latest.id) } : null;
}

export function isRowAfterCursor(row: IncrementalRow, cursor: CloudCursor | null | undefined): boolean {
  if (!cursor) return true;
  const updatedAt = rowUpdatedAt(row);
  if (updatedAt > cursor.updatedAt) return true;
  if (updatedAt < cursor.updatedAt) return false;
  return String(row.id).localeCompare(cursor.id) > 0;
}

export function mergeIncrementalRows<T extends IncrementalRow>(
  existing: T[],
  incoming: T[],
  pendingIds: Set<string> = new Set<string>(),
  options: { terminal?: (row: T) => boolean } = {},
): T[] {
  const byId = new Map<string, T>();
  for (const row of Array.isArray(existing) ? existing : []) byId.set(String(row.id), row);
  for (const row of Array.isArray(incoming) ? incoming : []) {
    const id = String(row.id);
    const previous = byId.get(id);
    if (!previous) {
      byId.set(id, row);
      continue;
    }
    if (pendingIds.has(id)) continue;
    if (options.terminal?.(previous) && !options.terminal(row)) continue;
    if (compareRowPosition(row, previous) >= 0) byId.set(id, row);
  }
  return Array.from(byId.values());
}

export function shouldReconcile(
  now: number,
  state: { lastSuccessAt?: number | null; staleAfterMs: number },
  visibility: 'visible' | 'hidden' | string,
): boolean {
  if (visibility !== 'visible') return false;
  const lastSuccessAt = Number(state.lastSuccessAt || 0);
  return lastSuccessAt <= 0 || now - lastSuccessAt >= Math.max(0, Number(state.staleAfterMs || 0));
}

export function createChangeCoalescer(
  flush: (changes: CollectionChange[]) => void,
  delayMs = 120,
) {
  const pending = new Map<string, CollectionChange>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    if (pending.size === 0) return;
    const changes = Array.from(pending.values());
    pending.clear();
    flush(changes);
  };
  return {
    push(change: CollectionChange) {
      pending.set(`${change.collection}:${String(change.id)}`, change);
      if (!timer) timer = setTimeout(run, Math.max(0, delayMs));
    },
    flush: run,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
