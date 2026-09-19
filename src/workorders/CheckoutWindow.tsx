import React, { useEffect, useState, useMemo } from 'react';
import MoneyInput from '../components/MoneyInput';
import { peekWindowPayload } from '../lib/windowPayload';
import { checkoutCompletionState } from '../lib/checkoutCompletion';
import { deliverCheckoutResult } from '../lib/checkoutDelivery';

export type PaymentType = "Cash" | "Cash + Card" | "Card" | "Apple Pay" | "Google Pay" | "Other";

type CheckoutPayFor = 'both' | 'parts' | 'labor';

export interface CheckoutResult {
  amountDue: number;
  /** Applied to the balance (what counts toward amountDue). */
  amountPaid: number;
  /** Cash received from customer (tendered). For non-cash, equals amountPaid. */
  tendered?: number;
  changeDue: number;
  paymentType: PaymentType;
  /** Optional split tender detail; callers should prefer this when present. */
  payments?: Array<{ paymentType: PaymentType; applied: number; amount: number; tendered?: number; change?: number }>;
  payFor?: CheckoutPayFor;
  appliedParts?: number;
  appliedLabor?: number;
  closeParent: boolean;
  printReceipt: boolean;
  markClosed: boolean;
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parsePayload(): { amountDue: number; partsDue?: number; laborDue?: number; title?: string } | null {
  // React development mode can initialize this window twice. Peek keeps the
  // current modal payload available for both passes; each open overwrites it.
  const stored = peekWindowPayload('checkout');
  if (stored && typeof stored === 'object') return stored;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('checkout');
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch { return null; }
}

const paymentTypes: PaymentType[] = ["Cash", "Cash + Card", "Card", "Apple Pay", "Google Pay", "Other"];

const CheckoutWindow: React.FC = () => {
  const payload = useMemo(() => parsePayload(), []);
  const originalAmountDue = payload?.amountDue ?? 0;
  const partsDue = Number(payload?.partsDue || 0) || 0;
  const laborDue = Number(payload?.laborDue || 0) || 0;
  const hasPayFor = partsDue > 0 || laborDue > 0;

  const [payFor, setPayFor] = useState<CheckoutPayFor>('both');
  const [cashReceived, setCashReceived] = useState<number>(0);
  const [cashEdited, setCashEdited] = useState<boolean>(false);
  const [amountToApply, setAmountToApply] = useState<number>(0);
  const [applyEdited, setApplyEdited] = useState<boolean>(false);
  const [paymentType, setPaymentType] = useState<PaymentType | ''>('');
  const [closeParent, setCloseParent] = useState(true);
  const [printReceipt, setPrintReceipt] = useState<boolean>(false); // Receipt starts unchecked
  const [markClosed, setMarkClosed] = useState(false);
  const [completionMessage, setCompletionMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [cloverEnabled, setCloverEnabled] = useState(false);
  const [cloverMode, setCloverMode] = useState<'local' | 'cloud'>('local');
  const [cloverLoading, setCloverLoading] = useState(false);
  const [cloverStatus, setCloverStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const payPartsChecked = !hasPayFor ? true : (payFor === 'both' || payFor === 'parts');
  const payLaborChecked = !hasPayFor ? true : (payFor === 'both' || payFor === 'labor');
  const payBothChecked = !hasPayFor ? true : (payFor === 'both');

  function setPayParts(next: boolean) {
    if (!hasPayFor) return;
    const labor = payLaborChecked;
    if (next && labor) setPayFor('both');
    else if (next) setPayFor('parts');
    else if (labor) setPayFor('labor');
  }

  function setPayLabor(next: boolean) {
    if (!hasPayFor) return;
    const parts = payPartsChecked;
    if (next && parts) setPayFor('both');
    else if (next) setPayFor('labor');
    else if (parts) setPayFor('parts');
  }

  function setPayBoth(next: boolean) {
    if (!hasPayFor) return;
    if (next) setPayFor('both');
    else {
      // keep at least one selected; default to parts if available else labor
      if (partsDue > 0) setPayFor('parts');
      else if (laborDue > 0) setPayFor('labor');
      else setPayFor('both');
    }
  }

  const selectedDue = useMemo(() => {
    const remaining = Number(originalAmountDue || 0) || 0;
    if (!hasPayFor) return remaining;
    if (payFor === 'parts') return round2(Math.min(partsDue || 0, remaining));
    if (payFor === 'labor') return round2(Math.min(laborDue || 0, remaining));
    return remaining;
  }, [originalAmountDue, hasPayFor, payFor, partsDue, laborDue]);

  const numericCashReceived = useMemo(() => {
    const n = Number(cashReceived || 0);
    return Number.isFinite(n) && n >= 0 ? round2(n) : 0;
  }, [cashReceived]);

  const numericAmountToApply = useMemo(() => {
    const n = Number(amountToApply || 0);
    return Number.isFinite(n) && n >= 0 ? round2(n) : 0;
  }, [amountToApply]);

  const isSplit = (paymentType as any) === 'Cash + Card';
  const isCashOnly = (paymentType as any) === 'Cash';
  const isCashLike = isCashOnly || isSplit;

  const nonCashApplied = round2(Math.min(numericAmountToApply, Math.max(0, selectedDue)));
  const cashApplied = isCashLike ? round2(Math.min(numericCashReceived, Math.max(0, selectedDue))) : 0;
  const cardRemainder = isSplit ? round2(Math.max(0, round2(selectedDue) - cashApplied)) : 0;
  const appliedPaid = isSplit
    ? round2(Math.max(0, selectedDue))
    : (isCashOnly ? cashApplied : nonCashApplied);
  const tendered = isCashLike ? numericCashReceived : undefined;
  const changeDue = isCashOnly ? Math.max(numericCashReceived - cashApplied, 0) : 0;
  const completionState = checkoutCompletionState({
    amountDue: selectedDue,
    amountPaid: appliedPaid,
    paymentType,
    markClosed,
    cashApplied,
    cardRemainder,
  });
  const canSave = completionState.allowed && (isCashLike ? numericCashReceived >= cashApplied : true);

  const allocation = useMemo(() => {
    if (!hasPayFor) return { appliedParts: undefined as any, appliedLabor: undefined as any };

    if (payFor === 'parts') return { appliedParts: round2(appliedPaid), appliedLabor: 0 };
    if (payFor === 'labor') return { appliedParts: 0, appliedLabor: round2(appliedPaid) };

    // Both: allocate parts first (parts includes tax), remainder to labor.
    const p = round2(Math.min(appliedPaid, Math.max(0, partsDue || 0)));
    const l = round2(Math.max(0, appliedPaid - p));
    return { appliedParts: p, appliedLabor: l };
  }, [hasPayFor, payFor, appliedPaid, partsDue]);

  const setPaymentChoice = (next: PaymentType) => {
    setPaymentType(next);
    if (next === 'Cash + Card') {
      setCashEdited(false);
      setCashReceived(0);
    }
  };

  function buildCheckoutResult(): CheckoutResult {
    const payments: Array<{ paymentType: PaymentType; applied: number; amount: number; tendered?: number; change?: number }> = [];
    if (isSplit) {
      payments.push({
        paymentType: 'Cash',
        applied: round2(cashApplied),
        amount: Number.isFinite(numericCashReceived) ? numericCashReceived : round2(cashApplied),
        tendered: Number.isFinite(numericCashReceived) ? numericCashReceived : round2(cashApplied),
        change: Number.isFinite(changeDue) ? round2(changeDue) : 0,
      });
      payments.push({
        paymentType: 'Card',
        applied: round2(cardRemainder),
        amount: round2(cardRemainder),
      });
    } else if (isCashOnly) {
      payments.push({
        paymentType: 'Cash',
        applied: round2(appliedPaid),
        amount: Number.isFinite(numericCashReceived) ? numericCashReceived : round2(appliedPaid),
        tendered: Number.isFinite(numericCashReceived) ? numericCashReceived : round2(appliedPaid),
        change: Number.isFinite(changeDue) ? round2(changeDue) : 0,
      });
    } else {
      payments.push({
        paymentType: paymentType as PaymentType,
        applied: round2(appliedPaid),
        amount: round2(appliedPaid),
      });
    }
    const result: CheckoutResult = {
      amountDue: selectedDue,
      amountPaid: appliedPaid,
      ...(isCashLike ? { tendered } : {}),
      changeDue,
      paymentType: (paymentType || 'Other') as PaymentType,
      payments,
      payFor: hasPayFor ? payFor : undefined,
      appliedParts: hasPayFor ? allocation.appliedParts : undefined,
      appliedLabor: hasPayFor ? allocation.appliedLabor : undefined,
      closeParent,
      printReceipt,
      markClosed,
    };
    return result;
  }

  async function save() {
    if (submitting) return;
    if (!canSave) {
      setCompletionMessage(completionState.reason || 'Review the payment details before completing checkout.');
      return;
    }
    setCompletionMessage('');
    const result = buildCheckoutResult();
    // Fire Clover cash sale in background (opens drawer, records in Clover)
    if (isCashOnly && cloverEnabled) {
      const amountCents = Math.round(appliedPaid * 100);
      const tenderedCents = Math.round(numericCashReceived * 100);
      (window as any).api?.cloverCashSale?.({ amountCents, tenderedCents, label: payload?.title || 'Service' }).catch(() => {});
    }
    setSubmitting(true);
    try {
      await deliverCheckoutResult((window as any).api, result);
    } catch (error: any) {
      setCompletionMessage(error?.message || 'Checkout could not be completed. Try again.');
      setSubmitting(false);
    }
  }
  function cancel() {
    (window as any).api._emitCheckoutCancel();
  }

  useEffect(() => {
    // ensure initial formatting
    setCashReceived(round2(originalAmountDue));
    setAmountToApply(round2(originalAmountDue));
    // Check if Clover is configured
    (window as any).api?.cloverGetConfig?.().then((cfg: any) => {
      const hasLocal = !!(cfg?.deviceIp);
      const hasCloud = !!(cfg?.hasToken && cfg?.merchantId);
      if (hasLocal) { setCloverEnabled(true); setCloverMode('local'); }
      else if (hasCloud) { setCloverEnabled(true); setCloverMode('cloud'); }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    // When the selected due changes, default inputs unless user edited.
    if (!applyEdited && paymentType !== 'Cash + Card') setAmountToApply(round2(selectedDue));
    if (paymentType === 'Cash' && !cashEdited && !applyEdited) setCashReceived(round2(selectedDue));
  }, [selectedDue, cashEdited, paymentType, applyEdited]);

  useEffect(() => {
    if (!isSplit) return;
    if (numericCashReceived <= selectedDue) return;
    setCashReceived(round2(selectedDue));
  }, [isSplit, numericCashReceived, selectedDue]);

  useEffect(() => {
    // When switching to cash, default cash received to amount due (but don't fight user edits for non-cash).
    if (paymentType === 'Cash') {
      setCashReceived(prev => {
        if (cashEdited) return prev;
        return (Number(prev) > 0) ? prev : round2(appliedPaid || selectedDue);
      });
    }
  }, [paymentType, selectedDue, cashEdited, applyEdited, appliedPaid]);

  async function handleCloverCharge() {
    if (!canSave) return;
    setCloverLoading(true);
    setCloverStatus(null);
    try {
      const amountCents = Math.round(appliedPaid * 100);
      const label = payload?.title || 'Service';
      let res: any;
      if (cloverMode === 'local') {
        res = await (window as any).api.cloverLocalCharge({ amountCents, label });
      } else {
        res = await (window as any).api.cloverChargeCard({ amountCents, label });
      }
      if (res?.ok) {
        (window as any).api._emitCheckoutSave(buildCheckoutResult());
        setCloverStatus({ ok: true, message: cloverMode === 'local' ? 'Sent to Flex — customer can now pay on device' : 'Sent to Clover — awaiting payment on device' });
      } else {
        setCloverStatus({ ok: false, message: res?.error || 'Clover error' });
      }
    } catch (e: any) {
      setCloverStatus({ ok: false, message: e?.message || 'Clover error' });
    } finally {
      setCloverLoading(false);
    }
  }

  function onRootKeyDownCapture(e: React.KeyboardEvent) {
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;

    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tag = (target as any).tagName as string | undefined;
    if (tag === 'TEXTAREA') return;
    if (tag === 'BUTTON') return;

    // Don't submit when focused on checkboxes (Enter toggles them).
    if (target instanceof HTMLInputElement) {
      const t = (target.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit') return;
    }

    if (!canSave) return;
    e.preventDefault();
    void save();
  }

  return (
    <div className="gb-checkout-window h-screen w-screen overflow-auto bg-gradient-to-b from-zinc-900 to-zinc-950 text-zinc-100 font-sans select-none" onKeyDownCapture={onRootKeyDownCapture}>
      <div className="gb-checkout-body mx-auto flex min-h-full max-w-2xl flex-col gap-3 p-3 text-[13px] leading-tight sm:p-4">
        <div className="gb-checkout-summary flex items-center justify-between rounded-2xl border border-[#39FF14]/35 bg-[#39FF14]/[0.06] p-4 shadow-[0_0_24px_rgba(57,255,20,0.08)]">
          <div><div className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Payment</div><h2 className="mt-1 text-lg font-black">{payload?.title ? String(payload.title) : 'Checkout'}</h2></div>
          <div className="text-right"><div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Amount due</div><div className="mt-1 text-2xl font-black text-neon-green">${selectedDue.toFixed(2)}</div></div>
        </div>

        {hasPayFor && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3 shadow-lg">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Paying for</div>
              <div className="text-[11px] text-zinc-400">
                <span className="mr-3">Parts: <span className="text-zinc-200 font-semibold">${partsDue.toFixed(2)}</span></span>
                <span>Labor: <span className="text-zinc-200 font-semibold">${laborDue.toFixed(2)}</span></span>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
              <label className={`gb-checkout-scope-card flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 font-bold transition ${payPartsChecked ? 'border-[#39FF14] bg-[#39FF14]/10 text-[#39FF14]' : 'border-zinc-700 bg-zinc-950/60 hover:border-zinc-500'}`}>
                <input type="checkbox" checked={payPartsChecked} onChange={(e) => setPayParts(e.target.checked)} />
                Parts
              </label>
              <label className={`gb-checkout-scope-card flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 font-bold transition ${payLaborChecked ? 'border-[#39FF14] bg-[#39FF14]/10 text-[#39FF14]' : 'border-zinc-700 bg-zinc-950/60 hover:border-zinc-500'}`}>
                <input type="checkbox" checked={payLaborChecked} onChange={(e) => setPayLabor(e.target.checked)} />
                Labor
              </label>
              <label className={`gb-checkout-scope-card flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 font-bold transition ${payBothChecked ? 'border-[#39FF14] bg-[#39FF14]/10 text-[#39FF14]' : 'border-zinc-700 bg-zinc-950/60 hover:border-zinc-500'}`}>
                <input type="checkbox" checked={payBothChecked} onChange={(e) => setPayBoth(e.target.checked)} />
                Both
              </label>
            </div>
            <div className="text-[10px] text-zinc-500 mt-1">Use this for partial payments (e.g. pay parts now, labor later).</div>
          </div>
        )}

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3 shadow-lg">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Choose payment method</div>
          <div className="mt-2 grid grid-cols-1 gap-2 min-[360px]:grid-cols-3">
            <button
              type="button"
              className={
                'gb-checkout-payment-tile min-h-14 rounded-xl border px-3 py-2 text-sm font-black transition focus:outline-none focus:ring-2 focus:ring-[#39FF14] ' +
                (paymentType === 'Cash'
                  ? 'bg-zinc-800 border-neon-green text-neon-green'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-200 hover:border-zinc-500')
              }
              onClick={() => setPaymentChoice('Cash')}
              aria-pressed={paymentType === 'Cash'}
            >
              Cash
            </button>
            <button
              type="button"
              className={
                'gb-checkout-payment-tile min-h-14 rounded-xl border px-3 py-2 text-sm font-black transition focus:outline-none focus:ring-2 focus:ring-[#39FF14] ' +
                (paymentType === 'Card'
                  ? 'bg-zinc-800 border-neon-green text-neon-green'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-200 hover:border-zinc-500')
              }
              onClick={() => setPaymentChoice('Card')}
              aria-pressed={paymentType === 'Card'}
            >
              Card
            </button>
            <button
              type="button"
              className={
                'gb-checkout-payment-tile min-h-14 rounded-xl border px-3 py-2 text-sm font-black transition focus:outline-none focus:ring-2 focus:ring-[#39FF14] ' +
                (paymentType === 'Cash + Card'
                  ? 'bg-zinc-800 border-neon-green text-neon-green'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-200 hover:border-zinc-500')
              }
              onClick={() => setPaymentChoice('Cash + Card')}
              aria-pressed={paymentType === 'Cash + Card'}
            >
              Split Pay
            </button>
          </div>
          {!paymentType && (
            <div className="mt-1 text-[10px] text-zinc-500">Select a payment type to continue.</div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3 shadow-lg">
          {isCashLike ? (
            <div className="col-span-2 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">Cash received</label>
                <MoneyInput
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-neon-green"
                  value={numericCashReceived}
                  onValueChange={(v) => {
                    setCashEdited(true);
                    const next = Number(v || 0);
                    const safe = Number.isFinite(next) ? Math.max(0, next) : 0;
                    setCashReceived(isSplit ? Math.min(safe, selectedDue) : safe);
                  }}
                />
              </div>
              <div>
                <label className="block text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">{isSplit ? 'Card remainder' : 'Applied to balance'}</label>
                <input
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                  value={(isSplit ? cardRemainder : cashApplied).toFixed(2)}
                  readOnly
                />
              </div>
              <div className="col-span-2 text-[10px] text-zinc-500">
                {isSplit ? (
                  <>
                    Cash: <span className="text-zinc-200 font-semibold">${cashApplied.toFixed(2)}</span>
                    {' '}+ Card: <span className="text-zinc-200 font-semibold">${cardRemainder.toFixed(2)}</span>
                    {' '}= <span className="text-zinc-200 font-semibold">${selectedDue.toFixed(2)}</span>
                    {(selectedDue > 0 && numericCashReceived >= selectedDue) ? (
                      <span className="ml-2 text-amber-400">(Cash covers total — use Cash)</span>
                    ) : null}
                  </>
                ) : (
                  <>Applied to balance: <span className="text-zinc-200 font-semibold">${cashApplied.toFixed(2)}</span></>
                )}
              </div>
            </div>
          ) : (
            <div className="col-span-2">
              <label className="block text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">Amount to apply</label>
              <MoneyInput
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-neon-green"
                value={appliedPaid}
                onValueChange={(v) => {
                  setApplyEdited(true);
                  const next = Number(v || 0);
                  const safe = Number.isFinite(next) ? Math.max(0, Math.min(next, selectedDue)) : 0;
                  setAmountToApply(safe);
                }}
              />
              <div className="text-[10px] text-zinc-500 mt-1">Max: <span className="text-zinc-200 font-semibold">${selectedDue.toFixed(2)}</span></div>
            </div>
          )}

          {isCashLike && (
            <div>
              <label className="block text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">Change due</label>
              <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1" value={changeDue.toFixed(2)} readOnly />
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 text-xs min-[420px]:grid-cols-3">
          <label className={`gb-checkout-option-card flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 font-semibold ${closeParent ? 'border-purple-400/70 bg-purple-500/10' : 'border-zinc-800 bg-zinc-900/70'}`}><input type="checkbox" checked={closeParent} onChange={e => setCloseParent(e.target.checked)} /> Close window</label>
          <label className={`gb-checkout-option-card flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 font-semibold ${printReceipt ? 'border-blue-400/70 bg-blue-500/10' : 'border-zinc-800 bg-zinc-900/70'}`}><input type="checkbox" checked={printReceipt} onChange={e => setPrintReceipt(e.target.checked)} /> Print receipt</label>
          <label className={`gb-checkout-option-card flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 font-semibold ${markClosed ? 'border-amber-400/70 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900/70'}`}><input type="checkbox" checked={markClosed} onChange={e => setMarkClosed(e.target.checked)} /> Mark closed</label>
        </div>

        {cloverEnabled && paymentType === 'Card' && (
          <div className="flex flex-col gap-1">
            <button
              className={`w-full py-2 rounded text-[11px] font-semibold border transition-colors ${
                cloverLoading
                  ? 'bg-zinc-800 border-zinc-600 text-zinc-400 cursor-wait'
                  : canSave
                  ? 'bg-zinc-900 border-[#39FF14] text-[#39FF14] hover:bg-zinc-800'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-500 cursor-not-allowed'
              }`}
              disabled={!canSave || cloverLoading}
              onClick={handleCloverCharge}
            >
              {cloverLoading ? 'Sending to Clover…' : '⬛ Charge on Clover Device'}
            </button>
            {cloverStatus && (
              <div className={`text-[10px] px-2 py-1 rounded text-center ${
                cloverStatus.ok ? 'text-[#39FF14] bg-green-950/40' : 'text-red-400 bg-red-950/40'
              }`}>
                {cloverStatus.message}
              </div>
            )}
          </div>
        )}

        <div className="gb-checkout-actions sticky bottom-0 mt-auto flex gap-2 border-t border-zinc-800 bg-zinc-950/95 py-3 backdrop-blur">
          <button className="min-h-12 flex-1 rounded-xl border border-zinc-700 bg-zinc-800 px-4 text-sm font-bold hover:border-zinc-500" onClick={cancel}>Cancel</button>
          <button
            className={`min-h-12 flex-[1.6] rounded-xl px-4 text-sm font-black ${canSave ? 'bg-neon-green text-zinc-950 shadow-[0_0_20px_rgba(57,255,20,0.2)] hover:brightness-110' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            aria-disabled={!canSave || submitting}
            disabled={submitting}
            onClick={() => void save()}
          >{submitting ? 'Completing…' : 'Complete Checkout'}</button>
        </div>
        {completionMessage ? <div role="alert" className="rounded-lg border border-amber-500/50 bg-amber-950/40 px-3 py-2 text-xs font-semibold text-amber-200">{completionMessage}</div> : null}
      </div>
    </div>
  );
};

export default CheckoutWindow;
