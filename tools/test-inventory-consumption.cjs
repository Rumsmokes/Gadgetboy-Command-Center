const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const fs = require('node:fs');

const build = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'lib', 'inventoryConsumption.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const moduleShim = { exports: {} };
new Function('module', 'exports', 'require', build.outputFiles[0].text)(moduleShim, moduleShim.exports, require);
const {
  consumeInStockInventory,
  reconcilePaidSaleInventory,
  reconcilePaidWorkOrderInventory,
  saleHasCheckoutPayment,
  shouldConsumeWorkOrderInventory,
} = moduleShim.exports;

async function main() {
  const quickSaleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'QuickSaleWindow.tsx'), 'utf8');
  const regularSaleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'sales', 'SaleWindow.tsx'), 'utf8');
  const workOrderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'workorders', 'NewWorkOrderWindow.tsx'), 'utf8');
  assert.match(quickSaleSource, /consumeInStockInventory\(api, 'sale'/, 'Quick Checkout must deduct linked inventory after creating its paid sale.');
  assert.match(regularSaleSource, /consumeInStockInventory\(/, 'Regular sale checkout must deduct linked inventory.');
  assert.match(workOrderSource, /consumeInStockInventory\(api, 'workOrder'/, 'Closed work-order checkout must deduct linked inventory.');
  assert.doesNotMatch(quickSaleSource, /repair\?\.orderSourceUrl \? \{ requiresOrder: true/, 'A saved catalog URL must not automatically turn a quick repair into an EOD purchase.');

  let products = [{ id: 7, itemDescription: 'Test Part', trackStock: true, stockCount: 5, inventoryConsumptionKeys: [] }];
  const api = {
    dbGet: async (key) => key === 'products' ? products.map((row) => ({ ...row })) : [],
    update: async (_key, value) => {
      products = products.map((row) => row.id === value.id ? { ...value } : row);
      return { ...value };
    },
  };
  const items = [{ id: 'line-1', inventoryProductId: 7, qty: 2, requiresOrder: false }];
  const first = await consumeInStockInventory(api, 'workOrder', 101, items);
  assert.equal(first.applied, 1);
  assert.equal(products[0].stockCount, 3);

  const retry = await consumeInStockInventory(api, 'workOrder', 101, items);
  assert.equal(retry.applied, 0);
  assert.equal(retry.skipped, 1);
  assert.equal(products[0].stockCount, 3, 'Retry must not consume the same work-order line twice.');

  const orderedPartNotReceived = await consumeInStockInventory(api, 'workOrder', 102, [{
    id: 'supplier-line', inventoryProductId: 7, qty: 1, requiresOrder: false, partSourceKind: 'order', orderStatus: 'needed',
  }]);
  assert.equal(orderedPartNotReceived.applied, 0, 'A supplier-sourced line must not consume shop inventory before delivery, even if it is not in the EOD cart.');
  assert.equal(products[0].stockCount, 3, 'Supplier-sourced repair lines cannot decrement an in-stock part.');

  await assert.rejects(
    () => consumeInStockInventory(api, 'sale', 202, [{ id: 'line-2', inventoryProductId: 7, qty: 4, requiresOrder: false }]),
    /has 3 in stock but checkout requires 4/,
  );
  assert.equal(products[0].stockCount, 3, 'Insufficient stock must not change inventory.');

  assert.equal(saleHasCheckoutPayment({ amountPaid: 0, payments: [] }), false);
  assert.equal(saleHasCheckoutPayment({ amountPaid: 0, payments: [{ applied: 2 }] }), true);
  assert.equal(shouldConsumeWorkOrderInventory({ partsPaymentApplied: false, markClosed: false, status: 'closed' }), true, 'A fully paid labor-only checkout that closes a repair must still consume its installed part.');
  assert.equal(shouldConsumeWorkOrderInventory({ partsPaymentApplied: false, markClosed: false, status: 'open' }), false, 'An open unpaid repair must not consume stock.');

  let historyProducts = [{ id: 9, itemDescription: 'GadgetBoy Drink', trackStock: true, stockCount: 8, inventoryConsumptionKeys: [] }];
  const historySales = [
    { id: 301, amountPaid: 6.48, items: [{ id: 'drink-a', inventoryProductId: 9, qty: 2, requiresOrder: false }] },
    { id: 302, amountPaid: 0, items: [{ id: 'unpaid-drink', inventoryProductId: 9, qty: 3, requiresOrder: false }] },
    { id: 303, payments: [{ applied: 3.24 }], items: [{ id: 'drink-b', inventoryProductId: 9, qty: 1, requiresOrder: false }] },
  ];
  const historyApi = {
    dbGet: async (key) => key === 'products'
      ? historyProducts.map((row) => ({ ...row, inventoryConsumptionKeys: [...row.inventoryConsumptionKeys] }))
      : historySales.map((row) => ({ ...row })),
    update: async (_key, value) => {
      historyProducts = historyProducts.map((row) => row.id === value.id ? { ...value } : row);
      return { ...value };
    },
  };
  const historical = await reconcilePaidSaleInventory(historyApi);
  assert.equal(historical.applied, 2);
  assert.equal(historyProducts[0].stockCount, 5, 'Only paid historical sales should reduce stock.');

  const historicalRetry = await reconcilePaidSaleInventory(historyApi);
  assert.equal(historicalRetry.applied, 0);
  assert.equal(historyProducts[0].stockCount, 5, 'A historical rescan must be idempotent.');

  let shortStock = [{ id: 10, itemDescription: 'Low Stock Drink', trackStock: true, stockCount: 1, inventoryConsumptionKeys: [] }];
  const shortApi = {
    dbGet: async (key) => key === 'products' ? shortStock.map((row) => ({ ...row })) : [
      { id: 401, amountPaid: 10, items: [{ id: 'drink-c', inventoryProductId: 10, qty: 3, requiresOrder: false }] },
    ],
    update: async (_key, value) => {
      shortStock = [{ ...value }];
      return { ...value };
    },
  };
  const shortResult = await reconcilePaidSaleInventory(shortApi);
  assert.equal(shortStock[0].stockCount, 0, 'Historical overselling should reconcile to zero, never negative stock.');
  assert.equal(shortResult.shortfalls.length, 1);

  let repairProducts = [
    {
      id: 26,
      itemType: 'Part',
      itemDescription: 'PS5 HDMI Port',
      category: 'Game Console',
      repairType: 'HDMI',
      associatedDevices: ['PS5 OG (Digital)', 'PS5 OG (Disc)', 'PS5 Pro (Digital)', 'PS5 Slim (Digital)', 'PS5 Slim (Disc)'],
      trackStock: true,
      stockCount: 10,
      createdAt: '2026-08-23T16:35:49.096Z',
      inventoryConsumptionKeys: [],
    },
    {
      id: 27,
      itemType: 'Part',
      itemDescription: 'Xbox HDMI Port',
      category: 'Game Console',
      repairType: 'HDMI',
      associatedDevices: ['Xbox Series S', 'Xbox Series X'],
      trackStock: true,
      stockCount: 6,
      createdAt: '2026-08-23T16:35:49.096Z',
      inventoryConsumptionKeys: [],
    },
    {
      id: 28,
      itemType: 'Part',
      itemDescription: 'iPhone 14 OLED Assembly',
      category: 'Phone',
      repairType: 'Screen Replacement',
      associatedDevices: ['iPhone 14'],
      trackStock: true,
      stockCount: 4,
      createdAt: '2026-08-23T16:35:49.096Z',
      inventoryConsumptionKeys: [],
    },
  ];
  const missedWorkOrders = [
    {
      id: 1166,
      status: 'closed',
      checkoutDate: '2026-08-24T16:46:00.859Z',
      productCategory: 'Game Console',
      productDescription: 'PS5 OG (Disc)',
      items: [{ id: 'ps5-hdmi', repair: 'HDMI', repairCategory: 'HDMI', quantity: 1, requiresOrder: false }],
    },
    {
      id: 1167,
      status: 'closed',
      checkoutDate: '2026-08-24T17:00:00.000Z',
      productCategory: 'Phone',
      productDescription: 'iPhone 14',
      items: [{ id: 'iphone-screen', repair: 'Screen Replacement', repairCategory: 'Screen Replacement', quantity: 1, requiresOrder: false }],
    },
    {
      id: 1100,
      status: 'closed',
      checkoutDate: '2026-08-20T17:00:00.000Z',
      productCategory: 'Game Console',
      productDescription: 'PS5 OG (Disc)',
      items: [{ id: 'old-ps5-hdmi', repair: 'HDMI', repairCategory: 'HDMI', quantity: 1, requiresOrder: false }],
    },
  ];
  const repairApi = {
    dbGet: async (key) => key === 'products'
      ? repairProducts.map((row) => ({ ...row, associatedDevices: [...row.associatedDevices], inventoryConsumptionKeys: [...row.inventoryConsumptionKeys] }))
      : key === 'workOrders' ? missedWorkOrders.map((row) => ({ ...row, items: row.items.map((item) => ({ ...item })) })) : [],
    update: async (_key, value) => {
      repairProducts = repairProducts.map((row) => row.id === value.id ? { ...value } : row);
      return { ...value };
    },
  };
  const repaired = await reconcilePaidWorkOrderInventory(repairApi);
  assert.equal(repaired.applied, 2, 'Only eligible checked-out work-order repairs should be reconciled.');
  assert.equal(repairProducts.find((row) => row.id === 26).stockCount, 9, 'PS5 HDMI must consume the PS5-compatible HDMI port.');
  assert.equal(repairProducts.find((row) => row.id === 27).stockCount, 6, 'PS5 HDMI must never consume an Xbox HDMI port.');
  assert.equal(repairProducts.find((row) => row.id === 28).stockCount, 3, 'Phone screen repairs must use the same repair-type and compatible-device matching.');

  const repairedRetry = await reconcilePaidWorkOrderInventory(repairApi);
  assert.equal(repairedRetry.applied, 0, 'Missed work-order reconciliation must be idempotent across app launches.');
  assert.equal(repairProducts.find((row) => row.id === 26).stockCount, 9);
  console.log('Inventory consumption checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
