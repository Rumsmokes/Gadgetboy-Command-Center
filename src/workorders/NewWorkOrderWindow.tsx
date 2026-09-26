
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSingleFlight } from '../lib/reliability';
import { shouldCloseWorkOrderAfterPayment } from '../lib/workOrderLifecycle';
import { useAutosave } from '../lib/useAutosave';
import { consumeWindowPayload } from '../lib/windowPayload';
import WorkOrderSidebar from './WorkOrderSidebar';
import WorkOrderForm from './WorkOrderForm';
import ItemsTable, { type WorkOrderItemRow } from './ItemsTable';
import CustomBuildItemsTable from './CustomBuildItemsTable';
import IntakePanel from './IntakePanel';
import PaymentPanel from './PaymentPanel';
import NotesPanel from './NotesPanel';
import DroneChecklistPanel, { defaultDroneChecklist } from './DroneChecklistPanel';
import DropoffAccessoriesPanel from './DropoffAccessoriesPanel';
import ClientUpdatePanel from './ClientUpdatePanel';
import { computeTotals, round2 } from '../lib/calc';
import { WorkOrderFull, WorkOrderItem as BaseWorkOrderItem, DroneChecklist, DropoffAccessory, RepairItem } from '../lib/types';
import { listTechnicians } from '../lib/admin';
import type { SaleItemRow } from '../sales/SaleItemsTable';
import { discountedWorkOrderItemAmounts, ticketLaborCharge } from '../lib/ticketAccounting';
import DurantProposalReview from './DurantProposalReview';
import { consumeInStockInventory, shouldConsumeWorkOrderInventory } from '../lib/inventoryConsumption';
import { TechnicianAvatar } from '../lib/technicianIcons';
import { queueInitialPaymentAcknowledgment } from '../lib/automaticEmailQueue';
import ClientDropoffWindow from './ClientDropoffWindow';

type RequiredKey = 'assignedTo' | 'productDescription' | 'problemInfo' | 'password' | 'model' | 'serial';

type ValidationActionKey = 'save' | 'checkout' | 'close';

type TechnicianOption = { id: string | number; nickname?: string; firstName?: string; profileIcon?: string };

const REQUIRED_LABELS: Record<RequiredKey, string> = {
  assignedTo: 'Assigned technician',
  productDescription: 'Device description',
  problemInfo: 'Problem details',
  password: 'Device password',
  model: 'Device model',
  serial: 'Device serial',
};

function workOrderItemQuantity(item: Partial<WorkOrderItemRow>) {
  const quantity = Number(item.quantity ?? 1);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function calculateWorkOrderItemAmounts(items: WorkOrderItemRow[], discount: number, taxRate: number, amountPaid: number, diagnostic?: WorkOrderFull['diagnosticSelection']) {
  const discounted = items.map(item => ({ ...item, ...discountedWorkOrderItemAmounts(item) }));
  const partCosts = round2(discounted.reduce((sum, item) => sum + item.parts, 0));
  const laborCost = ticketLaborCharge(discounted, diagnostic);
  return {
    partCosts,
    laborCost,
    totals: computeTotals({ laborCost, partCosts, discount, taxRate, amountPaid }),
  };
}

function parsePayload() {
  try {
    // Check the in-app modal payload store first (set when opened as internal modal).
    const stored = consumeWindowPayload('newWorkOrder');
    if (stored !== null) return stored;
  } catch {}
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('newWorkOrder');
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch (e) { return null; }
}

function onlyDate(iso?: string | null) {
  return (iso || '').toString().slice(0, 10);
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

  const anchor = parseCheckoutPaymentDate(record?.historicalPaymentDate)
    || parseCheckoutPaymentDate(record?.manualPaymentDate)
    || parseCheckoutPaymentDate(record?.checkoutDate)
    || parseCheckoutPaymentDate(record?.clientPickupDate)
    || parseCheckoutPaymentDate(record?.repairCompletionDate)
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

function remainingWorkOrderPaymentBuckets(record: any) {
  const grossParts = round2(Math.max(0, Number(record?.partCosts || 0)) * (1 + Math.max(0, Number(record?.taxRate || 0)) / 100));
  const grossLabor = round2(Math.max(0, Number(record?.laborCost || 0) - Number(record?.discount || 0)));
  const payments = buildNormalizedCheckoutPayments(record);
  let paidParts = round2(payments.reduce((sum: number, payment: any) => sum + Math.max(0, Number(payment?.appliedParts || 0)), 0));
  let paidLabor = round2(payments.reduce((sum: number, payment: any) => sum + Math.max(0, Number(payment?.appliedLabor || 0)), 0));
  const explicitPaid = round2(paidParts + paidLabor);
  const recordedPaid = round2(Math.max(
    Number(record?.amountPaid || 0),
    payments.reduce((sum: number, payment: any) => sum + Math.max(0, Number(payment?.applied ?? payment?.amount ?? 0)), 0),
  ));

  // Legacy payments predate explicit buckets. Most were diagnostic fees, so
  // allocate those to labor first. Every new checkout stores exact buckets.
  let unallocated = round2(Math.max(0, recordedPaid - explicitPaid));
  const legacyLabor = round2(Math.min(unallocated, Math.max(0, grossLabor - paidLabor)));
  paidLabor = round2(paidLabor + legacyLabor);
  unallocated = round2(Math.max(0, unallocated - legacyLabor));
  paidParts = round2(paidParts + Math.min(unallocated, Math.max(0, grossParts - paidParts)));

  const totalRemaining = round2(Math.max(0, Number(record?.totals?.remaining || 0)));
  let partsDue = round2(Math.max(0, grossParts - paidParts));
  let laborDue = round2(Math.max(0, grossLabor - paidLabor));
  const bucketTotal = round2(partsDue + laborDue);
  if (bucketTotal > totalRemaining) {
    const overflow = round2(bucketTotal - totalRemaining);
    const laborReduction = Math.min(laborDue, overflow);
    laborDue = round2(laborDue - laborReduction);
    partsDue = round2(Math.max(0, partsDue - (overflow - laborReduction)));
  } else if (bucketTotal < totalRemaining) {
    laborDue = round2(laborDue + (totalRemaining - bucketTotal));
  }
  return { partsDue, laborDue };
}

const ADDON_SALE_MAX_ITEMS = 20;

const AssignedTechnicianField: React.FC<{
  value: WorkOrderFull['assignedTo'];
  invalid?: boolean;
  onChange: (assignedTo: string | null) => void;
}> = ({ value, invalid = false, onChange }) => {
  const [techs, setTechs] = useState<TechnicianOption[]>([]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const list = await listTechnicians();
        if (mounted) setTechs(Array.isArray(list) ? list : []);
      } catch {
        if (mounted) setTechs([]);
      }
    };
    void refresh();
    const off = (window as any).api?.onTechniciansChanged?.(() => void refresh());
    return () => { mounted = false; try { off && off(); } catch {} };
  }, []);

  const selectedTechId = useMemo(() => {
    if (!value) return '';
    const raw = String(value).trim();
    if (techs.some((t: any) => String(t.id) === raw)) return raw;
    const matchByLabel = techs.find((t: any) => (t.nickname?.trim() || t.firstName) === raw);
    return matchByLabel ? String(matchByLabel.id) : '';
  }, [techs, value]);
  const selectedTech = techs.find((tech) => String(tech.id) === selectedTechId);

  return (
    <div className="gb-wo-assigned-field">
      <label className="block text-xs text-zinc-400">
        Assigned to
        {invalid && <span className="ml-1 text-red-500">*</span>}
      </label>
      <div className="mt-1 flex items-center gap-2">
      <TechnicianAvatar iconId={selectedTech?.profileIcon} size={34} ariaLabel={selectedTech?.nickname || selectedTech?.firstName || 'Unassigned technician'} />
      {techs.length === 0 ? (
        <select disabled className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-500">
          <option>No technicians</option>
        </select>
      ) : (
        <select
          className={`min-w-0 flex-1 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand bg-zinc-800 border ${invalid ? 'border-red-500' : 'border-zinc-700'}`}
          value={selectedTechId}
          onChange={e => {
            const id = e.target.value;
            if (!id) { onChange(null); return; }
            const tech = techs.find((t: any) => String(t.id) === id);
            onChange(tech ? String(tech.id) : null);
          }}
        >
          <option value="">Unassigned</option>
          {techs.map((t: any) => (
            <option key={t.id} value={String(t.id)}>{t.nickname?.trim() || t.firstName}</option>
          ))}
        </select>
      )}
      </div>
    </div>
  );
};

function isConsultationSaleItem(row: Partial<SaleItemRow> | null | undefined): boolean {
  const cat = (row as any)?.category;
  const s = (cat == null ? '' : String(cat)).trim().toLowerCase();
  return s === 'consultation' || s.startsWith('consult');
}

function addonSaleUnits(row: Partial<SaleItemRow> | null | undefined): number {
  if (isConsultationSaleItem(row)) {
    const hours = Number((row as any)?.consultationHours ?? row?.qty ?? 0);
    return Number.isFinite(hours) && hours > 0 ? hours : 0;
  }
  const qty = Number(row?.qty ?? 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function addonSaleLineTotal(row: Partial<SaleItemRow> | null | undefined): number {
  return addonSaleUnits(row) * (Number(row?.price) || 0);
}

function computeAddonSaleTotals(opts: { items: SaleItemRow[]; taxRate: number; discount: number; amountPaid: number }) {
  const items = Array.isArray(opts.items) ? opts.items : [];
  const taxRate = Number(opts.taxRate || 0) || 0;
  const discount = Number(opts.discount || 0) || 0;
  const amountPaid = Number(opts.amountPaid || 0) || 0;

  const partCosts = round2(items.reduce((sum, r) => sum + addonSaleLineTotal(r), 0));
  const consultationTotal = round2(items.reduce((sum, r) => (isConsultationSaleItem(r) ? sum + addonSaleLineTotal(r) : sum), 0));

  const discountedTotal = round2(Math.max(0, partCosts - discount));
  const taxableParts = Math.max(0, discountedTotal - consultationTotal);
  const subTotal = round2(partCosts);
  const tax = round2(taxableParts * taxRate / 100);
  const total = round2(discountedTotal + tax);
  const remaining = Math.max(0, round2(total - amountPaid));

  return {
    partCosts,
    laborCost: 0,
    totals: { subTotal, tax, total, remaining },
  };
}

const NewWorkOrderWindow: React.FC = () => {
  const payload = parsePayload();
  const isEditingExisting = !!payload?.workOrderId;
  const isChildWindow = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.has('newWorkOrder');
    } catch {
      return false;
    }
  }, []);
  const [loaded, setLoaded] = useState(!isEditingExisting);
  const [customerSummary, setCustomerSummary] = useState<{ name: string; phone: string }>({ name: payload?.customerName || '', phone: payload?.customerPhone || '' });
  const [initialCustomerId, setInitialCustomerId] = useState<number>(payload?.customerId || 0);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [clientUpdateOpen, setClientUpdateOpen] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [diagnosticOptions, setDiagnosticOptions] = useState<RepairItem[]>([]);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const now = new Date().toISOString();
  type WOState = Omit<WorkOrderFull, 'items'> & {
    items: WorkOrderItemRow[];
    internalNotesLog?: { id: number; text: string; createdAt?: string }[];
    workOrderType?: 'standard' | 'customBuild' | 'drone' | 'durantReport';
  };
  const [wo, setWo] = useState<WOState>({
    id: 0,
    customerId: initialCustomerId,
    customerName: payload?.customerName || '',
    customerPhone: payload?.customerPhone || '',
  status: 'open',
  assignedTo: null,
    addonSaleId: null,
    checkInAt: now,
    repairCompletionDate: null,
    checkoutDate: null,
    productCategory: '',
    productDescription: '',
    password: '',
    model: '',
    serial: '',
    intakeSource: '',
    workOrderType: (payload as any)?.workOrderType === 'customBuild' || (payload as any)?.isCustomBuild ? 'customBuild'
      : (payload as any)?.workOrderType === 'drone' ? 'drone'
      : (payload as any)?.workOrderType === 'durantReport' ? 'durantReport'
      : 'standard',
  partsOrdered: false,
  partsEstimatedDelivery: null,
  partsDates: '',
  partsOrderUrl: '',
  partsTrackingUrl: '',
  partsOrderDate: null,
  partsEstDelivery: null,
    discount: 0,
    amountPaid: 0,
    taxRate: 8,
    laborCost: 0,
    partCosts: 0,
    totals: { subTotal: 0, tax: 0, total: 0, remaining: 0 },
  items: [] as WorkOrderItemRow[],
  internalNotes: '',
  internalNotesLog: [],
  droneChecklist: defaultDroneChecklist(),
  dropoffAccessories: [] as DropoffAccessory[],
  });
  const [validationActive, setValidationActive] = useState<boolean>(false);
  const [validationActionLabel, setValidationActionLabel] = useState('');
  const [warningBanner, setWarningBanner] = useState<{ message: string; details?: string } | null>(null);
  const [warningBannerVisible, setWarningBannerVisible] = useState<boolean>(false);
  const warningHideTimer = useRef<number | undefined>(undefined);
  const warningRemoveTimer = useRef<number | undefined>(undefined);
  const lastPartsCalendarSyncKey = useRef<string>('');
  const handleCheckoutRef = useRef<() => Promise<void>>(async () => {});
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const checkoutSingleFlightRef = useRef<(() => Promise<void>) | null>(null);
  if (!checkoutSingleFlightRef.current) {
    checkoutSingleFlightRef.current = createSingleFlight(async () => {
      setCheckoutBusy(true);
      try { await handleCheckoutRef.current(); } finally { setCheckoutBusy(false); }
    });
  }
  const [addonSale, setAddonSale] = useState<any | null>(null);
  const [armedValidationActions, setArmedValidationActions] = useState<Record<ValidationActionKey, boolean>>({
    save: false,
    checkout: false,
    close: false,
  });

  useEffect(() => {
    let active = true;
    void (async () => {
      const rows = await (window as any).api?.dbGet?.('repairCategories').catch(() => []);
      if (!active) return;
      const diagnostics = (Array.isArray(rows) ? rows : []).filter((item: RepairItem) => /diagnostic/i.test(`${item.repairCategory || ''} ${item.title || ''}`));
      const unique = new Map<string, RepairItem>();
      diagnostics.forEach((item: RepairItem) => {
        const label = String(item.title || item.repairCategory || 'Diagnostic').trim().toLowerCase().replace(/\s+/g, ' ');
        const amount = Math.max(0, Number(item.laborCost || 0) + Number(item.partCost || 0)).toFixed(2);
        const key = `${label}|${amount}`;
        if (!unique.has(key)) unique.set(key, item);
      });
      setDiagnosticOptions([...unique.values()]);
    })();
    return () => { active = false; };
  }, []);

  // Load the attached retail sale (if any) so we can display quick context.
  useEffect(() => {
    const saleId = Number((wo as any).addonSaleId || 0);
    if (!saleId) { setAddonSale(null); return; }

    let alive = true;
    (async () => {
      try {
        const api: any = (window as any).api;
        if (!api?.dbGet) { if (alive) setAddonSale(null); return; }
        const list = await api.dbGet('sales').catch(() => []);
        const found = Array.isArray(list) ? list.find((s: any) => Number(s?.id || 0) === saleId) : null;
        if (alive) setAddonSale(found || null);
      } catch {
        if (alive) setAddonSale(null);
      }
    })();

    return () => { alive = false; };
  }, [wo.addonSaleId]);

  const isCustomBuild = wo.workOrderType === 'customBuild';
  const isDrone = wo.workOrderType === 'drone';
  const isDurantReport = wo.workOrderType === 'durantReport';

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

  const missingRequired = useMemo<RequiredKey[]>(() => {
    const missing: RequiredKey[] = [];
    const assigned = (wo.assignedTo ?? '').toString().trim();
    if (!assigned) missing.push('assignedTo');
    if (!(wo.productDescription || '').toString().trim()) missing.push('productDescription');
    if (!(wo.problemInfo || '').toString().trim()) missing.push('problemInfo');
    if (!isCustomBuild && !isDrone) {
      if (!(wo.password || '').toString().trim()) missing.push('password');
      if (!(wo.model || '').toString().trim()) missing.push('model');
      if (!(wo.serial || '').toString().trim()) missing.push('serial');
    }
    return missing;
  }, [wo.assignedTo, wo.productDescription, wo.problemInfo, wo.password, wo.model, wo.serial, isCustomBuild, isDrone]);

  const hasMeaningfulInput = useMemo(() => {
    return Boolean(
      (wo.productCategory && wo.productCategory.trim()) ||
      (wo.productDescription && wo.productDescription.trim()) ||
      (wo.problemInfo && wo.problemInfo.trim()) ||
      (wo.password && wo.password.trim()) ||
      (wo.model && wo.model.trim()) ||
      (wo.serial && wo.serial.trim()) ||
      (wo.intakeSource && wo.intakeSource.trim()) ||
      (wo.items && wo.items.length > 0) ||
      (Number(wo.discount) || 0) !== 0 ||
      (Number(wo.amountPaid) || 0) !== 0 ||
      (Number(wo.laborCost) || 0) !== 0 ||
      (Number(wo.partCosts) || 0) !== 0 ||
      ((wo.assignedTo ?? '').toString().trim().length > 0)
    );
  }, [wo]);

  useEffect(() => {
    if (validationActive && missingRequired.length === 0) {
      setValidationActive(false);
    }
  }, [validationActive, missingRequired]);

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

  const formValidationFlags = useMemo<
    Partial<Record<'productDescription' | 'problemInfo' | 'password' | 'model' | 'serial', boolean>> | undefined
  >(() => {
    if (!validationActive) return undefined;
    const set = new Set(missingRequired);
    return {
      productDescription: set.has('productDescription'),
      problemInfo: set.has('problemInfo'),
      password: set.has('password'),
      model: set.has('model'),
      serial: set.has('serial'),
    };
  }, [validationActive, missingRequired]);

  const sidebarValidationFlags = useMemo<Partial<Record<'assignedTo', boolean>> | undefined>(() => {
    if (!validationActive) return undefined;
    const set = new Set(missingRequired);
    return { assignedTo: set.has('assignedTo') };
  }, [validationActive, missingRequired]);


  // Load existing work order if editing
  useEffect(() => {
    if (!isEditingExisting) return;
    (async () => {
      try {
        const list = await (window as any).api.findWorkOrders({ id: payload.workOrderId });
        const existing = (list && list[0]) || null;
        if (!existing) { setLoaded(true); return; }
        // Map existing.items (WorkOrderItem[]) to WorkOrderItemRow[] if present
        const mappedItems: WorkOrderItemRow[] = (existing.items || []).map((it: any) => ({
          ...it,
          id: it.id?.toString() || Math.random().toString(36).slice(2),
          device: (it.device || existing.productDescription || existing.productCategory || ''),
          repairCategory: it.repairCategory || '',
          repair: (it.repair || it.description || it.title || it.name || it.altDescription || ''),
          parts: typeof it.parts === 'number' ? it.parts : (typeof it.partCost === 'number' ? it.partCost : 0),
          labor: typeof it.labor === 'number' ? it.labor : (typeof it.unitPrice === 'number' ? it.unitPrice : (typeof it.laborCost === 'number' ? it.laborCost : 0)),
          status: it.status || 'pending',
          note: it.note || it.model || it.modelNumber || '',
          orderSourceUrl: it.orderSourceUrl || it.productUrl || '',
          internalCost: it.internalCost === null || typeof it.internalCost === 'undefined' || it.internalCost === ''
            ? undefined
            : Number(it.internalCost),
          quantity: workOrderItemQuantity(it),
        }));
        setWo(w => ({
          ...w,
          ...existing,
          workOrderType: ((existing as any).workOrderType === 'customBuild' || (existing as any).isCustomBuild) ? 'customBuild'
            : (existing as any).workOrderType === 'drone' ? 'drone'
            : (existing as any).workOrderType === 'durantReport' ? 'durantReport'
            : (w.workOrderType || 'standard'),
          partsOrdered: existing.partsOrdered ?? w.partsOrdered,
          partsEstimatedDelivery: existing.partsEstimatedDelivery ?? w.partsEstimatedDelivery,
          partsDates: (existing as any).partsDates ?? w.partsDates,
          partsOrderUrl: (existing as any).partsOrderUrl ?? w.partsOrderUrl,
          partsTrackingUrl: (existing as any).partsTrackingUrl ?? w.partsTrackingUrl,
          partsOrderDate: (existing as any).partsOrderDate ?? w.partsOrderDate,
          partsEstDelivery: (existing as any).partsEstDelivery ?? w.partsEstDelivery,
          items: mappedItems.length ? mappedItems : w.items,
          totals: existing.totals || w.totals,
          droneChecklist: (existing as any).droneChecklist ?? w.droneChecklist,
          dropoffAccessories: Array.isArray((existing as any).dropoffAccessories) ? (existing as any).dropoffAccessories : w.dropoffAccessories,
          internalNotesLog: Array.isArray(existing.internalNotesLog) ? existing.internalNotesLog : (existing.internalNotes ? existing.internalNotes.split('\n').map((line: string, idx: number) => ({ id: idx + 1, text: line })) : []),
        }));
  setInitialCustomerId(existing.customerId || existing.customerID || existing.customer_id || 0);
        setCustomerSummary({ name: existing.customerName || customerSummary.name, phone: existing.customerPhone || customerSummary.phone });
      } catch (e) {
        console.error('Failed loading existing work order', e);
      } finally {
        setLoaded(true);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recompute partCosts, laborCost, and totals whenever items or payment fields change
  useEffect(() => {
    const { partCosts, laborCost, totals } = calculateWorkOrderItemAmounts(
      wo.items,
      wo.discount || 0,
      wo.taxRate || 0,
      wo.amountPaid || 0,
      wo.diagnosticSelection,
    );
    setWo(w => {
      const existing = w.totals || { subTotal: 0, tax: 0, total: 0, remaining: 0 };
      const totalsUnchanged =
        Number(existing.subTotal || 0) === Number(totals.subTotal || 0) &&
        Number(existing.tax || 0) === Number(totals.tax || 0) &&
        Number(existing.total || 0) === Number(totals.total || 0) &&
        Number(existing.remaining || 0) === Number(totals.remaining || 0);
      if (
        Number(w.partCosts || 0) === Number(partCosts || 0) &&
        Number(w.laborCost || 0) === Number(laborCost || 0) &&
        totalsUnchanged
      ) {
        return w;
      }
      return { ...w, partCosts, laborCost, totals };
    });
  }, [wo.items, wo.discount, wo.taxRate, wo.amountPaid, wo.diagnosticSelection, (wo as any).discountType, (wo as any).discountPctValue, (wo as any).discountCustomAmount]);

  const onSaveRef = useRef<() => void>(() => {});
  const onCancelRef = useRef<() => void>(() => {});
  const woRef = useRef<any>(wo);
  const persistedIdRef = useRef<number>(Number((wo as any).id || 0) || 0);
  const createWorkOrderPromiseRef = useRef<Promise<any> | null>(null);
  const isEditingExistingRef = useRef<boolean>(isEditingExisting);
  useEffect(() => { woRef.current = wo; }, [wo]);
  useEffect(() => { isEditingExistingRef.current = isEditingExisting; }, [isEditingExisting]);
  const createWorkOrderOnce = useCallback(async (draft: any) => {
    const existingId = persistedIdRef.current || Number(draft?.id || woRef.current?.id || 0);
    if (existingId) return { ...draft, id: existingId };
    if (createWorkOrderPromiseRef.current) return createWorkOrderPromiseRef.current;
    const api: any = (window as any).api || {};
    const request = (typeof api.addWorkOrder === 'function' ? api.addWorkOrder({ ...draft }) : api.dbAdd('workOrders', { ...draft }))
      .then((added: any) => {
        if (added?.id) {
          persistedIdRef.current = Number(added.id);
          woRef.current = { ...woRef.current, ...added, id: added.id };
          setWo(current => ({ ...current, id: added.id }));
        }
        return added;
      });
    createWorkOrderPromiseRef.current = request;
    try { return await request; } finally { if (createWorkOrderPromiseRef.current === request) createWorkOrderPromiseRef.current = null; }
  }, []);

  const persistJournalNote = useCallback(async (text: string) => {
    const previous = woRef.current as WOState;
    const stamp = new Date().toISOString();
    const displayStamp = stamp.slice(0, 16).replace('T', ' ');
    const entryText = `${displayStamp} — ${text}`;
    const currentLog = Array.isArray(previous.internalNotesLog) ? previous.internalNotesLog : [];
    const nextEntryId = currentLog.reduce((max, entry) => Math.max(max, Number(entry?.id || 0)), 0) + 1;
    const next: WOState & { updatedAt: string } = {
      ...previous,
      internalNotes: (previous.internalNotes ? `${previous.internalNotes}\n` : '') + entryText,
      internalNotesLog: [...currentLog, { id: nextEntryId, text: entryText, createdAt: stamp }],
      updatedAt: stamp,
    };
    woRef.current = next;
    setWo(next);

    const id = Number(previous.id || 0);
    if (!id) return;
    try {
      const api: any = (window as any).api || {};
      const saved = typeof api.dbUpdate === 'function'
        ? await api.dbUpdate('workOrders', id, next)
        : await api.update?.('workOrders', next);
      if (!saved) throw new Error('The work-order note was not returned after saving.');
      woRef.current = saved;
      setWo(saved);
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }));
      try { window.opener?.postMessage({ type: 'workorders:changed', id }, '*'); } catch {}
    } catch (error) {
      woRef.current = previous;
      setWo(previous);
      throw error;
    }
  }, []);

  // Bind the latest functions each render.
  onSaveRef.current = onSave;
  onCancelRef.current = onCancel;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        try { onSaveRef.current(); } catch {}
      }
      if (e.key === 'Escape') {
        try { onCancelRef.current(); } catch {}
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Attempt auto-save when the window is being closed if fields look valid
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const current = woRef.current || {};
      const requiredOk = !!(current.productCategory && current.productDescription && current.customerId && current.assignedTo);
      if (!requiredOk) return; // nothing to do
      // If it's a new order (id 0) or editing, persist synchronously before allowing close
      // Prevent default close, then perform save and close programmatically
      e.preventDefault();
      e.returnValue = '';
      (async () => {
        try {
          const api = (window as any).api || {};
          const persistedId = persistedIdRef.current || Number(current.id || 0);
          if (isEditingExistingRef.current || persistedId) {
            current.id = persistedId;
            if (typeof api.update === 'function') await api.update('workOrders', { ...current });
            else if (typeof api.dbUpdate === 'function') await api.dbUpdate('workOrders', current.id, { ...current });
          } else {
            const added = await createWorkOrderOnce(current);
            if (added?.id) persistedIdRef.current = Number(added.id);
          }
          try { window.opener?.postMessage({ type: 'workorders:changed', id: current.id }, '*'); } catch {}
        } catch (err) {
          console.warn('Auto-save on close failed', err);
        } finally {
          // Remove the listener to avoid loops then close
          window.removeEventListener('beforeunload', handler as any);
          window.close();
        }
      })();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [createWorkOrderOnce]);

  // Autosave work order after a short idle period (keeps UI responsive during typing)
  useAutosave(wo, async (val) => {
    if (!String(val.assignedTo ?? '').trim()) return;
    try {
      const api = (window as any).api || {};
      let saved: any = null;
      // Decide add vs update
      const persistedId = persistedIdRef.current || Number(val.id || 0);
      if (isEditingExisting || persistedId) {
        const updateValue = { ...val, id: persistedId };
        if (typeof api.update === 'function') saved = await api.update('workOrders', updateValue);
        else if (typeof api.dbUpdate === 'function') saved = await api.dbUpdate('workOrders', persistedId, updateValue);
      } else {
        // Only create a new record when some key fields have content
        const hasMeaningful = !!(val.productCategory || val.productDescription || val.customerId || (val.items && val.items.length));
        if (!hasMeaningful) return;
        const added = await createWorkOrderOnce(val);
        saved = added;
        if (added?.id) { persistedIdRef.current = Number(added.id); woRef.current = { ...woRef.current, ...added, id: added.id }; setWo(w => ({ ...w, id: added.id })); }
      }
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }));
      try { window.opener?.postMessage({ type: 'workorders:changed', id: (val as any).id }, '*'); } catch {}

      // Reflect parts into Calendar only when relevant fields changed
      try {
        const id = Number((saved?.id ?? val.id) || 0);
        const key = [
          id,
          onlyDate((saved?.partsOrderDate ?? (val as any).partsOrderDate) || null),
          onlyDate((saved?.partsEstDelivery ?? (val as any).partsEstDelivery) || null),
          String((saved?.partsOrderUrl ?? (val as any).partsOrderUrl) || ''),
          String((saved?.partsTrackingUrl ?? (val as any).partsTrackingUrl) || ''),
        ].join('|');
        if (id && key !== lastPartsCalendarSyncKey.current) {
          lastPartsCalendarSyncKey.current = key;
          await reflectWorkOrderInCalendar(saved || val);
        }
      } catch {
        // ignore
      }
    } catch (e) {
      // silent
    }
  }, {
    debounceMs: 8000,
    enabled: true,
    equals: Object.is,
    skipInitialSave: isEditingExisting,
    // Ensure autosave does not fire for brand-new empty forms
    shouldSave: (v) => !!String(v.assignedTo ?? '').trim()
      && !!(isEditingExisting || (v.id && v.id !== 0) || v.productCategory || v.productDescription || v.customerId || (v.items && v.items.length)),
  });

  function ensureRequired(action: ValidationActionKey, actionDescription: string): boolean {
    if (missingRequired.length === 0) {
      setValidationActive(false);
      setArmedValidationActions(prev => ({ ...prev, [action]: false }));
      return true;
    }

    setValidationActive(true);
    setArmedValidationActions(prev => ({ ...prev, [action]: false }));
    setValidationActionLabel(actionDescription);
    return false;
  }

  async function reflectWorkOrderInCalendar(saved: any) {
    const api: any = (window as any).api;
    if (!api?.dbGet || !api?.dbAdd || !api?.dbDelete) return;

    const all: any[] = await api.dbGet('calendarEvents').catch(() => []);
    const workOrderId = Number(saved?.id || 0);
    if (!workOrderId) return;

    const partName = `WO #${workOrderId} ${String(saved?.productDescription || saved?.productCategory || 'Parts').trim()}`.trim();
    const base = {
      category: 'parts',
      partName,
      title: partName,
      customerName: saved?.customerName || customerSummary.name,
      customerPhone: saved?.customerPhone || customerSummary.phone,
      technician: saved?.assignedTo || undefined,
      source: 'workorder',
      workOrderId,
      orderUrl: saved?.partsOrderUrl || undefined,
      trackingUrl: saved?.partsTrackingUrl || undefined,
    } as any;

    async function syncOne(status: 'ordered' | 'delivery', desiredDate: string | null) {
      const existing = all.filter(e => e.category === 'parts' && e.source === 'workorder' && e.workOrderId === workOrderId && e.partsStatus === status);
      if (!desiredDate) {
        for (const e of existing) {
          if (e?.id != null) await api.dbDelete('calendarEvents', e.id).catch(() => {});
        }
        return;
      }
      const sameDate = existing.find(e => e.date === desiredDate);
      for (const e of existing) {
        if (sameDate && e === sameDate) continue;
        if (e?.id != null) await api.dbDelete('calendarEvents', e.id).catch(() => {});
      }
      if (sameDate?.id != null && api.dbUpdate) {
        await api.dbUpdate('calendarEvents', sameDate.id, { ...sameDate, ...base, date: desiredDate, partsStatus: status }).catch(() => {});
      } else {
        await api.dbAdd('calendarEvents', { ...base, date: desiredDate, partsStatus: status }).catch(() => {});
      }
    }

    const orderedDate = onlyDate(saved?.partsOrderDate);
    const deliveryDate = onlyDate(saved?.partsEstDelivery);
    await syncOne('ordered', orderedDate ? orderedDate : null);
    await syncOne('delivery', deliveryDate ? deliveryDate : null);
  }

  function onSave() {
    if (!ensureRequired('save', 'saving the work order')) return;
    if (!wo.productCategory || !wo.productCategory.trim()) {
      triggerWarningBanner('Device category is missing', 'Select a device category, then click Save again.');
      return;
    }
    if (!wo.customerId) {
      triggerWarningBanner('Customer is missing', 'Select a customer, then click Save again.');
      return;
    }
    (async () => {
      try {
        const api = (window as any).api || {};
        let saved: any = null;
        const persistedId = persistedIdRef.current || Number(wo.id || 0);
        if (isEditingExisting || persistedId) {
          const updateValue = { ...wo, id: persistedId };
          if (typeof api.update === 'function') saved = await api.update('workOrders', updateValue);
          else if (typeof api.dbUpdate === 'function') saved = await api.dbUpdate('workOrders', persistedId, updateValue);
          console.log('Work order updated', saved);
        } else {
          saved = await createWorkOrderOnce(wo);
          console.log('Work order added', saved);
        }
        const savedId = Number(saved?.id || wo.id || 0);
        if(savedId){ persistedIdRef.current=savedId; woRef.current={...woRef.current,...saved,id:savedId}; }
        try { window.opener?.postMessage({ type: 'workorders:changed', id: savedId }, '*'); } catch {}
        setSavedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }));

        // Reflect parts ordered/delivery dates into Calendar
        try {
          await reflectWorkOrderInCalendar(saved || wo);
        } catch (e) {
          console.warn('calendar sync failed', e);
        }

        // After saving, return the user to the main/customer screen.
        // Use a safe close so we never accidentally close the main window.
        try {
          const api = (window as any).api;
          if (api?.closeSelfWindow) {
            await api.closeSelfWindow({ focusMain: true });
          } else {
            window.close();
          }
        } catch {
          try { window.close(); } catch {}
        }
      } catch (err) {
        console.error('DB save failed', err);
        triggerWarningBanner('Failed to save work order', 'See console for details.');
        return;
      }
    })();
  }

  async function sendToDurant() {
    if (!isDurantReport) return;
    if (!ensureRequired('save', 'sending the Durant Report')) return;
    if (!wo.customerId || !String(wo.productCategory || '').trim()) {
      triggerWarningBanner('Complete the client and device information first');
      return;
    }
    const recipient = window.prompt('Durant Media email address', '');
    if (!recipient?.trim()) return;
    try {
      const api: any = (window as any).api;
      let saved: any = null;
      const next = { ...wo, workOrderType: 'durantReport', updatedAt: new Date().toISOString() };
      if (Number(wo.id || 0) > 0) saved = await api.dbUpdate('workOrders', wo.id, next);
      else saved = await (api.addWorkOrder ? api.addWorkOrder(next) : api.dbAdd('workOrders', next));
      const record = saved || next;
      if (saved?.id) setWo(current => ({ ...current, id: Number(saved.id), workOrderType: 'durantReport' }));

      const customers = await api.findCustomers?.({ id: wo.customerId }).catch(() => []);
      const customer = Array.isArray(customers) ? customers[0] : null;
      const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(' ').trim() || customerSummary.name || 'Client';
      const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));
      const invoice = `GB${String(record.id || 0).padStart(7, '0')}`;
      const itemRows = wo.items.length ? wo.items.map(item => `<tr><td>${escape(item.repair || item.device)}</td><td>${escape(item.note || '')}</td></tr>`).join('') : '<tr><td colspan="2">No line items entered</td></tr>';
      const html = `<div style="font-family:Arial,sans-serif;color:#18181b;max-width:760px;margin:auto"><h1 style="color:#7e22ce">Durant Report</h1><p><strong>GadgetBoy work order:</strong> ${escape(invoice)}</p><table style="width:100%;border-collapse:collapse"><tr><td><strong>Client</strong></td><td>${escape(customerName)}</td></tr><tr><td><strong>Phone</strong></td><td>${escape(customer?.phone || customerSummary.phone)}</td></tr><tr><td><strong>Equipment</strong></td><td>${escape(wo.productDescription)}</td></tr><tr><td><strong>Category</strong></td><td>${escape(wo.productCategory)}</td></tr><tr><td><strong>Model</strong></td><td>${escape(wo.model)}</td></tr><tr><td><strong>Serial</strong></td><td>${escape(wo.serial)}</td></tr><tr><td><strong>Reported issue</strong></td><td>${escape(wo.problemInfo)}</td></tr><tr><td><strong>Assigned technician</strong></td><td>${escape(wo.assignedTo)}</td></tr></table><h2>Services / findings</h2><table style="width:100%;border-collapse:collapse" border="1" cellpadding="8"><tr><th>Item</th><th>Notes</th></tr>${itemRows}</table><h2>Internal notes supplied for review</h2><p style="white-space:pre-wrap">${escape(wo.internalNotes)}</p></div>`;
      const result = await api.emailSendReportHtml?.({
        to: recipient.trim(),
        subject: `Durant Report ${invoice} - ${wo.productDescription || wo.productCategory}`,
        bodyText: `Durant Report ${invoice}\nClient: ${customerName}\nEquipment: ${wo.productDescription}\nIssue: ${wo.problemInfo}`,
        html,
      });
      if (result?.ok === false) throw new Error(result.error || 'Email failed');
      setSavedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
      triggerWarningBanner('Durant Report sent', `Sent ${invoice} to ${recipient.trim()}.`);
    } catch (error: any) {
      console.error('send Durant Report failed', error);
      triggerWarningBanner('Durant Report was not sent', error?.message || 'Check email settings and try again.');
    }
  }
  function onCancel() {
    if (!isEditingExisting && !hasMeaningfulInput) {
      try {
        const api = (window as any).api;
        if (api?.closeSelfWindow) api.closeSelfWindow({ focusMain: true });
        else window.close();
      } catch { try { window.close(); } catch {} }
      return;
    }
    if (!ensureRequired('close', 'closing this work order window')) return;
    try {
      const api = (window as any).api;
      if (api?.closeSelfWindow) api.closeSelfWindow({ focusMain: true });
      else window.close();
    } catch { try { window.close(); } catch {} }
  }

  // Removed local onNewItemClick; ItemsTable owns New Item adding via picker

  const workOrderFull = useMemo<WorkOrderFull>(() => {
    const items = wo.items.map(row => ({
      ...row,
      id: row.id,
      status: row.status as any || 'pending',
      description: row.repair,
      qty: workOrderItemQuantity(row),
      unitPrice: (row.parts || 0) + (row.labor || 0),
      parts: row.parts,
      labor: row.labor,
    })) as any;
    return { ...wo, items } as unknown as WorkOrderFull;
  }, [wo]);

  // For the Payment panel + checkout, treat the linked retail sale as additional balance due.
  // This is UI-only: we do NOT roll retail dollars into the persisted Work Order totals.
  const paymentWorkOrder = useMemo<WorkOrderFull>(() => {
    const base: any = workOrderFull as any;
    const baseTotals = (base as any).totals || { subTotal: 0, tax: 0, total: 0, remaining: 0 };
    if (!addonSale) return base as WorkOrderFull;

    const sale: any = addonSale as any;
    const computed = (() => {
      const t = sale?.totals;
      const pc = Number(sale?.partCosts ?? 0) || 0;
      if (t && typeof t === 'object' && Number.isFinite(pc) && pc > 0) return { partCosts: pc, totals: t };
      const items = Array.isArray(sale?.items) ? (sale.items as SaleItemRow[]) : [];
      const taxRate = Number(sale?.taxRate || 0) || 0;
      const discount = Number(sale?.discount || 0) || 0;
      const amountPaid = Number(sale?.amountPaid || 0) || 0;
      return computeAddonSaleTotals({ items, taxRate, discount, amountPaid });
    })();

    const salePartCosts = round2(Number(computed?.partCosts || 0) || 0);
    const saleTotals = computed?.totals;
    const combinedPartCosts = round2((Number(base.partCosts || 0) || 0) + salePartCosts);

    const combinedTotals = {
      ...baseTotals,
      subTotal: round2((Number(baseTotals.subTotal || 0) || 0) + (Number(saleTotals?.subTotal || 0) || 0)),
      tax: round2((Number(baseTotals.tax || 0) || 0) + (Number(saleTotals?.tax || 0) || 0)),
      total: round2((Number(baseTotals.total || 0) || 0) + (Number(saleTotals?.total || 0) || 0)),
      remaining: round2((Number(baseTotals.remaining || 0) || 0) + (Number(saleTotals?.remaining || 0) || 0)),
    };

    return { ...base, partCosts: combinedPartCosts, totals: combinedTotals } as WorkOrderFull;
  }, [workOrderFull, addonSale]);

  const readonlyAddonRows = useMemo<WorkOrderItemRow[]>(() => {
    const sale: any = addonSale as any;
    const list: SaleItemRow[] = Array.isArray(sale?.items) ? (sale.items as SaleItemRow[]) : [];
    if (!list.length) return [];

    return list.map((row, idx) => {
      const isConsult = isConsultationSaleItem(row);
      const units = addonSaleUnits(row);
      const lineTotal = round2(addonSaleLineTotal(row));
      const baseDesc = String(row?.description || 'Item').trim();
      const showUnits = Number.isFinite(units) && units > 0 && Math.abs(units - 1) > 0.0001;
      const suffix = showUnits ? (isConsult ? ` (${units} hrs)` : ` (x${units})`) : '';
      return {
        id: `addon-${String((row as any)?.id || idx)}`,
        device: 'Retail',
        repairCategory: String((row as any)?.category || 'Retail'),
        repair: `${baseDesc}${suffix}`.trim(),
        parts: lineTotal,
        labor: 0,
        status: 'done',
        note: sale?.id ? `Sale #${sale.id}` : undefined,
      };
    });
  }, [addonSale]);

  const handleSidebarChange = useCallback((patch: Partial<WorkOrderFull>) => {
    setWo(w => ({ ...w, ...patch, items: w.items }));
  }, []);

  // Stable ref so handleSidebarForceSave doesn't change on every render
  const workOrderFullRef = useRef<WorkOrderFull>(workOrderFull);
  useEffect(() => { workOrderFullRef.current = workOrderFull; }, [workOrderFull]);

  // Called by the sidebar "Print customer receipt" button when the work order
  // hasn't been persisted yet (id=0). Saves immediately so the receipt can
  // embed a real QR-code status URL.
  const handleSidebarForceSave = useCallback(async (): Promise<number> => {
    const current = workOrderFullRef.current as any;
    if (!String(current?.assignedTo ?? '').trim()) {
      setValidationActive(true);
      triggerWarningBanner('Assign a technician before saving', 'A work order cannot be saved until a technician is assigned.');
      return 0;
    }
    const existingId = Number(current?.id || 0) || 0;
    if (existingId > 0) return existingId; // already saved — nothing to do
    const api: any = (window as any).api;
    if (typeof api.addWorkOrder !== 'function') return 0;
    try {
      const added = await createWorkOrderOnce(current);
      if (added?.id) {
        const newId = Number(added.id) || 0;
        persistedIdRef.current = newId;
        woRef.current = { ...woRef.current, ...added, id: newId };
        // Sync React state so the autosave takes the UPDATE path, not CREATE again
        setWo(w => ({ ...w, id: newId }));
        return newId;
      }
    } catch (e) { console.error('Force-save before receipt failed', e); }
    return 0;
  }, [createWorkOrderOnce]); // stable — reads latest workOrder from ref

  const handleFormChange = useCallback((patch: Partial<WorkOrderFull>) => {
    setWo(w => ({ ...w, ...patch, items: w.items }));
  }, []);

  const handleItemsChange = useCallback((items: WorkOrderItemRow[]) => {
    setWo(w => ({ ...w, items }));
  }, []);

  const handleItemsCommit = useCallback(async (items: WorkOrderItemRow[]) => {
    const current = workOrderFullRef.current as any;
    const id = Number(current?.id || 0) || 0;
    if (!String(current?.assignedTo ?? '').trim()) {
      setValidationActive(true);
      triggerWarningBanner('Assign a technician before saving this item', 'The work order cannot be persisted until a technician is assigned.');
      throw new Error('Assigned technician is required.');
    }
    if (!id) {
      triggerWarningBanner('Save the work order first', 'Save the work order to create its invoice number, then save the line-item changes again.');
      throw new Error('Work order must be saved before committing line-item changes.');
    }
    const amounts = calculateWorkOrderItemAmounts(
      items,
      Number(current.discount || 0),
      Number(current.taxRate || 0),
      Number(current.amountPaid || 0),
    );
    const payload = { ...current, ...amounts, id, items, updatedAt: new Date().toISOString() };
    const api: any = (window as any).api || {};
    const saved = typeof api.dbUpdate === 'function'
      ? await api.dbUpdate('workOrders', id, payload)
      : await api.update?.('workOrders', payload);
    if (!saved) throw new Error('The work-order line item was not saved.');
    setWo(previous => ({ ...previous, ...amounts, items, updatedAt: saved.updatedAt || payload.updatedAt }));
    setSavedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }));
    try { window.opener?.postMessage({ type: 'workorders:changed', id }, '*'); } catch {}
  }, []);

  const handleIntakeChange = useCallback((patch: Partial<WorkOrderFull>) => {
    setWo(w => ({ ...w, ...patch, items: w.items }));
  }, []);

  useEffect(() => {
    const customerId = Number(wo.customerId || 0);
    if (!customerId) return;
    let active = true;
    (async () => {
      try {
        const list = await (window as any).api?.findCustomers?.({ id: customerId });
        const customer = Array.isArray(list) ? list[0] : null;
        if (!active || !customer) return;
        const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim()
          || String(customer.name || customer.email || '').trim();
        const phone = String(customer.phone || '').trim();
        setCustomerSummary({ name, phone });
        setWo(current => {
          if (Number(current.customerId || 0) !== customerId) return current;
          if (String((current as any).customerName || '') === name && String((current as any).customerPhone || '') === phone) return current;
          return { ...current, customerName: name, customerPhone: phone };
        });
      } catch {}
    })();
    return () => { active = false; };
  }, [wo.customerId]);

  const handlePaymentChange = useCallback((patch: Partial<WorkOrderFull>) => {
    setWo(w => ({ ...w, ...patch, items: w.items }));
  }, []);

  async function handleAddProduct() {
    try {
      const api: any = (window as any).api;
      const workOrderId = Number((wo as any).id || 0) || 0;
      const customerId = Number((wo as any).customerId || 0) || 0;
      if (!customerId) {
        triggerWarningBanner('Customer is missing', 'Select a customer, then click Add Product again.');
        return;
      }
      if (!workOrderId) {
        triggerWarningBanner('Save work order first', 'Wait for the Work Order to get an invoice #, then try again.');
        return;
      }

      if (typeof api?.pickSaleProduct !== 'function') {
        triggerWarningBanner('Product picker unavailable', 'This build is missing the sale product picker IPC bridge.');
        return;
      }

      const picked = await api.pickSaleProduct();
      if (!picked) return; // cancelled

      const rows: SaleItemRow[] = (Array.isArray(picked) ? picked : [picked]).map((product: any) => ({
        id: crypto.randomUUID(),
        description: String(product.itemDescription || product.title || product.name || 'Item'),
        qty: Number(product.quantity ?? 1) || 1,
        price: Number(product.price ?? 0) || 0,
        consultationHours: typeof product.consultationHours === 'number' ? product.consultationHours : undefined,
        internalCost: typeof product.internalCost === 'number' ? product.internalCost : undefined,
        condition: product.condition || 'New',
        inStock: product.inStock == null ? true : !!product.inStock,
        productUrl: product.productUrl || product.url || product.link || '',
        category: product.category,
        distributor: product.distributor || '',
        inventoryProductId: typeof product.inventoryProductId === 'number' ? product.inventoryProductId : undefined,
      }));

      // Resolve customer info for the Sale record.
      let customerName = customerSummary.name || String((wo as any).customerName || '').trim();
      let customerPhone = customerSummary.phone || String((wo as any).customerPhone || '').trim();
      try {
        if (customerId && api?.findCustomers) {
          const list = await api.findCustomers({ id: customerId });
          const c = Array.isArray(list) && list.length ? list[0] : null;
          if (c) {
            const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
            customerName = full || customerName;
            customerPhone = c.phone || customerPhone;
          }
        }
      } catch {}

      // Load existing add-on sale if one is already linked.
      const existingSaleId = Number((wo as any).addonSaleId || 0) || 0;
      let existingSale: any = null;
      if (existingSaleId && api?.dbGet) {
        try {
          const list = await api.dbGet('sales').catch(() => []);
          existingSale = Array.isArray(list) ? list.find((s: any) => Number(s?.id || 0) === existingSaleId) : null;
        } catch {}
      }

      const existingItems: SaleItemRow[] = Array.isArray(existingSale?.items) ? (existingSale.items as SaleItemRow[]) : [];
      const nextItems = [...existingItems, ...rows].slice(0, ADDON_SALE_MAX_ITEMS);

      const nowIso = new Date().toISOString();
      const existingTaxRate = Number(existingSale?.taxRate || 0) || 0;
      const woTaxRate = Number((wo as any).taxRate || 0) || 0;
      const taxRate = existingTaxRate > 0 ? existingTaxRate : (woTaxRate > 0 ? woTaxRate : 8);
      const discount = Number(existingSale?.discount || 0) || 0;
      const amountPaid = Number(existingSale?.amountPaid || 0) || 0;
      const { partCosts, laborCost, totals } = computeAddonSaleTotals({ items: nextItems, taxRate, discount, amountPaid });

      const first = nextItems[0];

      const baseRecord: any = {
        ...(existingSale || {}),
        customerId,
        customerName,
        customerPhone,
        // multi-item list
        items: nextItems,
        // align with shared panels + tables
        status: (existingSale?.status || (totals.remaining <= 0.009 ? 'closed' : 'open')),
        assignedTo: (wo as any).assignedTo ?? existingSale?.assignedTo ?? null,
        checkInAt: (existingSale?.checkInAt || nowIso),
        createdAt: (existingSale?.createdAt || nowIso),
        updatedAt: nowIso,
        inStock: existingSale?.inStock ?? true,
        // totals
        partCosts,
        laborCost,
        discount,
        taxRate,
        amountPaid,
        totals,
        total: totals.total,
        // legacy single-item mirror (kept for backward-compatible prints)
        itemDescription: first ? first.description : (existingSale?.itemDescription || ''),
        quantity: first ? addonSaleUnits(first) : (existingSale?.quantity || 1),
        price: first ? first.price : (existingSale?.price || 0),
        consultationHours: first && isConsultationSaleItem(first)
          ? Number((first as any).consultationHours ?? addonSaleUnits(first)) || undefined
          : (existingSale?.consultationHours || undefined),
      };

      let savedSale: any = null;
      if (existingSale?.id) {
        savedSale = await api.dbUpdate('sales', existingSale.id, { ...baseRecord, id: existingSale.id });
      } else {
        savedSale = await api.dbAdd('sales', baseRecord);
      }

      const newSaleId = Number(savedSale?.id || existingSale?.id || 0) || 0;
      if (newSaleId) {
        setWo(w => ({ ...w, addonSaleId: newSaleId }));
      }
      setAddonSale(savedSale || { ...baseRecord, id: newSaleId });
      triggerWarningBanner('Product added', newSaleId ? `Attached to Sale #${newSaleId}.` : undefined);
    } catch (e) {
      console.error('Add Product failed', e);
      triggerWarningBanner('Failed to add product', 'See console for details.');
    }
  }

  async function handleRemoveRetailAddonRow(row: WorkOrderItemRow) {
    try {
      const api: any = (window as any).api;
      const addonSaleId = Number((wo as any).addonSaleId || 0) || 0;
      if (!addonSaleId) {
        triggerWarningBanner('No retail sale linked', 'There is no add-on Sale attached to this work order.');
        return;
      }
      if (!api?.dbGet || !api?.dbUpdate) {
        triggerWarningBanner('Database unavailable', 'This build is missing the dbGet/dbUpdate bridge methods.');
        return;
      }

      let saleRecord: any = null;
      if (addonSale && Number((addonSale as any)?.id || 0) === addonSaleId) {
        saleRecord = addonSale;
      } else {
        const list = await api.dbGet('sales').catch(() => []);
        saleRecord = Array.isArray(list) ? list.find((s: any) => Number(s?.id || 0) === addonSaleId) : null;
      }
      if (!saleRecord) {
        triggerWarningBanner('Retail sale not found', `Could not load Sale #${addonSaleId}.`);
        return;
      }

      const token = String((row as any)?.id || '').trim();
      const rawId = token.startsWith('addon-') ? token.slice('addon-'.length) : token;
      const prevItems: SaleItemRow[] = Array.isArray(saleRecord?.items) ? (saleRecord.items as SaleItemRow[]) : [];
      if (!prevItems.length) {
        triggerWarningBanner('Retail sale is empty');
        return;
      }

      // Prefer stable removal by item.id, but support legacy rows without item ids (fallback to index).
      let nextItems: SaleItemRow[] = prevItems.filter((it: any) => {
        try {
          const itId = it?.id;
          if (itId != null && String(itId) === rawId) return false;
        } catch {}
        return true;
      });

      if (nextItems.length === prevItems.length) {
        const idx = Number(rawId);
        if (Number.isInteger(idx) && idx >= 0 && idx < prevItems.length) {
          nextItems = prevItems.filter((_it, i) => i !== idx);
        }
      }

      if (nextItems.length === prevItems.length) {
        triggerWarningBanner('Item not found', 'Could not match this row to a Sale item.');
        return;
      }

      const taxRate = Number(saleRecord?.taxRate || 0) || (Number((wo as any).taxRate || 0) || 0);
      const discount = Number(saleRecord?.discount || 0) || 0;
      const amountPaid = Number(saleRecord?.amountPaid || 0) || 0;
      const computed = computeAddonSaleTotals({ items: nextItems, taxRate, discount, amountPaid });

      const first = nextItems[0];
      const prevStatus = String(saleRecord?.status || 'open');
      const status = prevStatus === 'closed'
        ? 'closed'
        : ((computed.totals?.remaining || 0) <= 0.009 ? 'closed' : 'open');

      const nowIso = new Date().toISOString();
      const nextSale: any = {
        ...(saleRecord || {}),
        id: addonSaleId,
        updatedAt: nowIso,
        items: nextItems,
        status,
        // totals
        partCosts: computed.partCosts,
        laborCost: computed.laborCost,
        totals: computed.totals,
        total: computed.totals.total,
        taxRate,
        discount,
        amountPaid,
        // legacy single-item mirror (kept for backward-compatible prints)
        itemDescription: first ? first.description : '',
        quantity: first ? addonSaleUnits(first) : 1,
        price: first ? first.price : 0,
        consultationHours: first && isConsultationSaleItem(first)
          ? Number((first as any).consultationHours ?? addonSaleUnits(first)) || undefined
          : undefined,
      };

      const savedSale = await api.dbUpdate('sales', addonSaleId, { ...nextSale, id: addonSaleId });
      setAddonSale(savedSale || nextSale);
      triggerWarningBanner(
        'Retail item removed',
        nextItems.length ? `Remaining retail items: ${nextItems.length}` : 'No retail items remaining.'
      );
    } catch (e) {
      console.error('handleRemoveRetailAddonRow failed', e);
      triggerWarningBanner('Failed to remove retail item', 'See console for details.');
    }
  }

  useEffect(() => {
    handleCheckoutRef.current = async () => {
      if (!ensureRequired('checkout', 'checking out')) return;
      if (!isCustomBuild && (!wo.productCategory || !wo.productCategory.trim())) {
        triggerWarningBanner('Device category is missing', 'Select a device category, then click Checkout again.');
        return;
      }
      if (!wo.customerId) {
        triggerWarningBanner('Customer is missing', 'Select a customer, then click Checkout again.');
        return;
      }
      try {
        const api: any = (window as any).api;
        const woRemaining = Number(wo.totals?.remaining || 0) || 0;

        // If a retail add-on sale is linked, include its remaining balance in the checkout due.
        const addonSaleId = Number((wo as any).addonSaleId || 0) || 0;
        let addonSaleRecord: any = null;
        if (addonSaleId) {
          if (addonSale && Number((addonSale as any)?.id || 0) === addonSaleId) {
            addonSaleRecord = addonSale;
          } else if (api?.dbGet) {
            try {
              const list = await api.dbGet('sales').catch(() => []);
              addonSaleRecord = Array.isArray(list) ? list.find((s: any) => Number(s?.id || 0) === addonSaleId) : null;
            } catch {}
          }
        }

        const addonSaleTotals = (() => {
          if (!addonSaleRecord) return null;
          const t = (addonSaleRecord as any)?.totals;
          if (t && typeof t === 'object') return t;
          const items = Array.isArray((addonSaleRecord as any)?.items) ? ((addonSaleRecord as any).items as SaleItemRow[]) : [];
          const taxRate = Number((addonSaleRecord as any)?.taxRate || 0) || 0;
          const discount = Number((addonSaleRecord as any)?.discount || 0) || 0;
          const amountPaid = Number((addonSaleRecord as any)?.amountPaid || 0) || 0;
          return computeAddonSaleTotals({ items, taxRate, discount, amountPaid }).totals;
        })();

        const addonRemaining = Number(addonSaleTotals?.remaining || 0) || 0;
        const amountDue = round2(woRemaining + addonRemaining);

        const checkoutPayload: any = {
          amountDue,
          title: isCustomBuild ? 'Custom Build Checkout' : 'Work Order Checkout',
        };

        // Always show the parts/labor split.
        // If a retail add-on sale is linked, treat its remaining balance as Parts for checkout allocation.
        {
          const remainingBuckets = remainingWorkOrderPaymentBuckets(wo);
          const woPartsDue = remainingBuckets.partsDue;
          const woLaborDue = remainingBuckets.laborDue;

          checkoutPayload.partsDue = round2(woPartsDue + Math.max(0, addonRemaining));
          checkoutPayload.laborDue = round2(woLaborDue);
        }

        const result = await api.openCheckout(checkoutPayload);
        if (!result) return;

        const nowIso = new Date().toISOString();

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

        const woPaymentAdds: any[] = [];
        const addonPaymentAdds: any[] = [];

        const partsDue = Number(checkoutPayload.partsDue || 0) || 0;
        const laborDue = Number(checkoutPayload.laborDue || 0) || 0;
        let remainingCombinedParts = partsDue;
        let remainingSaleParts = (addonSaleRecord && addonRemaining > 0.009) ? addonRemaining : 0;
        let remainingWoParts = Math.max(0, round2(partsDue - remainingSaleParts));
        let remainingWoLabor = laborDue;

        normalizedLines.forEach((p: any) => {
          const pt = String(p?.paymentType || '');
          const isCash = pt.toLowerCase().includes('cash');
          const lineApplied = round2(Number(p?.applied || 0) || 0);
          if (!(lineApplied > 0)) return;

          const tendered = Number(p?.tendered ?? p?.amount ?? lineApplied);
          const change = Number(p?.change ?? 0);

          // Split this payment line into Parts vs Labor based on the checkout selection.
          let lineParts = 0;
          let lineLabor = 0;
          if (result?.payFor === 'parts') {
            lineParts = lineApplied;
            lineLabor = 0;
          } else if (result?.payFor === 'labor') {
            lineParts = 0;
            lineLabor = lineApplied;
          } else if (result?.payFor) {
            const pAmt = round2(Math.min(lineApplied, Math.max(0, remainingCombinedParts)));
            const lAmt = round2(Math.max(0, lineApplied - pAmt));
            remainingCombinedParts = round2(Math.max(0, remainingCombinedParts - pAmt));
            lineParts = pAmt;
            lineLabor = lAmt;
          } else {
            // No split selection available — treat as a Work Order payment.
            lineParts = 0;
            lineLabor = lineApplied;
          }

          // Allocate Parts: retail add-on Sale first, then Work Order parts.
          const partsToSale = remainingSaleParts > 0
            ? round2(Math.min(lineParts, Math.max(0, remainingSaleParts)))
            : 0;
          remainingSaleParts = round2(Math.max(0, remainingSaleParts - partsToSale));

          let partsToWo = round2(Math.max(0, lineParts - partsToSale));
          const cappedWoParts = round2(Math.min(partsToWo, Math.max(0, remainingWoParts)));
          remainingWoParts = round2(Math.max(0, remainingWoParts - cappedWoParts));
          partsToWo = cappedWoParts;

          let laborToWo = round2(Math.max(0, lineLabor));
          const cappedWoLabor = round2(Math.min(laborToWo, Math.max(0, remainingWoLabor)));
          remainingWoLabor = round2(Math.max(0, remainingWoLabor - cappedWoLabor));
          laborToWo = cappedWoLabor;

          const appliedToWo = round2(partsToWo + laborToWo);
          const appliedToAddon = round2(partsToSale);
          const primary = appliedToWo > 0 ? 'workorder' : (appliedToAddon > 0 ? 'sale' : null);

          if (appliedToWo > 0) {
            const entry: any = {
              amount: isCash
                ? (primary === 'workorder' ? (Number.isFinite(tendered) ? tendered : appliedToWo) : 0)
                : appliedToWo,
              applied: appliedToWo,
              paymentType: pt,
              at: nowIso,
            };
            if (isCash && primary === 'workorder') entry.change = Number.isFinite(change) ? Math.max(0, change) : 0;

            if (result?.payFor) {
              entry.payFor = result.payFor;
              entry.appliedParts = partsToWo;
              entry.appliedLabor = laborToWo;
            }

            woPaymentAdds.push(entry);
          }

          if (appliedToAddon > 0) {
            const entry: any = {
              amount: isCash
                ? (primary === 'sale' ? (Number.isFinite(tendered) ? tendered : appliedToAddon) : 0)
                : appliedToAddon,
              applied: appliedToAddon,
              paymentType: pt,
              at: nowIso,
            };
            if (isCash && primary === 'sale') entry.change = Number.isFinite(change) ? Math.max(0, change) : 0;
            addonPaymentAdds.push(entry);
          }
        });

        const appliedToWorkOrder = round2(woPaymentAdds.reduce((sum: number, p: any) => sum + (Number(p?.applied) || 0), 0));
        const appliedToAddonSale = round2(addonPaymentAdds.reduce((sum: number, p: any) => sum + (Number(p?.applied) || 0), 0));

        let newAmountPaid = round2((wo.amountPaid || 0) + appliedToWorkOrder);
        if (!Number.isFinite(newAmountPaid) || newAmountPaid < 0) newAmountPaid = wo.amountPaid || 0;

        const updatedTotals = computeTotals({
          laborCost: Number(wo.laborCost || 0) || 0,
          partCosts: Number(wo.partCosts || 0) || 0,
          discount: Number(wo.discount || 0) || 0,
          taxRate: Number(wo.taxRate || 0) || 0,
          amountPaid: newAmountPaid,
        });

        let updatedItems = wo.items;
        let status = wo.status;
        let checkoutDate = wo.checkoutDate;
        const hadOutstandingBalance = woRemaining > 0.009;
        if (shouldCloseWorkOrderAfterPayment(wo, Number(updatedTotals?.remaining ?? NaN), result)) {
          status = 'closed';
          if (!checkoutDate || (appliedToWorkOrder > 0 && hadOutstandingBalance)) {
            checkoutDate = nowIso;
          }
          updatedItems = wo.items.map(it => ({ ...it, status: 'done' }));
        }

        const prevPayments = buildNormalizedCheckoutPayments(wo as any);
        const payments = appliedToWorkOrder > 0 ? [...prevPayments, ...woPaymentAdds] : prevPayments;

        // Update the linked retail Sale record (if any) with its portion of the payment.
        let savedAddonSale: any = null;
        if (addonSaleRecord && addonSaleId && api?.dbUpdate && (appliedToAddonSale > 0 || result.markClosed)) {
          try {
            const prevSalePayments = buildNormalizedCheckoutPayments(addonSaleRecord as any);
            const salePayments = appliedToAddonSale > 0 ? [...prevSalePayments, ...addonPaymentAdds] : prevSalePayments;

            const existingSaleAmountPaid = Number((addonSaleRecord as any)?.amountPaid || 0) || 0;
            const newSaleAmountPaid = round2(existingSaleAmountPaid + appliedToAddonSale);

            const items = Array.isArray((addonSaleRecord as any)?.items) ? ((addonSaleRecord as any).items as SaleItemRow[]) : [];
            const taxRate = Number((addonSaleRecord as any)?.taxRate || 0) || 0;
            const discount = Number((addonSaleRecord as any)?.discount || 0) || 0;
            const computed = computeAddonSaleTotals({ items, taxRate, discount, amountPaid: newSaleAmountPaid });

            let saleStatus = String((addonSaleRecord as any)?.status || 'open');
            let saleCheckoutDate = ((addonSaleRecord as any)?.checkoutDate as string | null) || null;
            const hadSaleOutstanding = addonRemaining > 0.009;
            if (result.markClosed || (computed.totals?.remaining || 0) <= 0) {
              saleStatus = 'closed';
              if (!saleCheckoutDate || (appliedToAddonSale > 0 && hadSaleOutstanding)) {
                saleCheckoutDate = nowIso;
              }
            }

            const nextSale: any = {
              ...(addonSaleRecord as any),
              updatedAt: nowIso,
              amountPaid: newSaleAmountPaid,
              paymentType: result.paymentType,
              payments: salePayments,
              status: saleStatus,
              checkoutDate: saleCheckoutDate,
              partCosts: computed.partCosts,
              laborCost: computed.laborCost,
              totals: computed.totals,
              total: computed.totals.total,
            };

            savedAddonSale = await api.dbUpdate('sales', addonSaleId, { ...nextSale, id: addonSaleId });
            setAddonSale(savedAddonSale || nextSale);
          } catch (e) {
            console.error('Failed updating add-on sale payment', e);
          }
        }

        const nextWo = {
          ...wo,
          amountPaid: newAmountPaid,
          paymentType: result.paymentType,
          payments,
          status,
          checkoutDate,
          items: updatedItems,
          totals: updatedTotals,
          ...(shouldCloseWorkOrderAfterPayment(wo, Number(updatedTotals?.remaining ?? NaN), result)
            ? { workflowStage: 'Completed', workflowUpdatedAt: nowIso }
            : {}),
        };

        setWo(() => nextWo);

        // Persist the work order. If it's brand-new (id=0) we create it here so the
        // receipt can include a real QR-code URL. If already saved, update it.
        let effectiveId = Number((wo as any).id || 0) || 0;
        let workOrderPersisted = false;
        if (effectiveId > 0) {
          try {
            await api.update('workOrders', { ...nextWo });
            workOrderPersisted = true;
          } catch (e) {
            console.error('Failed persisting checkout update', e);
          }
        } else {
          // Brand-new work order — save it now so we have a real ID for the receipt QR
          try {
            const added = typeof api.addWorkOrder === 'function'
              ? await api.addWorkOrder({ ...nextWo })
              : await api.dbAdd('workOrders', { ...nextWo });
            if (added?.id) {
              effectiveId = Number(added.id) || 0;
              workOrderPersisted = true;
              // Sync state so autosave won't create a duplicate
              setWo(w => ({ ...w, id: effectiveId }));
            }
          } catch (e) {
            console.error('Failed creating work order on checkout', e);
          }
        }

        const initialCheckoutReleaseForm = workOrderPersisted && effectiveId > 0 && appliedToWorkOrder > 0 && prevPayments.length === 0;
        if (initialCheckoutReleaseForm) {
          try {
            await api?.openReleaseForm?.({ workOrderId: effectiveId, autoPrint: true, silent: true, autoCloseMs: 1800 });
          } catch (releaseFormError) {
            console.warn('Initial release form could not be opened for printing.', releaseFormError);
          }
        }

        if (workOrderPersisted && effectiveId > 0 && appliedToWorkOrder > 0) {
          try {
            const customerRows = wo.customerId && api?.findCustomers ? await api.findCustomers({ id: wo.customerId }) : [];
            const customer = Array.isArray(customerRows) ? customerRows[0] : null;
            const statusResult = api?.qrGetStatusUrl ? await api.qrGetStatusUrl('repair', effectiveId).catch(() => null) : null;
            const grossLaborBeforePayment = round2(Math.max(0, Number(wo.laborCost || 0) - Number(wo.discount || 0)));
            const priorLaborPaid = round2(Math.max(0, grossLaborBeforePayment - Number(checkoutPayload.laborDue || 0)));
            const appliedParts = round2(woPaymentAdds.reduce((sum: number, payment: any) => sum + Math.max(0, Number(payment?.appliedParts || 0)), 0));
            const appliedLabor = round2(woPaymentAdds.reduce((sum: number, payment: any) => sum + Math.max(0, Number(payment?.appliedLabor || 0)), 0));
            const isFinalPayment = Number(updatedTotals?.remaining || 0) <= 0.009;
            await queueInitialPaymentAcknowledgment({
              recordType: 'repair',
              record: { ...nextWo, id: effectiveId, orderedPart: Boolean((nextWo as any).partsOrderDate || (nextWo as any).partsOrderUrl || updatedItems.some((item: any) => item?.inStock === false)) },
              payment: { applied: appliedToWorkOrder, appliedParts, appliedLabor, priorLaborPaid, isFinalPayment },
              customer,
              statusUrl: statusResult?.url,
            });
          } catch (emailError) { console.warn('Automatic work-order email was not queued.', emailError); }
        }

        const partsPaymentApplied = woPaymentAdds.some((payment: any) => Number(payment?.appliedParts || 0) > 0.009);
        if (workOrderPersisted && effectiveId > 0 && shouldConsumeWorkOrderInventory({ partsPaymentApplied, markClosed: result.markClosed, status })) {
          try {
            const inventoryResult = await consumeInStockInventory(api, 'workOrder', effectiveId, updatedItems, {
              allowShortfall: true,
              checkoutDate,
              repairContext: {
                deviceCategory: wo.productCategory,
                deviceName: wo.productDescription,
                deviceModel: (wo as any).model,
              },
            });
            if (inventoryResult.shortfalls.length) {
              triggerWarningBanner('Inventory reached zero', 'One or more repair parts need restocking.');
            }
          } catch (inventoryError) {
            console.error('Work-order inventory update failed', inventoryError);
            triggerWarningBanner('Inventory update needs attention', 'The checkout was saved, but inventory could not be adjusted.');
          }
        }

        if (result.printReceipt) {
          try {
            let customerName = (wo as any).customerName || '';
            let customerPhone = (wo as any).customerPhone || '';
            let customerPhoneAlt = '';
            let customerEmail = (wo as any).customerEmail || '';
            try {
              const id = (wo as any).customerId;
              if (id && (window as any).api?.findCustomers) {
                const list = await (window as any).api.findCustomers({ id });
                const c = Array.isArray(list) && list.length ? list[0] : null;
                if (c) {
                  const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
                  customerName = full || customerName;
                  customerPhone = c.phone || customerPhone;
                  customerPhoneAlt = c.phoneAlt || '';
                  customerEmail = c.email || customerEmail;
                }
              }
            } catch {}

            let addonSale: any = null;
            try {
              const addonSaleId = Number((nextWo as any).addonSaleId || (wo as any).addonSaleId || 0) || 0;
              if (addonSaleId && (window as any).api?.dbGet) {
                const sales = await (window as any).api.dbGet('sales').catch(() => []);
                addonSale = Array.isArray(sales) ? sales.find((s: any) => Number(s?.id || 0) === addonSaleId) : null;
              }
            } catch {}

            const payload = {
              id: effectiveId || (wo as any).id,
              workOrderId: effectiveId || (wo as any).id,
              receiptType: 'repair',
              customerId: (wo as any).customerId,
              customerName,
              customerPhone,
              customerPhoneAlt,
              customerEmail,
              paymentType: (nextWo as any).paymentType ?? (wo as any).paymentType,
              payments: (nextWo as any).payments ?? (wo as any).payments ?? [],
              addonSaleId: addonSale?.id ?? (nextWo as any).addonSaleId ?? (wo as any).addonSaleId ?? null,
              addonSale: addonSale || null,
              productCategory: wo.productCategory,
              productDescription: wo.productDescription,
              model: (wo as any).model,
              serial: (wo as any).serial,
              password: (nextWo as any).password ?? (wo as any).password ?? '',
              patternSequence: Array.isArray((nextWo as any).patternSequence)
                ? (nextWo as any).patternSequence
                : (Array.isArray((wo as any).patternSequence) ? (wo as any).patternSequence : []),
              problemInfo: wo.problemInfo,
              items: (nextWo as any).items || [],
              partCosts: (nextWo as any).partCosts,
              laborCost: (nextWo as any).laborCost,
              discount: (nextWo as any).discount,
              taxRate: (nextWo as any).taxRate,
              totals: (nextWo as any).totals,
              amountPaid: (nextWo as any).amountPaid,
            };
            if ((window as any).api?.openCustomerReceipt) {
              await (window as any).api.openCustomerReceipt({
                data: payload,
                autoPrint: true,
                silent: true,
                autoCloseMs: 900,
                show: false,
              });
            } else {
              const u = new URL(window.location.href);
              u.search = `?customerReceipt=${encodeURIComponent(JSON.stringify(payload))}`;
              window.open(u.toString(), '_blank');
            }
          } catch (e) { console.error('openCustomerReceipt failed', e); }
        }
        if (result.closeParent) {
          const delayMs = 0;
          setTimeout(() => {
            try {
              const api = (window as any).api;
              if (api?.closeSelfWindow) api.closeSelfWindow({ focusMain: true });
              else window.close();
            } catch { try { window.close(); } catch {} }
          }, delayMs);
        }
      } catch (e) {
        console.error('Checkout failed', e);
        alert('Checkout failed. See console.');
      }
    };
  });

  const handleCheckout = useCallback(() => {
    void checkoutSingleFlightRef.current?.();
  }, []);

  // (removed legacy printCustomerReceipt stub in favor of shared HTML builder)

  if (!loaded) {
    return <div className="p-4 text-zinc-200">Loading work order...</div>;
  }

  const saveDisabled = false;

  if ((payload as any)?.clientDropoff) return <ClientDropoffWindow />;

  return (
    <div className="gb-wo-window h-screen overflow-hidden p-3 bg-zinc-900 text-zinc-200">
      {clientUpdateOpen && Number((wo as any).id || 0) > 0 ? (
        <ClientUpdatePanel
          embedded
          recordType="repair"
          recordId={Number((wo as any).id)}
          onClose={() => setClientUpdateOpen(false)}
          onUpdated={saved => setWo(current => ({ ...current, ...saved, items: Array.isArray(saved?.items) ? saved.items : current.items }))}
        />
      ) : null}
      {validationActive && missingRequired.length > 0 ? (
        <div className="fixed inset-0 z-[1100] grid place-items-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-label="Complete required work-order details">
          <section className="w-full max-w-lg rounded-2xl border border-pink-500/60 bg-[#17171c] shadow-2xl">
            <header className="border-b border-zinc-700 bg-[#1d1d23] px-5 py-4">
              <h2 className="text-lg font-semibold text-zinc-100">Complete required work-order details</h2>
              <p className="mt-1 text-sm text-zinc-400">Finish these fields before {validationActionLabel || 'continuing'}.</p>
            </header>
            <div className="px-5 py-4">
              <p className="text-sm text-zinc-300">This form cannot continue until the applicable information below is recorded.</p>
              <ul className="mt-3 space-y-2">
                {missingRequired.map(key => <li key={key} className="rounded-lg border border-pink-500/40 bg-pink-950/35 px-3 py-2 text-sm text-pink-100">{REQUIRED_LABELS[key]}</li>)}
              </ul>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t border-zinc-700 bg-[#141418] px-5 py-4"><span className="text-xs text-zinc-400">Return to the form, complete these fields, then try again.</span><button type="button" className="shrink-0 rounded-lg bg-[#39ff14] px-4 py-2 text-sm font-bold text-black" onClick={() => setValidationActive(false)}>Review fields</button></footer>
          </section>
        </div>
      ) : null}
      {warningBanner && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[min(640px,calc(100%-48px))] transition-opacity duration-300 pointer-events-none ${warningBannerVisible ? 'opacity-100' : 'opacity-0'}`}>
          <div className="bg-amber-400 text-zinc-900 px-4 py-3 rounded shadow-lg border border-amber-300">
            <div className="text-sm font-semibold">{warningBanner.message}</div>
            {warningBanner.details ? <div className="text-xs mt-1 leading-snug opacity-80">{warningBanner.details}</div> : null}
          </div>
        </div>
      )}
      <div className="gb-wo-layout grid h-full" style={{ gridTemplateColumns: '220px 1fr 320px', columnGap: 12, rowGap: 8 }}>
        <WorkOrderSidebar
          workOrder={workOrderFull}
          onChange={handleSidebarChange}
          hideAssigned
          validationFlags={sidebarValidationFlags}
          onRequestForceSave={handleSidebarForceSave}
        />
        <div className="gb-wo-main-scroll flex flex-col gap-2 col-span-1 pb-16 min-h-0 overflow-auto">
          <div className="gb-wo-mobile-intake">
            <IntakePanel
              workOrder={workOrderFull}
              customerSummary={customerSummary}
              onChange={handleIntakeChange}
              onUpdateClient={() => setClientUpdateOpen(true)}
              updateClientDisabled={!Number((wo as any).id || 0)}
            />
          </div>
          <div className="gb-wo-top-card bg-zinc-900 border border-zinc-700 rounded p-2">
            <div className="gb-wo-top-row">
              <AssignedTechnicianField
                value={workOrderFull.assignedTo}
                invalid={!!sidebarValidationFlags?.assignedTo}
                onChange={assignedTo => handleSidebarChange({ assignedTo })}
              />
            </div>
            <div className="flex items-center justify-between mt-3">
              <div className="text-sm font-semibold text-zinc-200">Work Order Type</div>
              <div className="text-xs text-zinc-500">Switching types can clear fields</div>
            </div>
            <div className="gb-wo-type-grid mt-2">
              <button
                type="button"
                className={`gb-wo-type-button px-3 py-1.5 rounded border text-sm ${!isCustomBuild && !isDrone && !isDurantReport ? 'bg-neon-green text-zinc-900 border-transparent' : 'bg-zinc-800 border-zinc-700 text-zinc-200'}`}
                onClick={() => {
                  if (!isCustomBuild && !isDrone && !isDurantReport) return;
                  const hasData = Boolean((wo.items?.length || 0) > 0 || (wo.password || wo.model || wo.serial));
                  if (hasData && !confirm('Switch to Standard Work Order? This will clear custom-build-only fields and may clear some device fields.')) return;
                  setWo((w) => ({
                    ...w,
                    workOrderType: 'standard',
                    productCategory: w.productCategory || '',
                  }));
                }}
              >
                Standard
              </button>
              <button
                type="button"
                className={`gb-wo-type-button px-3 py-1.5 rounded border text-sm ${isCustomBuild ? 'bg-neon-green text-zinc-900 border-transparent' : 'bg-zinc-800 border-zinc-700 text-zinc-200'}`}
                onClick={() => {
                  if (isCustomBuild) return;
                  const hasData = Boolean((wo.items?.length || 0) > 0 || (wo.password || wo.model || wo.serial || wo.productCategory));
                  if (hasData && !confirm('Switch to Custom PC Build? This will clear device fields (password/model/serial/category).')) return;
                  setWo((w) => ({
                    ...w,
                    workOrderType: 'customBuild',
                    productCategory: 'Custom PC Build',
                    password: '',
                    model: '',
                    serial: '',
                    patternSequence: [] as any,
                  }));
                }}
              >
                Custom PC Build
              </button>
              <button
                type="button"
                className={`gb-wo-type-button px-3 py-1.5 rounded border text-sm ${isDrone ? 'bg-neon-green text-zinc-900 border-transparent' : 'bg-zinc-800 border-zinc-700 text-zinc-200'}`}
                onClick={() => {
                  if (isDrone) return;
                  const hasData = Boolean((wo.items?.length || 0) > 0 || (wo.password || wo.model || wo.serial || wo.productCategory));
                  if (hasData && !confirm('Switch to Drone? This will clear device fields (password/model/serial/category).')) return;
                  setWo((w) => ({
                    ...w,
                    workOrderType: 'drone',
                    productCategory: 'Drone',
                    password: '',
                    model: '',
                    serial: '',
                    patternSequence: [] as any,
                  }));
                }}
              >
                Drone
              </button>
              <button
                type="button"
                className={`gb-wo-type-button px-3 py-1.5 rounded border text-sm ${isDurantReport ? 'bg-purple-500 text-white border-purple-300' : 'bg-zinc-800 border-zinc-700 text-zinc-200'}`}
                onClick={() => {
                  if (isDurantReport) return;
                  setWo(current => ({ ...current, workOrderType: 'durantReport', productCategory: current.productCategory || 'AV / Sound Equipment' }));
                }}
              >
                Durant Report
              </button>
            </div>
          </div>

          <WorkOrderForm
            workOrder={workOrderFull}
            onChange={handleFormChange}
            validationFlags={formValidationFlags}
            mode={isCustomBuild ? 'customBuild' : 'standard'}
          />

          {isDrone && (
            <DroneChecklistPanel
              checklist={wo.droneChecklist ?? defaultDroneChecklist()}
              onChange={cl => setWo(w => ({ ...w, droneChecklist: cl }))}
            />
          )}

          <div className="rounded border border-zinc-700 bg-zinc-900 p-2">
            <div className="flex flex-wrap items-center gap-2"><button type="button" className="rounded border border-violet-400/70 bg-violet-500/15 px-3 py-1.5 text-sm font-semibold text-violet-100" onClick={() => setDiagnosticOpen(value => !value)}>Add Diagnostic</button>{wo.diagnosticSelection ? <><span className="text-sm text-zinc-200">{wo.diagnosticSelection.label} — ${Number(wo.diagnosticSelection.amount).toFixed(2)} minimum labor</span><button type="button" className="text-xs text-red-300" onClick={() => setWo(current => ({ ...current, diagnosticSelection: null }))}>Remove</button></> : <span className="text-xs text-zinc-500">Optional for every work order type</span>}</div>
            {diagnosticOpen ? <div className="mt-2 grid gap-2 sm:grid-cols-2">{diagnosticOptions.length ? diagnosticOptions.map(item => { const amount = Math.max(0, Number(item.laborCost || 0) + Number(item.partCost || 0)); return <button key={item.id} type="button" className="rounded border border-zinc-700 bg-zinc-800 p-2 text-left text-sm hover:border-violet-400" onClick={() => { setWo(current => ({ ...current, diagnosticSelection: { catalogId: item.id, label: item.title || item.repairCategory || 'Diagnostic', amount } })); setDiagnosticOpen(false); }}><strong className="block">{item.title || item.repairCategory}</strong><span className="text-zinc-400">${amount.toFixed(2)}</span></button>; }) : <div className="text-xs text-zinc-400">No repairs titled Diagnostic are configured.</div>}</div> : null}
            {isDurantReport ? <label className="mt-2 flex items-center gap-2 rounded border border-purple-500/40 bg-purple-950/20 p-2 text-sm font-semibold text-purple-100"><input type="checkbox" checked={!!wo.durantFullTransfer} onChange={event => setWo(current => ({ ...current, durantFullTransfer: event.target.checked }))} />Full Transfer to Durant Media</label> : null}
          </div>

          {isCustomBuild ? (
            <CustomBuildItemsTable
              items={wo.items}
              onChange={handleItemsChange}
              onAddProduct={handleAddProduct}
              addProductDisabled={!wo.customerId || !Number((wo as any).id || 0)}
              readonlyItems={readonlyAddonRows as any}
              onRemoveReadonlyItem={handleRemoveRetailAddonRow as any}
            />
          ) : (
            <ItemsTable
              items={wo.items}
              onChange={handleItemsChange}
              onCommit={handleItemsCommit}
              deviceCategory={String(wo.productCategory || '')}
              deviceName={String(wo.productDescription || '')}
              deviceModel={String((wo as any).model || '')}
              onAddProduct={handleAddProduct}
              addProductDisabled={!wo.customerId || !Number((wo as any).id || 0)}
              readonlyItems={readonlyAddonRows as any}
              onRemoveReadonlyItem={handleRemoveRetailAddonRow as any}
            />
          )}

          <DropoffAccessoriesPanel
            accessories={wo.dropoffAccessories ?? []}
            onChange={acc => setWo(w => ({ ...w, dropoffAccessories: acc }))}
          />
          {isDurantReport && (wo as any).cloudId ? <DurantProposalReview workOrderId={String((wo as any).cloudId)} onApproved={() => window.location.reload()} /> : null}
          <div className={`gb-wo-notes-expandable gb-wo-expandable ${notesExpanded ? 'is-expanded' : 'is-collapsed'}`}>
            <button type="button" className="gb-wo-notes-mobile-toggle" aria-expanded={notesExpanded} onClick={() => setNotesExpanded(value => !value)}><span>Internal notes</span><strong>{notesExpanded ? 'Collapse' : 'Expand'}</strong></button>
            <div className="gb-wo-expandable-body">
              <NotesPanel
                notes={wo.internalNotes || ''}
                log={wo.internalNotesLog || []}
                onChange={n => setWo(w => ({ ...w, internalNotes: n }))}
                onAdd={persistJournalNote}
              />
            </div>
          </div>
        </div>
        <div className="gb-wo-payment-scroll flex flex-col gap-3 min-h-0 overflow-auto">
          <div className="gb-wo-desktop-intake">
            <IntakePanel
              workOrder={workOrderFull}
              customerSummary={customerSummary}
              onChange={handleIntakeChange}
              onUpdateClient={() => setClientUpdateOpen(true)}
              updateClientDisabled={!Number((wo as any).id || 0)}
            />
          </div>
          <div className="bg-zinc-900 border border-zinc-700 rounded p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-zinc-200">Retail add-on</h4>
              {Number((wo as any).addonSaleId || 0) ? (
                <div className="text-[11px] text-zinc-500">Sale #{Number((wo as any).addonSaleId || 0)}</div>
              ) : (
                <div className="text-[11px] text-zinc-500">No sale linked</div>
              )}
            </div>
            {addonSale && Array.isArray((addonSale as any).items) && (addonSale as any).items.length > 0 ? (
              <div className="mt-2 text-xs text-zinc-400">
                Attached items: {(addonSale as any).items.length}
              </div>
            ) : null}
          </div>
          <PaymentPanel workOrder={paymentWorkOrder} onChange={handlePaymentChange} onCheckout={handleCheckout} checkoutBusy={checkoutBusy} />
        </div>
      </div>

      <div className="fixed bottom-4 left-4 right-3 flex items-center justify-between">
        <div className="text-xs text-zinc-500 min-h-[1.2rem]">Auto-save enabled</div>
        <div className="flex gap-2">
          {isDurantReport ? <button className="px-3 py-1.5 bg-purple-600 border border-purple-400 text-white rounded font-semibold" onClick={() => { void sendToDurant(); }}>Send to Durant</button> : null}
          <button className="px-3 py-1.5 bg-zinc-800 rounded" onClick={onCancel}>Cancel</button>
          <button
            className={`px-3 py-1.5 rounded font-semibold shadow focus:outline-none focus:ring-2 focus:ring-neon-green/70 active:scale-[0.98] transition ${saveDisabled ? 'bg-zinc-800 text-zinc-500' : 'bg-neon-green text-zinc-900 hover:brightness-110'}`}
            onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
};

export default NewWorkOrderWindow;
