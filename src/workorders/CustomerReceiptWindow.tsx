import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchPublicAssetAsDataUrlCached, publicAsset } from '../lib/publicAsset';
import { formatPhone } from '../lib/format';
import { consumeWindowPayload } from '../lib/windowPayload';
import { buildPatternSvg } from './releasePrint';
function getPayload() {
  try {
    const stored = consumeWindowPayload('customerReceipt');
    if (stored !== null) return stored;
  } catch {}
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('customerReceipt');
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch (e) { return null; }
}

function getReceiptFlags() {
  try {
    const params = new URLSearchParams(window.location.search);
    const autoPrint = params.get('autoPrint') === '1' || params.get('autoPrint') === 'true';
    const silent = params.get('silent') === '1' || params.get('silent') === 'true';
    const autoCloseMsRaw = params.get('autoCloseMs');
    const autoCloseMs = autoCloseMsRaw ? Number(autoCloseMsRaw) : 0;
    return { autoPrint, silent, autoCloseMs: Number.isFinite(autoCloseMs) ? autoCloseMs : 0 };
  } catch {
    return { autoPrint: false, silent: false, autoCloseMs: 0 };
  }
}

function round2(n: number) {
  return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
}

function parseDateValue(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const d = new Date(String(value));
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

function canonicalPaymentType(raw: any): string {
  const s = String(raw || '').trim();
  const t = s.toLowerCase();
  if (t.includes('cash')) return 'Cash';
  if (t.includes('card') || t.includes('credit') || t.includes('debit')) return 'Card';
  if (t.includes('apple')) return 'Apple Pay';
  if (t.includes('google')) return 'Google Pay';
  if (!s) return 'Other';
  return s;
}

function paymentAppliedAmount(p: any): number {
  const applied = Number(p?.applied);
  if (Number.isFinite(applied) && applied > 0) return round2(applied);
  const amount = Number(p?.amount ?? p?.tender ?? p?.paid ?? 0);
  const change = Number(p?.change ?? p?.changeDue ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (Number.isFinite(change) && change > 0) return round2(Math.max(0, amount - change));
  return round2(amount);
}

const CustomerReceiptWindow: React.FC = () => {
  const [data, setData] = useState<any>(() => getPayload() || {});
  const flags = useMemo(() => getReceiptFlags(), []);
  const now = new Date();

  const receiptType = String((data as any).receiptType || (data as any).type || '').toLowerCase();
  const isSaleReceipt = receiptType === 'sale' || receiptType === 'sales';

  const [logoSrc, setLogoSrc] = useState<string>('');
  const didAutoPrintRef = useRef(false);
  const logoImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const src = (await fetchPublicAssetAsDataUrlCached('logo.png')) || (await fetchPublicAssetAsDataUrlCached('logo-spin.gif')) || '';
      if (!alive) return;
      setLogoSrc(src);
    })();
    return () => { alive = false; };
  }, []);

  // Enrich from DB when only workOrderId is provided (e.g. from context menu)
  useEffect(() => {
    const payload = data as any;
    const hasContactBasics = Boolean(
      String(payload.customerName || '').trim()
      && String(payload.customerPhone || '').trim()
      && String(payload.customerEmail || '').trim()
    );
    const customerId = Number(payload.customerId || 0) || 0;
    const workOrderId = Number(payload.workOrderId || 0) || 0;
    if (!workOrderId && !customerId) return;
    if (hasContactBasics && String(payload.customerPhoneAlt || '').trim()) return;
    let alive = true;
    (async () => {
      try {
        const api = (window as any).api;
        const enriched: any = { ...payload };

        // Work-order payload path: hydrate from work order for missing structured fields.
        if (workOrderId) {
          let wo: any = null;
          try {
            const list = await api.findWorkOrders?.({ id: workOrderId });
            wo = Array.isArray(list) && list.length ? list[0] : null;
          } catch {}
          if (!wo) {
            try {
              const list = await api.dbGet?.('workOrders');
              wo = Array.isArray(list) ? list.find((w: any) => Number(w?.id || 0) === workOrderId) || null : null;
            } catch {}
          }
          if (wo) {
            Object.assign(enriched, { ...wo, ...enriched });
            if (!enriched.customerId && wo.customerId) enriched.customerId = wo.customerId;

            // If this work order has a linked add-on Sale, include it in the payload.
            try {
              const addonSaleId = Number((wo as any).addonSaleId || 0) || 0;
              if (addonSaleId && api?.dbGet) {
                const sales = await api.dbGet('sales').catch(() => []);
                const found = Array.isArray(sales) ? sales.find((s: any) => Number(s?.id || 0) === addonSaleId) : null;
                enriched.addonSaleId = addonSaleId;
                enriched.addonSale = found || null;
              }
            } catch {}
          }
        }

        // Customer payload path: always try to fill missing contact details from customer record.
        const cid = Number(enriched.customerId || customerId || 0) || 0;
        if (cid > 0 && api.findCustomers) {
          try {
            const customers = await api.findCustomers({ id: cid });
            const c = Array.isArray(customers) && customers.length ? customers[0] : null;
            if (c) {
              const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
              if (full) enriched.customerName = full;
              if (c.phone) enriched.customerPhone = c.phone;
              if (c.phoneAlt) enriched.customerPhoneAlt = c.phoneAlt;
              if (c.email) enriched.customerEmail = c.email;
            }
          } catch {}
        }

        if (alive) setData(enriched);
      } catch {}
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!flags.autoPrint || flags.silent) return;

    if (didAutoPrintRef.current) return;

    const fallback = window.setTimeout(() => {
      if (didAutoPrintRef.current) return;
      didAutoPrintRef.current = true;
      try { window.focus(); window.print(); } catch {}
      if (flags.autoCloseMs && flags.autoCloseMs > 0) {
        window.setTimeout(() => { try { window.close(); } catch {} }, flags.autoCloseMs);
      }
    }, 100);

    if (logoSrc) {
      window.clearTimeout(fallback);
      didAutoPrintRef.current = true;
      const doAutoPrint = () => {
        try { window.focus(); window.print(); } catch {}
        if (flags.autoCloseMs && flags.autoCloseMs > 0) {
          window.setTimeout(() => { try { window.close(); } catch {} }, flags.autoCloseMs);
        }
      };
      // Single rAF is enough to ensure the logo is committed to the DOM before
      // printing — matches the release form behavior (no img.complete wait needed
      // for base64 data URLs which decode synchronously in Chromium).
      requestAnimationFrame(doAutoPrint);
    }

    return () => window.clearTimeout(fallback);
  }, [flags.autoPrint, flags.autoCloseMs, flags.silent, logoSrc]);

  useEffect(() => {
    if (!flags.autoPrint || !flags.silent) return;

    let cancelled = false;
    let fallbackTimer: number | undefined;

    const waitForImage = async () => {
      const images = [logoImgRef.current].filter(Boolean) as HTMLImageElement[];
      await Promise.all(images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            try { img.removeEventListener('load', finish); } catch {}
            try { img.removeEventListener('error', finish); } catch {}
            resolve();
          };
          try { img.addEventListener('load', finish, { once: true }); } catch {}
          try { img.addEventListener('error', finish, { once: true }); } catch {}
          fallbackTimer = window.setTimeout(finish, 150);
        });
      }));
    };

    const signalReady = async () => {
      try {
        await waitForImage();
        // Race fonts.ready against a 100ms cap
        try {
          const fontSet = (document as any).fonts;
          if (fontSet?.ready) {
            await Promise.race([
              fontSet.ready,
              new Promise<void>((r) => window.setTimeout(r, 50)),
            ]);
          }
        } catch {}
        // One rAF to flush the current paint cycle before printing
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      } finally {
        if (!cancelled) {
          try { (window as any).api?.notifyCustomerReceiptReady?.(); } catch {}
        }
      }
    };

    void signalReady();

    return () => {
      cancelled = true;
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
    };
  }, [flags.autoPrint, flags.silent, logoSrc]);

  const items = Array.isArray((data as any).items) ? (data as any).items : [];
  const fullName = (data as any).customerName || (data as any).customer?.name || '';
  const phoneRaw = (data as any).customerPhone || (data as any).customer?.phone || '';
  const phone = formatPhone(String(phoneRaw || '')) || String(phoneRaw || '');
  const phoneAltRaw = (data as any).customerPhoneAlt || (data as any).customer?.phoneAlt || '';
  const phoneAlt = formatPhone(String(phoneAltRaw || '')) || String(phoneAltRaw || '');
  const email = (data as any).customerEmail || (data as any).customer?.email || '';
  const invoiceNo = (data as any).id ? String((data as any).id).padStart(6, '0') : '';

  const device = (data as any).productCategory || (data as any).device || '';
  const description = (data as any).productDescription || (data as any).description || device || '';
  const model = (data as any).model || '';
  const serial = (data as any).serial || (data as any).serialNumber || '';
  const password = (data as any).password || '';
  const patternSequence = Array.isArray((data as any).patternSequence) ? (data as any).patternSequence : [];
  const hasPattern = patternSequence.length > 0;
  const problem = (data as any).problemInfo || (data as any).problem || '';

  const partCosts = Number((data as any).partCosts ?? (data as any).subTotalParts ?? 0) || 0;
  const laborCost = Number((data as any).laborCost ?? (data as any).subTotalLabor ?? 0) || 0;
  const discount = Number((data as any).discount ?? 0) || 0;
  const taxRate = Number((data as any).taxRate ?? 0) || 0;
  const taxes = Number((data as any).totals?.tax ?? (data as any).taxes ?? 0) || 0;
  const amountPaid = Number((data as any).amountPaid ?? 0) || 0;
  const remaining = Number((data as any).totals?.remaining ?? 0) || 0;

  const subTotal = Number((data as any).totals?.subTotal ?? (partCosts + laborCost)) || 0;
  const totalDue = Number((data as any).totals?.total ?? (subTotal - discount + taxes)) || 0;

  const saleItems: Array<{ id: string; description: string; qty: number; price: number; total: number }> = useMemo(() => {
    if (!isSaleReceipt) return [];
    return (items || []).map((it: any, idx: number) => {
      const qty = Number(it.qty ?? it.quantity ?? 1) || 1;
      const price = Number(it.price ?? it.unitPrice ?? it.unit_cost ?? 0) || 0;
      const description = String(it.description || it.itemDescription || it.title || it.name || 'Item');
      const total = qty * price;
      return { id: String(it.id || idx), description, qty, price, total };
    });
  }, [isSaleReceipt, items]);

  const addonSale = !isSaleReceipt ? ((data as any).addonSale || null) : null;
  const addonSaleItems: Array<{ id: string; description: string; qty: number; price: number; total: number }> = useMemo(() => {
    if (isSaleReceipt) return [];
    const s = addonSale as any;
    const rows = Array.isArray(s?.items) ? s.items : [];
    return rows.map((it: any, idx: number) => {
      const qty = Number(it.qty ?? it.quantity ?? 1) || 1;
      const price = Number(it.price ?? it.unitPrice ?? it.unit_cost ?? 0) || 0;
      const description = String(it.description || it.itemDescription || it.title || it.name || 'Item');
      const total = qty * price;
      return { id: String(it.id || idx), description, qty, price, total };
    });
  }, [isSaleReceipt, addonSale]);

  const addonSubTotal = Number((addonSale as any)?.totals?.subTotal ?? (addonSale as any)?.partCosts ?? addonSaleItems.reduce((sum, r) => sum + (Number(r.total) || 0), 0)) || 0;
  const addonTax = Number((addonSale as any)?.totals?.tax ?? 0) || 0;
  const addonDiscount = Number((addonSale as any)?.discount ?? 0) || 0;
  const addonTotalDue = Number((addonSale as any)?.totals?.total ?? (Math.max(0, addonSubTotal - addonDiscount) + addonTax)) || 0;
  const addonAmountPaid = Number((addonSale as any)?.amountPaid ?? 0) || 0;
  const addonRemaining = Number((addonSale as any)?.totals?.remaining ?? Math.max(0, addonTotalDue - addonAmountPaid)) || 0;

  const displayPartCosts = !isSaleReceipt ? round2(partCosts + addonSubTotal) : partCosts;
  const displayTaxes = !isSaleReceipt ? round2(taxes + addonTax) : taxes;
  const displayAmountPaid = !isSaleReceipt ? round2(amountPaid + addonAmountPaid) : amountPaid;
  const displayRemaining = !isSaleReceipt ? round2(remaining + addonRemaining) : remaining;

  const paymentRows = useMemo(() => {
    const basePayments: any[] = Array.isArray((data as any)?.payments) ? (data as any).payments : [];
    const addonPayments: any[] = (!isSaleReceipt && Array.isArray((addonSale as any)?.payments)) ? (addonSale as any).payments : [];
    const combined = [...basePayments, ...addonPayments].filter(Boolean);

    const fallbackAmountPaid = Number(displayAmountPaid || 0) || 0;
    const fallbackPaymentType = (data as any)?.paymentType || (data as any)?.paymentMethod || (data as any)?.method || '';
    const fallbackAt = (data as any)?.checkoutDate || (data as any)?.closedAt || (data as any)?.createdAt || null;

    const source = combined.length
      ? combined
      : ((fallbackAmountPaid > 0 && String(fallbackPaymentType || '').trim())
          ? [{ paymentType: fallbackPaymentType, amount: fallbackAmountPaid, applied: fallbackAmountPaid, change: 0, at: fallbackAt }]
          : []);

    const map = new Map<string, { label: string; at?: string; sortTs: number; amount: number; change: number }>();

    for (const p of source) {
      const rawType = (p as any)?.paymentType ?? (p as any)?.method ?? (p as any)?.type ?? '';
      const type = canonicalPaymentType(rawType);
      const isCash = type.toLowerCase().includes('cash');

      const applied = paymentAppliedAmount(p);
      const tenderedRaw = Number((p as any)?.amount ?? (p as any)?.tender ?? (p as any)?.paid ?? applied);
      const tendered = Number.isFinite(tenderedRaw) ? round2(Math.max(0, tenderedRaw)) : 0;
      const changeRaw = Number((p as any)?.change ?? (p as any)?.changeDue ?? 0);
      const change = Number.isFinite(changeRaw) ? round2(Math.max(0, changeRaw)) : 0;

      const d = parseDateValue((p as any)?.at ?? (p as any)?.date ?? (p as any)?.createdAt ?? (p as any)?.timestamp ?? null);
      const sortTs = d ? d.getTime() : 0;
      const at = d
        ? `${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })}`
        : undefined;

      const label = isCash ? 'Cash received' : type;
      const key = `${at || ''}|${label}`;
      const existing = map.get(key);

      const amountToAdd = isCash ? tendered : applied;
      const changeToAdd = isCash ? change : 0;

      if (existing) {
        existing.amount = round2(existing.amount + amountToAdd);
        existing.change = round2(existing.change + changeToAdd);
        if (!existing.sortTs && sortTs) existing.sortTs = sortTs;
        if (!existing.at && at) existing.at = at;
      } else {
        map.set(key, {
          label,
          at,
          sortTs,
          amount: round2(amountToAdd),
          change: round2(changeToAdd),
        });
      }
    }

    return Array.from(map.values())
      .filter(r => r.amount > 0.009 || r.change > 0.009)
      .sort((a, b) => (a.sortTs || 0) - (b.sortTs || 0));
  }, [data, addonSale, isSaleReceipt, displayAmountPaid]);

  const consultationType = (data as any).consultationType as string | undefined;
  const isConsultationReceipt = isSaleReceipt && !!consultationType;
  const consultationAddress = (data as any).consultationAddress as string | undefined;
  const appointmentDate = (data as any).appointmentDate as string | undefined;
  const appointmentTime = (data as any).appointmentTime as string | undefined;
  const appointmentEndTime = (data as any).appointmentEndTime as string | undefined;
  const consultationHours = (data as any).consultationHours as number | undefined;
  const driverFee = (data as any).driverFee as number | undefined;

  function fmt12(hhmm?: string) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m ?? 0).padStart(2, '0')} ${ampm}`;
  }

  function fmtApptDate(iso?: string) {
    if (!iso) return '';
    try {
      const [y, mo, d] = iso.split('-').map(Number);
      return new Date(y, mo - 1, d).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch { return iso; }
  }

  return (
        <div className="receipt-root" style={{ background: '#f3f4f6', color: '#111', padding: '12px 0', fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          html, body { background: #fff; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .receipt-root { background: #fff !important; padding: 0 !important; }
        }
      .page { width: 210mm; margin: 0 auto 20px; background: #fff; padding: 12mm; box-shadow: 0 2px 20px rgba(0,0,0,0.12); box-sizing: border-box; display: flex; flex-direction: column; position: relative; }
      .page-inner { display: flex; flex-direction: column; min-height: 0; }
        .brand { display:grid; grid-template-columns:minmax(0,1fr) minmax(15rem,auto); align-items:center; gap:10px; margin-bottom:10px; }
        .brand-left { display:flex; min-width:0; align-items:center; gap:12px; }
        .brand-right { min-width:15rem; text-align:right; font-size: 10pt; line-height:1.25; }
        .brand-right > div, .brand-right > div > div { white-space:nowrap; }
        .brand-title { font-weight:700; letter-spacing:0.3px; }
        .slogan { color:#444; font-style:italic; margin-top:4px; }
  .section { border:1px solid #d1d5db; border-radius:6px; padding:8px; margin-bottom:10px; }
  .muted-bg { background: #f8fafc; }
  .chip { display:inline-block; padding:3px 6px; border-radius:6px; background:#f3f4f6; border:1px solid #e5e7eb; }
        .info-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:6px 12px; align-items:start; }
        .field { display:flex; gap:6px; align-items:baseline; min-width:0; }
        .label-inline { color:#555; font-size:9.5pt; font-weight:600; }
        .value-inline { font-size:10.5pt; color:#111; min-width:0; overflow-wrap:anywhere; }
  .items { width:100%; border-collapse:collapse; }
  .items thead th { text-align:left; border-bottom:1px solid #d1d5db; padding:6px 8px; font-size:10pt; color:#222; font-weight:600; background:#f3f4f6; }
  .items tbody tr:nth-child(odd) { background: #fafafa; }
        .items td:first-child { font-weight:600; color:#111; }
  .footer { margin-top: 10px; }
  @media print {
        .page { width: auto; margin: 0; box-shadow: none; padding: 0; }
        .page-inner { padding: 0; }
  }
        .totals { width:48%; margin-left:auto; border:1px solid #d1d5db; border-radius:6px; padding:10px; }
        .totals .row { display:flex; gap:12px; align-items:center; }
        .totals .label { width:60%; color:#444; }
        .circuit { position:absolute; top: 8mm; right: 8mm; pointer-events:none; opacity:0.06; }
        .terms { font-size:9pt; color:#222; }
        .toolbar { display:flex; justify-content:flex-end; gap:8px; margin-bottom:8px; position:sticky; top:0; background:#fff; padding-bottom:6px; z-index:5; }
        @media print { .toolbar { display:none; } .no-print { display:none !important; } }
      `}</style>
      <div className="page">
        <svg className="circuit" width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#39FF14" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#39FF14" stopOpacity="0.2" />
            </linearGradient>
          </defs>
          <g fill="none" stroke="url(#g1)" strokeWidth="1.2">
            <rect x="10" y="10" width="30" height="30" rx="4" />
            <rect x="60" y="20" width="40" height="20" rx="4" />
            <path d="M40 25 L60 25" />
            <circle cx="50" cy="25" r="2" />
            <path d="M25 40 L25 70 L90 70" />
            <circle cx="25" cy="55" r="2.5" />
            <circle cx="90" cy="70" r="2.5" />
            <path d="M90 70 L100 80 M100 80 L110 70" />
            <path d="M75 40 L75 55 L95 55" />
            <circle cx="95" cy="55" r="2" />
          </g>
        </svg>
        <div className="page-inner">
        <div className="toolbar">
          <button
            onClick={() => { try { window.focus(); window.print(); } catch {} }}
            style={{ background:'#111', color:'#39FF14', border:'1px solid #39FF14', padding:'6px 12px', borderRadius:6, fontSize:'10pt', cursor:'pointer' }}
          >Print</button>
          <button
            onClick={async () => {
              try {
                const embeddedLogo =
                  logoSrc ||
                  (await fetchPublicAssetAsDataUrlCached('logo.png')) ||
                  (await fetchPublicAssetAsDataUrlCached('logo-spin.gif')) ||
                  '';

                let html = document.documentElement.outerHTML;
                if (embeddedLogo) {
                  html = html.replace(/src=\"[^\"]*logo\.png\"/gi, `src=\"${embeddedLogo}\"`);
                  html = html.replace(/src=\"[^\"]*logo-spin\.gif\"/gi, `src=\"${embeddedLogo}\"`);
                }
                const base = `${isSaleReceipt ? 'sale' : 'workorder'}-receipt-${data.id || 'draft'}`;
                const res = await (window as any).api.exportPdf(html, base);
                if (!res?.ok && res?.canceled) return;
                if (!res?.ok) alert('Export failed: ' + (res?.error || 'Unknown error'));
              } catch (e:any) {
                alert('Export failed: ' + (e?.message || String(e)));
              }
            }}
            style={{ background:'#111', color:'#39FF14', border:'1px solid #39FF14', padding:'6px 12px', borderRadius:6, fontSize:'10pt', cursor:'pointer' }}
          >Download PDF</button>
        </div>
        <div className="brand">
          <div className="brand-left">
            {logoSrc ? (
              <img ref={logoImgRef} src={logoSrc} alt="GADGETBOY" style={{ height: 72, width: 'auto' }} />
            ) : (
              <img ref={logoImgRef} src={publicAsset('logo.png')} alt="GADGETBOY" style={{ height: 72, width: 'auto' }} />
            )}
            <div>
              <div className="brand-title">GADGETBOY Repair & Retail</div>
              <div style={{ fontSize: '10pt', color: '#222' }}>2822 Devine Street, Columbia, SC 29205</div>
              <div style={{ fontSize: '10pt', color: '#222' }}>(803) 708-0101 • gadgetboysc@gmail.com</div>
              <div className="slogan">The Solution Lives Here!</div>
            </div>
          </div>
          <div className="brand-right">
            {(data as any).workOrderType === 'durantReport' ? <><div style={{ fontWeight: 900, fontSize: '13pt' }}>Durant Report</div><div style={{ fontWeight: 800 }}>{(data as any).durantFullTransfer ? 'Full Transfer — diagnostic payment applies toward Durant bench fee' : 'Device remains with GadgetBoy'}</div></> : null}
            <div style={{ textAlign: 'right', fontSize: '10pt', lineHeight: '1.2' }}>
              <div><strong>Invoice:</strong> {invoiceNo}</div>
              <div><strong>Date/Time:</strong> {now.toLocaleDateString()} {now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })}</div>
              <div><strong>Client:</strong> {fullName}</div>
              <div><strong>Phone:</strong> {phone}</div>
              {phoneAlt ? <div><strong>Alt Phone:</strong> {phoneAlt}</div> : null}
              {email ? <div><strong>Email:</strong> {email}</div> : null}
            </div>
          </div>
        </div>

        {!isSaleReceipt ? (
          <>
            <div className="section muted-bg">
              <div className="info-grid">
                <div className="field"><span className="label-inline">Device:</span><span className="value-inline">{device}</span></div>
                <div className="field"><span className="label-inline">Description:</span><span className="value-inline"><span className="chip">{description}</span></span></div>
                <div className="field"><span className="label-inline">Model:</span><span className="value-inline">{model}</span></div>
                <div className="field"><span className="label-inline">Serial #:</span><span className="value-inline">{serial}</span></div>
                <div className="field"><span className="label-inline">Password:</span><span className="value-inline">{password}</span></div>
                {hasPattern ? (
                  <div className="field" style={{ gridColumn: '1 / -1', alignItems: 'center' }}>
                    <span className="label-inline">Pattern:</span>
                    <span className="value-inline" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span
                        aria-label="Unlock pattern"
                        dangerouslySetInnerHTML={{ __html: buildPatternSvg(patternSequence, 120) }}
                      />
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="section muted-bg" style={{ pageBreakInside: 'avoid' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Problem</div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.35, fontSize: '10.5pt' }}>{problem}</div>
            </div>
          </>
        ) : isConsultationReceipt ? (
          <div className="section muted-bg" style={{ pageBreakInside: 'avoid', borderColor: '#d97706' }}>
            <div style={{ fontWeight: 700, fontSize: '11pt', marginBottom: 8, color: '#92400e', letterSpacing: '0.3px' }}>Consultation Details</div>
            <div className="info-grid">
              <div className="field">
                <span className="label-inline">Type:</span>
                <span className="value-inline">{consultationType === 'athome' ? 'At-Home / On-Site' : 'In-Store'}</span>
              </div>
              {appointmentDate && (
                <div className="field">
                  <span className="label-inline">Appointment:</span>
                  <span className="value-inline">{fmtApptDate(appointmentDate)}</span>
                </div>
              )}
              {(appointmentTime || appointmentEndTime) && (
                <div className="field">
                  <span className="label-inline">Time:</span>
                  <span className="value-inline">
                    {fmt12(appointmentTime)}{appointmentEndTime ? ` – ${fmt12(appointmentEndTime)}` : ''}
                  </span>
                </div>
              )}
              {consultationHours != null && (
                <div className="field">
                  <span className="label-inline">Hours Worked:</span>
                  <span className="value-inline">{consultationHours}</span>
                </div>
              )}
              {consultationType === 'athome' && consultationAddress && (
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <span className="label-inline">Address:</span>
                  <span className="value-inline">{consultationAddress}</span>
                </div>
              )}
              {driverFee != null && driverFee > 0 && (
                <div className="field">
                  <span className="label-inline">Distance Surcharge:</span>
                  <span className="value-inline">${Number(driverFee).toFixed(2)}</span>
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div className="section muted-bg">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Items</div>
          {!isSaleReceipt ? (
            <table className="items" role="table" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th scope="col">Repair Service / Description</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Parts</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Labor</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it: any) => {
                  const parts = typeof it.parts === 'number' ? it.parts : (typeof it.partCost === 'number' ? it.partCost : 0);
                  const labor = typeof it.labor === 'number' ? it.labor : (typeof it.unitPrice === 'number' ? it.unitPrice : (typeof it.laborCost === 'number' ? it.laborCost : 0));
                  const desc = it.repair || it.description || it.title || it.name || it.altDescription || '';
                  return (
                    <tr key={it.id}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', overflowWrap: 'anywhere' }}>{desc}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>{parts ? parts.toFixed(2) : ''}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>{labor ? labor.toFixed(2) : ''}</td>
                    </tr>
                  );
                })}

                {addonSaleItems.map((it) => {
                  const qtySuffix = it.qty && it.qty !== 1 ? ` (x${it.qty})` : '';
                  const desc = `${it.description || ''}${qtySuffix}`.trim();
                  const parts = Number(it.total || 0) || 0;
                  return (
                    <tr key={`addon-${it.id}`}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', overflowWrap: 'anywhere' }}>{desc}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>{parts ? parts.toFixed(2) : ''}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="items" role="table" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" style={{ width: 60, textAlign: 'right' }}>Qty</th>
                  <th scope="col" style={{ width: 110, textAlign: 'right' }}>Price</th>
                  <th scope="col" style={{ width: 120, textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {saleItems.map((it: { id: string; description: string; qty: number; price: number; total: number }) => (
                  <tr key={it.id}>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', overflowWrap: 'anywhere' }}>{it.description}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>{it.qty}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>{it.price ? it.price.toFixed(2) : ''}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>{it.total ? it.total.toFixed(2) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Totals under list, aligned right */}
        <div className="totals" style={{ marginBottom: 10 }}>
          {!isSaleReceipt ? (
            <>
              <div className="row"><div className="label">Total Parts</div><div style={{ marginLeft: 'auto' }}>{displayPartCosts.toFixed(2)}</div></div>
              <div className="row"><div className="label">Total Labor</div><div style={{ marginLeft: 'auto' }}>{laborCost.toFixed(2)}</div></div>
              <div className="row"><div className="label">Discount</div><div style={{ marginLeft: 'auto' }}>{discount.toFixed(2)}</div></div>
              <div className="row"><div className="label">Taxes ({taxRate.toFixed(2)}%)</div><div style={{ marginLeft: 'auto' }}>{displayTaxes.toFixed(2)}</div></div>
              <div className="row"><div className="label">Amount Paid</div><div style={{ marginLeft: 'auto' }}>{displayAmountPaid.toFixed(2)}</div></div>
              <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '8px 0' }} />
              <div className="row"><div className="label"><strong>Remaining Balance</strong></div><div style={{ marginLeft: 'auto' }}><strong>{displayRemaining.toFixed(2)}</strong></div></div>
            </>
          ) : (
            <>
              <div className="row"><div className="label">Subtotal</div><div style={{ marginLeft: 'auto' }}>{subTotal.toFixed(2)}</div></div>
              <div className="row"><div className="label">Discount</div><div style={{ marginLeft: 'auto' }}>{discount.toFixed(2)}</div></div>
              <div className="row"><div className="label">Taxes ({taxRate.toFixed(2)}%)</div><div style={{ marginLeft: 'auto' }}>{taxes.toFixed(2)}</div></div>
              <div className="row"><div className="label"><strong>Total</strong></div><div style={{ marginLeft: 'auto' }}><strong>{totalDue.toFixed(2)}</strong></div></div>
              <div className="row"><div className="label">Amount Paid</div><div style={{ marginLeft: 'auto' }}>{amountPaid.toFixed(2)}</div></div>
              <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '8px 0' }} />
              <div className="row"><div className="label"><strong>Balance Due</strong></div><div style={{ marginLeft: 'auto' }}><strong>{remaining.toFixed(2)}</strong></div></div>
            </>
          )}
        </div>

        {paymentRows.length ? (
          <div className="section muted-bg" style={{ width: '48%', marginLeft: 'auto', pageBreakInside: 'avoid' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Payments</div>
            <table className="items" role="table" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th scope="col">Payment</th>
                  <th scope="col" style={{ width: 120, textAlign: 'right' }}>Amount</th>
                  <th scope="col" style={{ width: 110, textAlign: 'right' }}>Change</th>
                </tr>
              </thead>
              <tbody>
                {paymentRows.map((p, idx) => (
                  <tr key={`${p.label}-${p.at || ''}-${idx}`}>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', overflowWrap: 'anywhere' }}>
                      <div style={{ fontWeight: 600, color: '#111' }}>{p.label}</div>
                      {p.at ? <div style={{ fontSize: '9pt', color: '#555', marginTop: 2 }}>{p.at}</div> : null}
                    </td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>{p.amount ? p.amount.toFixed(2) : ''}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>{p.change ? p.change.toFixed(2) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {isSaleReceipt ? (
          <div className="section muted-bg terms" style={{ pageBreakInside: 'avoid' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {isConsultationReceipt ? 'Consultation Terms & Agreement' : 'Sales Terms & Conditions'}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.35 }}>
              {isConsultationReceipt
                ? `This document confirms the scheduled consultation listed above.\nPayment is due at completion of service unless otherwise arranged in writing.\nThe hourly rate applies to all time on-site or in-store. Travel time may apply for on-site visits.\nGadgetBoy is not responsible for pre-existing conditions discovered during the consultation.\nBy signing below, the client authorizes the consultation and acknowledges the pricing terms.`
                : `Please keep this receipt for any return/exchange or warranty service.\nItems are sold as-is unless otherwise stated in writing.\nReturns/exchanges are subject to store policy and may not apply to all items.\nBy signing below, customer acknowledges receipt of goods and acceptance of these terms.`}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 16, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <div style={{ borderBottom: '1px solid #111', height: 22 }} />
                <div style={{ fontSize: '9pt', color: '#444', marginTop: 4 }}>Customer Signature</div>
              </div>
              <div style={{ width: 180 }}>
                <div style={{ borderBottom: '1px solid #111', height: 22 }} />
                <div style={{ fontSize: '9pt', color: '#444', marginTop: 4 }}>Date</div>
              </div>
            </div>
          </div>
        ) : null}

        {/* end receipt body */}

        </div>
      </div>
    </div>
  );
};

export default CustomerReceiptWindow;
