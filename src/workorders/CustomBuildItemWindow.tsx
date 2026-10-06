import React, { useEffect, useMemo, useState } from 'react';
import MoneyInput from '../components/MoneyInput';
import { derivePartVendorFromUrl, markedUpPartPrice, normalizePartOrderUrl, scrapePartUrl } from '../lib/partOrdering';

export type CustomBuildItemPayload = {
  title?: string;
  item?: Partial<CustomBuildItemResult> | null;
};

export type CustomBuildItemResult = {
  description: string;
  itemType: 'part' | 'labor';
  quantity: number;
  price: number;
  internalCost?: number;
  partSource?: string;
  distributorSku?: string;
  orderSourceUrl?: string;
  partSourceKind?: 'stock' | 'order' | 'client';
  addToEodCart?: boolean;
  salvagedPart?: boolean;
  requiresOrder?: boolean;
  orderStatus?: 'needed' | 'ordered' | 'received' | 'in_stock';
  orderDate?: string;
  estimatedDeliveryDate?: string;
  trackingUrl?: string;
};

function parsePayload(): CustomBuildItemPayload {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('customBuildItem');
    if (!raw) return {};
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return {};
  }
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

type PartSource = 'stock' | 'order' | 'client';

const CustomBuildItemWindow: React.FC = () => {
  const payload = useMemo(() => parsePayload(), []);
  const existing = payload?.item || null;

  const [description, setDescription] = useState<string>(String(existing?.description || ''));
  const [price, setPrice] = useState<number>(
    existing?.price != null && Number.isFinite(Number(existing.price)) ? round2(Number(existing.price)) : 0
  );
  const [itemType, setItemType] = useState<'part' | 'labor'>(existing?.itemType === 'labor' ? 'labor' : 'part');
  const [quantity, setQuantity] = useState(Math.max(1, Number(existing?.quantity || 1) || 1));
  const [internalCost, setInternalCost] = useState(Math.max(0, Number(existing?.internalCost || 0) || 0));
  const [partSource, setPartSource] = useState(String(existing?.partSource || ''));
  const [distributorSku, setDistributorSku] = useState(String(existing?.distributorSku || ''));
  const [orderSourceUrl, setOrderSourceUrl] = useState(String(existing?.orderSourceUrl || ''));
  const [source, setSource] = useState<PartSource>(existing?.partSourceKind || (existing?.requiresOrder ? 'order' : 'stock'));
  const [addToEodCart, setAddToEodCart] = useState(existing?.addToEodCart ?? existing?.requiresOrder === true);
  const [salvagedPart, setSalvagedPart] = useState(existing?.salvagedPart === true);
  const [scrapingOrderUrl, setScrapingOrderUrl] = useState(false);
  const [error, setError] = useState('');

  const validUrl = (value: string) => !value.trim() || /^https?:\/\//i.test(value.trim());
  const canSave = description.trim().length > 0 && price >= 0 && quantity > 0
    && (itemType === 'labor' || validUrl(orderSourceUrl))
    && (itemType === 'labor' || source !== 'order' || !addToEodCart || (partSource.trim().length > 0 && orderSourceUrl.trim().length > 0));

  useEffect(() => {
    try {
      document.title = payload?.title ? String(payload.title) : 'Custom Build Item';
    } catch {}
  }, [payload?.title]);

  async function autofillOrderDetails(rawUrl: string) {
    const normalized = normalizePartOrderUrl(rawUrl);
    if (!normalized) return;
    setOrderSourceUrl(normalized);
    setScrapingOrderUrl(true);
    try {
      const metadata = await scrapePartUrl(normalized);
      if (!metadata) return;
      const detectedVendor = String(metadata.vendor || derivePartVendorFromUrl(normalized) || '').trim();
      if (detectedVendor) setPartSource((current) => current || detectedVendor);
      const detectedSku = (metadata.specs || []).find((spec) => /^(sku|item\s*(?:#|number)|part\s*(?:#|number)|mpn)$/i.test(String(spec?.name || '').trim()))?.value;
      if (detectedSku) setDistributorSku((current) => current || String(detectedSku));
      if (metadata.price != null && Number.isFinite(Number(metadata.price))) {
        const cost = round2(Number(metadata.price));
        setInternalCost(cost);
        setPrice((current) => current > 0 ? current : round2(markedUpPartPrice(cost) ?? cost));
      }
    } catch {
      // The URL remains usable even when a supplier blocks metadata lookup.
    } finally {
      setScrapingOrderUrl(false);
    }
  }

  function chooseSource(next: PartSource) {
    setSource(next);
    setError('');
    if (next === 'order') setAddToEodCart(true);
    if (next !== 'stock') setSalvagedPart(false);
  }

  function save() {
    if (!canSave) {
      setError(source === 'order' && addToEodCart
        ? 'Supplier, Order URL, and a valid line item are required before adding this build part to the EOD Cart.'
        : 'Enter a description and valid line-item values.');
      return;
    }
    const res: CustomBuildItemResult = {
      description: description.trim(),
      itemType,
      quantity: itemType === 'part' ? quantity : 1,
      price,
      ...(itemType === 'part' ? {
        internalCost,
        partSource: source === 'stock' ? 'Shop inventory' : source === 'client' ? 'Client provided' : partSource.trim(),
        distributorSku: distributorSku.trim(),
        orderSourceUrl: orderSourceUrl.trim(),
        partSourceKind: source,
        addToEodCart: source === 'order' && addToEodCart,
        salvagedPart: source === 'stock' && salvagedPart,
        orderStatus: source === 'order' && addToEodCart ? 'needed' : 'in_stock',
      } : {}),
    };
    (window as any).api?._emitCustomBuildItemSave?.(res);
  }

  function cancel() {
    (window as any).api?._emitCustomBuildItemCancel?.();
  }

  return <div className="min-h-[calc(100dvh-2rem)] w-screen bg-zinc-900 p-4 text-zinc-100">
    <div className="mx-auto flex min-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-[#17171c] shadow-2xl">
      <header className="flex items-start justify-between gap-4 border-b border-zinc-700 bg-[#1d1d23] px-5 py-4">
        <div><h1 className="text-lg font-semibold text-[#39ff14]">{payload?.title || 'Build line item'}</h1><p className="mt-1 text-xs text-zinc-400">Custom PC Build · parts follow the same supplier and EOD workflow as regular work orders.</p></div>
        <button type="button" aria-label="Close Custom Build item" className="h-9 w-9 shrink-0 rounded-lg border border-zinc-600 bg-zinc-900 text-xl leading-none text-zinc-200" onClick={cancel}>×</button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="sm:col-span-2"><span className="text-xs font-semibold text-zinc-300">Component / labor description <b className="text-pink-300">Required</b></span><input autoFocus className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" placeholder="e.g. RTX 4070 SUPER, 32GB DDR5 RAM, Assembly labor" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label><span className="text-xs font-semibold text-zinc-300">Item type <b className="text-pink-300">Required</b></span><select className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={itemType} onChange={(event) => setItemType(event.target.value as 'part' | 'labor')}><option value="part">Part (taxed)</option><option value="labor">Labor (not taxed)</option></select></label>
        </div>
        <section className="mt-5 border-t border-zinc-700 pt-4"><div className="grid grid-cols-1 gap-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-3 sm:grid-cols-3"><label><span className="text-xs font-semibold text-zinc-300">Customer price <b className="text-pink-300">Required</b></span><MoneyInput className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={price} onValueChange={(value) => setPrice(round2(Number(value || 0)))} /></label>{itemType === 'part' ? <label><span className="text-xs font-semibold text-zinc-300">Quantity <b className="text-pink-300">Required</b></span><input type="number" min="1" className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={quantity} onChange={(event) => setQuantity(Math.max(1, Number(event.target.value || 1)))} /></label> : null}<div className="flex flex-col justify-end pb-1"><span className="text-xs text-zinc-400">Line total</span><strong className="text-2xl text-[#39ff14]">${(price * (itemType === 'part' ? quantity : 1)).toFixed(2)}</strong></div></div></section>
        {itemType === 'part' ? <section className="mt-5 border-t border-zinc-700 pt-4"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold">Part source</h2><span className="text-xs text-zinc-400">Select a source to change the fields below.</span></div><div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{([['stock', 'Shop inventory'], ['order', 'Order from supplier'], ['client', 'Client provided']] as [PartSource, string][]).map(([value, label]) => <button key={value} type="button" onClick={() => chooseSource(value)} className={`rounded-lg border px-3 py-2.5 text-left text-sm ${source === value ? 'border-violet-400 bg-violet-950/50 text-white' : 'border-zinc-700 bg-zinc-800 text-zinc-300'}`}>{label}</button>)}</div><div className="mt-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-4">
          {source === 'stock' ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><label className={salvagedPart ? 'opacity-35' : ''}><span className="text-xs font-semibold text-zinc-300">Our part cost</span><MoneyInput disabled={salvagedPart} className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={internalCost} onValueChange={(value) => setInternalCost(round2(Number(value || 0)))} /></label><label className="sm:col-span-2 flex cursor-pointer items-center gap-3 rounded-lg border border-violet-500/60 bg-violet-950/40 px-3 py-2.5 text-sm"><input type="checkbox" checked={salvagedPart} onChange={(event) => setSalvagedPart(event.target.checked)} /><span><strong>Salvaged spare part</strong><small className="ml-2 text-zinc-300">No supplier transaction or EOD Cart entry.</small></span></label></div> : null}
          {source === 'order' ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><label><span className="text-xs font-semibold text-zinc-300">Our part cost <b className="text-pink-300">Required</b></span><MoneyInput className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={internalCost} onValueChange={(value) => setInternalCost(round2(Number(value || 0)))} /></label><label><span className="text-xs font-semibold text-zinc-300">Supplier <b className="text-pink-300">Required</b></span><input className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={partSource} onChange={(event) => setPartSource(event.target.value)} /></label><label><span className="text-xs font-semibold text-zinc-300">Supplier SKU</span><input className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" value={distributorSku} onChange={(event) => setDistributorSku(event.target.value)} /></label><label className="sm:col-span-3 flex cursor-pointer items-center gap-3 rounded-lg border border-amber-500/60 bg-amber-950/30 px-3 py-2.5 text-sm"><input type="checkbox" checked={addToEodCart} onChange={(event) => setAddToEodCart(event.target.checked)} /><span><strong>Add to EOD cart</strong><small className="ml-2 text-zinc-300">On by default. EOD checkout records the actual order date and ETA.</small></span></label><label className="sm:col-span-3"><span className="text-xs font-semibold text-zinc-300">Order URL <b className="text-pink-300">Required when added to cart</b>{scrapingOrderUrl ? <em className="ml-2 text-sky-300">Checking supplier…</em> : null}</span><div className="mt-1.5 flex gap-2"><input type="url" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5" placeholder="Paste exact product page" value={orderSourceUrl} onChange={(event) => setOrderSourceUrl(event.target.value)} onBlur={(event) => { if (event.currentTarget.value.trim()) void autofillOrderDetails(event.currentTarget.value); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void autofillOrderDetails(event.currentTarget.value); } }} />{orderSourceUrl ? <button type="button" className="rounded-lg border border-violet-500/70 bg-violet-950/40 px-3 text-sm font-semibold text-violet-100" onClick={() => void (window as any).api?.openUrl?.(normalizePartOrderUrl(orderSourceUrl))}>Open URL</button> : null}</div></label></div> : null}
          {source === 'client' ? <p className="text-sm text-zinc-300">Client-provided part: this component is saved to the build, but never added to the EOD Cart.</p> : null}
        </div></section> : null}
        {error ? <div className="mt-4 rounded-lg border border-pink-500/70 bg-pink-950/50 px-3 py-2 text-sm text-pink-100">{error}</div> : null}
      </main>
      <footer className="flex justify-end gap-3 border-t border-zinc-700 bg-[#141418] px-5 py-4"><button type="button" className="rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm" onClick={cancel}>Cancel</button><button type="button" className={`rounded-lg px-4 py-2 text-sm font-bold ${canSave ? 'bg-[#39ff14] text-black' : 'cursor-not-allowed bg-zinc-800 text-zinc-500'}`} onClick={save} disabled={!canSave}>Save item</button></footer>
    </div>
  </div>;
};

export default CustomBuildItemWindow;
