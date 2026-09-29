
type Summary = {
  removed: number;
  removedByCollection: Record<string, number>;
  clearedMetadata: boolean;
};

function idSet(rows: any[]) {
  return new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.id ?? '')).filter(Boolean));
}

function matchesSeedTimestamp(row: any, seedStamp: string) {
  return !!seedStamp && String(row?.createdAt || '') === seedStamp;
}

function filterCollection(db: any, key: string, predicate: (row: any) => boolean, summary: Summary) {
  const rows = Array.isArray(db?.[key]) ? db[key] : [];
  const kept = rows.filter((row: any) => !predicate(row));
  const removed = rows.length - kept.length;
  if (removed > 0) {
    db[key] = kept;
    summary.removed += removed;
    summary.removedByCollection[key] = removed;
  }
}

export function sanitizeAccidentalTestData(source: any): { db: any; summary: Summary } {
  const db = source && typeof source === 'object' ? JSON.parse(JSON.stringify(source)) : {};
  const summary: Summary = { removed: 0, removedByCollection: {}, clearedMetadata: false };
  const meta = db?._meta && typeof db._meta === 'object' ? db._meta : {};
  const seedProfile = String(meta.seedProfile || '').trim();
  const seedStamp = String(meta.seededAt || '').trim();

  // Explicit generated-data fingerprints remain safe to quarantine even after an
  // earlier cleanup has removed the seed marker from a production cache.

  const fakeCustomerIds = idSet((db.customers || []).filter((row: any) =>
    /@example\.com$/i.test(String(row?.email || '')) &&
    /^803-100-\d{4}$/.test(String(row?.phone || '')),
  ));

  filterCollection(db, 'customers', (row) => fakeCustomerIds.has(String(row?.id ?? '')), summary);
  const fakeWorkOrderIds = idSet((db.workOrders || []).filter((row: any) =>
    String(row?.intakeSource || '').trim() === 'Test Environment' ||
    String(row?.serial || '').trim() === 'TEST-SERIAL',
  ));
  filterCollection(db, 'workOrders', (row) => fakeWorkOrderIds.has(String(row?.id ?? '')), summary);

  const fakeSaleIds = idSet((db.sales || []).filter((row: any) =>
    String(row?.intakeSource || '').trim() === 'Test Environment',
  ));
  filterCollection(db, 'sales', (row) =>
    fakeSaleIds.has(String(row?.id ?? '')) || fakeCustomerIds.has(String(row?.customerId ?? '')),
  summary);

  const linkedToGeneratedTicket = (row: any) =>
    fakeCustomerIds.has(String(row?.customerId ?? '')) ||
    fakeWorkOrderIds.has(String(row?.workOrderId ?? '')) ||
    fakeSaleIds.has(String(row?.saleId ?? ''));

  for (const key of ['quotes', 'calendarEvents', 'calendarNotes', 'purchaseOrders', 'notifications']) {
    filterCollection(db, key, linkedToGeneratedTicket, summary);
  }
  filterCollection(db, 'clientResponses', (row) =>
    linkedToGeneratedTicket(row) || /^reply-test-/i.test(String(row?.id || '')),
  summary);

  // Catalog rows only use the seed timestamp while a full seeded profile is
  // present; without that marker, never infer that a shop catalog row is fake.
  if (seedProfile === 'test-week') {
    for (const key of [
      'products', 'repairCategories', 'repairTypes', 'deviceCategories',
      'productCategories', 'technicians', 'settings',
    ]) {
      filterCollection(db, key, (row) => matchesSeedTimestamp(row, seedStamp), summary);
    }

    if (Array.isArray(db.addressHistory)) db.addressHistory = [];
    delete db._meta;
    summary.clearedMetadata = true;
  }
  return { db, summary };
}
