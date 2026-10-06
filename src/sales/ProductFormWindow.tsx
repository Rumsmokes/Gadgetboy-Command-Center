// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchPublicAssetAsDataUrlCached, publicAsset } from '../lib/publicAsset';
import { formatPhone } from '../lib/format';
import { consumeWindowPayload } from '../lib/windowPayload';
import QRCode from 'qrcode';

function getPayload() {
  try {
    const stored = consumeWindowPayload('productForm');
    if (stored !== null) return stored;
  } catch {}
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('productForm');
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch { return null; }
}

function getFlags() {
  try { const p = new URLSearchParams(window.location.search); return { autoPrint: p.get('autoPrint') === '1' || p.get('autoPrint') === 'true', silent: p.get('silent') === '1' || p.get('silent') === 'true' }; }
  catch { return { autoPrint: false, silent: false }; }
}

const Row: React.FC<{ label: string; value?: any }> = ({ label, value }) => (
  <div style={{ display: 'flex', marginBottom: 6 }}>
    <div style={{ width: 180, color: '#444' }}>{label}</div>
    <div style={{ flex: 1, borderBottom: '1px solid #ddd', paddingBottom: 2 }}>{value ?? ''}</div>
  </div>
);

const ProductFormWindow: React.FC = () => {
  const data = useMemo(() => getPayload() || {}, []);
  const flags = useMemo(() => getFlags(), []);
  const saleId = Number((data as any).id || 0) || 0;
  const saleRequiresQr = saleId > 0;

  const [logoSrc, setLogoSrc] = useState('');
  const [qrSrc, setQrSrc] = useState('');
  const [qrResolved, setQrResolved] = useState(() => !saleRequiresQr);
  const didAutoPrintRef = useRef(false);
  const logoImgRef = useRef<HTMLImageElement | null>(null);
  const qrImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const src = (await fetchPublicAssetAsDataUrlCached('logo.png')) || (await fetchPublicAssetAsDataUrlCached('logo-spin.gif')) || '';
      if (!alive) return;
      setLogoSrc(src);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!saleRequiresQr) return;
    let alive = true;
    void (async () => {
      try {
        let result: any = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            result = await Promise.race([(window as any).api?.qrGetStatusUrl?.('sale', saleId), new Promise((_, reject) => window.setTimeout(() => reject(new Error('Sales QR status URL timed out.')), 5000))]);
            if (result?.ok && String(result?.url || '').trim()) break;
          } catch {}
          if (attempt < 3) await new Promise<void>((resolve) => window.setTimeout(resolve, attempt * 350));
        }
        const url = String(result?.url || '').trim();
        if (result?.ok && url) {
          const value = await QRCode.toDataURL(url, { width: 176, margin: 1, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'M' });
          if (alive && value.startsWith('data:')) setQrSrc(value);
        }
      } finally { if (alive) setQrResolved(true); }
    })();
    return () => { alive = false; };
  }, [saleId, saleRequiresQr]);

  useEffect(() => {
    if (!flags.autoPrint || flags.silent || didAutoPrintRef.current) return;
    if (!qrResolved || (saleRequiresQr && !qrSrc)) return;
    const timer = window.setTimeout(() => { if (!didAutoPrintRef.current) { didAutoPrintRef.current = true; try { window.focus(); window.print(); } catch {} } }, 120);
    return () => window.clearTimeout(timer);
  }, [flags.autoPrint, flags.silent, qrResolved, saleRequiresQr, qrSrc]);

  useEffect(() => {
    if (!flags.autoPrint || !flags.silent) return;
    if (!qrResolved || (saleRequiresQr && !qrSrc)) return;
    let cancelled = false;
    void (async () => {
      const images = [logoImgRef.current, qrImgRef.current].filter(Boolean) as HTMLImageElement[];
      await Promise.all(images.map((img) => img.complete ? Promise.resolve() : new Promise<void>((resolve) => { const done = () => resolve(); img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true }); window.setTimeout(done, 800); })));
      try { await (document as any).fonts?.ready; } catch {}
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!cancelled) try { (window as any).api?.notifyProductFormReady?.(); } catch {}
    })();
    return () => { cancelled = true; };
  }, [flags.autoPrint, flags.silent, logoSrc, qrResolved, saleRequiresQr, qrSrc]);

  const qrPending = saleRequiresQr && (!qrResolved || !qrSrc);
  const fullName = data.customerName || data.clientName || '';
  const phoneRaw = data.customerPhone || data.phone || '';
  const phone = formatPhone(String(phoneRaw || '')) || String(phoneRaw || '');
  const email = String(data.customerEmail || data.email || '').trim();
  const printItems = Array.isArray(data.items) && data.items.length
    ? data.items.map((row: any) => ({
      description: String(row?.description || row?.itemDescription || row?.productDescription || 'Sale item'),
      qty: Math.max(1, Number(row?.qty ?? row?.quantity ?? 1) || 1),
      price: Math.max(0, Number(row?.price ?? row?.total ?? 0) || 0),
    }))
    : [{
      description: String(data.itemDescription || data.productDescription || 'Sale item'),
      qty: Math.max(1, Number(data.quantity || 1) || 1),
      price: Math.max(0, Number(data.price || data.total || 0) || 0),
    }];
  const subtotal = Number(data.subTotal ?? data.subtotal ?? printItems.reduce((sum: number, row: any) => sum + row.qty * row.price, 0)) || 0;
  const discount = Math.max(0, Number(data.discount || 0) || 0);
  const taxes = Math.max(0, Number(data.taxes ?? data.totals?.tax ?? 0) || 0);
  const total = Number(data.total ?? data.totals?.total ?? (subtotal - discount + taxes)) || 0;
  const remaining = Math.max(0, Number(data.remaining ?? data.totals?.remaining ?? (total - Number(data.amountPaid || 0))) || 0);

  const terms = `By purchasing this product, the customer acknowledges and agrees that all sales are final unless otherwise stated by GadgetBoy Repair & Retail. Each device includes a 30-day limited warranty covering hardware defects or malfunctions not caused by misuse, physical or liquid damage, unauthorized repair attempts, or software alterations. The customer understands and accepts the condition of the device as described at the time of sale, including any cosmetic wear consistent with its grade (Fair, Good, or Excellent). This warranty applies only to the specific issue diagnosed and repaired or to the product as sold, and does not cover wear and tear, battery health degradation, accidental damage, or user-inflicted issues. GadgetBoy reserves the right to inspect and verify any warranty claim prior to service or replacement. The customer accepts responsibility for maintaining and using the product as intended, and understands that any tampering or modification voids the warranty.`;

  return (
    <div style={{ background: '#f3f4f6', color: '#111', minHeight: '100vh', padding: '12px 0', fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print { html, body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
        .page { width: 210mm; min-height: 297mm; margin: 0 auto 20px; background: #fff; padding: 12mm; box-shadow: 0 2px 20px rgba(0,0,0,0.12); box-sizing: border-box; display: flex; flex-direction: column; position: relative; }
        .page-inner { display: flex; flex-direction: column; min-height: 0; }
        .section { border:1px solid #e5e7eb; border-radius: 6px; padding: 8px; margin-bottom: 10px; }
        .footer { margin-top: 10px; }
        @media print {
          .page { height: calc(297mm - 24mm); margin: 0 auto; box-shadow: none; padding: 0; }
          .page-inner { padding: 12mm; }
        }
        .totals { width: 48%; margin-left: auto; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px; background: #fff; }
        .totals .row { display:flex; gap:12px; align-items:center; }
        .totals .label { width:60%; color:#444; }
        .terms { font-size: 9pt; color: #222; }
        .toolbar { display:flex; justify-content:flex-end; gap:8px; margin-bottom:8px; position:sticky; top:0; background:#fff; padding-bottom:6px; z-index:5; }
        @media print { .toolbar { display:none; } }
      `}</style>
      <div className="page">
        <div className="page-inner">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img ref={logoImgRef} src={logoSrc || publicAsset('logo.png')} alt="GadgetBoy" style={{ height: 36, width: 'auto' }} />
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.2, lineHeight: 1.1 }}>GADGETBOY REPAIR & RETAIL</div>
                <div style={{ fontSize: 11, color: '#666' }}>Product Sales Form</div>
              </div>
            </div>
            {qrSrc ? <div style={{ display: 'grid', justifyItems: 'center', gap: 2, marginLeft: 'auto', marginRight: 16 }}><img ref={qrImgRef} src={qrSrc} alt="Sales update QR" style={{ width: 88, height: 88, display: 'block' }} /><div style={{ fontSize: 9, color: '#666', fontWeight: 700, letterSpacing: 0.4 }}>SALES UPDATE</div></div> : null}
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: '#111' }}>2822 Devine Street, Columbia, SC 29205</div>
              <div style={{ fontSize: 11, color: '#111' }}>803-708-0101</div>
              <div style={{ fontSize: 10, color: '#666' }}>Mon–Fri 10am–7pm · Sat 10am–8pm</div>
              <div style={{ marginTop: 2, fontSize: 11, color: '#666' }}>Sale: {data.id ? String(data.id).padStart(6, '0') : '—'}</div>
              <div style={{ fontSize: 11, color: '#666' }}>Date: {new Date().toLocaleDateString()}</div>
            </div>
          </div>

          <div className="section" style={{ background: '#f8fafc' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div><div style={{ color: '#666', fontSize: 11 }}>Customer</div><div style={{ borderBottom: '1px solid #e5e7eb' }}>{fullName}</div></div>
              <div><div style={{ color: '#666', fontSize: 11 }}>Phone</div><div style={{ borderBottom: '1px solid #e5e7eb' }}>{phone}</div></div>
              <div><div style={{ color: '#666', fontSize: 11 }}>Email</div><div style={{ borderBottom: '1px solid #e5e7eb' }}>{email}</div></div>
              <div><div style={{ color: '#666', fontSize: 11 }}>Condition</div><div style={{ borderBottom: '1px solid #e5e7eb' }}>{data.condition || ''}</div></div>
            </div>
            <div style={{ marginTop: 6 }}>
              <div style={{ color: '#666', fontSize: 11 }}>Notes</div>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 4, padding: '6px 8px', minHeight: 28, whiteSpace: 'pre-wrap' }}>{data.notes || ''}</div>
            </div>
          </div>

          <div className="section" style={{ background: '#f8fafc' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Items</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: '4px 3px', fontSize: 11, color: '#666' }}>Description</th>
                  <th style={{ textAlign: 'right', borderBottom: '1px solid #e5e7eb', padding: '4px 3px', fontSize: 11, color: '#666' }}>Qty</th>
                  <th style={{ textAlign: 'right', borderBottom: '1px solid #e5e7eb', padding: '4px 3px', fontSize: 11, color: '#666' }}>Price</th>
                </tr>
              </thead>
              <tbody>
                {printItems.map((row: any, idx: number) => (
                  <tr key={`sale-item-${idx}`}>
                    <td style={{ padding: '4px 3px', borderBottom: '1px solid #f1f5f9', overflowWrap: 'anywhere' }}>{row.description}</td>
                    <td style={{ padding: '4px 3px', borderBottom: '1px solid #f1f5f9', textAlign: 'right' }}>{row.qty}</td>
                    <td style={{ padding: '4px 3px', borderBottom: '1px solid #f1f5f9', textAlign: 'right' }}>${row.price.toFixed(2)}</td>
                  </tr>
                ))}
                {Array.from({ length: Math.max(0, 5 - printItems.length) }).map((_, idx) => (
                  <tr key={`filler-${idx}`}>
                    <td style={{ padding: '12px 3px', borderBottom: '1px solid #f1f5f9' }}>&nbsp;</td>
                    <td style={{ padding: '12px 3px', borderBottom: '1px solid #f1f5f9' }}>&nbsp;</td>
                    <td style={{ padding: '12px 3px', borderBottom: '1px solid #f1f5f9' }}>&nbsp;</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="toolbar">
            <button disabled={qrPending} title={qrPending ? 'Generating the sales update QR before printing.' : 'Print'} onClick={() => { try { window.focus(); window.print(); } catch {} }} style={{ background:'#fff', color: qrPending ? '#999' : '#111', border:'1px solid #111', padding:'6px 12px', borderRadius:6, fontSize:'10pt', cursor: qrPending ? 'wait' : 'pointer' }}>{qrPending ? 'Preparing QR…' : 'Print'}</button>
            <button
              onClick={async () => {
                try {
                  let html = document.documentElement.outerHTML;
                  if (!logoSrc) {
                    const embeddedLogo =
                      (await fetchPublicAssetAsDataUrlCached('logo.png')) ||
                      (await fetchPublicAssetAsDataUrlCached('logo-spin.gif')) ||
                      '';
                    if (embeddedLogo) {
                      html = html.replace(/src=\"[^\"]*logo\.png\"/gi, `src=\"${embeddedLogo}\"`);
                      html = html.replace(/src=\"[^\"]*logo-spin\.gif\"/gi, `src=\"${embeddedLogo}\"`);
                    }
                  }
                  const base = `product-form-${data.id || 'draft'}`;
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

          {/* Totals under the list, aligned right */}
          <div className="totals">
            <div className="row"><div className="label">Subtotal</div><div style={{ marginLeft: 'auto' }}>${subtotal.toFixed(2)}</div></div>
            {discount ? <div className="row"><div className="label">Discount</div><div style={{ marginLeft: 'auto' }}>-${discount.toFixed(2)}</div></div> : null}
            {data.taxRate ? <div className="row"><div className="label">Tax Rate</div><div style={{ marginLeft: 'auto' }}>{`${data.taxRate}%`}</div></div> : null}
            {taxes ? <div className="row"><div className="label">Tax</div><div style={{ marginLeft: 'auto' }}>${taxes.toFixed(2)}</div></div> : null}
            <div className="row"><div className="label">Total</div><div style={{ marginLeft: 'auto' }}>${total.toFixed(2)}</div></div>
            <div className="row"><div className="label">Amount Paid</div><div style={{ marginLeft: 'auto' }}>${Number(data.amountPaid || 0).toFixed(2)}</div></div>
            <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '8px 0' }} />
            <div className="row"><div className="label"><strong>Remaining</strong></div><div style={{ marginLeft: 'auto' }}><strong>${remaining.toFixed(2)}</strong></div></div>
          </div>

          {/* Terms and signature removed per request */}
        </div>
      </div>
    </div>
  );
};

export default ProductFormWindow;
