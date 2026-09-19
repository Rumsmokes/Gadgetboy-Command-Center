import React, { useEffect, useMemo, useState } from 'react';
import MoneyInput from '@/components/MoneyInput';
import type { WorkOrderItemRow } from './ItemsTable';

type ItemType = 'both' | 'part' | 'labor' | 'fee';
type Source = 'stock' | 'order' | 'client';

function initialItemType(item: WorkOrderItemRow): ItemType {
  if (item.itemType) return item.itemType;
  if (Number(item.parts || 0) > 0 && Number(item.labor || 0) > 0) return 'both';
  if (Number(item.parts || 0) > 0) return 'part';
  if (Number(item.labor || 0) > 0) return 'labor';
  return 'both';
}

function initialSource(item: WorkOrderItemRow): Source {
  if (item.partSourceKind) return item.partSourceKind;
  if (item.requiresOrder) return 'order';
  if (String(item.partSource || '').toLowerCase().includes('client')) return 'client';
  return 'stock';
}

export default function WorkOrderItemDialog({ item, onClose, onSave }: {
  item: WorkOrderItemRow;
  onClose: () => void;
  onSave: (item: WorkOrderItemRow) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<WorkOrderItemRow>({ ...item });
  const [itemType, setItemType] = useState<ItemType>(() => initialItemType(item));
  const [source, setSource] = useState<Source>(() => initialSource(item));
  const [salvaged, setSalvaged] = useState(!!item.salvagedPart);
  const [error, setError] = useState('');

  useEffect(() => { setDraft({ ...item }); setItemType(initialItemType(item)); setSource(initialSource(item)); setSalvaged(!!item.salvagedPart); setError(''); }, [item]);

  const hasPart = itemType === 'both' || itemType === 'part';
  const hasLabor = itemType === 'both' || itemType === 'labor';
  const clientPrice = useMemo(() => itemType === 'fee' ? Number(draft.labor || 0) : Number(draft.parts || 0) + Number(draft.labor || 0), [draft.labor, draft.parts, itemType]);
  const update = (patch: Partial<WorkOrderItemRow>) => setDraft(current => ({ ...current, ...patch }));

  async function save() {
    if (!String(draft.repair || '').trim()) { setError('Enter a repair or item description.'); return; }
    if (hasPart && source === 'order' && (!Number.isFinite(Number(draft.internalCost)) || Number(draft.internalCost) < 0 || !String(draft.distributor || '').trim() || !String(draft.orderSourceUrl || '').trim() || !draft.orderDate || !draft.estimatedDeliveryDate)) {
      setError('Supplier cost, supplier, order URL, order date, and estimated delivery are required for an ordered part.'); return;
    }
    if (hasPart && source === 'client' && !String(draft.note || '').trim()) { setError('Describe the client-provided part.'); return; }
    const next: WorkOrderItemRow = {
      ...draft,
      itemType,
      partSourceKind: hasPart ? source : undefined,
      salvagedPart: hasPart && source === 'stock' && salvaged,
      requiresOrder: hasPart && source === 'order',
      orderStatus: hasPart && source === 'order' ? (draft.orderStatus || 'needed') : 'in_stock',
      partSource: hasPart ? (source === 'stock' ? 'Shop inventory' : source === 'order' ? (draft.distributor || 'Order from supplier') : 'Client provided') : undefined,
      parts: hasPart ? Number(draft.parts || 0) : 0,
      labor: itemType === 'fee' ? Number(draft.labor || 0) : hasLabor ? Number(draft.labor || 0) : 0,
      internalCost: hasPart && source === 'stock' && salvaged ? undefined : draft.internalCost,
    };
    setError('');
    try {
      await onSave(next);
    } catch (saveError: any) {
      setError(saveError?.message || 'The work-order item could not be saved.');
    }
  }

  return <div className="gb-ticket-item-dialog fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-label="Custom work-order item" onMouseDown={onClose}>
    <div className="max-h-[calc(100dvh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl border border-zinc-700 bg-[#17171c] shadow-2xl" onMouseDown={event => event.stopPropagation()}>
      <header className="flex items-start justify-between gap-4 border-b border-zinc-700 bg-[#1d1d23] px-5 py-4">
        <div><h2 className="text-lg font-semibold text-zinc-100">Add custom work-order item</h2><p className="mt-1 text-xs text-zinc-400">Part-source choices stay at the top; only their relevant details appear below.</p></div>
        <button type="button" aria-label="Close item popup" className="h-9 w-9 shrink-0 rounded-lg border border-zinc-600 bg-zinc-900 text-xl leading-none text-zinc-200" onClick={onClose}>×</button>
      </header>
      <div className="p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="sm:col-span-2"><span className="text-xs font-semibold text-zinc-300">Repair / item description <b className="text-pink-300">Required</b></span><input className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.repair || ''} onChange={event => update({ repair: event.target.value })} /></label>
          <label><span className="text-xs font-semibold text-zinc-300">Item type <b className="text-pink-300">Required</b></span><select className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={itemType} onChange={event => setItemType(event.target.value as ItemType)}><option value="both">Part + labor</option><option value="part">Part only</option><option value="labor">Labor only</option><option value="fee">Fee</option></select></label>
        </div>

        <section className="mt-5 border-t border-zinc-700 pt-4"><div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold">{itemType === 'fee' ? 'Fee' : 'Client price'}</h3><span className="text-xs text-zinc-400">{itemType === 'both' ? 'Part charge + labor charge' : itemType === 'part' ? 'Part charge only' : itemType === 'labor' ? 'Labor charge only' : 'Enter the fee amount'}</span></div>
          <div className="grid grid-cols-1 gap-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-3 sm:grid-cols-3">
            {hasPart ? <label><span className="text-xs font-semibold text-zinc-300">Part charge to client <b className="text-pink-300">Required</b></span><MoneyInput className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={Number(draft.parts || 0)} onValueChange={value => update({ parts: Number(value || 0) })} /></label> : null}
            {hasLabor || itemType === 'fee' ? <label><span className="text-xs font-semibold text-zinc-300">{itemType === 'fee' ? 'Fee charge' : 'Labor charge to client'} <b className="text-pink-300">Required</b></span><MoneyInput className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={Number(draft.labor || 0)} onValueChange={value => update({ labor: Number(value || 0) })} /></label> : null}
            <div className="flex flex-col justify-end pb-1"><span className="text-xs text-zinc-400">Client price</span><strong className="text-2xl text-[#39ff14]">${clientPrice.toFixed(2)}</strong></div>
          </div>
        </section>

        {hasPart ? <section className="mt-5 border-t border-zinc-700 pt-4"><div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold">Part source</h3><span className="text-xs text-zinc-400">Select a source to change the fields below.</span></div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{([['stock', 'Shop inventory'], ['order', 'Order from supplier'], ['client', 'Client provided']] as [Source, string][]).map(([value, label]) => <button key={value} type="button" onClick={() => setSource(value)} className={`rounded-lg border px-3 py-2.5 text-left text-sm ${source === value ? 'border-violet-400 bg-violet-950/50 text-white' : 'border-zinc-700 bg-zinc-800 text-zinc-300'}`}>{label}</button>)}</div>
          <div className="mt-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-4">
            {source === 'stock' ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><label className={salvaged ? 'opacity-35' : ''}><span className="text-xs font-semibold text-zinc-300">Our part cost</span><MoneyInput disabled={salvaged} className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.internalCost} onValueChange={value => update({ internalCost: value == null ? undefined : Number(value) })} allowEmpty /></label><label className={salvaged ? 'sm:col-span-2 opacity-35' : 'sm:col-span-2'}><span className="text-xs font-semibold text-zinc-300">Inventory item</span><input disabled={salvaged} className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.inventoryItemName || ''} onChange={event => update({ inventoryItemName: event.target.value })} placeholder="Select exact inventory item…" /></label><label><span className="text-xs font-semibold text-zinc-300">Quantity used <b className="text-pink-300">Required</b></span><input type="number" min="1" className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.quantity || 1} onChange={event => update({ quantity: Math.max(1, Number(event.target.value || 1)) })} /></label><label className="sm:col-span-3 flex cursor-pointer items-center gap-3 rounded-lg border border-violet-500/60 bg-violet-950/40 px-3 py-2.5 text-sm"><input type="checkbox" checked={salvaged} onChange={event => setSalvaged(event.target.checked)} /><span><strong>Salvaged spare part</strong><small className="ml-2 text-zinc-300">Cost and inventory item are not required; only quantity used is.</small></span></label></div> : null}
            {source === 'order' ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><label><span className="text-xs font-semibold text-zinc-300">Our part cost <b className="text-pink-300">Required</b></span><MoneyInput className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.internalCost} onValueChange={value => update({ internalCost: value == null ? undefined : Number(value) })} allowEmpty /></label><label><span className="text-xs font-semibold text-zinc-300">Supplier <b className="text-pink-300">Required</b></span><input className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.distributor || ''} onChange={event => update({ distributor: event.target.value })} /></label><label><span className="text-xs font-semibold text-zinc-300">Order date <b className="text-pink-300">Required</b></span><input type="date" className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.orderDate || ''} onChange={event => update({ orderDate: event.target.value })} /></label><label className="sm:col-span-2"><span className="text-xs font-semibold text-zinc-300">Order URL <b className="text-pink-300">Required</b></span><input type="url" className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.orderSourceUrl || ''} onChange={event => update({ orderSourceUrl: event.target.value })} placeholder="Paste exact product page" /></label><label><span className="text-xs font-semibold text-zinc-300">Estimated arrival <b className="text-pink-300">Required</b></span><input type="date" className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.estimatedDeliveryDate || ''} onChange={event => update({ estimatedDeliveryDate: event.target.value })} /></label><label><span className="text-xs font-semibold text-zinc-300">Supplier order #</span><input className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.distributorSku || ''} onChange={event => update({ distributorSku: event.target.value })} /></label><label className="sm:col-span-2"><span className="text-xs font-semibold text-zinc-300">Tracking URL</span><input type="url" className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.trackingUrl || ''} onChange={event => update({ trackingUrl: event.target.value })} /></label></div> : null}
            {source === 'client' ? <label><span className="text-xs font-semibold text-zinc-300">Client-provided part note <b className="text-pink-300">Required</b></span><input className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={draft.note || ''} onChange={event => update({ note: event.target.value })} placeholder="Describe exact part received" /></label> : null}
          </div>
        </section> : null}
        {error ? <div className="mt-4 rounded-lg border border-pink-500/70 bg-pink-950/50 px-3 py-2 text-sm text-pink-100">{error}</div> : null}
      </div>
      <footer className="flex justify-end gap-3 border-t border-zinc-700 bg-[#141418] px-5 py-4"><button type="button" className="rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm" onClick={onClose}>Cancel</button><button type="button" className="rounded-lg bg-[#39ff14] px-4 py-2 text-sm font-bold text-black" onClick={() => void save()}>Save item</button></footer>
    </div>
  </div>;
}
