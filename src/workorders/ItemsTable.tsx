import React, { useEffect, useMemo, useRef, useState } from 'react';
import ContextMenu, { ContextMenuItem } from '@/components/ContextMenu';
import { useContextMenu } from '@/lib/useContextMenu';
import MoneyInput from '@/components/MoneyInput';
import { DEFAULT_PART_MARKUP_PCT, derivePartVendorFromUrl, markedUpPartPrice, normalizePartOrderUrl, scrapePartUrl } from '@/lib/partOrdering';
import LineDiscountDialog from '@/components/LineDiscountDialog';
import { discountedWorkOrderItemAmounts } from '@/lib/ticketAccounting';
import { findInventoryPartForRepair, resolveInventoryVariantForRepair } from '@/lib/inventoryPartMatching';
import { resolveWorkOrderRepairPricing } from '@/lib/repairPartLinking';
import InventoryVariantPicker from '@/components/InventoryVariantPicker';
import WorkOrderItemDialog from './WorkOrderItemDialog';

// Use the new WorkOrderItemRow type
export type WorkOrderItemRow = {
  id: string;
  device: string;
  repairCategory?: string;
  repair: string;
  parts: number;
  labor: number;
  status?: string;
  note?: string;
  partSource?: string;
  orderSourceUrl?: string;
  internalCost?: number;
  markupPct?: number | string;
  distributor?: string;
  requiresOrder?: boolean;
  taxExempt?: boolean;
  supplierTaxRate?: number;
  orderStatus?: 'needed' | 'ordered' | 'received' | 'in_stock';
  orderDate?: string;
  estimatedDeliveryDate?: string;
  trackingUrl?: string;
  itemType?: 'both' | 'part' | 'labor' | 'fee';
  partSourceKind?: 'stock' | 'order' | 'client';
  salvagedPart?: boolean;
  inventoryItemName?: string;
  inventoryProductId?: number;
  inventoryParentId?: number;
  deviceModel?: string;
  condition?: 'New' | 'Used' | 'Refurbished' | 'Other';
  distributorSku?: string;
  quantity?: number;
  reorderQty?: number;
  trackStock?: boolean;
  purchaseQueueRemovedAt?: string;
  purchaseQueueRemovalNotice?: string;
  purchaseQueueRemovalPaymentStatus?: string;
  discountType?: 'percent' | 'amount';
  discountValue?: number;
};

const MAX_ITEMS = 5;

interface Props {
  items: WorkOrderItemRow[];
  onChange: (items: WorkOrderItemRow[]) => void;
  onCommit?: (items: WorkOrderItemRow[]) => void | Promise<void>;
  onAddProduct?: () => void | Promise<void>;
  addProductDisabled?: boolean;
  /** Read-only rows (e.g., linked retail add-ons) shown inside the items table. */
  readonlyItems?: WorkOrderItemRow[];
  /** Optional handler for removing a read-only row from its backing record (e.g., attached retail Sale). */
  onRemoveReadonlyItem?: (row: WorkOrderItemRow) => void | Promise<void>;
  deviceCategory?: string;
  deviceName?: string;
  deviceModel?: string;
}

const ItemsTable: React.FC<Props> = ({ items, onChange, onCommit, onAddProduct, addProductDisabled, readonlyItems, onRemoveReadonlyItem, deviceCategory, deviceName, deviceModel }) => {
  const ro = useMemo(() => (Array.isArray(readonlyItems) ? readonlyItems : []), [readonlyItems]);

  const [selected, setSelected] = useState<string | null>(() => items[0]?.id || ro[0]?.id || null);
  const [editing, setEditing] = useState<WorkOrderItemRow | null>(null);
  const [discounting, setDiscounting] = useState<WorkOrderItemRow | null>(null);
  const [editingError, setEditingError] = useState('');
  const [scrapingOrderUrl, setScrapingOrderUrl] = useState(false);
  const [variantRequest, setVariantRequest] = useState<{ repair: any; products: any[]; parentId: number } | null>(null);

  const selectedRow = useMemo(() => {
    if (!selected) return null;
    return items.find(i => i.id === selected) || null;
  }, [items, selected]);
  const removedPurchaseItems = useMemo(() => items.filter(item => !!item.purchaseQueueRemovedAt), [items]);

  useEffect(() => {
    const combined = [...items, ...ro];
    if (combined.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !combined.some(i => i.id === selected)) {
      setSelected(items[0]?.id || ro[0]?.id || null);
    }
  }, [items, ro, selected]);

  // Keep the inline editor in sync only after the user explicitly opens it.
  useEffect(() => {
    if (!selectedRow) {
      setEditing(null);
      return;
    }
    setEditing(prev => (prev ? (prev.id === selectedRow.id ? prev : { ...selectedRow }) : null));
  }, [selectedRow]);

  const ctx = useContextMenu<WorkOrderItemRow>();
  const ctxRow = ctx.state.data;

  const ctxItems = useMemo<ContextMenuItem[]>(() => {
    if (!ctxRow) return [];

    const isReadonly = ro.some(r => r.id === ctxRow.id);
    if (isReadonly) {
      return [
        { type: 'header', label: `${ctxRow.device || 'Item'} — ${ctxRow.repair || 'Item'}` },
        { label: 'Edit…', disabled: true, hint: 'Read-only' },
        { type: 'separator' },
        {
          label: 'Remove…',
          danger: true,
          disabled: typeof onRemoveReadonlyItem !== 'function',
          hint: ctxRow.note || 'Sale',
          onClick: async () => {
            await onRemoveReadonlyItem?.(ctxRow);
          },
        },
      ];
    }

    return [
      { type: 'header', label: `${ctxRow.device || 'Device'} — ${ctxRow.repair || 'Item'}` },
      {
        label: 'Edit…',
        onClick: () => {
          setSelected(ctxRow.id);
          setEditing(ctxRow);
        },
      },
      {
        label: 'Duplicate',
        onClick: () => {
          const copy: WorkOrderItemRow = { ...ctxRow, id: crypto.randomUUID() };
          const idx = items.findIndex(i => i.id === ctxRow.id);
          const next = [...items];
          next.splice(idx >= 0 ? idx + 1 : next.length, 0, copy);
          if (next.length > MAX_ITEMS) next.pop();
          onChange(next);
          setSelected(copy.id);
          setEditing(null);
        },
      },
      {
        label: ctxRow.discountType ? 'Edit Discount…' : 'Add Discount…',
        onClick: () => setDiscounting(ctxRow),
      },
      { type: 'separator' },
      {
        label: 'Remove…',
        danger: true,
        onClick: () => {
          onChange(items.filter(i => i.id !== ctxRow.id));
          if (selected === ctxRow.id) setSelected(null);
          if (editing?.id === ctxRow.id) setEditing(null);
        },
      },
    ];
  }, [ctxRow, items, onChange, selected, editing?.id, ro, onRemoveReadonlyItem]);

  function appendRepair(selectedRepair: any, linkedInventory: any) {
    const trackedOutOfStock = !!linkedInventory?.trackStock && Number(linkedInventory?.stockCount || 0) <= 0;
    const pricing = resolveWorkOrderRepairPricing(selectedRepair, linkedInventory);
    const row: WorkOrderItemRow = {
      id: crypto.randomUUID(),
      device: selectedRepair.category || selectedRepair.deviceCategoryName || selectedRepair.device || '',
      repairCategory: selectedRepair.repairCategory || '',
      repair: selectedRepair.title || selectedRepair.repair || selectedRepair.altDescription || '',
      parts: pricing.parts,
      labor: Number(selectedRepair.laborCost ?? 0) || 0,
      status: 'pending',
      note: selectedRepair.model || selectedRepair.modelNumber || '',
      partSource: selectedRepair.partSource || linkedInventory?.distributor || '',
      orderSourceUrl: selectedRepair.orderSourceUrl || selectedRepair.reorderUrlTemplate || linkedInventory?.reorderUrlTemplate || '',
      internalCost: pricing.internalCost,
      markupPct: pricing.markupPct,
      distributor: selectedRepair.distributor || selectedRepair.partSource || linkedInventory?.distributor || '',
      inventoryParentId: Number(selectedRepair.inventoryParentId || 0) || undefined,
      inventoryProductId: Number(selectedRepair.inventoryProductId || linkedInventory?.id || 0) || undefined,
      trackStock: linkedInventory?.trackStock === true || selectedRepair.trackStock === true,
      requiresOrder: trackedOutOfStock,
      taxExempt: selectedRepair.taxExempt === true,
      supplierTaxRate: 8,
      orderStatus: trackedOutOfStock ? 'needed' : 'in_stock',
    };
    onChange([...items, row].slice(0, MAX_ITEMS));
    setSelected(row.id);
    setEditing(null);
  }

  async function newItem() {
    if (items.length >= MAX_ITEMS) return;
    const api: any = window.api;
    if (!api) return;
    // Prefer promise-based picker if available
    if (typeof api.pickRepairItem === 'function') {
      let selected: any;
      try {
        selected = await api.pickRepairItem({ deviceCategory, deviceName });
        console.log('[ItemsTable] pickRepairItem resolved', selected);
      } catch (e) {
        console.error('[ItemsTable] pickRepairItem failed', e);
        return;
      }
      if (!selected) return; // cancelled
      let linkedInventory: any = null;
      let products: any[] = [];
      if (api?.dbGet) {
        products = await api.dbGet('products').catch(() => []);
        if (Array.isArray(products)) {
          linkedInventory = selected.inventoryProductId
            ? products.find((product: any) => Number(product?.id) === Number(selected.inventoryProductId))
            : findInventoryPartForRepair(products, selected, { deviceCategory, deviceName, deviceModel });
        }
      }
      const parentId = Number(selected.inventoryParentId || 0);
      if (parentId > 0 && Array.isArray(products)) {
        const resolution = resolveInventoryVariantForRepair(products, parentId, { deviceCategory, deviceName, deviceModel });
        if (resolution.resolution === 'automatic' && resolution.variant) {
          appendRepair(selected, resolution.variant);
          return;
        }
        setVariantRequest({ repair: selected, products: resolution.candidates, parentId });
        return;
      }
      appendRepair(selected, linkedInventory);
      return;
    }
    // Fallback: open legacy picker window
    if (api.openWorkOrderRepairPicker) {
      api.openWorkOrderRepairPicker();
    } else {
      const url = window.location.origin + '/?workOrderRepairPicker=true';
      window.open(url, '_blank', 'width=1000,height=620');
    }
  }

  // Adds a blank, one-off line item that lives ONLY on this work order.
  // It is never written to the repair/parts catalog — good for a single
  // part that was ordered/paid for just this once.
  function newCustomItem() {
    if (items.length >= MAX_ITEMS) return;
    const row: WorkOrderItemRow = {
      id: crypto.randomUUID(),
      device: '',
      repairCategory: '',
      repair: '',
      parts: 0,
      labor: 0,
      status: 'pending',
      quantity: 1,
      condition: 'New',
      markupPct: DEFAULT_PART_MARKUP_PCT,
      reorderQty: 1,
      orderStatus: 'in_stock',
    };
    onChange([...items, row].slice(0, MAX_ITEMS));
    setSelected(row.id);
    // Open the editor immediately so the tech can type a custom description/cost.
    setEditing(row);
    setEditingError('');
  }

  async function autofillOrderDetails(value: string) {
    if (!editing) return;
    const orderSourceUrl = normalizePartOrderUrl(value);
    if (!orderSourceUrl) return;
    setEditing(current => current ? { ...current, orderSourceUrl, requiresOrder: true, orderStatus: 'needed' } : current);
    setScrapingOrderUrl(true);
    setEditingError('');
    try {
      const meta = await scrapePartUrl(orderSourceUrl);
      setEditing(current => {
        if (!current) return current;
        const internalCost = typeof meta.price === 'number' ? meta.price : current.internalCost;
        const markupPct = current.markupPct ?? DEFAULT_PART_MARKUP_PCT;
        const suggestedParts = markedUpPartPrice(internalCost, markupPct);
        const distributor = current.distributor || meta.vendor || derivePartVendorFromUrl(orderSourceUrl);
        return {
          ...current,
          orderSourceUrl,
          distributor,
          partSource: current.partSource || distributor,
          internalCost,
          markupPct,
          parts: suggestedParts ?? current.parts,
          requiresOrder: true,
          orderStatus: current.orderStatus === 'ordered' || current.orderStatus === 'received' ? current.orderStatus : 'needed',
        };
      });
      if (!meta.ok && meta.error) setEditingError(`URL saved, but supplier details could not be read: ${meta.error}`);
    } catch (error: any) {
      setEditingError(`URL saved, but supplier details could not be read: ${error?.message || 'Unknown error'}`);
    } finally {
      setScrapingOrderUrl(false);
    }
  }

  // Listen for repair selection from picker window via Electron IPC
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  // No IPC handler here; handled in parent

  return (
    <div className="gb-wo-items-card bg-zinc-900 border border-zinc-700 rounded p-2">
      {variantRequest ? <InventoryVariantPicker parentId={variantRequest.parentId} products={variantRequest.products} onClose={() => setVariantRequest(null)} onSelect={(product) => { appendRepair(variantRequest.repair, product); setVariantRequest(null); }} /> : null}
      <div className="gb-wo-items-header flex items-center justify-between mb-1">
        <h4 className="text-sm font-semibold text-zinc-200">Items</h4>
        <div className="text-xs text-zinc-400">Add parts/services (max {MAX_ITEMS})</div>
      </div>
      {removedPurchaseItems.length ? <div className="mb-2 rounded border border-amber-500/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-100"><strong className="text-amber-300">Not ordered:</strong> {removedPurchaseItems.map(item => item.repair || item.device || 'Part').join(', ')}. Select the item below for payment details or to restore it to the EOD Cart.</div> : null}
      <div className="gb-wo-items-table-wrap overflow-y-auto border border-zinc-800 rounded" style={{ maxHeight: '10rem' }}>
        <table className="w-full text-sm">
          <thead className="bg-zinc-800 text-zinc-400">
            <tr>
              <th className="px-2 py-1 text-left font-semibold">Device</th>
              <th className="px-2 py-1 text-left font-semibold">Type</th>
              <th className="px-2 py-1 text-left font-semibold">Repair</th>
              <th className="px-2 py-1 text-right font-semibold">Parts</th>
              <th className="px-2 py-1 text-right font-semibold">Labor</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => {
              const isSel = selected === it.id;
              return (
                <tr
                  key={it.id}
                  onClick={() => setSelected(it.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    ctx.openFromEvent(e, it);
                  }}
                  className={`cursor-pointer transition-colors border-l-4 ${isSel ? 'border-[#39FF14] bg-zinc-800/80 shadow-[inset_0_0_0_1px_#1f1f21,0_0_5px_1px_rgba(57,255,20,0.25)]' : 'border-transparent hover:bg-zinc-800/60'}`}
                >
                  <td data-label="Device" className="px-2 py-1 font-medium text-left">{it.device || ''}</td>
                  <td data-label="Type" className="px-2 py-1 text-left text-zinc-400 text-xs">{it.repairCategory || ''}</td>
                  <td data-label="Repair" className="px-2 py-1 text-left">{it.repair}{it.discountType ? <span className="ml-2 text-[10px] font-semibold text-neon-green">Discount {it.discountType === 'percent' ? `${it.discountValue || 0}%` : `$${Number(it.discountValue || 0).toFixed(2)}`}</span> : null}</td>
                  <td data-label="Parts" className="px-2 py-1 text-right tabular-nums">{typeof it.parts === 'number' ? `$${it.parts.toFixed(2)}` : ''}</td>
                  <td data-label="Labor" className="px-2 py-1 text-right tabular-nums">{typeof it.labor === 'number' ? `$${it.labor.toFixed(2)}` : ''}</td>
                </tr>
              );
            })}

            {ro.map((it, idx) => {
              const isSel = selected === it.id;
              return (
                <tr
                  key={`readonly-${it.id || idx}`}
                  onClick={() => setSelected(it.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelected(it.id);
                    ctx.openFromEvent(e, it);
                  }}
                  className={`cursor-pointer transition-colors border-l-4 ${
                    isSel
                      ? 'border-[#39FF14] bg-zinc-800/80 shadow-[inset_0_0_0_1px_#1f1f21,0_0_5px_1px_rgba(57,255,20,0.25)]'
                      : 'border-transparent bg-zinc-950/30 hover:bg-zinc-800/40'
                  }`}
                >
                  <td data-label="Device" className="px-2 py-1 font-medium text-left">{it.device || ''}</td>
                  <td data-label="Type" className="px-2 py-1 text-left text-zinc-500 text-xs">{it.repairCategory || ''}</td>
                  <td data-label="Repair" className="px-2 py-1 text-left">{it.repair}</td>
                  <td data-label="Parts" className="px-2 py-1 text-right tabular-nums">{typeof it.parts === 'number' ? `$${it.parts.toFixed(2)}` : ''}</td>
                  <td data-label="Labor" className="px-2 py-1 text-right tabular-nums">{typeof it.labor === 'number' ? `$${it.labor.toFixed(2)}` : ''}</td>
                </tr>
              );
            })}

            {/* filler rows only for the editable repair list (keep UI compact when readonly rows are present) */}
            {(ro.length === 0 ? Array.from({ length: Math.max(0, MAX_ITEMS - items.length) }) : []).map((_, idx) => (
              <tr key={`filler-${idx}`} className="gb-wo-items-filler opacity-60">
                <td className="px-2 py-1 text-left">&nbsp;</td>
                <td className="px-2 py-1 text-left">&nbsp;</td>
                <td className="px-2 py-1 text-left">&nbsp;</td>
                <td className="px-2 py-1 text-right">&nbsp;</td>
                <td className="px-2 py-1 text-right">&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="gb-wo-items-actions flex gap-2 mt-2 items-center">
        <button className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded disabled:opacity-50" onClick={newItem} disabled={items.length >= MAX_ITEMS}>Pick from catalog…</button>
        <button className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded disabled:opacity-50" onClick={newCustomItem} disabled={items.length >= MAX_ITEMS}>+ Custom item</button>
        {onAddProduct ? (
          <button
            className="gb-wo-add-product px-3 py-1 rounded bg-neon-green text-zinc-900 font-semibold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => { void onAddProduct(); }}
            disabled={!!addProductDisabled}
          >
            Add Product
          </button>
        ) : null}
        <div className="flex-1 self-center text-[11px] text-zinc-400">Custom items are one-off and won't be saved to the parts/repair catalog.</div>
      </div>

      {selectedRow?.purchaseQueueRemovedAt ? (
        <div className="mt-2 flex flex-col gap-2 rounded border border-amber-500/60 bg-amber-950/30 p-3 text-xs text-amber-100 sm:flex-row sm:items-center sm:justify-between">
          <div><strong className="block text-amber-300">Part has not been ordered</strong>{selectedRow.purchaseQueueRemovalNotice || 'This part remains on the work order, but it was removed from the EOD purchasing cart after payment was recorded. Delivery and tracking information are unavailable.'}</div>
          <button type="button" className="shrink-0 rounded bg-amber-500 px-3 py-1.5 font-semibold text-black" onClick={() => onChange(items.map(item => item.id === selectedRow.id ? { ...item, purchaseQueueRemovedAt: undefined, purchaseQueueRemovalNotice: undefined, purchaseQueueRemovalPaymentStatus: undefined } : item))}>Restore to EOD Cart</button>
        </div>
      ) : null}

      {editing ? <WorkOrderItemDialog
        item={editing}
        onClose={() => { setEditingError(''); setEditing(null); }}
        onSave={async saved => {
          const nextItems = items.map(row => row.id === saved.id ? saved : row);
          await onCommit?.(nextItems);
          onChange(nextItems);
          setEditingError('');
          setEditing(null);
        }}
      /> : null}

      {editing && ((editing: WorkOrderItemRow) => false && (
        <div className="gb-ticket-item-dialog fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-label="Edit work-order item" onMouseDown={() => { setEditingError(''); setEditing(null); }}>
        <div className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-800 p-4 shadow-2xl" onMouseDown={event => event.stopPropagation()}>
          {(() => {
            const catalogLinked = !!(editing.inventoryProductId || editing.inventoryParentId);
            return <>
          <div className="flex items-center justify-between gap-3 border-b border-zinc-700 pb-3">
            <div className="text-sm font-semibold text-zinc-100">{catalogLinked ? 'Edit work-order item' : 'Add custom work-order item'}</div>
            <div className="max-w-[75%] truncate text-[11px] text-zinc-400" title={`${editing.device || ''} — ${editing.repair || ''}`.trim()}>{`${editing.device || ''} — ${editing.repair || ''}`.trim()}</div>
            <button type="button" aria-label="Close item popup" className="shrink-0 rounded border border-zinc-600 bg-zinc-900 px-2.5 py-1 text-base leading-none text-zinc-200 hover:border-zinc-400" onClick={() => { setEditingError(''); setEditing(null); }}>×</button>
          </div>

          {catalogLinked ? (
            <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300">Catalog-linked details</div>
              <div className="mt-1 text-sm font-semibold text-zinc-100">{editing.repair || 'Catalog repair'}</div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-zinc-300">
                {editing.device ? <span className="rounded-full bg-zinc-900 px-2 py-0.5">{editing.device}</span> : null}
                {editing.repairCategory ? <span className="rounded-full bg-zinc-900 px-2 py-0.5">{editing.repairCategory}</span> : null}
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-200">{editing.inventoryProductId ? 'Exact inventory part' : 'Parent part family'}</span>
              </div>
              <div className="mt-1 text-[10px] text-zinc-400">Catalog organization is managed in Admin → Repairs. This ticket keeps only fulfillment, pricing, and notes editable.</div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2 mt-2">
            {!catalogLinked ? <>
            <div>
              <label className="block text-xs text-zinc-400">Device</label>
              <input
                className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                value={editing.device || ''}
                onChange={e => setEditing({ ...editing, device: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Repair Category</label>
              <input
                className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                value={editing.repairCategory || ''}
                onChange={e => setEditing({ ...editing, repairCategory: e.target.value })}
                placeholder="e.g. Screen Repair, Diagnostic"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Status</label>
              <select
                className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                value={(editing.status as any) || 'pending'}
                onChange={e => setEditing({ ...editing, status: e.target.value })}
              >
                <option value="pending">pending</option>
                <option value="done">done</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-zinc-400">Repair</label>
              <input
                className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                value={editing.repair || ''}
                onChange={e => setEditing({ ...editing, repair: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Device Model</label>
              <input className="w-full mt-1 bg-zinc-900 rounded px-2 py-1" value={editing.deviceModel || ''} onChange={e => setEditing({ ...editing, deviceModel: e.target.value })} placeholder="Specific model" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Condition</label>
              <select className="w-full mt-1 bg-zinc-900 rounded px-2 py-1" value={editing.condition || 'New'} onChange={e => setEditing({ ...editing, condition: e.target.value as WorkOrderItemRow['condition'] })}>
                <option value="New">New</option><option value="Used">Used</option><option value="Refurbished">Refurbished</option><option value="Other">Other</option>
              </select>
            </div>
            </> : null}
            <div>
              <label className="block text-xs text-zinc-400">Quantity</label>
              <input type="number" min="1" step="1" className="w-full mt-1 bg-zinc-900 rounded px-2 py-1" value={editing.quantity || 1} onChange={e => setEditing({ ...editing, quantity: Math.max(1, Math.round(Number(e.target.value || 1))) })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Reorder / MOQ</label>
              <input type="number" min="1" step="1" className="w-full mt-1 bg-zinc-900 rounded px-2 py-1" value={editing.reorderQty || 1} onChange={e => setEditing({ ...editing, reorderQty: Math.max(1, Math.round(Number(e.target.value || 1))) })} />
            </div>
            <label className="col-span-2 flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={editing.requiresOrder === true}
                onChange={e => setEditing({ ...editing, requiresOrder: e.target.checked, orderStatus: e.target.checked ? 'needed' : 'in_stock' })}
              />
              Must be purchased
            </label>
            {editing.requiresOrder ? (
              <>
                <div>
                  <label className="block text-xs text-zinc-400">Supplier item cost</label>
                  <MoneyInput
                    className="w-full mt-1 bg-yellow-200 text-black rounded px-2 py-1"
                    value={typeof editing.internalCost === 'number' ? editing.internalCost : undefined}
                    onValueChange={(value) => {
                      const internalCost = value == null ? undefined : Number(value);
                      const parts = markedUpPartPrice(internalCost, editing.markupPct ?? DEFAULT_PART_MARKUP_PCT);
                      setEditing({ ...editing, internalCost, ...(parts == null ? {} : { parts }) });
                    }}
                    allowEmpty
                  />
                  <div className="mt-1 text-[10px] text-zinc-500">Item price only. Shipping and supplier tax are added during EOD checkout.</div>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400">Distributor</label>
                  <input
                    className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                    value={editing.distributor || ''}
                    onChange={e => setEditing({ ...editing, distributor: e.target.value })}
                    placeholder="Distributor name"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400">Supplier SKU</label>
                  <input className="w-full mt-1 bg-zinc-900 rounded px-2 py-1" value={editing.distributorSku || ''} onChange={e => setEditing({ ...editing, distributorSku: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400">Markup %</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                    value={editing.markupPct ?? DEFAULT_PART_MARKUP_PCT}
                    onChange={e => {
                      const markupPct = e.target.value;
                      const parts = markedUpPartPrice(editing.internalCost, markupPct);
                      setEditing({ ...editing, markupPct, ...(parts == null ? {} : { parts }) });
                    }}
                  />
                </div>
                <label className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">
                  <input type="checkbox" checked={editing.taxExempt === true} onChange={e => setEditing({ ...editing, taxExempt: e.target.checked })} />
                  Supplier tax exempt
                </label>
                <div className="col-span-2">
                  <label className="block text-xs text-zinc-400">Order URL</label>
                  <input
                    className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                    type="url"
                    value={editing.orderSourceUrl || ''}
                    onChange={e => setEditing({ ...editing, orderSourceUrl: e.target.value })}
                    onBlur={e => { if (e.currentTarget.value.trim()) void autofillOrderDetails(e.currentTarget.value); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void autofillOrderDetails(e.currentTarget.value); } }}
                    placeholder="https://..."
                  />
                  {scrapingOrderUrl ? <div className="mt-1 text-[10px] text-[#39FF14]">Reading supplier details...</div> : null}
                </div>
              </>
            ) : null}
            <div>
              <label className="block text-xs text-zinc-400">Parts</label>
              <MoneyInput
                className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                value={Number(editing.parts || 0)}
                onValueChange={(v) => setEditing({ ...editing, parts: Number(v || 0) || 0 })}
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Labor</label>
              <MoneyInput
                className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                value={Number(editing.labor || 0)}
                onValueChange={(v) => setEditing({ ...editing, labor: Number(v || 0) || 0 })}
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-zinc-400">Note</label>
              <input
                className="w-full mt-1 bg-zinc-900 rounded px-2 py-1"
                value={editing.note || ''}
                onChange={e => setEditing({ ...editing, note: e.target.value })}
                placeholder="Optional"
              />
            </div>
          </div>
          {editingError ? <div className="mt-2 rounded border border-red-700 bg-red-950/40 px-3 py-2 text-xs text-red-200">{editingError}</div> : null}
          <div className="flex gap-2 mt-2 justify-end">
            <button
              className="px-3 py-1 bg-zinc-800 rounded"
              onClick={() => { setEditingError(''); setEditing(null); }}
            >
              Cancel
            </button>
            <button
              className="px-3 py-1 bg-brand text-black rounded"
              onClick={async () => {
                if (editing.requiresOrder && (editing.internalCost === undefined || !Number.isFinite(Number(editing.internalCost)) || Number(editing.internalCost) < 0)) {
                  setEditingError('Enter the supplier item cost before shipping and tax.');
                  return;
                }
                if (editing.requiresOrder && !String(editing.distributor || '').trim() && !String(editing.orderSourceUrl || '').trim()) {
                  setEditingError('Enter a distributor or an order URL so the EOD Cart can group this part.');
                  return;
                }
                const distributor = String(editing.distributor || '').trim() || derivePartVendorFromUrl(editing.orderSourceUrl);
                const saved = { ...editing, distributor, orderStatus: editing.requiresOrder ? (editing.orderStatus || 'needed') : 'in_stock' as const };
                const nextItems = items.map(i => (i.id === editing.id ? saved : i));
                setEditingError('');
                try {
                  await onCommit?.(nextItems);
                  onChange(nextItems);
                  setEditing(null);
                } catch (error: any) {
                  setEditingError(error?.message || 'The line item could not be saved.');
                }
              }}
            >
              Save
            </button>
          </div>
            </>;
          })()}
        </div>
        </div>
      ))(editing)}

      <ContextMenu
        id="wo-items-ctx"
        open={ctx.state.open}
        x={ctx.state.x}
        y={ctx.state.y}
        items={ctxItems}
        onClose={ctx.close}
      />
      {discounting ? (() => { const amounts = discountedWorkOrderItemAmounts(discounting); return <LineDiscountDialog title={`${discounting.device} — ${discounting.repair}`} gross={amounts.gross} value={discounting} onClose={() => setDiscounting(null)} onApply={discount => { const next = items.map(item => item.id === discounting.id ? { ...item, discountType: discount.discountType, discountValue: discount.discountValue } : item); onChange(next); void onCommit?.(next); setDiscounting(null); }} />; })() : null}
    </div>
  );
}

export default React.memo(ItemsTable);
