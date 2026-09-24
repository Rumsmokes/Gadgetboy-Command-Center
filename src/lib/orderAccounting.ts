import { derivePartVendorFromUrl, normalizePartOrderUrl } from './partOrdering';

export type OrderCartPaymentStatus = 'paid' | 'partial' | 'unpaid' | 'unverified' | 'not_required';

export type OrderCartRow = {
  key: string;
  sourceType: 'workOrder' | 'sale' | 'manual' | 'inventory';
  sourceId: number;
  itemIndex: number;
  itemId?: string;
  customer: string;
  title: string;
  quantity: number;
  distributor: string;
  orderUrl: string;
  orderStatus: string;
  hasCost: boolean;
  unitCost: number;
  totalCost: number;
  unitCharge: number;
  baseUnitCharge: number;
  baseTotalCharge: number;
  clientTax: number;
  clientTaxRate: number;
  totalCharge: number;
  knownProfit: number | null;
  paymentStatus: OrderCartPaymentStatus;
  paymentDetail: string;
  taxExempt: boolean;
  supplierTaxRate: number;
  itemType?: 'Part' | 'Product';
  purchaseOrderId?: number;
  inventoryId?: number;
  estimatedDelivery?: string;
  queueAddedAt?: string;
};

export type OrderCartGroup = {
  distributor: string;
  rows: OrderCartRow[];
  checkoutUrl: string;
  checkoutLabel: 'Open cart' | 'Open distributor';
  knownCost: number;
  charge: number;
  knownProfit: number;
  missingCost: number;
  paymentWarnings: number;
};

function roundMoney(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

export const SC_SALES_TAX_RATE = 8;

export function calculateSalesTax(amount: unknown, taxExempt = false, taxRate = SC_SALES_TAX_RATE) {
  const taxableAmount = Math.max(0, Number(amount) || 0);
  const rate = Math.max(0, Number(taxRate) || 0);
  return taxExempt ? 0 : roundMoney(taxableAmount * rate / 100);
}

export function allocateCheckoutAdditionalCosts(rows: OrderCartRow[], additionalCost: unknown) {
  const allocation = new Map<string, number>();
  const amount = Math.max(0, Number(additionalCost) || 0);
  if (!rows.length || amount <= 0) return allocation;

  const weightTotal = rows.reduce((sum, row) => sum + (row.hasCost && row.totalCost > 0 ? row.totalCost : 1), 0);
  let allocated = 0;
  rows.forEach((row, index) => {
    const rowAmount = index === rows.length - 1
      ? roundMoney(amount - allocated)
      : roundMoney(amount * ((row.hasCost && row.totalCost > 0 ? row.totalCost : 1) / weightTotal));
    allocation.set(row.key, rowAmount);
    allocated = roundMoney(allocated + rowAmount);
  });
  return allocation;
}

function clientChargeWithTax(baseCharge: number, record: any) {
  const clientTaxRate = Math.max(0, Number(record?.taxRate) || 0);
  const clientTax = calculateSalesTax(baseCharge, false, clientTaxRate);
  return { clientTaxRate, clientTax, totalCharge: roundMoney(baseCharge + clientTax) };
}

export function itemQuantity(item: any) {
  const value = Number(item?.qty ?? item?.quantity ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function itemFullCost(item: any): number | null {
  const raw = item?.internalCost ?? item?.cost;
  if (raw === null || raw === undefined || raw === '') return null;
  const unit = Number(raw);
  if (!Number.isFinite(unit) || unit <= 0) return null;
  return roundMoney(unit * itemQuantity(item));
}

export function itemSoldCharge(item: any, sourceType: 'workOrder' | 'sale') {
  const raw = sourceType === 'workOrder'
    ? (item?.parts ?? item?.partCost ?? item?.price)
    : (item?.price ?? item?.unitPrice);
  return roundMoney((Number(raw) || 0) * itemQuantity(item));
}

export function applyPurchaseQueueRemovalToItems(itemsInput: any[], row: OrderCartRow, removedAt: string) {
  let matched = false;
  const paymentNotice = row.paymentStatus === 'paid'
    ? 'Payment was recorded for this item.'
    : row.paymentStatus === 'partial'
      ? 'A partial client payment was recorded for this item.'
      : row.paymentStatus === 'unverified'
        ? 'A client payment exists, but its allocation to this item needs verification.'
        : 'No client payment is currently recorded for this item.';
  const items = (Array.isArray(itemsInput) ? itemsInput : []).map((item: any, index: number) => {
    const isMatch = row.itemIndex >= 0 ? index === row.itemIndex : (!!row.itemId && String(item?.id) === String(row.itemId));
    if (!isMatch) return item;
    matched = true;
    return {
      ...item,
      purchaseQueueRemovedAt: removedAt,
      purchaseQueueRemovalPaymentStatus: row.paymentStatus,
      purchaseQueueRemovalNotice: `This item remains attached to the ${row.sourceType === 'workOrder' ? 'work order' : 'sale'}, but it has not been ordered. ${paymentNotice} Delivery and tracking information are unavailable until it is restored to the EOD Cart and purchased.`,
      requiresOrder: true,
      orderStatus: 'needed',
      orderDate: '',
      estDelivery: '',
      estimatedDelivery: '',
      trackingNumber: '',
      trackingUrl: '',
      trackingInfo: '',
    };
  });
  return { items, matched };
}

function paymentApplied(payment: any) {
  const value = Number(payment?.applied ?? payment?.amount ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function workOrderPartPayment(record: any, requiredCharge: number): { status: OrderCartPaymentStatus; detail: string } {
  const payments = Array.isArray(record?.payments) ? record.payments : [];
  const explicitPartsPaid = roundMoney(payments.reduce((sum: number, payment: any) => {
    const value = Number(payment?.appliedParts);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0));
  if (requiredCharge <= 0) return { status: 'unverified', detail: 'Client part charge is missing.' };
  if (explicitPartsPaid >= requiredCharge - 0.009) return { status: 'paid', detail: `${explicitPartsPaid.toFixed(2)} explicitly applied to parts.` };
  if (explicitPartsPaid > 0) return { status: 'partial', detail: `${explicitPartsPaid.toFixed(2)} of ${requiredCharge.toFixed(2)} applied to parts.` };
  const totalPaid = roundMoney(payments.reduce((sum: number, payment: any) => sum + paymentApplied(payment), 0));
  const legacyPaid = Math.max(totalPaid, roundMoney(record?.amountPaid));
  if (legacyPaid <= 0) return { status: 'unpaid', detail: 'No checkout payment is recorded.' };
  return { status: 'unverified', detail: 'Payment exists, but none is explicitly allocated to parts.' };
}

function salePayment(record: any): { status: OrderCartPaymentStatus; detail: string } {
  const amountPaid = roundMoney(record?.amountPaid);
  const remaining = Number(record?.totals?.remaining ?? record?.remaining);
  const total = Number(record?.totals?.total ?? record?.total);
  const fullyPaid = (Number.isFinite(remaining) && remaining <= 0.009)
    || (Number.isFinite(total) && total > 0 && amountPaid >= total - 0.009);
  if (fullyPaid) return { status: 'paid', detail: 'Sale checkout is paid in full.' };
  if (amountPaid <= 0) return { status: 'unpaid', detail: 'No sale checkout payment is recorded.' };
  return { status: 'unverified', detail: 'Sale is partially paid; payment is not allocated by product.' };
}

export function isOutstandingOrderItem(item: any, record: any, sourceType: 'workOrder' | 'sale') {
  if (item?.purchaseQueueRemovedAt) return false;
  const partSource = String(item?.partSourceKind || '').trim().toLowerCase();
  const saleSource = String(item?.sourceKind || '').trim().toLowerCase();
  const category = String(item?.category || item?.itemType || item?.type || '').trim().toLowerCase();
  if (item?.salvagedPart === true || item?.inStock === true || item?.isLabor === true || item?.labor === true || item?.isFee === true || item?.fee === true) return false;
  if (partSource === 'client' || partSource === 'stock' || saleSource === 'local') return false;
  if (category.startsWith('consult') || /labor|diagnostic|additional fee|\bfee\b/.test(category)) return false;
  const url = String(item?.orderSourceUrl || item?.productUrl || record?.partsOrderUrl || '').trim();
  const requiresOrder = sourceType === 'workOrder'
    ? item?.requiresOrder === true || partSource === 'order' || (!!url && item?.requiresOrder !== false)
    : item?.requiresOrder === true || saleSource === 'order' || item?.inStock === false;
  if (!requiresOrder) return false;
  const status = String(item?.orderStatus || (record?.partsOrderDate ? 'ordered' : 'needed')).trim().toLowerCase();
  return !['ordered', 'received', 'delivered', 'in_stock'].includes(status);
}

export function purchaseQueueAddedAt(item: any, record: any) {
  return String(item?.purchaseQueueAddedAt || item?.createdAt || record?.checkInAt || record?.createdAt || record?.updatedAt || '').trim();
}

function needsWorkOrderPurchase(item: any, record: any) {
  return isOutstandingOrderItem(item, record, 'workOrder');
}

function needsSalePurchase(item: any, record: any) {
  return isOutstandingOrderItem(item, record, 'sale');
}

function distributorName(item: any, url: string) {
  return String(item?.distributor || item?.partSource || derivePartVendorFromUrl(url) || '').trim() || 'Distributor needed';
}

export function collectOrderCartRows(workOrders: any[], sales: any[], purchaseOrders: any[] = []): OrderCartRow[] {
  const rows: OrderCartRow[] = [];
  for (const record of Array.isArray(workOrders) ? workOrders : []) {
    const items = Array.isArray(record?.items) ? record.items : [];
    const required = items.filter((item: any) => needsWorkOrderPurchase(item, record));
    const requiredCharge = roundMoney(required.reduce((sum: number, item: any) => {
      const baseCharge = itemSoldCharge(item, 'workOrder');
      return sum + clientChargeWithTax(baseCharge, record).totalCharge;
    }, 0));
    const payment = workOrderPartPayment(record, requiredCharge);
    required.forEach((item: any, itemIndex: number) => {
      const sourceIndex = items.indexOf(item);
      const orderUrl = normalizePartOrderUrl(item?.orderSourceUrl || item?.productUrl || record?.partsOrderUrl || '');
      const quantity = itemQuantity(item);
      const cost = itemFullCost(item);
      const baseCharge = itemSoldCharge(item, 'workOrder');
      const charge = clientChargeWithTax(baseCharge, record);
      rows.push({
        key: `workOrder:${record?.id}:${item?.id || sourceIndex}`,
        sourceType: 'workOrder',
        sourceId: Number(record?.id || 0),
        itemIndex: sourceIndex,
        itemId: item?.id,
        customer: String(record?.customerName || `Client #${record?.customerId || ''}`).trim(),
        title: String(item?.repair || item?.description || 'Repair part').trim(),
        quantity,
        distributor: distributorName(item, orderUrl),
        orderUrl,
        orderStatus: String(item?.orderStatus || 'needed'),
        hasCost: cost !== null,
        unitCost: cost === null ? 0 : roundMoney(cost / quantity),
        totalCost: cost ?? 0,
        unitCharge: roundMoney(charge.totalCharge / quantity),
        baseUnitCharge: roundMoney(baseCharge / quantity),
        baseTotalCharge: baseCharge,
        clientTax: charge.clientTax,
        clientTaxRate: charge.clientTaxRate,
        totalCharge: charge.totalCharge,
        knownProfit: cost === null ? null : roundMoney(baseCharge - cost),
        paymentStatus: payment.status,
        paymentDetail: payment.detail,
        taxExempt: item?.taxExempt === true,
        supplierTaxRate: Number(item?.supplierTaxRate ?? 8) || 8,
        estimatedDelivery: String(item?.estimatedDelivery || item?.estDelivery || '').slice(0, 10),
          queueAddedAt: purchaseQueueAddedAt(item, record),
      });
    });
  }

  for (const record of Array.isArray(sales) ? sales : []) {
    const quickSale = Number(record?.customerId) === 0
      && /^(quick sale|quick repair)$/i.test(String(record?.customerName || '').trim());
    if (quickSale) continue;
    const items = Array.isArray(record?.items) ? record.items : [];
    const payment = salePayment(record);
    items.forEach((item: any, itemIndex: number) => {
      if (!needsSalePurchase(item)) return;
      const orderUrl = normalizePartOrderUrl(item?.productUrl || item?.orderSourceUrl || item?.reorderUrlTemplate || '');
      const quantity = itemQuantity(item);
      const cost = itemFullCost(item);
      const baseCharge = itemSoldCharge(item, 'sale');
      const charge = clientChargeWithTax(baseCharge, record);
      rows.push({
        key: `sale:${record?.id}:${item?.id || itemIndex}`,
        sourceType: 'sale',
        sourceId: Number(record?.id || 0),
        itemIndex,
        itemId: item?.id,
        customer: String(record?.customerName || 'Walk-in sale').trim(),
        title: String(item?.description || item?.name || item?.title || 'Product').trim(),
        quantity,
        distributor: distributorName(item, orderUrl),
        orderUrl,
        orderStatus: String(item?.orderStatus || 'needed'),
        hasCost: cost !== null,
        unitCost: cost === null ? 0 : roundMoney(cost / quantity),
        totalCost: cost ?? 0,
        unitCharge: roundMoney(charge.totalCharge / quantity),
        baseUnitCharge: roundMoney(baseCharge / quantity),
        baseTotalCharge: baseCharge,
        clientTax: charge.clientTax,
        clientTaxRate: charge.clientTaxRate,
        totalCharge: charge.totalCharge,
        knownProfit: cost === null ? null : roundMoney(baseCharge - cost),
        paymentStatus: payment.status,
        paymentDetail: payment.detail,
        taxExempt: item?.vendorTaxExempt === true,
        supplierTaxRate: Number(item?.supplierTaxRate ?? 8) || 8,
        estimatedDelivery: String(item?.estimatedDelivery || item?.estDelivery || '').slice(0, 10),
          queueAddedAt: purchaseQueueAddedAt(item, record),
      });
    });
  }
  for (const record of Array.isArray(purchaseOrders) ? purchaseOrders : []) {
    if (!['pending', 'processing'].includes(String(record?.status || 'pending').toLowerCase())) continue;
    const quantity = itemQuantity(record);
    const unitCost = Number(record?.unitCost);
    const hasCost = Number.isFinite(unitCost) && unitCost >= 0;
    const totalCost = hasCost ? roundMoney(unitCost * quantity) : 0;
    const sourceType: OrderCartRow['sourceType'] = ['workOrder', 'sale', 'inventory'].includes(record?.sourceType)
      ? record.sourceType
      : 'manual';
    const orderUrl = normalizePartOrderUrl(record?.orderUrl || '');
    rows.push({
      key: `purchaseOrder:${record?.id}`,
      sourceType,
      sourceId: Number(record?.sourceId || record?.inventoryId || record?.id || 0),
      itemIndex: Number.isFinite(Number(record?.sourceItemIndex)) ? Number(record.sourceItemIndex) : -1,
      itemId: record?.sourceItemId ? String(record.sourceItemId) : undefined,
      customer: String(record?.customer || (sourceType === 'inventory' ? 'Inventory restock' : sourceType === 'manual' ? 'Manual purchase' : `${sourceType === 'workOrder' ? 'WO' : 'Sale'} #${record?.sourceId || ''}`)),
      title: String(record?.title || record?.itemDescription || 'Supplier item').trim(),
      quantity,
      distributor: distributorName(record, orderUrl),
      orderUrl,
      orderStatus: 'needed',
      hasCost,
      unitCost: hasCost ? roundMoney(unitCost) : 0,
      totalCost,
      unitCharge: 0,
      baseUnitCharge: 0,
      baseTotalCharge: 0,
      clientTax: 0,
      clientTaxRate: 0,
      totalCharge: 0,
      knownProfit: null,
      paymentStatus: 'not_required',
      paymentDetail: sourceType === 'inventory' ? 'Inventory restock; no client payment is expected.' : 'Manual supplier purchase; no client payment is linked.',
      taxExempt: record?.taxExempt === true,
      supplierTaxRate: Number(record?.supplierTaxRate ?? 8) || 8,
      itemType: record?.itemType === 'Product' ? 'Product' : 'Part',
      purchaseOrderId: Number(record?.id || 0),
      inventoryId: Number(record?.inventoryId || 0) || undefined,
      estimatedDelivery: String(record?.estimatedDelivery || record?.estDelivery || '').slice(0, 10),
    });
  }
  return rows.sort((a, b) => a.distributor.localeCompare(b.distributor) || a.sourceType.localeCompare(b.sourceType) || a.sourceId - b.sourceId);
}

export function filterLedgerBackedOrderCartRows(rows: OrderCartRow[], purchaseOrders: any[]) {
  const ledgerSourceKeys = new Set(
    (Array.isArray(purchaseOrders) ? purchaseOrders : [])
      .map(record => String(record?.sourceKey || ''))
      .filter(Boolean),
  );
  return rows.filter(row => row.purchaseOrderId || !ledgerSourceKeys.has(row.key));
}

const KNOWN_CART_PATHS: Array<[RegExp, string]> = [
  [/(^|\.)amazon\.com$/i, '/gp/cart/view.html'],
  [/(^|\.)ebay\.com$/i, '/cart'],
  [/(^|\.)phonelcdparts\.com$/i, '/checkout/cart'],
  [/(^|\.)mobilesentrix\.com$/i, '/checkout/cart'],
  [/(^|\.)injuredgadgets\.com$/i, '/checkout/cart'],
  [/(^|\.)wholesalegadgetparts\.com$/i, '/checkout/cart'],
];

export function distributorCheckoutTarget(rows: OrderCartRow[]) {
  const firstUrl = rows.map(row => row.orderUrl).find(Boolean) || '';
  if (!firstUrl) return { url: '', label: 'Open distributor' as const };
  try {
    const parsed = new URL(firstUrl);
    const match = KNOWN_CART_PATHS.find(([host]) => host.test(parsed.hostname));
    if (match) return { url: `${parsed.origin}${match[1]}`, label: 'Open cart' as const };
    return { url: firstUrl, label: 'Open distributor' as const };
  } catch {
    return { url: firstUrl, label: 'Open distributor' as const };
  }
}

export function groupOrderCartRows(rows: OrderCartRow[]): OrderCartGroup[] {
  const groups = new Map<string, OrderCartRow[]>();
  rows.forEach(row => groups.set(row.distributor, [...(groups.get(row.distributor) || []), row]));
  return Array.from(groups.entries()).map(([distributor, groupRows]) => {
    const checkout = distributorCheckoutTarget(groupRows);
    return {
      distributor,
      rows: groupRows,
      checkoutUrl: checkout.url,
      checkoutLabel: checkout.label,
      knownCost: roundMoney(groupRows.filter(row => row.hasCost).reduce((sum, row) => sum + row.totalCost, 0)),
      charge: roundMoney(groupRows.reduce((sum, row) => sum + row.totalCharge, 0)),
      knownProfit: roundMoney(groupRows.filter(row => row.knownProfit !== null).reduce((sum, row) => sum + Number(row.knownProfit), 0)),
      missingCost: groupRows.filter(row => !row.hasCost).length,
      paymentWarnings: groupRows.filter(row => row.paymentStatus !== 'paid' && row.paymentStatus !== 'not_required').length,
    };
  }).sort((a, b) => a.distributor.localeCompare(b.distributor));
}
