export type LineItem = { description: string; parts: number; labor: number; qty?: number; discountType?: 'percent' | 'amount'; discountValue?: number };
export type WorkOrder = {
  invoiceId: string;
  /** Numeric work-order / sale ID used to build the technician QR URL. Falls back to Number(invoiceId). */
  id?: number;
  /** Record type for the QR status URL — defaults to 'repair'. */
  type?: 'repair' | 'sale';
  dateTimeISO: string;
  clientName: string;
  phone: string;
  phoneAlt?: string;
  email: string;

  device: string;
  description: string;
  model: string;
  serialNumber: string;
  password: string;
  patternSequence: number[]; // indices 0..8 for 3x3 grid
  problem: string;

  items: LineItem[];
  subTotalParts: number;
  subTotalLabor: number;
  discount: number;  // absolute
  taxRate: number;   // percent, e.g. 8
  taxes: number;
  amountPaid: number;
  notes?: string;
  workOrderType?: string;
  durantFullTransfer?: boolean;
};

import { fetchPublicAssetAsDataUrlCached } from '../lib/publicAsset';
import { formatPhone } from '../lib/format';
import { discountedWorkOrderItemAmounts } from '../lib/ticketAccounting';
import { printPageProtectionCss } from '../lib/reliability';

export function buildPatternSvg(seq: number[], size: number = 140): string {
  const padding = 12;
  const grid = 3;
  const gap = (size - padding * 2) / (grid - 1);
  const dots: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      dots.push({ x: padding + c * gap, y: padding + r * gap });
    }
  }
  const path: string[] = [];
  const selected = new Set<number>();
  for (let i = 0; i < seq.length; i++) {
    const idx = seq[i];
    if (idx < 0 || idx > 8) continue;
    selected.add(idx);
    const p = dots[idx];
    if (i === 0) path.push(`M ${p.x} ${p.y}`);
    else path.push(`L ${p.x} ${p.y}`);
  }
  const numbers = Array.from(seq.entries()).map(([i, idx]) => {
    const p = dots[idx];
    const n = i + 1;
    return `<g>
      <circle cx="${p.x}" cy="${p.y}" r="11" fill="#111" />
      <text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="11" fill="#fff" font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial">${n}</text>
    </g>`;
  }).join('');
  const circles = dots.map((p, i) => {
    const isSel = selected.has(i);
    return `<circle cx="${p.x}" cy="${p.y}" r="5" stroke="#555" stroke-width="1" fill="${isSel ? '#39FF14' : 'none'}"/>`;
  }).join('');
  const d = path.join(' ');
  const defs = `
    <defs>
      <marker id="arrow-end-print" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#111" />
      </marker>
    </defs>`;
  const line = d ? `<path d="${d}" fill="none" stroke="#111" stroke-width="2" ${seq.length ? 'marker-end="url(#arrow-end-print)"' : ''}/>` : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pattern">
    ${defs}
    <rect x="0" y="0" width="${size}" height="${size}" fill="none" />
    ${line}
    ${circles}
    ${numbers}
  </svg>`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildHtml(wo: WorkOrder, opts?: { logoSrc?: string; autoCloseMs?: number; autoPrint?: boolean; qrSrc?: string }): string {
  const logoSrc = opts?.logoSrc ?? '';
  const autoCloseMs = typeof opts?.autoCloseMs === 'number' ? opts!.autoCloseMs : 3000;
  const autoPrint = opts?.autoPrint ?? true;
  const now = new Date();
  const dateStr = isNaN(now.getTime()) ? '' : `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
  const displayPhone = formatPhone(String(wo.phone || '')) || String(wo.phone || '');
  const displayPhoneAlt = formatPhone(String(wo.phoneAlt || '')) || String(wo.phoneAlt || '');
  const itemList = Array.isArray(wo.items) ? wo.items : [];
  const sanitizedItems = itemList.map(li => { const amount = discountedWorkOrderItemAmounts(li); return {
    description: htmlEscape(li.description || '') + (amount.discount > 0 ? `<br><small>Line discount: -$${amount.discount.toFixed(2)}</small>` : ''),
    parts: amount.parts.toFixed(2), labor: amount.labor.toFixed(2),
  }; });
  const columnCount = sanitizedItems.length > 10 ? 2 : 1;
  const perCol = columnCount === 2 ? Math.ceil(sanitizedItems.length / 2) : sanitizedItems.length;
  const columns: string[] = [];
  for (let c = 0; c < columnCount; c++) {
    const slice = sanitizedItems.slice(c * perCol, (c + 1) * perCol);
    const body = slice.map(li => `
      <tr>
        <td class="item-desc">${li.description}</td>
        <td class="item-num">${li.parts}</td>
        <td class="item-num">${li.labor}</td>
      </tr>
    `).join('');
    columns.push(`
      <table class="items" role="table">
        <thead>
          <tr>
            <th scope="col">Repair Service / Description</th>
            <th scope="col" style="text-align:right;">Parts</th>
            <th scope="col" style="text-align:right;">Labor</th>
          </tr>
        </thead>
        <tbody>
          ${body || '<tr><td colspan="3" style="padding:6px 8px; color:#777;">No items</td></tr>'}
        </tbody>
      </table>
    `);
  }
  const remaining = (wo.subTotalParts + wo.subTotalLabor - wo.discount + wo.taxes) - wo.amountPaid;
  const seq = Array.isArray(wo.patternSequence) ? wo.patternSequence : [];
  const hasPattern = seq.length > 0;
  const invoiceDisplay = (wo.invoiceId ?? '').toString().padStart(6, '0');
  const logoBlock = logoSrc
    ? `<img src="${logoSrc}" alt="GADGETBOY" style="height:72px; width:auto;" />`
    : `<div style="height:72px; display:flex; align-items:center; font-weight:800; font-size:22pt; letter-spacing:0.8px;">GADGETBOY</div>`;

  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Release Form - ${htmlEscape(invoiceDisplay)}</title>
    <style>
      @page { size: A4; margin: 12mm; }
      html, body { background:#fff; color:#111; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size: 11pt; margin: 0; }
      .page { width: auto; margin: 0; background: #fff; box-sizing: border-box; padding: 12mm; }
      .brand { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(15rem,auto); align-items:center; gap:10px; margin-bottom:10px; }
      .brand-left { display:flex; min-width:0; align-items:center; gap:12px; }
      .brand-right { min-width:15rem; text-align:right; font-size: 10pt; line-height:1.25; }
      .brand-right > div { white-space:nowrap; }
      .brand-center { display:flex; width:78px; flex-direction:column; align-items:center; justify-content:center; padding:0 3px; }
      .brand-title { font-weight:700; letter-spacing:0.3px; }
      .slogan { color:#444; font-style:italic; margin-top:4px; }
      .section { border:1px solid #d1d5db; border-radius:6px; padding:10px; margin-bottom:10px; }
      .muted-bg { background: #f8fafc; }
      .info-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:6px 12px; align-items:start; }
      .field { display:flex; gap:6px; align-items:baseline; min-width:0; }
      .label-inline { color:#555; font-size:9.5pt; font-weight:600; }
      .value-inline { font-size:10.5pt; color:#111; min-width:0; overflow-wrap:anywhere; }
      .value-block { font-size:10.5pt; color:#111; line-height:1.35; white-space:pre-wrap; }
      .items-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:8px; }
      .items { width:100%; border-collapse:collapse; font-size:10pt; }
      .items thead th { text-align:left; border-bottom:1px solid #d1d5db; padding:5px 6px; font-size:10pt; color:#222; font-weight:600; background:#f3f4f6; }
      .items tbody tr:nth-child(odd) { background: #fafafa; }
      .items td { padding:5px 6px; border-bottom:1px solid #e5e7eb; }
      .items .item-desc { font-weight:600; color:#111; width:65%; }
      .items .item-num { text-align:right; white-space:nowrap; }
      .totals { width:48%; margin-left:auto; border:1px solid #d1d5db; border-radius:6px; padding:10px; }
      .totals .row { display:flex; gap:12px; align-items:center; }
      .totals .label { width:60%; color:#444; }
      .terms { font-size:9pt; text-align:center; color:#222; }
      .circuit { position:absolute; top: 8mm; right: 8mm; pointer-events:none; opacity:0.06; }
      .final-block { break-inside: avoid-page; page-break-inside: avoid; margin-top:12px; }
      .sig-row { display:flex; gap:16px; align-items:center; margin-top:12px; }
      .sig-line { flex:1; border-bottom:1px solid #000; height:24px; }
      .muted-label { color:#444; font-size:10pt; }
      ${printPageProtectionCss()}
    </style>
  </head>
  <body>
    <div class="page">
      <svg class="circuit" width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#39FF14" stop-opacity="0.5" />
            <stop offset="100%" stop-color="#39FF14" stop-opacity="0.2" />
          </linearGradient>
        </defs>
        <g fill="none" stroke="url(#g1)" stroke-width="1.2">
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

      <div class="brand">
        <div class="brand-left">
          ${logoBlock}
          <div>
            <div class="brand-title">GADGETBOY Repair & Retail</div>
            <div style="font-size:10pt; color:#222;">2822 Devine Street, Columbia, SC 29205</div>
            <div style="font-size:10pt; color:#222;">(803) 708-0101 • gadgetboysc@gmail.com</div>
            <div class="slogan">The Solution Lives Here!</div>
          </div>
        </div>
        ${opts?.qrSrc ? `
        <div class="brand-center">
          <img src="${opts.qrSrc}" alt="Tech Status QR" style="width:72px; height:72px; display:block;" />
          <div style="font-size:6.5pt; color:#555; text-align:center; margin-top:3px; letter-spacing:0.4px;">TECH SCAN</div>
        </div>
        ` : '<div class="brand-center"></div>'}
        <div class="brand-right">
          ${wo.workOrderType === 'durantReport' ? `<div style="font-size:13pt;font-weight:900;letter-spacing:.5px;">Durant Report</div>${wo.durantFullTransfer ? '<div style="font-weight:800;">Full Transfer</div>' : ''}` : ''}
          <div><strong>Invoice:</strong> ${htmlEscape(invoiceDisplay)}</div>
          <div><strong>Date/Time:</strong> ${htmlEscape(dateStr)}</div>
          <div><strong>Client:</strong> ${htmlEscape(wo.clientName)}</div>
          <div><strong>Phone:</strong> ${htmlEscape(displayPhone)}</div>
          ${displayPhoneAlt ? `<div><strong>Alt Phone:</strong> ${htmlEscape(displayPhoneAlt)}</div>` : ''}
          <div><strong>Email:</strong> ${htmlEscape(wo.email)}</div>
        </div>
      </div>

      <div class="section muted-bg">
        <div class="info-grid">
          <div class="field"><span class="label-inline">Device:</span><span class="value-inline">${htmlEscape(wo.device)}</span></div>
          <div class="field"><span class="label-inline">Description:</span><span class="value-inline"><span class="chip">${htmlEscape(wo.description)}</span></span></div>
          <div class="field"><span class="label-inline">Model:</span><span class="value-inline">${htmlEscape(wo.model)}</span></div>
          <div class="field"><span class="label-inline">Serial #:</span><span class="value-inline">${htmlEscape(wo.serialNumber)}</span></div>
          <div class="field"><span class="label-inline">Password:</span><span class="value-inline">${htmlEscape(wo.password)}</span></div>
          ${hasPattern ? `
            <div class="field" style="grid-column: 1 / span 2; align-items:center;">
              <span class="label-inline">Pattern:</span>
              <span class="value-inline" style="display:flex; align-items:center; gap:10px;">${buildPatternSvg(seq, 120)}</span>
            </div>
          ` : ''}
        </div>
      </div>

      <div class="section muted-bg" style="page-break-inside: avoid;">
        <div style="font-weight:600; margin-bottom:6px;">Problem</div>
        <div class="value-block">${htmlEscape(wo.problem)}</div>
      </div>

      <div class="section muted-bg" style="page-break-inside: avoid;">
        <div style="font-weight:600; margin-bottom:6px;">Items</div>
        <div class="items-grid">${columns.join('')}</div>
      </div>

      <div class="totals" style="margin-bottom:10px;">
        <div class="row"><div class="label">Total Parts</div><div style="margin-left:auto;">${wo.subTotalParts.toFixed(2)}</div></div>
        <div class="row"><div class="label">Total Labor</div><div style="margin-left:auto;">${wo.subTotalLabor.toFixed(2)}</div></div>
        <div class="row"><div class="label">Discount</div><div style="margin-left:auto;">${wo.discount.toFixed(2)}</div></div>
        <div class="row"><div class="label">Taxes (${(wo.taxRate).toFixed(2)}%)</div><div style="margin-left:auto;">${wo.taxes.toFixed(2)}</div></div>
        <div class="row"><div class="label">Amount Paid</div><div style="margin-left:auto;">${wo.amountPaid.toFixed(2)}</div></div>
        <hr style="border:none; border-top:1px solid #e5e7eb; margin:8px 0;" />
        <div class="row"><div class="label"><strong>Remaining Balance</strong></div><div style="margin-left:auto;"><strong>${remaining.toFixed(2)}</strong></div></div>
      </div>

      <div class="section final-block">
        <div class="terms" style="margin-bottom:14px;">
          By signing this form, you authorize GADGETBOY LLC to diagnose and/or repair your device. Repairs are performed to the best of our ability but are not guaranteed beyond the stated warranty. A diagnostic assessment will be completed prior to repairs, and a non-refundable diagnostic fee of up to $50 may be charged at drop-off. Additional costs will be communicated and must be approved before work continues. You are responsible for backing up all data; GADGETBOY LLC is not liable for data loss or incidental access to personal files. Certain repairs, including liquid or severe board damage, may not restore full functionality, and pre-existing issues may worsen. Customer-supplied or third-party parts are installed at your risk and are not warrantied. All repairs include a 90-day limited warranty from the completion date, covering only the specific repair performed. The warranty does not cover unrelated issues, software problems, physical or liquid damage, or devices tampered with after service. Full payment is due at pickup. Devices must be collected within 7 days of completion or will incur a $25/day storage fee. Any device left unclaimed 45 days after completion becomes the property of GADGETBOY LLC.
        </div>
        <div class="sig-row">
          <div class="muted-label">Signature</div>
          <div class="sig-line"></div>
          <div class="muted-label">Date</div>
          <div class="sig-line" style="max-width:120px;"></div>
        </div>
      </div>
    </div>
    <script>
      (function(){
        function doPrint(){ try { window.focus(); window.print(); } catch(e){} }
        function doClose(){ try { window.close(); } catch(e){} }
        function onReady(){
          var auto = ${autoPrint ? 'true' : 'false'};
          if (auto) {
            doPrint();
            var ms = ${autoCloseMs};
            if (ms && ms > 0) setTimeout(doClose, ms);
          }
        }
        if (document.readyState === 'complete') onReady(); else window.onload = onReady;
      })();
    </script>
  </body>
  </html>`;
}

function openPopupAndPrint(html: string): boolean {
  const w = window.open('', '_blank', 'noopener,noreferrer');
  if (!w) return false;
  try {
    w.document.open();
    w.document.write(html);
    w.document.close();
    return true;
  } catch {
    try { w.close(); } catch {}
    return false;
  }
}

function iframeFallback(html: string) {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.55)';
  overlay.style.zIndex = '999999';

  const panel = document.createElement('div');
  panel.style.position = 'absolute';
  panel.style.top = '5%';
  panel.style.left = '50%';
  panel.style.transform = 'translateX(-50%)';
  panel.style.width = '85%';
  panel.style.height = '90%';
  panel.style.background = '#111827';
  panel.style.border = '1px solid #374151';
  panel.style.borderRadius = '10px';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';

  const bar = document.createElement('div');
  bar.style.display = 'flex';
  bar.style.justifyContent = 'space-between';
  bar.style.alignItems = 'center';
  bar.style.padding = '8px 10px';
  bar.style.color = '#e5e7eb';
  bar.style.borderBottom = '1px solid #374151';
  bar.innerHTML = '<div style="font-weight:600">Print Preview</div>';

  const btns = document.createElement('div');
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.marginLeft = '8px';
  const print = document.createElement('button');
  print.textContent = 'Print';
  btns.appendChild(print); btns.appendChild(close);
  [print, close].forEach(b => {
    b.style.background = '#10b981';
    b.style.color = '#000';
    b.style.border = 'none';
    b.style.padding = '6px 12px';
    b.style.borderRadius = '6px';
    b.style.cursor = 'pointer';
  });
  close.style.background = '#f3f4f6';
  bar.appendChild(btns);

  const content = document.createElement('div');
  content.style.flex = '1';
  content.style.background = '#111';
  const iframe = document.createElement('iframe');
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  content.appendChild(iframe);

  panel.appendChild(bar);
  panel.appendChild(content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const doc = iframe.contentDocument;
  if (doc) { doc.open(); doc.write(html); doc.close(); }
  close.onclick = () => document.body.removeChild(overlay);
  print.onclick = () => iframe.contentWindow?.print();
}

export async function printReleaseForm(workOrder: WorkOrder, opts?: { logoSrc?: string; autoCloseMs?: number; autoPrint?: boolean }): Promise<void> {
  let resolvedLogoSrc = opts?.logoSrc;
  if (!resolvedLogoSrc) {
    resolvedLogoSrc = (await fetchPublicAssetAsDataUrlCached('logo.png')) || (await fetchPublicAssetAsDataUrlCached('logo-spin.gif')) || '';
  }

  // Generate technician QR code pointing to the status page
  let qrSrc = '';
  const recordId = Number(workOrder.id || workOrder.invoiceId || 0) || 0;
  if (recordId <= 0) {
    const message = 'Printing stopped because the work order has not been saved and its QR code cannot be created.';
    try { window.alert(message); } catch {}
    throw new Error(message);
  }
  if (recordId > 0) {
    let lastQrError: any = null;
    for (let attempt = 1; attempt <= 3 && !qrSrc; attempt += 1) try {
      const publicBase = String((import.meta as any).env?.VITE_PUBLIC_APP_URL || 'https://rumsmokes.github.io/Gadgetboy-Command-Center').replace(/\/$/, '');
      let qrUrl = '';
      if (workOrder.workOrderType === 'durantReport') {
        qrUrl = `${publicBase}/?durantTicket=${encodeURIComponent(String(recordId))}`;
      } else {
        const statusResult = await (window as any).api?.qrGetStatusUrl?.('repair', recordId);
        qrUrl = String(statusResult?.url || '').trim();
        if (!statusResult?.ok || !qrUrl) throw new Error(statusResult?.error || 'Work-order QR status URL is unavailable.');
      }
      const QRCode = (await import('qrcode')).default;
      const dataUrl: string = await QRCode.toDataURL(qrUrl, {
        width: 176, margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      });
      if (dataUrl && dataUrl.startsWith('data:')) qrSrc = dataUrl;
    } catch (error) {
      lastQrError = error;
      if (attempt < 3) await new Promise<void>((resolve) => window.setTimeout(resolve, attempt * 350));
    }
    if (!qrSrc) {
      const message = `Printing stopped because the work-order QR code could not be created. ${String(lastQrError?.message || 'Check the connection and try again.')}`;
      try { window.alert(message); } catch {}
      throw new Error('Printing stopped because the work-order QR code could not be created.', { cause: lastQrError });
    }
  }

  const html = buildHtml(workOrder, { ...opts, logoSrc: resolvedLogoSrc, qrSrc });
  const ok = openPopupAndPrint(html);
  if (!ok) iframeFallback(html);
}
