
const FIELDS = {
  customers: ['id', 'email', 'phone'],
  workOrders: ['id', 'customerId', 'customerName', 'productDescription', 'problemInfo', 'intakeSource', 'serial'],
  sales: ['id', 'customerId', 'customerName', 'itemDescription', 'total', 'category'],
  quotes: ['id', 'customerId', 'customerName', 'notes'],
  calendarEvents: ['id', 'customerId', 'workOrderId', 'saleId', 'title', 'category', 'source'],
  calendarNotes: ['id', 'customerId', 'workOrderId', 'body'],
  purchaseOrders: ['id', 'customerId', 'workOrderId', 'itemName', 'orderUrl'],
  products: ['id', 'itemDescription', 'price', 'internalCost', 'distributorSku'],
  repairCategories: ['id', 'title', 'category', 'repairCategory', 'partCost', 'laborCost'],
  repairTypes: ['id', 'name'],
  deviceCategories: ['id', 'name'],
  productCategories: ['id', 'name'],
  technicians: ['id', 'firstName', 'lastName', 'nickname'],
  settings: ['id', 'shopAddress', 'shopLat', 'shopLng'],
};

function equal(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function matchingFixtureIds(key, liveRows, fixtureRows) {
  const fields = FIELDS[key];
  if (!fields) return new Set();
  const fixtureById = new Map((fixtureRows || []).map((row) => [String(row?.id ?? ''), row]));
  return new Set((liveRows || [])
    .filter((row) => {
      const fixture = fixtureById.get(String(row?.id ?? ''));
      return !!fixture && fields.every((field) => equal(row?.[field], fixture?.[field]));
    })
    .map((row) => String(row?.id ?? '')));
}

function removeFixtureRows(source, fixture) {
  const db = JSON.parse(JSON.stringify(source || {}));
  const removedByCollection = {};
  const fixtureIds = {};

  for (const key of Object.keys(FIELDS)) {
    fixtureIds[key] = matchingFixtureIds(key, db[key], fixture?.[key]);
    const rows = Array.isArray(db[key]) ? db[key] : [];
    const kept = rows.filter((row) => !fixtureIds[key].has(String(row?.id ?? '')));
    if (kept.length !== rows.length) {
      db[key] = kept;
      removedByCollection[key] = rows.length - kept.length;
    }
  }

  const workOrderIds = fixtureIds.workOrders || new Set();
  const saleIds = fixtureIds.sales || new Set();
  const customerIds = fixtureIds.customers || new Set();
  const linked = (row) =>
    workOrderIds.has(String(row?.workOrderId ?? '')) ||
    saleIds.has(String(row?.saleId ?? '')) ||
    customerIds.has(String(row?.customerId ?? ''));

  for (const key of ['notifications', 'clientResponses']) {
    const rows = Array.isArray(db[key]) ? db[key] : [];
    const kept = rows.filter((row) => !linked(row) && !/^reply-test-/i.test(String(row?.id || '')));
    if (kept.length !== rows.length) {
      db[key] = kept;
      removedByCollection[key] = (removedByCollection[key] || 0) + rows.length - kept.length;
    }
  }

  if (db._meta?.seedProfile === 'test-week') delete db._meta;
  return { db, removedByCollection };
}

module.exports = { removeFixtureRows };
