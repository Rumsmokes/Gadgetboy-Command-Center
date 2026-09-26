import React from 'react';
import { WorkOrderFull } from '../lib/types';
import MoneyInput from '../components/MoneyInput';
import PercentInput from '../components/PercentInput';

interface Props {
  workOrder: WorkOrderFull;
  onChange: (p: Partial<WorkOrderFull>) => void;
  onCheckout: () => void;
  checkoutBusy?: boolean;
  salesMode?: boolean; // when true, hide labor/parts and discount; show single Product row
}

const PaymentPanel: React.FC<Props> = ({ workOrder, onChange, onCheckout, checkoutBusy = false, salesMode = false }) => {
  const t = workOrder.totals || { subTotal: 0, tax: 0, total: 0, remaining: 0 };
  const lastNonZeroTaxRateRef = React.useRef<number>(Number(workOrder.taxRate) || 0);
  const currentTaxRate = Number(workOrder.taxRate) || 0;
  if (currentTaxRate > 0) lastNonZeroTaxRateRef.current = currentTaxRate;
  const salesTaxed = currentTaxRate > 0;

  return (
    <div className="gb-wo-payment-panel bg-zinc-900 border border-zinc-700 rounded p-3">
      <h4 className="text-sm font-semibold text-zinc-200 mb-2">Payment</h4>

      <div className="grid grid-cols-2 gap-2">
        {salesMode && (
          <div className="col-span-2">
            <label className="block text-xs text-zinc-400">Discount</label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {workOrder.discountType !== 'custom_amt' ? (
                <>
                  <PercentInput
                    className="w-20"
                    value={workOrder.discountPctValue ?? ''}
                    onChange={raw => {
                      const pct = Number(raw) || 0;
                      const discount = Number(((workOrder.partCosts || 0) * pct / 100).toFixed(2));
                      onChange({ discountType: pct ? 'custom_pct' : (undefined as any), discountPctValue: pct || undefined, discount });
                    }}
                  />
                </>
              ) : (
                <MoneyInput
                  className="w-28 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                  placeholder="0.00"
                  value={Number(workOrder.discountCustomAmount || 0)}
                  onValueChange={(v) => {
                    const amt = Number(v || 0) || 0;
                    onChange({ discountCustomAmount: amt, discount: amt });
                  }}
                />
              )}
              {(workOrder.discount || 0) > 0 && (
                <div className="text-xs text-green-400">−${(workOrder.discount || 0).toFixed(2)} off subtotal</div>
              )}
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer select-none">
              <input
                type="checkbox"
                className="scale-90"
                checked={workOrder.discountType === 'custom_amt'}
                onChange={e => {
                  if (e.target.checked) {
                    onChange({ discountType: 'custom_amt', discountPctValue: undefined, discount: workOrder.discountCustomAmount || 0 });
                  } else {
                    onChange({ discountType: undefined as any, discountPctValue: undefined, discount: 0 });
                  }
                }}
              />
              Enter dollar amount instead
            </label>
          </div>
        )}
        {!salesMode && (
          <div className="col-span-2">
            <label className="block text-xs text-zinc-400">Discount (labor only)</label>
            <div className="mt-1 flex flex-wrap gap-2 items-center">
              {workOrder.discountType !== 'custom_amt' ? (
                <PercentInput
                  className="w-20"
                  value={workOrder.discountPctValue ?? ''}
                  onChange={raw => {
                    const pct = Number(raw) || 0;
                    const discount = Number(((workOrder.laborCost || 0) * pct / 100).toFixed(2));
                    onChange({ discountType: pct ? 'custom_pct' : (undefined as any), discountPctValue: pct || undefined, discount });
                  }}
                />
              ) : (
                <MoneyInput
                  className="w-28 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                  placeholder="0.00"
                  value={Number(workOrder.discountCustomAmount || 0)}
                  onValueChange={(v) => {
                    const amt = Number(v || 0) || 0;
                    onChange({ discountCustomAmount: amt, discount: amt });
                  }}
                />
              )}
              <div className="text-xs text-zinc-300 self-center px-2 py-1 bg-zinc-800 rounded">−${(workOrder.discount || 0).toFixed(2)}</div>
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-500 cursor-pointer select-none">
              <input
                type="checkbox"
                className="scale-90"
                checked={workOrder.discountType === 'custom_amt'}
                onChange={e => {
                  if (e.target.checked) {
                    onChange({ discountType: 'custom_amt', discountPctValue: undefined, discount: workOrder.discountCustomAmount || 0 });
                  } else {
                    onChange({ discountType: undefined as any, discountPctValue: undefined, discount: 0 });
                  }
                }}
              />
              Enter dollar amount instead. Applies to labor only.
            </label>
          </div>
        )}
        <div>
          <label className="block text-xs text-zinc-400">Historical amount paid</label>
          <MoneyInput className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={Number(workOrder.amountPaid || 0)} onValueChange={(v) => onChange({ amountPaid: Number(v || 0) })} />
          <p className="mt-1 text-[10px] leading-tight text-amber-200">Use only for a payment taken on an earlier day. Use Checkout for any payment taken today.</p>
        </div>
        <div>
          <label className="block text-xs text-zinc-400">Historical payment date</label>
          <input type="date" className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" value={String((workOrder as any).historicalPaymentDate || '').slice(0, 10)} onChange={(event) => onChange({ historicalPaymentDate: event.target.value || null } as any)} />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="block text-xs text-zinc-400">Sales tax %</label>
            {salesMode && (
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer select-none">
                <input
                  className="scale-90"
                  type="checkbox"
                  checked={salesTaxed}
                  onChange={(e) => {
                    const next = e.target.checked;
                    if (!next) {
                      onChange({ taxRate: 0 });
                      return;
                    }
                    const fallback = Number(lastNonZeroTaxRateRef.current) || 8;
                    onChange({ taxRate: fallback });
                  }}
                />
                Taxed
              </label>
            )}
          </div>
          <input
            className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1"
            value={workOrder.taxRate || 0}
            onChange={e => onChange({ taxRate: Number(e.target.value) })}
            disabled={salesMode && !salesTaxed}
          />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        {salesMode ? (
          <>
            <div className="text-zinc-400">Product</div><div className="text-zinc-200">${(workOrder.partCosts || 0).toFixed(2)}</div>
            {(workOrder.discount || 0) > 0 && (
              <><div className="text-zinc-400">Discount</div><div className="text-green-400">−${(workOrder.discount || 0).toFixed(2)}</div></>
            )}
          </>
        ) : (
          <>
            <div className="text-zinc-400">Labor</div><div className="text-zinc-200">${(workOrder.laborCost || 0).toFixed(2)}</div>
            <div className="text-zinc-400">Parts</div><div className="text-zinc-200">${(workOrder.partCosts || 0).toFixed(2)}</div>
          </>
        )}
        <div className="text-zinc-400">Tax</div><div className="text-zinc-200">${(t.tax || 0).toFixed(2)}</div>
        <div className="text-zinc-400">Total</div><div className="text-zinc-200">${(t.total || 0).toFixed(2)}</div>
        <div className="text-zinc-400">Remaining</div><div className="text-zinc-200">${(t.remaining || 0).toFixed(2)}</div>
      </div>

      <div className="mt-3">
        <button disabled={checkoutBusy} className="w-full px-3 py-2 rounded bg-neon-green text-zinc-900 font-semibold hover:brightness-110 disabled:opacity-60 disabled:cursor-wait" onClick={() => onCheckout()}>{checkoutBusy ? 'Processing…' : 'Checkout'}</button>
      </div>
    </div>
  );
}

export default React.memo(PaymentPanel, (prev, next) => {
  const a = prev.workOrder;
  const b = next.workOrder;
  const at = a.totals || { subTotal: 0, tax: 0, total: 0, remaining: 0 };
  const bt = b.totals || { subTotal: 0, tax: 0, total: 0, remaining: 0 };
  return prev.salesMode === next.salesMode
    && prev.checkoutBusy === next.checkoutBusy
    && prev.onChange === next.onChange
    && prev.onCheckout === next.onCheckout
    && String(a.discountType || '') === String(b.discountType || '')
    && Number(a.discountPctValue || 0) === Number(b.discountPctValue || 0)
    && Number(a.discountCustomAmount || 0) === Number(b.discountCustomAmount || 0)
    && Number(a.discount || 0) === Number(b.discount || 0)
    && Number(a.amountPaid || 0) === Number(b.amountPaid || 0)
    && Number(a.taxRate || 0) === Number(b.taxRate || 0)
    && Number(a.laborCost || 0) === Number(b.laborCost || 0)
    && Number(a.partCosts || 0) === Number(b.partCosts || 0)
    && Number(at.tax || 0) === Number(bt.tax || 0)
    && Number(at.total || 0) === Number(bt.total || 0)
    && Number(at.remaining || 0) === Number(bt.remaining || 0);
});
