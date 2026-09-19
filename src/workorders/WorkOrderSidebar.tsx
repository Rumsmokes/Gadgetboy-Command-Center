import React, { useEffect, useMemo, useState } from 'react';
import { printReleaseForm, WorkOrder as PrintWorkOrder } from './releasePrint';
import { WorkOrderFull, WorkOrderStatus } from '../lib/types';
import { toLocalDatetimeInput, fromLocalDatetimeInput } from '../lib/datetime';
import { listTechnicians } from '../../src/lib/admin';

interface Props {
  workOrder: WorkOrderFull;
  onChange: (patch: Partial<WorkOrderFull>) => void;
  hideStatus?: boolean; // optionally hide status control (used by Sale window)
  hideAssigned?: boolean; // optionally hide assigned technician control when rendered elsewhere
  saleDates?: boolean; // when true, relabel date fields and show extra Client pickup
  hideDates?: boolean; // optionally hide the date controls entirely (used by Sale window)
  hideOrderDeliveryDates?: boolean; // when true in Sale window, hide Product ordered & Product delivered (keep Client pickup)
  renderActions?: (workOrder: WorkOrderFull) => React.ReactNode; // override default print buttons
  validationFlags?: Partial<Record<'assignedTo', boolean>>;
  /** Called when the receipt button needs a saved work-order ID but the record is still unsaved.
   *  Should persist the work order immediately and return its new numeric ID (0 if it fails). */
  onRequestForceSave?: () => Promise<number>;
  headerControl?: React.ReactNode;
}

const WorkOrderSidebar: React.FC<Props> = ({ workOrder, onChange, hideStatus = false, hideAssigned = false, saleDates = false, hideDates = false, hideOrderDeliveryDates = false, renderActions, validationFlags, onRequestForceSave, headerControl }) => {
  const [techs, setTechs] = useState<any[]>([]);
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const list = await listTechnicians();
        if (mounted) setTechs(list || []);
      } catch (e) { console.error('Failed to load technicians', e); }
    };
    refresh();
    const off = (window as any).api?.onTechniciansChanged?.(() => refresh());
    return () => { mounted = false; try { off && off(); } catch {} };
  }, []);
  const selectedTechId = useMemo(() => {
    if (!workOrder.assignedTo) return '';
    const raw = String(workOrder.assignedTo).trim();
    // If stored as id
    if (techs.some((t: any) => String(t.id) === raw)) return raw;
    // If stored as label (nickname/first)
    const matchByLabel = techs.find((t: any) => (t.nickname?.trim() || t.firstName) === raw);
    return matchByLabel ? String(matchByLabel.id) : '';
  }, [techs, workOrder.assignedTo]);
  const formatTimestamp = (value: any) => {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };
  const checkInAt = (workOrder as any).checkInAt || (workOrder as any).createdAt;
  const lastUpdateAt = (workOrder as any).lastClientUpdateAt || (workOrder as any).lastStatusUpdateAt || (workOrder as any).updatedAt;
  const lastUpdateLabel = (workOrder as any).lastClientUpdateLabel || (workOrder as any).lastStatusUpdateLabel || (workOrder as any).lastUpdateLabel || 'No client or technician update recorded';
  const balance = Number((workOrder as any).totals?.remaining || 0) || 0;

  return (
    <div className="gb-wo-side-actions bg-gradient-to-b from-slate-800 to-slate-900 p-3 rounded border border-zinc-700 h-full flex flex-col">
      {headerControl ? <div className="gb-wo-sidebar-header">{headerControl}</div> : null}
      <h4 className="text-sm font-semibold text-zinc-200 mb-3">Ticket summary</h4>
      <div className="mb-4 space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3 text-xs">
        <div className="flex items-center justify-between gap-2"><span className="text-zinc-400">{saleDates ? 'Sale created' : 'Checked in'}</span><strong className="text-right text-zinc-100">{formatTimestamp(checkInAt)}</strong></div>
        <div className="flex items-center justify-between gap-2"><span className="text-zinc-400">Status</span><strong className="rounded-full border border-violet-400/40 bg-violet-950/40 px-2 py-0.5 text-violet-100">{String(workOrder.status || 'open')}</strong></div>
        <div className="border-t border-zinc-800 pt-2"><span className="text-zinc-400">Last update</span><strong className="mt-1 block truncate text-zinc-100" title={String(lastUpdateLabel)}>{lastUpdateLabel}</strong><span className="mt-0.5 block text-zinc-500">{formatTimestamp(lastUpdateAt)}</span></div>
        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 pt-2"><span className="text-zinc-400">Balance</span><strong className={balance > 0 ? 'text-[#39ff14]' : 'text-zinc-200'}>${balance.toFixed(2)}</strong></div>
      </div>
      {!hideAssigned && (
        <>
          <label className="block text-xs text-zinc-400">
            Assigned to
            {validationFlags?.assignedTo && <span className="ml-1 text-red-500">*</span>}
          </label>
          {techs.length === 0 ? (
            <select disabled className="w-full mt-1 mb-2 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-500"><option>— No technicians —</option></select>
          ) : (
            <select
              className={`w-full mt-1 mb-2 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand bg-zinc-800 border ${validationFlags?.assignedTo ? 'border-red-500' : 'border-zinc-700'}`}
              value={selectedTechId}
              onChange={e => {
                const id = e.target.value;
                if (!id) { onChange({ assignedTo: null }); return; }
                const tech = techs.find((t: any) => String(t.id) === id);
                // Store technician reference as id string for consistency across app
                onChange({ assignedTo: tech ? String(tech.id) : null });
              }}
            >
              <option value="">—</option>
              {techs.map((t: any) => (
                <option key={t.id} value={String(t.id)}>{t.nickname?.trim() || t.firstName}</option>
              ))}
            </select>
          )}
        </>
      )}
      <div className="mt-auto pb-16">
        {renderActions ? (
          <>{renderActions(workOrder)}</>
        ) : (
          <>
            <button
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 mb-2"
              onClick={async () => {
                try {
                  // Force-save brand-new (id=0) work orders so the QR URL points to a real record
                  let releaseId = Number((workOrder as any).id || 0) || 0;
                  if (!releaseId && typeof onRequestForceSave === 'function') {
                    try { releaseId = (await onRequestForceSave()) || 0; } catch {}
                  }

                  let customerName = (workOrder as any).customerName;
                  let customerPhone = (workOrder as any).customerPhone;
                  let customerPhoneAlt = '';
                  let customerEmail = '';
                  try {
                    const id = (workOrder as any).customerId;
                    if (id && (window as any).api?.findCustomers) {
                      const list = await (window as any).api.findCustomers({ id });
                      const c = Array.isArray(list) && list.length ? list[0] : null;
                      if (c) {
                        const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
                        customerName = full || customerName;
                        customerPhone = c.phone || customerPhone;
                        customerPhoneAlt = c.phoneAlt || '';
                        customerEmail = c.email || '';
                      }
                    }
                  } catch {}

                  const itemsRaw = (workOrder as any).items || [];
                  const items = itemsRaw.map((it: any) => ({
                    description: it.repair || it.description || it.title || it.name || it.altDescription || '',
                    parts: typeof it.parts === 'number' ? it.parts : (typeof it.partCost === 'number' ? it.partCost : 0),
                    labor: typeof it.labor === 'number' ? it.labor : (typeof it.unitPrice === 'number' ? it.unitPrice : (typeof it.laborCost === 'number' ? it.laborCost : 0)),
                    qty: typeof it.qty === 'number' ? it.qty : undefined,
                    discountType: it.discountType,
                    discountValue: it.discountValue,
                  }));

                  const wo: PrintWorkOrder = {
                    invoiceId: String(releaseId || ((workOrder as any).id ?? '')),
                    id: releaseId,
                    type: 'repair',
                    dateTimeISO: (workOrder as any).checkInAt || new Date().toISOString(),
                    clientName: customerName || `${(workOrder as any).firstName ?? ''} ${(workOrder as any).lastName ?? ''}`.trim(),
                    phone: customerPhone || (workOrder as any).phone || '',
                    phoneAlt: customerPhoneAlt,
                    email: customerEmail,

                    device: workOrder.productCategory || '',
                    description: workOrder.productDescription || '',
                    model: (workOrder as any).model || '',
                    serialNumber: (workOrder as any).serial || '',
                    password: (workOrder as any).password || '',
                    patternSequence: Array.isArray((workOrder as any).patternSequence) ? (workOrder as any).patternSequence : [],
                    problem: workOrder.problemInfo || '',

                    items,
                    subTotalParts: Number((workOrder as any).partCosts || 0),
                    subTotalLabor: Number((workOrder as any).laborCost || 0),
                    discount: Number((workOrder as any).discount || 0),
                    taxRate: Number((workOrder as any).taxRate || 0),
                    taxes: Number((workOrder as any).totals?.tax || 0),
                    amountPaid: Number((workOrder as any).amountPaid || 0),
                    notes: (workOrder as any).internalNotes || '',
                    workOrderType: (workOrder as any).workOrderType || '',
                    durantFullTransfer: !!(workOrder as any).durantFullTransfer,
                  };

                  await printReleaseForm(wo, { autoCloseMs: 0, autoPrint: true });
                } catch (e) { console.error('Failed to open release form', e); }
              }}
            >
              Print release form
            </button>
            <button
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-zinc-200"
              onClick={async () => {
                try {
                  let customerName = (workOrder as any).customerName;
                  let customerPhone = (workOrder as any).customerPhone;
                  let customerPhoneAlt = '';
                  let customerEmail = (workOrder as any).customerEmail;
                  try {
                    const id = (workOrder as any).customerId;
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
                    const addonSaleId = Number((workOrder as any).addonSaleId || 0) || 0;
                    if (addonSaleId && (window as any).api?.dbGet) {
                      const sales = await (window as any).api.dbGet('sales').catch(() => []);
                      addonSale = Array.isArray(sales) ? sales.find((s: any) => Number(s?.id || 0) === addonSaleId) : null;
                    }
                  } catch {}

                  // If the work order hasn't been saved yet (id=0), force-save now so the
                  // receipt can embed a real QR-code status URL.
                  let effectiveId = Number((workOrder as any).id || 0) || 0;
                  if (!effectiveId && typeof onRequestForceSave === 'function') {
                    try { effectiveId = (await onRequestForceSave()) || 0; } catch {}
                  }

                  const payload = {
                    id: effectiveId || (workOrder as any).id,
                    workOrderId: effectiveId || (workOrder as any).id,
                    receiptType: 'repair',
                    customerId: (workOrder as any).customerId,
                    customerName,
                    customerPhone,
                    customerPhoneAlt,
                    customerEmail,
                    paymentType: (workOrder as any).paymentType,
                    payments: (workOrder as any).payments || [],
                    addonSaleId: addonSale?.id ?? (workOrder as any).addonSaleId ?? null,
                    addonSale: addonSale || null,
                    productCategory: workOrder.productCategory,
                    productDescription: workOrder.productDescription,
                    model: (workOrder as any).model,
                    serial: (workOrder as any).serial,
                    password: (workOrder as any).password || '',
                    patternSequence: Array.isArray((workOrder as any).patternSequence) ? (workOrder as any).patternSequence : [],
                    problemInfo: workOrder.problemInfo,
                    items: (workOrder as any).items || [],
                    partCosts: (workOrder as any).partCosts,
                    laborCost: (workOrder as any).laborCost,
                    discount: (workOrder as any).discount,
                    taxRate: (workOrder as any).taxRate,
                    totals: (workOrder as any).totals,
                    amountPaid: (workOrder as any).amountPaid,
                    workOrderType: (workOrder as any).workOrderType || '',
                    durantFullTransfer: !!(workOrder as any).durantFullTransfer,
                  };
                  if ((window as any).api?.openCustomerReceipt) {
                    await (window as any).api.openCustomerReceipt(payload);
                  } else {
                    const u = new URL(window.location.href);
                    u.search = `?customerReceipt=${encodeURIComponent(JSON.stringify(payload))}`;
                    window.open(u.toString(), '_blank');
                  }
                } catch (e) { console.error('Failed to open customer receipt', e); }
              }}
            >
              Print customer receipt
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default React.memo(WorkOrderSidebar, (prev, next) => {
  const a = prev.workOrder;
  const b = next.workOrder;
  return prev.hideStatus === next.hideStatus
    && prev.saleDates === next.saleDates
    && prev.hideDates === next.hideDates
    && prev.hideOrderDeliveryDates === next.hideOrderDeliveryDates
    && prev.renderActions === next.renderActions
    && prev.onRequestForceSave === next.onRequestForceSave
    && prev.headerControl === next.headerControl
    && !!prev.validationFlags?.assignedTo === !!next.validationFlags?.assignedTo
    && String(a.status || '') === String(b.status || '')
    && String(a.assignedTo || '') === String(b.assignedTo || '')
    && String(a.repairCompletionDate || '') === String(b.repairCompletionDate || '')
    && String(a.checkoutDate || '') === String(b.checkoutDate || '')
    && String((a as any).clientPickupDate || '') === String((b as any).clientPickupDate || '')
    && String((a as any).customerId || '') === String((b as any).customerId || '')
    && String((a as any).customerName || '') === String((b as any).customerName || '')
    && String((a as any).addonSaleId || '') === String((b as any).addonSaleId || '')
    && String((a as any).id || '') === String((b as any).id || '')
    && JSON.stringify(a.items) === JSON.stringify(b.items)
    && Number((a as any).totals?.total ?? 0) === Number((b as any).totals?.total ?? 0)
    && Number((a as any).amountPaid ?? 0) === Number((b as any).amountPaid ?? 0);
});
