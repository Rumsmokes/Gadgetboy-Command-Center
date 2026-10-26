import { findInventoryPartForRepair, InventoryPartMatchContext } from './inventoryPartMatching';
import { inventoryParentId, isInventoryParent } from './inventoryVariants';

type InventoryApi = {
  dbGet?: (key: string) => Promise<any[]>;
  update?: (key: string, value: any) => Promise<any>;
  dbUpdate?: (key: string, id: number, value: any) => Promise<any>;
};

type ConsumeOptions = {
  allowShortfall?: boolean;
  repairContext?: InventoryPartMatchContext;
  respectProductCreatedAt?: boolean;
  checkoutDate?: unknown;
};

type ConsumptionResult = {
  applied: number;
  skipped: number;
  shortfalls: Array<{ productId: number; title: string; requested: number; available: number }>;
};

let reconciliationPromise: Promise<ConsumptionResult> | null = null;
let workOrderReconciliationPromise: Promise<ConsumptionResult> | null = null;

export function resolveConsumedInventoryId(item: any, products: any[]): number | undefined {
  const explicitId = Number(item?.inventoryProductId || 0);
  if (!(explicitId > 0)) return undefined;
  const product = (Array.isArray(products) ? products : []).find((row: any) => Number(row?.id) === explicitId);
  if (!product || isInventoryParent(product)) return undefined;
  const requiredParentId = Number(item?.inventoryParentId || 0);
  if (requiredParentId > 0 && inventoryParentId(product) !== requiredParentId) return undefined;
  return explicitId;
}

export function validateRequiredVariant(item: any, products: any[]): void {
  const parentId = Number(item?.inventoryParentId || 0);
  if (!(parentId > 0)) return;
  if (!resolveConsumedInventoryId(item, products)) {
    throw new Error('Choose the exact part used (such as color or type) before checkout.');
  }
}

function units(item: any) {
  const value = Number(item?.qty ?? item?.quantity ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : 1;
}

function isSupplierSourced(item: any): boolean {
  const source = String(item?.partSourceKind || item?.sourceKind || '').trim().toLowerCase();
  return item?.requiresOrder === true || source === 'order' || source === 'supplier';
}

function itemConsumptionKey(sourceType: 'sale' | 'workOrder', sourceId: number | string, item: any, index: number) {
  const lineId = String(item?.id || '').trim() || `line-${index}`;
  return `${sourceType}:${sourceId}:${lineId}`;
}

function paidAmount(record: any) {
  const direct = Number(record?.amountPaid || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const payments = Array.isArray(record?.payments) ? record.payments : [];
  return payments.reduce((sum: number, payment: any) => {
    const applied = Number(payment?.applied ?? payment?.amount ?? 0);
    return sum + (Number.isFinite(applied) && applied > 0 ? applied : 0);
  }, 0);
}

export function saleHasCheckoutPayment(sale: any) {
  return paidAmount(sale) > 0;
}

export function shouldConsumeWorkOrderInventory(input: {
  partsPaymentApplied?: boolean;
  markClosed?: boolean;
  status?: unknown;
}) {
  return input.partsPaymentApplied === true
    || input.markClosed === true
    || String(input.status || '').trim().toLowerCase() === 'closed';
}

async function saveProduct(api: InventoryApi, product: any) {
  if (api.update) return api.update('products', product);
  return api.dbUpdate?.('products', Number(product.id), product);
}

async function consumeWithProducts(
  api: InventoryApi,
  products: any[],
  sourceType: 'sale' | 'workOrder',
  sourceId: number | string,
  items: any[],
  options: ConsumeOptions = {},
): Promise<ConsumptionResult> {
  const result: ConsumptionResult = { applied: 0, skipped: 0, shortfalls: [] };
  const dirtyProducts = new Map<number, any>();

  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    validateRequiredVariant(item, products);
    const matchedPart = sourceType === 'workOrder' && !item?.inventoryProductId
      ? findInventoryPartForRepair(products, item, options.repairContext)
      : null;
    const inventoryId = Number(resolveConsumedInventoryId(item, products) || (matchedPart && !isInventoryParent(matchedPart) ? matchedPart.id : 0));
    // Supplier-sourced lines are not installed inventory. A line must be
    // explicitly marked as shop inventory (or resolve to a linked stock part)
    // before it can reduce an on-hand variant.
    if (!(inventoryId > 0) || isSupplierSourced(item)) continue;
    const productIndex = products.findIndex((row: any) => Number(row?.id) === inventoryId);
    const product = productIndex >= 0 ? products[productIndex] : null;
    if (!product || product.trackStock !== true) {
      result.skipped += 1;
      continue;
    }

    if (options.respectProductCreatedAt) {
      const checkoutAt = new Date(String(options.checkoutDate || '')).getTime();
      const productCreatedAt = new Date(String(product.createdAt || '')).getTime();
      if (Number.isFinite(checkoutAt) && Number.isFinite(productCreatedAt) && checkoutAt < productCreatedAt) {
        result.skipped += 1;
        continue;
      }
    }

    const key = itemConsumptionKey(sourceType, sourceId, item, index);
    const consumedKeys = Array.isArray(product.inventoryConsumptionKeys)
      ? product.inventoryConsumptionKeys.map(String).filter(Boolean)
      : [];
    if (consumedKeys.includes(key)) {
      result.skipped += 1;
      continue;
    }

    const quantity = units(item);
    const stockCount = Math.max(0, Math.round(Number(product.stockCount || 0)));
    if (stockCount < quantity && !options.allowShortfall) {
      throw new Error(`${product.itemDescription || 'Inventory item'} has ${stockCount} in stock but checkout requires ${quantity}.`);
    }
    if (stockCount < quantity) {
      result.shortfalls.push({
        productId: inventoryId,
        title: String(product.itemDescription || 'Inventory item'),
        requested: quantity,
        available: stockCount,
      });
    }

    const updated = {
      ...product,
      stockCount: Math.max(0, stockCount - quantity),
      // Durable markers prevent a second device or a later reconciliation
      // from subtracting the same paid sale line again.
      inventoryConsumptionKeys: [...consumedKeys, key],
      updatedAt: new Date().toISOString(),
    };
    products[productIndex] = updated;
    dirtyProducts.set(inventoryId, updated);
    result.applied += 1;
  }

  for (const product of dirtyProducts.values()) {
    const saved = await saveProduct(api, product);
    if (!saved) throw new Error(`${product.itemDescription || 'Inventory item'} stock update returned no record.`);
    const index = products.findIndex((row: any) => Number(row?.id) === Number(product.id));
    if (index >= 0) products[index] = saved;
  }

  return result;
}

export async function consumeInStockInventory(
  api: InventoryApi,
  sourceType: 'sale' | 'workOrder',
  sourceId: number | string,
  items: any[],
  options: ConsumeOptions = {},
) {
  if (!api?.dbGet || !sourceId) return { applied: 0, skipped: 0, shortfalls: [] };
  const products: any[] = await api.dbGet('products').catch(() => []);
  if (!Array.isArray(products)) throw new Error('Inventory could not be loaded for checkout.');
  return consumeWithProducts(api, products, sourceType, sourceId, items, options);
}

export async function reconcilePaidSaleInventory(api: InventoryApi): Promise<ConsumptionResult> {
  if (!api?.dbGet) return { applied: 0, skipped: 0, shortfalls: [] };
  if (reconciliationPromise) return reconciliationPromise;

  reconciliationPromise = (async () => {
    const [sales, products] = await Promise.all([
      api.dbGet!('sales').catch(() => []),
      api.dbGet!('products').catch(() => []),
    ]);
    if (!Array.isArray(sales) || !Array.isArray(products)) {
      throw new Error('Sales or inventory could not be loaded for reconciliation.');
    }

    const total: ConsumptionResult = { applied: 0, skipped: 0, shortfalls: [] };
    const orderedSales = sales
      .filter((sale: any) => Number(sale?.id || 0) > 0 && saleHasCheckoutPayment(sale))
      .sort((a: any, b: any) => Number(a?.id || 0) - Number(b?.id || 0));

    for (const sale of orderedSales) {
      const result = await consumeWithProducts(
        api,
        products,
        'sale',
        Number(sale.id),
        Array.isArray(sale.items) ? sale.items : [],
        { allowShortfall: true },
      );
      total.applied += result.applied;
      total.skipped += result.skipped;
      total.shortfalls.push(...result.shortfalls);
    }
    return total;
  })().finally(() => {
    reconciliationPromise = null;
  });

  return reconciliationPromise;
}

function workOrderHasCheckout(workOrder: any): boolean {
  if (String(workOrder?.checkoutDate || '').trim()) return true;
  return String(workOrder?.status || '').trim().toLowerCase() === 'closed' && paidAmount(workOrder) > 0;
}

export async function reconcilePaidWorkOrderInventory(api: InventoryApi): Promise<ConsumptionResult> {
  if (!api?.dbGet) return { applied: 0, skipped: 0, shortfalls: [] };
  if (workOrderReconciliationPromise) return workOrderReconciliationPromise;

  workOrderReconciliationPromise = (async () => {
    const [workOrders, products] = await Promise.all([
      api.dbGet!('workOrders').catch(() => []),
      api.dbGet!('products').catch(() => []),
    ]);
    if (!Array.isArray(workOrders) || !Array.isArray(products)) {
      throw new Error('Work orders or inventory could not be loaded for reconciliation.');
    }

    const total: ConsumptionResult = { applied: 0, skipped: 0, shortfalls: [] };
    const checkedOut = workOrders
      .filter((workOrder: any) => workOrder?.id && workOrderHasCheckout(workOrder))
      .sort((a: any, b: any) => {
        const aTime = new Date(String(a?.checkoutDate || a?.updatedAt || 0)).getTime() || 0;
        const bTime = new Date(String(b?.checkoutDate || b?.updatedAt || 0)).getTime() || 0;
        return aTime - bTime;
      });

    for (const workOrder of checkedOut) {
      const result = await consumeWithProducts(
        api,
        products,
        'workOrder',
        workOrder.id,
        Array.isArray(workOrder.items) ? workOrder.items : [],
        {
          allowShortfall: true,
          respectProductCreatedAt: true,
          checkoutDate: workOrder.checkoutDate,
          repairContext: {
            deviceCategory: workOrder.productCategory,
            deviceName: workOrder.productDescription,
            deviceModel: workOrder.model,
          },
        },
      );
      total.applied += result.applied;
      total.skipped += result.skipped;
      total.shortfalls.push(...result.shortfalls);
    }
    return total;
  })().finally(() => {
    workOrderReconciliationPromise = null;
  });

  return workOrderReconciliationPromise;
}
