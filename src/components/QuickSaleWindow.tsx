import React, { useEffect, useMemo, useState } from 'react';
import { computeTotals, round2 } from '@/lib/calc';
import SaleItemsTable, { SaleItemRow } from '@/sales/SaleItemsTable';
import { consumeInStockInventory } from '@/lib/inventoryConsumption';
import { finishSuccessfulQuickCheckout } from '@/lib/quickCheckoutLifecycle';

const TAX_RATE = 8;

function itemUnits(row: Partial<SaleItemRow> | null | undefined): number {
  const category = String(row?.category || '').trim().toLowerCase();
  if (category === 'consultation' || category.startsWith('consult')) {
    const hours = Number(row?.consultationHours ?? row?.qty ?? 0);
    return Number.isFinite(hours) && hours > 0 ? hours : 0;
  }
  const qty = Number(row?.qty ?? 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function itemTotal(row: Partial<SaleItemRow> | null | undefined): number {
  return round2(itemUnits(row) * (Number(row?.price) || 0));
}

function newLineId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `qs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function repairPrice(repair: any): number {
  const partCost = Math.max(0, Number(repair?.partCost) || 0);
  const laborCost = Math.max(0, Number(repair?.laborCost) || 0);
  const markupPct = Math.max(0, Number(repair?.markupPct) || 0);
  return round2(laborCost + partCost * (1 + markupPct / 100));
}

const QuickSaleWindow: React.FC = () => {
  const api = (window as any)?.api as any;
  const isModalShell = useMemo(() => {
    try { return !!document.querySelector('[data-modal-shell="1"]'); } catch { return false; }
  }, []);
  const [saleItems, setSaleItems] = useState<SaleItemRow[]>([]);
  const [repairLines, setRepairLines] = useState<SaleItemRow[]>([]);
  const [checkoutType, setCheckoutType] = useState<'sale' | 'repair'>('sale');
  const [repairItems, setRepairItems] = useState<any[]>([]);
  const [repairSearch, setRepairSearch] = useState('');
  const [taxed, setTaxed] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);

  const items = checkoutType === 'sale' ? saleItems : repairLines;
  const setItems = checkoutType === 'sale' ? setSaleItems : setRepairLines;

  useEffect(() => {
    if (!api?.dbGet) return;
    api.dbGet('repairCategories')
      .then((rows: any) => setRepairItems(Array.isArray(rows) ? rows : []))
      .catch(() => setRepairItems([]));
  }, [api]);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyHeight = body.style.height;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    body.style.height = '100%';
    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.height = previousBodyHeight;
    };
  }, []);

  const visibleRepairItems = useMemo(() => {
    const query = repairSearch.trim().toLowerCase();
    const rows = repairItems.filter((repair) => {
      if (!query) return true;
      return [repair?.title, repair?.altDescription, repair?.repairCategory, repair?.category]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
    return rows.sort((a, b) => String(a?.repairCategory || '').localeCompare(String(b?.repairCategory || ''))
      || String(a?.title || '').localeCompare(String(b?.title || '')));
  }, [repairItems, repairSearch]);

  const subTotal = useMemo(() => round2(items.reduce((sum, item) => sum + itemTotal(item), 0)), [items]);
  const taxRate = taxed ? TAX_RATE : 0;
  const totals = useMemo(
    () => computeTotals({ laborCost: 0, partCosts: subTotal, discount: 0, taxRate, amountPaid: 0 }),
    [subTotal, taxRate]
  );

  const canCheckout = !busy
    && items.length > 0
    && subTotal > 0
    && items.every((item) => String(item.description || '').trim() && itemUnits(item) > 0 && Number(item.price) >= 0);

  async function closeSelf() {
    if (api?.closeSelfWindow) return api.closeSelfWindow({ focusMain: true });
    window.close();
    return { ok: true };
  }

  function addRepair(repair: any) {
    const description = String(repair?.title || repair?.altDescription || 'Repair').trim();
    const row: SaleItemRow = {
      id: newLineId(),
      description,
      qty: 1,
      price: repairPrice(repair),
      internalCost: Number(repair?.internalCost ?? repair?.partCost) || 0,
      inStock: repair?.trackStock ? Number(repair?.stockCount) > 0 : !repair?.orderSourceUrl,
      productUrl: String(repair?.orderSourceUrl || '').trim(),
      category: 'Repair',
      distributor: String(repair?.partSource || '').trim(),
      trackStock: repair?.trackStock === true,
      inventoryProductId: repair?.inventoryProductId,
      ...(repair?.orderSourceUrl ? { requiresOrder: true, orderStatus: 'needed' } : {}),
    } as SaleItemRow;
    setRepairLines((current) => [...current, row].slice(0, 20));
  }

  async function handleCheckout() {
    if (!canCheckout) return;
    setBusy(true);
    try {
      if (!api?.openCheckout) {
        alert('Quick Sale requires the desktop app (window.api unavailable).');
        return;
      }

      const result = await api.openCheckout({ amountDue: totals.total || 0 });
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
                return isCash
                  ? (Number.isFinite(tendered) ? tendered : Number(result.amountPaid || 0) || 0)
                  : (Number(result.amountPaid || 0) || 0);
              })(),
              tendered: result.tendered,
              change: result.changeDue,
            },
          ];

      const amountPaid = round2(normalizedLines.reduce((sum: number, p: any) => sum + (Number(p?.applied) || 0), 0));
      const paymentType = result.paymentType;
      const totalsAfter = computeTotals({ laborCost: 0, partCosts: subTotal, discount: 0, taxRate, amountPaid });
      const remainingAfter = round2(Math.max(0, totalsAfter.remaining || 0));
      const shouldClose = remainingAfter <= 0 || !!result.markClosed;

      const now = new Date().toISOString();
      const normalizedItems = items.map((item) => ({
        ...item,
        id: item.id || newLineId(),
        description: String(item.description || '').trim(),
        qty: itemUnits(item) || 1,
        price: Number(item.price || 0) || 0,
      }));
      const firstItem = normalizedItems[0];

      const payments = (amountPaid > 0)
        ? normalizedLines
            .map((p: any) => {
              const pt = String(p?.paymentType || '');
              const isCash = pt.toLowerCase().includes('cash');
              const applied = round2(Number(p?.applied || 0) || 0);
              if (!(applied > 0)) return null;

              const tendered = Number(p?.tendered ?? p?.amount ?? applied);
              const change = Number(p?.change ?? 0);
              const entry: any = {
                amount: isCash ? (Number.isFinite(tendered) ? tendered : applied) : applied,
                applied,
                paymentType: pt,
                at: now,
              };
              if (isCash) entry.change = Number.isFinite(change) ? Math.max(0, change) : 0;
              return entry;
            })
            .filter(Boolean)
        : [];

      const saleRecord: any = {
        createdAt: now,
        updatedAt: now,
        customerId: 0,
        customerName: checkoutType === 'repair' ? 'Quick Repair' : 'Quick Sale',
        customerPhone: '',
        itemDescription: firstItem?.description || (checkoutType === 'repair' ? 'Quick Repair' : 'Quick Sale'),
        quantity: firstItem ? itemUnits(firstItem) || 1 : 1,
        price: Number(firstItem?.price || 0) || 0,
        items: normalizedItems,
        inStock: normalizedItems.every((item) => !!item.inStock),
        notes: checkoutType === 'repair' ? 'Quick Checkout - Repair' : 'Quick Checkout - Sale',
        quickCheckoutType: checkoutType,
        status: shouldClose ? 'closed' : 'open',
        assignedTo: 'Quick Checkout',
        checkInAt: now,
        repairCompletionDate: null,
        checkoutDate: shouldClose ? now : null,
        discount: 0,
        amountPaid,
        paymentType,
        payments,
        taxRate,
        laborCost: 0,
        partCosts: subTotal,
        totals: totalsAfter,
        total: totalsAfter.total,
      };

      const created = await api.dbAdd('sales', saleRecord);
      if (created?.id && amountPaid > 0) {
        const inventoryResult = await consumeInStockInventory(api, 'sale', Number(created.id), normalizedItems, { allowShortfall: true });
        if (inventoryResult.shortfalls.length) {
          alert('Checkout was saved, but one or more tracked products reached zero inventory. Review Inventory for restocking.');
        }
      }

      if (result.printReceipt) {
        try {
          const receiptPayload = {
            receiptType: 'sale',
            id: created?.id,
            customerId: 0,
            customerName: checkoutType === 'repair' ? 'Quick Repair' : 'Quick Sale',
            customerPhone: '',
            customerEmail: '',
            paymentType,
            payments,
            productCategory: checkoutType === 'repair' ? 'Repair' : 'Retail',
            productDescription: firstItem?.description || (checkoutType === 'repair' ? 'Quick Repair' : 'Quick Sale'),
            items: normalizedItems.map((item) => ({
              id: item.id,
              description: item.description,
              qty: itemUnits(item) || 1,
              price: Number(item.price) || 0,
            })),
            partCosts: subTotal,
            laborCost: 0,
            discount: 0,
            taxRate,
            totals: totalsAfter,
            amountPaid,
          };
          if (api?.openCustomerReceipt) {
            await api.openCustomerReceipt({
              data: receiptPayload,
              autoPrint: true,
              silent: true,
              autoCloseMs: 900,
              show: false,
            });
          }
        } catch (e) {
          console.error('QuickSale receipt failed', e);
        }
      }

      try { window.opener?.postMessage({ type: 'sales:changed', customerId: 0 }, '*'); } catch {}
      setItems([]);
      await finishSuccessfulQuickCheckout(closeSelf, () => window.close());
    } catch (e) {
      console.error('QuickSale checkout failed', e);
      alert('Checkout failed. See console.\n\nTip: if this window was opened outside the desktop app, it will not have checkout support.');
    } finally {
      setBusy(false);
    }
  }

  if (!api) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 font-sans p-6">
        <div className="max-w-xl mx-auto bg-zinc-950/40 border border-zinc-800 rounded p-5">
          <div className="text-xl font-bold text-[#39FF14]">Quick Checkout</div>
          <div className="text-sm text-zinc-300 mt-2">
            Quick Checkout requires the Electron desktop app (missing <code>window.api</code> bridge).
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gb-quick-checkout flex min-h-0 flex-col overflow-hidden bg-zinc-900 text-zinc-100 font-sans">
      <div className="gb-quick-checkout-header shrink-0 p-4 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#39FF14]">Quick Checkout</h1>
          <div className="text-xs text-zinc-400">Create a sale or repair checkout without customer info</div>
        </div>
      </div>

      <div className="gb-quick-checkout-layout grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden p-4">
        <div className="gb-quick-checkout-mode flex items-center gap-1 self-start rounded border border-zinc-700 bg-zinc-950/40 p-1">
          {(['sale', 'repair'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setCheckoutType(type)}
              className={`px-4 py-2 rounded text-sm font-semibold ${checkoutType === type ? 'bg-[#39FF14] text-black' : 'text-zinc-300 hover:bg-zinc-800'}`}
            >
              {type === 'sale' ? 'Sale' : 'Repair'}
            </button>
          ))}
        </div>

        {checkoutType === 'sale' ? (
          <SaleItemsTable items={saleItems} onChange={setSaleItems} showRequiredIndicator={saleItems.length === 0} layout="split" quickCheckout />
        ) : (
          <SaleItemsTable
            items={repairLines}
            onChange={setRepairLines}
            allowAddItems={false}
            layout="split"
            quickCheckout
            showRequiredIndicator={repairLines.length === 0}
            catalogPanel={(
              <div className="gb-quick-repair-catalog mb-3 flex min-h-0 flex-col rounded border border-zinc-700 bg-zinc-950/40 p-2">
                <div className="gb-quick-repair-toolbar mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-100">Repair catalog</h2>
                    <p className="text-xs text-zinc-400">Catalog records stay unchanged. Edits apply only to this checkout.</p>
                  </div>
                  <input
                    value={repairSearch}
                    onChange={(event) => setRepairSearch(event.target.value)}
                    placeholder="Search repairs"
                    className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm focus:border-[#39FF14] focus:outline-none sm:w-56"
                  />
                </div>
                <div className="gb-quick-repair-results min-h-0 flex-1 overflow-y-auto rounded border border-zinc-800">
                  {visibleRepairItems.length === 0 ? (
                    <p className="p-3 text-sm text-zinc-400">No matching repairs in the catalog.</p>
                  ) : visibleRepairItems.map((repair) => (
                    <button
                      key={String(repair.id)}
                      type="button"
                      onClick={() => addRepair(repair)}
                      className="flex w-full items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2 text-left last:border-b-0 hover:bg-zinc-800"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-zinc-100">{repair.title || repair.altDescription || 'Untitled repair'}</span>
                        <span className="block truncate text-xs text-zinc-400">{repair.repairCategory || repair.category || 'Repair'}</span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold text-[#39FF14]">${repairPrice(repair).toFixed(2)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          />
        )}

        <div className="gb-quick-checkout-totals relative z-10 shrink-0 bg-zinc-950 border border-zinc-700 rounded p-3 shadow-[0_-8px_20px_rgba(9,9,11,0.75)]">
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
              <input
                className="scale-95"
                type="checkbox"
                checked={taxed}
                onChange={(e) => setTaxed(e.target.checked)}
              />
              Taxed
              <span className="text-xs text-zinc-400">(8%)</span>
            </label>
            <div className="text-xs text-zinc-500">
              {items.length} item{items.length === 1 ? '' : 's'} in this checkout
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="bg-zinc-900 border border-zinc-800 rounded p-3">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Subtotal</div>
              <div className="text-lg font-semibold">${totals.subTotal.toFixed(2)}</div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded p-3">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Tax</div>
              <div className="text-lg font-semibold">${totals.tax.toFixed(2)}</div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded p-3">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Total</div>
              <div className="text-lg font-semibold text-neon-green">${totals.total.toFixed(2)}</div>
            </div>
          </div>

          <div className="pt-2 flex justify-end gap-2">
            {!isModalShell && (
              <button className="px-4 py-2 rounded bg-zinc-800 border border-zinc-700 text-sm" onClick={closeSelf} disabled={busy}>
                Cancel
              </button>
            )}
            <button
              className={`px-4 py-2 rounded text-sm font-semibold ${canCheckout ? 'bg-neon-green text-zinc-900 hover:brightness-110' : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}`}
              onClick={handleCheckout}
              disabled={!canCheckout}
            >
              {busy ? 'Processing...' : 'Checkout'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuickSaleWindow;
