import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ContextMenu, { ContextMenuItem } from '@/components/ContextMenu';
import { useContextMenu } from '@/lib/useContextMenu';
import MoneyInput from '@/components/MoneyInput';
import { derivePartVendorFromUrl, markedUpPartPrice, normalizePartOrderUrl, scrapePartUrl } from '@/lib/partOrdering';
import LineDiscountDialog from '@/components/LineDiscountDialog';
import { discountedLineTotal } from '@/lib/ticketAccounting';
import SaleItemDialog from './SaleItemDialog';

export type SaleItemRow = {
  id: string;
  inventoryProductId?: number;
  description: string;
  qty: number;
  price: number; // unit price
  consultationHours?: number;
  internalCost?: number;
  condition?: 'New' | 'Excellent' | 'Good' | 'Fair';
  inStock?: boolean; // whether this specific item is in stock
  productUrl?: string;
  category?: 'Device' | 'Accessory' | 'Consultation' | 'Other' | string;
  itemType?: 'Product' | 'Part';
  distributor?: string;
  vendorRelationship?: 'wholesale' | 'consignment';
  vendorSharePct?: number;
  vendorTaxExempt?: boolean;
  trackStock?: boolean;
  stockCountAtSelection?: number;
  requiresOrder?: boolean;
  orderStatus?: 'needed' | 'ordered' | 'received' | 'in_stock';
  orderDate?: string;
  estimatedDeliveryDate?: string;
  trackingUrl?: string;
  sourceKind?: 'local' | 'order';
  localStore?: string;
  receiptReference?: string;
  quantityAcquired?: number;
  purchaseQueueRemovedAt?: string;
  purchaseQueueRemovalNotice?: string;
  purchaseQueueRemovalPaymentStatus?: string;
  deviceModel?: string;
  partCategory?: string;
  distributorSku?: string;
  markupPct?: number | string;
  reorderQty?: number;
  notes?: string;
  taxExempt?: boolean;
  discountType?: 'percent' | 'amount';
  discountValue?: number;
};

interface Props {
  items: SaleItemRow[];
  onChange: (items: SaleItemRow[]) => void;
  onCommit?: (items: SaleItemRow[]) => void | Promise<void>;
  showRequiredIndicator?: boolean;
  allowAddItems?: boolean;
  layout?: 'stacked' | 'split';
  catalogPanel?: React.ReactNode;
  editRequestId?: string | null;
  quickCheckout?: boolean;
}

const MAX_ITEMS = 20;

function isConsultationItem(row: Partial<SaleItemRow> | null | undefined) {
  const category = (row?.category || '').toString().trim().toLowerCase();
  return category === 'consultation' || category.startsWith('consult');
}

function effectiveUnits(row: Partial<SaleItemRow> | null | undefined) {
  if (isConsultationItem(row)) {
    const hours = Number(row?.consultationHours ?? row?.qty ?? 0);
    return Number.isFinite(hours) && hours > 0 ? hours : 0;
  }
  const qty = Number(row?.qty ?? 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function lineTotalFor(row: Partial<SaleItemRow> | null | undefined) {
  return discountedLineTotal({ units: effectiveUnits(row), unitPrice: Number(row?.price) || 0, discountType: row?.discountType, discountValue: row?.discountValue });
}

const SaleItemsTable: React.FC<Props> = ({
  items,
  onChange,
  onCommit,
  showRequiredIndicator,
  allowAddItems = true,
  layout = 'stacked',
  catalogPanel,
  editRequestId,
  quickCheckout = false,
}) => {
  const [selected, setSelected] = useState<string | null>(items[0]?.id || null);
  const itemsRef = useRef(items);
  const [editing, setEditing] = useState<SaleItemRow | null>(null);
  const [discounting, setDiscounting] = useState<SaleItemRow | null>(null);
  const [editingError, setEditingError] = useState('');
  const [scrapingProductUrl, setScrapingProductUrl] = useState(false);
  const holdRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  const holdTriggeredRef = useRef(false);

  const selectedRow = useMemo(() => {
    if (!selected) return null;
    return items.find(i => i.id === selected) || null;
  }, [items, selected]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const removedPurchaseItems = useMemo(() => items.filter(item => !!item.purchaseQueueRemovedAt), [items]);

  useEffect(() => {
    if (items.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !items.some(i => i.id === selected)) {
      setSelected(items[0].id);
    }
  }, [items, selected]);

  useEffect(() => {
    if (quickCheckout || !editRequestId) return;
    const requested = items.find(item => item.id === editRequestId);
    if (!requested) return;
    setSelected(requested.id);
    setEditing({ ...requested });
    setEditingError('');
  }, [editRequestId, items, quickCheckout]);

  // Keep the inline editor in sync only after the user explicitly opens it.
  useEffect(() => {
    if (quickCheckout) {
      setEditing(null);
      return;
    }
    if (!selectedRow) {
      setEditing(null);
      return;
    }
    setEditing(prev => (prev ? (prev.id === selectedRow.id ? prev : { ...selectedRow }) : null));
  }, [selectedRow, quickCheckout]);

  const ctx = useContextMenu<SaleItemRow>();
  const ctxRow = ctx.state.data;

  const clearHold = useCallback(() => {
    if (holdRef.current) window.clearTimeout(holdRef.current.timer);
    holdRef.current = null;
  }, []);

  const startHold = useCallback((event: React.PointerEvent, row: SaleItemRow) => {
    if (event.pointerType === 'mouse') return;
    clearHold();
    holdTriggeredRef.current = false;
    const x = event.clientX;
    const y = event.clientY;
    const timer = window.setTimeout(() => {
      holdTriggeredRef.current = true;
      setSelected(row.id);
      ctx.openAt(x, y, row);
      navigator.vibrate?.(25);
    }, 550);
    holdRef.current = { timer, x, y };
  }, [clearHold, ctx]);

  const moveHold = useCallback((event: React.PointerEvent) => {
    const hold = holdRef.current;
    if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10) clearHold();
  }, [clearHold]);

  useEffect(() => clearHold, [clearHold]);

  const ctxItems = useMemo<ContextMenuItem[]>(() => {
    if (!ctxRow) return [];
    const lineTotal = lineTotalFor(ctxRow);
    const url = (ctxRow.productUrl || '').trim();
    return [
      { type: 'header', label: ctxRow.description || 'Item' },
      { label: 'Edit…', disabled: quickCheckout || !!ctxRow.inventoryProductId, onClick: () => { if (quickCheckout || ctxRow.inventoryProductId) return; setSelected(ctxRow.id); setEditing(ctxRow); } },
      {
        label: 'Duplicate',
        onClick: () => {
          const copy: SaleItemRow = { ...ctxRow, id: crypto.randomUUID() };
          const idx = items.findIndex(i => i.id === ctxRow.id);
          const next = [...items];
          next.splice(idx >= 0 ? idx + 1 : next.length, 0, copy);
          if (next.length > MAX_ITEMS) next.pop();
          onChange(next);
          setSelected(copy.id);
          setEditing(null);
        },
      },
      { label: ctxRow.discountType ? 'Edit Discount…' : 'Add Discount…', onClick: () => setDiscounting(ctxRow) },
      ...(url
        ? ([
            { type: 'separator' as const },
            {
              label: 'Open product URL',
              hint: url.length > 24 ? url.slice(0, 24) + '…' : url,
              onClick: () => {
                try {
                  (window as any).api?.openUrl ? (window as any).api.openUrl(url) : window.open(url, '_blank');
                } catch {
                  window.open(url, '_blank');
                }
              },
            },
            {
              label: 'Copy product URL',
              onClick: async () => {
                try { await navigator.clipboard.writeText(url); } catch {}
              },
            },
          ] as ContextMenuItem[])
        : ([] as ContextMenuItem[])),
      { type: 'separator' },
      { label: 'Copy line total', hint: `$${lineTotal.toFixed(2)}`, onClick: async () => { try { await navigator.clipboard.writeText(String(lineTotal.toFixed(2))); } catch {} } },
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
  }, [ctxRow, items, onChange, selected, editing?.id, quickCheckout]);

  async function newItem() {
    if (items.length >= MAX_ITEMS) return;
    const api: any = (window as any).api || (window as any).opener?.api;
    if (!api) return;
    if (typeof api.pickSaleProduct === 'function') {
      try {
        const picked = await api.pickSaleProduct();
        if (!picked) return; // cancelled
        const currentItems = itemsRef.current;
        const picks = (Array.isArray(picked) ? picked : [picked]).slice(0, Math.max(0, MAX_ITEMS - currentItems.length));
        const rows: SaleItemRow[] = picks.map((product: any) => ({
          id: crypto.randomUUID(),
          inventoryProductId: typeof product.inventoryProductId === 'number' ? product.inventoryProductId : undefined,
          description: product.itemDescription || product.title || product.name || 'Item',
          qty: Number(product.quantity ?? 1) || 1,
          price: Number(product.price ?? 0) || 0,
          consultationHours: typeof product.consultationHours === 'number' ? product.consultationHours : undefined,
          internalCost: typeof product.internalCost === 'number' ? product.internalCost : undefined,
          condition: product.condition || 'New',
          inStock: !!product.inStock,
          productUrl: product.productUrl || product.url || product.link || '',
          category: product.category,
          distributor: product.distributor || '',
          vendorRelationship: product.vendorRelationship,
          vendorSharePct: typeof product.vendorSharePct === 'number' ? product.vendorSharePct : undefined,
          vendorTaxExempt: !!product.vendorTaxExempt,
          trackStock: !!product.trackStock,
          stockCountAtSelection: typeof product.stockCount === 'number' ? product.stockCount : undefined,
          requiresOrder: !product.inStock,
          orderStatus: product.inStock ? 'in_stock' : 'needed',
        }));
        if (!rows.length) return;
        onChange([...currentItems, ...rows].slice(0, MAX_ITEMS));
        const lastRow = rows[rows.length - 1];
        setSelected(lastRow.id);
        setEditing(null);
        return;
      } catch (e) {
        console.error('[SaleItemsTable] pickSaleProduct failed', e);
      }
    }
    // Fallback: open Products window in picker mode via URL param
    const url = window.location.origin + '/?products=true&picker=sale';
    window.open(url, '_blank', 'width=1280,height=800');
  }

  function newCustomItem() {
    if (items.length >= MAX_ITEMS) return;
    const row: SaleItemRow = {
      id: crypto.randomUUID(),
      description: '',
      qty: 1,
      price: 0,
      condition: 'New',
      inStock: true,
      markupPct: 10,
      reorderQty: 1,
      requiresOrder: false,
      orderStatus: 'in_stock',
    };
    onChange([...items, row].slice(0, MAX_ITEMS));
    setSelected(row.id);
    // Open the editor immediately so the tech can type a custom description/price.
    setEditing(row);
    setEditingError('');
  }

  async function autofillProductOrderDetails(value: string) {
    if (!editing || isConsultationItem(editing)) return;
    const productUrl = normalizePartOrderUrl(value);
    if (!productUrl) return;
    setEditing(current => current ? { ...current, productUrl, inStock: false, requiresOrder: true, orderStatus: 'needed' } : current);
    setScrapingProductUrl(true);
    setEditingError('');
    try {
      const meta = await scrapePartUrl(productUrl);
      setEditing(current => {
        if (!current) return current;
        const distributor = current.distributor || meta.vendor || derivePartVendorFromUrl(productUrl);
        const internalCost = typeof meta.price === 'number' ? meta.price : current.internalCost;
        const markupPct = current.markupPct ?? 10;
        const price = markedUpPartPrice(internalCost, markupPct);
        return {
          ...current,
          productUrl,
          distributor,
          internalCost,
          markupPct,
          ...(price == null ? {} : { price }),
          inStock: false,
          requiresOrder: true,
          orderStatus: current.orderStatus === 'ordered' || current.orderStatus === 'received' ? current.orderStatus : 'needed',
        };
      });
      if (!meta.ok && meta.error) setEditingError(`URL saved, but supplier details could not be read: ${meta.error}`);
    } catch (error: any) {
      setEditingError(`URL saved, but supplier details could not be read: ${error?.message || 'Unknown error'}`);
    } finally {
      setScrapingProductUrl(false);
    }
  }

  const splitLayout = layout === 'split';

  return (
    <div className={`gb-sale-items ${splitLayout ? 'flex h-full min-h-0 flex-col' : ''} ${editing ? 'has-editor' : ''} bg-zinc-900 border ${showRequiredIndicator ? 'border-red-500' : 'border-zinc-700'} rounded p-3`}>
      <div className="gb-sale-items-header flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-zinc-200">
          Items
          {showRequiredIndicator && <span className="ml-1 text-red-500">*</span>}
        </h4>
        <div className="text-xs text-zinc-400">Add products (max {MAX_ITEMS})</div>
      </div>
      <div className={splitLayout ? 'gb-sale-items-split-layout grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[minmax(320px,0.9fr)_minmax(430px,1.1fr)]' : ''}>
      <div className={`${splitLayout ? 'gb-sale-items-list-pane flex min-h-0 flex-col' : ''}`}>
      {catalogPanel}
      {removedPurchaseItems.length ? <div className="mb-2 rounded border border-amber-500/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-100"><strong className="text-amber-300">Not ordered:</strong> {removedPurchaseItems.map(item => item.description || 'Product').join(', ')}. Select the item below for payment details or to restore it to the EOD Cart.</div> : null}
      <div className={`gb-sale-items-table-wrap overflow-y-auto border border-zinc-800 rounded ${splitLayout ? 'min-h-[9rem] flex-1' : ''}`} style={{ maxHeight: splitLayout ? undefined : '12rem' }}>
        <table className="gb-sale-items-table w-full text-sm">
          <thead className="bg-zinc-800 text-zinc-400">
            <tr>
              <th className="px-2 py-1">Item</th>
              <th className="px-2 py-1" style={{ width: 80 }}>Qty / Hrs</th>
              <th className="px-2 py-1" style={{ width: 110 }}>Price</th>
              <th className="px-2 py-1" style={{ width: 120, textAlign: 'right' }}>Total</th>
              <th className="px-2 py-1" style={{ width: 90, textAlign: 'center' }}>In stock</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => {
              const isSel = selected === it.id;
              const units = effectiveUnits(it);
              const lineTotal = lineTotalFor(it);
              return (
                <tr
                  key={it.id}
                  onClick={() => {
                    if (holdTriggeredRef.current) {
                      holdTriggeredRef.current = false;
                      return;
                    }
                    setSelected(it.id);
                    if (splitLayout && !quickCheckout && !it.inventoryProductId) {
                      setEditing({ ...it });
                      setEditingError('');
                    }
                  }}
                  onPointerDown={(event) => startHold(event, it)}
                  onPointerMove={moveHold}
                  onPointerUp={clearHold}
                  onPointerCancel={clearHold}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    ctx.openFromEvent(e, it);
                  }}
                  className={`cursor-pointer transition-colors border-l-4 ${isSel ? 'border-[#39FF14] bg-zinc-800/80 shadow-[inset_0_0_0_1px_#1f1f21,0_0_5px_1px_rgba(57,255,20,0.25)]' : 'border-transparent hover:bg-zinc-800/60'}`}
                >
                  <td data-label="Item" className="px-2 py-1 font-medium truncate" title={it.description}>{it.description}{it.discountType ? <span className="ml-2 text-[10px] font-semibold text-neon-green">Discount {it.discountType === 'percent' ? `${it.discountValue || 0}%` : `$${Number(it.discountValue || 0).toFixed(2)}`}</span> : null}</td>
                  <td data-label="Qty / Hrs" className="px-2 py-1">{Number.isFinite(units) ? units : ''}</td>
                  <td data-label="Price" className="px-2 py-1">{typeof it.price === 'number' ? `$${it.price.toFixed(2)}` : ''}</td>
                  <td data-label="Total" className="px-2 py-1" style={{ textAlign: 'right' }}>{`$${lineTotal.toFixed(2)}`}</td>
                  <td data-label="In stock" className="px-2 py-1" style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 align-middle"
                      checked={!!it.inStock}
                      onClick={e => e.stopPropagation()}
                      onChange={e => {
                        const next = items.map(row => row.id === it.id ? { ...row, inStock: e.target.checked } : row);
                        onChange(next);
                      }}
                    />
                  </td>
                </tr>
              );
            })}
            {Array.from({ length: Math.max(0, MAX_ITEMS - items.length) }).map((_, idx) => (
              <tr key={`filler-${idx}`} className="gb-sale-items-filler opacity-60">
                <td className="px-2 py-1">&nbsp;</td>
                <td className="px-2 py-1">&nbsp;</td>
                <td className="px-2 py-1">&nbsp;</td>
                <td className="px-2 py-1">&nbsp;</td>
                <td className="px-2 py-1">&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {allowAddItems ? <div className="gb-sale-items-actions flex gap-2 mt-2">
        <button className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded disabled:opacity-50" onClick={newItem} disabled={items.length >= MAX_ITEMS}>Pick product…</button>
        {!quickCheckout ? <><button className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded disabled:opacity-50" onClick={newCustomItem} disabled={items.length >= MAX_ITEMS}>+ Custom item</button><div className="self-center text-[11px] text-zinc-400">Right-click or press and hold an item to edit it.</div></> : <div className="self-center text-[11px] text-zinc-400">Inventory products keep their saved pricing and tracking details.</div>}
      </div> : <div className="mt-2 text-[11px] text-zinc-400">Right-click or press and hold a repair line to edit it.</div>}

      {selectedRow?.purchaseQueueRemovedAt ? (
        <div className="mt-2 flex flex-col gap-2 rounded border border-amber-500/60 bg-amber-950/30 p-3 text-xs text-amber-100 sm:flex-row sm:items-center sm:justify-between">
          <div><strong className="block text-amber-300">Product has not been ordered</strong>{selectedRow.purchaseQueueRemovalNotice || 'This product remains on the sale, but it was removed from the EOD purchasing cart after payment was recorded. Delivery and tracking information are unavailable.'}</div>
          <button type="button" className="shrink-0 rounded bg-amber-500 px-3 py-1.5 font-semibold text-black" onClick={() => onChange(items.map(item => item.id === selectedRow.id ? { ...item, purchaseQueueRemovedAt: undefined, purchaseQueueRemovalNotice: undefined, purchaseQueueRemovalPaymentStatus: undefined } : item))}>Restore to EOD Cart</button>
        </div>
      ) : null}
      </div>

      {editing && !quickCheckout && !editing.inventoryProductId ? <SaleItemDialog
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

      {editing && ((editing: SaleItemRow) => false && (
        <div className="gb-ticket-item-dialog fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-label="Edit sale item" onMouseDown={() => { setEditingError(''); setEditing(null); }}>
        <div className="gb-sale-item-editor max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto bg-zinc-800 border border-zinc-700 rounded p-4 shadow-2xl" onMouseDown={event => event.stopPropagation()}>
          {(() => {
            const inventoryLinked = !!editing.inventoryProductId;
            return <>
          <div className="flex items-center justify-between gap-3 border-b border-zinc-700 pb-3">
            <div className="text-sm font-semibold text-zinc-100">{inventoryLinked ? 'Edit sale item' : 'Add custom sale item'}</div>
            <div className="max-w-[75%] truncate text-[11px] text-zinc-400" title={editing.description || ''}>{editing.description || ''}</div>
            <button type="button" aria-label="Close item popup" className="shrink-0 rounded border border-zinc-600 bg-zinc-900 px-2.5 py-1 text-base leading-none text-zinc-200 hover:border-zinc-400" onClick={() => { setEditingError(''); setEditing(null); }}>×</button>
          </div>

          {inventoryLinked && !isConsultationItem(editing) ? (
            <div className="mt-2 rounded-lg border border-cyan-500/30 bg-cyan-950/20 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">Inventory-linked item</div>
              <div className="mt-1 text-sm font-semibold text-zinc-100">{editing.description || 'Inventory product'}</div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-zinc-300">
                {editing.category ? <span className="rounded-full bg-zinc-900 px-2 py-0.5">{editing.category}</span> : null}
                {editing.condition ? <span className="rounded-full bg-zinc-900 px-2 py-0.5">{editing.condition}</span> : null}
                {editing.distributor ? <span className="rounded-full bg-zinc-900 px-2 py-0.5">{editing.distributor}</span> : null}
              </div>
              <div className="mt-1 text-[10px] text-zinc-400">Catalog details are managed in Admin → Inventory. Quantity, checkout price, availability, and notes remain ticket-specific.</div>
            </div>
          ) : null}

          <div className="gb-sale-item-editor-fields">
          <label className="block text-xs text-zinc-400 mt-2">{isConsultationItem(editing) ? 'Consultation' : 'Item'}</label>
          {inventoryLinked && !isConsultationItem(editing)
            ? <div className="mt-1 rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200">{editing.description}</div>
            : <input className="w-full mt-1 bg-zinc-900 rounded px-2 py-1" value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} />}
          <div className="gb-sale-item-primary-fields flex gap-2 mt-2">
            <div className="w-1/3">
              <label className="block text-xs text-zinc-400">{isConsultationItem(editing) ? 'Hours' : 'Qty'}</label>
              <input
                className="w-full bg-zinc-900 rounded px-2 py-1"
                type="number"
                min={0.25}
                step={isConsultationItem(editing) ? 0.25 : 1}
                value={isConsultationItem(editing) ? (editing.consultationHours ?? editing.qty) : editing.qty}
                onChange={e => {
                  const nextValue = Number(e.target.value);
                  if (isConsultationItem(editing)) {
                    const hours = Number.isFinite(nextValue) && nextValue > 0 ? nextValue : 1;
                    setEditing({ ...editing, consultationHours: hours, qty: hours });
                    return;
                  }
                  setEditing({ ...editing, qty: Number.isFinite(nextValue) && nextValue > 0 ? nextValue : 1 });
                }}
              />
            </div>
            <div className="w-2/3">
              <label className="block text-xs text-zinc-400">{isConsultationItem(editing) ? 'Hourly rate' : 'Price'}</label>
              <MoneyInput
                className="w-full bg-zinc-900 rounded px-2 py-1"
                value={Number(editing.price || 0)}
                onValueChange={(v) => setEditing({ ...editing, price: Number(v || 0) })}
              />
            </div>
          </div>

          {!isConsultationItem(editing) ? <>
          <div className="gb-sale-item-stock-fields flex gap-2 mt-2">
            {!inventoryLinked ? <div className="w-1/2">
              <label className="block text-xs text-zinc-400">Category</label>
              <select
                className="w-full bg-zinc-900 rounded px-2 py-1"
                value={(editing.category || '') as any}
                onChange={e => {
                  const nextCategory = (e.target.value || undefined) as any;
                  if (isConsultationItem({ category: nextCategory })) {
                    const hours = Number(editing.consultationHours ?? editing.qty ?? 1) || 1;
                    const rate = Number(editing.price || 0) > 0 ? Number(editing.price || 0) : 75;
                    setEditing({ ...editing, category: nextCategory, consultationHours: hours, qty: hours, price: rate });
                    return;
                  }
                  setEditing({ ...editing, category: nextCategory });
                }}
              >
                <option value="">—</option>
                <option value="Device">Device</option>
                <option value="Accessory">Accessory</option>
                <option value="Consultation">Consultation</option>
                <option value="Other">Other</option>
              </select>
            </div> : null}
            <div className={inventoryLinked ? 'w-full' : 'w-1/2'}>
              <label className="block text-xs text-zinc-400">In stock</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={!!editing.inStock}
                  onChange={e => setEditing({ ...editing, inStock: e.target.checked, requiresOrder: !e.target.checked, orderStatus: e.target.checked ? 'in_stock' : 'needed' })}
                />
                <span className="text-xs text-zinc-400">Available immediately</span>
              </div>
            </div>
          </div>

          {!inventoryLinked ? <div className="gb-sale-item-cost-fields flex gap-2 mt-2">
            <div className="w-1/2">
              <label className="block text-xs text-zinc-400">Condition</label>
              <select className="w-full bg-zinc-900 rounded px-2 py-1" value={editing.condition || 'New'} onChange={e => setEditing({ ...editing, condition: e.target.value as any })}>
                <option value="New">New</option>
                <option value="Excellent">Excellent</option>
                <option value="Good">Good</option>
                <option value="Fair">Fair</option>
              </select>
            </div>
            <div className="w-1/2">
              <label className="block text-xs text-zinc-400">Supplier item cost</label>
              <MoneyInput
                className="w-full bg-yellow-200 text-black rounded px-2 py-1"
                value={typeof editing.internalCost === 'number' ? editing.internalCost : undefined}
                onValueChange={(v) => {
                  const internalCost = v == null ? undefined : Number(v || 0);
                  const price = markedUpPartPrice(internalCost, editing.markupPct ?? 10);
                  setEditing({ ...editing, internalCost, ...(price == null ? {} : { price }) });
                }}
                allowEmpty
              />
              {editing.requiresOrder ? <div className="mt-1 text-[10px] text-zinc-500">Item price only. Shipping and supplier tax are added during EOD checkout.</div> : null}
            </div>
          </div> : null}
          {!inventoryLinked ? <div className="gb-sale-item-order-fields grid grid-cols-2 gap-2 mt-2">
            <div>
              <label className="block text-xs text-zinc-400">Device Model</label>
              <input className="w-full bg-zinc-900 rounded px-2 py-1" value={editing.deviceModel || ''} onChange={e => setEditing({ ...editing, deviceModel: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Part / Product Category</label>
              <input className="w-full bg-zinc-900 rounded px-2 py-1" value={editing.partCategory || ''} onChange={e => setEditing({ ...editing, partCategory: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Supplier SKU</label>
              <input className="w-full bg-zinc-900 rounded px-2 py-1" value={editing.distributorSku || ''} onChange={e => setEditing({ ...editing, distributorSku: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Markup %</label>
              <input
                type="number"
                min="0"
                step="1"
                className="w-full bg-zinc-900 rounded px-2 py-1"
                value={editing.markupPct ?? 10}
                onChange={e => {
                  const markupPct = e.target.value;
                  const price = markedUpPartPrice(editing.internalCost, markupPct);
                  setEditing({ ...editing, markupPct, ...(price == null ? {} : { price }) });
                }}
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400">Reorder / MOQ</label>
              <input type="number" min="1" step="1" className="w-full bg-zinc-900 rounded px-2 py-1" value={editing.reorderQty || 1} onChange={e => setEditing({ ...editing, reorderQty: Math.max(1, Math.round(Number(e.target.value || 1))) })} />
            </div>
            <label className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">
              <input type="checkbox" checked={(editing.taxExempt ?? editing.vendorTaxExempt) === true} onChange={e => setEditing({ ...editing, taxExempt: e.target.checked, vendorTaxExempt: e.target.checked })} />
              Supplier tax exempt
            </label>
            <div className="col-span-2">
              <label className="block text-xs text-zinc-400">Item Notes</label>
              <textarea className="w-full min-h-[64px] bg-zinc-900 rounded px-2 py-1" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
            </div>
          </div> : (
            <div className="mt-2">
              <label className="block text-xs text-zinc-400">Item Notes</label>
              <textarea className="mt-1 w-full min-h-[64px] bg-zinc-900 rounded px-2 py-1" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
            </div>
          )}
          </> : null}
          {isConsultationItem(editing) ? (
            <div className="mt-2 space-y-2">
              <div>
                <label className="block text-xs text-zinc-400">Consultation Notes</label>
                <textarea className="mt-1 w-full min-h-[80px] bg-zinc-900 rounded px-2 py-1" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
              </div>
              <div className="text-[11px] text-zinc-400">
                The customer hourly rate is editable. Technician commission remains based on saved hours at the configured $25 per hour, independent of the customer rate.
              </div>
            </div>
          ) : null}
          {!isConsultationItem(editing) ? <div className="mt-2">
            <label className="block text-xs text-zinc-400">Product URL</label>
            <input
              className="w-full bg-zinc-900 rounded px-2 py-1"
              type="url"
              placeholder="https://..."
              value={editing.productUrl || ''}
              onChange={e => setEditing({ ...editing, productUrl: e.target.value })}
              onBlur={e => { if (e.currentTarget.value.trim()) void autofillProductOrderDetails(e.currentTarget.value); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void autofillProductOrderDetails(e.currentTarget.value); } }}
            />
            {scrapingProductUrl ? <div className="mt-1 text-[10px] text-[#39FF14]">Reading supplier details...</div> : null}
          </div> : null}
          {!isConsultationItem(editing) && editing.requiresOrder ? (
            <div className="mt-2">
              <label className="block text-xs text-zinc-400">Distributor</label>
              <input
                className="w-full bg-zinc-900 rounded px-2 py-1"
                value={editing.distributor || ''}
                onChange={e => setEditing({ ...editing, distributor: e.target.value })}
                placeholder="Distributor name"
              />
            </div>
          ) : null}
          {editingError ? <div className="mt-2 rounded border border-red-700 bg-red-950/40 px-3 py-2 text-xs text-red-200">{editingError}</div> : null}
          </div>
          <div className="gb-sale-item-editor-actions flex gap-2 mt-2 justify-end">
            <button
              className="px-3 py-1 bg-zinc-800 rounded"
              onClick={() => { setEditingError(''); setEditing(null); }}
            >
              Cancel
            </button>
            <button
              className="px-3 py-1 bg-brand text-black rounded"
              onClick={() => {
                if (!isConsultationItem(editing) && editing.requiresOrder && (editing.internalCost === undefined || !Number.isFinite(Number(editing.internalCost)) || Number(editing.internalCost) < 0)) {
                  setEditingError('Enter the supplier item cost before shipping and tax.');
                  return;
                }
                if (!isConsultationItem(editing) && editing.requiresOrder && !String(editing.distributor || '').trim() && !String(editing.productUrl || '').trim()) {
                  setEditingError('Enter a distributor or product URL so the EOD Cart can group this product.');
                  return;
                }
                const consultation = isConsultationItem(editing);
                const distributor = consultation ? editing.distributor : (String(editing.distributor || '').trim() || derivePartVendorFromUrl(editing.productUrl));
                const saved = consultation
                  ? { ...editing, inStock: true, requiresOrder: false, orderStatus: 'in_stock' as const }
                  : { ...editing, distributor, orderStatus: editing.requiresOrder ? (editing.orderStatus || 'needed') : 'in_stock' as const };
                const nextItems = items.map(i => (i.id === editing.id ? saved : i));
                setEditingError('');
                onChange(nextItems);
                void onCommit?.(nextItems);
                setEditing(null);
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
      {splitLayout && !editing ? (
        <div className="gb-sale-items-empty-editor flex min-h-[16rem] items-center justify-center rounded border border-dashed border-zinc-700 bg-zinc-950/30 p-6 text-center text-sm text-zinc-400">
          Select a checkout line to review or temporarily edit its details.
        </div>
      ) : null}
      </div>

      <ContextMenu
        id="sale-items-ctx"
        open={ctx.state.open}
        x={ctx.state.x}
        y={ctx.state.y}
        items={ctxItems}
        onClose={ctx.close}
        zIndex={100600}
      />
      {discounting ? <LineDiscountDialog title={discounting.description} gross={effectiveUnits(discounting) * (Number(discounting.price) || 0)} value={discounting} onClose={() => setDiscounting(null)} onApply={discount => { const next = items.map(item => item.id === discounting.id ? { ...item, discountType: discount.discountType, discountValue: discount.discountValue } : item); onChange(next); void onCommit?.(next); setDiscounting(null); }} /> : null}
    </div>
  );
};

export default React.memo(SaleItemsTable);
