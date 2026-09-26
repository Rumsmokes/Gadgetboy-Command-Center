import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { computeTotals } from '../lib/calc';
import { useAutosave } from '../lib/useAutosave';
import { listTechnicians, technicianDisplayName } from '../lib/admin';
import { allocateCheckoutAdditionalCosts, applyPurchaseQueueRemovalToItems, calculateSalesTax, collectOrderCartRows, filterLedgerBackedOrderCartRows, groupOrderCartRows, SC_SALES_TAX_RATE, type OrderCartRow } from '../lib/orderAccounting';
import { buildReportingLedger } from '../lib/reportingAccounting';
import { derivePartVendorFromUrl, normalizePartInventoryTitle, normalizePartOrderUrl, scrapePartUrl } from '../lib/partOrdering';
import { applyDeliveredInventoryPurchase, buildInventoryReorderPurchase, inventoryLowStockFingerprint, inventoryReorderQuantity, isInventoryLowStock } from '../lib/inventoryReorder';
import { DEFAULT_COMMISSION_SETTINGS, allocateCommissionPool, normalizeCommissionSettings, selectedSalesCommissionTechnicians, technicianCommissionId, type CommissionSettings } from '../lib/commission';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { useContextMenu } from '../lib/useContextMenu';
import { supabase } from '../lib/supabase';
import { checkedOutPurchaseSpend, purchaseBudgetDayKey, purchaseBudgetSnapshot, selectedPurchaseCost } from '../lib/purchaseBudget';
import { consumeWindowPayload } from '../lib/windowPayload';
import { taskAssignmentLabel, taskIsCompleted } from '../lib/calendarTasks';
import { taskCompletionPatch } from '../lib/immediatePersistence';
import { expandRecurringEvent } from '../lib/calendarRecurrence';

type RangeKey = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'last7' | 'custom';
type CommissionRangeKey = 'currentMonth' | 'previousMonth' | 'currentYear' | 'custom';
const CONSULTATION_HOURLY_RATE = 75;
const LOW_STOCK_DISMISSALS_KEY = 'gbpos:eod-low-stock-dismissals:v1';

interface EodSettings {
  id?: number;
  recipients: string;
  subject?: string;
  includeWorkOrders: boolean;
  includeSales: boolean;
  includeOutstanding: boolean;
  includePayments: boolean;
  includeCounts: boolean;
  includeBatchInfo: boolean;
  emailIncludeTrends?: boolean; // legacy flag (applies when specific flags not set)
  emailIncludeTrendsWeek?: boolean;
  emailIncludeTrendsMonth?: boolean;
  emailIncludeOpenTickets?: boolean;
  emailIncludeWorkOrdersDetails?: boolean;
  emailIncludeSalesDetails?: boolean;
  emailIncludeOutstandingDetails?: boolean;
  emailIncludeTechnicianSummary?: boolean;
  schedule: 'manual' | 'daily' | 'weekly' | 'monthly';
  sendTime: string; // HH:mm
  batchOutTime?: string; // HH:mm
  autoBackup?: boolean;
  emailBody?: string;
  lastSentAt?: string | null;
}

const defaultSettings: EodSettings = {
  recipients: '',
  subject: 'Daily batch report',
  includeWorkOrders: true,
  includeSales: true,
  includeOutstanding: true,
  includePayments: true,
  includeCounts: true,
  includeBatchInfo: true,
  emailIncludeTrends: true,
  emailIncludeTrendsWeek: true,
  emailIncludeTrendsMonth: true,
  emailIncludeOpenTickets: false,
  emailIncludeWorkOrdersDetails: false,
  emailIncludeSalesDetails: false,
  emailIncludeOutstandingDetails: false,
  emailIncludeTechnicianSummary: false,
  schedule: 'daily',
  sendTime: '18:00',
  batchOutTime: '21:00',
  autoBackup: true,
  emailBody: '',
  lastSentAt: null,
};

function formatCurrency(n: number) {
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(input: string | Date | null | undefined) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function escapeHtml(text: string) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function sendCartClientUpdate(payload: {
  recordType: 'repair' | 'sale';
  recordId: number;
  statusKey: 'part_ordered' | 'product_ordered' | 'part_delivered' | 'product_in_shop';
  estimatedDate?: string;
  notes?: string;
}) {
  const request = supabase.functions.invoke('client-updates', { body: { ...payload, deliveryMode: 'email', preserveTechNotes: true } });
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(() => reject(new DOMException('Supabase did not respond in time.', 'AbortError')), 25_000);
  });
  const { data, error } = await Promise.race([request, timeout]);
  if (error) {
    const contextBody = (error as any)?.context?.body;
    throw new Error(String(contextBody?.error || (error as any)?.message || 'Client update failed.'));
  }
  if (!data?.ok) throw new Error(String(data?.error || 'Client update failed.'));
  return data;
}

function allocateSupplierTax(rows: OrderCartRow[], taxExempt: boolean) {
  const byRow = new Map<string, number>();
  const taxableTotal = round2(rows.reduce((sum, row) => sum + row.totalCost, 0));
  const supplierTax = calculateSalesTax(taxableTotal, taxExempt, SC_SALES_TAX_RATE);
  let allocatedTax = 0;
  rows.forEach((row, index) => {
    const amount = index === rows.length - 1
      ? round2(supplierTax - allocatedTax)
      : round2(supplierTax * (taxableTotal > 0 ? row.totalCost / taxableTotal : 1 / rows.length));
    byRow.set(row.key, amount);
    allocatedTax = round2(allocatedTax + amount);
  });
  return byRow;
}

function normalizeSaleItems(sale: any): Array<{ description: string; qty: number; price: number; category?: string; consultationHours?: number }> {
  const items = Array.isArray(sale?.items) ? sale.items : [];
  if (items.length) {
    return items.map((it: any) => {
      const description = (it?.description || it?.name || it?.title || '').toString();
      const category = it?.category;
      const isNonHourConsultationFee = isConsultationCategory(category)
        && !(Number(it?.consultationHours) > 0)
        && /(driver|distance|travel|fee)/i.test(description);
      return {
      description,
      qty: Number(it?.qty ?? it?.quantity ?? 1) || 1,
      price: Number(it?.price ?? it?.unitPrice ?? 0) || 0,
      category: isNonHourConsultationFee ? 'Fee' : category,
      consultationHours: Number(it?.consultationHours ?? 0) || undefined,
    }; });
  }
  const desc = (sale?.itemDescription || sale?.description || '').toString();
  const qty = Number(sale?.quantity ?? 1) || 1;
  const price = Number(sale?.price ?? 0) || 0;
  if (!desc && !(qty || price)) return [];
  return [{ description: desc, qty, price, category: sale?.category, consultationHours: Number(sale?.consultationHours ?? 0) || undefined }];
}

function normalizeCategory(cat: any): string {
  const s = (cat == null ? '' : String(cat)).trim();
  if (!s) return 'Uncategorized';
  const lower = s.toLowerCase();
  if (lower === 'consultation' || lower.startsWith('consult')) return 'Consultation';
  if (lower === 'device') return 'Device';
  if (lower === 'accessory') return 'Accessory';
  if (lower === 'other') return 'Other';
  return s;
}

function normalizeTechKey(v: any) {
  return (v == null ? '' : String(v)).trim().toLowerCase();
}

function resolveAssignedTechnician(record: any) {
  if (!record || typeof record !== 'object') return null;
  const raw = record?.assignedTo
    ?? record?.technician
    ?? record?.technicianName
    ?? record?.techName
    ?? record?.assigned_to
    ?? record?.assignedTech
    ?? null;
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value ? value : null;
}

function isConsultationCategory(cat: any) {
  return normalizeCategory(cat).toLowerCase() === 'consultation';
}

function saleItemUnits(item: { qty?: number; price?: number; category?: string; consultationHours?: number }) {
  if (isConsultationCategory(item?.category)) {
    const explicitHours = Number(item?.consultationHours ?? 0);
    if (Number.isFinite(explicitHours) && explicitHours > 0) return explicitHours;
    const qty = Number(item?.qty ?? 0);
    const price = Number(item?.price ?? 0);
    if (Number.isFinite(qty) && qty > 0 && Math.abs(price - CONSULTATION_HOURLY_RATE) < 0.01) return qty;
    const line = qty * price;
    if (line > 0) return line / CONSULTATION_HOURLY_RATE;
    return qty > 0 ? qty : 0;
  }
  const qty = Number(item?.qty ?? 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function saleItemLineTotal(item: { qty?: number; price?: number; category?: string; consultationHours?: number }) {
  return saleItemUnits(item) * (Number(item?.price) || 0);
}

function saleGross(items: Array<{ qty: number; price: number; category?: string; consultationHours?: number }>) {
  return items.reduce((sum, it) => sum + saleItemLineTotal(it), 0);
}

function computeSaleBreakdown(sale: any, commissionRate: number) {
  const items = normalizeSaleItems(sale);
  const discount = Math.max(0, Number(sale?.discount || 0) || 0);
  const gross = saleGross(items);
  const net = Math.max(0, gross - discount);

  const byCategoryGross = new Map<string, number>();
  const byCategoryNet = new Map<string, number>();

  for (const it of items) {
    const cat = normalizeCategory(it.category);
    const line = saleItemLineTotal(it);
    if (!Number.isFinite(line) || line === 0) continue;
    byCategoryGross.set(cat, (byCategoryGross.get(cat) || 0) + line);
  }

  // Allocate discount proportionally across categories (so mixed tickets behave well).
  const denom = gross > 0 ? gross : 0;
  for (const [cat, catGross] of byCategoryGross.entries()) {
    const share = denom > 0 ? (catGross / denom) : 0;
    const catNet = Math.max(0, catGross - discount * share);
    byCategoryNet.set(cat, catNet);
  }

  const consultationNet = Array.from(byCategoryNet.entries()).reduce((sum, [cat, amt]) => (isConsultationCategory(cat) ? sum + amt : sum), 0);
  const commissionableNet = Math.max(0, net - consultationNet);
  const commission = round2(commissionableNet * commissionRate);
  const consultationHours = items.reduce((sum, it) => (isConsultationCategory(it.category) ? sum + saleItemUnits(it) : sum), 0);

  return {
    items,
    gross: round2(gross),
    net: round2(net),
    discount: round2(discount),
    byCategoryGross,
    byCategoryNet,
    consultationNet: round2(consultationNet),
    consultationHours: round2(consultationHours),
    commissionableNet: round2(commissionableNet),
    commission,
  };
}

function renderTemplate(template: string, data: Record<string, string>) {
  return (template || '').replace(/\{\{(.*?)\}\}/g, (_m, key) => data[key.trim()] ?? '');
}

function rangeLabel(range: RangeKey, start: Date, end: Date) {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, opts);
  if (start.toDateString() === end.toDateString()) return startStr;
  return `${startStr} - ${endStr}`;
}

function startOfLocalWeek(date: Date) {
  const d = new Date(date);
  const day = d.getDay();
  const diffFromMonday = (day + 6) % 7;
  d.setDate(d.getDate() - diffFromMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfLocalMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function resolveRange(range: RangeKey, customFrom: string, customTo: string) {
  const now = new Date();
  let start = new Date();
  let end = new Date();

  if (range === 'today') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (range === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    start = new Date(y.setHours(0, 0, 0, 0));
    end = new Date(y.setHours(23, 59, 59, 999));
  } else if (range === 'thisWeek') {
    start = startOfLocalWeek(now);
    end.setHours(23, 59, 59, 999);
  } else if (range === 'thisMonth') {
    start = startOfLocalMonth(now);
    end.setHours(23, 59, 59, 999);
  } else if (range === 'last7') {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    start = new Date(s.setHours(0, 0, 0, 0));
    end.setHours(23, 59, 59, 999);
  } else if (range === 'custom') {
    const s = customFrom ? new Date(customFrom) : now;
    const e = customTo ? new Date(customTo) : s;
    start = new Date(s.setHours(0, 0, 0, 0));
    end = new Date(e.setHours(23, 59, 59, 999));
  }

  return { start, end };
}

function resolveAccountingDayRange(batchOutTime?: string, now = new Date()) {
  const [hourText = '21', minuteText = '00'] = String(batchOutTime || '21:00').split(':');
  const hour = Math.min(23, Math.max(0, Number(hourText) || 0));
  const minute = Math.min(59, Math.max(0, Number(minuteText) || 0));
  const nextCutoff = new Date(now);
  nextCutoff.setHours(hour, minute, 0, 0);
  if (now >= nextCutoff) nextCutoff.setDate(nextCutoff.getDate() + 1);
  const start = new Date(nextCutoff);
  start.setDate(start.getDate() - 1);
  const end = new Date(nextCutoff.getTime() - 1);
  return { start, end };
}

function resolveCommissionRange(range: CommissionRangeKey, customFrom: string, customTo: string) {
  const now = new Date();
  let start = new Date();
  let end = new Date();

  if (range === 'currentMonth') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (range === 'previousMonth') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else if (range === 'currentYear') {
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else {
    const s = customFrom ? new Date(customFrom) : now;
    const e = customTo ? new Date(customTo) : s;
    start = new Date(s.setHours(0, 0, 0, 0));
    end = new Date(e.setHours(23, 59, 59, 999));
  }

  return { start, end };
}

function commissionRangeLabel(range: CommissionRangeKey, start: Date, end: Date) {
  if (range === 'currentMonth' || range === 'previousMonth') {
    return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  if (range === 'currentYear') {
    return start.toLocaleDateString(undefined, { year: 'numeric' });
  }
  return rangeLabel('custom', start, end);
}

const DATE_KEYS = [
  'completedAt', 'completedDate', 'completed_on',
  'closedAt', 'closedDate', 'closed_on',
  'finishedAt', 'finishedDate',
  'checkInAt',
  'checkoutDate',
  'repairCompletionDate',
  'clientPickupDate',
  'invoiceDate', 'invoice_date', 'saleDate', 'sale_date', 'transactionDate', 'transaction_date',
  'date', 'dateCreated', 'date_created', 'created', 'createdAt', 'createdDate', 'created_at', 'created_on',
  'updatedAt', 'updatedDate', 'updated_at',
  'timestamp', 'time', 'openedAt', 'openedDate'
];

function parseDateValue(value: any): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const normalized = value > 1e12 ? value : value * 1000;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function extractRecordDate(record: any): Date | null {
  if (!record || typeof record !== 'object') return null;
  for (const key of DATE_KEYS) {
    const date = parseDateValue((record as any)[key]);
    if (date) return date;
  }
  return null;
}

function readNumber(record: any, key: string): number | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const raw = (record as any)[key];
  if (raw === null || raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function resolveTotals(record: any) {
  const totalFields = ['total', 'grandTotal', 'invoiceTotal', 'totalAmount', 'amountTotal', 'totalDue', 'total_due', 'amountDue', 'amount_due', 'balanceDue', 'balance_due', 'balance'];
  const paidFields = ['amountPaid', 'paid', 'totalPaid', 'paidAmount', 'paid_amount', 'collected', 'amountCollected'];
  const remainingFields = ['remaining', 'balance', 'balanceDue', 'balance_due', 'amountDue', 'amount_due', 'due', 'totalDue', 'total_due'];

  let total = totalFields.map(key => readNumber(record, key)).find(val => val !== undefined);
  let paid = paidFields.map(key => readNumber(record, key)).find(val => val !== undefined);
  let remaining = remainingFields.map(key => readNumber(record, key)).find(val => val !== undefined);

  if (total === undefined) {
    const subTotal = ['subTotal', 'subtotal', 'sub_total'].map(key => readNumber(record, key)).find(val => val !== undefined) ?? 0;
    const tax = ['taxTotal', 'tax', 'tax_amount'].map(key => readNumber(record, key)).find(val => val !== undefined) ?? 0;
    if (subTotal || tax) {
      total = subTotal + tax;
    } else {
      const labor = readNumber(record, 'laborCost') ?? readNumber(record, 'labor') ?? readNumber(record, 'laborTotal') ?? 0;
      const parts = readNumber(record, 'partCosts') ?? readNumber(record, 'partCost') ?? readNumber(record, 'partsTotal') ?? readNumber(record, 'parts') ?? 0;
      const discount = readNumber(record, 'discount') ?? readNumber(record, 'laborDiscount') ?? 0;
      const taxRate = readNumber(record, 'taxRate') ?? readNumber(record, 'taxPercent') ?? readNumber(record, 'taxPercentage') ?? 0;
      const amountPaid = paid ?? 0;
      const computed = computeTotals({ laborCost: labor, partCosts: parts, discount, taxRate, amountPaid });
      total = computed.total;
      if (remaining === undefined) remaining = computed.remaining;
    }
  }

  if (paid === undefined && total !== undefined && remaining !== undefined) {
    paid = Math.max(0, (total || 0) - (remaining || 0));
  }
  if (remaining === undefined && total !== undefined && paid !== undefined) {
    remaining = Math.max(0, (total || 0) - (paid || 0));
  }

  const safeTotal = Number.isFinite(total ?? NaN) ? (total as number) : 0;
  const safePaid = Number.isFinite(paid ?? NaN) ? (paid as number) : 0;
  const safeRemaining = Number.isFinite(remaining ?? NaN) ? (remaining as number) : Math.max(0, safeTotal - safePaid);

  return { total: safeTotal, paid: safePaid, remaining: safeRemaining };
}

function paymentAppliedAmount(p: any): number {
  const applied = Number(p?.applied);
  if (Number.isFinite(applied) && applied > 0) return applied;
  const amount = Number(p?.amount ?? p?.tender ?? p?.paid ?? 0);
  const change = Number(p?.change ?? p?.changeDue ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (Number.isFinite(change) && change > 0) return Math.max(0, amount - change);
  return amount;
}

function paymentFallbackDate(record: any): Date | null {
  if (!record || typeof record !== 'object') return null;
  const keys = [
    'checkoutDate',
    'clientPickupDate',
    'repairCompletionDate',
    'completedAt',
    'completedDate',
    'closedAt',
    'closedDate',
    'invoiceDate',
    'invoice_date',
    'saleDate',
    'sale_date',
    'transactionDate',
    'transaction_date',
    'checkInAt',
    'createdAt',
    'createdDate',
  ];
  for (const key of keys) {
    const date = parseDateValue(record?.[key]);
    if (date) return date;
  }
  return null;
}

function collectPayments(record: any) {
  if (!record || typeof record !== 'object') return [];
  const existing = Array.isArray(record.payments)
    ? [...record.payments]
    : Array.isArray(record.paymentHistory)
      ? [...record.paymentHistory]
      : Array.isArray(record.paymentLogs)
        ? [...record.paymentLogs]
        : [];
  const { paid } = resolveTotals(record);
  const recorded = round2(existing.reduce((sum: number, payment: any) => sum + paymentAppliedAmount(payment), 0));
  const missing = round2((Number(paid || 0) || 0) - recorded);
  if (missing <= 0.009) return existing;
  const anchor = paymentFallbackDate(record);
  if (!anchor) return existing;
  return [{
    amount: missing,
    applied: missing,
    paymentType: String(record?.paymentType || 'Legacy'),
    at: anchor.toISOString(),
    inferred: true,
  }, ...existing];
}

function paymentEventDate(p: any): Date | null {
  return parseDateValue(p?.at ?? p?.date ?? p?.createdAt ?? p?.timestamp ?? null);
}

function isDateWithin(value: unknown, startMs: number, endMs: number) {
  const date = value instanceof Date ? value : parseDateValue(value);
  if (!date) return false;
  const ts = date.getTime();
  return ts >= startMs && ts <= endMs;
}

function getTimelineDate(record: any): Date | null {
  const payments = collectPayments(record)
    .map((p: any) => paymentEventDate(p))
    .filter(Boolean) as Date[];
  if (payments.length) {
    payments.sort((a, b) => b.getTime() - a.getTime());
    return payments[0];
  }

  const orderedKeys = [
    'checkoutDate',
    'repairCompletionDate',
    'clientPickupDate',
    'checkInAt',
    'createdAt',
  ];
  for (const key of orderedKeys) {
    const d = parseDateValue(record?.[key]);
    if (d) return d;
  }
  return paymentFallbackDate(record) || extractRecordDate(record);
}

function getSaleReportDate(record: any): Date | null {
  const orderedKeys = [
    'checkoutDate',
    'invoiceDate',
    'invoice_date',
    'saleDate',
    'sale_date',
    'transactionDate',
    'transaction_date',
    'checkInAt',
    'createdAt',
    'createdDate',
  ];
  for (const key of orderedKeys) {
    const d = parseDateValue(record?.[key]);
    if (d) return d;
  }
  return paymentFallbackDate(record) || extractRecordDate(record);
}

function collectedAmountInRange(record: any, startMs: number, endMs: number, fallbackDate?: Date | null): number {
  const payments = collectPayments(record);
  if (payments.length) {
    return round2(payments.reduce((sum: number, p: any) => {
      const d = paymentEventDate(p);
      if (!isDateWithin(d, startMs, endMs)) return sum;
      return sum + paymentAppliedAmount(p);
    }, 0));
  }

  const date = paymentFallbackDate(record);
  if (!isDateWithin(date, startMs, endMs)) return 0;
  const { paid, total } = resolveTotals(record);
  const value = Number(paid || 0) || Number(total || 0) || 0;
  return round2(Math.max(0, value));
}

function latestPaymentDateInRange(record: any, startMs: number, endMs: number): Date | null {
  const dates = collectPayments(record)
    .map((p: any) => paymentEventDate(p))
    .filter((d: Date | null) => isDateWithin(d, startMs, endMs)) as Date[];
  if (!dates.length) return null;
  dates.sort((a, b) => b.getTime() - a.getTime());
  return dates[0];
}

function firstDateInKeys(record: any, keys: string[]): Date | null {
  if (!record || typeof record !== 'object') return null;
  for (const key of keys) {
    const value = parseDateValue((record as any)[key]);
    if (value) return value;
  }
  return null;
}

function computeSaleCommissionInRange(sale: any, startMs: number, endMs: number, commissionRate: number, consultationTechHourlyRate: number) {
  const breakdown = computeSaleBreakdown(sale, commissionRate);
  const net = Number(breakdown.net || 0) || 0;
  const commissionableRatio = net > 0 ? Math.min(1, Math.max(0, (Number(breakdown.commissionableNet || 0) || 0) / net)) : 0;
  const consultationRatio = net > 0 ? Math.min(1, Math.max(0, (Number(breakdown.consultationNet || 0) || 0) / net)) : 0;

  const collected = collectedAmountInRange(sale, startMs, endMs, getTimelineDate(sale));
  if (!(collected > 0)) return null;

  const commissionableCollected = round2(collected * commissionableRatio);
  const consultationCollected = round2(collected * consultationRatio);
  const salesCommission = round2(commissionableCollected * commissionRate);
  const consultationCollectionRatio = Number(breakdown.consultationNet || 0) > 0
    ? Math.min(1, consultationCollected / Number(breakdown.consultationNet || 0))
    : 0;
  const consultationHoursCollected = round2(Number(breakdown.consultationHours || 0) * consultationCollectionRatio);
  const consultationPayout = round2(consultationHoursCollected * consultationTechHourlyRate);
  const commission = round2(salesCommission + consultationPayout);
  const date = latestPaymentDateInRange(sale, startMs, endMs) || getTimelineDate(sale) || new Date(0);

  return {
    sale,
    date,
    collected: round2(collected),
    commissionableCollected,
    consultationCollected,
    consultationHoursCollected,
    salesCommission,
    consultationPayout,
    commission,
    breakdown,
  };
}

function normalizeRow(kind: UnifiedRow['kind'], record: any): UnifiedRow | null {
  if (!record) return null;
  const enriched = kind === 'sale' && record && typeof record === 'object'
    ? {
        ...record,
        partCosts: readNumber(record, 'partCosts') ?? readNumber(record, 'partsTotal') ?? (Array.isArray(record.items)
          ? record.items.reduce((sum: number, item: any) => sum + Number(item?.price ?? 0) * Number(item?.qty ?? 1), 0)
          : 0),
      }
    : record;

  const date = kind === 'sale' ? getSaleReportDate(enriched) : getTimelineDate(enriched);
  if (!date) return null;
  const { total, paid, remaining } = resolveTotals(enriched);
  const payments = collectPayments(enriched);

  const statusRaw = (enriched as any)?.status;
  const status = typeof statusRaw === 'string'
    ? statusRaw
    : (statusRaw === null || statusRaw === undefined ? undefined : String(statusRaw));

  const checkoutRaw = (enriched as any)?.checkoutDate;
  const checkoutDate = typeof checkoutRaw === 'string'
    ? checkoutRaw
    : (checkoutRaw === null || checkoutRaw === undefined ? null : String(checkoutRaw));

  const assignedToRaw = resolveAssignedTechnician(enriched);
  const assignedTo = typeof assignedToRaw === 'string'
    ? assignedToRaw
    : (assignedToRaw === null || assignedToRaw === undefined ? null : String(assignedToRaw));

  const customerNameRaw = (enriched as any)?.customerName
    ?? (enriched as any)?.name
    ?? (enriched as any)?.customer
    ?? [
      (enriched as any)?.firstName,
      (enriched as any)?.lastName,
    ].filter(Boolean).join(' ').trim();
  const customerName = typeof customerNameRaw === 'string' && customerNameRaw.trim() ? customerNameRaw.trim() : undefined;

  const titleRaw = kind === 'work'
    ? ((enriched as any)?.productCategory || (enriched as any)?.productDescription || (enriched as any)?.summary || '').toString()
    : (() => {
        const items = Array.isArray((enriched as any)?.items) ? (enriched as any).items : [];
        const first = items.find((it: any) => (it?.description || '').toString().trim());
        return (first?.description || (enriched as any)?.itemDescription || '').toString();
      })();
  const title = titleRaw && titleRaw.trim() ? titleRaw.trim() : undefined;

  const diagnosticLike = kind === 'work' && Array.isArray((enriched as any)?.items)
    ? (enriched as any).items.some((it: any) => /diagnos/i.test((it?.description || '').toString()))
    : false;
  const id = enriched?.id
    ?? enriched?.ticketNumber
    ?? enriched?.ticketNo
    ?? enriched?.invoiceNumber
    ?? enriched?.invoiceNo
    ?? enriched?.uuid
    ?? enriched?.guid
    ?? enriched?.workorderId
    ?? `${kind}-${date.getTime()}`;

  return {
    kind,
    id,
    date,
    total,
    paid,
    remaining,
    payments,
    status,
    checkoutDate,
    assignedTo,
    customerName,
    title,
    diagnosticLike,
  };
}

type UnifiedRow = {
  kind: 'work' | 'sale';
  id: any;
  date: Date;
  total: number;
  paid: number;
  remaining: number;
  payments: any[];
  status?: string;
  checkoutDate?: string | null;
  assignedTo?: string | null;
  customerName?: string;
  title?: string;
  diagnosticLike?: boolean;
};

function recordLineItems(record: any): string {
  const items = Array.isArray(record?.items) ? record.items : [];
  const labels = items
    .map((item: any) => String(item?.description || item?.repair || item?.name || item?.itemDescription || '').trim())
    .filter(Boolean);
  return labels.length ? labels.join(', ') : 'No line items recorded';
}

function recordDeviceName(record: any): string {
  return String(
    record?.deviceName
    || record?.deviceModel
    || record?.productDescription
    || record?.productCategory
    || record?.deviceType
    || ''
  ).trim() || 'Device not recorded';
}

function hasRepairCompleteUpdate(record: any): boolean {
  const update = String(record?.statusUpdate || '').trim();
  const repairStatus = String(record?.repairStatus || '').trim();
  return /^repair complete$/i.test(update) || /^(complete|completed|repair complete)$/i.test(repairStatus);
}

function cartPaymentLabel(row: OrderCartRow) {
  if (row.paymentStatus === 'not_required') return 'Shop purchase';
  if (row.paymentStatus === 'paid') return 'Paid';
  if (row.paymentStatus === 'partial') return 'Warning: partial payment';
  if (row.paymentStatus === 'unpaid') return 'Warning: payment not taken';
  return 'Verify payment';
}

function cartPaymentClass(row: OrderCartRow) {
  if (row.paymentStatus === 'not_required') return 'text-sky-200 border-sky-700 bg-sky-950/40';
  if (row.paymentStatus === 'paid') return 'text-[#39FF14] border-[#39FF14]/30 bg-[#39FF14]/10';
  if (row.paymentStatus === 'unpaid') return 'text-red-200 border-red-700 bg-red-950/40';
  return 'text-amber-200 border-amber-600/50 bg-amber-950/30';
}

const EODWindow: React.FC = () => {
  const isCartLayoutPreview = Boolean((import.meta as any).env?.DEV) && new URLSearchParams(window.location.search).get('cartPreview') === '1';
  const [reportDayKey, setReportDayKey] = useState(() => new Date().toDateString());
  const [savedSettings, setSavedSettings] = useState<EodSettings>(defaultSettings);
  const [draftSettings, setDraftSettings] = useState<EodSettings>(defaultSettings);
  const [commissionSettings, setCommissionSettings] = useState<CommissionSettings>(DEFAULT_COMMISSION_SETTINGS);
  const [workOrders, setWorkOrders] = useState<any[]>([]);
  const [sales, setSales] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<any[]>([]);
  const [inventoryProducts, setInventoryProducts] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
  const [shopSettingsRecord, setShopSettingsRecord] = useState<any>({});
  const [cloverTotalDraft, setCloverTotalDraft] = useState('');
  const [cloverSaving, setCloverSaving] = useState(false);
  const [selectedPurchaseRows, setSelectedPurchaseRows] = useState<Set<string>>(() => new Set());
  const [cartRefreshBusy, setCartRefreshBusy] = useState(false);
  const [cartPriceReview, setCartPriceReview] = useState<Array<{ key: string; title: string; previousUnitCost: number; nextUnitCost: number }> | null>(null);
  const [selectingDistributors, setSelectingDistributors] = useState<Set<string>>(() => new Set());
  const [deleteCandidateRows, setDeleteCandidateRows] = useState<OrderCartRow[] | null>(null);
  const [checkoutCandidateRows, setCheckoutCandidateRows] = useState<OrderCartRow[] | null>(null);
  const [sendCartClientUpdateEnabled, setSendCartClientUpdateEnabled] = useState(false);
  const [useHistoricalOrderDate, setUseHistoricalOrderDate] = useState(false);
  const [historicalOrderDate, setHistoricalOrderDate] = useState('');
  const [previewDeletedPurchaseKeys, setPreviewDeletedPurchaseKeys] = useState<Set<string>>(() => new Set());
  const [quantityOverrides, setQuantityOverrides] = useState<Record<string, string>>({});
  const [deliveryByDistributor, setDeliveryByDistributor] = useState<Record<string, string>>({});
  const [deliveryByRow, setDeliveryByRow] = useState<Record<string, string>>({});
  const [splitDeliveryByDistributor, setSplitDeliveryByDistributor] = useState<Record<string, boolean>>({});
  const [purchaseUpdateBusy, setPurchaseUpdateBusy] = useState(false);
  const [purchaseUpdateMessage, setPurchaseUpdateMessage] = useState('');
  const [additionalCostsByDistributor, setAdditionalCostsByDistributor] = useState<Record<string, string>>({});
  const [taxExemptByDistributor, setTaxExemptByDistributor] = useState<Record<string, boolean>>({});
  const [showCart, setShowCart] = useState(() => consumeWindowPayload('eod')?.showCart === true);
  const [showAddPurchase, setShowAddPurchase] = useState(false);
  const [showCheckoutVerification, setShowCheckoutVerification] = useState(false);
  const [verifiedDistributors, setVerifiedDistributors] = useState<Set<string>>(() => new Set());
  const [purchaseDraft, setPurchaseDraft] = useState<any>({ itemType: 'Part', orderUrl: '', title: '', distributor: '', quantity: 1, unitCost: '' });
  const [purchaseDraftBusy, setPurchaseDraftBusy] = useState(false);
  const [selectedLowStockItem, setSelectedLowStockItem] = useState<any | null>(null);
  const [lowStockBusy, setLowStockBusy] = useState(false);
  const [lowStockMessage, setLowStockMessage] = useState('');
  const [deliveryBusyId, setDeliveryBusyId] = useState<number | null>(null);
  const [deliveryMessage, setDeliveryMessage] = useState('');
  const [previewLowStockCartIds, setPreviewLowStockCartIds] = useState<Set<number>>(() => new Set());
  const [lowStockDismissals, setLowStockDismissals] = useState<Record<string, string>>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOW_STOCK_DISMISSALS_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });
  const range = useMemo<RangeKey>(() => 'today', []);
  const customFrom = '';
  const customTo = '';
  const [loadingData, setLoadingData] = useState(true);
  const [settingsReady, setSettingsReady] = useState(false);
  const [batchInfo, setBatchInfo] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [viewMode, setViewMode] = useState<'reports' | 'trends'>('reports');
  const [showCommissionPanel, setShowCommissionPanel] = useState(false);
  const [showEmailSettings, setShowEmailSettings] = useState(false);
  const [showBatchSettings, setShowBatchSettings] = useState(false);
  const [batchSettingsDraft, setBatchSettingsDraft] = useState(() => ({
    schedule: defaultSettings.schedule,
    sendTime: defaultSettings.sendTime,
    batchOutTime: defaultSettings.batchOutTime || '21:00',
  }));
  const [commissionRange, setCommissionRange] = useState<CommissionRangeKey>('currentMonth');
  const [commissionCustomFrom, setCommissionCustomFrom] = useState('');
  const [commissionCustomTo, setCommissionCustomTo] = useState('');
  const ticketContext = useContextMenu<UnifiedRow>();
  const [closeTicketCandidate, setCloseTicketCandidate] = useState<UnifiedRow | null>(null);
  const [closingTicket, setClosingTicket] = useState(false);
  const [ticketActionMessage, setTicketActionMessage] = useState('');

  const [technicians, setTechnicians] = useState<any[]>([]);
  const [techSummary, setTechSummary] = useState<string>('');

  useEffect(() => {
    if (!showCart) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [showCart]);

  useEffect(() => {
    const refreshClock = async () => {
      const nextDayKey = new Date().toDateString();
      setReportDayKey(current => current === nextDayKey ? current : nextDayKey);
      try {
        const info = await (window as any).api?.getBatchOutInfo?.();
        if (info) setBatchInfo(info);
      } catch {
        // The next scheduler tick or window reopen will retry.
      }
    };
    const timer = window.setInterval(() => { void refreshClock(); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    async function refresh() {
      if (!(window as any).api?.dbGet) {
        if (!disposed) setTechnicians([]);
        return;
      }
      try {
        const list = await listTechnicians();
        if (!disposed) setTechnicians(Array.isArray(list) ? list : []);
      } catch (e) {
        console.error('Failed loading technicians', e);
      }
    }
    refresh();
    const off = (window as any).api?.onTechniciansChanged?.(() => refresh());
    return () => { disposed = true; try { off && off(); } catch {} };
  }, []);

  const technicianOptions = useMemo(() => {
    return (technicians || []).filter((t: any) => t && (t.active !== false)).map((t: any) => {
      const value = technicianDisplayName(t);
      const label = technicianDisplayName(t);
      return { value, label };
    });
  }, [technicians]);

  const techAliasToCanonical = useMemo(() => {
    const map = new Map<string, string>();
    const labelMap = new Map<string, string>();

    for (const t of (technicians || [])) {
      if (!t || (t.active === false)) continue;
      const canonicalDisplay = technicianDisplayName(t);
      const canonicalKey = normalizeTechKey(canonicalDisplay);
      const fullName = [t.firstName, t.lastName].filter(Boolean).join(' ').trim();
      const label = technicianDisplayName(t);

      labelMap.set(canonicalKey, label);

      const aliases = new Set<string>();
      aliases.add(canonicalDisplay);
      if (t.id) aliases.add(String(t.id));
      if (t.nickname) aliases.add(String(t.nickname));
      if (t.firstName) aliases.add(String(t.firstName));
      if (fullName) aliases.add(fullName);
      if (fullName) aliases.add(fullName.split(' ')[0]);

      for (const a of aliases) {
        const k = normalizeTechKey(a);
        if (!k) continue;
        map.set(k, canonicalKey);
      }
    }

    return { map, labelMap };
  }, [technicians]);

  const canonicalizeAssignedTo = (raw: any): string => {
    const k = normalizeTechKey(raw);
    if (!k) return '';
    return techAliasToCanonical.map.get(k) || k;
  };

  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        setLoadingData(true);
        const api = (window as any).api ?? {};
        const woPromise = api.getWorkOrders
          ? api.getWorkOrders().catch(() => [])
          : api.dbGet
            ? api.dbGet('workOrders').catch(() => [])
            : Promise.resolve([]);
        const saPromise = api.getSales
          ? api.getSales().catch(() => [])
          : api.dbGet
            ? api.dbGet('sales').catch(() => [])
            : Promise.resolve([]);
        const settingsPromise = api.dbGet ? api.dbGet('eodSettings').catch(() => []) : Promise.resolve([]);
        const shopSettingsPromise = api.dbGet ? api.dbGet('settings').catch(() => []) : Promise.resolve([]);
        const customersPromise = api.dbGet ? api.dbGet('customers').catch(() => []) : Promise.resolve([]);
        const purchaseOrdersPromise = api.dbGet ? api.dbGet('purchaseOrders').catch(() => []) : Promise.resolve([]);
        const productsPromise = api.dbGet ? api.dbGet('products').catch(() => []) : Promise.resolve([]);
        const vendorsPromise = api.dbGet ? api.dbGet('vendors').catch(() => []) : Promise.resolve([]);
        const calendarPromise = api.dbGet ? api.dbGet('calendarEvents').catch(() => []) : Promise.resolve([]);
        const batchPromise = api.getBatchOutInfo
          ? api.getBatchOutInfo().catch(() => null)
          : api.dbGet
            ? api.dbGet('batchInfo').catch(() => null)
            : Promise.resolve(null);

        const [wo, sa, stored, shopSettingsRows, batch, customerRows, purchaseRows, productRows, vendorRows, calendarRows] = await Promise.all([woPromise, saPromise, settingsPromise, shopSettingsPromise, batchPromise, customersPromise, purchaseOrdersPromise, productsPromise, vendorsPromise, calendarPromise]);
        if (disposed) return;

        setWorkOrders(Array.isArray(wo) ? wo : []);
        setSales(Array.isArray(sa) ? sa : []);
        setCustomers(Array.isArray(customerRows) ? customerRows : []);
        setPurchaseOrders(Array.isArray(purchaseRows) ? purchaseRows : []);
        setInventoryProducts(Array.isArray(productRows) ? productRows : []);
        setVendors(Array.isArray(vendorRows) ? vendorRows : []);
        setCalendarEvents(Array.isArray(calendarRows) ? calendarRows : []);

        const storedSettings = Array.isArray(stored) ? stored[0] : stored;
        if (storedSettings && typeof storedSettings === 'object') {
          setSavedSettings(prev => ({ ...prev, ...storedSettings }));
          setDraftSettings(prev => ({ ...prev, ...storedSettings }));
        }
        const shopSettings = Array.isArray(shopSettingsRows) ? shopSettingsRows[0] : shopSettingsRows;
        setShopSettingsRecord(shopSettings && typeof shopSettings === 'object' ? shopSettings : {});
        setCommissionSettings(normalizeCommissionSettings(shopSettings?.commissionSettings));

        const batchRecord = Array.isArray(batch) ? batch[0] : batch;
        setBatchInfo(batchRecord || null);
        setSettingsReady(true);
      } catch (err) {
        console.error('Failed to load EOD data', err);
        if (!disposed) setSettingsReady(true);
      } finally {
        if (!disposed) setLoadingData(false);
      }
    }
    load();
    const api = (window as any).api || {};
    const offPurchases = api.onPurchaseOrdersChanged?.(() => load());
    const offProducts = api.onProductsChanged?.(() => load());
    const offWorkOrders = api.onWorkOrdersChanged?.(() => load());
    const offSales = api.onSalesChanged?.(() => load());
    const offSettings = api.onSettingsChanged?.(() => load());
    const offCalendar = api.onCalendarEventsChanged?.(() => load());
    return () => {
      disposed = true;
      try { offPurchases?.(); } catch {}
      try { offProducts?.(); } catch {}
      try { offWorkOrders?.(); } catch {}
      try { offSales?.(); } catch {}
      try { offSettings?.(); } catch {}
      try { offCalendar?.(); } catch {}
    };
  }, []);

  const cloverDayKey = useMemo(() => { const today = new Date(); return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`; }, [reportDayKey]);
  const savedCloverTotal = shopSettingsRecord?.cloverDailyTotals?.[cloverDayKey];

  useEffect(() => {
    setCloverTotalDraft(savedCloverTotal == null || savedCloverTotal === '' ? '' : String(savedCloverTotal));
  }, [cloverDayKey, savedCloverTotal]);

  const saveCloverTotal = async () => {
    const parsed = Number(cloverTotalDraft);
    if (!Number.isFinite(parsed) || parsed < 0) { window.alert('Enter the Clover total as a non-negative amount.'); return; }
    const api: any = (window as any).api || {};
    const updated = { ...shopSettingsRecord, cloverDailyTotals: { ...(shopSettingsRecord?.cloverDailyTotals || {}), [cloverDayKey]: Math.round(parsed * 100) / 100 }, updatedAt: new Date().toISOString() };
    setCloverSaving(true);
    try {
      const saved = updated.id ? await api.dbUpdate?.('settings', updated.id, updated) : await api.dbAdd?.('settings', updated);
      setShopSettingsRecord(saved || updated);
    } catch (error) { console.error('Failed to save Clover reconciliation total', error); window.alert('Clover total could not be saved.'); }
    finally { setCloverSaving(false); }
  };

  const settingsPayload = useMemo(() => ({ ...savedSettings }), [savedSettings]);

  useAutosave(settingsPayload, async payload => {
    if (!settingsReady) return;
    const api = (window as any).api;
    if (!api) return;
    try {
      if (payload.id && api.dbUpdate) {
        await api.dbUpdate('eodSettings', payload.id, payload);
      } else if (!payload.id && api.dbAdd) {
        const created = await api.dbAdd('eodSettings', payload);
        if (created?.id) {
          setSavedSettings(s => ({ ...s, id: created.id }));
        }
      }
    } catch (err) {
      console.error('Failed to save EOD settings', err);
    }
  }, { enabled: settingsReady, debounceMs: 1000, equals: Object.is });

  const { start, end } = useMemo(
    () => range === 'today'
      ? resolveAccountingDayRange(savedSettings.batchOutTime)
      : resolveRange(range, customFrom, customTo),
    [range, customFrom, customTo, reportDayKey, savedSettings.batchOutTime],
  );
  const rangeKey = `${start.getTime()}-${end.getTime()}`;
  const { start: commissionStart, end: commissionEnd } = useMemo(
    () => resolveCommissionRange(commissionRange, commissionCustomFrom, commissionCustomTo),
    [commissionRange, commissionCustomFrom, commissionCustomTo],
  );
  const commissionRangeKey = `${commissionStart.getTime()}-${commissionEnd.getTime()}`;
  const commissionLabel = useMemo(
    () => commissionRangeLabel(commissionRange, commissionStart, commissionEnd),
    [commissionRange, commissionStart, commissionEnd],
  );

  const unified = useMemo(() => {
    const rows: UnifiedRow[] = [];
    const min = start.getTime();
    const max = end.getTime();
    const push = (kind: UnifiedRow['kind'], record: any) => {
      const normalized = normalizeRow(kind, record);
      if (!normalized) return;
      const ts = normalized.date.getTime();
      const hasPaymentInRange = collectedAmountInRange(normalized, min, max, normalized.date) > 0.009;
      if ((ts < min || ts > max) && !hasPaymentInRange) return;
      rows.push(normalized);
    };

    (workOrders || []).forEach(wo => push('work', wo));
    (sales || []).forEach(sa => push('sale', sa));

    rows.sort((a, b) => a.date.getTime() - b.date.getTime());
    return rows;
  }, [workOrders, sales, rangeKey]);

  const accountingLedger = useMemo(() => {
    const min = start.getTime();
    const max = end.getTime();
    return buildReportingLedger([
      ...(workOrders || []).map(record => ({ ...record, kind: 'repair' as const })),
      ...(sales || []).map(record => ({ ...record, kind: 'sale' as const })),
    ]).filter(entry => entry.date.getTime() >= min && entry.date.getTime() <= max);
  }, [workOrders, sales, rangeKey]);

  const trendRows = useMemo(() => {
    const rows: UnifiedRow[] = [];
    (workOrders || []).forEach(wo => {
      const normalized = normalizeRow('work', wo);
      if (normalized) rows.push(normalized);
    });
    (sales || []).forEach(sa => {
      const normalized = normalizeRow('sale', sa);
      if (normalized) rows.push(normalized);
    });
    rows.sort((a, b) => a.date.getTime() - b.date.getTime());
    return rows;
  }, [workOrders, sales]);

  const summary = useMemo(() => {
    const min = start.getTime();
    const max = end.getTime();
    const wo = { count: 0, billed: 0, collected: 0, remaining: 0 };
    const sa = { count: 0, billed: 0, collected: 0, remaining: 0 };
    unified.forEach(row => {
      const bucket = row.kind === 'work' ? wo : sa;
      const collected = collectedAmountInRange(row, min, max, row.date);
      bucket.count += 1;
      bucket.billed += Number(row.total || 0) || 0;
      bucket.collected += collected;
      bucket.remaining += row.remaining;
    });
    const grandBilled = wo.billed + sa.billed;
    const grandCollected = wo.collected + sa.collected;
    const grandRemaining = wo.remaining + sa.remaining;
    return { woTotals: wo, saTotals: sa, grandBilled, grandCollected, grandRemaining };
  }, [unified, rangeKey]);

  const COMMISSION_RATE = commissionSettings.salesCommissionPercent / 100;

  const salesCommissionInRange = useMemo(() => {
    const min = commissionStart.getTime();
    const max = commissionEnd.getTime();
    const rows = (sales || []).map(sa => computeSaleCommissionInRange(sa, min, max, COMMISSION_RATE, commissionSettings.consultationTechHourlyRate)).filter(Boolean) as Array<{
      sale: any;
      date: Date;
      collected: number;
      commissionableCollected: number;
      consultationCollected: number;
      consultationHoursCollected: number;
      salesCommission: number;
      consultationPayout: number;
      commission: number;
      breakdown: ReturnType<typeof computeSaleBreakdown>;
    }>;
    rows.sort((a, b) => b.date.getTime() - a.date.getTime());
    return rows;
  }, [sales, commissionRangeKey, commissionSettings]);

  const salesCategoryTotals = useMemo(() => {
    const map = new Map<string, { count: number; collected: number; commissionableCollected: number; consultationCollected: number; consultationPayout: number }>();
    for (const row of salesCommissionInRange) {
      const net = Number(row.breakdown?.net || 0) || 0;
      if (!(net > 0)) continue;
      for (const [cat, catNet] of row.breakdown.byCategoryNet.entries()) {
        if (!(catNet > 0)) continue;
        const share = catNet / net;
        const collectedPortion = row.collected * share;
        const commissionablePortion = row.commissionableCollected * share;
        const consultationPortion = row.consultationCollected * share;
        const prev = map.get(cat) || { count: 0, collected: 0, commissionableCollected: 0, consultationCollected: 0, consultationPayout: 0 };
        prev.count += 1;
        prev.collected += collectedPortion;
        if (isConsultationCategory(cat)) {
          prev.consultationCollected += consultationPortion || collectedPortion;
          prev.consultationPayout += row.consultationPayout;
        } else {
          prev.commissionableCollected += commissionablePortion || collectedPortion;
        }
        map.set(cat, prev);
      }
    }
    const rows = Array.from(map.entries()).map(([category, v]) => ({
      category,
      count: v.count,
      collected: round2(v.collected),
      commissionableCollected: round2(v.commissionableCollected),
      consultationCollected: round2(v.consultationCollected),
      consultationPayout: round2(v.consultationPayout),
    }));
    rows.sort((a, b) => b.collected - a.collected);
    return rows;
  }, [salesCommissionInRange, commissionSettings.consultationTechHourlyRate]);

  const commissionSummary = useMemo(() => {
    let commissionableNet = 0;
    let salesCommission = 0;
    let consultationNet = 0;
    let consultationPayout = 0;
    for (const row of salesCommissionInRange) {
      commissionableNet += row.commissionableCollected;
      consultationNet += row.consultationCollected;
      salesCommission += row.salesCommission;
      consultationPayout += row.consultationPayout;
    }
    return {
      commissionableNet: round2(commissionableNet),
      consultationNet: round2(consultationNet),
      salesCommission: round2(salesCommission),
      consultationPayout: round2(consultationPayout),
      commission: round2(salesCommission + consultationPayout),
    };
  }, [salesCommissionInRange]);

  const commissionByTechnician = useMemo(() => {
    const map = new Map<string, { salesCount: number; commissionableNet: number; salesCommission: number; consultationPayout: number; commission: number }>();
    const splitTechnicians = selectedSalesCommissionTechnicians(technicians, commissionSettings);
    const splitKeys = splitTechnicians.map((tech: any) => canonicalizeAssignedTo(technicianCommissionId(tech))).filter(Boolean);
    for (const row of salesCommissionInRange) {
      if (row.salesCommission > 0 && splitKeys.length) {
        const commissionShares = allocateCommissionPool(row.salesCommission, splitKeys.length);
        const perTechBase = round2(row.commissionableCollected / splitKeys.length);
        splitKeys.forEach((tech, index) => {
          const prev = map.get(tech) || { salesCount: 0, commissionableNet: 0, salesCommission: 0, consultationPayout: 0, commission: 0 };
          const exactShare = commissionShares[index] || 0;
          prev.salesCount += 1;
          prev.commissionableNet += perTechBase;
          prev.salesCommission += exactShare;
          prev.commission += exactShare;
          map.set(tech, prev);
        });
      }
      if (row.consultationPayout > 0) {
        const tech = canonicalizeAssignedTo(resolveAssignedTechnician(row.sale)) || 'unassigned';
        const prev = map.get(tech) || { salesCount: 0, commissionableNet: 0, salesCommission: 0, consultationPayout: 0, commission: 0 };
        prev.consultationPayout += row.consultationPayout;
        prev.commission += row.consultationPayout;
        map.set(tech, prev);
      }
    }
    return map;
  }, [salesCommissionInRange, techAliasToCanonical, technicians, commissionSettings]);

  const technicianOperationalRows = useMemo(() => {
    const min = start.getTime();
    const max = end.getTime();
    const map = new Map<string, {
      workOrders: number;
      sales: number;
      checkedOut: number;
      partialPaid: number;
      billed: number;
      collected: number;
      remaining: number;
    }>();

    for (const row of unified) {
      const tech = canonicalizeAssignedTo(row.assignedTo);
      if (!tech) continue;
      const prev = map.get(tech) || {
        workOrders: 0,
        sales: 0,
        checkedOut: 0,
        partialPaid: 0,
        billed: 0,
        collected: 0,
        remaining: 0,
      };

      if (row.kind === 'work') prev.workOrders += 1;
      else prev.sales += 1;

      const collected = collectedAmountInRange(row, min, max, row.date);
      const status = (row.status || '').toLowerCase();
      const checkedOut = !!row.checkoutDate || status === 'closed';
      const partialPaid = Number(row.paid || 0) > 0.01 && Number(row.remaining || 0) > 0.01;

      if (checkedOut) prev.checkedOut += 1;
      if (partialPaid) prev.partialPaid += 1;

      prev.billed += Number(row.total || 0) || 0;
      prev.collected += collected;
      prev.remaining += Number(row.remaining || 0) || 0;
      map.set(tech, prev);
    }

    return Array.from(map.entries()).map(([tech, value]) => ({
      tech,
      workOrders: value.workOrders,
      sales: value.sales,
      checkedOut: value.checkedOut,
      partialPaid: value.partialPaid,
      billed: round2(value.billed),
      collected: round2(value.collected),
      remaining: round2(value.remaining),
    })).sort((a, b) => b.collected - a.collected);
  }, [unified, rangeKey, techAliasToCanonical]);

  const technicianCommissionRows = useMemo(() => {
    const rows = Array.from(commissionByTechnician.entries()).map(([tech, v]) => ({
      tech,
      salesCount: v.salesCount,
      commissionableNet: round2(v.commissionableNet),
      salesCommission: round2(v.salesCommission),
      consultationPayout: round2(v.consultationPayout),
      commission: round2(v.commission),
    }));
    rows.sort((a, b) => b.commission - a.commission);
    return rows;
  }, [commissionByTechnician]);

  const technicianSummaryRows = useMemo(() => {
    const operationalMap = new Map(technicianOperationalRows.map(row => [row.tech, row]));
    const commissionMap = new Map(technicianCommissionRows.map(row => [row.tech, row]));
    const keys = new Set<string>([
      ...Array.from(operationalMap.keys()),
      ...Array.from(commissionMap.keys()),
    ]);

    const rows = Array.from(keys).map((tech) => {
      const operational = operationalMap.get(tech);
      const commission = commissionMap.get(tech);
      return {
        tech,
        workOrders: operational?.workOrders || 0,
        sales: operational?.sales || 0,
        commissionSales: commission?.salesCount || 0,
        checkedOut: operational?.checkedOut || 0,
        partialPaid: operational?.partialPaid || 0,
        billed: operational?.billed || 0,
        collected: operational?.collected || 0,
        remaining: operational?.remaining || 0,
        commissionableNet: commission?.commissionableNet || 0,
        consultationPayout: commission?.consultationPayout || 0,
        commission: commission?.commission || 0,
      };
    });
    rows.sort((a, b) => (b.collected + b.commission) - (a.collected + a.commission));
    return rows;
  }, [technicianOperationalRows, technicianCommissionRows]);

  const techSummaryKey = useMemo(() => normalizeTechKey(techSummary), [techSummary]);

  const techSummarySales = useMemo(() => {
    if (!techSummaryKey) return [] as Array<{ id: any; date: Date; title: string; totalNet: number; salesCommission: number; consultationPayout: number; commission: number }>;
    const rows: Array<{ id: any; date: Date; title: string; totalNet: number; salesCommission: number; consultationPayout: number; commission: number }> = [];
    for (const row of salesCommissionInRange) {
      const sa = row.sale;
      if (canonicalizeAssignedTo(resolveAssignedTechnician(sa)) !== techSummaryKey) continue;
      const items = normalizeSaleItems(sa);
      const title = (items.find(it => (it.description || '').trim())?.description || sa?.itemDescription || 'Sale').toString();
      rows.push({ id: sa?.id, date: row.date, title, totalNet: row.collected, salesCommission: row.salesCommission, consultationPayout: row.consultationPayout, commission: row.commission });
    }
    rows.sort((a, b) => b.date.getTime() - a.date.getTime());
    return rows;
  }, [salesCommissionInRange, techSummaryKey, techAliasToCanonical]);

  const techSummaryWorkOrders = useMemo(() => {
    if (!techSummaryKey) return [] as UnifiedRow[];
    const rows = unified.filter(r => r.kind === 'work' && canonicalizeAssignedTo(r.assignedTo) === techSummaryKey);
    rows.sort((a, b) => b.date.getTime() - a.date.getTime());
    return rows;
  }, [unified, techSummaryKey, techAliasToCanonical]);

  const techSummaryOperational = useMemo(() => {
    if (!techSummaryKey) return null;
    return technicianSummaryRows.find(row => row.tech === techSummaryKey) || null;
  }, [techSummaryKey, technicianSummaryRows]);

  const techSummaryTotals = useMemo(() => {
    if (!techSummaryKey) return null;
    const salesCount = techSummarySales.length;
    const salesNet = round2(techSummarySales.reduce((sum, r) => sum + (Number(r.totalNet) || 0), 0));
    const salesCommission = round2(techSummarySales.reduce((sum, r) => sum + (Number(r.salesCommission) || 0), 0));
    const consultationPayout = round2(techSummarySales.reduce((sum, r) => sum + (Number(r.consultationPayout) || 0), 0));
    const commission = round2(techSummarySales.reduce((sum, r) => sum + (Number(r.commission) || 0), 0));
    const workCount = techSummaryWorkOrders.length;
    const workTotal = round2(techSummaryWorkOrders.reduce((sum, r) => sum + (Number(r.total) || 0), 0));
    return {
      salesCount,
      salesNet,
      salesCommission,
      consultationPayout,
      commission,
      workCount,
      workTotal,
      checkedOut: techSummaryOperational?.checkedOut || 0,
      partialPaid: techSummaryOperational?.partialPaid || 0,
      collected: techSummaryOperational?.collected || 0,
      remaining: techSummaryOperational?.remaining || 0,
      billed: techSummaryOperational?.billed || 0,
    };
  }, [techSummaryKey, techSummaryOperational, techSummarySales, techSummaryWorkOrders]);

  const paymentSummary = useMemo(() => {
    const min = start.getTime();
    const max = end.getTime();
    let cashTender = 0;
    let cashChange = 0;
    let cashNet = 0;
    let card = 0;
    let other = 0;
    let paymentsCount = 0;

    const addPayment = (p: any) => {
      const d = paymentEventDate(p);
      if (!isDateWithin(d, min, max)) return;
      const applied = paymentAppliedAmount(p);
      if (!(applied > 0)) return;
      const tender = Number(p?.amount ?? p?.tender ?? p?.paid ?? 0);
      const change = Math.max(0, Number(p?.change ?? p?.changeDue ?? 0) || 0);
      const type = (p?.paymentType || p?.method || '').toString().toLowerCase();
      if (type.includes('cash')) {
        cashTender += Number.isFinite(tender) && tender > 0 ? tender : applied + change;
        cashChange += change;
        cashNet += applied;
      } else if (type.includes('card') || type.includes('credit') || type.includes('debit')) {
        card += applied;
      } else {
        other += applied;
      }
      paymentsCount += 1;
    };

    const rawRecords = [...(workOrders || []), ...(sales || [])];
    rawRecords.forEach(row => {
      const payments = collectPayments(row);
      payments.forEach(addPayment);
      if (!payments.length) {
        const fallback = getTimelineDate(row);
        const collected = collectedAmountInRange(row, min, max, fallback);
        const anchor = paymentFallbackDate(row) || fallback;
        if (collected > 0) addPayment({ amount: collected, paymentType: String((row as any)?.paymentType || 'unknown'), change: 0, at: anchor });
      }
    });

    return { cashTender, cashChange, cashNet, card, other, paymentsCount };
  }, [workOrders, sales, start, end]);

  const dailyBatchSummary = useMemo(() => {
    const min = start.getTime();
    const max = end.getTime();
    const cardTotal = round2(paymentSummary.card + paymentSummary.other);
    const cashTotal = round2(paymentSummary.cashNet);
    const totalTaken = round2(cardTotal + cashTotal);
    const repairLedger = accountingLedger.filter(entry => entry.kind === 'repair');
    const saleLedger = accountingLedger.filter(entry => entry.kind === 'sale');
    const partsSold = round2(repairLedger.reduce((sum, entry) => sum + entry.partsCharged, 0));
    const partsCost = round2(repairLedger.reduce((sum, entry) => sum + entry.internalCost, 0));
    const laborSold = round2(repairLedger.reduce((sum, entry) => sum + entry.laborCharged, 0));
    const productsSold = round2(saleLedger.reduce((sum, entry) => sum + entry.partsCharged, 0));
    const productsCost = round2(saleLedger.reduce((sum, entry) => sum + entry.internalCost, 0));
    const verifiedPurchasesInRange = (purchaseOrders || []).filter((purchase) => purchase?.status === 'checked_out' && isDateWithin(purchase?.checkedOutAt || purchase?.updatedAt, min, max));
    const supplierSpendParts = round2(verifiedPurchasesInRange
      .filter((purchase) => String(purchase?.itemType || 'Part').toLowerCase() === 'part')
      .reduce((sum, purchase) => sum + (Number(purchase?.totalCost) || (Number(purchase?.itemCost) || 0) + (Number(purchase?.additionalCost) || 0)), 0));
    const supplierSpendProducts = round2(verifiedPurchasesInRange
      .filter((purchase) => String(purchase?.itemType || '').toLowerCase() === 'product')
      .reduce((sum, purchase) => sum + (Number(purchase?.totalCost) || (Number(purchase?.itemCost) || 0) + (Number(purchase?.additionalCost) || 0)), 0));

    const checkInCount = (workOrders || []).reduce((count, workOrder) => {
      const checkInDate = firstDateInKeys(workOrder, ['checkInAt', 'checkInDate', 'check_in_at', 'createdAt', 'createdDate']);
      return isDateWithin(checkInDate, min, max) ? count + 1 : count;
    }, 0);

    const closedTicketCount = (workOrders || []).reduce((count, workOrder) => {
      const status = String(workOrder?.status || '').trim().toLowerCase();
      if (status !== 'closed') return count;
      const closedDate = firstDateInKeys(workOrder, [
        'checkoutDate',
        'closedAt',
        'closedDate',
        'closed_on',
        'clientPickupDate',
        'repairCompletionDate',
        'completedAt',
        'completedDate',
        'finishedAt',
        'finishedDate',
      ]) || getTimelineDate(workOrder);
      return isDateWithin(closedDate, min, max) ? count + 1 : count;
    }, 0);

    return {
      totalTaken,
      cardTotal,
      cashTotal,
      partsSold,
      partsCost,
      laborSold,
      productsSold,
      productsCost,
      supplierSpendParts,
      supplierSpendProducts,
      checkInCount,
      closedTicketCount,
    };
  }, [accountingLedger, end, paymentSummary.card, paymentSummary.cashNet, paymentSummary.other, purchaseOrders, start, workOrders]);

  const partsPurchaseQueue = useMemo(
    () => {
      const rows = isCartLayoutPreview
      ? collectOrderCartRows([
          { id: -101, customerName: 'Preview Client', taxRate: 8, payments: [{ applied: 193.8, appliedParts: 118.8 }], items: [{ id: 'preview-screen', repair: 'iPhone 15 Pro OLED Assembly', qty: 1, parts: 110, internalCost: 82.45, distributor: 'Phone LCD Parts', orderSourceUrl: 'https://www.phonelcdparts.com/example-screen', requiresOrder: true, orderStatus: 'needed' }] },
          { id: -102, customerName: 'Preview Client', taxRate: 8, payments: [], items: [{ id: 'preview-power', repair: 'PlayStation 5 Power Supply', qty: 1, parts: 89.99, internalCost: 61.2, distributor: 'Amazon', orderSourceUrl: 'https://www.amazon.com/dp/example', requiresOrder: true, orderStatus: 'needed' }] },
        ], [
          { id: -201, customerName: 'Preview Sale', taxRate: 8, amountPaid: 20, totals: { total: 75.59, remaining: 55.59 }, items: [{ id: 'preview-product', description: 'Nintendo Switch Dock', qty: 1, price: 69.99, internalCost: 44.5, inStock: false, requiresOrder: true, distributor: 'Independent Vendor', productUrl: 'https://example.com/switch-dock', orderStatus: 'needed' }] },
        ], [
          { id: -301, status: 'pending', sourceType: 'inventory', inventoryId: -1, itemType: 'Product', title: 'USB-C Charging Cable', distributor: 'Independent Vendor', orderUrl: 'https://example.com/usb-c-cable', quantity: 3, unitCost: 7.5 },
          ...Array.from(previewLowStockCartIds).map((inventoryId, index) => inventoryId === 91001
            ? { id: -401 - index, status: 'pending', sourceType: 'inventory', inventoryId, itemType: 'Part', title: 'PlayStation 5 Power Supply', distributor: 'Console Parts Direct', orderUrl: 'https://example.com/ps5-power-supply?qty=2', quantity: 2, unitCost: 54.99 }
            : { id: -401 - index, status: 'pending', sourceType: 'inventory', inventoryId, itemType: 'Product', title: 'USB-C 65W Power Adapter', distributor: 'Independent Vendor', orderUrl: 'https://example.com/usb-c-adapter?qty=4', quantity: 4, unitCost: 18.5 }),
        ])
      : collectOrderCartRows(workOrders, sales, purchaseOrders);
      const visibleRows = rows.filter(row => !previewDeletedPurchaseKeys.has(row.key));
      return filterLedgerBackedOrderCartRows(visibleRows, purchaseOrders).map(row => {
        const override = Number(quantityOverrides[row.key]);
        if (!Number.isFinite(override) || override <= 0 || override === row.quantity) return row;
        const quantity = Math.max(1, Math.round(override));
        const totalCost = round2(row.unitCost * quantity);
        const baseTotalCharge = round2(row.baseUnitCharge * quantity);
        const clientTax = calculateSalesTax(baseTotalCharge, false, row.clientTaxRate);
        const totalCharge = round2(baseTotalCharge + clientTax);
        return { ...row, quantity, totalCost, baseTotalCharge, clientTax, totalCharge, unitCharge: round2(totalCharge / quantity), knownProfit: row.hasCost && baseTotalCharge > 0 ? round2(baseTotalCharge - totalCost) : null };
      });
    },
    [isCartLayoutPreview, previewDeletedPurchaseKeys, previewLowStockCartIds, purchaseOrders, quantityOverrides, sales, workOrders],
  );
  const purchaseGroups = useMemo(() => groupOrderCartRows(partsPurchaseQueue), [partsPurchaseQueue]);
  const selectedCartRows = useMemo(() => partsPurchaseQueue.filter(row => selectedPurchaseRows.has(row.key)), [partsPurchaseQueue, selectedPurchaseRows]);

  useEffect(() => {
    const activeKeys = new Set(partsPurchaseQueue.map(row => row.key));
    setSelectedPurchaseRows(current => new Set(Array.from(current).filter(key => activeKeys.has(key))));
    setSelectingDistributors(current => new Set(Array.from(current).filter(distributor => purchaseGroups.some(group => group.distributor === distributor))));
    setCheckoutCandidateRows(current => { const next = current?.filter(row => activeKeys.has(row.key)) || []; return next.length ? next : null; });
    setDeleteCandidateRows(current => { const next = current?.filter(row => activeKeys.has(row.key)) || []; return next.length ? next : null; });
  }, [partsPurchaseQueue, purchaseGroups]);
  const lowStockInventory = useMemo(() => {
    const source = isCartLayoutPreview
      ? [
          { id: 91001, itemDescription: 'PlayStation 5 Power Supply', itemType: 'Part', category: 'Game Console', deviceModel: 'PlayStation 5', distributor: 'Console Parts Direct', internalCost: 54.99, reorderQty: 2, reorderUrlTemplate: 'https://example.com/ps5-power-supply?qty={{qty}}', trackStock: true, stockCount: 1, lowStockThreshold: 1 },
          { id: 91002, itemDescription: 'USB-C 65W Power Adapter', itemType: 'Product', category: 'Accessory', distributor: 'Independent Vendor', internalCost: 18.5, reorderQty: 4, reorderUrlTemplate: 'https://example.com/usb-c-adapter?qty={{qty}}', trackStock: true, stockCount: 0, lowStockThreshold: 2 },
        ]
      : inventoryProducts;
    return source
      .filter(isInventoryLowStock)
      .filter((item: any) => lowStockDismissals[String(item.id)] !== inventoryLowStockFingerprint(item))
      .sort((a: any, b: any) => Number(a.stockCount || 0) - Number(b.stockCount || 0)
        || String(a.itemDescription || '').localeCompare(String(b.itemDescription || '')));
  }, [inventoryProducts, isCartLayoutPreview, lowStockDismissals]);
  const pendingLowStockInventoryIds = useMemo(() => {
    const ids = new Set<number>(previewLowStockCartIds);
    purchaseOrders.forEach((record: any) => {
      if (record?.status === 'pending' && record?.sourceType === 'inventory' && Number(record?.inventoryId) > 0) ids.add(Number(record.inventoryId));
    });
    return ids;
  }, [previewLowStockCartIds, purchaseOrders]);
  const pendingDeliveries = useMemo(() => purchaseOrders
    .filter((record: any) => ['checked_out', 'ordered'].includes(String(record?.status || '').toLowerCase()))
    .filter((record: any) => !record?.deliveredAt)
    .sort((left: any, right: any) => String(left?.estimatedDelivery || '9999-12-31').localeCompare(String(right?.estimatedDelivery || '9999-12-31'))), [purchaseOrders]);

  const distributorIsTaxExempt = useCallback((distributor: string, rows: OrderCartRow[]) => {
    if (Object.prototype.hasOwnProperty.call(taxExemptByDistributor, distributor)) return taxExemptByDistributor[distributor];
    const savedVendors = vendors.filter((vendor: any) => String(vendor?.name || '').trim().toLowerCase() === distributor.trim().toLowerCase());
    if (savedVendors.length) return savedVendors.every((vendor: any) => vendor?.taxExempt === true);
    return rows.length > 0 && rows.every(row => row.taxExempt === true);
  }, [taxExemptByDistributor, vendors]);

  const purchaseGroupAmounts = useMemo(() => {
    const amounts = new Map<string, { itemSubtotal: number; supplierTax: number; additional: number; checkoutTotal: number; clientCharge: number; clientTax: number; knownMargin: number; taxExempt: boolean }>();
    purchaseGroups.forEach(group => {
      const taxExempt = distributorIsTaxExempt(group.distributor, group.rows);
      const itemSubtotal = round2(group.knownCost);
      const supplierTax = calculateSalesTax(itemSubtotal, taxExempt, SC_SALES_TAX_RATE);
      const additional = round2(Math.max(0, Number(additionalCostsByDistributor[group.distributor]) || 0));
      const clientCharge = round2(group.rows.reduce((sum, row) => sum + row.totalCharge, 0));
      const clientTax = round2(group.rows.reduce((sum, row) => sum + row.clientTax, 0));
      const preTaxClientCharge = round2(group.rows.reduce((sum, row) => sum + row.baseTotalCharge, 0));
      amounts.set(group.distributor, {
        itemSubtotal,
        supplierTax,
        additional,
        checkoutTotal: round2(itemSubtotal + supplierTax + additional),
        clientCharge,
        clientTax,
        knownMargin: round2(preTaxClientCharge - itemSubtotal - supplierTax - additional),
        taxExempt,
      });
    });
    return amounts;
  }, [additionalCostsByDistributor, distributorIsTaxExempt, purchaseGroups]);

  const purchaseRowSupplierTax = useMemo(() => {
    const taxByRow = new Map<string, number>();
    purchaseGroups.forEach(group => {
      const taxExempt = distributorIsTaxExempt(group.distributor, group.rows);
      allocateSupplierTax(group.rows, taxExempt).forEach((tax, key) => taxByRow.set(key, tax));
    });
    return taxByRow;
  }, [distributorIsTaxExempt, purchaseGroups]);

  const budgetDayKey = useMemo(() => purchaseBudgetDayKey(end), [end]);
  const purchaseBudgets = useMemo<Record<string, number>>(() => {
    const value = shopSettingsRecord?.dailyPurchaseBudgets;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }, [shopSettingsRecord]);
  const budgetConfigured = Object.prototype.hasOwnProperty.call(purchaseBudgets, budgetDayKey);
  const dailyBudget = budgetConfigured ? Math.max(0, Number(purchaseBudgets[budgetDayKey]) || 0) : 0;
  const dailyBudgetSpent = useMemo(() => checkedOutPurchaseSpend(purchaseOrders, start, end), [end, purchaseOrders, start]);
  const budgetTaxExemptByDistributor = useMemo(() => Object.fromEntries(purchaseGroups.map(group => [group.distributor, distributorIsTaxExempt(group.distributor, group.rows)])), [distributorIsTaxExempt, purchaseGroups]);
  const selectedPurchaseBudgetCost = useCallback((rows: OrderCartRow[]) => selectedPurchaseCost({
    selectedRows: rows,
    allRows: partsPurchaseQueue,
    taxExemptByDistributor: budgetTaxExemptByDistributor,
    additionalCostsByDistributor,
    salesTaxRate: SC_SALES_TAX_RATE,
  }), [additionalCostsByDistributor, budgetTaxExemptByDistributor, partsPurchaseQueue]);
  const selectedBudgetCost = useMemo(() => selectedPurchaseBudgetCost(selectedCartRows), [selectedCartRows, selectedPurchaseBudgetCost]);
  const budgetSnapshot = useMemo(() => purchaseBudgetSnapshot(dailyBudget, dailyBudgetSpent, selectedBudgetCost), [dailyBudget, dailyBudgetSpent, selectedBudgetCost]);

  const updateDistributorTaxExempt = useCallback(async (distributor: string, checked: boolean) => {
    setTaxExemptByDistributor(current => ({ ...current, [distributor]: checked }));
    if (isCartLayoutPreview) return;
    const matchingVendors = vendors.filter((vendor: any) => String(vendor?.name || '').trim().toLowerCase() === distributor.trim().toLowerCase());
    if (!matchingVendors.length) return;
    const api = (window as any).api || {};
    const now = new Date().toISOString();
    try {
      const saved = await Promise.all(matchingVendors.map(async (vendor: any) => {
        const updated = { ...vendor, taxExempt: checked, updatedAt: now };
        return api.update ? (await api.update('vendors', updated) || updated) : (await api.dbUpdate?.('vendors', vendor.id, updated) || updated);
      }));
      const byId = new Map(saved.map((vendor: any) => [String(vendor?.id), vendor]));
      setVendors(current => current.map((vendor: any) => byId.get(String(vendor?.id)) || vendor));
    } catch (error: any) {
      setPurchaseUpdateMessage(`${distributor}: tax-exempt setting could not sync. ${error?.message || error}`);
    }
  }, [isCartLayoutPreview, vendors]);

  const autofillPurchaseDraft = useCallback(async () => {
    const orderUrl = normalizePartOrderUrl(purchaseDraft.orderUrl);
    if (!orderUrl) return;
    setPurchaseDraftBusy(true);
    try {
      const metadata = await scrapePartUrl(orderUrl);
      const title = normalizePartInventoryTitle(metadata?.title);
      const distributor = String(metadata?.vendor || derivePartVendorFromUrl(orderUrl) || '').trim();
      setPurchaseDraft((current: any) => ({
        ...current,
        orderUrl,
        title: title || current.title,
        distributor: distributor || current.distributor,
        unitCost: typeof metadata?.price === 'number' ? String(metadata.price) : current.unitCost,
      }));
    } catch (error) {
      console.error('Purchase URL autofill failed', error);
    } finally {
      setPurchaseDraftBusy(false);
    }
  }, [purchaseDraft.orderUrl]);

  useEffect(() => {
    if (!showAddPurchase || !/^https?:\/\//i.test(String(purchaseDraft.orderUrl || '').trim())) return;
    const timer = window.setTimeout(() => { void autofillPurchaseDraft(); }, 550);
    return () => window.clearTimeout(timer);
  }, [autofillPurchaseDraft, purchaseDraft.orderUrl, showAddPurchase]);

  const addManualPurchase = useCallback(async () => {
    const title = String(purchaseDraft.title || '').trim();
    const distributor = String(purchaseDraft.distributor || '').trim();
    const quantity = Math.max(1, Math.round(Number(purchaseDraft.quantity) || 1));
    const unitCost = Number(purchaseDraft.unitCost);
    if (!title || !distributor || !Number.isFinite(unitCost) || unitCost < 0) {
      setPurchaseUpdateMessage('Part/product title, distributor, quantity, and supplier unit cost are required.');
      return;
    }
    setPurchaseDraftBusy(true);
    try {
      const api = (window as any).api || {};
      const now = new Date().toISOString();
      const payload = {
        status: 'pending',
        sourceType: 'manual',
        itemType: purchaseDraft.itemType === 'Product' ? 'Product' : 'Part',
        title,
        distributor,
        orderUrl: normalizePartOrderUrl(purchaseDraft.orderUrl),
        quantity,
        unitCost: round2(unitCost),
        taxExempt: distributorIsTaxExempt(distributor, []),
        supplierTaxRate: SC_SALES_TAX_RATE,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await api.dbAdd?.('purchaseOrders', payload);
      if (!saved) throw new Error('The purchase record was not saved.');
      setPurchaseOrders(current => {
        const savedId = Number(saved?.id || 0);
        if (savedId && current.some(record => Number(record?.id || 0) === savedId)) {
          return current.map(record => Number(record?.id || 0) === savedId ? saved : record);
        }
        return [...current, saved];
      });
      const matchingVendor = vendors.some((vendor: any) => String(vendor?.name || '').trim().toLowerCase() === distributor.toLowerCase()
        && String(vendor?.inventoryMode || 'Product') === payload.itemType);
      if (!matchingVendor && api.dbAdd) {
        const vendor = await api.dbAdd('vendors', { name: distributor, inventoryMode: payload.itemType, relationship: 'wholesale', taxExempt: false, createdAt: now, updatedAt: now });
        if (vendor) setVendors(current => [...current, vendor]);
      }
      setPurchaseDraft({ itemType: 'Part', orderUrl: '', title: '', distributor: '', quantity: 1, unitCost: '' });
      setShowAddPurchase(false);
      setPurchaseUpdateMessage(`${title} was added to the purchasing cart and synced.`);
    } catch (error: any) {
      setPurchaseUpdateMessage(error?.message || 'The purchase could not be added.');
    } finally {
      setPurchaseDraftBusy(false);
    }
  }, [distributorIsTaxExempt, purchaseDraft, vendors]);

  const dismissLowStockItem = useCallback((item: any) => {
    const next = { ...lowStockDismissals, [String(item.id)]: inventoryLowStockFingerprint(item) };
    setLowStockDismissals(next);
    try { localStorage.setItem(LOW_STOCK_DISMISSALS_KEY, JSON.stringify(next)); } catch {}
    setSelectedLowStockItem(null);
    setLowStockMessage(`${item.itemDescription || 'Inventory item'} dismissed at its current stock level.`);
  }, [lowStockDismissals]);

  const addLowStockMoqToCart = useCallback(async (item: any) => {
    const inventoryId = Number(item?.id);
    if (pendingLowStockInventoryIds.has(inventoryId)) {
      setLowStockMessage(`${item.itemDescription || 'This item'} is already in the purchasing cart.`);
      setSelectedLowStockItem(null);
      return;
    }
    setLowStockBusy(true);
    setLowStockMessage('');
    try {
      const payload = buildInventoryReorderPurchase(item);
      if (isCartLayoutPreview) {
        setPreviewLowStockCartIds(current => new Set(current).add(inventoryId));
        setLowStockMessage(`Preview: ${payload.quantity} ${payload.title} added to the purchasing cart.`);
      } else {
        const api = (window as any).api || {};
        const saved = await api.dbAdd?.('purchaseOrders', payload);
        if (!saved) throw new Error('The purchasing record was not saved.');
        setPurchaseOrders(current => [...current, saved]);
        setLowStockMessage(`${payload.quantity} ${payload.title} added to the purchasing cart and synced.`);
      }
      setSelectedLowStockItem(null);
    } catch (error: any) {
      setLowStockMessage(error?.message || 'This item could not be added to the purchasing cart.');
    } finally {
      setLowStockBusy(false);
    }
  }, [isCartLayoutPreview, pendingLowStockInventoryIds]);

  const viewLowStockItem = useCallback(async (item: any) => {
    if (isCartLayoutPreview) {
      setLowStockMessage(`Preview item: ${item.itemDescription}. In the installed app this opens the matching inventory record.`);
      setSelectedLowStockItem(null);
      return;
    }
    try {
      await (window as any).api?.openInventory?.({ inventoryId: Number(item.id) });
      setSelectedLowStockItem(null);
    } catch (error: any) {
      setLowStockMessage(error?.message || 'The inventory item could not be opened.');
    }
  }, [isCartLayoutPreview]);

  const deleteSelectedPurchaseRows = useCallback(async (rows: OrderCartRow[]) => {
    if (!rows.length) return;
    if (isCartLayoutPreview) {
      setPreviewDeletedPurchaseKeys(current => new Set([...current, ...rows.map(row => row.key)]));
      setSelectedPurchaseRows(current => { const next = new Set(current); rows.forEach(row => next.delete(row.key)); return next; });
      setDeleteCandidateRows(null);
      setPurchaseUpdateMessage(`Preview: removed ${rows.length} selected item${rows.length === 1 ? '' : 's'} from the cart.`);
      return;
    }

    const api = (window as any).api || {};
    const now = new Date().toISOString();
    const failures: string[] = [];
    const removedKeys = new Set<string>();
    setPurchaseUpdateBusy(true);
    setPurchaseUpdateMessage('');

    try {
      for (const row of rows) {
        try {
          if (row.sourceType === 'workOrder') {
            const current = workOrders.find(record => Number(record?.id) === Number(row.sourceId));
            if (!current) throw new Error(`WO #${row.sourceId} was not found.`);
            const { items, matched } = applyPurchaseQueueRemovalToItems(current.items, row, now);
            if (!matched) throw new Error(`The linked line on WO #${row.sourceId} was not found.`);
            const updated = { ...current, items, updatedAt: now };
            const saved = api.update ? await api.update('workOrders', updated) : await api.dbUpdate?.('workOrders', current.id, updated);
            if (!saved) throw new Error(`WO #${row.sourceId} did not save.`);
            setWorkOrders(currentRows => currentRows.map(record => Number(record?.id) === Number(row.sourceId) ? saved : record));
          } else if (row.sourceType === 'sale') {
            const current = sales.find(record => Number(record?.id) === Number(row.sourceId));
            if (!current) throw new Error(`Sale #${row.sourceId} was not found.`);
            const { items, matched } = applyPurchaseQueueRemovalToItems(current.items, row, now);
            if (!matched) throw new Error(`The linked line on Sale #${row.sourceId} was not found.`);
            const updated = { ...current, items, updatedAt: now };
            const saved = await api.dbUpdate?.('sales', current.id, updated);
            if (!saved) throw new Error(`Sale #${row.sourceId} did not save.`);
            setSales(currentRows => currentRows.map(record => Number(record?.id) === Number(row.sourceId) ? saved : record));
          }

          if (row.purchaseOrderId) {
            const deleted = await api.dbDelete?.('purchaseOrders', row.purchaseOrderId);
            if (deleted === false || deleted == null) throw new Error('The purchasing record did not delete.');
            setPurchaseOrders(current => current.filter(record => Number(record?.id) !== Number(row.purchaseOrderId)));
          }
          removedKeys.add(row.key);
        } catch (error: any) {
          failures.push(`${row.title}: ${error?.message || error}`);
        }
      }
      setSelectedPurchaseRows(current => { const next = new Set(current); removedKeys.forEach(key => next.delete(key)); return next; });
      setDeleteCandidateRows(null);
      setPurchaseUpdateMessage(`${removedKeys.size} item${removedKeys.size === 1 ? '' : 's'} removed from the purchasing cart.${failures.length ? ` ${failures.join(' ')}` : ''}`);
    } finally {
      setPurchaseUpdateBusy(false);
    }
  }, [isCartLayoutPreview, sales, workOrders]);

  const markSelectedPurchasesOrdered = useCallback(async (selectedOverride?: OrderCartRow[], orderedOn?: string, sendClientUpdate = false) => {
    const selected = selectedOverride || partsPurchaseQueue.filter((row) => selectedPurchaseRows.has(row.key));
    if (!selected.length) return;
    if (isCartLayoutPreview) {
      setPurchaseUpdateMessage('Preview mode: no records were changed or synced.');
      return;
    }
    const missingCostRows = selected.filter(row => !row.hasCost);
    if (missingCostRows.length) {
      setPurchaseUpdateMessage(`Enter the full supplier cost for ${missingCostRows.length} selected item${missingCostRows.length === 1 ? '' : 's'} before marking the order purchased.`);
      return;
    }
    const allocationByRow = new Map<string, number>();
    const supplierTaxByRow = new Map<string, number>();
    const selectedKeys = new Set(selected.map(row => row.key));
    const distributorsWithAdditionalCosts = new Set<string>();
    for (const group of purchaseGroups) {
      const selectedRows = group.rows.filter(row => selectedKeys.has(row.key));
      if (!selectedRows.length) continue;
      const taxExempt = distributorIsTaxExempt(group.distributor, group.rows);
      allocateSupplierTax(selectedRows, taxExempt).forEach((tax, key) => supplierTaxByRow.set(key, tax));

      const extra = Number(additionalCostsByDistributor[group.distributor] || 0);
      if (!Number.isFinite(extra) || extra < 0) {
        setPurchaseUpdateMessage(`${group.distributor}: Additional Costs must be zero or a valid positive amount.`);
        return;
      }
      if (extra <= 0) continue;
      distributorsWithAdditionalCosts.add(group.distributor);
      allocateCheckoutAdditionalCosts(selectedRows, extra).forEach((amount, key) => allocationByRow.set(key, amount));
    }
    setPurchaseUpdateBusy(true);
    setPurchaseUpdateMessage('');
    const api = (window as any).api || {};
    const today = new Date();
    const todayLocal = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(orderedOn || '')) ? String(orderedOn) : todayLocal;
    if (date > todayLocal) { setPurchaseUpdateMessage('Ordered date cannot be in the future.'); return; }
    const now = orderedOn ? new Date(`${date}T12:00:00`).toISOString() : new Date().toISOString();
    let updatedCount = 0;
    let emailCount = 0;
    let queuedEmailCount = 0;
    let skippedEmailCount = 0;
    const failures: string[] = [];
    const deliveryForRow = (row: OrderCartRow) => String(
      (splitDeliveryByDistributor[row.distributor] ? deliveryByRow[row.key] : deliveryByDistributor[row.distributor])
      || row.estimatedDelivery
      || '',
    ).slice(0, 10);
    const syncDeliveryCalendar = async (row: OrderCartRow, estimatedDelivery: string) => {
      if (!estimatedDelivery || !api.dbGet || !api.dbAdd) return;
      const all = await api.dbGet('calendarEvents').catch(() => []);
      const sourceNote = `Purchase source: ${row.key}`;
      const existing = (Array.isArray(all) ? all : []).find((event: any) => event?.category === 'parts' && event?.partsStatus === 'delivery' && (String(event?.sourceKey || '') === row.key || String(event?.notes || '').includes(sourceNote)));
      const payload = {
        ...(existing || {}),
        date: estimatedDelivery,
        title: `Expected: ${row.title}`,
        partName: row.title,
        category: 'parts',
        partsStatus: 'delivery',
        source: row.sourceType === 'workOrder' ? 'workorder' : row.sourceType,
        sourceKey: row.key,
        notes: sourceNote,
        workOrderId: row.sourceType === 'workOrder' ? row.sourceId : undefined,
        saleId: row.sourceType === 'sale' ? row.sourceId : undefined,
        orderUrl: row.orderUrl || undefined,
        customerName: row.customer,
        updatedAt: now,
      };
      if (existing?.id != null && api.dbUpdate) await api.dbUpdate('calendarEvents', existing.id, payload);
      else await api.dbAdd('calendarEvents', { ...payload, createdAt: now });
    };
    try {
      const savedPurchaseRecords: any[] = [];
      const successfulPurchaseKeys = new Set<string>();
      for (const row of selected) {
        const additionalCost = allocationByRow.get(row.key) || 0;
        const supplierTax = supplierTaxByRow.get(row.key) || 0;
        const taxExempt = distributorIsTaxExempt(row.distributor, purchaseGroups.find(group => group.distributor === row.distributor)?.rows || [row]);
        const finalTotalCost = round2(row.totalCost + supplierTax + additionalCost);
        const estimatedDelivery = deliveryForRow(row);
        const ledgerPayload = {
          status: row.sourceType === 'inventory' ? 'processing' : 'checked_out',
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          sourceItemIndex: row.itemIndex,
          sourceItemId: row.itemId || null,
          sourceKey: row.key,
          inventoryId: row.inventoryId || null,
          itemType: row.itemType || (row.sourceType === 'sale' ? 'Product' : 'Part'),
          title: row.title,
          customer: row.customer,
          distributor: row.distributor,
          orderUrl: row.orderUrl,
          quantity: row.quantity,
          unitCost: row.unitCost,
          itemCost: row.totalCost,
          supplierTax,
          supplierTaxRate: SC_SALES_TAX_RATE,
          taxExempt,
          additionalCost,
          totalCost: finalTotalCost,
          paymentStatus: row.paymentStatus,
          estimatedDelivery,
          checkedOutAt: now,
          updatedAt: now,
        };
        try {
          let saved: any = null;
          if (row.purchaseOrderId) {
            const currentRecord = purchaseOrders.find(record => Number(record?.id) === Number(row.purchaseOrderId));
            saved = await api.dbUpdate?.('purchaseOrders', row.purchaseOrderId, { ...currentRecord, ...ledgerPayload });
          } else {
            const existingLedger = purchaseOrders.find(record => record?.status === 'checked_out' && record?.sourceKey === row.key);
            saved = existingLedger || await api.dbAdd?.('purchaseOrders', { ...ledgerPayload, createdAt: now });
          }
          if (!saved) throw new Error('Purchase ledger save returned no record.');
          if (row.sourceType === 'inventory' && row.inventoryId) {
            saved = await api.dbUpdate?.('purchaseOrders', saved.id, { ...saved, status: 'checked_out', inventoryApplied: false, checkedOutAt: now, updatedAt: now });
            if (!saved) throw new Error('Purchase checkout could not be finalized as incoming inventory.');
          }
          savedPurchaseRecords.push(saved);
          successfulPurchaseKeys.add(row.key);
        } catch (error: any) {
          failures.push(`${row.title}: ${error?.message || error}`);
        }
      }
      if (savedPurchaseRecords.length) {
        updatedCount = savedPurchaseRecords.length;
        setPurchaseOrders(current => {
          const byId = new Map(current.map(record => [Number(record?.id), record]));
          savedPurchaseRecords.forEach(record => byId.set(Number(record?.id), record));
          return Array.from(byId.values());
        });
      }

      const workOrderIds = Array.from(new Set(selected.filter(row => row.sourceType === 'workOrder').map((row) => row.sourceId)));
      for (const workOrderId of workOrderIds) {
        const current = workOrders.find((row) => Number(row?.id) === Number(workOrderId));
        if (!current) { failures.push(`WO #${workOrderId} was not found.`); continue; }
        const selectedForWorkOrder = selected.filter((row) => successfulPurchaseKeys.has(row.key) && row.sourceType === 'workOrder' && Number(row.sourceId) === Number(workOrderId));
        if (!selectedForWorkOrder.length) continue;
        const items = (Array.isArray(current.items) ? current.items : []).map((item: any, itemIndex: number) => {
          const cartRow = selectedForWorkOrder.find((row) => row.itemIndex === itemIndex);
          if (!cartRow) return item;
          const extra = allocationByRow.get(cartRow.key) || 0;
          const supplierTax = supplierTaxByRow.get(cartRow.key) || 0;
          const taxExempt = distributorIsTaxExempt(cartRow.distributor, purchaseGroups.find(group => group.distributor === cartRow.distributor)?.rows || [cartRow]);
          const fullUnitCost = round2((Number(item.internalCost) || 0) + ((supplierTax + extra) / Math.max(1, cartRow.quantity)));
          return { ...item, qty: cartRow.quantity, internalCost: fullUnitCost, supplierTax, supplierTaxRate: SC_SALES_TAX_RATE, taxExempt, checkoutAdditionalCost: extra, requiresOrder: true, orderStatus: 'ordered', orderDate: date, estimatedDelivery: deliveryForRow(cartRow) };
        });
        const updated = {
          ...current,
          items,
          partsOrdered: true,
          partsOrderDate: date,
          repairStatus: 'Part Ordered',
          statusUpdate: 'Part Ordered',
          statusUpdatedAt: now,
          updatedAt: now,
        };
        try {
          const saved = api.update ? await api.update('workOrders', updated) : await api.dbUpdate?.('workOrders', current.id, updated);
          setWorkOrders((rows) => rows.map((row) => Number(row?.id) === Number(workOrderId) ? (saved || updated) : row));
          for (const cartRow of selectedForWorkOrder) await syncDeliveryCalendar(cartRow, deliveryForRow(cartRow));

          const customer = customers.find((row) => Number(row?.id) === Number(current.customerId));
          const email = String(current.customerEmail || customer?.email || '').trim();
          if (sendClientUpdate && !email) {
            skippedEmailCount += 1;
          } else if (sendClientUpdate) {
            const deliveryDates = selectedForWorkOrder.map(row => deliveryForRow(row)).filter(Boolean).sort();
            const result = await sendCartClientUpdate({
              recordType: 'repair',
              recordId: Number(workOrderId),
              statusKey: 'part_ordered',
              estimatedDate: deliveryDates[deliveryDates.length - 1] || '',
              notes: `Ordered on ${new Date(`${date}T12:00:00`).toLocaleDateString()}: ${selectedForWorkOrder.map(row => row.title).join(', ')}`,
            });
            if (result?.deliveryStatus === 'sent') emailCount += 1;
            else queuedEmailCount += 1;
          }
        } catch (error: any) {
          failures.push(`WO #${workOrderId}: ${error?.message || error}`);
        }
      }
      const saleIds = Array.from(new Set(selected.filter(row => row.sourceType === 'sale').map(row => row.sourceId)));
      for (const saleId of saleIds) {
        const current = sales.find(row => Number(row?.id) === Number(saleId));
        if (!current) { failures.push(`Sale #${saleId} was not found.`); continue; }
        const selectedForSale = selected.filter(row => successfulPurchaseKeys.has(row.key) && row.sourceType === 'sale' && Number(row.sourceId) === Number(saleId));
        if (!selectedForSale.length) continue;
        const items = (Array.isArray(current.items) ? current.items : []).map((item: any, itemIndex: number) => {
          const cartRow = selectedForSale.find(row => row.itemIndex === itemIndex);
          if (!cartRow) return item;
          const extra = allocationByRow.get(cartRow.key) || 0;
          const supplierTax = supplierTaxByRow.get(cartRow.key) || 0;
          const taxExempt = distributorIsTaxExempt(cartRow.distributor, purchaseGroups.find(group => group.distributor === cartRow.distributor)?.rows || [cartRow]);
          const fullUnitCost = round2((Number(item.internalCost) || 0) + ((supplierTax + extra) / Math.max(1, cartRow.quantity)));
          return { ...item, qty: cartRow.quantity, internalCost: fullUnitCost, supplierTax, supplierTaxRate: SC_SALES_TAX_RATE, vendorTaxExempt: taxExempt, checkoutAdditionalCost: extra, requiresOrder: true, orderStatus: 'ordered', orderDate: date, estimatedDelivery: deliveryForRow(cartRow) };
        });
        const updated = { ...current, items, status: 'Product Ordered', statusUpdate: 'Product Ordered', statusUpdatedAt: now, updatedAt: now };
        try {
          const saved = await api.dbUpdate?.('sales', current.id, updated);
          setSales(rows => rows.map(row => Number(row?.id) === Number(saleId) ? (saved || updated) : row));
          for (const cartRow of selectedForSale) await syncDeliveryCalendar(cartRow, deliveryForRow(cartRow));

          const customer = customers.find(row => Number(row?.id) === Number(current.customerId));
          const email = String(current.customerEmail || customer?.email || '').trim();
          if (sendClientUpdate && !email) {
            skippedEmailCount += 1;
          } else if (sendClientUpdate) {
            const deliveryDates = selectedForSale.map(row => deliveryForRow(row)).filter(Boolean).sort();
            const result = await sendCartClientUpdate({
              recordType: 'sale',
              recordId: Number(saleId),
              statusKey: 'product_ordered',
              estimatedDate: deliveryDates[deliveryDates.length - 1] || '',
              notes: `Ordered on ${new Date(`${date}T12:00:00`).toLocaleDateString()}: ${selectedForSale.map(row => row.title).join(', ')}`,
            });
            if (result?.deliveryStatus === 'sent') emailCount += 1;
            else queuedEmailCount += 1;
          }
        } catch (error: any) {
          failures.push(`Sale #${saleId}: ${error?.message || error}`);
        }
      }
      setSelectedPurchaseRows(current => {
        const next = new Set(current);
        successfulPurchaseKeys.forEach(key => next.delete(key));
        return next;
      });
      setQuantityOverrides(current => {
        const next = { ...current };
        successfulPurchaseKeys.forEach(key => delete next[key]);
        return next;
      });
      setAdditionalCostsByDistributor(current => {
        const next = { ...current };
        purchaseGroups.forEach(group => {
          if (!distributorsWithAdditionalCosts.has(group.distributor)) return;
          const selectedGroupRows = group.rows.filter(row => selectedKeys.has(row.key));
          if (selectedGroupRows.length && selectedGroupRows.every(row => successfulPurchaseKeys.has(row.key))) delete next[group.distributor];
        });
        return next;
      });
      const checkoutSummary = updatedCount
        ? `${updatedCount} selected item${updatedCount === 1 ? '' : 's'} purchased, removed from the cart, and synced to reporting.`
        : 'No selected items were purchased.';
      setPurchaseUpdateMessage(`${checkoutSummary}${emailCount ? ` ${emailCount} client email${emailCount === 1 ? '' : 's'} sent.` : ''}${queuedEmailCount ? ` ${queuedEmailCount} client email${queuedEmailCount === 1 ? '' : 's'} queued.` : ''}${skippedEmailCount ? ` ${skippedEmailCount} client update${skippedEmailCount === 1 ? '' : 's'} skipped because no email is on file.` : ''}${failures.length ? ` ${failures.join(' ')}` : ''}`);
    } finally {
      setPurchaseUpdateBusy(false);
    }
  }, [additionalCostsByDistributor, customers, deliveryByDistributor, deliveryByRow, distributorIsTaxExempt, inventoryProducts, isCartLayoutPreview, partsPurchaseQueue, purchaseGroups, purchaseOrders, sales, selectedPurchaseRows, splitDeliveryByDistributor, workOrders]);

  const markPurchaseDelivered = useCallback(async (purchase: any) => {
    const api: any = (window as any).api;
    const purchaseId = Number(purchase?.id || 0);
    if (!purchaseId || deliveryBusyId != null) return;
    const sourceType = String(purchase?.sourceType || '');
    const sourceId = Number(purchase?.sourceId || 0);
    const sourceItemIndex = Number(purchase?.sourceItemIndex);
    const sourceItemId = String(purchase?.sourceItemId || '');
    const now = new Date().toISOString();
    setDeliveryBusyId(purchaseId);
    setDeliveryMessage('');
    try {
      const sendsClientUpdate = sourceType === 'workOrder' || sourceType === 'sale';
      if (!sendsClientUpdate) {
        let inventorySaved: any = null;
        if (sourceType === 'inventory' && Number(purchase?.inventoryId) > 0) {
          const inventoryItem = inventoryProducts.find(item => Number(item?.id) === Number(purchase.inventoryId));
          if (!inventoryItem) throw new Error('The linked inventory item could not be found, so stock was not changed.');
          const updatedInventory = applyDeliveredInventoryPurchase(inventoryItem, purchase, now);
          inventorySaved = updatedInventory === inventoryItem
            ? inventoryItem
            : (api.update ? await api.update('products', updatedInventory) : await api.dbUpdate?.('products', inventoryItem.id, updatedInventory));
          if (!inventorySaved) throw new Error('The inventory stock update did not save.');
        }
        const savedPurchase = await api.dbUpdate?.('purchaseOrders', purchaseId, { ...purchase, status: 'delivered', deliveredAt: now, inventoryApplied: sourceType === 'inventory' ? true : purchase?.inventoryApplied, updatedAt: now });
        if (!savedPurchase) throw new Error('The purchase ledger did not confirm delivery.');
        if (inventorySaved) setInventoryProducts((list) => list.map((item) => Number(item?.id) === Number(purchase.inventoryId) ? inventorySaved : item));
        setPurchaseOrders((list) => list.map((item) => Number(item?.id) === purchaseId ? savedPurchase : item));
        setDeliveryMessage(`${purchase?.title || 'Item'} marked delivered. No client update was required.`);
        return;
      }
      const records = sourceType === 'workOrder' ? workOrders : sales;
      const record = records.find((item: any) => Number(item?.id) === sourceId);
      if (!record) throw new Error(`The linked ${sourceType === 'workOrder' ? 'work order' : 'sale'} could not be found.`);
      let matched = false;
      const items = (Array.isArray(record.items) ? record.items : []).map((item: any, index: number) => {
        const itemMatches = Number.isFinite(sourceItemIndex) && sourceItemIndex >= 0
          ? index === sourceItemIndex
          : Boolean(sourceItemId) && String(item?.id || '') === sourceItemId;
        if (!itemMatches) return item;
        matched = true;
        return { ...item, orderStatus: 'received', receivedAt: now, partDeliveredAt: now };
      });
      if (!matched) throw new Error('The linked invoice line item could not be matched, so nothing was changed.');

      const invoiceUpdate = sourceType === 'workOrder'
        ? { ...record, items, repairStatus: 'Part Delivered', statusUpdate: 'Part Delivered', statusUpdatedAt: now, updatedAt: now }
        : { ...record, items, status: 'Product Arrived', statusUpdate: 'Product Arrived', statusUpdatedAt: now, updatedAt: now };
      const savedInvoice = sourceType === 'workOrder'
        ? (api.update ? await api.update('workOrders', invoiceUpdate) : await api.dbUpdate?.('workOrders', sourceId, invoiceUpdate))
        : await api.dbUpdate?.('sales', sourceId, invoiceUpdate);
      if (!savedInvoice) throw new Error('The linked invoice did not confirm its update.');

      const savedPurchase = await api.dbUpdate?.('purchaseOrders', purchaseId, { ...purchase, status: 'delivered', deliveredAt: now, updatedAt: now });
      if (!savedPurchase) throw new Error('The purchase ledger did not confirm delivery.');
      if (sourceType === 'workOrder') setWorkOrders((list) => list.map((item) => Number(item?.id) === sourceId ? savedInvoice : item));
      else setSales((list) => list.map((item) => Number(item?.id) === sourceId ? savedInvoice : item));
      setPurchaseOrders((list) => list.map((item) => Number(item?.id) === purchaseId ? savedPurchase : item));

      const calendarEvents = await api.dbGet?.('calendarEvents').catch(() => []);
      const matchingDeliveries = (Array.isArray(calendarEvents) ? calendarEvents : []).filter((event: any) => event?.category === 'parts'
        && event?.partsStatus === 'delivery'
        && (sourceType === 'workOrder' ? Number(event?.workOrderId) === sourceId : Number(event?.saleId) === sourceId)
        && String(event?.partName || event?.title || '').trim().toLowerCase() === String(purchase?.title || '').trim().toLowerCase());
      for (const event of matchingDeliveries) if (event?.id != null) await api.dbDelete?.('calendarEvents', event.id);

      const updateResult = await sendCartClientUpdate({
        recordType: sourceType === 'workOrder' ? 'repair' : 'sale',
        recordId: sourceId,
        statusKey: sourceType === 'workOrder' ? 'part_delivered' : 'product_in_shop',
        notes: `Arrived: ${String(purchase?.title || 'ordered item')}`,
      });
      const deliveryStatus = String(updateResult?.deliveryStatus || '');
      setDeliveryMessage(`${purchase?.title || 'Item'} marked delivered.${deliveryStatus === 'sent' ? ' Client email sent.' : deliveryStatus === 'queued' ? ' Client email queued.' : ' Invoice updated; client email was not sent.'}`);
    } catch (error: any) {
      setDeliveryMessage(error?.message || 'The delivery could not be completed.');
    } finally {
      setDeliveryBusyId(null);
    }
  }, [deliveryBusyId, inventoryProducts, purchaseOrders, sales, workOrders]);

  const partsPurchaseTotals = useMemo(() => {
    const verified = partsPurchaseQueue.filter(row => row.hasCost);
    const groupAmounts = Array.from(purchaseGroupAmounts.values());
    const itemCost = round2(groupAmounts.reduce((sum, amount) => sum + amount.itemSubtotal, 0));
    const supplierTax = round2(groupAmounts.reduce((sum, amount) => sum + amount.supplierTax, 0));
    const additionalCosts = round2(groupAmounts.reduce((sum, amount) => sum + amount.additional, 0));
    return {
      count: partsPurchaseQueue.length,
      missingCost: partsPurchaseQueue.length - verified.length,
      cost: round2(itemCost + supplierTax),
      itemCost,
      supplierTax,
      additionalCosts,
      checkoutCost: round2(groupAmounts.reduce((sum, amount) => sum + amount.checkoutTotal, 0)),
      charged: round2(groupAmounts.reduce((sum, amount) => sum + amount.clientCharge, 0)),
      clientTax: round2(groupAmounts.reduce((sum, amount) => sum + amount.clientTax, 0)),
      profit: round2(groupAmounts.reduce((sum, amount) => sum + amount.knownMargin, 0)),
      paymentWarnings: partsPurchaseQueue.filter(row => row.paymentStatus !== 'paid' && row.paymentStatus !== 'not_required').length,
    };
  }, [partsPurchaseQueue, purchaseGroupAmounts]);

  const openPurchaseUrl = useCallback((url: string) => {
    if (!url) return;
    const api = (window as any).api;
    if (api?.openUrl) void api.openUrl(url);
    else if (api?.openExternal) void api.openExternal(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const openPurchaseRows = useCallback((rows: OrderCartRow[]) => {
    rows.filter(row => row.orderUrl).forEach(row => openPurchaseUrl(row.orderUrl));
  }, [openPurchaseUrl]);

  const openPurchaseInvoice = useCallback(async (row: OrderCartRow) => {
    const api = (window as any).api || {};
    if (row.sourceType === 'workOrder') await api.openNewWorkOrder?.({ workOrderId: row.sourceId });
    else if (row.sourceType === 'sale') await api.openNewSale?.({ id: row.sourceId });
  }, []);

  const refreshCartPrices = useCallback(async () => {
    const rows = partsPurchaseQueue.filter(row => row.orderUrl);
    if (!rows.length || cartRefreshBusy) {
      if (!rows.length) setPurchaseUpdateMessage('No cart items have an Order URL to refresh.');
      return;
    }
    setCartRefreshBusy(true);
    setCartPriceReview(null);
    setPurchaseUpdateMessage('Checking current supplier item pages...');
    try {
      if (isCartLayoutPreview) {
        const first = rows[0];
        setCartPriceReview([{ key: first.key, title: first.title, previousUnitCost: first.unitCost, nextUnitCost: round2(first.unitCost + 2.5) }]);
        setPurchaseUpdateMessage('Preview: one supplier price changed. Review it before keeping changes.');
        return;
      }
      const results = await Promise.allSettled(rows.map(async row => ({ row, metadata: await scrapePartUrl(row.orderUrl) })));
      const changes = results.flatMap(result => {
        if (result.status !== 'fulfilled') return [];
        const next = Number(result.value.metadata?.price);
        const row = result.value.row;
        if (!Number.isFinite(next) || next < 0 || Math.abs(next - row.unitCost) < 0.005) return [];
        return [{ key: row.key, title: row.title, previousUnitCost: row.unitCost, nextUnitCost: round2(next) }];
      });
      setCartPriceReview(changes);
      setPurchaseUpdateMessage(changes.length
        ? `${changes.length} supplier price change${changes.length === 1 ? '' : 's'} found. Choose Keep Changes or Revert.`
        : 'Refresh complete. No readable supplier item prices changed. Shipping, tax, and signed-in distributor cart totals still require checkout review.');
    } catch (error: any) {
      setPurchaseUpdateMessage(`Cart refresh could not finish: ${error?.message || error}`);
    } finally {
      setCartRefreshBusy(false);
    }
  }, [cartRefreshBusy, isCartLayoutPreview, partsPurchaseQueue]);

  const keepRefreshedCartPrices = useCallback(async () => {
    if (!cartPriceReview?.length) return;
    if (isCartLayoutPreview) {
      setCartPriceReview(null);
      setPurchaseUpdateMessage('Preview: refreshed prices accepted without saving records.');
      return;
    }
    const api = (window as any).api || {};
    const reviewByKey = new Map(cartPriceReview.map(change => [change.key, change]));
    const rows = partsPurchaseQueue.filter(row => reviewByKey.has(row.key));
    setCartRefreshBusy(true);
    try {
      const savedWorkOrders: any[] = [];
      for (const sourceId of Array.from(new Set(rows.filter(row => row.sourceType === 'workOrder').map(row => row.sourceId)))) {
        const record = workOrders.find(item => Number(item?.id) === Number(sourceId));
        if (!record) continue;
        const updated = { ...record, items: (Array.isArray(record.items) ? record.items : []).map((item: any, index: number) => {
          const row = rows.find(candidate => candidate.sourceType === 'workOrder' && candidate.sourceId === sourceId && candidate.itemIndex === index);
          const change = row ? reviewByKey.get(row.key) : null;
          return change ? { ...item, internalCost: change.nextUnitCost, cost: change.nextUnitCost } : item;
        }), updatedAt: new Date().toISOString() };
        const saved = api.update ? await api.update('workOrders', updated) : await api.dbUpdate?.('workOrders', sourceId, updated);
        if (!saved) throw new Error(`WO #${sourceId} did not save.`);
        savedWorkOrders.push(saved);
      }
      const savedSales: any[] = [];
      for (const sourceId of Array.from(new Set(rows.filter(row => row.sourceType === 'sale').map(row => row.sourceId)))) {
        const record = sales.find(item => Number(item?.id) === Number(sourceId));
        if (!record) continue;
        const updated = { ...record, items: (Array.isArray(record.items) ? record.items : []).map((item: any, index: number) => {
          const row = rows.find(candidate => candidate.sourceType === 'sale' && candidate.sourceId === sourceId && candidate.itemIndex === index);
          const change = row ? reviewByKey.get(row.key) : null;
          return change ? { ...item, internalCost: change.nextUnitCost, cost: change.nextUnitCost } : item;
        }), updatedAt: new Date().toISOString() };
        const saved = await api.dbUpdate?.('sales', sourceId, updated);
        if (!saved) throw new Error(`Sale #${sourceId} did not save.`);
        savedSales.push(saved);
      }
      const savedPurchases: any[] = [];
      for (const row of rows.filter(candidate => candidate.purchaseOrderId)) {
        const change = reviewByKey.get(row.key);
        const record = purchaseOrders.find(item => Number(item?.id) === Number(row.purchaseOrderId));
        if (!change || !record) continue;
        const saved = await api.dbUpdate?.('purchaseOrders', record.id, { ...record, unitCost: change.nextUnitCost, updatedAt: new Date().toISOString() });
        if (!saved) throw new Error(`${row.title} purchasing record did not save.`);
        savedPurchases.push(saved);
      }
      if (savedWorkOrders.length) setWorkOrders(current => current.map(record => savedWorkOrders.find(saved => Number(saved?.id) === Number(record?.id)) || record));
      if (savedSales.length) setSales(current => current.map(record => savedSales.find(saved => Number(saved?.id) === Number(record?.id)) || record));
      if (savedPurchases.length) setPurchaseOrders(current => current.map(record => savedPurchases.find(saved => Number(saved?.id) === Number(record?.id)) || record));
      setCartPriceReview(null);
      setPurchaseUpdateMessage(`${cartPriceReview.length} refreshed supplier price${cartPriceReview.length === 1 ? '' : 's'} saved and synced.`);
    } catch (error: any) {
      setPurchaseUpdateMessage(`Refreshed prices were not fully saved: ${error?.message || error}`);
    } finally {
      setCartRefreshBusy(false);
    }
  }, [cartPriceReview, isCartLayoutPreview, partsPurchaseQueue, purchaseOrders, sales, workOrders]);

  const workStatusCounts = useMemo(() => {
    let open = 0;
    let closed = 0;
    let total = 0;
    unified.forEach(row => {
      if (row.kind !== 'work') return;
      total += 1;
      const st = (row.status || '').toLowerCase();
      if (st === 'closed') closed += 1; else open += 1;
    });
    return { total, open, closed };
  }, [unified]);

  const monthlyTrends = useMemo(() => {
    const map = new Map<string, { count: number; total: number }>();
    trendRows.forEach(row => {
      const d = row.date;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const existing = map.get(key) || { count: 0, total: 0 };
      existing.count += 1;
      existing.total += row.total;
      map.set(key, existing);
    });
    const entries = Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([key, val]) => {
        const [year, month] = key.split('-').map(Number);
        const label = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
        return { key, label, count: val.count, total: val.total };
      });
    return entries;
  }, [trendRows]);

  const monthlyBatchSummary = useMemo(() => {
    const min = commissionStart.getTime();
    const max = commissionEnd.getTime();
    let workCollected = 0;
    let saleCollected = 0;
    let workCount = 0;
    let saleCount = 0;

    trendRows.forEach(row => {
      const ts = row.date.getTime();
      if (ts < min || ts > max) return;
      const collected = collectedAmountInRange(row, min, max, row.date);
      if (row.kind === 'work') {
        workCount += 1;
        workCollected += collected;
      } else {
        saleCount += 1;
        saleCollected += collected;
      }
    });

    return {
      workCount,
      saleCount,
      workCollected: round2(workCollected),
      saleCollected: round2(saleCollected),
      combinedCollected: round2(workCollected + saleCollected),
    };
  }, [commissionRangeKey, trendRows]);

  const busiestDays = useMemo(() => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const counts = new Array(7).fill(0);
    trendRows.forEach(row => {
      counts[row.date.getDay()] += 1;
    });
    return days.map((label, idx) => ({ label, count: counts[idx] }))
      .sort((a, b) => b.count - a.count);
  }, [trendRows]);

  const topDevices = useMemo(() => {
    const map = new Map<string, number>();
    (workOrders || []).forEach((wo: any) => {
      const device = (wo.productDescription || wo.device || wo.productCategory || 'Unknown device').toString().trim();
      if (!device) return;
      map.set(device, (map.get(device) || 0) + 1);
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, count]) => ({ label, count }));
  }, [workOrders]);

  const topRepairs = useMemo(() => {
    const map = new Map<string, number>();
    (workOrders || []).forEach((wo: any) => {
      const items = Array.isArray(wo.items) ? wo.items : [];
      items.forEach((it: any) => {
        const label = (it.repair || it.description || it.title || it.name || it.altDescription || '').toString().trim();
        if (!label) return;
        map.set(label, (map.get(label) || 0) + 1);
      });
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, count]) => ({ label, count }));
  }, [workOrders]);

  const reportHasAnyActivity = useMemo(() => {
    const anyTaken = (Number(dailyBatchSummary.totalTaken) || 0) > 0.009;
    const anyCounts = (Number(dailyBatchSummary.checkInCount) || 0) > 0 || (Number(dailyBatchSummary.closedTicketCount) || 0) > 0;
    const anyOrders = (Number(summary.woTotals.count) || 0) > 0 || (Number(summary.saTotals.count) || 0) > 0;
    const anyRemaining = (Number(summary.grandRemaining) || 0) > 0.009;
    return anyTaken || anyCounts || anyOrders || anyRemaining;
  }, [dailyBatchSummary.checkInCount, dailyBatchSummary.closedTicketCount, dailyBatchSummary.totalTaken, summary.grandRemaining, summary.saTotals.count, summary.woTotals.count]);

  const reportLines = useMemo(() => {
    const lines: string[] = [];
    if (!reportHasAnyActivity) return '';
    if (draftSettings.includePayments) {
      lines.push(`Total taken in: ${formatCurrency(dailyBatchSummary.totalTaken)}`);
      lines.push(`Card: ${formatCurrency(dailyBatchSummary.cardTotal)}`);
      lines.push(`Cash: ${formatCurrency(dailyBatchSummary.cashTotal)}`);
      lines.push(`Parts charged: ${formatCurrency(dailyBatchSummary.partsSold)} | Parts COGS: ${formatCurrency(dailyBatchSummary.partsCost)}`);
      lines.push(`Products sold: ${formatCurrency(dailyBatchSummary.productsSold)} | Product COGS: ${formatCurrency(dailyBatchSummary.productsCost)}`);
      lines.push(`Verified supplier spend: Parts ${formatCurrency(dailyBatchSummary.supplierSpendParts)} | Products ${formatCurrency(dailyBatchSummary.supplierSpendProducts)}`);
      lines.push(`Purchasing cart: ${partsPurchaseTotals.count} item(s) | Checkout total: ${formatCurrency(partsPurchaseTotals.checkoutCost)}`);
      if (partsPurchaseTotals.paymentWarnings || partsPurchaseTotals.missingCost) lines.push(`Purchasing warnings: ${partsPurchaseTotals.paymentWarnings} payment | ${partsPurchaseTotals.missingCost} missing cost`);
    }
    if (draftSettings.includeCounts) {
      lines.push(`Check-ins: ${dailyBatchSummary.checkInCount}`);
      lines.push(`Closed tickets: ${dailyBatchSummary.closedTicketCount}`);
    }
    if (draftSettings.includeWorkOrders) {
      lines.push(`Work orders: ${summary.woTotals.count} · Collected ${formatCurrency(summary.woTotals.collected)} · Remaining ${formatCurrency(summary.woTotals.remaining)}`);
    }
    if (draftSettings.includeSales) {
      lines.push(`Sales: ${summary.saTotals.count} · Collected ${formatCurrency(summary.saTotals.collected)} · Remaining ${formatCurrency(summary.saTotals.remaining)}`);
    }
    if (draftSettings.includeOutstanding) {
      lines.push(`Outstanding total: ${formatCurrency(summary.grandRemaining)}`);
    }
    if (draftSettings.includeBatchInfo && batchInfo) {
      const last = batchInfo?.lastBatchOutDate ? formatDate(batchInfo.lastBatchOutDate) : 'Not yet run';
      lines.push(`Last Batch Out: ${last}`);
    }
    return lines.filter(Boolean).join('\n');
  }, [batchInfo, dailyBatchSummary.cardTotal, dailyBatchSummary.cashTotal, dailyBatchSummary.checkInCount, dailyBatchSummary.closedTicketCount, dailyBatchSummary.partsCost, dailyBatchSummary.partsSold, dailyBatchSummary.productsCost, dailyBatchSummary.productsSold, dailyBatchSummary.supplierSpendParts, dailyBatchSummary.supplierSpendProducts, dailyBatchSummary.totalTaken, draftSettings.includeBatchInfo, draftSettings.includeCounts, draftSettings.includeOutstanding, draftSettings.includePayments, draftSettings.includeSales, draftSettings.includeWorkOrders, partsPurchaseTotals.checkoutCost, partsPurchaseTotals.count, partsPurchaseTotals.missingCost, partsPurchaseTotals.paymentWarnings, reportHasAnyActivity, summary.grandRemaining, summary.saTotals.collected, summary.saTotals.count, summary.saTotals.remaining, summary.woTotals.collected, summary.woTotals.count, summary.woTotals.remaining]);

  const presetBody = useMemo(() => {
    const header = `Batch report for ${rangeLabel(range, start, end)}`;
    if (!reportHasAnyActivity) return `${header}\n\nNo activity in range.`;
    return [header, reportLines].filter(Boolean).join('\n\n');
  }, [range, reportHasAnyActivity, reportLines, start, end]);

  const [trendEditor, setTrendEditor] = useState<'week' | 'month' | null>(null);
  const weekTrendsEnabled = useMemo(() => {
    const legacy = draftSettings.emailIncludeTrends !== false;
    return (draftSettings.emailIncludeTrendsWeek ?? legacy) !== false;
  }, [draftSettings.emailIncludeTrends, draftSettings.emailIncludeTrendsWeek]);

  const monthTrendsEnabled = useMemo(() => {
    const legacy = draftSettings.emailIncludeTrends !== false;
    return (draftSettings.emailIncludeTrendsMonth ?? legacy) !== false;
  }, [draftSettings.emailIncludeTrends, draftSettings.emailIncludeTrendsMonth]);

  const trendData = useMemo(() => {
    if (range !== 'thisWeek' && range !== 'thisMonth') return null;
    if (range === 'thisWeek' && !weekTrendsEnabled) return null;
    if (range === 'thisMonth' && !monthTrendsEnabled) return null;

    const startDay = new Date(start);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(end);
    endDay.setHours(0, 0, 0, 0);

    const dayRows: Array<{ day: Date; collected: number; transactions: number }> = [];
    for (let d = new Date(startDay); d.getTime() <= endDay.getTime(); d.setDate(d.getDate() + 1)) {
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(d);
      dayEnd.setHours(23, 59, 59, 999);
      const min = dayStart.getTime();
      const max = dayEnd.getTime();

      let collected = 0;
      let transactions = 0;
      unified.forEach(row => {
        const amt = collectedAmountInRange(row, min, max, row.date);
        if (amt > 0) {
          collected += amt;
          transactions += 1;
        }
      });
      dayRows.push({ day: new Date(dayStart), collected: round2(collected), transactions });
    }

    if (range === 'thisWeek') {
      const totalCollected = round2(dayRows.reduce((s, r) => s + r.collected, 0));
      const totalTx = dayRows.reduce((s, r) => s + r.transactions, 0);
      return { kind: 'week' as const, rows: dayRows, totalCollected, totalTx };
    }

    const weeks = new Map<string, { start: Date; end: Date; collected: number; transactions: number }>();
    dayRows.forEach(r => {
      const ws = startOfLocalWeek(r.day);
      const key = ws.toISOString();
      const existing = weeks.get(key);
      const we = new Date(ws);
      we.setDate(we.getDate() + 6);
      we.setHours(23, 59, 59, 999);
      if (!existing) {
        weeks.set(key, { start: ws, end: we, collected: r.collected, transactions: r.transactions });
      } else {
        existing.collected = round2(existing.collected + r.collected);
        existing.transactions += r.transactions;
      }
    });
    const orderedWeeks = Array.from(weeks.values()).sort((a, b) => a.start.getTime() - b.start.getTime());
    const totalCollected = round2(orderedWeeks.reduce((s, w) => s + w.collected, 0));
    const totalTx = orderedWeeks.reduce((s, w) => s + w.transactions, 0);
    return { kind: 'month' as const, rows: orderedWeeks, totalCollected, totalTx };
  }, [end, monthTrendsEnabled, range, start, unified, weekTrendsEnabled]);

  const trendSectionHtml = useMemo(() => {
    if (!trendData) return '';

    const startDay = new Date(start);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(end);
    endDay.setHours(0, 0, 0, 0);

    const dayRows: Array<{ day: Date; collected: number; transactions: number }> = [];
    for (let d = new Date(startDay); d.getTime() <= endDay.getTime(); d.setDate(d.getDate() + 1)) {
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(d);
      dayEnd.setHours(23, 59, 59, 999);
      const min = dayStart.getTime();
      const max = dayEnd.getTime();

      let collected = 0;
      let transactions = 0;
      unified.forEach(row => {
        const amt = collectedAmountInRange(row, min, max, row.date);
        if (amt > 0) {
          collected += amt;
          transactions += 1;
        }
      });

      dayRows.push({ day: new Date(dayStart), collected: round2(collected), transactions });
    }

    const tableStyle = 'border-collapse:collapse;width:100%;margin-top:8px;';
    const thStyle = 'text-align:left;padding:8px;border:1px solid #27272a;background:#111113;color:#39FF14;font-size:12px;';
    const tdStyle = 'padding:8px;border:1px solid #27272a;font-size:12px;color:#f8f8f8;';
    const sectionTitleStyle = 'margin-top:12px;font-size:13px;font-weight:700;color:#39FF14;';
    const subStyle = 'font-size:12px;color:#a1a1aa;margin-top:2px;';

    if (trendData.kind === 'week') {
      const rowsHtml = trendData.rows.map(r => {
        const label = r.day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        return `<tr>`
          + `<td style="${tdStyle}">${escapeHtml(label)}</td>`
          + `<td style="${tdStyle}">${escapeHtml(formatCurrency(r.collected))}</td>`
          + `<td style="${tdStyle}">${escapeHtml(String(r.transactions))}</td>`
          + `</tr>`;
      }).join('');

      return `
        <div style="${sectionTitleStyle}">Trends (This week)</div>
        <div style="${subStyle}">Daily collected totals across the selected week.</div>
        <table style="${tableStyle}">
          <thead>
            <tr>
              <th style="${thStyle}">Day</th>
              <th style="${thStyle}">Collected</th>
              <th style="${thStyle}">Transactions</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
            <tr>
              <td style="${tdStyle}"><b>Total</b></td>
              <td style="${tdStyle}"><b>${escapeHtml(formatCurrency(trendData.totalCollected))}</b></td>
              <td style="${tdStyle}"><b>${escapeHtml(String(trendData.totalTx))}</b></td>
            </tr>
          </tbody>
        </table>
      `;
    }

    const rowsHtml = trendData.rows.map(w => {
      const label = `${w.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${w.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      return `<tr>`
        + `<td style="${tdStyle}">${escapeHtml(label)}</td>`
        + `<td style="${tdStyle}">${escapeHtml(formatCurrency(w.collected))}</td>`
        + `<td style="${tdStyle}">${escapeHtml(String(w.transactions))}</td>`
        + `</tr>`;
    }).join('');

    return `
      <div style="${sectionTitleStyle}">Trends (This month)</div>
      <div style="${subStyle}">Week-by-week collected totals across the selected month.</div>
      <table style="${tableStyle}">
        <thead>
          <tr>
            <th style="${thStyle}">Week</th>
            <th style="${thStyle}">Collected</th>
            <th style="${thStyle}">Transactions</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
          <tr>
            <td style="${tdStyle}"><b>Total</b></td>
            <td style="${tdStyle}"><b>${escapeHtml(formatCurrency(trendData.totalCollected))}</b></td>
            <td style="${tdStyle}"><b>${escapeHtml(String(trendData.totalTx))}</b></td>
          </tr>
        </tbody>
      </table>
    `;
  }, [trendData]);

  const subject = useMemo(() => {
    return draftSettings.subject || 'Daily batch report';
  }, [draftSettings.subject]);

  const savedReportPrefs = useMemo(() => {
    return {
      recipients: savedSettings.recipients,
      subject: savedSettings.subject || '',
      includePayments: !!savedSettings.includePayments,
      includeCounts: !!savedSettings.includeCounts,
      includeBatchInfo: !!savedSettings.includeBatchInfo,
      includeWorkOrders: !!savedSettings.includeWorkOrders,
      includeSales: !!savedSettings.includeSales,
      includeOutstanding: !!savedSettings.includeOutstanding,
      emailIncludeTrends: savedSettings.emailIncludeTrends !== false,
      emailIncludeTrendsWeek: savedSettings.emailIncludeTrendsWeek,
      emailIncludeTrendsMonth: savedSettings.emailIncludeTrendsMonth,
      emailIncludeOpenTickets: !!savedSettings.emailIncludeOpenTickets,
      emailIncludeWorkOrdersDetails: !!savedSettings.emailIncludeWorkOrdersDetails,
      emailIncludeSalesDetails: !!savedSettings.emailIncludeSalesDetails,
      emailIncludeOutstandingDetails: !!savedSettings.emailIncludeOutstandingDetails,
      emailIncludeTechnicianSummary: !!savedSettings.emailIncludeTechnicianSummary,
    };
  }, [savedSettings.emailIncludeOpenTickets, savedSettings.emailIncludeOutstandingDetails, savedSettings.emailIncludeSalesDetails, savedSettings.emailIncludeTechnicianSummary, savedSettings.emailIncludeTrends, savedSettings.emailIncludeTrendsMonth, savedSettings.emailIncludeTrendsWeek, savedSettings.emailIncludeWorkOrdersDetails, savedSettings.includeBatchInfo, savedSettings.includeCounts, savedSettings.includeOutstanding, savedSettings.includePayments, savedSettings.includeSales, savedSettings.includeWorkOrders, savedSettings.recipients, savedSettings.subject]);

  const draftReportPrefs = useMemo(() => {
    return {
      recipients: draftSettings.recipients,
      subject: draftSettings.subject || '',
      includePayments: !!draftSettings.includePayments,
      includeCounts: !!draftSettings.includeCounts,
      includeBatchInfo: !!draftSettings.includeBatchInfo,
      includeWorkOrders: !!draftSettings.includeWorkOrders,
      includeSales: !!draftSettings.includeSales,
      includeOutstanding: !!draftSettings.includeOutstanding,
      emailIncludeTrends: draftSettings.emailIncludeTrends !== false,
      emailIncludeTrendsWeek: draftSettings.emailIncludeTrendsWeek,
      emailIncludeTrendsMonth: draftSettings.emailIncludeTrendsMonth,
      emailIncludeOpenTickets: !!draftSettings.emailIncludeOpenTickets,
      emailIncludeWorkOrdersDetails: !!draftSettings.emailIncludeWorkOrdersDetails,
      emailIncludeSalesDetails: !!draftSettings.emailIncludeSalesDetails,
      emailIncludeOutstandingDetails: !!draftSettings.emailIncludeOutstandingDetails,
      emailIncludeTechnicianSummary: !!draftSettings.emailIncludeTechnicianSummary,
    };
  }, [draftSettings.emailIncludeOpenTickets, draftSettings.emailIncludeOutstandingDetails, draftSettings.emailIncludeSalesDetails, draftSettings.emailIncludeTechnicianSummary, draftSettings.emailIncludeTrends, draftSettings.emailIncludeTrendsMonth, draftSettings.emailIncludeTrendsWeek, draftSettings.emailIncludeWorkOrdersDetails, draftSettings.includeBatchInfo, draftSettings.includeCounts, draftSettings.includeOutstanding, draftSettings.includePayments, draftSettings.includeSales, draftSettings.includeWorkOrders, draftSettings.recipients, draftSettings.subject]);

  const draftPrefsDirty = useMemo(() => {
    return JSON.stringify(draftReportPrefs) !== JSON.stringify(savedReportPrefs);
  }, [draftReportPrefs, savedReportPrefs]);

  const resetDraftToSaved = () => {
    setDraftSettings(s => ({ ...s, ...savedReportPrefs }));
  };

  const saveDraftAsDefault = () => {
    setSavedSettings(s => ({ ...s, ...draftReportPrefs }));
    setDraftSettings(s => ({ ...s, ...draftReportPrefs }));
  };

  const openEmailSettings = () => {
    setDraftSettings(current => ({
      ...current,
      recipients: savedSettings.recipients,
      subject: savedSettings.subject || 'Daily batch report',
    }));
    setShowEmailSettings(true);
  };

  const openBatchSettings = () => {
    setBatchSettingsDraft({
      schedule: savedSettings.schedule,
      sendTime: savedSettings.sendTime || '18:00',
      batchOutTime: savedSettings.batchOutTime || '21:00',
    });
    setShowBatchSettings(true);
  };

  const saveBatchSettings = () => {
    setSavedSettings(current => ({ ...current, ...batchSettingsDraft }));
    setShowBatchSettings(false);
  };

  const filteredLists = useMemo(() => {
    const workOrderRows = unified.filter(row => row.kind === 'work');
    const salesRows = unified.filter(row => row.kind === 'sale');
    const outstandingRows = unified.filter(row => row.remaining > 0.01);
    const collectedRows = workOrderRows.filter(row => (row.status || '').toLowerCase() === 'closed');

    const openTicketRows: UnifiedRow[] = [];
    const pushOpen = (kind: UnifiedRow['kind'], record: any) => {
      const normalized = normalizeRow(kind, record);
      if (!normalized) return;
      const st = (normalized.status || '').toLowerCase();
      const isClosed = st === 'closed';
      const needsCheckout = !normalized.checkoutDate;
      if (!isClosed || needsCheckout) {
        openTicketRows.push(normalized);
      }
    };
    (workOrders || []).forEach(wo => pushOpen('work', wo));
    (sales || []).forEach(sa => pushOpen('sale', sa));
    openTicketRows.sort((a, b) => a.date.getTime() - b.date.getTime());

    return {
      work: workOrderRows,
      sales: salesRows,
      outstanding: outstandingRows,
      collected: collectedRows,
      openTickets: openTicketRows,
    };
  }, [sales, unified, workOrders]);

  const unclosedTickets = useMemo(() => {
    type UnclosedTicket = {
      row: UnifiedRow;
      customerName: string;
      deviceName: string;
      lineItems: string;
      reasons: string[];
      repairCompleteSent: boolean;
    };
    const tickets: UnclosedTicket[] = [];
    const addTicket = (kind: UnifiedRow['kind'], record: any) => {
      const row = normalizeRow(kind, record);
      if (!row) return;
      const status = String(row.status || '').trim().toLowerCase();
      if (status === 'closed' && !!row.checkoutDate) return;

      const repairCompleteSent = kind === 'work' && hasRepairCompleteUpdate(record);
      const reasons: string[] = [];
      if (kind === 'work' && row.diagnosticLike && row.paid <= 0.01) reasons.push('Diagnostic fee not taken');
      if (row.paid > 0.01) reasons.push('Payment taken without checkout');
      if (repairCompleteSent) reasons.push('Repair Complete update sent while still open');
      if (!reasons.length) return;

      tickets.push({
        row,
        customerName: row.customerName || 'Client not recorded',
        deviceName: kind === 'work' ? recordDeviceName(record) : 'Sale',
        lineItems: recordLineItems(record),
        reasons,
        repairCompleteSent,
      });
    };

    (workOrders || []).forEach(record => addTicket('work', record));
    (sales || []).forEach(record => addTicket('sale', record));
    return tickets.sort((left, right) => Number(right.row.paid) - Number(left.row.paid));
  }, [sales, workOrders]);

  const [activeList, setActiveList] = useState<keyof typeof filteredLists | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const todayTaskDate = useMemo(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }, [reportDayKey]);
  const todayTasks = useMemo(() => calendarEvents
    .flatMap(event => event?.recurrenceRule ? expandRecurringEvent(event, todayTaskDate, todayTaskDate) : [event])
    .filter(event => event?.category === 'task' && String(event?.date || '').slice(0, 10) === todayTaskDate)
    .sort((left, right) => Number(taskIsCompleted(left)) - Number(taskIsCompleted(right)) || String(left?.title || '').localeCompare(String(right?.title || ''))), [calendarEvents, todayTaskDate]);
  const setEodTaskCompleted = useCallback(async (task: any, completed: boolean) => {
    if (task?.id == null) return;
    const master = task.recurrenceMaster || task;
    const previous = calendarEvents.find(row => String(row?.id) === String(master.id)) || master;
    const optimistic = taskCompletionPatch(master, completed, task.occurrenceDate || task.date || todayTaskDate, String(task?.technician || ''));
    setCalendarEvents(rows => rows.map(row => String(row?.id) === String(master.id) ? optimistic : row));
    try {
      const saved = await (window as any).api?.dbUpdate('calendarEvents', master.id, optimistic);
      if (!saved) throw new Error('Task update was not saved.');
      setCalendarEvents(rows => rows.map(row => String(row?.id) === String(master.id) ? saved : row));
    } catch (error) {
      setCalendarEvents(rows => rows.map(row => String(row?.id) === String(master.id) ? previous : row));
      console.error('EOD task completion failed', error);
    }
  }, [calendarEvents, todayTaskDate]);

  const listMeta = useMemo(() => {
    if (!activeList) return null;
    const titleMap: Record<keyof typeof filteredLists, string> = {
      work: 'Work orders in range',
      sales: 'Sales in range',
      outstanding: 'Outstanding balances',
      collected: 'Closed work orders (collected)',
      openTickets: 'Open tickets (not completed / not checked out)',
    };
    const rows = filteredLists[activeList];
    return {
      title: titleMap[activeList],
      rows,
    };
  }, [activeList, filteredLists]);

  const emailText = useMemo(() => {
    const parts: string[] = [];
    if (presetBody) parts.push(presetBody);

    const extras: string[] = [];
    if (draftSettings.emailIncludeWorkOrdersDetails) extras.push('Work orders table included');
    if (draftSettings.emailIncludeSalesDetails) extras.push('Sales table included');
    if (draftSettings.emailIncludeOutstandingDetails) extras.push('Outstanding balances table included');
    if (draftSettings.emailIncludeOpenTickets) extras.push('Open tickets table included');
    if (draftSettings.emailIncludeTechnicianSummary) extras.push('Technician summary included');
    if (extras.length) parts.push(`\nDetails: ${extras.join(' · ')}`);

    return parts.filter(Boolean).join('\n\n').trim();
  }, [draftSettings.emailIncludeOpenTickets, draftSettings.emailIncludeOutstandingDetails, draftSettings.emailIncludeSalesDetails, draftSettings.emailIncludeTechnicianSummary, draftSettings.emailIncludeWorkOrdersDetails, presetBody]);

  const emailDetailsHtml = useMemo(() => {
    const tableStyle = 'border-collapse:collapse;width:100%;margin-top:8px;';
    const thStyle = 'text-align:left;padding:8px;border:1px solid #27272a;background:#111113;color:#39FF14;font-size:12px;';
    const tdStyle = 'padding:8px;border:1px solid #27272a;font-size:12px;color:#f8f8f8;vertical-align:top;';
    const sectionTitleStyle = 'margin-top:14px;font-size:13px;font-weight:700;color:#39FF14;';
    const subStyle = 'font-size:12px;color:#a1a1aa;margin-top:2px;';

    const renderTable = (title: string, subtitle: string, headers: string[], rows: string[][]) => {
      if (!rows.length) return '';
      const head = headers.map(h => `<th style="${thStyle}">${escapeHtml(h)}</th>`).join('');
      const body = rows.map(r => `<tr>${r.map(cell => `<td style="${tdStyle}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
      return `
        <div style="${sectionTitleStyle}">${escapeHtml(title)}</div>
        ${subtitle ? `<div style="${subStyle}">${escapeHtml(subtitle)}</div>` : ''}
        <table style="${tableStyle}">
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      `;
    };

    const blocks: string[] = [];

    if (draftSettings.emailIncludeWorkOrdersDetails) {
      const rows = filteredLists.work.slice(0, 20).map(r => ([
        String(r.id ?? ''),
        r.date ? r.date.toLocaleDateString() : '',
        (r.customerName || '').toString(),
        formatCurrency(Number(r.total || 0) || 0),
        formatCurrency(Number(r.paid || 0) || 0),
        formatCurrency(Number(r.remaining || 0) || 0),
        (r.status || '').toString(),
      ]));
      blocks.push(renderTable('Work orders (in range)', 'Showing up to 20', ['Ticket', 'Date', 'Customer', 'Total', 'Paid', 'Remaining', 'Status'], rows));
    }

    if (draftSettings.emailIncludeSalesDetails) {
      const rows = filteredLists.sales.slice(0, 20).map(r => ([
        String(r.id ?? ''),
        r.date ? r.date.toLocaleDateString() : '',
        (r.customerName || '').toString(),
        (r.title || 'Sale').toString(),
        formatCurrency(Number(r.total || 0) || 0),
        formatCurrency(Number(r.paid || 0) || 0),
        formatCurrency(Number(r.remaining || 0) || 0),
      ]));
      blocks.push(renderTable('Sales (in range)', 'Showing up to 20', ['Ticket', 'Date', 'Customer', 'Item', 'Total', 'Paid', 'Remaining'], rows));
    }

    if (draftSettings.emailIncludeOutstandingDetails) {
      const sorted = [...filteredLists.outstanding].sort((a, b) => (Number(b.remaining || 0) || 0) - (Number(a.remaining || 0) || 0));
      const rows = sorted.slice(0, 20).map(r => ([
        `${r.kind === 'work' ? 'WO' : 'Sale'} ${String(r.id ?? '')}`,
        r.date ? r.date.toLocaleDateString() : '',
        (r.customerName || '').toString(),
        formatCurrency(Number(r.total || 0) || 0),
        formatCurrency(Number(r.paid || 0) || 0),
        formatCurrency(Number(r.remaining || 0) || 0),
      ]));
      blocks.push(renderTable('Outstanding balances', 'Showing up to 20 (highest remaining first)', ['Ticket', 'Date', 'Customer', 'Total', 'Paid', 'Remaining'], rows));
    }

    if (draftSettings.emailIncludeOpenTickets) {
      const rows = filteredLists.openTickets.slice(0, 20).map(r => ([
        `${r.kind === 'work' ? 'WO' : 'Sale'} ${String(r.id ?? '')}`,
        r.date ? r.date.toLocaleDateString() : '',
        (r.customerName || '').toString(),
        (r.status || '').toString(),
        r.checkoutDate ? 'Yes' : 'No',
        formatCurrency(Number(r.remaining || 0) || 0),
      ]));
      blocks.push(renderTable('Open tickets', 'Showing up to 20', ['Ticket', 'Date', 'Customer', 'Status', 'Checked out', 'Remaining'], rows));
    }

    if (draftSettings.emailIncludeTechnicianSummary) {
      const rows = technicianSummaryRows.slice(0, 10).map(r => ([
        (techAliasToCanonical.labelMap.get(r.tech) || r.tech || '').toString(),
        String(r.workOrders || 0),
        String(r.sales || 0),
        formatCurrency(Number(r.collected || 0) || 0),
        formatCurrency(Number(r.remaining || 0) || 0),
      ]));
      blocks.push(renderTable('Technician summary', 'Showing up to 10', ['Technician', 'Work', 'Sales', 'Collected', 'Remaining'], rows));
    }

    return blocks.filter(Boolean).join('');
  }, [draftSettings.emailIncludeOpenTickets, draftSettings.emailIncludeOutstandingDetails, draftSettings.emailIncludeSalesDetails, draftSettings.emailIncludeTechnicianSummary, draftSettings.emailIncludeWorkOrdersDetails, filteredLists.openTickets, filteredLists.outstanding, filteredLists.sales, filteredLists.work, techAliasToCanonical.labelMap, technicianSummaryRows]);

  const emailHtml = useMemo(() => {
    const wrapperStyle = 'font-family:Arial, sans-serif;font-size:13px;color:#f8f8f8;background:#0b0b0c;padding:12px;white-space:normal;';
    const headerStyle = 'font-size:14px;font-weight:700;color:#39FF14;margin-bottom:10px;';
    const tableStyle = 'border-collapse:collapse;width:100%;';
    const tdLabel = 'padding:6px 8px;border:1px solid #27272a;color:#a1a1aa;font-size:12px;width:220px;';
    const tdVal = 'padding:6px 8px;border:1px solid #27272a;color:#f8f8f8;font-size:12px;';

    const header = `Batch report for ${rangeLabel(range, start, end)}`;

    if (!reportHasAnyActivity) {
      const last = (draftSettings.includeBatchInfo && batchInfo)
        ? (batchInfo?.lastBatchOutDate ? formatDate(batchInfo.lastBatchOutDate) : 'Not yet run')
        : '';
      const extra = last ? `<div style="margin-top:10px;color:#a1a1aa;font-size:12px;">Last Batch Out: ${escapeHtml(last)}</div>` : '';
      return `<div style="${wrapperStyle}"><div style="${headerStyle}">${escapeHtml(header)}</div><div>No activity in range.</div>${extra}${trendSectionHtml}${emailDetailsHtml}</div>`;
    }

    const rows: Array<[string, string]> = [];
    if (draftSettings.includePayments) {
      rows.push(['Total taken in', formatCurrency(dailyBatchSummary.totalTaken)]);
      rows.push(['Card', formatCurrency(dailyBatchSummary.cardTotal)]);
      rows.push(['Cash', formatCurrency(dailyBatchSummary.cashTotal)]);
      rows.push(['Parts charged', formatCurrency(dailyBatchSummary.partsSold)]);
      rows.push(['Parts COGS', formatCurrency(dailyBatchSummary.partsCost)]);
      rows.push(['Products sold', formatCurrency(dailyBatchSummary.productsSold)]);
      rows.push(['Product COGS', formatCurrency(dailyBatchSummary.productsCost)]);
      rows.push(['Parts supplier spend', formatCurrency(dailyBatchSummary.supplierSpendParts)]);
      rows.push(['Products supplier spend', formatCurrency(dailyBatchSummary.supplierSpendProducts)]);
      rows.push(['Purchasing cart', `${partsPurchaseTotals.count} item(s)`]);
      rows.push(['Purchasing checkout total', formatCurrency(partsPurchaseTotals.checkoutCost)]);
      if (partsPurchaseTotals.paymentWarnings) rows.push(['Unverified item payments', String(partsPurchaseTotals.paymentWarnings)]);
      if (partsPurchaseTotals.missingCost) rows.push(['Missing item costs', String(partsPurchaseTotals.missingCost)]);
    }
    if (draftSettings.includeCounts) {
      rows.push(['Check-ins', String(dailyBatchSummary.checkInCount)]);
      rows.push(['Closed tickets', String(dailyBatchSummary.closedTicketCount)]);
    }
    if (draftSettings.includeWorkOrders) {
      rows.push(['Work orders', `${summary.woTotals.count} · Collected ${formatCurrency(summary.woTotals.collected)} · Remaining ${formatCurrency(summary.woTotals.remaining)}`]);
    }
    if (draftSettings.includeSales) {
      rows.push(['Sales', `${summary.saTotals.count} · Collected ${formatCurrency(summary.saTotals.collected)} · Remaining ${formatCurrency(summary.saTotals.remaining)}`]);
    }
    if (draftSettings.includeOutstanding) {
      rows.push(['Outstanding total', formatCurrency(summary.grandRemaining)]);
    }
    if (draftSettings.includeBatchInfo && batchInfo) {
      const last = batchInfo?.lastBatchOutDate ? formatDate(batchInfo.lastBatchOutDate) : 'Not yet run';
      rows.push(['Last Batch Out', last]);
    }

    const body = rows
      .map(([k, v]) => `<tr><td style="${tdLabel}">${escapeHtml(k)}</td><td style="${tdVal}">${escapeHtml(v)}</td></tr>`)
      .join('');

    return `<div style="${wrapperStyle}"><div style="${headerStyle}">${escapeHtml(header)}</div><table style="${tableStyle}"><tbody>${body}</tbody></table>${trendSectionHtml}${emailDetailsHtml}</div>`;
  }, [batchInfo, dailyBatchSummary.cardTotal, dailyBatchSummary.cashTotal, dailyBatchSummary.checkInCount, dailyBatchSummary.closedTicketCount, dailyBatchSummary.partsCost, dailyBatchSummary.partsSold, dailyBatchSummary.productsCost, dailyBatchSummary.productsSold, dailyBatchSummary.supplierSpendParts, dailyBatchSummary.supplierSpendProducts, dailyBatchSummary.totalTaken, draftSettings.includeBatchInfo, draftSettings.includeCounts, draftSettings.includeOutstanding, draftSettings.includePayments, draftSettings.includeSales, draftSettings.includeWorkOrders, emailDetailsHtml, end, partsPurchaseTotals.checkoutCost, partsPurchaseTotals.count, partsPurchaseTotals.missingCost, partsPurchaseTotals.paymentWarnings, range, reportHasAnyActivity, start, summary.grandRemaining, summary.saTotals.collected, summary.saTotals.count, summary.saTotals.remaining, summary.woTotals.collected, summary.woTotals.count, summary.woTotals.remaining, trendSectionHtml]);

  async function handleRowOpen(row: UnifiedRow) {
    const api = (window as any).api;
    if (!api) return;
    try {
      if (row.kind === 'work') {
        if (!api?.openNewWorkOrder) return;
        await api.openNewWorkOrder({ workOrderId: row.id });
      } else {
        if (!api?.openNewSale) return;
        await api.openNewSale({ id: row.id });
      }
    } catch (err) {
      console.error('Failed to open record', err);
    }
  }

  async function handleCloseTicket(row: UnifiedRow) {
    if (closingTicket) return;
    const api = (window as any).api;
    if (!api?.dbUpdate) {
      setTicketActionMessage('Ticket checkout is unavailable on this installation.');
      return;
    }
    const source = row.kind === 'work' ? workOrders : sales;
    const record = source.find((candidate: any) => String(candidate?.id) === String(row.id));
    if (!record) {
      setTicketActionMessage('The ticket could not be found. Refresh EOD Report and try again.');
      return;
    }

    setClosingTicket(true);
    setTicketActionMessage('');
    try {
      const now = new Date().toISOString();
      const preservedPayments = collectPayments(record);
      const next = {
        ...record,
        status: 'closed',
        checkoutDate: now,
        activityAt: now,
        updatedAt: now,
        payments: preservedPayments,
      };
      const saved = await api.dbUpdate(row.kind === 'work' ? 'workOrders' : 'sales', record.id, next);
      const persisted = saved || next;
      if (row.kind === 'work') {
        setWorkOrders(current => current.map(item => String(item?.id) === String(row.id) ? persisted : item));
      } else {
        setSales(current => current.map(item => String(item?.id) === String(row.id) ? persisted : item));
      }
      setCloseTicketCandidate(null);
      setTicketActionMessage(`${row.kind === 'work' ? 'Work order' : 'Sale'} #${String(row.id)} was closed. ${formatCurrency(row.remaining)} remains due and was not added to today's collected totals.`);
    } catch (err) {
      console.error('Failed to close EOD ticket', err);
      setTicketActionMessage('The ticket could not be closed. No payment or totals were changed.');
    } finally {
      setClosingTicket(false);
    }
  }

  const ticketContextItems = useMemo<ContextMenuItem[]>(() => {
    const row = ticketContext.state.data;
    if (!row) return [];
    const alreadyClosed = String(row.status || '').toLowerCase() === 'closed' && !!row.checkoutDate;
    return [
      { type: 'header', label: `${row.kind === 'work' ? 'Work Order' : 'Sale'} #${String(row.id)}` },
      { label: 'Open Invoice', onClick: () => handleRowOpen(row) },
      { type: 'separator' },
      { label: 'Close Ticket', disabled: alreadyClosed, onClick: () => setCloseTicketCandidate(row) },
    ];
  }, [ticketContext.state.data]);

  async function handleSend() {
    if (sending) return;
    const recipients = (draftSettings.recipients || '').split(/[;,]/).map(r => r.trim()).filter(Boolean);
    if (!recipients.length) { alert('Add at least one recipient'); return; }
    setSending(true);
    try {
      const api = (window as any).api;
      if (!api?.emailSendReportHtml) {
        window.location.href = `mailto:${encodeURIComponent(recipients.join(','))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailText)}`;
        return;
      }
      const sentAtIso = new Date().toISOString();
      let text = emailText;
      let html = emailHtml;
      if (draftSettings.includeBatchInfo) {
        const stamp = `Sent: ${formatDate(sentAtIso)}`;
        text = [text, stamp].filter(Boolean).join('\n\n');
        html = `${html}<div style="margin-top:10px;color:#a1a1aa;font-size:12px;">${escapeHtml(stamp)}</div>`;
      }
      for (const to of recipients) {
        const result = await api.emailSendReportHtml({ to, subject, bodyText: text, html });
        if (result?.ok === false) {
          window.location.href = `mailto:${encodeURIComponent(recipients.join(','))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
          return;
        }
      }
      setSavedSettings(s => ({ ...s, lastSentAt: sentAtIso }));
      alert('Report sent');
    } catch (e) {
      console.error('Report send failed', e);
      alert('Send failed. Check console for details.');
    } finally {
      setSending(false);
    }
  }

  async function handleBatchOutNow() {
    try {
      setSending(true);
      const res = await (window as any).api.runBatchOut?.();
      if (res?.ok) {
        const info = await (window as any).api.getBatchOutInfo?.();
        if (info) setBatchInfo(info);
        alert('Batch Out complete. Backup saved.');
      } else {
        alert(res?.error || 'Batch Out failed.');
      }
    } catch (e) {
      console.error('Batch Out failed', e);
      alert('Batch Out failed. See console for details.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="gb-eod-window min-h-screen bg-zinc-900 p-3 text-zinc-50 sm:p-4 lg:h-screen lg:min-h-0 lg:overflow-hidden lg:p-4">
      <div className="gb-eod-shell mx-auto flex max-w-[1600px] flex-col gap-3 lg:h-full lg:min-h-0">
        <div className="gb-eod-header flex shrink-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {viewMode === 'trends' && (
              <button
                className="mt-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded hover:border-[#39FF14]"
                onClick={() => setViewMode('reports')}
              >← Back</button>
            )}
            <div>
              <div className="text-sm uppercase tracking-[0.2em] text-zinc-500">Shop closeout</div>
              <h1 className="text-3xl font-bold text-[#39FF14]">{viewMode === 'trends' ? 'Trends & Insights' : 'End of Day Report'}</h1>
              <p className="text-zinc-400 text-sm max-w-2xl">{viewMode === 'trends'
                ? 'Review monthly volume, busy days, and popular devices/repairs at a glance.'
                : `Current business day: ${formatDate(start)} through ${formatDate(end)}. Historical and monthly analysis remains in Reporting.`}
              </p>
            </div>
          </div>
          <div className="gb-eod-primary-actions grid w-full grid-cols-2 gap-2 md:w-auto md:min-w-[420px]">
            {viewMode === 'reports' && (
              <>
                <button
                  className="min-h-11 px-3 py-2 text-sm font-semibold bg-[#BC13FE] text-white border border-[#d45cff] rounded hover:brightness-110"
                  onClick={() => setShowCart(true)}
                >Cart ({partsPurchaseTotals.count})</button>
                <button
                  className="min-h-11 px-3 py-2 text-sm font-semibold bg-amber-500 text-black border border-amber-400 rounded hover:brightness-110"
                  onClick={openEmailSettings}
                >EOD Report Email</button>
                <button
                  className="col-span-2 min-h-10 px-3 py-2 text-sm font-semibold bg-[#39FF14] text-black border border-[#39FF14] rounded hover:brightness-110"
                  onClick={() => handleBatchOutNow()}
                  disabled={sending}
                >Batch Out now</button>
              </>
            )}
          </div>
        </div>

        {viewMode === 'reports' ? (
          <div className="gb-eod-dashboard space-y-3 lg:min-h-0 lg:flex-1 lg:overflow-hidden">
            <div className="grid grid-cols-1 gap-3 lg:h-full lg:min-h-0 lg:grid-cols-12">
              <div className="col-span-12 grid min-h-0 gap-3 lg:col-span-4 lg:grid-rows-2">
              <div className="gb-eod-low-stock flex min-h-0 flex-col overflow-hidden rounded-lg border border-amber-500/40 bg-zinc-950 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
                <header className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-800 px-3 py-3">
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-amber-300">Low Stock</h3>
                    <div className="text-xs text-zinc-400">Select an item to restock, dismiss, or inspect it.</div>
                  </div>
                  <span className={`w-fit shrink-0 rounded border px-2.5 py-1 text-xs font-semibold ${lowStockInventory.length ? 'border-amber-500/50 bg-amber-950/40 text-amber-200' : 'border-[#39FF14]/40 bg-[#39FF14]/10 text-[#39FF14]'}`}>
                    {lowStockInventory.length ? `${lowStockInventory.length} need attention` : 'Stock levels clear'}
                  </span>
                </header>
                {lowStockMessage ? <div className="border-b border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-200">{lowStockMessage}</div> : null}
                {lowStockInventory.length ? (
                  <div className="gb-eod-low-stock-list min-h-0 divide-y divide-zinc-800 lg:max-h-[34rem] lg:overflow-y-auto">
                    {lowStockInventory.map((item: any) => {
                      const inCart = pendingLowStockInventoryIds.has(Number(item.id));
                      return (
                        <button key={item.id} type="button" className="gb-eod-low-stock-row grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left transition hover:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-amber-400" onClick={() => setSelectedLowStockItem(item)}>
                          <span className="min-w-0">
                            <strong className="block truncate text-sm text-white">{item.itemDescription || 'Untitled inventory item'}</strong>
                            <span className="block truncate text-[11px] text-zinc-500">{item.itemType || 'Item'}{item.deviceModel ? ` | ${item.deviceModel}` : item.category ? ` | ${item.category}` : ''}{item.distributor ? ` | ${item.distributor}` : ''}</span>
                            <span className="mt-1 block text-[11px] text-zinc-400">On hand <strong className="text-amber-200">{Math.max(0, Number(item.stockCount) || 0)}</strong> / alert {Math.max(0, Number(item.lowStockThreshold) || 0)} / MOQ {inventoryReorderQuantity(item)}</span>
                          </span>
                          <span className={`rounded border px-2 py-1 text-center text-[11px] font-semibold ${inCart ? 'border-[#39FF14]/40 bg-[#39FF14]/10 text-[#39FF14]' : 'border-amber-500/40 bg-amber-950/30 text-amber-200'}`}>{inCart ? 'In Cart' : 'Review'}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : <div className="flex min-h-28 items-center justify-center px-4 py-5 text-center text-sm text-zinc-500">No tracked inventory is currently at or below its saved threshold.</div>}
                <div className="mt-auto border-t border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
                  The business day rolls forward at the saved Batch Out time. Reporting history is not altered.
                </div>
              </div>
              <div className="gb-eod-deliveries flex min-h-0 flex-col overflow-hidden rounded-lg border border-sky-500/40 bg-zinc-950 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
                <header className="flex items-start justify-between gap-2 border-b border-zinc-800 px-3 py-3">
                  <div className="min-w-0"><h3 className="text-lg font-semibold text-sky-300">Deliveries</h3><div className="text-xs text-zinc-400">Purchased items waiting to be marked as arrived.</div></div>
                  <span className="shrink-0 rounded border border-sky-500/40 bg-sky-950/40 px-2.5 py-1 text-xs font-semibold text-sky-200">{pendingDeliveries.length}</span>
                </header>
                {deliveryMessage ? <div className="border-b border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-200">{deliveryMessage}</div> : null}
                {pendingDeliveries.length ? <div className="min-h-0 flex-1 divide-y divide-zinc-800 overflow-y-auto">
                  {pendingDeliveries.map((purchase: any) => <div key={purchase.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5">
                    <div className="min-w-0"><strong className="block truncate text-sm text-white">{purchase.title || 'Ordered item'}</strong><span className="block truncate text-[11px] text-zinc-500">{purchase.customer || `${purchase.sourceType === 'workOrder' ? 'WO' : 'Sale'} #${purchase.sourceId}`}{purchase.estimatedDelivery ? ` | Expected ${purchase.estimatedDelivery}` : ''}</span></div>
                    <button type="button" className="rounded border border-sky-400/50 bg-sky-500 px-2.5 py-1.5 text-xs font-bold text-black disabled:opacity-50" disabled={deliveryBusyId != null} onClick={() => { void markPurchaseDelivered(purchase); }}>{deliveryBusyId === Number(purchase.id) ? 'Saving...' : 'Mark Delivered'}</button>
                  </div>)}
                </div> : <div className="flex min-h-24 flex-1 items-center justify-center px-4 py-5 text-center text-sm text-zinc-500">No purchased client items are waiting for delivery.</div>}
              </div>
              </div>

              <div className="col-span-12 min-h-0 overflow-hidden lg:col-span-4 bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-col gap-2 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Batch totals</h3>
                  <span className="text-xs text-zinc-500">{loadingData ? '...' : rangeLabel(range, start, end)}</span>
                </div>
                <div className="rounded border border-violet-500/40 bg-violet-950/20 p-2 text-sm"><div className="flex flex-wrap items-end gap-2"><label className="min-w-44 flex-1 text-xs text-violet-200">Clover actual total<input aria-label="Clover actual total" type="number" min="0" step="0.01" className="mt-1 w-full rounded border border-violet-400/40 bg-zinc-950 px-2 py-1.5 text-sm text-white" value={cloverTotalDraft} onChange={event => setCloverTotalDraft(event.target.value)} placeholder="Enter Clover total" /></label><button type="button" className="rounded border border-violet-300/50 bg-violet-500 px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50" disabled={cloverSaving || !cloverTotalDraft.trim()} onClick={() => { void saveCloverTotal(); }}>{cloverSaving ? 'Saving…' : 'Reconcile'}</button></div><p className="mt-1 text-[11px] text-zinc-400">Enter the total from Clover. Any difference from POS checkouts is sent to Needs Attention.</p></div>
                <div className="grid min-h-0 grid-cols-2 gap-2 overflow-y-auto pr-1 text-sm">
                  <div className="col-span-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Payments received</div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Total taken in</div>
                    <div className="text-xl font-semibold">{formatCurrency(dailyBatchSummary.totalTaken)}</div>
                    <div className="text-[11px] text-zinc-400">cash plus card today</div>
                  </div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Card</div>
                    <div className="text-xl font-semibold">{formatCurrency(dailyBatchSummary.cardTotal)}</div>
                    <div className="text-[11px] text-zinc-400">non-cash intake today</div>
                  </div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Cash</div>
                    <div className="text-xl font-semibold">{formatCurrency(dailyBatchSummary.cashTotal)}</div>
                    <div className="text-[11px] text-zinc-400">after change given</div>
                  </div>
                  <div className="col-span-2 mt-1 border-t border-zinc-800 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Revenue and cost</div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Labor billed</div>
                    <div className="text-xl font-semibold">{formatCurrency(dailyBatchSummary.laborSold)}</div>
                    <div className="text-[11px] text-zinc-400">customer labor charges</div>
                  </div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Parts charged</div>
                    <div className="text-xl font-semibold">{formatCurrency(dailyBatchSummary.partsSold)}</div>
                    <div className="text-[11px] text-zinc-400">parts billed on work orders</div>
                  </div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Parts COGS</div>
                    <div className="text-xl font-semibold">{formatCurrency(dailyBatchSummary.partsCost)}</div>
                    <div className="text-[11px] text-zinc-400">saved internal part costs</div>
                  </div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Products sold</div>
                    <div className="text-xl font-semibold">{formatCurrency(dailyBatchSummary.productsSold)}</div>
                    <div className="text-[11px] text-zinc-400">sales item totals</div>
                  </div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Product COGS</div>
                    <div className="text-xl font-semibold">{formatCurrency(dailyBatchSummary.productsCost)}</div>
                    <div className="text-[11px] text-zinc-400">saved internal product costs</div>
                  </div>
                  <div className="col-span-2 mt-1 border-t border-zinc-800 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Supplier checkout</div>
                  <div className="bg-zinc-800 border border-amber-500/40 rounded p-2">
                    <div className="text-xs text-zinc-500">Parts supplier spend</div>
                    <div className="text-xl font-semibold text-amber-300">{formatCurrency(dailyBatchSummary.supplierSpendParts)}</div>
                    <div className="text-[11px] text-zinc-400">verified checkouts today</div>
                  </div>
                  <div className="bg-zinc-800 border border-amber-500/40 rounded p-2">
                    <div className="text-xs text-zinc-500">Products supplier spend</div>
                    <div className="text-xl font-semibold text-amber-300">{formatCurrency(dailyBatchSummary.supplierSpendProducts)}</div>
                    <div className="text-[11px] text-zinc-400">verified checkouts today</div>
                  </div>
                  <div className="col-span-2 mt-1 border-t border-zinc-800 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Ticket intake</div>
                  <div className="bg-zinc-800 border border-zinc-700 rounded p-2">
                    <div className="text-xs text-zinc-500">Check-ins</div>
                    <div className="text-xl font-semibold">{dailyBatchSummary.checkInCount}</div>
                    <div className="text-[11px] text-zinc-400">new tickets checked in</div>
                  </div>
                </div>
              </div>

              <div className={`gb-eod-activity col-span-12 min-h-0 overflow-hidden lg:col-span-4 bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-col gap-2 shadow-[0_10px_40px_rgba(0,0,0,0.35)]${activityExpanded ? ' is-expanded' : ''}`}>
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Activity drill-down</h3>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">{loadingData ? '...' : `${summary.woTotals.count + summary.saTotals.count} records`}</span>
                    <button type="button" className="gb-eod-activity-expand rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-semibold hover:border-[#39FF14]" onClick={() => setActivityExpanded(value => !value)}>{activityExpanded ? 'Collapse' : 'Expand'}</button>
                  </div>
                </div>
                {ticketActionMessage ? <div className="rounded border border-[#39FF14]/30 bg-[#39FF14]/5 px-3 py-2 text-[11px] text-zinc-200">{ticketActionMessage}</div> : null}
                {activityExpanded ? <section className={`gb-eod-tickets-not-closed shrink-0 rounded border p-2 ${filteredLists.openTickets.length ? 'border-amber-500/60 bg-amber-950/20' : 'border-[#39FF14]/30 bg-[#39FF14]/5'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className={`text-sm font-semibold ${filteredLists.openTickets.length ? 'text-amber-200' : 'text-[#39FF14]'}`}>Tickets Not Closed</h4>
                      <p className="text-[11px] text-zinc-400">Every work order or sale that is still open or has not completed checkout.</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`rounded border px-2 py-1 text-xs font-semibold ${filteredLists.openTickets.length ? 'border-amber-500/50 bg-amber-950/50 text-amber-200' : 'border-[#39FF14]/40 bg-[#39FF14]/10 text-[#39FF14]'}`}>{filteredLists.openTickets.length}</span>
                      <button type="button" className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-semibold hover:border-[#39FF14]" onClick={() => setActiveList('openTickets')}>View Tickets</button>
                    </div>
                  </div>
                </section> : null}
                {activityExpanded && unclosedTickets.length ? <section className="gb-eod-open-ticket-warning min-h-0 rounded border border-red-500/60 bg-red-950/20 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h4 className={`text-sm font-semibold ${unclosedTickets.length ? 'text-red-200' : 'text-[#39FF14]'}`}>Open Ticket Warnings</h4>
                      <p className="text-[11px] text-zinc-400">Diagnostic, paid, or repair-complete tickets that still need checkout review.</p>
                    </div>
                    <span className={`shrink-0 rounded border px-2 py-1 text-xs font-semibold ${unclosedTickets.length ? 'border-red-500/50 bg-red-950/50 text-red-200' : 'border-[#39FF14]/40 bg-[#39FF14]/10 text-[#39FF14]'}`}>{unclosedTickets.length}</span>
                  </div>
                  <div className="mt-2 max-h-52 overflow-y-auto rounded border border-red-900/50">
                      <table className="w-full text-left text-[11px]">
                        <thead className="sticky top-0 z-[1] bg-zinc-950 text-zinc-400">
                          <tr><th className="px-2 py-1.5 font-medium">Client / device</th><th className="px-2 py-1.5 font-medium">Items</th><th className="px-2 py-1.5 text-right font-medium">Taken</th><th className="px-2 py-1.5 text-right font-medium">Owed</th></tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800">
                          {unclosedTickets.map(ticket => (
                            <tr
                              key={`${ticket.row.kind}-${String(ticket.row.id)}`}
                              className={`${ticket.repairCompleteSent ? 'bg-red-950/30' : ''} cursor-pointer hover:bg-zinc-800/70`}
                              title="Double-click to open. Right-click or hold for options."
                              onDoubleClick={() => { void handleRowOpen(ticket.row); }}
                              onContextMenu={event => ticketContext.openFromEvent(event, ticket.row)}
                            >
                              <td className="px-2 py-1.5 align-top"><div className="font-semibold text-zinc-100">{ticket.customerName}</div><div className="text-zinc-400">{ticket.deviceName} - #{String(ticket.row.id)}</div><div className="mt-0.5 text-amber-200">{ticket.reasons.join(' - ')}</div></td>
                              <td className="max-w-36 px-2 py-1.5 align-top text-zinc-300">{ticket.lineItems}</td>
                              <td className="px-2 py-1.5 text-right align-top tabular-nums text-[#39FF14]">{formatCurrency(ticket.row.paid)}</td>
                              <td className="px-2 py-1.5 text-right align-top tabular-nums text-amber-200">{formatCurrency(ticket.row.remaining)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                  </div>
                </section> : null}
                <div className="min-h-0 overflow-y-auto grid grid-cols-2 gap-2 text-sm">
                  <div className="col-span-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Records and balances</div>
                  <button
                    type="button"
                    className={`text-left bg-zinc-800 border border-zinc-700 rounded p-2 transition ${activeList === 'work' ? 'border-[#39FF14] shadow-[0_0_0_1px_rgba(57,255,20,0.25)]' : 'hover:border-[#39FF14] hover:shadow-[0_0_0_1px_rgba(57,255,20,0.1)]'}`}
                    onClick={() => setActiveList(prev => (prev === 'work' ? null : 'work'))}
                  >
                    <div className="text-xs text-zinc-500">Work orders</div>
                    <div className="text-xl font-semibold">{summary.woTotals.count}</div>
                    <div className="text-[11px] text-zinc-400">{formatCurrency(summary.woTotals.collected)} collected</div>
                  </button>
                  <button
                    type="button"
                    className={`text-left bg-zinc-800 border border-zinc-700 rounded p-2 transition ${activeList === 'sales' ? 'border-[#39FF14] shadow-[0_0_0_1px_rgba(57,255,20,0.25)]' : 'hover:border-[#39FF14] hover:shadow-[0_0_0_1px_rgba(57,255,20,0.1)]'}`}
                    onClick={() => setActiveList(prev => (prev === 'sales' ? null : 'sales'))}
                  >
                    <div className="text-xs text-zinc-500">Sales</div>
                    <div className="text-xl font-semibold">{summary.saTotals.count}</div>
                    <div className="text-[11px] text-zinc-400">{formatCurrency(summary.saTotals.collected)} collected</div>
                  </button>
                  <button
                    type="button"
                    className={`text-left bg-zinc-800 border border-zinc-700 rounded p-2 transition ${activeList === 'collected' ? 'border-[#39FF14] shadow-[0_0_0_1px_rgba(57,255,20,0.25)]' : 'hover:border-[#39FF14] hover:shadow-[0_0_0_1px_rgba(57,255,20,0.1)]'}`}
                    onClick={() => setActiveList(prev => (prev === 'collected' ? null : 'collected'))}
                  >
                    <div className="text-xs text-zinc-500">Collected (closed)</div>
                    <div className="text-xl font-semibold">{formatCurrency(filteredLists.collected.reduce((sum, row) => sum + row.paid, 0))}</div>
                    <div className="text-[11px] text-zinc-400">{filteredLists.collected.length} closed</div>
                  </button>
                  <button
                    type="button"
                    className={`text-left bg-zinc-800 border border-zinc-700 rounded p-2 transition ${activeList === 'outstanding' ? 'border-[#39FF14] shadow-[0_0_0_1px_rgba(57,255,20,0.25)]' : 'hover:border-[#39FF14] hover:shadow-[0_0_0_1px_rgba(57,255,20,0.1)]'}`}
                    onClick={() => setActiveList(prev => (prev === 'outstanding' ? null : 'outstanding'))}
                  >
                    <div className="text-xs text-zinc-500">Outstanding</div>
                    <div className="text-xl font-semibold text-orange-300">{formatCurrency(summary.grandRemaining)}</div>
                    <div className="text-[11px] text-zinc-400">{filteredLists.outstanding.length} with balance</div>
                  </button>
                  <div className="col-span-2 mt-1 border-t border-zinc-800 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Ticket status</div>
                  {activityExpanded ? <button
                    type="button"
                    className={`col-span-2 text-left bg-zinc-800 border border-zinc-700 rounded p-2 transition ${activeList === 'openTickets' ? 'border-[#39FF14] shadow-[0_0_0_1px_rgba(57,255,20,0.25)]' : 'hover:border-[#39FF14] hover:shadow-[0_0_0_1px_rgba(57,255,20,0.1)]'}`}
                    onClick={() => setActiveList(prev => (prev === 'openTickets' ? null : 'openTickets'))}
                  >
                    <div className="text-xs text-zinc-500">Tickets Not Closed</div>
                    <div className="text-xl font-semibold">{filteredLists.openTickets.length}</div>
                    <div className="text-[11px] text-zinc-400">Open the list to review, open invoices, or close tickets.</div>
                  </button> : null}
                  <button
                    type="button"
                    className={`text-left bg-zinc-800 border border-zinc-700 rounded p-2 transition ${activeList === 'collected' ? 'border-[#39FF14] shadow-[0_0_0_1px_rgba(57,255,20,0.25)]' : 'hover:border-[#39FF14] hover:shadow-[0_0_0_1px_rgba(57,255,20,0.1)]'}`}
                    onClick={() => setActiveList(prev => (prev === 'collected' ? null : 'collected'))}
                  >
                    <div className="text-xs text-zinc-500">Closed tickets</div>
                    <div className="text-xl font-semibold">{dailyBatchSummary.closedTicketCount}</div>
                    <div className="text-[11px] text-zinc-400">closed in this business day</div>
                  </button>
                  <div className="col-span-2 pt-2 border-t border-zinc-800 text-xs text-zinc-400">Last Batch Out: {batchInfo?.lastBatchOutDate ? formatDate(batchInfo.lastBatchOutDate) : 'Not yet run'}</div>
                  <section className="col-span-2 mt-1 rounded-lg border border-violet-500/40 bg-violet-950/20 p-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div><h4 className="text-sm font-semibold text-violet-100">Technician Task Checklist</h4><p className="text-[11px] text-zinc-400">Today’s Calendar tasks update everywhere when checked.</p></div>
                      <span className="shrink-0 rounded border border-violet-400/40 bg-violet-950/50 px-2 py-1 text-[11px] font-semibold text-violet-100">{todayTasks.filter(task => !taskIsCompleted(task)).length} open</span>
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {todayTasks.map(task => <label key={String(task.id)} className={`flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2 text-left ${taskIsCompleted(task) ? 'border-zinc-700 bg-zinc-900/50 text-zinc-500' : 'border-violet-500/30 bg-zinc-900 text-zinc-100 hover:border-violet-400'}`}>
                        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-violet-400" checked={taskIsCompleted(task)} onChange={event => void setEodTaskCompleted(task, event.target.checked)} />
                        <span className="min-w-0"><strong className={`block truncate text-xs ${taskIsCompleted(task) ? 'line-through' : ''}`}>{task.title || 'Untitled task'}</strong><small className="block truncate text-[10px] text-zinc-500">{taskAssignmentLabel(task.technician)}</small></span>
                      </label>)}
                      {!todayTasks.length ? <p className="rounded border border-dashed border-zinc-700 px-3 py-3 text-center text-xs text-zinc-500">No technician tasks scheduled for today.</p> : null}
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {selectedLowStockItem ? (
              <div className="fixed inset-0 z-[100110] flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-4" onClick={() => setSelectedLowStockItem(null)}>
                <section className="gb-eod-low-stock-actions w-full max-w-xl rounded-t-lg border border-amber-500/50 bg-zinc-950 p-4 shadow-[0_24px_90px_rgba(0,0,0,0.75)] sm:rounded-lg" role="dialog" aria-modal="true" aria-label="Low stock item actions" onClick={event => event.stopPropagation()}>
                  <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-600 sm:hidden" />
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><div className="text-[11px] font-semibold uppercase text-amber-300">Low stock</div><h3 className="truncate text-xl font-semibold text-white">{selectedLowStockItem.itemDescription}</h3><p className="mt-1 text-xs text-zinc-400">{Math.max(0, Number(selectedLowStockItem.stockCount) || 0)} on hand | alert at {Math.max(0, Number(selectedLowStockItem.lowStockThreshold) || 0)} | MOQ {inventoryReorderQuantity(selectedLowStockItem)}</p></div>
                    <button type="button" className="h-9 w-9 shrink-0 rounded border border-zinc-700 bg-zinc-900 text-lg" aria-label="Close low stock actions" onClick={() => setSelectedLowStockItem(null)}>x</button>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <button type="button" disabled={lowStockBusy} className="rounded border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm font-semibold disabled:opacity-40" onClick={() => dismissLowStockItem(selectedLowStockItem)}>Dismiss</button>
                    <button type="button" disabled={lowStockBusy || pendingLowStockInventoryIds.has(Number(selectedLowStockItem.id))} className="rounded bg-amber-500 px-4 py-3 text-sm font-semibold text-black disabled:opacity-40" onClick={() => void addLowStockMoqToCart(selectedLowStockItem)}>{pendingLowStockInventoryIds.has(Number(selectedLowStockItem.id)) ? 'Already in Cart' : `Add MOQ (${inventoryReorderQuantity(selectedLowStockItem)}) to Cart`}</button>
                    <button type="button" disabled={lowStockBusy} className="rounded bg-[#39FF14] px-4 py-3 text-sm font-semibold text-black disabled:opacity-40" onClick={() => void viewLowStockItem(selectedLowStockItem)}>View Item</button>
                  </div>
                </section>
              </div>
            ) : null}

            {showCart ? (
              <div className="fixed inset-0 z-[100100] flex items-start justify-center overflow-x-hidden overflow-y-auto bg-black/80 p-2 sm:p-4" onClick={() => setShowCart(false)}>
                <section className="gb-eod-cart-dialog my-2 min-w-0 w-full max-w-[min(96vw,1600px)] rounded-lg border border-[#BC13FE]/50 bg-zinc-950 shadow-[0_24px_90px_rgba(0,0,0,0.75)] sm:my-6" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Purchasing cart">
                  <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-zinc-800 bg-zinc-950 p-4">
                    <div>
                      <h2 className="text-2xl font-semibold text-[#d45cff]">Purchasing Cart</h2>
                      <p className="mt-1 text-xs text-zinc-400">Grouped by distributor. Line-item cost excludes supplier tax, shipping, and checkout fees; those are calculated here.</p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2"><button type="button" disabled={cartRefreshBusy || !partsPurchaseQueue.some(row => row.orderUrl)} className="rounded border border-[#BC13FE]/70 bg-[#BC13FE]/15 px-3 py-2 text-xs font-semibold text-fuchsia-100 disabled:opacity-40" onClick={() => { void refreshCartPrices(); }}>{cartRefreshBusy ? 'Refreshing...' : 'Refresh Cart'}</button><button type="button" className="rounded bg-[#39FF14] px-3 py-2 text-xs font-semibold text-black" onClick={() => setShowAddPurchase(true)}>Add Part / Product</button><button type="button" className="h-9 w-9 rounded border border-zinc-700 bg-zinc-900 text-lg" onClick={() => setShowCart(false)} aria-label="Close cart">x</button></div>
                  </header>

                  <div className="grid gap-2 border-b border-violet-500/30 bg-violet-950/20 p-3 sm:grid-cols-4 lg:p-4">
                    <div><div className="text-[11px] uppercase text-violet-300">Daily budget</div><div className="text-xl font-semibold text-white">{budgetConfigured ? formatCurrency(dailyBudget) : 'Not set'}</div></div>
                    <div><div className="text-[11px] uppercase text-zinc-500">Checked out</div><div className="text-xl font-semibold">{formatCurrency(dailyBudgetSpent)}</div></div>
                    <div><div className="text-[11px] uppercase text-zinc-500">Selected</div><div className="text-xl font-semibold">{formatCurrency(selectedBudgetCost)}</div></div>
                    <div><div className="text-[11px] uppercase text-zinc-500">After selection</div><div className={`text-xl font-semibold ${budgetConfigured && budgetSnapshot.overBy > 0 ? 'text-red-300' : 'text-[#39FF14]'}`}>{budgetConfigured ? formatCurrency(budgetSnapshot.afterSelection) : '--'}</div></div>
                    <div className="sm:col-span-4 text-xs text-zinc-400">Cart guardrail only. Reporting is unchanged.{budgetConfigured ? ` ${formatCurrency(budgetSnapshot.available)} remains before the current selection.` : ' Set a daily purchasing budget to preview available spending.'}</div>
                    {budgetConfigured && budgetSnapshot.overBy > 0 ? <div className="sm:col-span-4 rounded border border-red-500/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">This selection is {formatCurrency(budgetSnapshot.overBy)} over today&apos;s available purchasing budget. Checkout remains available after review.</div> : null}
                  </div>

                  <div className="gb-eod-cart-summary grid grid-cols-2 gap-2 border-b border-zinc-800 p-3 sm:grid-cols-5 lg:p-4">
                    <div className="rounded border border-zinc-800 bg-zinc-900 p-2"><div className="text-[11px] text-zinc-500">To purchase</div><div className="text-xl font-semibold">{partsPurchaseTotals.count}</div></div>
                    <div className="rounded border border-zinc-800 bg-zinc-900 p-2"><div className="text-[11px] text-zinc-500">Checkout total</div><div className="text-xl font-semibold">{formatCurrency(partsPurchaseTotals.checkoutCost)}</div><div className="text-[10px] text-zinc-500">includes {formatCurrency(partsPurchaseTotals.supplierTax)} supplier tax</div></div>
                    <div className="rounded border border-zinc-800 bg-zinc-900 p-2"><div className="text-[11px] text-zinc-500">Client charges</div><div className="text-xl font-semibold">{formatCurrency(partsPurchaseTotals.charged)}</div><div className="text-[10px] text-zinc-500">includes {formatCurrency(partsPurchaseTotals.clientTax)} client tax</div></div>
                    <div className="rounded border border-zinc-800 bg-zinc-900 p-2"><div className="text-[11px] text-zinc-500">Known margin</div><div className="text-xl font-semibold text-[#39FF14]">{formatCurrency(partsPurchaseTotals.profit)}</div><div className="text-[10px] text-zinc-500">client tax excluded</div></div>
                    <div className="col-span-2 rounded border border-zinc-800 bg-zinc-900 p-2 sm:col-span-1"><div className="text-[11px] text-zinc-500">Warnings</div><div className={`text-xl font-semibold ${partsPurchaseTotals.missingCost || partsPurchaseTotals.paymentWarnings ? 'text-amber-300' : 'text-[#39FF14]'}`}>{partsPurchaseTotals.missingCost + partsPurchaseTotals.paymentWarnings}</div></div>
                  </div>

                  <div className="space-y-2 p-2 sm:p-3">
                    {purchaseUpdateMessage ? <div className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200">{purchaseUpdateMessage}</div> : null}
                    {cartPriceReview?.length ? <div className="rounded border border-[#BC13FE]/60 bg-[#BC13FE]/10 p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-sm text-fuchsia-100">Supplier price review</strong><div className="text-xs text-zinc-400">Current item-page prices changed. Nothing is saved until Keep Changes is selected.</div></div><div className="flex gap-2"><button type="button" className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs" onClick={() => { setCartPriceReview(null); setPurchaseUpdateMessage('Refreshed supplier prices reverted.'); }}>Revert</button><button type="button" disabled={cartRefreshBusy} className="rounded bg-[#39FF14] px-3 py-2 text-xs font-semibold text-black disabled:opacity-40" onClick={() => { void keepRefreshedCartPrices(); }}>Keep Changes</button></div></div><div className="mt-3 grid gap-1 sm:grid-cols-2">{cartPriceReview.map(change => <div key={change.key} className="flex items-center justify-between gap-3 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs"><span className="truncate">{change.title}</span><span className="shrink-0"><span className="text-zinc-500 line-through">{formatCurrency(change.previousUnitCost)}</span><span className="ml-2 font-semibold text-fuchsia-100">{formatCurrency(change.nextUnitCost)}</span></span></div>)}</div></div> : null}
                    {purchaseGroups.map(group => {
                      const selectedGroupRows = group.rows.filter(row => selectedPurchaseRows.has(row.key));
                      const allSelected = selectedGroupRows.length === group.rows.length && group.rows.length > 0;
                      const selectionActive = selectingDistributors.has(group.distributor);
                      const groupAmounts = purchaseGroupAmounts.get(group.distributor) || { itemSubtotal: group.knownCost, supplierTax: 0, additional: 0, checkoutTotal: group.knownCost, clientCharge: group.charge, clientTax: 0, knownMargin: group.knownProfit, taxExempt: false };
                      return (
                      <details key={group.distributor} className="group overflow-hidden rounded border border-zinc-800 bg-zinc-900/60">
                        <summary className="cursor-pointer list-none bg-zinc-900 px-3 py-2">
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <div className="min-w-0"><h3 className="truncate text-sm font-semibold leading-tight text-white">{group.distributor}</h3><div className="text-[11px] leading-tight text-zinc-500">{group.rows.length} item{group.rows.length === 1 ? '' : 's'} | {formatCurrency(groupAmounts.checkoutTotal)} | {groupAmounts.taxExempt ? 'Tax exempt' : '8% tax'}</div></div>
                            <span className="shrink-0 text-[11px] text-zinc-400"><span className="group-open:hidden">Expand</span><span className="hidden group-open:inline">Collapse</span></span>
                          </div>
                        </summary>
                        <div className="gb-eod-cart-toolbar flex flex-wrap items-center gap-2 border-y border-zinc-800 bg-zinc-950/60 p-2">
                          <button type="button" className={`rounded border px-3 py-2 text-xs font-semibold ${selectionActive ? 'border-[#BC13FE] bg-[#BC13FE]/20 text-white' : 'border-zinc-700 bg-zinc-800'}`} onClick={() => setSelectingDistributors(current => { const next = new Set(current); if (next.has(group.distributor)) { next.delete(group.distributor); setSelectedPurchaseRows(selected => { const cleaned = new Set(selected); group.rows.forEach(row => cleaned.delete(row.key)); return cleaned; }); } else next.add(group.distributor); return next; })}>{selectionActive ? 'Cancel Select' : 'Select'}</button>
                          {selectionActive ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="h-4 w-4 shrink-0 accent-[#BC13FE]" style={{ minWidth: 16, maxWidth: 16, minHeight: 16, maxHeight: 16 }} checked={allSelected} onChange={event => setSelectedPurchaseRows(current => { const next = new Set(current); group.rows.forEach(row => event.target.checked ? next.add(row.key) : next.delete(row.key)); return next; })} />Select all</label> : null}
                          {selectionActive ? <button type="button" disabled={!selectedGroupRows.some(row => row.orderUrl)} className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs disabled:opacity-40" onClick={() => openPurchaseRows(selectedGroupRows)}>Open Selected</button> : null}
                          {selectionActive ? <button type="button" disabled={!selectedGroupRows.length || purchaseUpdateBusy} className="rounded border border-red-500/70 bg-red-950/50 px-3 py-2 text-xs font-semibold text-red-200 disabled:opacity-40" onClick={() => setDeleteCandidateRows(selectedGroupRows)}>Delete Selected</button> : null}
                          {selectionActive ? <button type="button" disabled={!selectedGroupRows.length || purchaseUpdateBusy} className="rounded border border-[#39FF14]/70 bg-[#39FF14]/10 px-3 py-2 text-xs font-semibold text-[#39FF14] disabled:opacity-40" onClick={() => setCheckoutCandidateRows(selectedGroupRows)}>Checkout Selected</button> : null}
                          <label className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold"><input type="checkbox" className="h-4 w-4 shrink-0 accent-[#39FF14]" style={{ minWidth: 16, maxWidth: 16, minHeight: 16, maxHeight: 16 }} checked={groupAmounts.taxExempt} onChange={event => void updateDistributorTaxExempt(group.distributor, event.target.checked)} />Tax Exempt</label>
                          <button type="button" disabled={!group.rows.some(row => row.orderUrl)} className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs disabled:opacity-40" onClick={() => openPurchaseRows(group.rows)}>View Cart</button>
                          <button type="button" disabled={!group.checkoutUrl} className="rounded bg-amber-500 px-3 py-2 text-xs font-semibold text-black disabled:opacity-40" onClick={() => openPurchaseUrl(group.checkoutUrl)}>{group.checkoutUrl ? group.checkoutLabel : 'Cart URL unavailable'}</button>
                        </div>
                        <div className="grid gap-2 border-b border-zinc-800 bg-zinc-950/40 p-2 sm:grid-cols-[minmax(190px,280px)_1fr] sm:items-end">
                          <label className="text-xs text-zinc-300">Estimated Delivery
                            <input type="date" disabled={splitDeliveryByDistributor[group.distributor] === true} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm disabled:opacity-40" value={deliveryByDistributor[group.distributor] || group.rows.find(row => row.estimatedDelivery)?.estimatedDelivery || ''} onChange={event => setDeliveryByDistributor(current => ({ ...current, [group.distributor]: event.target.value }))} />
                          </label>
                          <label className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-300"><input type="checkbox" className="h-4 w-4" checked={splitDeliveryByDistributor[group.distributor] === true} onChange={event => setSplitDeliveryByDistributor(current => ({ ...current, [group.distributor]: event.target.checked }))} />Items arrive on different dates</label>
                        </div>
                        <div className="divide-y divide-zinc-800">
                          {group.rows.map(row => (
                            <div key={row.key} className={`gb-eod-cart-row grid gap-2 p-2 text-sm lg:items-center ${selectionActive ? 'grid-cols-[24px_minmax(0,1fr)] lg:grid-cols-[24px_minmax(220px,2fr)_64px_96px_88px_105px_115px_125px_88px_92px]' : 'grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(220px,2fr)_64px_96px_88px_105px_115px_125px_88px_92px]'}`}>
                              {selectionActive ? <input type="checkbox" className="h-4 w-4 shrink-0 self-center accent-[#BC13FE]" style={{ minWidth: 16, maxWidth: 16, minHeight: 16, maxHeight: 16 }} checked={selectedPurchaseRows.has(row.key)} onChange={event => setSelectedPurchaseRows(current => { const next = new Set(current); if (event.target.checked) next.add(row.key); else next.delete(row.key); return next; })} aria-label={`Select ${row.title}`} /> : null}
                              <div className="min-w-0"><div className="truncate font-medium" title={row.title}>{row.title}</div><div className="text-xs text-zinc-500">{row.sourceType === 'workOrder' ? `WO #${row.sourceId}` : row.sourceType === 'sale' ? `Sale #${row.sourceId}` : row.sourceType === 'inventory' ? 'Inventory restock' : 'Manual purchase'} · {row.customer}</div>{splitDeliveryByDistributor[group.distributor] ? <label className="mt-2 block text-[11px] text-zinc-400">Estimated Delivery<input type="date" className="mt-1 block w-full max-w-48 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white" value={deliveryByRow[row.key] || row.estimatedDelivery || ''} onChange={event => setDeliveryByRow(current => ({ ...current, [row.key]: event.target.value }))} /></label> : null}<label className="gb-eod-cart-mobile-qty mt-2 flex w-32 items-center gap-2 text-xs text-zinc-400 lg:hidden">Qty<input type="number" min="1" step="1" inputMode="numeric" className="min-w-0 w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-white" value={quantityOverrides[row.key] ?? String(row.quantity)} onChange={event => setQuantityOverrides(current => ({ ...current, [row.key]: event.target.value }))} /></label><div className="gb-eod-cart-mobile-amounts mt-2 grid grid-cols-2 gap-2 text-xs lg:hidden"><div><span className="text-zinc-500">Cost incl. tax</span><div>{row.hasCost ? formatCurrency(row.totalCost + (purchaseRowSupplierTax.get(row.key) || 0)) : 'Missing'}</div></div><div><span className="text-zinc-500">Charged incl. tax</span><div>{row.totalCharge > 0 ? formatCurrency(row.totalCharge) : 'Not client-linked'}</div></div></div><div className={`gb-eod-cart-mobile-payment mt-2 inline-block rounded border px-2 py-1 text-[11px] lg:hidden ${cartPaymentClass(row)}`} title={row.paymentDetail}>{cartPaymentLabel(row)}</div></div>
                              <label className="gb-eod-cart-desktop-cell hidden text-xs text-zinc-400 lg:block">Qty<input type="number" min="1" step="1" inputMode="numeric" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-center text-white" value={quantityOverrides[row.key] ?? String(row.quantity)} onChange={event => setQuantityOverrides(current => ({ ...current, [row.key]: event.target.value }))} /></label>
                              <div className="gb-eod-cart-desktop-cell hidden text-right text-sm lg:block"><div className="text-[10px] text-zinc-500">Item cost</div>{row.hasCost ? formatCurrency(row.totalCost) : <span className="text-red-300">Missing</span>}</div>
                              <div className="gb-eod-cart-desktop-cell hidden text-right text-sm lg:block"><div className="text-[10px] text-zinc-500">Supplier tax</div>{formatCurrency(purchaseRowSupplierTax.get(row.key) || 0)}</div>
                              <div className="gb-eod-cart-desktop-cell hidden text-right text-sm font-semibold lg:block"><div className="text-[10px] font-normal text-zinc-500">Cost incl. tax</div>{row.hasCost ? formatCurrency(row.totalCost + (purchaseRowSupplierTax.get(row.key) || 0)) : <span className="text-red-300">Missing</span>}</div>
                              <div className="gb-eod-cart-desktop-cell hidden text-right text-sm font-semibold lg:block"><div className="text-[10px] font-normal text-zinc-500">Charged incl. tax</div>{formatCurrency(row.totalCharge)}</div>
                              <div className={`gb-eod-cart-desktop-cell hidden rounded border px-2 py-1 text-center text-[11px] lg:block ${cartPaymentClass(row)}`} title={row.paymentDetail}>{cartPaymentLabel(row)}</div>
                              <button type="button" disabled={!row.orderUrl} className={`${selectionActive ? 'col-start-2' : 'col-start-1'} rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs disabled:text-zinc-600 lg:col-start-auto`} onClick={() => openPurchaseUrl(row.orderUrl)}>{row.orderUrl ? 'Order URL' : 'URL needed'}</button>
                              <button type="button" disabled={row.sourceType !== 'workOrder' && row.sourceType !== 'sale'} className={`${selectionActive ? 'col-start-2' : 'col-start-1'} rounded border border-[#BC13FE]/60 bg-[#BC13FE]/15 px-2 py-1 text-xs text-fuchsia-100 disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600 lg:col-start-auto`} onClick={() => void openPurchaseInvoice(row)}>{row.sourceType === 'workOrder' || row.sourceType === 'sale' ? 'View Invoice' : 'No Invoice'}</button>
                            </div>
                          ))}
                        </div>
                        <div className="grid gap-2 border-t border-zinc-800 bg-zinc-950/70 p-2 sm:grid-cols-[minmax(190px,280px)_1fr] sm:items-end">
                          <label className="text-xs text-zinc-300">Additional Costs
                            <div className="mt-1 flex items-center rounded border border-zinc-700 bg-zinc-900 px-2"><span className="text-zinc-500">$</span><input type="number" min="0" step="0.01" inputMode="decimal" className="min-w-0 flex-1 bg-transparent px-2 py-2 outline-none" placeholder="Shipping and checkout fees" value={additionalCostsByDistributor[group.distributor] || ''} onChange={event => setAdditionalCostsByDistributor(current => ({ ...current, [group.distributor]: event.target.value }))} /></div>
                          </label>
                          <div className="text-sm sm:text-right"><div><span className="text-zinc-500">Item subtotal</span> {formatCurrency(groupAmounts.itemSubtotal)}</div><div><span className="text-zinc-500">Supplier tax {groupAmounts.taxExempt ? '(exempt)' : `(${SC_SALES_TAX_RATE}%)`}</span> {formatCurrency(groupAmounts.supplierTax)}</div><div><span className="text-zinc-500">Additional</span> {formatCurrency(groupAmounts.additional)}</div><div className="mt-1 text-base font-semibold"><span className="text-zinc-400">Distributor total</span> {formatCurrency(groupAmounts.checkoutTotal)}</div></div>
                        </div>
                      </details>
                    )})}
                    {!purchaseGroups.length ? <div className="rounded border border-zinc-800 bg-zinc-900 p-8 text-center text-zinc-500">Nothing currently needs purchasing.</div> : null}
                  </div>

                  <footer className="gb-eod-cart-footer sticky bottom-0 flex flex-col gap-2 border-t border-zinc-800 bg-zinc-950 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm"><span className="text-zinc-500">Total checkout cost</span> <strong className="ml-2 text-lg">{formatCurrency(partsPurchaseTotals.checkoutCost)}</strong>{partsPurchaseTotals.supplierTax ? <span className="ml-2 text-zinc-400">{formatCurrency(partsPurchaseTotals.supplierTax)} supplier tax</span> : null}{partsPurchaseTotals.additionalCosts ? <span className="ml-2 text-zinc-400">{formatCurrency(partsPurchaseTotals.additionalCosts)} additional</span> : null}{partsPurchaseTotals.missingCost ? <span className="ml-2 text-red-300">+ {partsPurchaseTotals.missingCost} missing cost</span> : null}</div>
                    <div className="flex flex-wrap gap-2">{selectedCartRows.length ? <button type="button" disabled={purchaseUpdateBusy} onClick={() => setCheckoutCandidateRows(selectedCartRows)} className="rounded border border-[#BC13FE] bg-[#BC13FE]/15 px-5 py-2 text-sm font-semibold text-fuchsia-100 disabled:opacity-40">Checkout Selected ({selectedCartRows.length})</button> : null}<button type="button" disabled={!purchaseGroups.length || purchaseUpdateBusy} onClick={() => { setVerifiedDistributors(new Set()); setShowCheckoutVerification(true); }} className="rounded bg-[#39FF14] px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{purchaseUpdateBusy ? 'Updating...' : 'Checkout Whole Cart'}</button></div>
                  </footer>
                </section>
              </div>
            ) : null}

            {deleteCandidateRows ? (
              <div className="fixed inset-0 z-[100300] flex items-center justify-center overflow-y-auto bg-black/90 p-3" onClick={() => setDeleteCandidateRows(null)}>
                <section className="w-full max-w-lg rounded-lg border border-red-500/60 bg-zinc-950 p-4 shadow-[0_24px_90px_rgba(0,0,0,0.85)]" onClick={event => event.stopPropagation()} role="alertdialog" aria-modal="true" aria-label="Confirm cart item deletion">
                  <header><h3 className="text-xl font-semibold text-red-300">Remove selected cart items?</h3><p className="mt-2 text-sm text-zinc-300">This removes {deleteCandidateRows.length} selected purchasing task{deleteCandidateRows.length === 1 ? '' : 's'} from the EOD Cart.</p></header>
                  {deleteCandidateRows.some(row => row.sourceType === 'workOrder' || row.sourceType === 'sale') ? <div className="mt-4 rounded border border-amber-500/60 bg-amber-950/30 p-3 text-sm text-amber-100"><strong className="block text-amber-300">Linked transaction warning</strong>Work-order and sale items will remain attached to their transaction. They will be marked <strong>not ordered</strong>, delivery and tracking fields will be cleared, and the transaction will show that payment may already have been taken. They can be restored to the EOD Cart from the item warning.</div> : null}
                  <div className="mt-4 max-h-48 space-y-1 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 text-xs">{deleteCandidateRows.map(row => <div key={row.key} className="flex justify-between gap-3"><span className="truncate">{row.title}</span><span className="shrink-0 text-zinc-500">{row.sourceType === 'workOrder' ? `WO #${row.sourceId}` : row.sourceType === 'sale' ? `Sale #${row.sourceId}` : row.sourceType === 'inventory' ? 'Restock' : 'Manual'}</span></div>)}</div>
                  <footer className="mt-4 flex justify-end gap-2"><button type="button" className="rounded border border-zinc-700 px-4 py-2 text-sm" onClick={() => setDeleteCandidateRows(null)}>Cancel</button><button type="button" disabled={purchaseUpdateBusy} className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void deleteSelectedPurchaseRows(deleteCandidateRows)}>{purchaseUpdateBusy ? 'Deleting...' : 'Delete Selected'}</button></footer>
                </section>
              </div>
            ) : null}

            {checkoutCandidateRows ? (() => {
              const receiptRows = checkoutCandidateRows;
              const receiptCostTotal = selectedPurchaseBudgetCost(receiptRows);
              const receiptChargeTotal = round2(receiptRows.reduce((sum, row) => sum + row.totalCharge, 0));
              const receiptHasMissingCost = receiptRows.some(row => !row.hasCost);
              const receiptBudget = purchaseBudgetSnapshot(dailyBudget, dailyBudgetSpent, receiptCostTotal);
              return (
              <div className="fixed inset-0 z-[100300] flex items-center justify-center overflow-y-auto bg-black/90 p-3" onClick={() => { setCheckoutCandidateRows(null); setUseHistoricalOrderDate(false); setHistoricalOrderDate(''); setSendCartClientUpdateEnabled(false); }}>
                <section className="w-full max-w-lg rounded-lg border border-[#39FF14]/60 bg-zinc-950 p-4 shadow-[0_24px_90px_rgba(0,0,0,0.85)]" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Confirm selected checkout">
                  <header><h3 className="text-xl font-semibold text-[#39FF14]">Confirm Checkout</h3><p className="mt-2 text-sm text-zinc-300">Review each item's cost before checking out {receiptRows.length} selected item{receiptRows.length === 1 ? '' : 's'}.</p></header>
                  {receiptHasMissingCost ? <div className="mt-4 rounded border border-amber-500/60 bg-amber-950/30 p-3 text-sm text-amber-100"><strong className="block text-amber-300">Missing cost</strong>Some selected items are missing a cost and will not be included in the total below.</div> : null}
                  {budgetConfigured && receiptBudget.overBy > 0 ? <div className="mt-4 rounded border border-red-500/60 bg-red-950/40 p-3 text-sm text-red-200"><strong className="block text-red-300">Over daily budget</strong>This checkout is {formatCurrency(receiptBudget.overBy)} over the remaining purchasing budget. This is a warning only and does not alter reporting.</div> : null}
                  <div className="mt-4 max-h-64 space-y-2 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 text-xs">
                    {receiptRows.map(row => (
                      <div key={row.key} className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2 last:border-0 last:pb-0">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-100" title={row.title}>{row.title}</div>
                          <div className="text-zinc-500">{row.sourceType === 'workOrder' ? `WO #${row.sourceId}` : row.sourceType === 'sale' ? `Sale #${row.sourceId}` : row.sourceType === 'inventory' ? 'Restock' : 'Manual'} · Qty {row.quantity}</div>
                        </div>
                        <div className="shrink-0 text-right font-semibold text-zinc-100">{row.hasCost ? formatCurrency(row.totalCost + (purchaseRowSupplierTax.get(row.key) || 0)) : <span className="text-red-300">Missing</span>}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
                    <div><span className="text-zinc-500">Cost incl. tax</span><strong className="float-right">{formatCurrency(receiptCostTotal)}</strong></div>
                    <div className="mt-1"><span className="text-zinc-500">Client charges</span><strong className="float-right">{formatCurrency(receiptChargeTotal)}</strong></div>
                  </div>
                  <div className="mt-4 rounded border border-violet-500/50 bg-violet-950/20 p-3"><label className="flex items-center gap-2 text-sm font-semibold text-violet-100"><input type="checkbox" checked={useHistoricalOrderDate} onChange={event => setUseHistoricalOrderDate(event.target.checked)} />Ordered on Different Day</label>{useHistoricalOrderDate ? <label className="mt-3 block text-xs text-zinc-300">Date order was checked out<input type="date" max={new Date().toLocaleDateString('en-CA')} required className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-base" value={historicalOrderDate} onChange={event => setHistoricalOrderDate(event.target.value)} /></label> : null}</div>
                  <label className="mt-3 flex items-start gap-2 rounded border border-zinc-700 bg-zinc-900 p-3 text-sm text-zinc-200"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#39FF14]" checked={sendCartClientUpdateEnabled} onChange={event => setSendCartClientUpdateEnabled(event.target.checked)} /><span><strong className="block text-zinc-100">Send client update</strong><span className="text-xs text-zinc-400">Off by default. Leave unchecked for an internal-only EOD order update.</span></span></label>
                  <footer className="mt-4 flex justify-end gap-2"><button type="button" className="rounded border border-zinc-700 px-4 py-2 text-sm" onClick={() => { setCheckoutCandidateRows(null); setUseHistoricalOrderDate(false); setHistoricalOrderDate(''); setSendCartClientUpdateEnabled(false); }}>Cancel</button><button type="button" disabled={purchaseUpdateBusy || (useHistoricalOrderDate && !historicalOrderDate)} className="rounded bg-[#39FF14] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50" onClick={() => { const rows = checkoutCandidateRows; const chosenDate = useHistoricalOrderDate ? historicalOrderDate : undefined; setCheckoutCandidateRows(null); setUseHistoricalOrderDate(false); setHistoricalOrderDate(''); const sendClientUpdate = sendCartClientUpdateEnabled; setSendCartClientUpdateEnabled(false); void markSelectedPurchasesOrdered(rows || undefined, chosenDate, sendClientUpdate); }}>{purchaseUpdateBusy ? 'Checking out...' : 'Checkout'}</button></footer>
                </section>
              </div>
              );
            })() : null}


            {showAddPurchase ? (
              <div className="fixed inset-0 z-[100200] flex items-center justify-center overflow-y-auto bg-black/85 p-3" onClick={() => setShowAddPurchase(false)}>
                <section className="w-full max-w-xl rounded-lg border border-[#39FF14]/50 bg-zinc-950 p-4 shadow-[0_24px_90px_rgba(0,0,0,0.8)]" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add cart item">
                  <header className="mb-4 flex items-center justify-between gap-3"><div><h3 className="text-xl font-semibold text-[#39FF14]">Add Part / Product</h3><p className="text-xs text-zinc-400">Paste a supplier URL to fill available details, then verify every field.</p></div><button type="button" className="h-9 w-9 rounded border border-zinc-700" onClick={() => setShowAddPurchase(false)} aria-label="Close add purchase">x</button></header>
                  <div className="mb-3 grid grid-cols-2 rounded border border-zinc-700 p-1">
                    {(['Part', 'Product'] as const).map(itemType => <button key={itemType} type="button" className={`rounded px-3 py-2 text-sm font-semibold ${purchaseDraft.itemType === itemType ? (itemType === 'Part' ? 'bg-[#39FF14] text-black' : 'bg-sky-500 text-black') : 'text-zinc-400'}`} onClick={() => setPurchaseDraft((current: any) => ({ ...current, itemType }))}>{itemType}</button>)}
                  </div>
                  <label className="block text-xs text-zinc-300">Order URL<input type="url" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" placeholder="https://supplier.com/item" value={purchaseDraft.orderUrl} onChange={event => setPurchaseDraft((current: any) => ({ ...current, orderUrl: event.target.value }))} /></label>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-xs text-zinc-300 sm:col-span-2">Part / Product Title<input className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" value={purchaseDraft.title} onChange={event => setPurchaseDraft((current: any) => ({ ...current, title: event.target.value }))} /></label>
                    <label className="text-xs text-zinc-300">Distributor<input list="eod-purchase-vendors" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" value={purchaseDraft.distributor} onChange={event => setPurchaseDraft((current: any) => ({ ...current, distributor: event.target.value }))} /><datalist id="eod-purchase-vendors">{vendors.filter((vendor: any) => String(vendor?.inventoryMode || 'Product') === purchaseDraft.itemType).map((vendor: any) => <option key={`${vendor.id}-${vendor.name}`} value={vendor.name} />)}</datalist></label>
                    <label className="text-xs text-zinc-300">Quantity<input type="number" min="1" step="1" inputMode="numeric" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" value={purchaseDraft.quantity} onChange={event => setPurchaseDraft((current: any) => ({ ...current, quantity: event.target.value }))} /></label>
                    <label className="text-xs text-zinc-300 sm:col-span-2">Supplier Unit Cost<input type="number" min="0" step="0.01" inputMode="decimal" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" value={purchaseDraft.unitCost} onChange={event => setPurchaseDraft((current: any) => ({ ...current, unitCost: event.target.value }))} /></label>
                  </div>
                  <div className="mt-3 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm"><span className="text-zinc-500">Estimated line cost</span><strong className="float-right">{formatCurrency((Number(purchaseDraft.unitCost) || 0) * Math.max(1, Number(purchaseDraft.quantity) || 1))}</strong></div>
                  <footer className="mt-4 flex items-center justify-between gap-3"><span className="text-xs text-zinc-500">{purchaseDraftBusy ? 'Reading supplier information...' : 'Scraped details remain editable.'}</span><button type="button" disabled={purchaseDraftBusy} className="rounded bg-[#39FF14] px-4 py-2 text-sm font-semibold text-black disabled:opacity-40" onClick={() => void addManualPurchase()}>Add to Cart</button></footer>
                </section>
              </div>
            ) : null}

            {showCheckoutVerification ? (
              <div className="fixed inset-0 z-[100250] flex items-center justify-center overflow-y-auto bg-black/90 p-3" onClick={() => setShowCheckoutVerification(false)}>
                <section className="w-full max-w-lg rounded-lg border border-amber-500/60 bg-zinc-950 p-4" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Verify distributor checkout">
                  <header className="mb-4"><h3 className="text-xl font-semibold text-amber-300">Verify Supplier Checkout</h3><p className="mt-1 text-xs text-zinc-400">Check only distributors whose website checkout is complete and payment has actually been submitted.</p></header>
                  <div className="space-y-2">
                    {purchaseGroups.map(group => {
                      const amounts = purchaseGroupAmounts.get(group.distributor);
                      return <label key={group.distributor} className="flex items-center justify-between gap-3 rounded border border-zinc-700 bg-zinc-900 p-3"><span className="flex min-w-0 items-center gap-3"><input type="checkbox" checked={verifiedDistributors.has(group.distributor)} onChange={event => setVerifiedDistributors(current => { const next = new Set(current); event.target.checked ? next.add(group.distributor) : next.delete(group.distributor); return next; })} /><span className="min-w-0"><strong className="block truncate">{group.distributor}</strong><span className="text-xs text-zinc-500">{group.rows.length} item{group.rows.length === 1 ? '' : 's'} · {amounts?.taxExempt ? 'Tax exempt' : `${SC_SALES_TAX_RATE}% tax`}</span></span></span><strong>{formatCurrency(amounts?.checkoutTotal || 0)}</strong></label>;
                    })}
                  </div>
                  {(() => { const rows = purchaseGroups.filter(group => verifiedDistributors.has(group.distributor)).flatMap(group => group.rows); const total = selectedPurchaseBudgetCost(rows); const projected = purchaseBudgetSnapshot(dailyBudget, dailyBudgetSpent, total); return <><div className="mt-4 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm"><span className="text-zinc-500">Selected checkout total</span><strong className="float-right">{formatCurrency(total)}</strong></div>{budgetConfigured ? <div className={`mt-2 rounded border p-3 text-sm ${projected.overBy > 0 ? 'border-red-500/60 bg-red-950/40 text-red-200' : 'border-violet-500/40 bg-violet-950/20 text-violet-100'}`}>Budget after checkout: <strong className="float-right">{formatCurrency(projected.afterSelection)}</strong>{projected.overBy > 0 ? <span className="mt-1 block text-xs">Warning: {formatCurrency(projected.overBy)} over budget. Reporting is unchanged.</span> : null}</div> : null}</>; })()}
                  <footer className="mt-4 flex justify-end gap-2"><button type="button" className="rounded border border-zinc-700 px-4 py-2 text-sm" onClick={() => setShowCheckoutVerification(false)}>Back</button><button type="button" disabled={!verifiedDistributors.size || purchaseUpdateBusy} className="rounded bg-amber-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40" onClick={() => { const rows = purchaseGroups.filter(group => verifiedDistributors.has(group.distributor)).flatMap(group => group.rows); setShowCheckoutVerification(false); void markSelectedPurchasesOrdered(rows); }}>Checkout Verified Carts</button></footer>
                </section>
              </div>
            ) : null}

            {showEmailSettings ? (
              <div className="fixed inset-0 z-[100300] flex items-center justify-center overflow-y-auto bg-black/80 p-3 sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setShowEmailSettings(false); }}>
                <section className="gb-eod-email-dialog pointer-events-auto my-auto max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto rounded-lg border border-amber-500/50 bg-zinc-950 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.75)]" role="dialog" aria-modal="true" aria-label="EOD report email settings" onMouseDown={event => event.stopPropagation()}>
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div><h3 className="text-xl font-semibold text-amber-300">EOD Report Email</h3><p className="text-xs text-zinc-400 mt-1">Separate multiple recipients with commas. These settings sync with the report configuration.</p></div>
                    <button type="button" className="rounded border border-zinc-700 px-2.5 py-1.5 text-zinc-400 hover:text-white" aria-label="Close email settings" onClick={() => setShowEmailSettings(false)}>x</button>
                  </div>
                  <label className="block text-sm text-zinc-300 mb-3">Recipients
                    <textarea rows={3} autoComplete="email" inputMode="email" className="gb-eod-email-input mt-1 min-h-24 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-white outline-none focus:border-amber-400" placeholder="tech@example.com, owner@example.com" value={draftSettings.recipients} onChange={e => setDraftSettings(s => ({ ...s, recipients: e.target.value }))} />
                  </label>
                  <label className="block text-sm text-zinc-300 mb-4">Subject
                    <input type="text" autoComplete="off" className="gb-eod-email-input mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-white outline-none focus:border-amber-400" value={draftSettings.subject || ''} onChange={e => setDraftSettings(s => ({ ...s, subject: e.target.value }))} />
                  </label>

                  <button type="button" className="mb-3 flex w-full items-center justify-between rounded border border-[#BC13FE]/60 bg-[#BC13FE]/10 px-3 py-3 text-left text-sm font-semibold text-purple-100 hover:border-[#d45cff]" onClick={openBatchSettings}>
                    <span><span className="block">Daily Batch Settings</span><span className="mt-0.5 block text-xs font-normal text-zinc-400">Accounting day closes at {savedSettings.batchOutTime || '21:00'} · Email {savedSettings.schedule === 'manual' ? 'manual' : `at ${savedSettings.sendTime || '18:00'}`}</span></span>
                    <span aria-hidden="true">›</span>
                  </button>

                  <details className="mb-4 rounded border border-zinc-800 bg-zinc-900/70">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-zinc-300">Report Contents</summary>
                    <div className="grid gap-2 border-t border-zinc-800 p-3 text-sm sm:grid-cols-2">
                      {([
                        ['includePayments', 'Payment totals'],
                        ['includeCounts', 'Check-ins and closed tickets'],
                        ['includeWorkOrders', 'Work order summary'],
                        ['includeSales', 'Sales summary'],
                        ['includeOutstanding', 'Outstanding balances'],
                        ['includeBatchInfo', 'Batch timestamps'],
                        ['emailIncludeWorkOrdersDetails', 'Work order details'],
                        ['emailIncludeSalesDetails', 'Sales details'],
                        ['emailIncludeOutstandingDetails', 'Outstanding details'],
                        ['emailIncludeOpenTickets', 'Open tickets'],
                        ['emailIncludeTechnicianSummary', 'Technician summary'],
                      ] as Array<[keyof EodSettings, string]>).map(([key, label]) => (
                        <label key={key} className="flex items-center gap-2 rounded px-1 py-1 text-zinc-300">
                          <input type="checkbox" checked={Boolean(draftSettings[key])} onChange={event => setDraftSettings(current => ({ ...current, [key]: event.target.checked }))} />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                  </details>

                  <div className="flex flex-col-reverse justify-end gap-2 sm:flex-row">
                    <button type="button" className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm" onClick={() => setShowEmailSettings(false)}>Cancel</button>
                    <button type="button" className="rounded bg-amber-500 px-3 py-2 text-sm font-semibold text-black" onClick={() => { saveDraftAsDefault(); setShowEmailSettings(false); }}>Save Email Settings</button>
                    <button type="button" disabled={sending} className="rounded bg-[#39FF14] px-3 py-2 text-sm font-semibold text-black disabled:opacity-50" onClick={() => { saveDraftAsDefault(); void handleSend(); }}>{sending ? 'Sending...' : 'Send Report'}</button>
                  </div>
                </section>
              </div>
            ) : null}

            {showEmailSettings && showBatchSettings ? (
              <div className="fixed inset-0 z-[100400] flex items-center justify-center overflow-y-auto bg-black/75 p-3 sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setShowBatchSettings(false); }}>
                <section className="gb-eod-batch-dialog pointer-events-auto my-auto w-full max-w-md rounded-lg border border-[#BC13FE]/70 bg-zinc-950 p-4 shadow-[0_24px_90px_rgba(0,0,0,0.8)]" role="dialog" aria-modal="true" aria-label="Daily batch settings" onMouseDown={event => event.stopPropagation()}>
                  <header className="mb-4 flex items-start justify-between gap-3">
                    <div><h3 className="text-xl font-semibold text-purple-200">Daily Batch Settings</h3><p className="mt-1 text-xs text-zinc-400">Batch Out closes the current accounting day and starts the next one at this shop-local time.</p></div>
                    <button type="button" className="rounded border border-zinc-700 px-2.5 py-1.5 text-zinc-400 hover:text-white" aria-label="Close batch settings" onClick={() => setShowBatchSettings(false)}>x</button>
                  </header>
                  <div className="space-y-3">
                    <label className="block text-sm text-zinc-300">Batch Out time
                      <input type="time" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-white outline-none focus:border-[#BC13FE]" value={batchSettingsDraft.batchOutTime} onChange={event => setBatchSettingsDraft(current => ({ ...current, batchOutTime: event.target.value || '21:00' }))} />
                    </label>
                    <div className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs leading-relaxed text-zinc-400">Transactions after this time belong to the next business day. If the app is closed at the cutoff, the missed batch is recorded once when the desktop app next opens.</div>
                    <label className="block text-sm text-zinc-300">Email schedule
                      <select className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-white outline-none focus:border-[#BC13FE]" value={batchSettingsDraft.schedule} onChange={event => setBatchSettingsDraft(current => ({ ...current, schedule: event.target.value as EodSettings['schedule'] }))}>
                        <option value="manual">Manual only</option>
                        <option value="daily">Daily</option>
                      </select>
                    </label>
                    <label className="block text-sm text-zinc-300">Daily report email time
                      <input type="time" disabled={batchSettingsDraft.schedule === 'manual'} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-white outline-none focus:border-[#BC13FE] disabled:opacity-40" value={batchSettingsDraft.sendTime} onChange={event => setBatchSettingsDraft(current => ({ ...current, sendTime: event.target.value || '18:00' }))} />
                    </label>
                    <div className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-300"><div>Last Batch Out: {batchInfo?.lastBatchOutDate ? formatDate(batchInfo.lastBatchOutDate) : 'Not yet run'}</div><div className="mt-1">Last email: {savedSettings.lastSentAt ? formatDate(savedSettings.lastSentAt) : 'Not yet sent'}</div></div>
                  </div>
                  <footer className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                    <button type="button" disabled={sending} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm disabled:opacity-50" onClick={() => void handleBatchOutNow()}>Batch Out Now</button>
                    <span className="flex gap-2"><button type="button" className="flex-1 rounded border border-zinc-700 px-3 py-2 text-sm" onClick={() => setShowBatchSettings(false)}>Cancel</button><button type="button" className="flex-1 rounded bg-[#BC13FE] px-4 py-2 text-sm font-semibold text-white" onClick={saveBatchSettings}>Save</button></span>
                  </footer>
                </section>
              </div>
            ) : null}

            {showCommissionPanel ? (
              <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 p-4" onClick={() => setShowCommissionPanel(false)}>
                <div className="mt-10 w-full max-w-6xl max-h-[calc(100vh-5rem)] overflow-auto rounded-xl border border-zinc-700 bg-zinc-950 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.6)]" onClick={e => e.stopPropagation()}>
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <h3 className="text-xl font-semibold text-zinc-100">Monthly Totals & Technician Summary</h3>
                      <div className="text-xs text-zinc-500 mt-1">Monthly sales, repairs, and commission stay out of the daily batch flow so the report stays focused on same-day intake.</div>
                    </div>
                    <button
                      type="button"
                      className="px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded hover:border-[#39FF14]"
                      onClick={() => setShowCommissionPanel(false)}
                    >Close</button>
                  </div>

                  <div className="grid grid-cols-12 gap-3">
                    <div className="col-span-12 lg:col-span-4 bg-zinc-900 border border-zinc-800 rounded-lg p-3 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
                      <div className="flex items-center justify-between">
                        <h3 className="text-lg font-semibold">Monthly totals</h3>
                        <div className="text-xs text-zinc-500">{(COMMISSION_RATE * 100).toFixed(0)}% (non-consultation)</div>
                      </div>
                      <div className="mt-3 space-y-2">
                        <div>
                          <label className="block text-xs text-zinc-400 mb-1">Commission period</label>
                          <select
                            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-2 text-sm"
                            value={commissionRange}
                            onChange={e => setCommissionRange(e.target.value as CommissionRangeKey)}
                          >
                            <option value="currentMonth">This month</option>
                            <option value="previousMonth">Previous month</option>
                            <option value="currentYear">This year</option>
                            <option value="custom">Custom</option>
                          </select>
                        </div>
                        {commissionRange === 'custom' ? (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs text-zinc-400 mb-1">From</label>
                              <input type="date" className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" value={commissionCustomFrom} onChange={e => setCommissionCustomFrom(e.target.value)} />
                            </div>
                            <div>
                              <label className="block text-xs text-zinc-400 mb-1">To</label>
                              <input type="date" className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" value={commissionCustomTo} onChange={e => setCommissionCustomTo(e.target.value)} />
                            </div>
                          </div>
                        ) : null}
                        <div className="text-[11px] text-zinc-500">Uses collected payments during {commissionLabel}. Eligible sales contribute {commissionSettings.salesCommissionPercent}% to the shared pool. Consultations pay the assigned technician {formatCurrency(commissionSettings.consultationTechHourlyRate)} per logged hour.</div>
                      </div>
                      <div className="mt-2 space-y-2 text-sm">
                        <div className="flex items-center justify-between"><span className="text-zinc-300">Repair collected</span><span className="font-semibold">{formatCurrency(monthlyBatchSummary.workCollected)}</span></div>
                        <div className="flex items-center justify-between"><span className="text-zinc-300">Sales collected</span><span className="font-semibold">{formatCurrency(monthlyBatchSummary.saleCollected)}</span></div>
                        <div className="flex items-center justify-between"><span className="text-zinc-300">Combined collected</span><span className="font-semibold">{formatCurrency(monthlyBatchSummary.combinedCollected)}</span></div>
                        <div className="flex items-center justify-between text-xs text-zinc-500"><span>Repair / sale records</span><span>{monthlyBatchSummary.workCount} / {monthlyBatchSummary.saleCount}</span></div>
                        <div className="pt-2 border-t border-zinc-800" />
                        <div className="flex items-center justify-between"><span className="text-zinc-300">Commissionable collected</span><span className="font-semibold">{formatCurrency(commissionSummary.commissionableNet)}</span></div>
                        <div className="flex items-center justify-between"><span className="text-zinc-300">Sales commission</span><span className="font-semibold">{formatCurrency(commissionSummary.salesCommission)}</span></div>
                        <div className="flex items-center justify-between"><span className="text-zinc-300">Consultation collected</span><span className="font-semibold">{formatCurrency(commissionSummary.consultationNet)}</span></div>
                        <div className="flex items-center justify-between"><span className="text-zinc-300">Consultation payout</span><span className="font-semibold">{formatCurrency(commissionSummary.consultationPayout)}</span></div>
                        <div className="flex items-center justify-between text-[#39FF14]"><span className="text-zinc-100">Total payout</span><span className="font-semibold">{formatCurrency(commissionSummary.commission)}</span></div>
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-2">Uses collected payments during the selected month or custom range. Discount is allocated proportionally across sale item categories.</div>
                    </div>

                    <div className="col-span-12 lg:col-span-8 bg-zinc-900 border border-zinc-800 rounded-lg p-3 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-lg font-semibold">Sales by Category</h3>
                        <div className="text-xs text-zinc-500">{salesCommissionInRange.length} sale record{salesCommissionInRange.length === 1 ? '' : 's'} with collected payments in {commissionLabel}</div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs uppercase tracking-wide text-zinc-400">
                              <th className="py-2 pr-4">Category</th>
                              <th className="py-2 pr-4 text-right">Tickets</th>
                              <th className="py-2 pr-4 text-right">Collected</th>
                              <th className="py-2 pr-4 text-right">Commissionable</th>
                              <th className="py-2 text-right">Consult payout</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800">
                            {salesCategoryTotals.map(r => (
                              <tr key={r.category} className="hover:bg-zinc-800/40">
                                <td className="py-2 pr-4">{r.category}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{r.count}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{formatCurrency(r.collected)}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{formatCurrency(r.commissionableCollected)}</td>
                                <td className="py-2 text-right tabular-nums font-semibold">{formatCurrency(r.consultationPayout)}</td>
                              </tr>
                            ))}
                            {!salesCategoryTotals.length && (
                              <tr><td colSpan={5} className="py-6 text-center text-zinc-500">No sales with collected payments in this commission period.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 bg-zinc-900 border border-zinc-800 rounded-lg p-3 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <h3 className="text-lg font-semibold">Technician Summary</h3>
                        <div className="text-xs text-zinc-500">Report-range activity plus commission-period payout totals, so payout rows show the sales that generated them.</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-zinc-400">Technician</label>
                        <select
                          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-2 text-sm min-w-[220px]"
                          value={techSummary}
                          onChange={e => setTechSummary(e.target.value)}
                        >
                          <option value="">All technicians</option>
                          {technicianOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {!techSummaryKey ? (
                      <div className="mt-3 overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs uppercase tracking-wide text-zinc-400">
                              <th className="py-2 pr-4">Technician</th>
                              <th className="py-2 pr-4 text-right">Report sales</th>
                              <th className="py-2 pr-4 text-right">Commission sales</th>
                              <th className="py-2 pr-4 text-right">Checked out</th>
                              <th className="py-2 pr-4 text-right">Partial paid</th>
                              <th className="py-2 pr-4 text-right">Collected</th>
                              <th className="py-2 pr-4 text-right">Remaining</th>
                              <th className="py-2 pr-4 text-right">Consult payout</th>
                              <th className="py-2 text-right">Total payout</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800">
                            {technicianSummaryRows.map(r => (
                              <tr key={r.tech} className="hover:bg-zinc-800/40">
                                <td className="py-2 pr-4">{techAliasToCanonical.labelMap.get(r.tech) || r.tech}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{r.sales}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{r.commissionSales}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{r.checkedOut}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{r.partialPaid}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{formatCurrency(r.collected)}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{formatCurrency(r.remaining)}</td>
                                <td className="py-2 pr-4 text-right tabular-nums">{formatCurrency(r.consultationPayout)}</td>
                                <td className="py-2 text-right tabular-nums font-semibold text-[#39FF14]">{formatCurrency(r.commission)}</td>
                              </tr>
                            ))}
                            {!technicianSummaryRows.length && (
                              <tr><td colSpan={9} className="py-6 text-center text-zinc-500">No technician activity in range.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-3 grid grid-cols-12 gap-3">
                        <div className="col-span-12 lg:col-span-4 bg-zinc-800 border border-zinc-700 rounded p-3">
                          <div className="text-xs text-zinc-400">Sales (net)</div>
                          <div className="text-2xl font-semibold">{formatCurrency(techSummaryTotals?.salesNet || 0)}</div>
                          <div className="text-[11px] text-zinc-400">{techSummaryTotals?.salesCount || 0} sale record{(techSummaryTotals?.salesCount || 0) === 1 ? '' : 's'}</div>
                          <div className="mt-3 text-xs text-zinc-400">Collected in report range</div>
                          <div className="text-xl font-semibold">{formatCurrency(techSummaryTotals?.collected || 0)}</div>
                          <div className="text-[11px] text-zinc-400">Billed {formatCurrency(techSummaryTotals?.billed || 0)} · Remaining {formatCurrency(techSummaryTotals?.remaining || 0)}</div>
                          <div className="mt-3 text-xs text-zinc-400">Checked out / partial paid</div>
                          <div className="text-xl font-semibold">{techSummaryTotals?.checkedOut || 0} / {techSummaryTotals?.partialPaid || 0}</div>
                          <div className="mt-3 text-xs text-zinc-400">Sales commission</div>
                          <div className="text-xl font-semibold">{formatCurrency(techSummaryTotals?.salesCommission || 0)}</div>
                          <div className="mt-3 text-xs text-zinc-400">Consultation payout</div>
                          <div className="text-xl font-semibold">{formatCurrency(techSummaryTotals?.consultationPayout || 0)}</div>
                          <div className="mt-3 text-xs text-zinc-400">Total payout</div>
                          <div className="text-xl font-semibold text-[#39FF14]">{formatCurrency(techSummaryTotals?.commission || 0)}</div>
                          <div className="mt-3 text-xs text-zinc-400">Work orders</div>
                          <div className="text-xl font-semibold">{techSummaryTotals?.workCount || 0}</div>
                          <div className="text-[11px] text-zinc-400">{formatCurrency(techSummaryTotals?.workTotal || 0)} total</div>
                        </div>

                        <div className="col-span-12 lg:col-span-8 grid grid-cols-1 xl:grid-cols-2 gap-3">
                          <div className="bg-zinc-800 border border-zinc-700 rounded p-3">
                            <div className="text-sm font-semibold mb-2">Recent Sales</div>
                            <div className="max-h-[260px] overflow-auto">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-xs uppercase tracking-wide text-zinc-400">
                                    <th className="py-1 pr-2 text-left">Invoice</th>
                                    <th className="py-1 pr-2 text-left">Date</th>
                                    <th className="py-1 pr-2 text-right">Collected</th>
                                    <th className="py-1 text-right">Payout</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-700">
                                  {techSummarySales.slice(0, 15).map(r => (
                                    <tr key={String(r.id)} className="hover:bg-zinc-900/40">
                                      <td className="py-1 pr-2 font-mono">{typeof r.id === 'number' ? `GB${String(r.id).padStart(7,'0')}` : String(r.id || '')}</td>
                                      <td className="py-1 pr-2">{r.date.toISOString().slice(0,10)}</td>
                                      <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.totalNet)}</td>
                                      <td className="py-1 text-right tabular-nums text-[#39FF14]">{formatCurrency(r.commission)}</td>
                                    </tr>
                                  ))}
                                  {!techSummarySales.length && (
                                    <tr><td colSpan={4} className="py-6 text-center text-zinc-500">No sales for this tech in range.</td></tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>

                          <div className="bg-zinc-800 border border-zinc-700 rounded p-3">
                            <div className="text-sm font-semibold mb-2">Recent Work Orders</div>
                            <div className="max-h-[260px] overflow-auto">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-xs uppercase tracking-wide text-zinc-400">
                                    <th className="py-1 pr-2 text-left">Invoice</th>
                                    <th className="py-1 pr-2 text-left">Date</th>
                                    <th className="py-1 pr-2 text-left">Status</th>
                                    <th className="py-1 text-right">Total</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-700">
                                  {techSummaryWorkOrders.slice(0, 15).map(r => (
                                    <tr key={String(r.id)} className="hover:bg-zinc-900/40">
                                      <td className="py-1 pr-2 font-mono">{typeof r.id === 'number' ? `GB${String(r.id).padStart(7,'0')}` : String(r.id || '')}</td>
                                      <td className="py-1 pr-2">{r.date.toISOString().slice(0,10)}</td>
                                      <td className="py-1 pr-2">{(r.status || '').toString()}</td>
                                      <td className="py-1 text-right tabular-nums">{formatCurrency(r.total)}</td>
                                    </tr>
                                  ))}
                                  {!techSummaryWorkOrders.length && (
                                    <tr><td colSpan={4} className="py-6 text-center text-zinc-500">No work orders for this tech in range.</td></tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {listMeta ? (
              <div className="gb-eod-list-layer fixed inset-0 z-[100090] flex items-center justify-center bg-black/75 p-3" onClick={() => setActiveList(null)}>
              <div className="gb-eod-list-dialog flex h-[94vh] max-h-[94vh] w-full max-w-[1280px] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 p-3 shadow-[0_24px_90px_rgba(0,0,0,0.7)]" role="dialog" aria-modal="true" aria-label={listMeta.title} onClick={(event) => event.stopPropagation()}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-semibold">{listMeta.title}</h3>
                    <div className="text-xs text-zinc-500">{listMeta.rows.length} record{listMeta.rows.length === 1 ? '' : 's'} in view</div>
                  </div>
                  <button
                    type="button"
                    className="px-3 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded hover:border-[#39FF14]"
                    onClick={() => setActiveList(null)}
                  >Close</button>
                </div>
                {listMeta.rows.length ? (
                  <div className="gb-eod-list-scroll min-h-0 overflow-auto">
                    <table className="gb-eod-list-table min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-zinc-400">
                          <th className="py-2 pr-4">Ticket</th>
                          <th className="py-2 pr-4">Date</th>
                          <th className="py-2 pr-4">Type</th>
                          <th className="py-2 pr-4">Status</th>
                          <th className="py-2 pr-4 text-right">Total</th>
                          <th className="py-2 pr-4 text-right">Paid</th>
                          <th className="py-2 text-right">Remaining</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800">
                        {listMeta.rows.map(row => (
                          <tr
                            key={`${row.kind}-${row.id}`}
                            className="hover:bg-zinc-800/50 cursor-pointer transition-colors"
                            onDoubleClick={() => { void handleRowOpen(row); }}
                            onContextMenu={event => ticketContext.openFromEvent(event, row)}
                            onKeyDown={event => { if (event.key === 'Enter') void handleRowOpen(row); }}
                            tabIndex={0}
                            title="Double-click to open. Right-click or hold for options."
                          >
                            <td className="py-2 pr-4">
                              <div className="font-mono text-xs text-zinc-200">{row.id}</div>
                              {row.customerName ? <div className="text-[11px] text-zinc-400 truncate max-w-[220px]">{row.customerName}</div> : null}
                            </td>
                            <td className="py-2 pr-4 text-zinc-300">{row.date.toLocaleDateString()}</td>
                            <td className="py-2 pr-4 text-zinc-300">
                              <div className="capitalize">{row.kind === 'work' ? 'Work order' : 'Sale'}</div>
                              {row.title ? <div className="text-[11px] text-zinc-400 truncate max-w-[260px]">{row.title}</div> : null}
                            </td>
                            <td className="py-2 pr-4 text-zinc-400">
                              <div>{row.status || '—'}</div>
                              {!row.checkoutDate ? <div className="text-[11px] text-orange-200">Needs checkout</div> : null}
                              {row.paid > 0.01 && row.remaining > 0.01 ? <div className="text-[11px] text-yellow-200">Partial payment</div> : null}
                              {row.diagnosticLike ? <div className="text-[11px] text-zinc-300">Diagnostic</div> : null}
                            </td>
                            <td className="py-2 pr-4 text-right text-zinc-200">{formatCurrency(row.total)}</td>
                            <td className="py-2 pr-4 text-right text-zinc-200">{formatCurrency(row.paid)}</td>
                            <td className={`py-2 text-right ${row.remaining > 0.01 ? 'text-orange-300' : 'text-zinc-400'}`}>{formatCurrency(row.remaining)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-sm text-zinc-400">No records in this category for the selected range.</div>
                )}
              </div>
              </div>
            ) : null}

            {closeTicketCandidate ? (
              <div className="fixed inset-0 z-[100500] flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-4" onClick={() => { if (!closingTicket) setCloseTicketCandidate(null); }}>
                <section className="w-full max-w-lg rounded-t-lg border border-amber-500/60 bg-zinc-950 p-4 shadow-[0_24px_90px_rgba(0,0,0,0.8)] sm:rounded-lg" role="dialog" aria-modal="true" aria-label="Close ticket confirmation" onClick={event => event.stopPropagation()}>
                  <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-600 sm:hidden" />
                  <h3 className="text-xl font-semibold text-amber-200">Close ticket without collecting the balance?</h3>
                  <p className="mt-2 text-sm text-zinc-300">{closeTicketCandidate.kind === 'work' ? 'Work order' : 'Sale'} #{String(closeTicketCandidate.id)} will be marked checked out and closed. Existing payments remain unchanged.</p>
                  <div className="mt-4 grid grid-cols-2 gap-2 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
                    <div><span className="block text-xs text-zinc-500">Already collected</span><strong>{formatCurrency(closeTicketCandidate.paid)}</strong></div>
                    <div><span className="block text-xs text-zinc-500">Still owed</span><strong className="text-amber-200">{formatCurrency(closeTicketCandidate.remaining)}</strong></div>
                  </div>
                  <p className="mt-3 text-xs text-zinc-400">The remaining balance will stay on the invoice and will not be counted as money collected today.</p>
                  <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <button type="button" disabled={closingTicket} className="rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm disabled:opacity-50" onClick={() => setCloseTicketCandidate(null)}>Cancel</button>
                    <button type="button" disabled={closingTicket} className="rounded bg-amber-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50" onClick={() => { void handleCloseTicket(closeTicketCandidate); }}>{closingTicket ? 'Closing...' : 'Close Ticket'}</button>
                  </div>
                </section>
              </div>
            ) : null}

            <ContextMenu
              id="eod-ticket-context-menu"
              open={ticketContext.state.open}
              x={ticketContext.state.x}
              y={ticketContext.state.y}
              items={ticketContextItems}
              onClose={ticketContext.close}
              zIndex={100600}
            />

            <details className="hidden rounded-lg border border-zinc-800 bg-zinc-950/60">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-300 hover:text-[#39FF14]">Daily email and batch settings</summary>
            <div className="grid grid-cols-12 gap-3 p-3 pt-0">
              <div className="col-span-12 bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-col gap-3 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h3 className="text-lg font-semibold">Email report</h3>
                    <div className="text-xs text-zinc-500">Subject: {subject}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`text-xs ${draftPrefsDirty ? 'text-yellow-200' : 'text-zinc-500'}`}>{draftPrefsDirty ? 'Unsaved changes' : 'Using saved defaults'}</div>
                    <button
                      type="button"
                      className="px-3 py-2 text-xs bg-zinc-800 border border-zinc-700 rounded hover:border-[#39FF14] disabled:opacity-50"
                      onClick={resetDraftToSaved}
                      disabled={!draftPrefsDirty}
                      title="Discard changes and return to your saved default report preferences"
                    >Reset</button>
                    <button
                      type="button"
                      className="px-3 py-2 text-xs bg-[#39FF14] text-black border border-[#39FF14] rounded hover:brightness-110 disabled:opacity-50"
                      onClick={saveDraftAsDefault}
                      disabled={!draftPrefsDirty}
                      title="Save the current report preferences as your default"
                    >Save as default</button>
                  </div>
                </div>

                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-12 lg:col-span-7 flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-zinc-400 mb-1">Recipients</label>
                        <textarea
                          rows={2}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-2 text-sm"
                          placeholder="ops@gadgetboy.com; owner@gadgetboy.com"
                          value={draftSettings.recipients}
                          onChange={e => setDraftSettings(s => ({ ...s, recipients: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-zinc-400 mb-1">Subject</label>
                        <input
                          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-2 text-sm"
                          value={draftSettings.subject || ''}
                          onChange={e => setDraftSettings(s => ({ ...s, subject: e.target.value }))}
                        />
                        <div className="text-[11px] text-zinc-500 mt-1">Sent at the scheduled batch-out time.</div>
                      </div>
                    </div>

                    <div className="bg-zinc-800 border border-zinc-700 rounded p-3">
                      <div className="text-sm font-semibold mb-2">Report preferences (this send)</div>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={!!draftSettings.includePayments} onChange={e => setDraftSettings(s => ({ ...s, includePayments: e.target.checked }))} />
                          <span>Include payment totals (total/card/cash)</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={!!draftSettings.includeCounts} onChange={e => setDraftSettings(s => ({ ...s, includeCounts: e.target.checked }))} />
                          <span>Include counts (check-ins/closed)</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={!!draftSettings.includeWorkOrders} onChange={e => setDraftSettings(s => ({ ...s, includeWorkOrders: e.target.checked }))} />
                          <span>Include work order summary line</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={!!draftSettings.includeSales} onChange={e => setDraftSettings(s => ({ ...s, includeSales: e.target.checked }))} />
                          <span>Include sales summary line</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={!!draftSettings.includeOutstanding} onChange={e => setDraftSettings(s => ({ ...s, includeOutstanding: e.target.checked }))} />
                          <span>Include outstanding total line</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={!!draftSettings.includeBatchInfo} onChange={e => setDraftSettings(s => ({ ...s, includeBatchInfo: e.target.checked }))} />
                          <span>Include batch info (last batch out / sent stamp)</span>
                        </label>
                      </div>

                      <div className="mt-3 pt-3 border-t border-zinc-700">
                        <div className="text-xs text-zinc-400 mb-2">Optional detail tables (emails can get long)</div>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={!!draftSettings.emailIncludeWorkOrdersDetails} onChange={e => setDraftSettings(s => ({ ...s, emailIncludeWorkOrdersDetails: e.target.checked }))} />
                            <span>Work orders table</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={!!draftSettings.emailIncludeSalesDetails} onChange={e => setDraftSettings(s => ({ ...s, emailIncludeSalesDetails: e.target.checked }))} />
                            <span>Sales table</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={!!draftSettings.emailIncludeOutstandingDetails} onChange={e => setDraftSettings(s => ({ ...s, emailIncludeOutstandingDetails: e.target.checked }))} />
                            <span>Outstanding balances table</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={!!draftSettings.emailIncludeOpenTickets} onChange={e => setDraftSettings(s => ({ ...s, emailIncludeOpenTickets: e.target.checked }))} />
                            <span>Open tickets table</span>
                          </label>
                          <label className="flex items-center gap-2 col-span-2">
                            <input type="checkbox" checked={!!draftSettings.emailIncludeTechnicianSummary} onChange={e => setDraftSettings(s => ({ ...s, emailIncludeTechnicianSummary: e.target.checked }))} />
                            <span>Technician summary table</span>
                          </label>
                        </div>
                        <div className="text-[11px] text-zinc-500 mt-1">Tables are capped (usually first/top 20) to keep emails readable.</div>
                      </div>
                    </div>
                  </div>

                  <div className="col-span-12 lg:col-span-5">
                    <label className="block text-xs text-zinc-400 mb-1">Email preview</label>
                    <div className="bg-zinc-800 border border-zinc-700 rounded p-3 text-xs text-zinc-200 space-y-2">
                      <div className="font-semibold text-zinc-100">Preview</div>
                      <div className="rounded border border-zinc-700 overflow-auto max-h-[680px] p-3 space-y-3">
                        <div className="text-sm font-semibold text-[#39FF14]">Batch report for {rangeLabel(range, start, end)}</div>
                        {!reportHasAnyActivity ? (
                          <div className="text-sm text-zinc-300">No activity in range.</div>
                        ) : (
                          <div className="grid grid-cols-1 gap-1 text-sm">
                            {draftSettings.includePayments ? (
                              <>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Total taken in</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.totalTaken)}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Card</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.cardTotal)}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Cash</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.cashTotal)}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Parts charged</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.partsSold)}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Parts COGS</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.partsCost)}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Products sold</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.productsSold)}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Product COGS</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.productsCost)}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Parts supplier spend</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.supplierSpendParts)}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Products supplier spend</div><div className="tabular-nums">{formatCurrency(dailyBatchSummary.supplierSpendProducts)}</div></div>
                              </>
                            ) : null}
                            {draftSettings.includeCounts ? (
                              <>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Check-ins</div><div className="tabular-nums">{dailyBatchSummary.checkInCount}</div></div>
                                <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Closed tickets</div><div className="tabular-nums">{dailyBatchSummary.closedTicketCount}</div></div>
                              </>
                            ) : null}
                            {draftSettings.includeWorkOrders ? (
                              <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Work orders</div><div className="tabular-nums">{summary.woTotals.count} · Collected {formatCurrency(summary.woTotals.collected)} · Remaining {formatCurrency(summary.woTotals.remaining)}</div></div>
                            ) : null}
                            {draftSettings.includeSales ? (
                              <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Sales</div><div className="tabular-nums">{summary.saTotals.count} · Collected {formatCurrency(summary.saTotals.collected)} · Remaining {formatCurrency(summary.saTotals.remaining)}</div></div>
                            ) : null}
                            {draftSettings.includeOutstanding ? (
                              <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Outstanding total</div><div className="tabular-nums">{formatCurrency(summary.grandRemaining)}</div></div>
                            ) : null}
                            {draftSettings.includeBatchInfo ? (
                              <div className="flex items-center justify-between gap-3"><div className="text-zinc-400">Last Batch Out</div><div className="tabular-nums">{batchInfo?.lastBatchOutDate ? formatDate(batchInfo.lastBatchOutDate) : 'Not yet run'}</div></div>
                            ) : null}
                          </div>
                        )}

                        {trendData ? (
                          <div className="pt-3 border-t border-zinc-700">
                            <div className="text-sm font-semibold text-zinc-100">Trends ({trendData.kind === 'week' ? 'This week' : 'This month'})</div>
                            <div className="overflow-x-auto mt-2">
                              <table className="min-w-full text-sm">
                                <thead>
                                  <tr className="text-xs uppercase tracking-wide text-zinc-400">
                                    <th className="py-1 pr-2 text-left">{trendData.kind === 'week' ? 'Day' : 'Week'}</th>
                                    <th className="py-1 pr-2 text-right">Collected</th>
                                    <th className="py-1 text-right">Tx</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-700">
                                  {trendData.kind === 'week' ? (
                                    (trendData.rows as Array<{ day: Date; collected: number; transactions: number }>).map(r => (
                                      <tr key={r.day.toISOString()}>
                                        <td className="py-1 pr-2 text-zinc-300">{r.day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                                        <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.collected)}</td>
                                        <td className="py-1 text-right tabular-nums">{r.transactions}</td>
                                      </tr>
                                    ))
                                  ) : (
                                    (trendData.rows as Array<{ start: Date; end: Date; collected: number; transactions: number }>).map(w => (
                                      <tr key={w.start.toISOString()}>
                                        <td className="py-1 pr-2 text-zinc-300">{w.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {w.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                                        <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(w.collected)}</td>
                                        <td className="py-1 text-right tabular-nums">{w.transactions}</td>
                                      </tr>
                                    ))
                                  )}
                                  <tr>
                                    <td className="py-1 pr-2 font-semibold text-zinc-200">Total</td>
                                    <td className="py-1 pr-2 text-right font-semibold tabular-nums text-zinc-200">{formatCurrency(trendData.totalCollected)}</td>
                                    <td className="py-1 text-right font-semibold tabular-nums text-zinc-200">{trendData.totalTx}</td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ) : null}

                        {(draftSettings.emailIncludeWorkOrdersDetails || draftSettings.emailIncludeSalesDetails || draftSettings.emailIncludeOutstandingDetails || draftSettings.emailIncludeOpenTickets || draftSettings.emailIncludeTechnicianSummary) ? (
                          <div className="text-[11px] text-zinc-500">Detail tables (if enabled) are included in the emailed report.</div>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-zinc-500">Plain text fallback is sent automatically (not shown).</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="col-span-12 bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-col gap-3 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
                <h3 className="text-lg font-semibold">EOD Batches</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Schedule</label>
                    <select
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-2"
                        value={savedSettings.schedule}
                        onChange={e => {
                          const next = e.target.value as EodSettings['schedule'];
                          setSavedSettings(s => ({
                            ...s,
                            schedule: next,
                            sendTime: s.sendTime || '18:00',
                          }));
                        }}
                    >
                      <option value="manual">Manual only</option>
                      <option value="daily">Daily</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Send time</label>
                      <input
                        type="time"
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-2"
                        value={savedSettings.sendTime}
                        onChange={e => setSavedSettings(s => ({ ...s, sendTime: e.target.value }))}
                      />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Batch Out time</label>
                      <input type="time" className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-2" value={savedSettings.batchOutTime || ''} onChange={e => setSavedSettings(s => ({ ...s, batchOutTime: e.target.value }))} />
                  </div>
                </div>
                <div className="text-xs text-zinc-500 -mt-1">
                  This schedule sends today&apos;s EOD snapshot only. Monthly reporting remains available in Reporting.
                </div>
                <div className="bg-zinc-800 border border-zinc-700 rounded p-2 text-xs text-zinc-300 leading-relaxed">
                    <div>Last sent: {savedSettings.lastSentAt ? formatDate(savedSettings.lastSentAt) : 'Not yet sent'}</div>
                  <div>Last Batch Out: {batchInfo?.lastBatchOutDate ? formatDate(batchInfo.lastBatchOutDate) : 'Not yet run'}</div>
                </div>
                <div className="flex gap-2">
                  <button className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded" onClick={() => handleBatchOutNow()} disabled={sending}>Run Batch Out now</button>
                  <button className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded" onClick={() => handleSend()} disabled={sending}>{sending ? 'Sending…' : 'Send email'}</button>
                </div>
              </div>
            </div>
            </details>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 bg-zinc-900 border border-zinc-800 rounded-lg p-4 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold">Monthly volume (last 12 months)</h3>
                <span className="text-xs text-zinc-500">{trendRows.length} total records</span>
              </div>
              <div className="space-y-2">
                {monthlyTrends.map(item => {
                  const max = Math.max(1, ...monthlyTrends.map(m => m.count));
                  const pct = Math.max(0, Math.min(100, Math.round((item.count / (max * 1.15)) * 100)));
                  return (
                    <div key={item.key} className="flex items-center gap-3">
                      <div className="w-28 text-xs text-zinc-400">{item.label}</div>
                      <div className="flex-1 h-3 bg-zinc-800 rounded overflow-hidden">
                        <div className="h-3 bg-[#39FF14]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-16 text-right text-xs text-zinc-300">{item.count}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="col-span-12 lg:col-span-4 bg-zinc-900 border border-zinc-800 rounded-lg p-4 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
              <h3 className="text-lg font-semibold mb-3">Busiest days</h3>
              <div className="space-y-2">
                {busiestDays.map(item => {
                  const max = Math.max(1, ...busiestDays.map(d => d.count));
                  const pct = Math.max(0, Math.min(100, Math.round((item.count / (max * 1.15)) * 100)));
                  return (
                    <div key={item.label} className="flex items-center gap-3">
                      <div className="w-10 text-xs text-zinc-400">{item.label}</div>
                      <div className="flex-1 h-3 bg-zinc-800 rounded overflow-hidden">
                        <div className="h-3 bg-[#39FF14]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-10 text-right text-xs text-zinc-300">{item.count}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="col-span-12 lg:col-span-4 bg-zinc-900 border border-zinc-800 rounded-lg p-4 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
              <h3 className="text-lg font-semibold mb-3">Popular devices</h3>
              <div className="space-y-2">
                {topDevices.map(item => {
                  const max = Math.max(1, ...topDevices.map(d => d.count));
                  const pct = Math.max(0, Math.min(100, Math.round((item.count / (max * 1.15)) * 100)));
                  return (
                    <div key={item.label} className="flex items-center gap-3">
                      <div className="w-28 text-xs text-zinc-400 truncate">{item.label}</div>
                      <div className="flex-1 h-3 bg-zinc-800 rounded overflow-hidden">
                        <div className="h-3 bg-[#39FF14]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-10 text-right text-xs text-zinc-300">{item.count}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="col-span-12 lg:col-span-4 bg-zinc-900 border border-zinc-800 rounded-lg p-4 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
              <h3 className="text-lg font-semibold mb-3">Popular repairs</h3>
              <div className="space-y-2">
                {topRepairs.map(item => {
                  const max = Math.max(1, ...topRepairs.map(d => d.count));
                  const pct = Math.max(0, Math.min(100, Math.round((item.count / (max * 1.15)) * 100)));
                  return (
                    <div key={item.label} className="flex items-center gap-3">
                      <div className="w-28 text-xs text-zinc-400 truncate">{item.label}</div>
                      <div className="flex-1 h-3 bg-zinc-800 rounded overflow-hidden">
                        <div className="h-3 bg-[#39FF14]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-10 text-right text-xs text-zinc-300">{item.count}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default EODWindow;
