import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchPublicAssetAsDataUrlCached, publicAsset } from '../lib/publicAsset';
import { formatPhone } from '../lib/format';
import { consumeWindowPayload } from '../lib/windowPayload';
import { consultationLocationDisplay } from '../lib/consultationLocation';
import QRCode from 'qrcode';

function getPayload() {
  try {
    const stored = consumeWindowPayload('consultSheet');
    if (stored !== null) return stored;
  } catch {}
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('consultSheet');
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function getFlags() {
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

const ConsultSheetWindow: React.FC = () => {
  const data = useMemo(() => getPayload() || {}, []);
  const flags = useMemo(() => getFlags(), []);
  const consultationRequiresQr = Number((data as any).eventId || (data as any).id || 0) > 0;

  const [logoSrc, setLogoSrc] = useState<string>('');
  const [qrSrc, setQrSrc] = useState<string>('');
  const [qrResolved, setQrResolved] = useState<boolean>(() => !Number((data as any).eventId || 0));
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
    let alive = true;
    void (async () => {
      let eventId = Number((data as any).eventId || 0) || 0;
      if (!eventId && Number((data as any).id || 0) > 0) {
        try {
          const events = await (window as any).api?.dbGet?.('calendarEvents');
          const match = Array.isArray(events) ? events.find((event: any) => Number(event?.saleId || 0) === Number((data as any).id || 0) && String(event?.category || '').toLowerCase() === 'consultation') : null;
          eventId = Number(match?.id || 0) || 0;
        } catch {}
      }
      try {
        if (!eventId) return;
        const result: any = await Promise.race([(window as any).api?.qrGetStatusUrl?.('consult', eventId), new Promise((_, reject) => window.setTimeout(() => reject(new Error('QR status URL timed out.')), 5000))]);
        const url = String(result?.url || '').trim();
        if (!result?.ok || !url) return;
        const value = await QRCode.toDataURL(url, { width: 176, margin: 1, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'M' });
        if (alive && value.startsWith('data:')) setQrSrc(value);
      } catch {
        // Never silently print a consultation sheet without its required QR.
      } finally { if (alive) setQrResolved(true); }
    })();
    return () => { alive = false; };
  }, [data]);

  useEffect(() => {
    if (!flags.autoPrint || flags.silent) return;
    if (!qrResolved) return;
    if (consultationRequiresQr && !qrSrc) return;
    if (didAutoPrintRef.current) return;

    const fallback = window.setTimeout(() => {
      if (didAutoPrintRef.current) return;
      didAutoPrintRef.current = true;
      try { window.focus(); window.print(); } catch {}
      if (flags.autoCloseMs && flags.autoCloseMs > 0) {
        window.setTimeout(() => { try { window.close(); } catch {} }, flags.autoCloseMs);
      }
    }, 120);

    if (logoSrc) {
      window.clearTimeout(fallback);
      didAutoPrintRef.current = true;
      requestAnimationFrame(() => {
        try { window.focus(); window.print(); } catch {}
        if (flags.autoCloseMs && flags.autoCloseMs > 0) {
          window.setTimeout(() => { try { window.close(); } catch {} }, flags.autoCloseMs);
        }
      });
    }

    return () => window.clearTimeout(fallback);
  }, [flags.autoPrint, flags.autoCloseMs, flags.silent, logoSrc, qrResolved, qrSrc, consultationRequiresQr]);

  // When silently printing, the main-process print pipeline waits for this signal
  useEffect(() => {
    if (!flags.autoPrint || !flags.silent) return;
    if (!qrResolved) return;
    if (consultationRequiresQr && !qrSrc) return;

    let cancelled = false;

    const waitForImage = async () => {
      const images = [logoImgRef.current, qrImgRef.current].filter(Boolean) as HTMLImageElement[];
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
        window.setTimeout(finish, 800);
        });
      }));
    };

    const signalReady = async () => {
      try {
        await waitForImage();
        try {
          const fontSet = (document as any).fonts;
          if (fontSet?.ready) {
            await Promise.race([
              fontSet.ready,
              new Promise<void>((r) => window.setTimeout(r, 50)),
            ]);
          }
        } catch {}
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      } finally {
        if (!cancelled) {
          try { (window as any).api?.notifyConsultSheetReady?.(); } catch {}
        }
      }
    };

    void signalReady();
    return () => { cancelled = true; };
  }, [flags.autoPrint, flags.silent, logoSrc, qrResolved, qrSrc, consultationRequiresQr]);

  const qrPending = consultationRequiresQr && (!qrResolved || !qrSrc);
  const customerName = String((data as any).customerName || '').trim();
  const phoneRaw = String((data as any).customerPhone || '').trim();
  const phone = formatPhone(phoneRaw) || phoneRaw;
  const phoneAltRaw = String((data as any).customerPhoneAlt || '').trim();
  const phoneAlt = formatPhone(phoneAltRaw) || phoneAltRaw;
  const email = String((data as any).customerEmail || '').trim();

  const consultationDateLabel = String((data as any).consultationDateLabel || '').trim();
  const consultationTimeLabel = String((data as any).consultationTimeLabel || '').trim();
  const reasonForVisit = String((data as any).reasonForVisit || '').trim();
  const address = consultationLocationDisplay({
    consultationType: (data as any).consultationType,
    consultationAddress: (data as any).address,
  });

  const firstHourRateLabel = String((data as any).firstHourRateLabel || '').trim();
  const driverFeeLabel = String((data as any).driverFeeLabel || '').trim();
  const firstHourTotalLabel = String((data as any).firstHourTotalLabel || '').trim();

  return (
    <div className="gb-consult-sheet-window" style={{ background: '#f3f4f6', color: '#111', minHeight: '100vh', padding: '12px 0', fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
      <style>{`
        @page { size: Letter; margin: 12mm; }
        @media print { html, body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
        .page { width: 216mm; min-height: 279mm; margin: 0 auto 20px; background: #fff; padding: 12mm; box-shadow: 0 2px 20px rgba(0,0,0,0.12); box-sizing: border-box; display: flex; flex-direction: column; }
        @media print { .page { margin: 0 auto; box-shadow: none; } }
        .toolbar { display:flex; justify-content:flex-end; gap:8px; margin: 0 auto 8px; width: 216mm; padding: 0 12mm; box-sizing:border-box; }
        .btn { padding: 8px 12px; border-radius: 8px; border: 1px solid #111; background: #39FF14; color: #000; font-weight: 800; cursor: pointer; }
        .btn2 { padding: 8px 12px; border-radius: 8px; border: 1px solid #d4d4d8; background: #fff; color:#111; font-weight: 600; cursor: pointer; }
        @media print { .toolbar { display:none; } }
        .section { border:1px solid #e5e7eb; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
        .label { color:#52525b; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
        .value { border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; min-height: 18px; }
        .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .notesBox { border: 1px solid #e5e7eb; border-radius: 8px; min-height: 220px; background: repeating-linear-gradient(to bottom, #ffffff, #ffffff 22px, #f4f4f5 23px); }
      `}</style>

      <div className="toolbar">
        <button className="btn" disabled={qrPending} title={qrPending ? 'Generating the consultation update QR before printing.' : 'Print'} style={qrPending ? { opacity: .55, cursor: 'wait' } : undefined} onClick={() => { try { window.focus(); window.print(); } catch {} }}>{qrPending ? 'Preparing QR…' : 'Print'}</button>
        <button className="btn2" onClick={() => { try { window.close(); } catch {} }}>Close</button>
      </div>

      <div className="page">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img ref={logoImgRef} src={logoSrc || publicAsset('logo.png')} alt="GadgetBoy" style={{ height: 38, width: 'auto' }} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 0.2, lineHeight: 1.1 }}>GADGETBOY REPAIR & RETAIL</div>
              <div style={{ fontSize: 12, color: '#52525b', fontWeight: 700 }}>Consultation Sheet</div>
            </div>
          </div>
          {qrSrc ? (
            <div style={{ display: 'grid', justifyItems: 'center', gap: 2, marginLeft: 'auto', marginRight: 16 }}>
              <img ref={qrImgRef} src={qrSrc} alt="Consultation update QR" style={{ width: 88, height: 88, display: 'block' }} />
              <div style={{ fontSize: 9, color: '#52525b', fontWeight: 700, letterSpacing: 0.4 }}>CONSULTATION UPDATE</div>
            </div>
          ) : null}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#111' }}>2822 Devine Street, Columbia, SC 29205</div>
            <div style={{ fontSize: 11, color: '#111' }}>803-708-0101</div>
            <div style={{ fontSize: 10, color: '#52525b' }}>Mon–Fri 10am–7pm · Sat 10am–8pm</div>
          </div>
        </div>

        <div className="section">
          <div className="grid2">
            <div>
              <div className="label">Client</div>
              <div className="value">{customerName}</div>
            </div>
            <div>
              <div className="label">Consultation Date</div>
              <div className="value">{consultationDateLabel}</div>
            </div>
            <div>
              <div className="label">Phone</div>
              <div className="value">{phone}</div>
            </div>
            <div>
              <div className="label">Consultation Time</div>
              <div className="value">{consultationTimeLabel}</div>
            </div>
            <div>
              <div className="label">Alt Phone</div>
              <div className="value">{phoneAlt}</div>
            </div>
            <div>
              <div className="label">Email</div>
              <div className="value">{email}</div>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <div className="label">Address</div>
            <div className="value" style={{ minHeight: 22 }}>{address}</div>
          </div>

          <div style={{ marginTop: 10 }}>
            <div className="label">Reason For Visit</div>
            <div className="value" style={{ minHeight: 22 }}>{reasonForVisit}</div>
          </div>
        </div>

        <div className="section">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div className="label">Average Quote (First Hour)</div>
              <div className="value">{firstHourRateLabel}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div className="label">Driver Fee Included</div>
              <div className="value">{driverFeeLabel}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div className="label">Estimated First-Hour Total</div>
              <div className="value">{firstHourTotalLabel}</div>
            </div>
          </div>
        </div>

        <div className="section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <div style={{ fontWeight: 900, fontSize: 13 }}>Tech Notes</div>
            <div style={{ fontSize: 10, color: '#52525b' }}>Use this space to write job details</div>
          </div>
          <div className="notesBox" />
        </div>
      </div>
    </div>
  );
};

export default ConsultSheetWindow;
