import { itemFullCost } from './orderAccounting';
export { buildRepairWorkflowTiming } from './repairWorkflowReporting';

export type ReportingLedgerEntry = {
  recordKey: string;
  kind: 'repair' | 'sale';
  date: Date;
  laborCharged: number;
  partsCharged: number;
  taxCollected: number;
  collected: number;
  internalCost: number;
  profitExcludingTax: number;
  missingInternalCost: number;
};

export function reportingRecordKind(record: any): 'repair' | 'sale' {
  if (record?.kind !== 'sale') return 'repair';
  if (String(record?.quickCheckoutType || '').trim().toLowerCase() === 'repair') return 'repair';
  const items = Array.isArray(record?.items) ? record.items : [];
  return items.some((item: any) => String(item?.category || '').trim().toLowerCase() === 'repair') ? 'repair' : 'sale';
}

const roundMoney = (value: number) => Math.round((Number(value) || 0) * 100) / 100;

export function verifiedPurchaseTotal(purchase: any) {
  const recordedTotal = Number(purchase?.totalCost);
  if (Number.isFinite(recordedTotal) && recordedTotal >= 0) return roundMoney(recordedTotal);
  const itemCost = Number(purchase?.itemCost);
  const additionalCost = Number(purchase?.additionalCost);
  const supplierTax = purchase?.taxExempt === true ? 0 : Number(purchase?.supplierTax);
  return roundMoney(
    (Number.isFinite(itemCost) ? itemCost : 0)
    + (Number.isFinite(supplierTax) ? supplierTax : 0)
    + (Number.isFinite(additionalCost) ? additionalCost : 0),
  );
}

function positive(value: any) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseDate(value: any): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function paymentAmount(payment: any) {
  const applied = positive(payment?.applied);
  if (applied > 0) return roundMoney(applied);
  const tendered = positive(payment?.amount ?? payment?.tender ?? payment?.paid);
  const change = positive(payment?.change ?? payment?.changeDue);
  return roundMoney(Math.max(0, tendered - change));
}

function paymentDate(payment: any) {
  return parseDate(payment?.at ?? payment?.date ?? payment?.createdAt ?? payment?.timestamp);
}

function fallbackPaymentDate(record: any) {
  for (const key of [
    'historicalPaymentDate', 'manualPaymentDate', 'checkoutDate', 'clientPickupDate', 'repairCompletionDate', 'completedAt',
    'closedAt', 'invoiceDate', 'saleDate', 'transactionDate', 'checkInAt', 'createdAt',
  ]) {
    const date = parseDate(record?.[key]);
    if (date) return date;
  }
  return null;
}

export function collectReportingPayments(record: any) {
  const existing = Array.isArray(record?.payments)
    ? [...record.payments]
    : Array.isArray(record?.paymentHistory)
      ? [...record.paymentHistory]
      : Array.isArray(record?.paymentLogs)
        ? [...record.paymentLogs]
        : [];
  const amountPaid = positive(record?.amountPaid ?? record?.paid ?? record?.totalPaid);
  const recorded = roundMoney(existing.reduce((sum: number, payment: any) => sum + paymentAmount(payment), 0));
  const missing = roundMoney(amountPaid - recorded);
  if (missing <= 0.009) return existing;
  const date = fallbackPaymentDate(record);
  if (!date) return existing;
  return [{
    applied: missing,
    amount: missing,
    paymentType: String(record?.paymentType || 'Legacy'),
    at: date.toISOString(),
    inferred: true,
  }, ...existing];
}

function isConsultationItem(item: any, record: any) {
  const category = String(item?.category || record?.category || '').toLowerCase();
  const title = String(item?.description || item?.repair || item?.name || '').toLowerCase();
  return category.startsWith('consult') || title.includes('consultation');
}

function itemQuantity(item: any) {
  return positive(item?.qty ?? item?.quantity) || 1;
}

function invoiceBuckets(record: any, kind: 'repair' | 'sale') {
  const discount = positive(record?.discount);
  const taxRate = positive(record?.taxRate);
  let labor = 0;
  let parts = 0;

  if (kind === 'repair') {
    labor = Math.max(0, positive(record?.laborCost) - discount);
    parts = positive(record?.partCosts);
  } else {
    const items = Array.isArray(record?.items) ? record.items : [];
    if (items.length) {
      for (const item of items) {
        const line = itemQuantity(item) * positive(item?.price ?? item?.unitPrice);
        if (isConsultationItem(item, record)) labor += line;
        else parts += line;
      }
    } else {
      parts = positive(record?.partCosts ?? record?.price);
    }
    const gross = labor + parts;
    if (discount > 0 && gross > 0) {
      labor = Math.max(0, labor - discount * (labor / gross));
      parts = Math.max(0, parts - discount * (parts / gross));
    }
  }

  labor = roundMoney(labor);
  parts = roundMoney(parts);
  const tax = roundMoney(parts * taxRate / 100);
  return { labor, parts, tax, partsGross: roundMoney(parts + tax), total: roundMoney(labor + parts + tax) };
}

function internalCostState(record: any, kind: 'repair' | 'sale') {
  const items = Array.isArray(record?.items) ? record.items : [];
  if (items.length) {
    let knownCost = 0;
    let missing = 0;
    for (const item of items) {
      if (isConsultationItem(item, record)) continue;
      const charge = kind === 'sale'
        ? itemQuantity(item) * positive(item?.price ?? item?.unitPrice)
        : itemQuantity(item) * positive(item?.parts ?? item?.partCost ?? item?.price);
      if (!(charge > 0)) continue;
      const cost = itemFullCost(item);
      const rawCost = item?.internalCost ?? item?.cost;
      if (cost === null && rawCost !== 0 && rawCost !== '0') missing += 1;
      else knownCost += cost || 0;
    }
    return { knownCost: roundMoney(knownCost), missing };
  }
  const physicalCharge = kind === 'sale' ? positive(record?.partCosts ?? record?.price) : positive(record?.partCosts);
  if (!(physicalCharge > 0)) return { knownCost: 0, missing: 0 };
  const raw = record?.internalCost;
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) {
    return { knownCost: 0, missing: 1 };
  }
  return { knownCost: roundMoney(positive(raw)), missing: 0 };
}

export function buildReportingLedger(records: any[]): ReportingLedgerEntry[] {
  const ledger: ReportingLedgerEntry[] = [];
  for (const record of records || []) {
    const kind = reportingRecordKind(record);
    const buckets = invoiceBuckets(record, kind);
    if (!(buckets.total > 0)) continue;
    const costState = internalCostState(record, kind);
    let remainingLabor = buckets.labor;
    let remainingPartsGross = buckets.partsGross;

    for (const payment of collectReportingPayments(record)) {
      const date = paymentDate(payment);
      let applied = Math.min(paymentAmount(payment), roundMoney(remainingLabor + remainingPartsGross));
      if (!date || !(applied > 0)) continue;

      let laborGross = 0;
      let partsGross = 0;
      const explicitLabor = Math.min(positive(payment?.appliedLabor), remainingLabor, applied);
      const explicitParts = Math.min(positive(payment?.appliedParts), remainingPartsGross, Math.max(0, applied - explicitLabor));
      laborGross = explicitLabor;
      partsGross = explicitParts;
      let unallocated = roundMoney(applied - explicitLabor - explicitParts);

      if (unallocated > 0 && kind === 'sale') {
        const available = remainingLabor + remainingPartsGross;
        const laborShare = available > 0 ? remainingLabor / available : 0;
        const proportionalLabor = Math.min(remainingLabor - laborGross, roundMoney(unallocated * laborShare));
        laborGross += Math.max(0, proportionalLabor);
        partsGross += Math.min(remainingPartsGross - partsGross, roundMoney(unallocated - proportionalLabor));
      } else if (unallocated > 0) {
        const toLabor = Math.min(remainingLabor - laborGross, unallocated);
        laborGross += Math.max(0, toLabor);
        unallocated = roundMoney(unallocated - toLabor);
        partsGross += Math.min(remainingPartsGross - partsGross, unallocated);
      }

      laborGross = roundMoney(Math.min(remainingLabor, laborGross));
      partsGross = roundMoney(Math.min(remainingPartsGross, partsGross));
      remainingLabor = roundMoney(Math.max(0, remainingLabor - laborGross));
      remainingPartsGross = roundMoney(Math.max(0, remainingPartsGross - partsGross));

      const partsNetRatio = buckets.partsGross > 0 ? buckets.parts / buckets.partsGross : 0;
      const partsCharged = roundMoney(partsGross * partsNetRatio);
      const taxCollected = roundMoney(partsGross - partsCharged);
      const costRatio = buckets.parts > 0 ? Math.min(1, partsCharged / buckets.parts) : 0;
      const internalCost = roundMoney(costState.knownCost * costRatio);
      const netCollected = roundMoney(laborGross + partsCharged);

      ledger.push({
        recordKey: `${kind}:${String(record?.id ?? record?.ticketNumber ?? record?.invoiceNumber ?? 'unknown')}`,
        kind,
        date,
        laborCharged: laborGross,
        partsCharged,
        taxCollected,
        collected: roundMoney(netCollected + taxCollected),
        internalCost,
        profitExcludingTax: roundMoney(netCollected - internalCost),
        missingInternalCost: partsCharged > 0 ? costState.missing : 0,
      });
    }
  }
  return ledger;
}
