import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AssignedTechnicianAvatar from '../components/AssignedTechnicianAvatar';
import { consumeWindowPayload } from '../lib/windowPayload';
import { printSaleReleaseForm, SaleOrderPrint } from './salePrint';
import WorkOrderSidebar from '@/workorders/WorkOrderSidebar';
import IntakePanel from '@/workorders/IntakePanel';
import PaymentPanel from '@/workorders/PaymentPanel';
import { round2 } from '@/lib/calc';
import { WorkOrderFull } from '@/lib/types';
import SaleItemsTable, { SaleItemRow } from './SaleItemsTable';
import { discountedLineTotal } from '@/lib/ticketAccounting';
import ClientUpdatePanel from '@/workorders/ClientUpdatePanel';
import { consumeInStockInventory } from '@/lib/inventoryConsumption';
import { consultationDigest } from '@/lib/automaticClientEmail';
import { consultationEmailDetails, queueConsultationEmail, queueInitialPaymentAcknowledgment } from '@/lib/automaticEmailQueue';
import { listTechnicians } from '@/lib/admin';

type SalePayload = {
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
};

type SaleRecord = {
  id?: number;
  createdAt?: string;
  updatedAt?: string;
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  // legacy single-item fields (kept for backward-compat in prints/receipt)
  itemDescription?: string;
  quantity?: number;
  price?: number;
  // new multi-item list
  items?: SaleItemRow[];
  inStock?: boolean; // true when item is available immediately
  orderedDate?: string | null; // YYYY-MM-DD
  estimatedDeliveryDate?: string | null; // YYYY-MM-DD
  partsOrderUrl?: string;
  partsTrackingUrl?: string;
  notes?: string;
  total?: number;
  // Fields to align with shared panels
  status?: string;
  assignedTo?: string | null;
  checkInAt?: string | null;
  repairCompletionDate?: string | null;
  checkoutDate?: string | null;
  clientPickupDate?: string | null;
  intakeSource?: string;
  discount?: number;
  amountPaid?: number;
  taxRate?: number;
  laborCost?: number;
  partCosts?: number;
  totals?: { subTotal: number; tax: number; total: number; remaining: number };
  internalCost?: number; // deprecated: moved per-item; kept for old records
  condition?: 'New' | 'Excellent' | 'Good' | 'Fair'; // deprecated: moved per-item
  consultationHours?: number; // legacy mirror of first consultation item
};

/** Kept in the main form so every sale has the same clear ownership control as a work order. */
const SaleTechnicianField: React.FC<{
  value?: string | null;
  invalid?: boolean;
  onChange: (assignedTo: string | null) => void;
}> = ({ value, invalid = false, onChange }) => {
  const [techs, setTechs] = useState<any[]>([]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const technicians = await listTechnicians();
        if (mounted) setTechs(Array.isArray(technicians) ? technicians : []);
      } catch {
        if (mounted) setTechs([]);
      }
    };
    void refresh();
    const off = (window as any).api?.onTechniciansChanged?.(() => void refresh());
    return () => { mounted = false; try { off?.(); } catch {} };
  }, []);

  const selectedTechId = useMemo(() => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (techs.some((tech) => String(tech.id) === raw)) return raw;
    const namedMatch = techs.find((tech) => String(tech.nickname?.trim() || tech.firstName || '') === raw);
    return namedMatch ? String(namedMatch.id) : '';
  }, [techs, value]);

  return (
    <section className="gb-wo-top-card rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-2">
      <label className="block text-xs text-zinc-400">
        Assigned to
        {invalid ? <span className="ml-1 text-red-500">*</span> : null}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <AssignedTechnicianAvatar assignedTo={value} />
        {techs.length === 0 ? (
          <select disabled className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-500">
            <option>No technicians</option>
          </select>
        ) : (
          <select
            className={`min-w-0 flex-1 rounded border bg-zinc-800 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand ${invalid ? 'border-red-500' : 'border-zinc-700'}`}
            value={selectedTechId}
            onChange={(event) => onChange(event.target.value || null)}
          >
            <option value="">Unassigned</option>
            {techs.map((tech) => <option key={tech.id} value={String(tech.id)}>{tech.nickname?.trim() || tech.firstName}</option>)}
          </select>
        )}
      </div>
    </section>
  );
};

const CONSULTATION_BASE_RATE = 75;    // covers first hour + at-home travel within range
const CONSULTATION_EXTRA_RATE = 50;   // each additional hour after the first
const CONSULTATION_DISTANCE_FEE = 20; // applied when client is >15 miles from shop
const CONSULTATION_DISTANCE_THRESHOLD = 15; // miles

// Haversine formula – returns distance in miles between two lat/lng points
function haversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const GEOCODE_CACHE = new Map<string, { lat: number; lng: number } | null>();

async function geocodeAddress(address: string, near?: { lat: number; lng: number }): Promise<{ lat: number; lng: number } | null> {
  try {
    const q = String(address || '').trim();
    if (!q) return null;

    const cacheKey = `${q.toLowerCase()}|${near ? `${near.lat.toFixed(4)},${near.lng.toFixed(4)}` : ''}`;
    if (GEOCODE_CACHE.has(cacheKey)) return GEOCODE_CACHE.get(cacheKey) ?? null;

    const params = new URLSearchParams({
      q,
      format: 'json',
      limit: '5',
      addressdetails: '1',
      countrycodes: 'us',
    });

    // If we know the shop coords, strongly bias results to the local area to avoid
    // ambiguous addresses resolving to another state (e.g., same street name).
    if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
      const delta = 1.0; // ~69 miles latitude; plenty for local consultations
      const left = (near.lng - delta).toFixed(6);
      const right = (near.lng + delta).toFixed(6);
      const top = (near.lat + delta).toFixed(6);
      const bottom = (near.lat - delta).toFixed(6);
      params.set('viewbox', `${left},${top},${right},${bottom}`);
    }

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params.toString()}`,
      { headers: { 'Accept-Language': 'en-US,en' } }
    );
    const data = await res.json() as any[];
    if (!Array.isArray(data) || !data.length) {
      GEOCODE_CACHE.set(cacheKey, null);
      return null;
    }

    const parsed = data
      .map((d) => ({
        lat: Number.parseFloat(String(d?.lat ?? '')),
        lng: Number.parseFloat(String(d?.lon ?? '')),
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!parsed.length) {
      GEOCODE_CACHE.set(cacheKey, null);
      return null;
    }

    let best = parsed[0];
    if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
      let bestD = Number.POSITIVE_INFINITY;
      for (const p of parsed) {
        const d = haversineDistanceMiles(near.lat, near.lng, p.lat, p.lng);
        if (d < bestD) { bestD = d; best = p; }
      }
    }

    GEOCODE_CACHE.set(cacheKey, best);
    return best;
  } catch {
    return null;
  }
}

// Add minutes to a HH:MM time string; returns null if base time is empty
function addHoursToTime(time: string, hours: number): string | null {
  if (!time) return null;
  const [hStr, mStr] = time.split(':');
  const totalMin = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) + Math.round(hours * 60);
  const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
  const mm = String(totalMin % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

type SaleRequiredKey = 'assignedTo' | 'itemDetails';

type ValidationActionKey = 'save' | 'checkout' | 'close';

const SALE_REQUIRED_LABELS: Record<SaleRequiredKey, string> = {
  assignedTo: 'Assigned technician',
  itemDetails: 'At least one product',
};

function readPayload(): SalePayload | null {
  try {
    const stored = consumeWindowPayload('newSale');
    if (stored !== null) return stored as SalePayload;
  } catch {}
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('newSale');
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

async function findConsultationEventId(saleIdInput: any): Promise<number> {
  const saleId = Number(saleIdInput) || 0;
  if (!saleId) return 0;
  try {
    const events = await (window as any).api?.dbGet?.('calendarEvents');
    const match = Array.isArray(events)
      ? events.find((event: any) => Number(event?.saleId || 0) === saleId && String(event?.category || '').toLowerCase() === 'consultation')
      : null;
    return Number(match?.id || 0) || 0;
  } catch {
    return 0;
  }
}

function parseCheckoutPaymentDate(value: any): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function checkoutPaymentAppliedAmount(payment: any): number {
  const applied = Number(payment?.applied);
  if (Number.isFinite(applied) && applied > 0) return round2(applied);
  const amount = Number(payment?.amount ?? payment?.tender ?? payment?.paid ?? 0);
  const change = Number(payment?.change ?? payment?.changeDue ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (Number.isFinite(change) && change > 0) return round2(Math.max(0, amount - change));
  return round2(amount);
}

function buildNormalizedCheckoutPayments(record: any) {
  const existing = Array.isArray(record?.payments)
    ? [...record.payments]
    : Array.isArray(record?.paymentHistory)
      ? [...record.paymentHistory]
      : Array.isArray(record?.paymentLogs)
        ? [...record.paymentLogs]
        : [];
  const paid = round2(Number(record?.amountPaid || 0) || 0);
  const recorded = round2(existing.reduce((sum: number, payment: any) => sum + checkoutPaymentAppliedAmount(payment), 0));
  const missing = round2(paid - recorded);
  if (missing <= 0.009) return existing;

  const anchor = parseCheckoutPaymentDate(record?.checkoutDate)
    || parseCheckoutPaymentDate(record?.saleDate)
    || parseCheckoutPaymentDate(record?.transactionDate)
    || parseCheckoutPaymentDate(record?.invoiceDate)
    || parseCheckoutPaymentDate(record?.checkInAt)
    || parseCheckoutPaymentDate(record?.createdAt);
  if (!anchor) return existing;

  return [{
    amount: missing,
    applied: missing,
    paymentType: String(record?.paymentType || 'Legacy'),
    at: anchor,
    inferred: true,
  }, ...existing];
}

const SaleWindow: React.FC = () => {
  const payload = useMemo(() => readPayload() || {}, []);
  const [sale, setSale] = useState<Partial<SaleRecord>>({
    customerId: payload.customerId,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    items: [],
    inStock: false,
    orderedDate: null,
    estimatedDeliveryDate: null,
    partsOrderUrl: '',
    partsTrackingUrl: '',
    notes: '',
    // shared-panel fields
    status: 'open',
    assignedTo: null,
    checkInAt: new Date().toISOString(),
    repairCompletionDate: null,
    checkoutDate: null,
    intakeSource: '',
    discount: 0,
    amountPaid: 0,
    taxRate: 8,
    laborCost: 0,
    partCosts: 0,
    totals: { subTotal: 0, tax: 0, total: 0, remaining: 0 },
    // sales-only
    clientPickupDate: null as any,
    internalCost: undefined,
    condition: 'New',
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [clientUpdateTarget, setClientUpdateTarget] = useState<{ recordType: 'sale' | 'consult'; recordId: number } | null>(null);
  const [validationActive, setValidationActive] = useState<boolean>(false);
  const [warningBanner, setWarningBanner] = useState<{ message: string; details?: string } | null>(null);
  const [warningBannerVisible, setWarningBannerVisible] = useState<boolean>(false);
  const warningHideTimer = useRef<number | undefined>(undefined);
  const warningRemoveTimer = useRef<number | undefined>(undefined);
  const handleCheckoutRef = useRef<() => Promise<void>>(async () => {});
  const initialConsultationRef = useRef<any>(null);
  const [armedValidationActions, setArmedValidationActions] = useState<Record<ValidationActionKey, boolean>>({
    save: false,
    checkout: false,
    close: false,
  });

  // ── Consultation / Shop-address state ────────────────────────
  const [shopAddress, setShopAddress] = useState<string>('');
  const [shopLat, setShopLat] = useState<number | null>(null);
  const [shopLng, setShopLng] = useState<number | null>(null);
  const [shopAddressInput, setShopAddressInput] = useState<string>('');
  const [distanceMiles, setDistanceMiles] = useState<number | null>(null);
  const [distanceLoading, setDistanceLoading] = useState(false);
  const [distanceFeeApplied, setDistanceFeeApplied] = useState(false);

  type AddressHistoryRecord = { id: number; key?: string; address?: string; usedCount?: number; lastUsedAt?: string };
  const [addressHistory, setAddressHistory] = useState<AddressHistoryRecord[]>([]);
  const [addressMatches, setAddressMatches] = useState<AddressHistoryRecord[]>([]);
  const [addressSuggestOpen, setAddressSuggestOpen] = useState(false);
  const addressSuggestTimer = useRef<number | undefined>(undefined);

  const normalizeAddressKey = (s: string) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const refreshAddressHistory = useCallback(async () => {
    try {
      const list = await window.api.dbGet('addressHistory');
      setAddressHistory(Array.isArray(list) ? list : []);
    } catch {
      setAddressHistory([]);
    }
  }, []);

  const upsertAddressHistory = useCallback(async (addr: string) => {
    try {
      const address = String(addr || '').trim();
      // avoid storing tiny fragments; keep the DB clean
      if (address.length < 8) return;
      if (!/\d/.test(address)) return;
      const key = normalizeAddressKey(address);
      if (!key) return;

      const now = new Date().toISOString();
      const existing = (addressHistory || []).find((r) => normalizeAddressKey(String(r.key || r.address || '')) === key);
      if (existing?.id != null) {
        await window.api.dbUpdate('addressHistory', existing.id, {
          ...existing,
          key,
          address,
          usedCount: (Number(existing.usedCount) || 0) + 1,
          lastUsedAt: now,
        });
      } else {
        await window.api.dbAdd('addressHistory', { key, address, usedCount: 1, lastUsedAt: now });
      }

      // Cap to a reasonable size so we never bog the system down.
      // Keep the most recently used entries.
      const after = await window.api.dbGet('addressHistory').catch(() => []);
      const arr: any[] = Array.isArray(after) ? after : [];
      const CAP = 500;
      if (arr.length > CAP) {
        const sorted = [...arr].sort((a, b) => String(b?.lastUsedAt || '').localeCompare(String(a?.lastUsedAt || '')));
        const extras = sorted.slice(CAP);
        for (const ex of extras) {
          try { if (ex?.id != null) await window.api.dbDelete('addressHistory', ex.id); } catch {}
        }
      }
      refreshAddressHistory();
    } catch {
      // ignore
    }
  }, [addressHistory, refreshAddressHistory]);

  function triggerWarningBanner(message: string, details?: string) {
    if (warningHideTimer.current !== undefined) {
      window.clearTimeout(warningHideTimer.current);
      warningHideTimer.current = undefined;
    }
    if (warningRemoveTimer.current !== undefined) {
      window.clearTimeout(warningRemoveTimer.current);
      warningRemoveTimer.current = undefined;
    }
    setWarningBanner({ message, details });
    setWarningBannerVisible(true);
    warningHideTimer.current = window.setTimeout(() => {
      setWarningBannerVisible(false);
      warningRemoveTimer.current = window.setTimeout(() => {
        setWarningBanner(null);
        warningRemoveTimer.current = undefined;
      }, 400);
    }, 6000);
  }

  const missingRequired = useMemo<SaleRequiredKey[]>(() => {
    const missing: SaleRequiredKey[] = [];
    const assigned = (sale.assignedTo ?? '').toString().trim();
    if (!assigned) missing.push('assignedTo');
    const rows = Array.isArray(sale.items) ? sale.items : [];
    const legacyDesc = (sale as any).itemDescription;
    const hasItem = (rows.length > 0) || (typeof legacyDesc === 'string' && legacyDesc.trim().length > 0);
    if (!hasItem) missing.push('itemDetails');
    return missing;
  }, [sale]);

  const hasMeaningfulInput = useMemo(() => {
    const assigned = (sale.assignedTo ?? '').toString().trim();
    const rows = Array.isArray(sale.items) ? sale.items : [];
    const legacyDesc = (sale as any).itemDescription;
    return Boolean(
      assigned ||
      rows.length > 0 ||
      (typeof legacyDesc === 'string' && legacyDesc.trim().length > 0) ||
      (sale.notes && sale.notes.trim()) ||
      (Number(sale.discount) || 0) !== 0 ||
      (Number(sale.amountPaid) || 0) !== 0 ||
      sale.inStock ||
      (sale.orderedDate && sale.orderedDate.toString().trim()) ||
      (sale.estimatedDeliveryDate && sale.estimatedDeliveryDate.toString().trim()) ||
      (sale as any).quantity ||
      (sale as any).price
    );
  }, [sale]);

  useEffect(() => {
    if (validationActive && missingRequired.length === 0) {
      setValidationActive(false);
    }
  }, [validationActive, missingRequired]);

  // Load saved shop address from DB settings on mount
  useEffect(() => {
    (async () => {
      try {
        const settings = await window.api.dbGet('settings');
        const rec = (settings || []).find((s: any) => s.shopAddress);
        if (rec?.shopAddress) {
          setShopAddress(rec.shopAddress);
          setShopAddressInput(rec.shopAddress);
          setShopLat(rec.shopLat ?? null);
          setShopLng(rec.shopLng ?? null);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // Load address autocomplete history once
  useEffect(() => {
    refreshAddressHistory();
  }, [refreshAddressHistory]);

  useEffect(() => () => {
    if (warningHideTimer.current !== undefined) {
      window.clearTimeout(warningHideTimer.current);
      warningHideTimer.current = undefined;
    }
    if (warningRemoveTimer.current !== undefined) {
      window.clearTimeout(warningRemoveTimer.current);
      warningRemoveTimer.current = undefined;
    }
  }, []);

  useEffect(() => {
    if (missingRequired.length === 0) {
      if (warningHideTimer.current !== undefined) {
        window.clearTimeout(warningHideTimer.current);
        warningHideTimer.current = undefined;
      }
      if (warningRemoveTimer.current !== undefined) {
        window.clearTimeout(warningRemoveTimer.current);
        warningRemoveTimer.current = undefined;
      }
      setWarningBannerVisible(false);
      setWarningBanner(null);
      setArmedValidationActions({ save: false, checkout: false, close: false });
    }
  }, [missingRequired.length]);

  const sidebarValidationFlags = useMemo<Partial<Record<'assignedTo', boolean>> | undefined>(() => {
    if (!validationActive) return undefined;
    const set = new Set(missingRequired);
    return { assignedTo: set.has('assignedTo') };
  }, [validationActive, missingRequired]);

  const itemsSectionNeedsAttention = validationActive && missingRequired.includes('itemDetails');

  // If payload contains an id, load the existing sale from DB for editing
  useEffect(() => {
    (async () => {
      try {
        const pid = (payload as any)?.id;
        if (!pid) return;
        const list = await (window as any).api.dbGet('sales').catch(() => []);
        const found = (Array.isArray(list) ? list : []).find((s: any) => Number(s.id) === Number(pid));
        if (found) {
          initialConsultationRef.current = { ...found };
          // Auto-migrate legacy single-item fields to items for editing
          if ((!Array.isArray(found.items) || found.items.length === 0) && (found.itemDescription || found.quantity || found.price)) {
            const row: SaleItemRow = {
              id: crypto.randomUUID(),
              description: found.itemDescription || 'Item',
              qty: Number(found.quantity || 1) || 1,
              price: Number(found.price || 0) || 0,
              consultationHours: typeof found.consultationHours === 'number' ? found.consultationHours : undefined,
              internalCost: typeof found.internalCost === 'number' ? found.internalCost : undefined,
              condition: (found as any).condition || 'New',
              productUrl: (found as any).productUrl,
              category: (found as any).category,
            } as any;
            setSale({ ...found, items: [row] });
          } else {
            setSale(found);
          }
        }
      } catch (e) { console.warn('Failed to load sale by id from payload', e); }
    })();
  }, [payload]);

  const itemUnits = (row: Partial<SaleItemRow> | null | undefined) => {
    if (isConsultationItem(row)) {
      const hours = Number((row as any)?.consultationHours ?? row?.qty ?? 0);
      return Number.isFinite(hours) && hours > 0 ? hours : 0;
    }
    const qty = Number(row?.qty ?? 0);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
  };

  const itemTotal = (row: SaleItemRow) => discountedLineTotal({ units: itemUnits(row), unitPrice: Number(row.price) || 0, discountType: row.discountType, discountValue: row.discountValue });

  const isConsultationItem = (row: Partial<SaleItemRow> | null | undefined) => {
    const cat = (row as any)?.category;
    const s = (cat == null ? '' : String(cat)).trim().toLowerCase();
    return s === 'consultation' || s.startsWith('consult');
  };

  const total = useMemo(() => {
    const rows = sale.items || [];
    if (rows.length > 0) return rows.reduce((sum, r) => sum + itemTotal(r), 0);
    // Legacy single item fallback
    const q = Number((sale as any).quantity || 0);
    const p = Number((sale as any).price || 0);
    return (q > 0 && p > 0) ? (q * p) : 0;
  }, [sale.items, (sale as any).quantity, (sale as any).price]);

  const consultationTotal = useMemo(() => {
    const rows = Array.isArray(sale.items) ? sale.items : [];
    return rows.reduce((sum, r) => (isConsultationItem(r) ? sum + itemTotal(r) : sum), 0);
  }, [sale.items]);

  // Recompute partCosts and totals like the Work Order window, treating sales as parts-only
  useEffect(() => {
    const partCosts = Number(total || 0) || 0;
    const laborCost = 0;
    const taxRate = Number(sale.taxRate || 0) || 0;
    const amountPaid = Number(sale.amountPaid || 0) || 0;
    const discountType = (sale as any).discountType || '';
    const discountCustomAmount = Number((sale as any).discountCustomAmount || 0) || 0;
    const discountPctValue = Number((sale as any).discountPctValue || 0) || 0;
    // Percentage discounts auto-recompute when items change; custom_amt uses the stored amount.
    const discount = (() => {
      if (discountType === 'pct_5')  return round2(partCosts * 0.05);
      if (discountType === 'pct_10') return round2(partCosts * 0.10);
      if (discountType === 'pct_15') return round2(partCosts * 0.15);
      if (discountType === 'pct_20') return round2(partCosts * 0.20);
      if (discountType === 'pct_25') return round2(partCosts * 0.25);
      if (discountType === 'custom_pct') return round2(partCosts * discountPctValue / 100);
      if (discountType === 'custom_amt') return discountCustomAmount;
      return Number(sale.discount || 0) || 0; // legacy / no type set
    })();

    // Consultation items are NOT taxed.
    const discountedTotal = round2(Math.max(0, partCosts - discount));
    const taxableParts = Math.max(0, discountedTotal - (Number(consultationTotal || 0) || 0));
    const subTotal = round2(partCosts);
    const tax = round2(taxableParts * taxRate / 100);
    const totalWithTax = round2(discountedTotal + tax);
    const remaining = Math.max(0, round2(totalWithTax - amountPaid));
    const totals = { subTotal, tax, total: totalWithTax, remaining };

    setSale(s => {
      const currentTotals = s.totals || { subTotal: 0, tax: 0, total: 0, remaining: 0 };
      const totalsUnchanged =
        Number(currentTotals.subTotal || 0) === Number(totals.subTotal || 0) &&
        Number(currentTotals.tax || 0) === Number(totals.tax || 0) &&
        Number(currentTotals.total || 0) === Number(totals.total || 0) &&
        Number(currentTotals.remaining || 0) === Number(totals.remaining || 0);
      if (
        Number((s as any).partCosts || 0) === Number(partCosts || 0) &&
        Number((s as any).laborCost || 0) === Number(laborCost || 0) &&
        Number((s as any).discount || 0) === Number(discount || 0) &&
        totalsUnchanged
      ) {
        return s;
      }
      return { ...s, partCosts, laborCost, discount, totals };
    });
  }, [total, consultationTotal, sale.taxRate, sale.amountPaid, (sale as any).discountType, (sale as any).discountCustomAmount, (sale as any).discountPctValue, sale.discount]);

  // Per-item internal cost editing and pricing handled inside SaleItemsTable edit flow.

  function ensureRequired(action: ValidationActionKey, actionDescription: string): boolean {
    if (missingRequired.length === 0) {
      setValidationActive(false);
      setArmedValidationActions(prev => ({ ...prev, [action]: false }));
      return true;
    }

    setValidationActive(true);
    const detailText = missingRequired.map(key => SALE_REQUIRED_LABELS[key]).join(', ');

    if ((action === 'save' || action === 'checkout') && missingRequired.includes('assignedTo')) {
      setArmedValidationActions(prev => ({ ...prev, [action]: false }));
      triggerWarningBanner(
        `Assign a technician before ${actionDescription}`,
        'A sale cannot be saved or checked out until a technician is assigned.'
      );
      return false;
    }

    if (!armedValidationActions[action]) {
      setArmedValidationActions(prev => ({ ...prev, [action]: true }));
      triggerWarningBanner(
        `Review required fields before ${actionDescription}`,
        `${detailText}. Click again to continue.`
      );
      return false;
    }

    setArmedValidationActions(prev => ({ ...prev, [action]: false }));
    triggerWarningBanner(`Continuing with missing fields`, detailText);
    return true;
  }

  function validate(actionDescription: string): boolean {
    if (!ensureRequired(actionDescription.includes('checking out') ? 'checkout' : 'save', actionDescription)) return false;
    if ((sale as any).id) {
      setErrors([]);
      return true;
    }

    const errs: string[] = [];
    const rows = sale.items || [];
    if (rows.length === 0) {
      const desc = (sale as any).itemDescription;
      const qty = Number((sale as any).quantity || 0);
      const price = Number((sale as any).price || 0);
      if (!desc || !desc.toString().trim()) errs.push('Item description required');
      if (!(qty > 0)) errs.push('Qty must be >= 1');
      if (!(price >= 0)) errs.push('Price must be ≥ 0');
    } else {
      rows.forEach((r, idx) => {
        if (!r.description || !r.description.toString().trim()) errs.push(`Row ${idx + 1}: description required`);
        if (isConsultationItem(r)) {
          if (!(Number(r.consultationHours ?? r.qty) > 0)) errs.push(`Row ${idx + 1}: consultation hours must be greater than 0`);
          if (!(Number(r.price) > 0)) errs.push(`Row ${idx + 1}: consultation hourly rate must be greater than 0`);
        } else if (!(Number(r.qty) > 0)) errs.push(`Row ${idx + 1}: qty must be >= 1`);
        if (!(Number(r.price) >= 0)) errs.push(`Row ${idx + 1}: price must be ≥ 0`);
      });
    }

    setErrors(errs);
    if (errs.length > 0) {
      triggerWarningBanner(`Fix fields before ${actionDescription}`, errs.slice(0, 4).join(' · '));
      return false;
    }
    return true;
  }

  const canSave = useMemo(() => {
    if (!String(sale.assignedTo ?? '').trim()) return false;
    // Existing sale can always be saved to persist metadata like technician/dates
    if ((sale as any).id) return true;
    const rows = sale.items || [];
    if (rows.length === 0) {
      // Legacy single item fallback
      const desc = (sale as any).itemDescription;
      const qty = Number((sale as any).quantity || 0);
      const price = Number((sale as any).price || 0);
      return !!(desc && desc.toString().trim() && qty > 0 && price >= 0);
    }
    for (const r of rows) {
      if (!r.description || !r.description.toString().trim()) return false;
      if (isConsultationItem(r)) {
        if (!(Number(r.consultationHours ?? r.qty) > 0)) return false;
      } else if (!(Number(r.qty) > 0)) return false;
      if (!(Number(r.price) >= 0)) return false;
    }
    return true;
  }, [sale.items, sale.assignedTo, (sale as any).itemDescription, (sale as any).quantity, (sale as any).price, (sale as any).id]);

  function buildSaleRecordBase(): SaleRecord {
    const now = new Date().toISOString();
    const consultation = !!(sale as any).consultationType
      || String((sale as any).category || '').toLowerCase() === 'consultation';
    const record: SaleRecord = {
      ...sale,
      // legacy fields: mirror first row for compatibility
      itemDescription: sale.items && sale.items[0] ? sale.items[0].description : (sale as any).itemDescription,
      quantity: sale.items && sale.items[0] ? itemUnits(sale.items[0]) : (sale as any).quantity,
      price: sale.items && sale.items[0] ? sale.items[0].price : (sale as any).price,
      consultationHours: sale.items && sale.items[0] && isConsultationItem(sale.items[0])
        ? Number(sale.items[0].consultationHours ?? itemUnits(sale.items[0])) || undefined
        : (sale as any).consultationHours,
      // If inStock, null out order/delivery fields to avoid confusion
      orderedDate: consultation || sale.inStock ? null : sale.orderedDate || null,
      estimatedDeliveryDate: consultation || sale.inStock ? null : sale.estimatedDeliveryDate || null,
      partsOrderUrl: consultation || sale.inStock ? '' : (sale.partsOrderUrl || ''),
      partsTrackingUrl: consultation || sale.inStock ? '' : (sale.partsTrackingUrl || ''),
      createdAt: (sale as any).id ? (sale.createdAt || now) : now,
      updatedAt: now,
      total: total,
      items: sale.items as any,
    } as SaleRecord;
    // Preserve original checkInAt for updates
    if ((sale as any).id) {
      (record as any).checkInAt = sale.checkInAt || record.checkInAt || null;
    }
    return record;
  }

  async function closeThisWindow(opts?: { focusMain?: boolean }) {
    const api = (window as any).api;
    try {
      if (api?.closeSelfWindow) {
        const res = await api.closeSelfWindow({ focusMain: opts?.focusMain ?? true });
        if (res?.ok) return;
        if (res?.blocked) {
          // If this view is ever rendered in the main window, don't close the whole app.
          try {
            const u = new URL(window.location.href);
            u.search = '';
            window.location.href = u.toString();
            return;
          } catch {}
        }
      }
    } catch {}
    try { window.close(); } catch {}
  }

  async function handleSave() {
    if (!validate('saving this sale')) return;
    const record = buildSaleRecordBase();
    try {
      let saved;
      if ((sale as any).id) {
        saved = await window.api.dbUpdate('sales', (sale as any).id, { ...record, id: (sale as any).id });
      } else {
        saved = await window.api.dbAdd('sales', record);
      }
      if (saved) {
        setSale(saved);
        setSavedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }));
        // Reflect in Calendar: add parts/events based on dates present
        try { await reflectSaleInCalendar(saved); } catch (e) { console.warn('calendar sync failed', e); }
        // Nudge any opener window (e.g., Customer Overview) to reload sales in fallback scenarios
        try { window.opener?.postMessage({ type: 'sales:changed', customerId: saved.customerId }, '*'); } catch {}

        const isConsultation = Boolean((saved as any).consultationType) || String((saved as any).category || '').toLowerCase() === 'consultation';
        if (isConsultation && initialConsultationRef.current) {
          try {
            const before = consultationEmailDetails(initialConsultationRef.current);
            const after = consultationEmailDetails(saved);
            if (consultationDigest(before) !== consultationDigest(after)) {
              const eventId = await findConsultationEventId(Number(saved.id || 0));
              const events = eventId ? await (window as any).api.dbGet('calendarEvents').catch(() => []) : [];
              const event = Array.isArray(events) ? events.find((entry: any) => Number(entry?.id) === Number(eventId)) : null;
              const customers = saved.customerId ? await (window as any).api.findCustomers?.({ id: saved.customerId }) : [];
              await queueConsultationEmail({ kind: 'consultation-updated', record: { ...saved, ...(event || {}), id: eventId }, previous: initialConsultationRef.current, customer: Array.isArray(customers) ? customers[0] : null });
              initialConsultationRef.current = { ...saved };
            }
          } catch (emailError) { console.warn('Automatic consultation update email was not queued.', emailError); }
        }

        // After saving, return the user to the main/customer screen.
        await closeThisWindow({ focusMain: true });
      }
    } catch (e) {
      console.error('Save failed', e);
      triggerWarningBanner('Failed to save sale', 'See console for details.');
    }
  }

  function onlyDate(iso?: string | null) { return (iso || '').toString().slice(0, 10); }
  function onlyTime(iso?: string | null) {
    const v = (iso || '').toString();
    if (!v.includes('T')) return '';
    return v.split('T')[1].slice(0, 5); // HH:mm
  }

  async function reflectSaleInCalendar(saved: SaleRecord) {
    const all: any[] = await (window as any).api.dbGet('calendarEvents').catch(() => []);
    const firstDesc = saved.items && saved.items[0] ? saved.items[0].description : saved.itemDescription;
    const safeItem = (firstDesc || 'Product').toString().trim();
    const base = {
      category: 'parts',
      partName: safeItem,
      title: safeItem,
      customerName: saved.customerName,
      customerPhone: saved.customerPhone,
      technician: saved.assignedTo || undefined,
      source: 'sale',
      saleId: saved.id,
      orderUrl: (saved as any).partsOrderUrl || undefined,
      trackingUrl: (saved as any).partsTrackingUrl || undefined,
    } as any;

    async function syncOne(status: 'ordered' | 'delivery', desiredDate: string | null) {
      const existing = all.filter(e => e.category === 'parts' && e.source === 'sale' && e.saleId === saved.id && e.partsStatus === status);
      if (!desiredDate) {
        for (const e of existing) {
          if (e?.id != null) await (window as any).api.dbDelete('calendarEvents', e.id).catch(() => {});
        }
        return;
      }
      const sameDate = existing.find(e => e.date === desiredDate);
      for (const e of existing) {
        if (sameDate && e === sameDate) continue;
        if (e?.id != null) await (window as any).api.dbDelete('calendarEvents', e.id).catch(() => {});
      }
      if (sameDate?.id != null) {
        await (window as any).api.dbUpdate('calendarEvents', sameDate.id, { ...sameDate, ...base, date: desiredDate, partsStatus: status }).catch(() => {});
      } else {
        await (window as any).api.dbAdd('calendarEvents', { ...base, date: desiredDate, partsStatus: status }).catch(() => {});
      }
    }

    // Ordered (O)
    const od = saved.inStock ? null : onlyDate(saved.orderedDate || undefined);
    // Estimated Delivery (D)
    const dd = saved.inStock ? null : onlyDate(saved.estimatedDeliveryDate || undefined);
    await syncOne('ordered', od ? od : null);
    await syncOne('delivery', dd ? dd : null);
    // Client pickup as regular event with time if provided
    const cpDate = onlyDate((saved as any).clientPickupDate);
    const cpTime = onlyTime((saved as any).clientPickupDate);
    if (cpDate) {
      const title = `Pickup: ${safeItem}`;
      const exists = all.some(e => e.category === 'event' && e.title === title && e.date === cpDate && (e.time || '') === (cpTime || ''));
      if (!exists) {
        await (window as any).api.dbAdd('calendarEvents', { category: 'event', date: cpDate, time: cpTime || undefined, title, customerName: saved.customerName, customerPhone: saved.customerPhone });
      }
    }
  }

  const sharedWorkOrder = useMemo<WorkOrderFull>(() => {
    const rows = (sale.items || []) as SaleItemRow[];
    // IMPORTANT: Never generate random IDs during render. Unstable IDs will cause the items table
    // to re-mount rows on every keystroke, which feels like input lag.
    const items = (rows.length ? rows : [{ id: 'sale-item', description: sale.itemDescription || 'Retail item', qty: sale.quantity || 1, price: sale.price || 0 } as any]).map((r: any, idx: number) => ({
      id: String(r.id || `sale-row-${idx}`),
      description: r.description,
      qty: itemUnits(r) || 1,
      unitPrice: r.price,
      parts: itemTotal(r),
      labor: 0,
      status: 'pending',
    }));
    return {
      id: (sale as any).id || 0,
      customerId: sale.customerId || 0,
      status: (sale.status as any) || 'open',
      assignedTo: sale.assignedTo || null,
      checkInAt: sale.checkInAt || null,
      repairCompletionDate: sale.repairCompletionDate || null,
      checkoutDate: sale.checkoutDate || null,
      productCategory: 'Retail',
      productDescription: (sale.items && sale.items[0]?.description) || sale.itemDescription || '',
      problemInfo: '',
      password: '',
      model: '',
      serial: '',
      intakeSource: (sale as any).intakeSource || '',
      discount: sale.discount || 0,
      discountType: (sale as any).discountType || undefined,
      discountPctValue: (sale as any).discountPctValue || undefined,
      discountCustomAmount: (sale as any).discountCustomAmount || 0,
      amountPaid: sale.amountPaid || 0,
      taxRate: sale.taxRate || 0,
      laborCost: sale.laborCost || 0,
      partCosts: items.reduce((s, r) => s + (r.parts || 0), 0),
      totals: sale.totals as any,
      items: items,
      clientPickupDate: (sale as any).clientPickupDate || null,
    } as unknown as WorkOrderFull;
  }, [
    sale.items,
    sale.itemDescription,
    sale.quantity,
    sale.price,
    (sale as any).id,
    sale.customerId,
    sale.status,
    sale.assignedTo,
    sale.checkInAt,
    sale.repairCompletionDate,
    sale.checkoutDate,
    (sale as any).intakeSource,
    sale.discount,
    (sale as any).discountType,
    (sale as any).discountPctValue,
    (sale as any).discountCustomAmount,
    sale.amountPaid,
    sale.taxRate,
    sale.laborCost,
    sale.totals,
    (sale as any).clientPickupDate,
  ]);

  const intakeCustomerSummary = useMemo(() => ({ name: sale.customerName, phone: sale.customerPhone }), [sale.customerName, sale.customerPhone]);
  const isConsultation = !!(sale as any).consultationType || String((sale as any).category || '').toLowerCase() === 'consultation';

  const openClientUpdate = useCallback(async () => {
    const saleId = Number((sale as any).id || 0) || 0;
    if (!saleId) return;
    if (!isConsultation) {
      setClientUpdateTarget({ recordType: 'sale', recordId: saleId });
      return;
    }
    const eventId = await findConsultationEventId(saleId);
    if (!eventId) {
      alert('This consultation is still syncing to the calendar. Save it, then try Update Client again.');
      return;
    }
    setClientUpdateTarget({ recordType: 'consult', recordId: eventId });
  }, [isConsultation, (sale as any).id]);

  const handleSidebarChange = useCallback((patch: Partial<WorkOrderFull>) => {
    const { items: _ignore, ...rest } = (patch as any) || {};
    setSale(s => ({ ...s, ...rest }));
  }, []);

  const handleSaleItemsChange = useCallback((items: SaleItemRow[]) => {
    setSale(s => ({ ...s, items }));
  }, []);

  // Save shop address to DB and geocode it for future distance checks
  async function saveShopAddressToDB() {
    const addr = shopAddressInput.trim();
    if (!addr) return;
    const coords = await geocodeAddress(addr);
    const record = { shopAddress: addr, shopLat: coords?.lat ?? null, shopLng: coords?.lng ?? null };
    try {
      const existing = await window.api.dbGet('settings');
      const rec = (existing || []).find((s: any) => s.shopAddress != null);
      if (rec) {
        await window.api.dbUpdate('settings', rec.id, record);
      } else {
        await window.api.dbAdd('settings', record);
      }
    } catch { /* ignore */ }
    setShopAddress(addr);
    setShopLat(coords?.lat ?? null);
    setShopLng(coords?.lng ?? null);
  }

  // Geocode client address, compute distance, auto-apply $20 surcharge if >15 miles
  async function checkClientDistance(address: string) {
    if (!address.trim()) return;
    setDistanceLoading(true);
    try {
      let sLat = shopLat;
      let sLng = shopLng;
      // Geocode shop address on-the-fly if coords not loaded yet
      if ((sLat == null || sLng == null) && shopAddress) {
        const sc = await geocodeAddress(shopAddress);
        if (sc) { sLat = sc.lat; sLng = sc.lng; setShopLat(sc.lat); setShopLng(sc.lng); }
      }
      if (sLat == null || sLng == null) {
        setDistanceLoading(false);
        return;
      }
      const clientCoords = await geocodeAddress(address, { lat: sLat, lng: sLng });
      if (!clientCoords) { setDistanceMiles(null); setDistanceFeeApplied(false); setDistanceLoading(false); return; }
      const dist = haversineDistanceMiles(sLat, sLng, clientCoords.lat, clientCoords.lng);
      setDistanceMiles(dist);
      setDistanceFeeApplied(dist > CONSULTATION_DISTANCE_THRESHOLD);
    } catch { setDistanceMiles(null); }
    setDistanceLoading(false);
  }



  const handleIntakeChange = useCallback((patch: Partial<WorkOrderFull>) => {
    const { items: _ignore, ...rest } = (patch as any) || {};
    setSale(s => ({ ...s, ...rest }));
  }, []);

  const handlePaymentChange = useCallback((patch: Partial<WorkOrderFull>) => {
    const { items: _ignore, ...rest } = (patch as any) || {};
    setSale(s => ({ ...s, ...rest }));
  }, []);

  const renderSidebarActions = useCallback(() => (
    <>
      {/* Print Sales Form — tech copy with QR code */}
      {!((sale as any).consultationType || String((sale as any).category || '').toLowerCase() === 'consultation') && (
        <button
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 mb-1"
          onClick={async () => {
            try {
              const rows = (sale.items || []) as SaleItemRow[];
              const saleItems = (rows.length
                ? rows
                : [{ description: sale.itemDescription || 'Sale', qty: (sale as any).quantity || 1, price: sale.price || 0 }]
              ).map(r => ({
                description: r.description || '',
                qty: itemUnits(r) || 1,
                price: Number(r.price) || 0,
                discountType: (r as SaleItemRow).discountType,
                discountValue: (r as SaleItemRow).discountValue,
              }));
              let customerPhoneAlt = '';
              let customerEmail = String((sale as any).customerEmail || '').trim();
              try {
                const cid = sale.customerId;
                if (cid && (window as any).api?.findCustomers) {
                  const list = await (window as any).api.findCustomers({ id: cid });
                  const c = Array.isArray(list) && list.length ? list[0] : null;
                  if (c) { customerPhoneAlt = c.phoneAlt || ''; if (!customerEmail) customerEmail = c.email || ''; }
                }
              } catch {}
              const payload: SaleOrderPrint = {
                invoiceId: String((sale as any).invoiceId || (sale as any).id || ''),
                id: Number((sale as any).id) || 0,
                dateTimeISO: sale.checkInAt || new Date().toISOString(),
                clientName: sale.customerName || '',
                phone: sale.customerPhone || '',
                phoneAlt: customerPhoneAlt,
                email: customerEmail,
                items: saleItems,
                subTotal: sale.totals?.subTotal ?? 0,
                discount: sale.discount || 0,
                taxRate: sale.taxRate || 0,
                taxes: sale.totals?.tax ?? 0,
                amountPaid: sale.amountPaid || 0,
                notes: (sale as any).notes || '',
              };
              await printSaleReleaseForm(payload);
            } catch (e) { console.error('Print Sales Form failed', e); }
          }}
        >
          Print Sales Form
        </button>
      )}
      <button
        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-zinc-200"
        onClick={async () => {
          const isConsult = !!(sale as any).consultationType || String((sale as any).category || '').toLowerCase() === 'consultation';
          if (isConsult && (window as any).api?.openConsultSheet) {
            let customerPhoneAlt = '';
            let customerEmail = String((sale as any).customerEmail || '').trim();
            try {
              const cid = sale.customerId;
              if (cid && (window as any).api?.findCustomers) {
                const list = await (window as any).api.findCustomers({ id: cid });
                const c = Array.isArray(list) && list.length ? list[0] : null;
                if (c) {
                  customerPhoneAlt = c.phoneAlt || '';
                  if (!customerEmail) customerEmail = c.email || '';
                }
              }
            } catch {}

            const items = Array.isArray(sale.items) ? (sale.items as any[]) : [];
            const consultItem = items.find((r) => {
              const cat = String(r?.category || '').toLowerCase();
              const desc = String(r?.description || '').toLowerCase();
              if (!cat.startsWith('consult')) return false;
              if (desc.includes('driver') || desc.includes('on-site') || desc.includes('on site')) return false;
              return true;
            }) || items.find((r) => String(r?.category || '').toLowerCase().startsWith('consult')) || null;

            const driverItem = items.find((r) => {
              const cat = String(r?.category || '').toLowerCase();
              const desc = String(r?.description || '').toLowerCase();
              return cat.startsWith('consult') && (desc.includes('driver') || desc.includes('on-site') || desc.includes('on site'));
            }) || null;

            const reasonForVisit = String(
              (consultItem as any)?.description
              || (sale as any).itemDescription
              || 'Consultation'
            ).trim();

            const appointmentDate = String((sale as any).appointmentDate || '').trim();
            const appointmentTime = String((sale as any).appointmentTime || '').trim();
            const consultationDateLabel = appointmentDate
              ? (() => {
                const d = new Date(`${appointmentDate}T00:00:00`);
                return Number.isNaN(d.getTime()) ? appointmentDate : d.toLocaleDateString();
              })()
              : (sale.checkInAt ? new Date(String(sale.checkInAt)).toLocaleDateString() : new Date().toLocaleDateString());
            const consultationTimeLabel = appointmentTime || '';

            const address = (sale as any).consultationType === 'athome'
              ? String((sale as any).consultationAddress || '').trim()
              : 'In-Store';

            const firstHourRate = Number((consultItem as any)?.price ?? CONSULTATION_BASE_RATE) || CONSULTATION_BASE_RATE;
            const driverFee = Number((sale as any).driverFee ?? (driverItem as any)?.price ?? 0) || 0;
            const firstHourTotal = round2(firstHourRate + driverFee);
            const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
            const eventId = await findConsultationEventId((sale as any).id);

            const payload = {
              id: (sale as any).id,
              eventId,
              customerId: sale.customerId,
              customerName: sale.customerName,
              customerPhone: sale.customerPhone,
              customerPhoneAlt,
              customerEmail,
              consultationDateLabel,
              consultationTimeLabel,
              reasonForVisit,
              address,
              firstHourRateLabel: money(firstHourRate),
              driverFeeLabel: money(driverFee),
              firstHourTotalLabel: money(firstHourTotal),
            };

            await (window as any).api.openConsultSheet({
              data: payload,
              autoPrint: true,
              silent: true,
              autoCloseMs: 900,
              show: false,
            });
            return;
          }

          const rows = (sale.items || []) as SaleItemRow[];
          const receiptItems = (rows.length ? rows : [{ description: sale.itemDescription, qty: sale.quantity || 1, price: sale.price || 0 } as any]).map(r => ({
            id: r.id,
            description: r.description,
            qty: itemUnits(r) || 1,
            price: Number(r.price) || 0,
          }));
          const partCosts = Number(sale.partCosts ?? 0) || 0;
          const laborCost = Number(sale.laborCost ?? 0) || 0;
          const consultationMeta = (sale as any).consultationType ? {
            consultationType: (sale as any).consultationType,
            consultationAddress: (sale as any).consultationAddress,
            appointmentDate: (sale as any).appointmentDate,
            appointmentTime: (sale as any).appointmentTime,
            appointmentEndTime: (sale as any).appointmentEndTime,
            consultationHours: (sale as any).consultationHours,
            driverFee: (sale as any).driverFee,
          } : {};
          let customerPhoneAlt = '';
          try {
            const cid = sale.customerId;
            if (cid && (window as any).api?.findCustomers) {
              const list = await (window as any).api.findCustomers({ id: cid });
              const c = Array.isArray(list) && list.length ? list[0] : null;
              if (c) customerPhoneAlt = c.phoneAlt || '';
            }
          } catch {}
          const payload = {
            receiptType: 'sale',
            id: (sale as any).id,
            customerId: sale.customerId,
            customerName: sale.customerName,
            customerPhone: sale.customerPhone,
            customerPhoneAlt,
            customerEmail: (sale as any).customerEmail || '',
            paymentType: (sale as any).paymentType,
            payments: (sale as any).payments || [],
            productCategory: 'Retail',
            productDescription: (rows[0]?.description) || sale.itemDescription || 'Sale',
            items: receiptItems,
            partCosts,
            laborCost,
            discount: sale.discount || 0,
            taxRate: sale.taxRate || 0,
            totals: sale.totals,
            amountPaid: sale.amountPaid || 0,
            ...consultationMeta,
          };
          await (window as any).api.openCustomerReceipt({
            data: payload,
            autoPrint: true,
            silent: true,
            autoCloseMs: 900,
            show: false,
          });
        }}
      >
        {((sale as any).consultationType || String((sale as any).category || '').toLowerCase() === 'consultation') ? 'Print Consult Sheet' : 'Print Customer Receipt'}
      </button>
    </>
  ), [sale]);

  useEffect(() => {
    handleCheckoutRef.current = async () => {
      if (!validate('checking out this sale')) return;
      try {
        const amountDue = (sale.totals?.remaining || 0);
        const result = await (window as any).api.openCheckout({ amountDue });
        if (!result) return;
        const checkoutLines = Array.isArray(result.payments) ? result.payments : [];
        const normalizedLines = checkoutLines.length
          ? checkoutLines
          : [
              {
                paymentType: result.paymentType,
                applied: Number(result.amountPaid || 0) || 0,
                amount: (() => {
                  const pt = String(result.paymentType || '');
                  const isCash = pt.toLowerCase().includes('cash');
                  const tendered = Number(result.tendered ?? result.amountPaid);
                  return isCash ? (Number.isFinite(tendered) ? tendered : Number(result.amountPaid || 0) || 0) : (Number(result.amountPaid || 0) || 0);
                })(),
                tendered: result.tendered,
                change: result.changeDue,
              },
            ];

        const additionalPaid = round2(normalizedLines.reduce((sum: number, p: any) => sum + (Number(p?.applied) || 0), 0));
        let newAmountPaid = (sale.amountPaid || 0) + additionalPaid;
        if (!Number.isFinite(newAmountPaid) || newAmountPaid < 0) newAmountPaid = sale.amountPaid || 0;

        const prevPayments = buildNormalizedCheckoutPayments(sale as any);
        const payments = (() => {
          if (!(additionalPaid > 0)) return prevPayments;
          const now = new Date().toISOString();
          const newEntries = normalizedLines
            .map((p: any) => {
              const pt = String(p?.paymentType || '');
              const isCash = pt.toLowerCase().includes('cash');
              const applied = round2(Number(p?.applied || 0) || 0);
              if (!(applied > 0)) return null;

              const tendered = Number(p?.tendered ?? p?.amount ?? applied);
              const change = Number(p?.change ?? 0);
              const amount = isCash
                ? (Number.isFinite(tendered) ? tendered : applied)
                : applied;

              const entry: any = {
                amount,
                applied,
                paymentType: pt,
                at: now,
              };
              if (isCash) entry.change = Number.isFinite(change) ? Math.max(0, change) : 0;
              return entry;
            })
            .filter(Boolean);
          return [...prevPayments, ...(newEntries as any[])];
        })();
        let status = sale.status;
        let checkoutDate = sale.checkoutDate as string | null;
        const hadOutstandingBalance = Number(sale.totals?.remaining || 0) > 0.009;
        if ((sale.totals?.remaining || 0) - additionalPaid <= 0 || result.markClosed) {
          status = 'closed';
          if (!checkoutDate || (additionalPaid > 0 && hadOutstandingBalance)) {
            checkoutDate = new Date().toISOString();
          }
        }

        const partCosts = Number(total || 0) || 0;
        const taxRate = Number(sale.taxRate || 0) || 0;
        const discount = Number(sale.discount || 0) || 0;
        const discountedTotal = round2(Math.max(0, partCosts - discount));
        const taxableParts = Math.max(0, discountedTotal - (Number(consultationTotal || 0) || 0));
        const subTotal = round2(partCosts);
        const tax = round2(taxableParts * taxRate / 100);
        const totalWithTax = round2(discountedTotal + tax);
        const remaining = Math.max(0, round2(totalWithTax - (Number(newAmountPaid || 0) || 0)));
        const updatedTotals = { subTotal, tax, total: totalWithTax, remaining };

        const recordBase = buildSaleRecordBase();
        const recordToPersist: SaleRecord = {
          ...recordBase,
          amountPaid: newAmountPaid,
          paymentType: result.paymentType,
          payments,
          status: status as any,
          checkoutDate,
          partCosts,
          laborCost: 0,
          totals: updatedTotals,
          total: updatedTotals.total,
        } as any;

        let saved: any = null;
        let currentId = (sale as any).id as number | undefined;
        if (currentId) {
          saved = await (window as any).api.dbUpdate('sales', currentId, { ...recordToPersist, id: currentId });
        } else {
          saved = await (window as any).api.dbAdd('sales', recordToPersist);
          currentId = saved?.id;
        }
        if (saved) {
          setSale(saved);
          try { await reflectSaleInCalendar(saved); } catch (e) { console.warn('calendar sync failed', e); }
        } else {
          setSale(s => ({ ...s, id: currentId, ...recordToPersist }));
        }
        const initialSaleCheckoutForm = !!currentId && additionalPaid > 0 && prevPayments.length === 0 && !((sale as any).consultationType || String((sale as any).category || '').toLowerCase() === 'consultation');
        if (initialSaleCheckoutForm) {
          try {
            const formItems = (Array.isArray(recordToPersist.items) ? recordToPersist.items : []).map((row: any) => ({ description: row.description || 'Sale item', qty: itemUnits(row) || 1, price: Number(row.price) || 0, discountType: row.discountType, discountValue: row.discountValue }));
            await printSaleReleaseForm({
              invoiceId: String((saved as any)?.invoiceId || currentId),
              id: Number(currentId),
              dateTimeISO: recordToPersist.checkInAt || new Date().toISOString(),
              clientName: recordToPersist.customerName || '',
              phone: recordToPersist.customerPhone || '',
              email: String((recordToPersist as any).customerEmail || ''),
              items: formItems,
              subTotal: Number(updatedTotals.subTotal || 0),
              discount: Number(recordToPersist.discount || 0),
              taxRate: Number(recordToPersist.taxRate || 0),
              taxes: Number(updatedTotals.tax || 0),
              amountPaid: Number(newAmountPaid || 0),
              notes: String((recordToPersist as any).notes || ''),
            });
          } catch (formError) { console.warn('Initial sale form could not be printed.', formError); }
        }
        if (saved && currentId && additionalPaid > 0) {
          try {
            const customerRows = recordToPersist.customerId && (window as any).api?.findCustomers
              ? await (window as any).api.findCustomers({ id: recordToPersist.customerId }) : [];
            const customer = Array.isArray(customerRows) ? customerRows[0] : null;
            const savedRecord = { ...recordToPersist, ...saved, id: currentId, completed: String(status).toLowerCase() === 'closed', requiresOrder: recordToPersist.inStock === false };
            await queueInitialPaymentAcknowledgment({ recordType: 'sale', record: savedRecord, payment: { applied: additionalPaid }, customer });
          } catch (emailError) { console.warn('Automatic sale email was not queued.', emailError); }
        }
        if (currentId && additionalPaid > 0) {
          try {
            const inventoryResult = await consumeInStockInventory(
              (window as any).api,
              'sale',
              Number(currentId),
              Array.isArray(recordToPersist.items) ? recordToPersist.items : [],
              { allowShortfall: true },
            );
            if (inventoryResult.shortfalls.length) {
              alert('Checkout was saved, but one or more tracked products reached zero inventory. Review Inventory for restocking.');
            }
          } catch (inventoryError) {
            console.error('Sale inventory update failed; reconciliation will retry it.', inventoryError);
          }
        }
        try { window.opener?.postMessage({ type: 'sales:changed', customerId: recordToPersist.customerId }, '*'); } catch {}

        if (result.printReceipt) {
          try {
            const isConsult = !!(sale as any).consultationType || String((sale as any).category || '').toLowerCase() === 'consultation';
            if (isConsult && (window as any).api?.openConsultSheet) {
              let customerPhoneAlt = '';
              let customerEmail = String((recordToPersist as any).customerEmail || (sale as any).customerEmail || '').trim();
              try {
                const cid = recordToPersist.customerId;
                if (cid && (window as any).api?.findCustomers) {
                  const list = await (window as any).api.findCustomers({ id: cid });
                  const c = Array.isArray(list) && list.length ? list[0] : null;
                  if (c) {
                    customerPhoneAlt = c.phoneAlt || '';
                    if (!customerEmail) customerEmail = c.email || '';
                  }
                }
              } catch {}

              const items = Array.isArray(recordToPersist.items) ? (recordToPersist.items as any[]) : [];
              const consultItem = items.find((r) => {
                const cat = String(r?.category || '').toLowerCase();
                const desc = String(r?.description || '').toLowerCase();
                if (!cat.startsWith('consult')) return false;
                if (desc.includes('driver') || desc.includes('on-site') || desc.includes('on site')) return false;
                return true;
              }) || items.find((r) => String(r?.category || '').toLowerCase().startsWith('consult')) || null;

              const driverItem = items.find((r) => {
                const cat = String(r?.category || '').toLowerCase();
                const desc = String(r?.description || '').toLowerCase();
                return cat.startsWith('consult') && (desc.includes('driver') || desc.includes('on-site') || desc.includes('on site'));
              }) || null;

              const reasonForVisit = String(
                (consultItem as any)?.description
                || (recordToPersist as any).itemDescription
                || 'Consultation'
              ).trim();

              const appointmentDate = String((recordToPersist as any).appointmentDate || (sale as any).appointmentDate || '').trim();
              const appointmentTime = String((recordToPersist as any).appointmentTime || (sale as any).appointmentTime || '').trim();
              const consultationDateLabel = appointmentDate
                ? (() => {
                  const d = new Date(`${appointmentDate}T00:00:00`);
                  return Number.isNaN(d.getTime()) ? appointmentDate : d.toLocaleDateString();
                })()
                : (recordToPersist.checkInAt ? new Date(String(recordToPersist.checkInAt)).toLocaleDateString() : new Date().toLocaleDateString());
              const consultationTimeLabel = appointmentTime || '';

              const consultationType = String((recordToPersist as any).consultationType || (sale as any).consultationType || '').trim();
              const address = consultationType === 'athome'
                ? String((recordToPersist as any).consultationAddress || (sale as any).consultationAddress || '').trim()
                : 'In-Store';

              const firstHourRate = Number((consultItem as any)?.price ?? CONSULTATION_BASE_RATE) || CONSULTATION_BASE_RATE;
              const driverFee = Number((recordToPersist as any).driverFee ?? (driverItem as any)?.price ?? (sale as any).driverFee ?? 0) || 0;
              const firstHourTotal = round2(firstHourRate + driverFee);
              const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
              const eventId = await findConsultationEventId(currentId || (sale as any).id);

              const payload = {
                id: currentId || (sale as any).id,
                eventId,
                customerId: recordToPersist.customerId,
                customerName: recordToPersist.customerName,
                customerPhone: recordToPersist.customerPhone,
                customerPhoneAlt,
                customerEmail,
                consultationDateLabel,
                consultationTimeLabel,
                reasonForVisit,
                address,
                firstHourRateLabel: money(firstHourRate),
                driverFeeLabel: money(driverFee),
                firstHourTotalLabel: money(firstHourTotal),
              };

              await (window as any).api.openConsultSheet({
                data: payload,
                autoPrint: true,
                silent: true,
                autoCloseMs: 900,
                show: false,
              });
              return;
            }

            const rows = (sale.items || []) as SaleItemRow[];
            const receiptItems = (rows.length ? rows : [{ description: sale.itemDescription, qty: sale.quantity || 1, price: sale.price || 0 } as any]).map(r => ({
              id: r.id,
              description: r.description,
              qty: itemUnits(r) || 1,
              price: Number(r.price) || 0,
            }));

            const consultationMetaCheckout = (sale as any).consultationType ? {
              consultationType: (sale as any).consultationType,
              consultationAddress: (sale as any).consultationAddress,
              appointmentDate: (sale as any).appointmentDate,
              appointmentTime: (sale as any).appointmentTime,
              appointmentEndTime: (sale as any).appointmentEndTime,
              consultationHours: (sale as any).consultationHours,
              driverFee: (sale as any).driverFee,
            } : {};
            let checkoutCustomerPhoneAlt = '';
            try {
              const cid = recordToPersist.customerId;
              if (cid && (window as any).api?.findCustomers) {
                const list = await (window as any).api.findCustomers({ id: cid });
                const c = Array.isArray(list) && list.length ? list[0] : null;
                if (c) checkoutCustomerPhoneAlt = c.phoneAlt || '';
              }
            } catch {}
            const payload = {
              receiptType: 'sale',
              id: currentId || (sale as any).id,
              customerId: recordToPersist.customerId,
              customerName: recordToPersist.customerName,
              customerPhone: recordToPersist.customerPhone,
              customerPhoneAlt: checkoutCustomerPhoneAlt,
              customerEmail: (recordToPersist as any).customerEmail || '',
              paymentType: (recordToPersist as any).paymentType,
              payments: (recordToPersist as any).payments || [],
              productCategory: 'Retail',
              productDescription: (recordToPersist.items && (recordToPersist.items as any)[0]?.description) || recordToPersist.itemDescription || 'Sale',
              items: receiptItems,
              partCosts: total,
              laborCost: 0,
              discount: recordToPersist.discount || 0,
              taxRate: recordToPersist.taxRate || 0,
              totals: updatedTotals,
              amountPaid: newAmountPaid,
              ...consultationMetaCheckout,
            };
            if ((window as any).api?.openCustomerReceipt) {
              await (window as any).api.openCustomerReceipt({
                data: payload,
                autoPrint: true,
                silent: true,
                autoCloseMs: 900,
                show: false,
              });
            }
          } catch (e) { console.error('openCustomerReceipt failed', e); }
        }
        if (result.closeParent) {
          const delayMs = 0;
          setTimeout(() => { void closeThisWindow({ focusMain: true }); }, delayMs);
        }
      } catch (e) {
        console.error('Checkout failed', e);
        alert('Checkout failed. See console.');
      }
    };
  });

  const handleCheckout = useCallback(() => {
    void handleCheckoutRef.current();
  }, []);

  function onCancel() {
    if (!(sale as any).id && !hasMeaningfulInput) {
      void closeThisWindow({ focusMain: true });
      return;
    }
    if (!ensureRequired('close', 'closing this sale window')) return;
    void closeThisWindow({ focusMain: true });
  }

  // Listen for product selection from Products picker via window message or IPC
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e?.data;
      if (!data || data.type !== 'sale-product-selected') return;
      const picked = data.product || {};
      const row: SaleItemRow = {
        id: crypto.randomUUID(),
        inventoryProductId: picked.inventoryProductId,
        description: picked.itemDescription || picked.title || picked.name || 'Item',
        qty: Number(picked.quantity ?? 1) || 1,
        price: Number(picked.price ?? 0) || (String(picked.category || '').toLowerCase().startsWith('consult') ? CONSULTATION_BASE_RATE : 0),
        consultationHours: typeof picked.consultationHours === 'number' ? picked.consultationHours : undefined,
        internalCost: typeof picked.internalCost === 'number' ? picked.internalCost : undefined,
        condition: picked.condition || 'New',
        productUrl: picked.productUrl || picked.url || picked.link || '',
        category: picked.category,
        itemType: picked.itemType,
        distributor: picked.distributor,
        distributorSku: picked.distributorSku,
        vendorRelationship: picked.vendorRelationship,
        vendorSharePct: picked.vendorSharePct,
        trackStock: picked.trackStock,
        stockCountAtSelection: picked.stockCount,
      };
      setSale(s => ({ ...s, items: ([...(s.items || []), row]) }));
    }
    window.addEventListener('message', onMessage);
    // IPC pathway, if available
    try {
      const { ipcRenderer } = (window as any).require ? (window as any).require('electron') : { ipcRenderer: null };
      if (ipcRenderer) {
        ipcRenderer.on('sale-product-selected', (_event: any, product: any) => {
          const picked = product || {};
          const row: SaleItemRow = {
            id: crypto.randomUUID(),
            inventoryProductId: picked.inventoryProductId,
            description: picked.itemDescription || picked.title || picked.name || 'Item',
            qty: Number(picked.quantity ?? 1) || 1,
            price: Number(picked.price ?? 0) || (String(picked.category || '').toLowerCase().startsWith('consult') ? CONSULTATION_BASE_RATE : 0),
            consultationHours: typeof picked.consultationHours === 'number' ? picked.consultationHours : undefined,
            internalCost: typeof picked.internalCost === 'number' ? picked.internalCost : undefined,
            condition: picked.condition || 'New',
            productUrl: picked.productUrl || picked.url || picked.link || '',
            category: picked.category,
            itemType: picked.itemType,
            distributor: picked.distributor,
            distributorSku: picked.distributorSku,
            vendorRelationship: picked.vendorRelationship,
            vendorSharePct: picked.vendorSharePct,
            trackStock: picked.trackStock,
            stockCountAtSelection: picked.stockCount,
          };
          setSale(s => ({ ...s, items: ([...(s.items || []), row]) }));
        });
      }
    } catch {}
    return () => {
      window.removeEventListener('message', onMessage);
      try {
        const { ipcRenderer } = (window as any).require ? (window as any).require('electron') : { ipcRenderer: null };
        ipcRenderer?.removeAllListeners?.('sale-product-selected');
      } catch {}
    };
  }, []);

  return (
    <div className="gb-sale-window h-screen overflow-hidden p-3 bg-zinc-900 text-gray-100">
      {clientUpdateTarget ? (
        <ClientUpdatePanel
          embedded
          recordType={clientUpdateTarget.recordType}
          recordId={clientUpdateTarget.recordId}
          onClose={() => setClientUpdateTarget(null)}
          onUpdated={saved => setSale(current => ({ ...current, ...saved, items: Array.isArray(saved?.items) ? saved.items : current.items }))}
        />
      ) : null}
      {warningBanner && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[min(640px,calc(100%-48px))] transition-opacity duration-300 pointer-events-none ${warningBannerVisible ? 'opacity-100' : 'opacity-0'}`}>
          <div className="bg-amber-400 text-zinc-900 px-4 py-3 rounded shadow-lg border border-amber-300">
            <div className="text-sm font-semibold">{warningBanner.message}</div>
            {warningBanner.details ? <div className="text-xs mt-1 leading-snug opacity-80">{warningBanner.details}</div> : null}
          </div>
        </div>
      )}
      <div className="gb-sale-layout grid h-full" style={{ gridTemplateColumns: '220px 1fr 320px', columnGap: 12, rowGap: 8 }}>
    <WorkOrderSidebar
      workOrder={sharedWorkOrder}
      onChange={handleSidebarChange}
      hideAssigned
      saleDates
      hideOrderDeliveryDates
      validationFlags={sidebarValidationFlags}
      renderActions={renderSidebarActions}
    />
  <div className="gb-sale-main flex flex-col gap-2 col-span-1 pb-16 min-h-0 overflow-auto">
          <h1 className="text-xl font-semibold mb-2">New Sale</h1>
          <SaleTechnicianField
            value={sale.assignedTo}
            invalid={!!sidebarValidationFlags?.assignedTo}
            onChange={(assignedTo) => setSale((current) => ({ ...current, assignedTo }))}
          />

          {/* ── Consultation Details Panel ──────────────────────── */}
          {((sale as any).consultationType || String((sale as any).category || '').toLowerCase() === 'consultation') && (
            <div className="bg-zinc-800 border border-yellow-500/50 rounded p-3 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-yellow-400 font-semibold text-sm uppercase tracking-wide">Consultation Details</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Appointment Date</label>
                  <input
                    type="date"
                    className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-sm focus:border-yellow-400 focus:outline-none"
                    value={(sale as any).appointmentDate || ''}
                    onChange={e => setSale(s => ({ ...s, appointmentDate: e.target.value } as any))}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Start Time</label>
                    <input
                      type="time"
                      className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-sm focus:border-yellow-400 focus:outline-none"
                      value={(sale as any).appointmentTime || ''}
                      onChange={e => {
                        const t = e.target.value;
                        const hrs = Number((sale as any).consultationHours) || 1;
                        setSale(s => ({ ...s, appointmentTime: t, appointmentEndTime: addHoursToTime(t, hrs) || (s as any).appointmentEndTime } as any));
                      }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Hours Worked</label>
                    <input
                      type="number"
                      min="0.5"
                      step="0.5"
                      className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-sm focus:border-yellow-400 focus:outline-none"
                      value={(sale as any).consultationHours || 1}
                      onChange={e => {
                        const hrs = Math.max(0.5, Number(e.target.value) || 0.5);
                        const startTime = (sale as any).appointmentTime || '';
                        setSale(s => ({ ...s, consultationHours: hrs, appointmentEndTime: startTime ? addHoursToTime(startTime, hrs) : (s as any).appointmentEndTime } as any));
                      }}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Location Type</label>
                  <select
                    className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-sm focus:border-yellow-400 focus:outline-none"
                    value={(sale as any).consultationType || 'instore'}
                    onChange={e => {
                      const t = e.target.value;
                      if (t === 'instore') { setDistanceMiles(null); setDistanceFeeApplied(false); }
                      setSale(s => ({
                        ...s,
                        consultationType: t,
                        consultationAddress: t === 'instore' ? undefined : (s as any).consultationAddress,
                      } as any));
                    }}
                  >
                    <option value="instore">In-Store</option>
                    <option value="athome">At-Home / On-Site</option>
                  </select>
                </div>
              </div>

              {/* At-Home address + distance check */}
              {(sale as any).consultationType === 'athome' && (
                <div className="space-y-2">
                  {/* Shop address setup (shown when not yet saved) */}
                  {!shopAddress && (
                    <div className="bg-zinc-700/40 border border-zinc-600 rounded p-2 space-y-1">
                      <div className="text-xs text-zinc-400">Enter your shop address to enable distance checking:</div>
                      <div className="flex gap-2">
                        <input
                          className="flex-1 bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-sm focus:border-yellow-400 focus:outline-none"
                          value={shopAddressInput}
                          onChange={e => setShopAddressInput(e.target.value)}
                          placeholder="123 Shop St, City, State ZIP"
                          onKeyDown={e => { if (e.key === 'Enter') saveShopAddressToDB(); }}
                        />
                        <button
                          type="button"
                          className="px-3 py-1.5 text-xs bg-yellow-500 text-black rounded font-medium hover:bg-yellow-400"
                          onClick={saveShopAddressToDB}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Client Address</label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-sm focus:border-yellow-400 focus:outline-none"
                          value={(sale as any).consultationAddress || ''}
                          onChange={e => {
                            const v = e.target.value;
                            setSale(s => ({ ...s, consultationAddress: v } as any));
                            if (addressSuggestTimer.current !== undefined) window.clearTimeout(addressSuggestTimer.current);
                            addressSuggestTimer.current = window.setTimeout(() => {
                              const q = normalizeAddressKey(v);
                              if (!q || q.length < 2) {
                                setAddressMatches([]);
                                setAddressSuggestOpen(false);
                                return;
                              }
                              const list = (addressHistory || [])
                                .filter((r) => {
                                  const a = String(r.address || '');
                                  const ak = normalizeAddressKey(a);
                                  return ak.includes(q);
                                })
                                .sort((a, b) => {
                                  const bc = Number(b.usedCount) || 0;
                                  const ac = Number(a.usedCount) || 0;
                                  if (bc !== ac) return bc - ac;
                                  return String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || ''));
                                })
                                .slice(0, 8);
                              setAddressMatches(list);
                              setAddressSuggestOpen(true);
                            }, 120);
                          }}
                          onFocus={() => {
                            const v = String((sale as any).consultationAddress || '');
                            const q = normalizeAddressKey(v);
                            if (q.length >= 2) setAddressSuggestOpen(true);
                          }}
                          onBlur={e => {
                            const v = e.target.value;
                            // close after click handlers run
                            window.setTimeout(() => setAddressSuggestOpen(false), 150);
                            upsertAddressHistory(v);
                            if (shopAddress) checkClientDistance(v);
                          }}
                          placeholder="123 Main St, City, State ZIP"
                        />
                        {addressSuggestOpen && addressMatches.length > 0 && (
                          <div className="absolute left-0 right-0 top-full z-50 mt-1 bg-zinc-800 border border-zinc-600 rounded shadow-xl max-h-44 overflow-auto">
                            {addressMatches.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                className="w-full text-left px-3 py-2 text-sm hover:bg-zinc-700"
                                onMouseDown={(ev) => {
                                  ev.preventDefault();
                                  const addr = String(r.address || '');
                                  setSale(s => ({ ...s, consultationAddress: addr } as any));
                                  setAddressSuggestOpen(false);
                                  setAddressMatches([]);
                                  upsertAddressHistory(addr);
                                  if (shopAddress) checkClientDistance(addr);
                                }}
                              >
                                <div className="text-zinc-100">{String(r.address || '')}</div>
                                <div className="text-[11px] text-zinc-400">Used {Number(r.usedCount) || 0}×</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {shopAddress && (
                        <button
                          type="button"
                          className="px-3 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded hover:bg-zinc-600 whitespace-nowrap"
                          onClick={() => checkClientDistance((sale as any).consultationAddress || '')}
                          disabled={distanceLoading}
                        >
                          {distanceLoading ? 'Checking…' : 'Check Distance'}
                        </button>
                      )}
                    </div>
                    {/* Distance result badge */}
                    {distanceMiles != null && (
                      <div className={`mt-1 text-xs flex items-center gap-1 ${distanceFeeApplied ? 'text-orange-400' : 'text-green-400'}`}>
                        {distanceFeeApplied
                          ? `⚠ ${distanceMiles.toFixed(1)} mi from shop — $${CONSULTATION_DISTANCE_FEE} distance surcharge added`
                          : `✓ ${distanceMiles.toFixed(1)} mi from shop — within range, no surcharge`}
                      </div>
                    )}
                    {shopAddress && (
                      <div className="mt-0.5 text-[11px] text-zinc-500 flex items-center gap-1">
                        Shop: {shopAddress}
                        <button
                          type="button"
                          className="ml-1 underline text-zinc-400 hover:text-zinc-200"
                          onClick={() => { setShopAddress(''); setShopAddressInput(''); setShopLat(null); setShopLng(null); }}
                        >
                          change
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Pricing breakdown */}
              <div className="pt-1 border-t border-zinc-700">
                {(() => {
                  const hours = Number((sale as any).consultationHours) || 1;
                  const extraHrs = Math.max(0, hours - 1);
                  const extraCost = extraHrs * CONSULTATION_EXTRA_RATE;
                  const distCost = distanceFeeApplied ? CONSULTATION_DISTANCE_FEE : 0;
                  const total = CONSULTATION_BASE_RATE + extraCost + distCost;
                  return (
                    <div className="bg-zinc-900/60 rounded p-2 text-xs space-y-1">
                      <div className="text-zinc-400 font-medium mb-1">Pricing Breakdown</div>
                      <div className="flex justify-between text-zinc-300">
                        <span>Base rate (1st hr)</span>
                        <span>${CONSULTATION_BASE_RATE}.00</span>
                      </div>
                      {extraHrs > 0 && (
                        <div className="flex justify-between text-zinc-300">
                          <span>+{extraHrs} additional hr{extraHrs !== 1 ? 's' : ''} × ${CONSULTATION_EXTRA_RATE}</span>
                          <span>${extraCost.toFixed(2)}</span>
                        </div>
                      )}
                      {distCost > 0 && (
                        <div className="flex justify-between text-orange-400">
                          <span>Distance surcharge (&gt;{CONSULTATION_DISTANCE_THRESHOLD} mi)</span>
                          <span>${distCost}.00</span>
                        </div>
                      )}
                      <div className="flex justify-between font-semibold text-yellow-400 border-t border-zinc-700 pt-1">
                        <span>Total</span>
                        <span>${total.toFixed(2)}</span>
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div className="text-xs text-zinc-500">Purpose / title is shown in the items list below.</div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 bg-zinc-900 border border-zinc-700 rounded p-3">
            <SaleItemsTable
              items={(sale.items || []) as SaleItemRow[]}
              onChange={handleSaleItemsChange}
              showRequiredIndicator={itemsSectionNeedsAttention}
            />

            {(() => {
              const orderedItems = ((sale.items || []) as SaleItemRow[]).filter(item => item.requiresOrder || item.sourceKind === 'order' || item.orderStatus === 'ordered' || item.orderStatus === 'needed');
              if (!orderedItems.length) return null;
              return <section className="col-span-2 rounded-xl border border-violet-500/35 bg-violet-950/20 p-3">
                <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold text-violet-100">Delivery overview</h3><span className="text-xs text-violet-200">From ordered sale items</span></div>
                <div className="space-y-2">{orderedItems.map(item => <div key={item.id} className="grid gap-2 rounded-lg border border-zinc-700 bg-zinc-950/50 px-3 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"><strong className="truncate text-zinc-100">{item.description || 'Ordered product'}</strong><span className="text-zinc-400">Ordered: {item.orderDate || 'Not recorded'}</span><span className="text-zinc-400">ETA: {item.estimatedDeliveryDate || 'Not recorded'}</span></div>)}</div>
              </section>;
            })()}
          <div className="col-span-2">
            <label className="block text-sm text-zinc-400 mb-1">Notes</label>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 min-h-[80px]"
              value={sale.notes || ''}
              onChange={e => setSale(s => ({ ...s, notes: e.target.value }))}
              placeholder="Optional notes"
            />
          </div>
        </div>

        <div className="mt-2 flex items-center justify-end">
          <div className="flex items-center gap-2">
            {errors.length > 0 && (
              <div className="text-sm text-red-400 mr-2">{errors.join(' · ')}</div>
            )}
            {savedAt && errors.length === 0 && (
              <div className="text-xs text-neon-green mr-2">Saved {savedAt}</div>
            )}
          </div>
        </div>
        </div>
        <div className="gb-sale-payment flex flex-col gap-3 min-h-0 overflow-auto">
          <IntakePanel
            workOrder={sharedWorkOrder}
            customerSummary={intakeCustomerSummary}
            onChange={handleIntakeChange}
            onUpdateClient={() => { void openClientUpdate(); }}
            updateClientDisabled={!Number((sale as any).id || 0)}
          />
          <PaymentPanel salesMode workOrder={sharedWorkOrder} onChange={handlePaymentChange} onCheckout={handleCheckout} />
        </div>
      </div>
      <div className="fixed bottom-4 left-4 right-3 flex items-center justify-between gap-2">
        <div className="text-xs text-zinc-500 min-h-[1.2rem]">Auto-save enabled</div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 bg-zinc-800 rounded" onClick={onCancel}>Cancel</button>
          <button
          className={`px-3 py-1.5 rounded font-semibold shadow focus:outline-none focus:ring-2 focus:ring-neon-green/70 active:scale-[0.98] transition ${canSave ? 'bg-neon-green text-zinc-900 hover:brightness-110' : 'bg-zinc-800 text-zinc-300 hover:border hover:border-amber-300'}`}
          onClick={handleSave}
        >Save</button>
        </div>
      </div>
    </div>
  );
};

export default SaleWindow;
