import { publicAsset } from '../lib/publicAsset';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getOsOptions } from '../lib/osVersions';
import { deviceTypes as DEVICE_TYPE_DEFS } from '../lib/deviceTypes';
import { formatPhone } from '../lib/format';
import { useAutosave } from '../lib/useAutosave';
import { buildQuoteSalesPrompt, copyQuotePromptText } from '../lib/quoteSalesPrompt';
import type { SaleItemRow } from '../sales/SaleItemsTable';
import MoneyInput from './MoneyInput';
import PercentInput from './PercentInput';
import CustomerOverviewWindow from './CustomerOverviewWindow';
import QuoteOptionViewer from './QuoteOptionViewer';
import html2pdfBundleRaw from 'html2pdf.js/dist/html2pdf.bundle.min.js?raw';

const HTML2PDF_BUNDLE_INLINE = String(html2pdfBundleRaw || '').replace(/<\/script/gi, '<\\/script');

const QUOTE_AUTOFIT_SCRIPT_INLINE = String(`
(function(){
  function hasClass(el, cls){
    try {
      if (!el) return false;
      if (el.classList) return el.classList.contains(cls);
      return (' ' + (el.className || '') + ' ').indexOf(' ' + cls + ' ') >= 0;
    } catch(e) { return false; }
  }
  function addClass(el, cls){
    try {
      if (!el) return;
      if (el.classList) { el.classList.add(cls); return; }
      if (!hasClass(el, cls)) el.className = ((el.className || '') + ' ' + cls).trim();
    } catch(e) {}
  }
  function removeClass(el, cls){
    try {
      if (!el) return;
      if (el.classList) { el.classList.remove(cls); return; }
      el.className = (' ' + (el.className || '') + ' ').replace(' ' + cls + ' ', ' ').trim();
    } catch(e) {}
  }
  function num(v){
    var x = parseFloat(v || '0');
    return isFinite(x) ? x : 0;
  }
  function getPadding(el){
    try {
      var cs = (window.getComputedStyle ? getComputedStyle(el) : null);
      return cs ? { l:num(cs.paddingLeft), r:num(cs.paddingRight), t:num(cs.paddingTop), b:num(cs.paddingBottom) } : { l:0, r:0, t:0, b:0 };
    } catch(e) { return { l:0, r:0, t:0, b:0 }; }
  }
  function resetScale(inner){
    try {
      inner.style.transform = '';
      inner.style.transformOrigin = '';
    } catch(e) {}
  }
  function fitOne(page){
    try {
      if (!page) return;
      var inner = page.querySelector ? (page.querySelector('.page-inner') || page) : page;
      if (!inner) return;
      resetScale(inner);

      var pad = getPadding(page);
      var availW = (page.clientWidth || 0) - pad.l - pad.r;
      var availH = (page.clientHeight || 0) - pad.t - pad.b;
      if (!(availW > 0 && availH > 0)) return;

      var rect = inner.getBoundingClientRect ? inner.getBoundingClientRect() : { width:0, height:0 };
      var needW = Math.max(inner.scrollWidth || 0, rect.width || 0);
      var needH = Math.max(inner.scrollHeight || 0, rect.height || 0);
      if (!(needW > 0 && needH > 0)) return;

      var scaleW = availW / needW;
      var scaleH = availH / needH;
      var scale = Math.min(scaleW, scaleH, 1);

      if (scale < 1) {
        inner.style.transformOrigin = 'top left';
        inner.style.transform = 'scale(' + scale + ')';
      }
    } catch(e) {}
  }
  function fitAll(){
    try {
      var pages = document.querySelectorAll ? document.querySelectorAll('.print-page') : [];
      for (var i = 0; i < pages.length; i++) fitOne(pages[i]);
    } catch(e) {}
  }
  function fitWithMode(){
    try { addClass(document.documentElement, 'gb-fit-pages'); } catch(e) {}
    try { fitAll(); } catch(e) {}
    try { setTimeout(fitAll, 60); } catch(e) {}
    try { setTimeout(fitAll, 250); } catch(e) {}
  }
  function clearMode(){
    try { removeClass(document.documentElement, 'gb-fit-pages'); } catch(e) {}
    try { fitAll(); } catch(e) {}
  }

  try { window.__gbFitQuotePages = fitWithMode; } catch(e) {}
  try { window.__gbClearQuotePageFit = clearMode; } catch(e) {}

  try {
    window.addEventListener('beforeprint', function(){ try { fitWithMode(); } catch(e) {} });
    window.addEventListener('afterprint', function(){ try { clearMode(); } catch(e) {} });
  } catch(e) {}
})();
`).replace(/<\/script/gi, '<\\/script');

const QUOTE_AUTOFIT_CSS = String(`
  html.gb-fit-pages, html.gb-fit-pages body { background: #ffffff !important; color: #000000 !important; }
  html.gb-fit-pages .print-page { width: 210mm !important; height: 297mm !important; min-height: 297mm !important; overflow: hidden !important; box-sizing: border-box !important; }
  html.gb-fit-pages .page-inner { transform-origin: top left !important; }
`).trim();

// Minimal types to satisfy this component
type SaleItem = {
  expanded?: boolean;
  images?: string[];
  dynamic?: Record<string, any>;
  deviceType?: string;
  brand?: string;
  model?: string;
  description?: string;
  condition?: string;
  accessories?: string;
  url?: string; // new: source or ordering URL
  prompt?: string;
  price?: string | number;
  internalCost?: string | number;
  markupPct?: string;
  inStock?: boolean; // new: track whether this item is in stock
};

type SalesState = {
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  notes?: string;
  items: SaleItem[];
};

type RepairLine = { description: string; partPrice?: string | number; laborPrice?: string | number; lineCost?: string; lineMarkupPct?: string };
type RepairsState = {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  notes?: string;
  lines: RepairLine[];
  selectedCategoryId?: string;
  selectedRepairId?: string;
  customerId?: number;
};

const PERIPHERAL_TYPE_OPTIONS: string[] = [
  'Monitor',
  'Keyboard',
  'Mouse',
  'Keyboard/Mouse Combo',
  'Headset',
  'Speakers',
  'External Storage Device',
  'Controller',
  'Webcam',
  'Microphone',
  'USB Hub/Dock',
  'Other',
];

// Lightweight Field and ComboInput used in this window
const Field: React.FC<{ label: string; value: any; onChange: (v: string) => void; type?: string; placeholder?: string }> = ({ label, value, onChange, type, placeholder }) => (
  <div>
    <label className="block text-xs text-zinc-400 mb-1">{label}</label>
    <input
      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      type={type}
      placeholder={placeholder}
    />
  </div>
);

const ComboInput: React.FC<{ value: string; onChange: (v: string) => void; options: string[]; placeholder?: string }> = ({ value, onChange, options, placeholder }) => {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  const [highlight, setHighlight] = React.useState<number>(-1);

  const filtered = (options || []).filter((o) => String(o || '').toLowerCase().includes(String(filter || value || '').toLowerCase()));

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && ['ArrowDown','ArrowUp'].includes(e.key)) setOpen(true);
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min((filtered.length - 1), Math.max(0, h + 1))); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
    if (e.key === 'Enter') {
      if (open && highlight >= 0 && highlight < filtered.length) { onChange(filtered[highlight]); setOpen(false); setHighlight(-1); }
    }

    
    if (e.key === 'Escape') { setOpen(false); setHighlight(-1); }
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
        value={filter.length > 0 ? filter : (value || '')}
        onChange={(e) => { setFilter(e.target.value); onChange(e.target.value); setOpen(true); setHighlight(-1); }}
        placeholder={placeholder || 'Type or select...'}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 right-0 mt-1 bg-zinc-800 border border-zinc-700 rounded max-h-48 overflow-auto z-50">
          {filtered.map((opt, i) => (
            <div
              key={opt + i}
              className={`px-2 py-1 text-sm cursor-pointer ${i === highlight ? 'bg-zinc-700' : 'hover:bg-zinc-700'}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); onChange(opt); setFilter(''); setOpen(false); setHighlight(-1); }}
            >{opt}</div>
          ))}
        </div>
      )}
    </div>
  );
};

// Client search bar — lets the user pick an existing customer to pre-fill quote fields
type ClientSearchBarProps = {
  onSelect: (c: { id?: number; firstName?: string; lastName?: string; phone?: string; email?: string }) => void;
  onClear?: () => void;
};
const ClientSearchBar: React.FC<ClientSearchBarProps> = ({ onSelect, onClear }) => {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<any[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<any | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const customersIndexRef = React.useRef<Array<{ c: any; fullLower: string; phoneDigits: string }>>([]);

  const loadCustomers = React.useCallback(async () => {
    try {
      const api: any = (window as any).api;
      const list = await (api?.getCustomers ? api.getCustomers() : api?.dbGet ? api.dbGet('customers') : Promise.resolve([])).catch(() => []);
      const safe = Array.isArray(list) ? list : [];
      customersIndexRef.current = safe.map((c: any) => ({
        c,
        fullLower: `${c.firstName || ''} ${c.lastName || ''}`.trim().toLowerCase(),
        phoneDigits: String(c.phone || '').replace(/\D/g, ''),
      }));
    } catch {
      customersIndexRef.current = [];
    }
  }, []);

  React.useEffect(() => {
    loadCustomers();
    const off = (window as any).api?.onCustomersChanged?.(() => loadCustomers());
    return () => { try { off && off(); } catch {} };
  }, [loadCustomers]);

  React.useEffect(() => () => {
    if (timerRef.current) {
      try { clearTimeout(timerRef.current); } catch {}
      timerRef.current = null;
    }
  }, []);

  const search = React.useCallback((q: string) => {
    const v = q.trim();
    if (!v) { setResults([]); return; }
    setBusy(true);
    try {
      const digits = v.replace(/\D/g, '');
      const vl = v.toLowerCase();
      const idx = customersIndexRef.current || [];
      const out: any[] = [];
      for (const it of idx) {
        if (it.fullLower.includes(vl)) {
          out.push(it.c);
        } else if (digits && it.phoneDigits.includes(digits)) {
          out.push(it.c);
        }
        if (out.length >= 8) break;
      }
      setResults(out);
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleChange = (v: string) => {
    setQuery(v);
    setSelected(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(v), 200);
  };

  const pick = (c: any) => {
    setSelected(c);
    setQuery('');
    setResults([]);
    const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
    onSelect({ id: c?.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone || '', email: c.email || '' });
    // Update query display to selected name
    setQuery(name);
  };

  const clear = () => { setSelected(null); setQuery(''); setResults([]); try { onClear && onClear(); } catch {} };

  return (
    <div className="relative mb-1">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm pr-6 focus:border-blue-400 focus:outline-none placeholder-zinc-500"
            placeholder="Look up existing client by name or phone…"
            value={query}
            onChange={e => handleChange(e.target.value)}
          />
          {busy && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500">…</span>}
        </div>
        {selected && (
          <button
            className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded hover:bg-zinc-600 whitespace-nowrap"
            onClick={clear}
            title="Clear selection"
          >Clear</button>
        )}
      </div>
      {results.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 bg-zinc-800 border border-zinc-600 rounded shadow-xl max-h-40 overflow-auto">
          {results.map((c: any) => (
            <button
              key={c.id}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-700 flex items-center justify-between"
              onMouseDown={e => { e.preventDefault(); pick(c); }}
            >
              <span>{`${c.firstName || ''} ${c.lastName || ''}`.trim()}</span>
              {c.phone && <span className="text-xs text-zinc-400 ml-2">{formatPhone(c.phone) || c.phone}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

type QuoteClientPanelProps = {
  client: {
    customerId?: number;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
  };
  searchOpen: boolean;
  onToggleSearch: () => void;
  onAddClient: () => void;
  onSelect: (c: { id?: number; firstName?: string; lastName?: string; phone?: string; email?: string }) => void;
  onClear: () => void;
  clientCreator?: React.ReactNode;
};

const QuoteClientPanel: React.FC<QuoteClientPanelProps> = ({ client, searchOpen, onToggleSearch, onAddClient, onSelect, onClear, clientCreator }) => {
  const hasClient = !!(client.customerId || client.customerName || client.customerPhone || client.customerEmail);
  const phone = formatPhone(client.customerPhone || '') || client.customerPhone || '';

  return (
    <section className="gb-quote-client-panel">
      <div className="gb-quote-client-actions">
        <button type="button" className={searchOpen ? 'active' : ''} onClick={onToggleSearch}>
          Search Client
        </button>
        <button type="button" onClick={onAddClient}>
          Add Client
        </button>
      </div>
      {clientCreator ? <div className="gb-quote-client-create">{clientCreator}</div> : null}
      <div className="gb-quote-client-summary">
        {hasClient ? (
          <>
            <strong>{client.customerName || 'Selected client'}</strong>
            <span>{[phone, client.customerEmail].filter(Boolean).join(' | ') || 'No contact info saved'}</span>
            <button type="button" onClick={onClear}>Clear</button>
          </>
        ) : (
          <>
            <strong>No client selected</strong>
            <span>Search existing clients or add a new client before sending the quote.</span>
          </>
        )}
      </div>
      {searchOpen ? (
        <div className="gb-quote-client-search">
          <ClientSearchBar onSelect={onSelect} onClear={onClear} />
        </div>
      ) : null}
    </section>
  );
};

function sanitizeForSnapshot(value: any, keyHint?: string): any {
  try {
    if (value == null) return value;

    const key = String(keyHint || '');
    const isImageKey = /(^|\b)(image|images|img|photo|photos|signature|dataurl|dataUrl)(\b|$)/i.test(key);

    if (typeof value === 'string') {
      const s = value;
      const lower = s.slice(0, 32).toLowerCase();
      const looksLikeDataUri = lower.startsWith('data:') || lower.startsWith('blob:') || s.includes('base64,');
      if ((isImageKey || looksLikeDataUri) && s.length > 400) return { __omitted: true, len: s.length };
      return s;
    }

    if (typeof value === 'number' || typeof value === 'boolean') return value;

    if (Array.isArray(value)) {
      if (isImageKey) {
        const lens = value
          .map((v) => (typeof v === 'string' ? v.length : 0))
          .slice(0, 10);
        const totalLen = value.reduce((acc, v) => acc + (typeof v === 'string' ? v.length : 0), 0);
        return { __images: true, count: value.length, lens, totalLen };
      }
      // cap recursion work for very large arrays
      const capped = value.length > 80 ? value.slice(0, 80) : value;
      const mapped = capped.map((v) => sanitizeForSnapshot(v));
      return value.length > 80 ? { __array: true, len: value.length, head: mapped } : mapped;
    }

    if (typeof value === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = sanitizeForSnapshot(v, k);
      }
      return out;
    }

    return String(value);
  } catch {
    return '';
  }
}

function normalizeQuoteSnapshot(record: any) {
  if (!record) return '';
  if ((record.type ?? 'sales') === 'sales') {
    return JSON.stringify(sanitizeForSnapshot({
      type: 'sales',
      customerName: record.customerName || '',
      customerPhone: record.customerPhone || '',
      customerEmail: record.customerEmail || '',
      notes: record.notes || '',
      items: Array.isArray(record.items) ? record.items : [],
      totals: record.totals || { subtotal: 0, total: 0 },
    }));
  }
  return JSON.stringify(sanitizeForSnapshot({
    type: 'repairs',
    customerName: record.customerName || '',
    customerPhone: record.customerPhone || '',
    customerEmail: record.customerEmail || '',
    notes: record.notes || '',
    lines: Array.isArray(record.lines) ? record.lines : [],
    totals: record.totals || { parts: 0, labor: 0, total: 0 },
  }));
}

function getQuoteActivityIso(record: any) {
  return String(record?.contentUpdatedAt || record?.updatedAt || record?.createdAt || '');
}

function getQuoteMonthKey(record: any) {
  const raw = getQuoteActivityIso(record);
  const date = raw ? new Date(raw) : new Date(0);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function formatQuoteMonthLabel(key: string) {
  const [yearRaw, monthRaw] = String(key || '').split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return 'Older';
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function QuoteGeneratorWindow(): JSX.Element {
  // Mode: sales or repairs quote workflow
  const [mode, setMode] = useState<'sales' | 'repairs'>('sales');
  const [sales, setSales] = useState<SalesState>({ items: [] });
  const [repairs, setRepairs] = useState<RepairsState>({ lines: [] });
  const [quotes, setQuotes] = useState<any[]>([]);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showOptionViewer, setShowOptionViewer] = useState(false);
  const [showHtmlPreview, setShowHtmlPreview] = useState(false);
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showEmailSettings, setShowEmailSettings] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailFromName, setEmailFromName] = useState('GadgetBoy Repair & Retail');
  const [emailBodyTemplate, setEmailBodyTemplate] = useState('');
  const [emailBodyDraft, setEmailBodyDraft] = useState('');
  const [emailBodySavingDefault, setEmailBodySavingDefault] = useState(false);
  const [emailAppPassword, setEmailAppPassword] = useState('');
  const [emailHasPassword, setEmailHasPassword] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [emailSettingsSaving, setEmailSettingsSaving] = useState(false);
  const [emailSettingsErr, setEmailSettingsErr] = useState<string | null>(null);
  const [quoteEmailAttachmentMode, setQuoteEmailAttachmentMode] = useState<'html' | 'pdf'>('pdf');
  const [printPreviewUrl, setPrintPreviewUrl] = useState<string | null>(null);
  const [quoteId, setQuoteId] = useState<number | undefined>(undefined);
  const [expandedQuoteMonths, setExpandedQuoteMonths] = useState<Record<string, boolean>>({});
  const quoteMetaRef = useRef<{ createdAt?: string; contentUpdatedAt?: string }>({});
  const quoteSnapshotRef = useRef('');
  const quotePreviewRef = useRef<HTMLDivElement | null>(null);
  const [clientSearchOpen, setClientSearchOpen] = useState<Record<'sales' | 'repairs', boolean>>({ sales: false, repairs: false });
  const [addingClientFor, setAddingClientFor] = useState<'sales' | 'repairs' | null>(null);
  // Track expanded categories per item for Custom PC (keyed by item index string)
  const [openCats, setOpenCats] = useState<Record<string, Record<string, boolean>>>({});

  // Create Sales form workflow (Quote → Sale)
  const [createSaleSelecting, setCreateSaleSelecting] = useState(false);
  const [createSaleSelected, setCreateSaleSelected] = useState<Record<number, boolean>>({});
  const [createSaleBusy, setCreateSaleBusy] = useState(false);

  const isModalShell = useMemo(() => {
    try { return !!document.querySelector('[data-modal-shell="1"]'); } catch { return false; }
  }, []);
  const isMobileShell = useMemo(() => {
    try { return window.location.pathname.toLowerCase().endsWith('/mobile.html') || !!document.querySelector('.gbpos-mobile'); } catch { return false; }
  }, []);

  // Use the full device type catalog from lib so all dropdowns are available
  const deviceTypes = useMemo(() => DEVICE_TYPE_DEFS, []);
  // Options for the Device Type dropdown: remove 'Custom Build' and force 'Custom PC' to the end
  const deviceTypeOptions = useMemo(() => {
    try {
      const all = (deviceTypes || []).map((d: any) => d.type).filter(Boolean) as string[];
      const filtered = all.filter((t) => t !== 'Custom Build' && t !== 'Custom PC' && t !== 'Other');
      // Ensure Custom PC and Other are last (Other at the very bottom)
      return [...filtered, 'Custom PC', 'Other'];
    } catch { return (deviceTypes || []).map((d: any) => d.type).concat(['Custom PC','Other']); }
  }, [deviceTypes]);

  const salesTotals = useMemo(() => {
    try {
      const subtotal = (sales.items || []).reduce((acc, it) => acc + (Number(it.price) || 0), 0);
      return { subtotal, total: subtotal } as any;
    } catch { return { subtotal: 0, total: 0 } as any; }
  }, [sales]);

  const selectedSaleIndices = useMemo(() => {
    const max = (sales.items || []).length;
    const out: number[] = [];
    for (const [k, v] of Object.entries(createSaleSelected || {})) {
      if (!v) continue;
      const idx = Number(k);
      if (!Number.isFinite(idx)) continue;
      if (idx < 0 || idx >= max) continue;
      out.push(idx);
    }
    out.sort((a, b) => a - b);
    return out;
  }, [createSaleSelected, sales.items]);

  function quoteItemTitle(it: SaleItem, idx: number): string {
    const model = String((it.model ?? (it as any).dynamic?.model) || '').trim();
    const desc = String(it.description || '').trim();
    const base = model || desc || `Item ${idx + 1}`;
    const brand = String(it.brand || '').trim();
    if (!brand) return base;
    const lowerBase = base.toLowerCase();
    if (lowerBase.includes(brand.toLowerCase())) return base;
    return `${brand} ${base}`.trim();
  }

  function normalizeSaleCondition(cond?: string): SaleItemRow['condition'] {
    const v = String(cond || '').trim().toLowerCase();
    if (!v) return undefined;
    if (v.includes('new')) return 'New';
    if (v.includes('excellent')) return 'Excellent';
    if (v.includes('fair')) return 'Fair';
    if (v.includes('good')) return 'Good';
    // Like New / Poor / For Parts → closest supported values
    if (v.includes('like')) return 'Excellent';
    return 'Good';
  }

  function makeRowId(): string {
    try {
      const c: any = (globalThis as any).crypto;
      if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    } catch {}
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function round2(n: number): number {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  async function createSalesTicketFromSelection() {
    if (mode !== 'sales') return;
    const indices = selectedSaleIndices;
    if (!indices.length) {
      // Treat as a toggle-off when nothing is selected.
      setCreateSaleSelecting(false);
      setCreateSaleSelected({});
      return;
    }

    const customerName = String(sales.customerName || '').trim();
    const customerPhone = String(sales.customerPhone || '').trim();
    if (!sales.customerId && !customerName && !customerPhone) {
      setSaveMsg('Select a customer first');
      setTimeout(() => setSaveMsg(null), 2000);
      return;
    }

    const nowIso = new Date().toISOString();
    const rows: SaleItemRow[] = indices.map((idx) => {
      const it = sales.items[idx];
      const description = quoteItemTitle(it, idx);
      const price = Number(it.price || 0) || 0;
      const internalCost = Number(it.internalCost);
      return {
        id: makeRowId(),
        description,
        qty: 1,
        price,
        internalCost: Number.isFinite(internalCost) ? internalCost : undefined,
        condition: normalizeSaleCondition(it.condition),
        inStock: !!it.inStock,
        productUrl: String(it.url || '').trim(),
        category: 'Device',
      };
    });

    const taxRate = 8;
    const subTotal = round2(rows.reduce((sum, r) => sum + (Number(r.qty) || 0) * (Number(r.price) || 0), 0));
    const tax = round2(subTotal * taxRate / 100);
    const total = round2(subTotal + tax);
    const record: any = {
      customerId: sales.customerId || undefined,
      customerName,
      customerPhone,
      // Mirror customer email if present (safe even if not used by SaleWindow)
      customerEmail: String((sales as any).customerEmail || '').trim() || undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
      checkInAt: nowIso,
      status: 'open',
      assignedTo: null,
      items: rows,
      // legacy mirror
      itemDescription: rows[0]?.description || '',
      quantity: rows[0]?.qty || 1,
      price: rows[0]?.price || 0,
      amountPaid: 0,
      taxRate,
      discount: 0,
      totals: { subTotal, tax, total, remaining: total },
      total,
    };

    setCreateSaleBusy(true);
    try {
      const saved = await (window as any).api.dbAdd('sales', record);
      if (!saved?.id) throw new Error('Sale create failed');

      setSaveMsg(`Sales ticket created (GB${String(saved.id).padStart(7, '0')})`);
      setTimeout(() => setSaveMsg(null), 2500);
      setCreateSaleSelecting(false);
      setCreateSaleSelected({});

      try {
        await (window as any).api.openNewSale?.({
          id: saved.id,
          customerId: saved.customerId,
          customerName: saved.customerName,
          customerPhone: saved.customerPhone,
        });
      } catch {}
    } catch (e: any) {
      setSaveMsg(`Could not create sale: ${e?.message || e}`);
      setTimeout(() => setSaveMsg(null), 3000);
    } finally {
      setCreateSaleBusy(false);
    }
  }

  const repairTotals = useMemo(() => {
    try {
      const parts = (repairs.lines || []).reduce((acc, ln) => acc + (Number(ln.partPrice) || 0), 0);
      const labor = (repairs.lines || []).reduce((acc, ln) => acc + (Number(ln.laborPrice) || 0), 0);
      const total = parts + labor;
      return { parts, labor, total } as any;
    } catch { return { parts: 0, labor: 0, total: 0 } as any; }
  }, [repairs]);

  function applyQuoteClient(target: 'sales' | 'repairs', c: { id?: number; firstName?: string; lastName?: string; phone?: string; email?: string }) {
    const next = {
      customerId: c?.id ? Number(c.id) : undefined,
      customerName: `${c?.firstName || ''} ${c?.lastName || ''}`.trim(),
      customerPhone: c?.phone || '',
      customerEmail: c?.email || '',
    };
    if (target === 'sales') {
      setSales((s) => ({ ...s, ...next }));
    } else {
      setRepairs((s) => ({ ...s, ...next }));
    }
    setClientSearchOpen((current) => ({ ...current, [target]: false }));
  }

  function clearQuoteClient(target: 'sales' | 'repairs') {
    const next = { customerId: undefined, customerName: '', customerPhone: '', customerEmail: '' };
    if (target === 'sales') {
      setSales((s) => ({ ...s, ...next }));
    } else {
      setRepairs((s) => ({ ...s, ...next }));
    }
  }

  function renderQuoteClientPanel(target: 'sales' | 'repairs') {
    const source = target === 'sales' ? sales : repairs;
    return (
      <QuoteClientPanel
        client={{
          customerId: source.customerId,
          customerName: source.customerName,
          customerPhone: source.customerPhone,
          customerEmail: source.customerEmail,
        }}
        searchOpen={clientSearchOpen[target]}
        onToggleSearch={() => {
          setAddingClientFor(null);
          setClientSearchOpen((current) => ({ ...current, [target]: !current[target] }));
        }}
        onAddClient={() => {
          setClientSearchOpen((current) => ({ ...current, [target]: false }));
          setAddingClientFor((current) => current === target ? null : target);
        }}
        onSelect={(c) => applyQuoteClient(target, c)}
        onClear={() => clearQuoteClient(target)}
        clientCreator={isMobileShell && addingClientFor === target ? (
          <CustomerOverviewWindow
            customer={null}
            closeAfterSave
            childDialog
            compactCreate
            embeddedCreate
            onClose={() => setAddingClientFor(null)}
            onSaved={(c) => {
              applyQuoteClient(target, {
                id: c.id,
                firstName: c.firstName,
                lastName: c.lastName,
                phone: c.phone || '',
                email: c.email || '',
              });
              setAddingClientFor(null);
            }}
          />
          ) : null}
      />
    );
  }

  const currentQuoteRecord = useMemo(() => {
    if (mode === 'sales') {
      return {
        type: 'sales' as const,
        customerId: sales.customerId || undefined,
        customerName: sales.customerName || '',
        customerPhone: sales.customerPhone || '',
        customerEmail: sales.customerEmail || '',
        notes: sales.notes || '',
        items: sales.items || [],
        totals: { ...salesTotals },
      };
    }
    return {
      type: 'repairs' as const,
      customerId: repairs.customerId || undefined,
      customerName: repairs.customerName || '',
      customerPhone: repairs.customerPhone || '',
      customerEmail: repairs.customerEmail || '',
      notes: repairs.notes || '',
      lines: repairs.lines || [],
      totals: { ...repairTotals },
    };
  }, [mode, repairs, repairTotals, sales, salesTotals]);

  const currentQuoteSnapshot = useMemo(() => normalizeQuoteSnapshot(currentQuoteRecord), [currentQuoteRecord]);

  function getBuiltInQuoteEmailBody(): string {
    return (
      'Attached is the following quote for the product(s) you have requested. ' +
      'Feel free to email us back or call our shop if you want to finalize, ask questions, or have any concerns!\n\n' +
      'Mobile tip: If the signature box or PDF buttons don\'t work in your mail app preview, tap "Open in Browser" (Safari/Chrome). ' +
      'After signing, use "Share PDF" to email the signed PDF back to us.'
    );
  }

  function buildInteractiveSalesHtml(logoDataUrl?: string): string {
    const esc = (s: any) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
    const cust = `${sales.customerName || ''}`.trim();
    const phoneRaw = `${sales.customerPhone || ''}`.trim();
    const phone = (formatPhone(phoneRaw) || phoneRaw).trim();
    const email = `${sales.customerEmail || ''}`.trim();
    const custId = (() => {
      const v = Number((sales as any).customerId || 0);
      return v > 0 ? v : null;
    })();
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const mm = pad(ts.getMonth() + 1), dd = pad(ts.getDate()), yy = String(ts.getFullYear()).slice(-2);
  const h24 = ts.getHours(), h12 = h24 % 12 === 0 ? 12 : h24 % 12; const hh = pad(h12), mi = pad(ts.getMinutes()), ss = pad(ts.getSeconds());
  const nowDate = `${mm}/${dd}/${yy}`;
  const stampTitle = `${mm}${dd}${yy} ${hh}${mi}${ss}`; // full timestamp for document title
  const stampShort = `${mm}${dd}${yy} ${hh}${mi}`; // for filenames (no seconds)

    const logoBlock = (heightMm: number) => {
      // When this HTML is emailed/saved as a standalone attachment, relative public assets won't be present.
      // Prefer embedded data URLs; otherwise render a clean text fallback.
      if (logoDataUrl) return `<img src="${logoDataUrl}" alt="GadgetBoy" style="height:${heightMm}mm; width:auto" />`;
      return `<div style="height:${heightMm}mm; width:${heightMm}mm; display:flex; align-items:center; justify-content:center; border:2px solid #111; border-radius:10px; font-weight:800; font-size:12pt; letter-spacing:0.5px">GB</div>`;
    };

    // Final page for non-custom devices: Notes box + checklist + terms + signature/date (single page)
    const finalPageInteractive = () => {
      const labels = sales.items.map((it, i) => {
        const model = String(((it.model ?? (it as any).dynamic?.model) || '')).trim();
        return (model ? [it.brand, model].filter(Boolean).join(' ').trim() : '') || `Item ${i + 1}`;
      });
      const checklistHtml = labels
        .map((label, i) => {
          const safe = esc(label);
          return `<label style="display:flex; align-items:flex-start; gap:8px; margin:0 0 6px 0"><input type="checkbox" style="margin-top:2px"/> <span>${safe || `Item ${i + 1}`}</span></label>`;
        })
        .join('');

      return `
      <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:12mm">
        <div class="page-inner" style="display:flex; flex-direction:column; min-height:273mm; padding-top:8px">
          <div style="font-weight:800; margin-bottom:10px; font-size:14pt; text-align:center">Notes, Checklist, Terms</div>

          <div style="font-weight:700; margin-bottom:6px; font-size:12pt">Notes</div>
          <textarea id="clientNotes" placeholder="Notes, requested changes, questions, or preferences..." style="width:100%; height:52mm; border:2px solid #f00; border-radius:4px; padding:10px; font: 11pt system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; box-sizing:border-box; resize:vertical"></textarea>

          <div style="font-weight:700; margin-top:14px; margin-bottom:6px; font-size:12pt">Checklist</div>
          <div style="border:2px solid #f00; border-radius:4px; padding:10px; font-size:11pt; line-height:1.35">
            <div style="columns:2; column-gap:16px">${checklistHtml || '<div style="color:#666">No items listed.</div>'}</div>
          </div>
          <div style="margin-top:auto">
            <div style="font-weight:700; margin-top:14px; margin-bottom:6px; font-size:12pt">Terms and Conditions</div>
            <div style="border:2px solid #f00; border-radius:4px; padding:12px; font-size:11pt; line-height:1.45">
              <ul style="padding-left:1.1rem; margin:0">
                <li style="margin-bottom:6px"><b>Quote Validity, Price Changes & Availability:</b> Pricing is provided as of the date issued, is subject to parts availability and vendor/distributor price changes, and may change prior to purchase. Any substitutions must be approved by the client before purchase.</li>
                <li style="margin-bottom:6px"><b>Warranty, Exclusions & Client-Caused Damage:</b> 90-day limited hardware warranty for defects under normal use; exclusions include physical/impact damage, liquid exposure, misuse/accidents, unauthorized repairs/modifications, abuse/neglect, loss/theft, and third-party accessories. Damage occurring after delivery/pickup is the client’s responsibility and is not covered.</li>
                <li style="margin-bottom:6px"><b>Data & Software:</b> Client is responsible for backups and licensing. Service may require updates/reinstall/reset; we are not responsible for data loss.</li>
                <li style="margin-bottom:6px"><b>Deposits & Special Orders:</b> Deposits may be required to order parts/products. Special-order items may be non-returnable and subject to supplier restocking policies.</li>
                <li style="margin-bottom:6px"><b>Returns & Cancellations:</b> Returns/cancellations are subject to manufacturer/vendor policies and may incur restocking/processing fees. Labor and time spent is non-refundable.</li>
                <li style="margin-bottom:6px"><b>Taxes & Fees:</b> Sales tax and applicable fees may apply at checkout; printed totals may be shown before tax.</li>
                <li style="margin-bottom:0"><b>Limitation of Liability:</b> Liability is limited to amounts paid; incidental or consequential damages are excluded where permitted by law.</li>
              </ul>
            </div>

            <div style="margin-top:16px">
              <div class="no-print" style="margin:16px 0 0 0; border:2px solid #111; border-radius:12px; padding:12px; background:#ffffff; color:#000000">
                <div style="font-size:14pt; font-weight:900; margin-bottom:10px; text-align:center">Signature</div>
                <form id="gbSigForm" autocomplete="off" style="margin:0">
                  <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px">
                    <input id="gbSigName" name="gbSigName" type="text" placeholder="Type your full name to sign" style="flex:1; min-width:220px; padding:10px 12px; border:2px solid #000; border-radius:10px; font-size:12pt" />
                    <div style="display:flex; flex-direction:column; gap:6px">
                      <div style="font-weight:900; font-size:10pt; letter-spacing:0.4px">DATE</div>
                      <input id="gbSigDate" name="gbSigDate" type="date" style="padding:10px 12px; border:2px solid #000; border-radius:10px; font-size:12pt" />
                    </div>
                  </div>
                  <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; align-items:center">
                    <button id="gbSigClear" type="reset" style="padding:10px 14px; border-radius:10px; border:2px solid #000; background:#efefef; color:#000; font-weight:800; cursor:pointer">Clear</button>
                    <button id="signFinalize" type="button" onclick="try{ if(window.__gbInlineFinalize) return window.__gbInlineFinalize(); try{ alert('Finalize is not ready in this viewer. If you opened this from an email preview, use Open in Browser.\n\nFallback: use Print to Save as PDF.'); }catch(_){} try{ window.print(); }catch(_){} return false; }catch(e){ try{ console.error(e); }catch(_){} try{ alert('Finalize failed. Please try again, or use Print to Save as PDF.'); }catch(_){} try{ window.print(); }catch(_){} return false; }" style="margin-left:auto; padding:10px 14px; border-radius:10px; border:2px solid #000; background:#39FF14; color:#000; font-weight:900; cursor:pointer">Finalize (Download PDF)</button>
                  </div>
                </form>
                <div style="color:#333; font-size:11.5pt; line-height:1.35; margin-top:10px">Type your full name to sign. Finalize downloads the signed PDF automatically.</div>
                <div id="gbJsWarn" style="margin-top:10px; padding:10px 12px; border:2px solid #f00; border-radius:10px; font-size:11.5pt; line-height:1.35; font-weight:800">
                  If Finalize does nothing, this viewer is blocking scripts.
                  <br/><br/>
                  <b>iPhone/iPad:</b> Opening the HTML inside the iOS Files preview will NOT run scripts. In Files, tap <b>Share</b> → <b>Open in Safari</b> (or “Open in Browser”), then try Finalize again.
                  <br/><br/>
                  <b>Gmail/Drive:</b> Attachment viewers often block scripts. Download the HTML first, then open it from Files/Downloads in a real browser.
                </div>
              </div>

              <!-- PDF-only signature area (hidden on screen; auto-filled during export) -->
              <div id="gbPdfSigWrap" style="display:none; margin-top:16px; break-inside:avoid; page-break-inside:avoid">
                <div style="font-weight:700; margin-bottom:6px; font-size:12pt">Signature</div>
                <div style="display:flex; gap:24px; align-items:flex-start">
                  <div style="flex:1">
                    <img id="gbPdfSigImg" alt="Signature" style="display:block; width:100%; height:96px; object-fit:contain; border:1px solid #000; border-radius:4px; background:#fff" />
                  </div>
                  <div style="width:220px">
                    <div style="font-weight:700; margin-bottom:6px; font-size:12pt">Date</div>
                    <div id="gbPdfDate" style="border:2px solid #f00; border-radius:4px; min-height:96px; padding:10px; box-sizing:border-box; display:flex; align-items:center; justify-content:center; text-align:center; font-weight:700"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    };

    // -------- Device pages (mirror print layout) --------
    const specRowsInteractive = (item: SaleItem) => {
      const rows: Array<[string, string]> = [];
      const titleCase = (s: string) => s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map((w) => {
          const up = w.toUpperCase();
          return (w.length <= 3 && w === up) ? up : (w.charAt(0).toUpperCase() + w.slice(1));
        })
        .join(' ');

      const asPrintableText = (x: any): string => {
        if (x == null) return '';
        if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return String(x);
        if (Array.isArray(x)) {
          const parts = x
            .map((y) => (typeof y === 'string' || typeof y === 'number' || typeof y === 'boolean') ? String(y) : '')
            .map((s) => s.trim())
            .filter(Boolean);
          return parts.join(', ');
        }
        if (typeof x === 'object') {
          const v = (x as any).value;
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
          const l = (x as any).label;
          if (typeof l === 'string' || typeof l === 'number' || typeof l === 'boolean') return String(l);
          const t = (x as any).text;
          if (typeof t === 'string' || typeof t === 'number' || typeof t === 'boolean') return String(t);
          return '';
        }
        return '';
      };

      if (item.deviceType) rows.push(['Device Type', item.deviceType]);
      const appleFamily = (item.dynamic || ({} as any)).device as string | undefined;
      if (appleFamily) rows.push(['Apple Family', appleFamily]);
      if (item.model) rows.push(['Model', item.model]);
      if (item.condition) rows.push(['Condition', item.condition]);
      if (item.accessories) rows.push(['Accessories', item.accessories]);
      try {
        Object.entries(item.dynamic || {}).forEach(([k, v]) => {
          if (k === 'device') return;

          if ((k === 'otherSpecs' || k === 'droneSpecs') && Array.isArray(v)) {
            (v as any[]).forEach((s: any, i: number) => {
              const rawDesc = s?.desc ?? s?.description ?? s?.name;
              const rawVal = s?.value ?? s?.val;
              const desc = asPrintableText(rawDesc == null ? '' : rawDesc).trim();
              const val = asPrintableText(rawVal == null ? '' : rawVal).trim();
              if (!desc && !val) return;
              rows.push([desc || `Spec ${i + 1}`, val]);
            });
            return;
          }

          if (Array.isArray(v)) {
            const list = (v as any[])
              .map((x) => asPrintableText(x))
              .map((s) => s.trim())
              .filter(Boolean);
            rows.push([titleCase(k), list.length ? list.join(', ') : `${v.length} item(s)`]);
            return;
          }

          if (v && typeof v === 'object') {
            const t = asPrintableText(v).trim();
            if (t) rows.push([titleCase(k), t]);
            return;
          }

          rows.push([titleCase(k), asPrintableText(v)]);
        });
      } catch {}
      return rows.map(([k, v]) => `<tr><td style="border:1px solid #f00; padding:6px 14px; font-weight:600; white-space:nowrap">${esc(k)}</td><td style="border:1px solid #f00; padding:6px 14px">${esc(v)}</td></tr>`).join('');
    };

    const devicePageInteractive = (item: SaleItem, title: string, standalone: boolean = true) => {
      const images = (item.images || []).slice(0, 3);
      const base = Number(item.price || 0);
      // Price is already the customer-facing total (before tax). Do not apply any additional multiplier here.
      const shown = Number.isFinite(base) && base > 0 ? base : null;
      const hasSpecs = !!(
        (item.dynamic && Object.keys(item.dynamic || {}).length > 0) ||
        item.deviceType || (item.dynamic && (item.dynamic as any).device) || item.model || item.condition || item.accessories
      );
      const inner = `
        <div class=\"text-base\" style=\"text-align:center; font-weight:600; margin-bottom:8px\">${esc(title)}</div>
        <div class=\"gb-spec-grid\" style=\"display:grid; grid-template-columns:${images.length ? '70mm 1fr' : '1fr'}; align-items:start; column-gap:12px; width:100%\">
          ${images.length ? `
            <div style=\"display:flex; flex-direction:column; gap:10px; align-items:center\">
              ${images.map((src) => `<img src=\"${src}\" data-gbzoom=\"1\" style=\"max-height:55mm; max-width:65mm; object-fit:contain; border:1px solid #e5e7eb; border-radius:4px; padding:2px; cursor:zoom-in\" />`).join('')}
            </div>
          ` : ''}
          <div style=\"min-width:0; display:flex; flex-direction:column; gap:12px\">
            ${hasSpecs ? `
              <div style=\"font-size:12pt; border:2px solid #f00; padding:12px 14px; border-radius:4px; width:100%; box-sizing:border-box\">
                <div style=\"font-weight:600; margin-bottom:6px; text-align:center\">Specifications</div>
                <table style=\"border-collapse:collapse; width:100%; table-layout:auto\"><tbody>
                  ${specRowsInteractive(item)}
                </tbody></table>
              </div>
            ` : ''}
            ${shown != null ? `
              <div class=\"gb-total\" style=\"text-align:right\">
                <div style=\"display:inline-block; border:2px solid #f00; padding:10px 14px; border-radius:6px; font-size:14pt; white-space:nowrap; font-weight:800\">Total (before tax): $${shown.toFixed(2)}</div>
              </div>
            ` : ''}
          </div>
        </div>
        ${item.prompt && String(item.prompt).trim().length > 0 ? `
          <div style=\"text-align:center; font-size:13pt; line-height:1.45; max-width:180mm; margin:18px auto 0 auto; border:2px solid #f00; border-radius:4px; padding:10px 12px\">${esc(item.prompt || '')}</div>
        ` : ''}`;
      return standalone
        ? `<div class=\"print-page\" style=\"width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:10mm\"><div class=\"page-inner\">${inner}</div></div>`
        : inner;
    };

    const pages: string[] = [];
    // Page 1 header + first device
    const first = sales.items[0];
    const firstTitleModel = first ? String(((first.model ?? (first as any).dynamic?.model) || '')).trim() : '';
    const firstTitle = firstTitleModel ? [first?.brand, firstTitleModel].filter(Boolean).join(' ').trim() : 'First Device';

    // -------------------------------------------------------------
    // Custom Build: entirely separate print pipeline
    // Trigger for any deviceType containing "custom" (e.g., "Custom Build", "Custom PC")
    // -------------------------------------------------------------
    if (first && /custom/i.test(String((first as any).deviceType || (first as any).deviceCategory || (first as any).category || ''))) {
      const TAX_RATE = 0.08; // configurable sales tax (8%)
      const dyn: any = first.dynamic || {};
      type Part = { label: string; key: string; desc: string; priceRaw: number; priceMarked: number; image?: string; image2?: string };
      const baseParts: Array<{ key: string; label: string }> = [
        { key: 'case', label: 'Case' },
        { key: 'motherboard', label: 'Motherboard' },
        { key: 'cpu', label: 'Processor' },
        { key: 'cooling', label: 'Cooling' },
        { key: 'ram', label: 'Memory' },
        { key: 'gpu', label: 'Graphics Card' },
        { key: 'storage', label: 'Primary Storage' },
        { key: 'psu', label: 'PSU' },
        { key: 'os', label: 'Operating System' },
      ];
      const parts: Part[] = [];
      const buildDesc = (key: string) => {
        const raw = String(dyn[key] || dyn[`${key}Info`] || '').trim();
        const combine = (parts: (string|undefined)[]) => parts.filter(Boolean).map(String).map(s=>s.trim()).filter(Boolean).join(' | ');
        switch (key) {
          case 'cpu':
            return combine([raw, dyn.cpuGen && `Gen ${dyn.cpuGen}`, dyn.cpuCores && `${dyn.cpuCores} cores`, dyn.cpuClock && `${dyn.cpuClock}`]) || raw;
          case 'ram':
            return combine([raw, dyn.ramSize && `${dyn.ramSize}`, dyn.ramSpeed && `${dyn.ramSpeed}`, dyn.ramType && `${dyn.ramType}`]) || raw;
          case 'gpu':
            return combine([raw, dyn.gpuModel || dyn.gpu, dyn.gpuVram && `${dyn.gpuVram}`]) || raw;
          case 'storage':
            return combine([raw, formatPrimaryStorageSummary(dyn)]) || raw;
          case 'motherboard':
            return combine([raw, dyn.moboChipset && `Chipset: ${dyn.moboChipset}`, dyn.formFactor && `${dyn.formFactor}`]) || raw;
          case 'psu':
            return combine([raw, dyn.psuWatt && `${dyn.psuWatt}W`]) || raw;
          case 'cooling':
            return combine([raw, dyn.coolingType]) || raw;
          case 'case':
            return combine([raw, dyn.caseFormFactor && `${dyn.caseFormFactor}`]) || raw;
          case 'os':
            return raw || dyn.os || '';
          default:
            return raw;
        }
      };
      baseParts.forEach(p => {
        const desc = buildDesc(p.key);
        const priceRaw = Number(dyn[`${p.key}Price`] || 0) || 0;
        const imagesArr = Array.isArray(dyn[`${p.key}Images`]) ? dyn[`${p.key}Images`] : [];
        let image: string | undefined = dyn[`${p.key}Image`] ? String(dyn[`${p.key}Image`]) : undefined;
        let image2: string | undefined = dyn[`${p.key}Image2`] ? String(dyn[`${p.key}Image2`]) : undefined;
        if (!image && imagesArr[0]) image = String(imagesArr[0]);
        if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
        if (!desc && !priceRaw && !image && !image2) return; // skip completely empty
        parts.push({ label: p.label, key: p.key, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
      });

      // Secondary + Additional Storage as separate priced parts
      const secList = Array.isArray(dyn.pcSecondaryStorage) ? dyn.pcSecondaryStorage : [];
      secList.forEach((d: any, i: number) => {
        const type = String(d?.type || '').trim();
        const size = String(d?.size || '').trim();
        const desc = [type, size].filter(Boolean).join(' ').trim();
        const priceRaw = Number(d?.price || 0) || 0;
        const image = d?.image ? String(d.image) : undefined;
        const image2 = d?.image2 ? String(d.image2) : undefined;
        if (!desc && !priceRaw && !image && !image2) return;
        const label = i === 0 ? 'Secondary Storage' : 'Additional Storage';
        parts.push({ label, key: `pc-storage-${i}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
      });

      // Peripherals (Custom PC) - render as line items directly under OS
      const pcExtras = Array.isArray(dyn.pcExtras) ? dyn.pcExtras : [];
      pcExtras.forEach((e: any, i: number) => {
        const label = String(e?.label || e?.type || e?.name || '').trim() || 'Peripheral';
        const desc = String(e?.desc || '').trim();
        const priceRaw = Number(e?.price || 0) || 0;
        const imagesArr = Array.isArray(e?.images) ? e.images : [];
        let image: string | undefined = e?.image ? String(e.image) : undefined;
        let image2: string | undefined = e?.image2 ? String(e.image2) : undefined;
        if (!image && imagesArr[0]) image = String(imagesArr[0]);
        if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
        if (!desc && !priceRaw && !image && !image2) return;
        parts.push({ label, key: `pc-extra-${i}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
      });
      // Extra parts (array)
      const extras = Array.isArray(dyn.extraParts) ? dyn.extraParts : [];
      extras.forEach((e: any) => {
        const label = String(e?.name || 'Extra');
        const desc = String(e?.desc || '').trim();
        const priceRaw = Number(e?.price || 0) || 0;
        const imagesArr = Array.isArray(e?.images) ? e.images : [];
        let image: string | undefined = e?.image ? String(e.image) : undefined;
        let image2: string | undefined = e?.image2 ? String(e.image2) : undefined;
        if (!image && imagesArr[0]) image = String(imagesArr[0]);
        if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
        if (!label && !desc && !priceRaw && !image && !image2) return;
        parts.push({ label, key: `extra-${label}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
      });
      const laborRaw = Number(dyn.buildLabor || 0) || 0; // no markup

      // Paginate parts with images first (show rows regardless of image; up to 4 per page)
      const chunk = <T,>(arr: T[], size: number) => {
        const out: T[][] = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out;
      };
      const partPages = chunk(parts, 6);

      const headerBlock = () => `
        <div style="display:flex; gap:12px; align-items:flex-start; margin-bottom:12px">
          ${logoBlock(30)}
          <div style="line-height:1.15; flex:1">
            <div style="font-size:18pt; font-weight:700; letter-spacing:0.3px">Custom PC Build Quote</div>
            <div style="font-size:12pt; font-weight:700">GADGETBOY Repair & Retail</div>
            <div style="font-size:11pt">2822 Devine Street, Columbia, SC 29205</div>
            <div style="font-size:11pt">(803) 708-0101 | gadgetboysc@gmail.com</div>
            <div style="margin-top:6px; font-size:11pt"><b>Customer:</b> ${esc(cust || '-')} | <b>Phone:</b> ${esc(phone)}${email ? ` | <b>Email:</b> ${esc(email)}` : ''}</div>
            <div style="font-size:11pt; color:#555">Generated: ${esc(nowDate)}</div>
          </div>
        </div>`;

      // Render a single part as a bordered box with two columns: images (up to 2) | description with price under
      const partBox = (p: Part) => {
        // OS: text-only box (no images, no price)
        if (String(p.key).toLowerCase() === 'os' || String(p.label).toLowerCase().includes('operating system')) {
          return `
        <div style=\"display:grid; grid-template-columns:42mm 1fr; column-gap:10px; align-items:stretch; margin-bottom:8px\">
          <div></div>
            <div style=\"border:2px solid #f00; border-radius:6px; padding:8px; min-height:22mm\">
            <div style=\"font-weight:700; margin-bottom:2px\">${esc(p.label)}</div>
            <div style=\"font-size:10.5pt; line-height:1.35\">${esc(p.desc || '-') }</div>
          </div>
        </div>`;
        }
        const imgs = [p.image, p.image2].filter(Boolean) as string[];
          const leftCol = imgs.length >= 2
          ? `
            <div style="width:44mm; height:34mm; display:flex; flex-direction:column; gap:4px; background:#fff; border:1px solid #e5e7eb; border-radius:4px; padding:4px; box-sizing:border-box">
              <div style="flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden"><img src="${imgs[0]}" style="max-width:100%; max-height:100%; object-fit:contain; display:block" /></div>
              <div style="flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden"><img src="${imgs[1]}" style="max-width:100%; max-height:100%; object-fit:contain; display:block" /></div>
            </div>`
          : (imgs.length === 1
            ? `<div style="width:44mm; height:34mm; display:flex; align-items:center; justify-content:center; background:#fff; border:1px solid #e5e7eb; border-radius:4px; overflow:hidden"><img src="${imgs[0]}" style="max-width:100%; max-height:100%; object-fit:contain; display:block" /></div>`
            : `<div style="width:44mm; height:34mm; display:flex; align-items:center; justify-content:center; background:#fff; border:1px solid #e5e7eb; border-radius:4px; overflow:hidden"><div style=\"font-size:9pt; color:#888\">No Image</div></div>`);

        return `
        <div style="display:grid; grid-template-columns:44mm 1fr; column-gap:8px; align-items:stretch; margin-bottom:6px">
          ${leftCol}
          <div style="border:2px solid #f00; border-radius:6px; padding:6px; min-height:14mm; display:flex; align-items:center; justify-content:center; text-align:center; flex-direction:column">
            <div style="font-weight:700; margin-bottom:4px">${esc(p.label)}</div>
            <div style="font-size:10.5pt; line-height:1.35; margin-bottom:4px">${esc(p.desc || '-') }</div>
            <div style="font-weight:700; font-size:11pt">$${(p.priceMarked || 0).toFixed(2)}</div>
          </div>
        </div>`;
      };

      // First page shows up to 6 boxes under the header; subsequent pages show up to 6 boxes per page
      const firstPageParts = parts.slice(0, 6);
      const remainingParts = parts.slice(6);
      const remainingChunks = chunk(remainingParts, 6);

      const firstPageHtml = `
        <div class=\"print-page\" style=\"width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm\">
          <div class=\"page-inner\">
            ${headerBlock()}
            ${firstPageParts.length ? firstPageParts.map(partBox).join('') : `<div style=\"border:1px dashed #f00; padding:10px; text-align:center; color:#666\">No parts listed.</div>`}
          </div>
        </div>`;

      const promptHtmlBlock = first && first.prompt && String(first.prompt).trim().length > 0
        ? `\n            <div style="text-align:center; font-size:12.5pt; line-height:1.45; max-width:180mm; margin:12px auto 0 auto; border:2px solid #f00; border-radius:4px; padding:10px 12px">${esc(first.prompt || '')}</div>`
        : '';

      let otherPagesHtml = '';
      if (remainingChunks.length > 0) {
        otherPagesHtml = remainingChunks.map((group, i) => `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm">
          <div class="page-inner">
            ${group.map(partBox).join('')}${i === 0 ? promptHtmlBlock : ''}
          </div>
        </div>`).join('');
      } else if (promptHtmlBlock) {
        // No remaining part pages - create a dedicated second page for the AI summary
        otherPagesHtml = `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm">
          <div class="page-inner">
            ${promptHtmlBlock}
          </div>
        </div>`;
      }

      let partPagesHtml = firstPageHtml + otherPagesHtml;

      // Summary page (labor + totals)
      const pricedParts = parts.filter(p => !(String(p.key).toLowerCase() === 'os' || String(p.label).toLowerCase().includes('operating system')));
      const partsSubtotal = pricedParts.reduce((acc, p) => acc + (p.priceMarked || 0), 0);
      const taxableParts = partsSubtotal; // Labor is NOT taxed
      const taxAmount = taxableParts * TAX_RATE;
      const subtotalBeforeTax = taxableParts; // clarify: before tax means parts only
      const totalAfterTax = taxableParts + taxAmount + laborRaw;
      const summaryPage = `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm">
          <div class="page-inner">
            <div style="font-weight:700; font-size:13pt; margin-bottom:6px; text-align:center">Itemized Summary</div>
            <table style="border-collapse:collapse; width:100%; font-size:10pt">
              <thead>
                <tr><th style="border:1px solid #f00; padding:6px; text-align:left">Component</th><th style="border:1px solid #f00; padding:6px; text-align:right">Price</th></tr>
              </thead>
              <tbody>
                ${pricedParts.map(p => `<tr><td style=\"border:1px solid #f00; padding:6px\"><b>${esc(p.label)}</b>${p.desc ? ` - ${esc(p.desc)}` : ''}</td><td style=\"border:1px solid #f00; padding:6px; text-align:right\">$${(p.priceMarked || 0).toFixed(2)}</td></tr>`).join('') || '<tr><td colspan=\"2\" style=\"border:1px solid #f00; padding:8px; text-align:center; color:#666\">No components listed.</td></tr>'}
              </tbody>
              <tfoot>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:600">Parts Subtotal</td><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:600">$${partsSubtotal.toFixed(2)}</td></tr>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right">Build Labor (not taxed)</td><td style="border:1px solid #f00; padding:6px; text-align:right">$${laborRaw.toFixed(2)}</td></tr>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:600">Subtotal (before tax)</td><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:600">$${subtotalBeforeTax.toFixed(2)}</td></tr>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right">Tax on Parts (${(TAX_RATE*100).toFixed(0)}%)</td><td style="border:1px solid #f00; padding:6px; text-align:right">$${taxAmount.toFixed(2)}</td></tr>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:700">Total (after tax)</td><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:700">$${totalAfterTax.toFixed(2)}</td></tr>
              </tfoot>
            </table>
          </div>
        </div>`;

      // Final page: Client notes + approval checklist + terms + optional signature/date + download button
      const checklistHtml = (parts || []).map((p, i) => {
        const line = `<b>${esc(p.label || '')}</b>${p.desc ? ` - ${esc(p.desc)}` : ''}`;
        return `
          <label style="display:block; break-inside:avoid; margin:0 0 6px 0; font-size:10.5pt; line-height:1.25">
            <input type="checkbox" class="approve-box" data-approve-index="${i}" style="width:14px; height:14px; vertical-align:middle; margin-right:8px" />
            <span style="vertical-align:middle">${line}</span>
          </label>`;
      }).join('');
      const approvalPage = `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm">
          <div class="page-inner">
            <div style="font-weight:700; font-size:13pt; margin-bottom:10px; text-align:center">Client Notes & Parts Approval</div>

            <div style="font-weight:700; margin-bottom:6px; font-size:12pt">Client Notes</div>
            <textarea id="clientNotes" placeholder="Notes, requested changes, questions, or preferences..." style="width:100%; min-height:60mm; border:2px solid #f00; border-radius:4px; padding:10px; font: 11pt system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; box-sizing:border-box; resize:vertical"></textarea>

            <div style="font-weight:700; margin-top:14px; margin-bottom:6px; font-size:12pt">Parts Approval Checklist</div>
            <div style="border:2px solid #f00; border-radius:4px; padding:10px">
              <div style="font-size:10.5pt; color:#444; margin-bottom:8px">Check the components you approve. Leave items unchecked if you do not approve them yet or require changes.</div>
              <div style="columns:2; column-gap:16px">${checklistHtml || '<div style="color:#666">No parts listed.</div>'}</div>
            </div>

            <div style="font-weight:700; margin-top:14px; margin-bottom:6px; font-size:12pt">Terms and Conditions</div>
            <div style="border:2px solid #f00; border-radius:4px; padding:12px; font-size:11pt; line-height:1.45">
              <ul style="padding-left:1.1rem; margin:0">
                <li style="margin-bottom:6px"><b>Quote Validity & Availability:</b> Quoted pricing is provided as of the date issued, is subject to parts availability, and is subject to change prior to purchase. Special-order items may require a deposit and may be non-returnable.</li>
                <li style="margin-bottom:6px"><b>Warranty, Exclusions & Client-Caused Damage:</b> We provide a 90-day limited warranty covering defects in parts and workmanship under normal use. At our discretion, warranty remedies may include repair, replacement with an equivalent part, or refund. This warranty does not cover physical/impact damage, liquid exposure, cosmetic wear, misuse/accidents, loss or theft, abuse or neglect, unauthorized repairs/modifications, or damage caused by third-party accessories. Damage occurring after delivery/pickup is the client’s responsibility and is not covered. Damage or conditions outside warranty may result in additional diagnostic and/or repair charges, subject to client approval. To the maximum extent permitted by law, our total liability is limited to the amount paid for the applicable device or service, and we are not liable for incidental, indirect, special, or consequential damages.</li>
                <li style="margin-bottom:0"><b>Data & Software:</b> The client is responsible for backing up all data prior to service. Service may require software updates, configuration changes, operating system reinstall, and/or factory reset, which may result in partial or total data loss. We do not guarantee data retention or recovery and are not responsible for data loss. The client is responsible for software licensing, activation, account credentials, and access to third-party services.</li>
              </ul>
            </div>

            <div class="no-print" style="margin-top:16px; border:2px solid #111; border-radius:12px; padding:12px; background:#ffffff; color:#000000">
              <div style="font-size:14pt; font-weight:900; margin-bottom:10px; text-align:center">Signature</div>
              <form id="gbSigForm" autocomplete="off" style="margin:0">
                <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px">
                  <input id="gbSigName" name="gbSigName" type="text" placeholder="Type your full name to sign" style="flex:1; min-width:220px; padding:10px 12px; border:2px solid #000; border-radius:10px; font-size:12pt" />
                    <div style="display:flex; flex-direction:column; gap:6px">
                      <div style="font-weight:900; font-size:10pt; letter-spacing:0.4px">DATE</div>
                      <input id="gbSigDate" name="gbSigDate" type="date" style="padding:10px 12px; border:2px solid #000; border-radius:10px; font-size:12pt" />
                    </div>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; align-items:center">
                  <button id="gbSigClear" type="reset" style="padding:10px 14px; border-radius:10px; border:2px solid #000; background:#efefef; color:#000; font-weight:800; cursor:pointer">Clear</button>
                  <button id="signFinalize" type="button" onclick="try{ if(window.__gbInlineFinalize) return window.__gbInlineFinalize(); try{ alert('Finalize is not ready in this viewer. If you opened this from an email preview, use Open in Browser.\n\nFallback: use Print to Save as PDF.'); }catch(_){} try{ window.print(); }catch(_){} return false; }catch(e){ try{ console.error(e); }catch(_){} try{ alert('Finalize failed. Please try again, or use Print to Save as PDF.'); }catch(_){} try{ window.print(); }catch(_){} return false; }" style="margin-left:auto; padding:10px 14px; border-radius:10px; border:2px solid #000; background:#39FF14; color:#000; font-weight:900; cursor:pointer">Finalize (Download PDF)</button>
                </div>
              </form>
              <div style="color:#333; font-size:11.5pt; line-height:1.35; margin-top:10px">Type your full name to sign. Finalize downloads the signed PDF automatically.</div>
              <div id="gbJsWarn" style="margin-top:10px; padding:10px 12px; border:2px solid #f00; border-radius:10px; font-size:11.5pt; line-height:1.35; font-weight:800">
                If Finalize does nothing, this viewer is blocking scripts.
                <br/><br/>
                <b>iPhone/iPad:</b> Opening the HTML inside the iOS Files preview will NOT run scripts. In Files, tap <b>Share</b> → <b>Open in Safari</b> (or “Open in Browser”), then try Finalize again.
                <br/><br/>
                <b>Gmail/Drive:</b> Attachment viewers often block scripts. Download the HTML first, then open it from Files/Downloads in a real browser.
              </div>
            </div>

            <!-- PDF-only signature area (hidden on screen; auto-filled during export) -->
            <div id="gbPdfSigWrap" style="display:none; margin-top:16px; break-inside:avoid; page-break-inside:avoid">
              <div style="font-weight:700; margin-bottom:6px; font-size:12pt">Signature</div>
              <div style="display:flex; gap:24px; align-items:flex-start">
                <div style="flex:1">
                  <img id="gbPdfSigImg" alt="Signature" style="display:block; width:100%; height:96px; object-fit:contain; border:1px solid #000; border-radius:4px; background:#fff" />
                </div>
                <div style="width:220px">
                  <div style="font-weight:700; margin-bottom:6px; font-size:12pt">Date</div>
                  <div id="gbPdfDate" style="border:2px solid #f00; border-radius:4px; min-height:96px; padding:10px; box-sizing:border-box; display:flex; align-items:center; justify-content:center; text-align:center; font-weight:700"></div>
                </div>
              </div>
            </div>
          </div>
        </div>`;

      const html = `<!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Custom Build Quote</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link href="https://fonts.googleapis.com/css2?family=Alex+Brush&display=swap" rel="stylesheet" />
        <script>${HTML2PDF_BUNDLE_INLINE}</script>
        <style>
          @media print {
            @page { size:A4; margin:0; }
            .print-page { page-break-after: always; page-break-inside: avoid; break-inside: avoid; }
            .print-page:last-of-type { page-break-after: auto; }
            .no-print { display:none !important; }
          }
          ${QUOTE_AUTOFIT_CSS}
          html,body { margin:0; padding:0; background:#fff; color:#000; font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; }
          /* Mobile drawing reliability */
          #sigPad { touch-action: none; -webkit-user-select: none; user-select: none; }

          /* Mobile layout: avoid zoomed-in A4 */
          @media screen and (max-width: 900px) {
            .print-page { width: calc(100vw - 16px) !important; min-height: auto !important; margin: 8px auto !important; padding: 14px !important; border-width: 2px !important; }
            #sigSection { flex-direction: column !important; gap: 12px !important; }
            #sigSection > div { width: 100% !important; }
            .sig-actions { flex-wrap: wrap !important; }
          }
        </style>
        <script>${QUOTE_AUTOFIT_SCRIPT_INLINE}</script>
        <script>
          try { window.__GB_CUSTOM_PRINT__ = true; console.log('[GB POS] Custom Build Print active'); } catch(e) {}
        </script>
        <script>
          (function(){
            function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
            ready(function(){
              // New signing flow: Sign & Finalize opens a dedicated signing window (draw or type),
              // then generates a PDF download and replaces this page with a thank-you/instructions screen.
              try {
                var SHOP_EMAIL = 'gadgetboysc@gmail.com';
                var CUSTOMER_NAME = ${JSON.stringify(cust)};
                var STAMP_SHORT = ${JSON.stringify(stampShort)};

                var gbSigDataUrl = '';
                var gbSigDateStr = '';

                function sanitize(s){
                  return String(s||'').toString().replace(/[^a-z0-9\-\_\+]+/gi,'-').replace(/-{2,}/g,'-').replace(/^-+|-+$/g,'');
                }
                function fmtDate(d){
                  try {
                    var pad=function(n){ return String(n).padStart(2,'0'); };
                    var mm=pad(d.getMonth()+1), dd=pad(d.getDate()), yy=String(d.getFullYear());
                    return mm + '/' + dd + '/' + yy;
                  } catch(_) { return ''; }
                }
                function applySignature(dataUrl, dateStr){
                  try {
                    gbSigDataUrl = String(dataUrl || '');
                    gbSigDateStr = String(dateStr || '');
                  } catch(_) {}
                }
                function showThankYou(filename){
                  try {
                    var safeFile = filename ? String(filename) : 'the PDF';
                    document.documentElement.style.background = '#ffffff';
                    document.body.style.background = '#ffffff';
                    document.body.style.color = '#000000';
                    document.body.innerHTML =
                      '<div style="max-width:720px; margin:20px auto; padding:18px; border:2px solid #111; border-radius:12px; background:#ffffff; color:#000; font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial">' +
                        '<div style="font-size:20pt; font-weight:900; margin-bottom:10px">Thank you!</div>' +
                        '<div style="font-size:12.5pt; line-height:1.45">Your signed PDF should download as <b>' + safeFile + '</b>.</div>' +
                        '<div id="gbPdfActions" style="display:none; margin-top:12px; gap:8px; flex-wrap:wrap; align-items:center; justify-content:center"></div>' +
                        '<div style="font-size:12pt; line-height:1.45; margin-top:10px">Please email the signed PDF back to us at <a href="mailto:' + encodeURIComponent(SHOP_EMAIL) + '" style="font-weight:800; color:#000; text-decoration:underline">' + SHOP_EMAIL + '</a>.</div>' +
                        '<div style="font-size:11.5pt; color:#333; margin-top:10px">If you do not see a download, tap <b>Open PDF</b> then use your browser Share/Save options.</div>' +
                      '</div>';

                    try {
                      var pdfUrl = '';
                      try { pdfUrl = String((window).__gbLastPdfUrl || ''); } catch(_) { pdfUrl = ''; }
                      if (!pdfUrl) return;
                      var actions = document.getElementById('gbPdfActions');
                      if (!actions) return;
                      actions.style.display = 'flex';

                      function mkLink(text, href, isPrimary){
                        var a = document.createElement('a');
                        a.textContent = String(text || '');
                        a.href = String(href || '#');
                        a.target = '_blank';
                        a.rel = 'noopener noreferrer';
                        a.style.display = 'inline-flex';
                        a.style.alignItems = 'center';
                        a.style.justifyContent = 'center';
                        a.style.padding = '10px 14px';
                        a.style.borderRadius = '10px';
                        a.style.border = '2px solid #000';
                        a.style.fontWeight = '900';
                        a.style.textDecoration = 'none';
                        a.style.cursor = 'pointer';
                        a.style.background = isPrimary ? '#39FF14' : '#efefef';
                        a.style.color = '#000';
                        return a;
                      }

                      function mkBtn(text, isPrimary){
                        var b = document.createElement('button');
                        b.type = 'button';
                        b.textContent = String(text || '');
                        b.style.display = 'inline-flex';
                        b.style.alignItems = 'center';
                        b.style.justifyContent = 'center';
                        b.style.padding = '10px 14px';
                        b.style.borderRadius = '10px';
                        b.style.border = '2px solid #000';
                        b.style.fontWeight = '900';
                        b.style.cursor = 'pointer';
                        b.style.background = isPrimary ? '#39FF14' : '#efefef';
                        b.style.color = '#000';
                        return b;
                      }

                      var open = mkLink('Open PDF', pdfUrl, true);
                      actions.appendChild(open);

                      var dl = mkLink('Download PDF', pdfUrl, false);
                      try { dl.setAttribute('download', safeFile); } catch(_) {}
                      actions.appendChild(dl);

                      try {
                        if (navigator && navigator.share && typeof File === 'function') {
                          var shareBtn = mkBtn('Share PDF', false);
                          shareBtn.addEventListener('click', async function(){
                            try {
                              var blob = null;
                              try { blob = (window).__gbLastPdfBlob || null; } catch(_) { blob = null; }
                              if (!blob) { try { alert('Share is not available yet. Please use Open PDF.'); } catch(_) {} return; }
                              var name = safeFile;
                              try {
                                name = String(name || 'Signed-Quote.pdf');
                                if (!/\.pdf$/i.test(name)) name = name + '.pdf';
                              } catch(_) { name = 'Signed-Quote.pdf'; }
                              var f = null;
                              try { f = new File([blob], name, { type: 'application/pdf' }); } catch(_) { f = null; }
                              if (!f) { try { alert('Sharing is not supported in this browser.'); } catch(_) {} return; }
                              try {
                                if (navigator && navigator.canShare && !navigator.canShare({ files: [f] })) {
                                  try { alert('Sharing is not supported in this browser. Please use Download PDF.'); } catch(_) {}
                                  return;
                                }
                              } catch(_) {}
                              await navigator.share({ files: [f] });
                            } catch(_) { }
                          });
                          actions.appendChild(shareBtn);
                        }
                      } catch(_) {}
                    } catch(_) {}
                  } catch(_) {}
                }

                function bakeInputsForPdf(){
                  try {
                    // Notes: replace textarea with a static div so the PDF looks like the printout.
                    var ta = document.getElementById('clientNotes');
                    if (ta && ta.tagName === 'TEXTAREA') {
                      var div = document.createElement('div');
                      div.setAttribute('data-gb-baked', '1');
                      try { div.setAttribute('style', ta.getAttribute('style') || ''); } catch(_) {}
                      try {
                        div.style.whiteSpace = 'pre-wrap';
                        div.style.overflowWrap = 'break-word';
                        div.style.wordBreak = 'break-word';
                      } catch(_) {}
                      try { div.textContent = (ta).value ? String((ta).value) : ''; } catch(_) { div.textContent = ''; }
                      try { if (ta.parentNode) ta.parentNode.replaceChild(div, ta); } catch(_) {}
                    }

                    // Checklist: replace checkbox inputs with static checked/unchecked boxes.
                    var labels = document.querySelectorAll('label');
                    for (var i = 0; i < labels.length; i++) {
                      var lbl = labels[i];
                      if (!lbl) continue;
                      var cb = lbl.querySelector && lbl.querySelector('input[type="checkbox"]');
                      if (!cb) continue;
                      var span = lbl.querySelector && lbl.querySelector('span');
                      var txt = '';
                      try { txt = String(span ? span.textContent : lbl.textContent || '').trim(); } catch(_) { txt = ''; }

                      var row = document.createElement('div');
                      row.setAttribute('data-gb-baked', '1');
                      row.style.display = 'flex';
                      row.style.alignItems = 'flex-start';
                      row.style.gap = '8px';
                      row.style.margin = '0 0 6px 0';

                      var box = document.createElement('div');
                      try { box.textContent = (cb).checked ? '☑' : '☐'; } catch(_) { box.textContent = '☐'; }
                      box.style.fontWeight = '900';
                      box.style.width = '16px';
                      box.style.lineHeight = '1';

                      var text = document.createElement('div');
                      text.textContent = txt;

                      row.appendChild(box);
                      row.appendChild(text);
                      try { if (lbl.parentNode) lbl.parentNode.replaceChild(row, lbl); } catch(_) {}
                    }
                  } catch(_) {}
                }

                async function exportPdfAndThankYou(){
                  var base = 'Gadgetboy-Quote-' + sanitize(CUSTOMER_NAME || 'Customer');
                  var filename = base + '-' + (STAMP_SHORT || '') + '.pdf';

                  // Populate PDF-only signature/date slots
                  var pdfWrap = document.getElementById('gbPdfSigWrap');
                  var pdfImg = document.getElementById('gbPdfSigImg');
                  var pdfDate = document.getElementById('gbPdfDate');
                  try {
                    if (pdfImg && gbSigDataUrl) pdfImg.setAttribute('src', gbSigDataUrl);
                    if (pdfDate) pdfDate.textContent = gbSigDateStr || fmtDate(new Date());
                    if (pdfWrap && pdfWrap.style) pdfWrap.style.display = 'block';
                  } catch(_) {}

                  // Convert interactive inputs to static content before capturing the PDF.
                  try { bakeInputsForPdf(); } catch(_) {}

                  var style = document.createElement('style');
                  style.setAttribute('data-gb-hide','1');
                  style.textContent = '.no-print{display:none !important} html,body{background:#ffffff !important; color:#000000 !important} .print-page{background:#ffffff !important; color:#000000 !important; box-sizing:border-box !important; page-break-after:always !important; break-after:page !important;} .print-page:last-of-type{page-break-after:auto !important; break-after:auto !important;} .print-page *{box-sizing:border-box !important;} *{-webkit-print-color-adjust:exact; print-color-adjust:exact;}';
                  try { document.head.appendChild(style); } catch(_) {}
                  try {
                    if (typeof (window).html2pdf !== 'function') {
                      try { alert('PDF export is not available in this viewer. Use Print to Save as PDF.'); } catch(_) {}
                      try { window.print(); } catch(_) {}
                      return;
                    }
                    var opt = {
                      margin: 0,
                      filename: filename,
                      image: { type: 'jpeg', quality: 0.98 },
                      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
                      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                      pagebreak: { mode: ['css', 'legacy'] }
                    };
                    // Blob-first export (more reliable than triggering a download directly in many browsers/viewers)
                    var worker = (window).html2pdf().set(opt).from(document.body);
                    var blob = null;
                    try {
                      if (worker && typeof worker.outputPdf === 'function') {
                        blob = await worker.outputPdf('blob');
                      } else {
                        try { if (worker && typeof worker.toPdf === 'function') await worker.toPdf(); } catch(_) {}
                        var pdf = null;
                        try { if (worker && typeof worker.get === 'function') pdf = await worker.get('pdf'); } catch(_) { pdf = null; }
                        try { if (pdf && typeof pdf.output === 'function') blob = pdf.output('blob'); } catch(_) { blob = null; }
                      }
                    } catch(_) { blob = null; }

                    if (blob) {
                      try {
                        var file = null;
                        try { file = new File([blob], filename, { type: 'application/pdf' }); } catch(_) { file = null; }
                        if (navigator && navigator.share && file) {
                          try {
                            if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('cannot-share-files');
                          } catch(_) {}
                          try { await navigator.share({ files: [file] }); showThankYou(filename); return; } catch(_) {}
                        }
                      } catch(_) {}

                      try {
                        var url = URL.createObjectURL(blob);
                        try { (window).__gbLastPdfUrl = url; (window).__gbLastPdfBlob = blob; } catch(_) {}
                        // Try to download and also open in a new tab as a fallback.
                        try {
                          var a = document.createElement('a');
                          a.href = url;
                          a.download = filename;
                          a.target = '_blank';
                          document.body.appendChild(a);
                          a.click();
                          try { a.parentNode && a.parentNode.removeChild(a); } catch(_) {}
                        } catch(_) {}
                        try { window.open(url, '_blank'); } catch(_) {}
                        try { setTimeout(function(){ try{ URL.revokeObjectURL(url); } catch(_){} }, 600000); } catch(_) {}
                      } catch(_) {}

                      showThankYou(filename);
                      return;
                    }

                    // Last resort: library-managed download
                    try {
                      if (worker && typeof worker.save === 'function') {
                        await worker.save();
                      } else {
                        await (window).html2pdf().set(opt).from(document.body).save();
                      }
                      showThankYou(filename);
                      return;
                    } catch(_) {
                      throw new Error('Could not generate PDF');
                    }
                  } catch(e) {
                    try { console.error(e); } catch(_) {}
                    try { alert('Could not generate the PDF. Check Chrome Downloads / popups. Fallback: Print to Save as PDF.'); } catch(_) {}
                    try { window.print(); } catch(_) {}
                  } finally {
                    try { if (style && style.parentNode) style.parentNode.removeChild(style); } catch(_) {}
                    try { if (pdfWrap && pdfWrap.style) pdfWrap.style.display = 'none'; } catch(_) {}
                  }
                }

                (window).__gbApplySignature = applySignature;
                (window).__gbFinalizeFromPopup = exportPdfAndThankYou;

                function gbPad(n){ return String(n).padStart(2,'0'); }
                function gbTodayIso(){ try{ var d=new Date(); return String(d.getFullYear())+'-'+gbPad(d.getMonth()+1)+'-'+gbPad(d.getDate()); }catch(_){ return ''; } }
                function gbIsoToSlash(iso){
                  try {
                    var s=String(iso||'');
                    // This script is inside a TS template literal, so use double-backslashes
                    // to preserve the intended regex escapes in the exported HTML.
                    if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return '';
                    return s.slice(5,7) + '/' + s.slice(8,10) + '/' + s.slice(0,4);
                  } catch(_) { return ''; }
                }

                function setupInlineSigning(){
                  try { var warn = document.getElementById('gbJsWarn'); if (warn && warn.style) warn.style.display = 'none'; } catch(_) {}
                  var nameInput = document.getElementById('gbSigName');
                  var dateInput = document.getElementById('gbSigDate');
                  var clearBtn = document.getElementById('gbSigClear');
                  var finBtn = document.getElementById('signFinalize');
                  var finText = '';
                  try { finText = finBtn && finBtn.textContent ? String(finBtn.textContent) : ''; } catch(_) { finText = ''; }

                  function setBusy(isBusy){
                    try {
                      if (!finBtn) return;
                      finBtn.disabled = !!isBusy;
                      finBtn.style.opacity = isBusy ? '0.75' : '1';
                      finBtn.textContent = isBusy ? 'Generating PDF…' : (finText || 'Finalize (Download PDF)');
                    } catch(_) {}
                  }

                  // Best-effort: start loading the signature font early.
                  try { if (document.fonts && document.fonts.load) document.fonts.load('48px "Alex Brush"'); } catch(_) {}

                  function sigDataUrlFromName(name){
                    try {
                      var n = String(name || '').trim();
                      if (!n) return '';
                      var c = document.createElement('canvas');
                      c.width = 1200;
                      c.height = 300;
                      var t = c.getContext && c.getContext('2d');
                      if (!t) return '';
                      t.fillStyle = '#ffffff';
                      t.fillRect(0,0,c.width,c.height);
                      t.fillStyle = '#000000';
                      t.textAlign = 'center';
                      t.textBaseline = 'middle';

                      var maxW = c.width * 0.92;
                      var size = 140;
                      while (size > 64) {
                        t.font = String(size) + 'px "Alex Brush", "Segoe Script", "Brush Script MT", cursive';
                        try { if (t.measureText(n).width <= maxW) break; } catch(_) { break; }
                        size -= 6;
                      }
                      t.font = String(size) + 'px "Alex Brush", "Segoe Script", "Brush Script MT", cursive';
                      t.fillText(n, c.width/2, (c.height/2) + 8);
                      return c.toDataURL('image/png');
                    } catch(_) { return ''; }
                  }

                  function inlineFinalize(){
                    try {
                      setBusy(true);
                      var typed = (nameInput && nameInput.value) ? String(nameInput.value).trim() : '';
                      if (!typed) { try { alert('Please type your full name to sign.'); } catch(_) {} return false; }
                      var iso = '';
                      try { iso = (dateInput && dateInput.value) ? String(dateInput.value) : ''; } catch(_) { iso = ''; }
                      if (!iso) { try { alert('Please select a date.'); } catch(_) {} return false; }
                      var url = sigDataUrlFromName(typed);
                      if (!url) { try { alert('Could not render the signature. Please try again.'); } catch(_) {} return false; }
                      var ds = '';
                      try { ds = gbIsoToSlash(iso) || fmtDate(new Date()); } catch(_) { ds = fmtDate(new Date()); }
                      try { applySignature(url, ds); } catch(_) {}
                      try {
                        var p = exportPdfAndThankYou();
                        if (p && typeof p.then === 'function') {
                          p.then(function(){ try{ setBusy(false); } catch(_){} }).catch(function(e){ try{ setBusy(false); } catch(_){} try{ console.error(e); } catch(_){} try{ alert('PDF export failed. Please try again, and check Chrome Downloads / popup settings.'); } catch(_){} });
                        } else {
                          setBusy(false);
                        }
                      } catch(e) {
                        try { setBusy(false); } catch(_) {}
                        try { console.error(e); } catch(_) {}
                        try { alert('PDF export failed. Please try again.'); } catch(_) {}
                      }
                    } catch(e) {
                      try { setBusy(false); } catch(_) {}
                      try { console.error(e); } catch(_) {}
                      try { alert('Finalize failed. Please refresh and try again.'); } catch(_) {}
                    }
                    return false;
                  }

                  try { (window).__gbInlineFinalize = inlineFinalize; } catch(_) {}

                  try { if (dateInput && !dateInput.value) dateInput.value = gbTodayIso(); } catch(_) {}

                  try { if (clearBtn) clearBtn.addEventListener('click', function(e){ try{ e.preventDefault(); }catch(_){} try{ if(nameInput) nameInput.value=''; }catch(_){} try{ if(dateInput) dateInput.value=''; }catch(_){} }); } catch(_) {}
                  try { if (finBtn) finBtn.addEventListener('click', function(e){ try{ e.preventDefault(); }catch(_){} inlineFinalize(); }); } catch(_) {}
                }

                try { setupInlineSigning(); } catch(_) {}
                return;
              } catch(_) {}

              // Minimal signature pad (optional)
              var canvas = document.getElementById('sigPad');
              var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
              var typedBox = document.getElementById('typedSigBox');
              var sigToggle = document.getElementById('sigToggle');
              var sigInput = document.getElementById('sigName');
              var sigApply = document.getElementById('sigApply');
              var sigClear = document.getElementById('sigClear');
              var dateBox = document.getElementById('dateBox');
              var finalizeBtn = document.getElementById('finalize');
              var CUSTOMER_NAME = ${JSON.stringify(cust)};
              var STAMP_SHORT = ${JSON.stringify(stampShort)};
              var drawing=false, last=[0,0], dirty=false;
              var typeMode=false;

              function setMode(isType){
                typeMode = !!isType;
                try {
                  if (canvas && canvas.style) canvas.style.display = typeMode ? 'none' : 'block';
                  if (typedBox && typedBox.style) typedBox.style.display = typeMode ? 'flex' : 'none';
                  if (sigInput && sigInput.style) sigInput.style.display = typeMode ? 'block' : 'none';
                  if (sigToggle) sigToggle.textContent = typeMode ? 'Write Instead' : 'Type Instead';
                } catch(_) {}

                // If switching back to draw mode, the canvas may have been hidden
                // (0x0 rect) - re-measure after layout.
                if (!typeMode) {
                  try { setTimeout(resize, 0); } catch(_) {}
                }
              }

              function resize(){
                if(!canvas || !ctx) return;
                var r = canvas.getBoundingClientRect();
                var parentW = 0;
                try { parentW = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 0; } catch(_) { parentW = 0; }
                var dpr = (window.devicePixelRatio || 1);
                var cssW = r.width || parentW || 600;
                var cssH = r.height || 96;
                canvas.width = Math.max(1, Math.floor(cssW * dpr));
                canvas.height = Math.max(1, Math.floor(cssH * dpr));
                ctx.setTransform(1,0,0,1,0,0);
                ctx.scale(dpr, dpr);
                ctx.lineWidth = 2.5;
                ctx.lineCap = 'round';
                ctx.strokeStyle = '#000000';
              }
              function pos(e){ if(!canvas) return [0,0]; var r=canvas.getBoundingClientRect(); var pt=(e.touches? e.touches[0] : e); return [pt.clientX - r.left, pt.clientY - r.top]; }
              function start(e){ if(!ctx || typeMode) return; drawing=true; last=pos(e); try{ e.preventDefault(); }catch(_){} }
              function move(e){ if(!drawing || !ctx || typeMode) return; var p=pos(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last=p; dirty=true; try{ e.preventDefault(); }catch(_){} }
              function end(){ drawing=false; }
              function setDate(){
                if(!dateBox) return;
                var now=new Date();
                var pad=function(n){ return String(n).padStart(2,'0'); };
                var mm=pad(now.getMonth()+1), dd=pad(now.getDate()), yy=String(now.getFullYear());
                dateBox.textContent = mm + '/' + dd + '/' + yy;
              }
              function applyTypedSignature(name){
                if(!typedBox) return;
                typedBox.textContent = name;
                setDate();
              }

              if(canvas && ctx){
                window.addEventListener('resize', resize, { passive: true });
                resize();
                try { canvas.style.touchAction = 'none'; } catch(_){}
                canvas.addEventListener('pointerdown', function(e){ start(e); try{ if (typeof canvas.setPointerCapture==='function') canvas.setPointerCapture(e.pointerId); }catch(_){} }, { passive:false });
                canvas.addEventListener('pointermove', move, { passive:false });
                window.addEventListener('pointerup', function(){ end(); });
                window.addEventListener('pointercancel', function(){ end(); });

                // Fallbacks for environments where Pointer Events are flaky
                canvas.addEventListener('mousedown', function(e){ start(e); }, false);
                canvas.addEventListener('mousemove', function(e){ move(e); }, false);
                window.addEventListener('mouseup', function(){ end(); }, false);
                canvas.addEventListener('touchstart', function(e){ start(e); }, { passive:false });
                canvas.addEventListener('touchmove', function(e){ move(e); }, { passive:false });
                window.addEventListener('touchend', function(){ end(); }, false);
                window.addEventListener('touchcancel', function(){ end(); }, false);
                window.addEventListener('pointercancel', function(){ end(); }, false);
              }

              // Default to draw mode
              setMode(false);

              // Live preview typed signature into the signature box
              if (sigInput) sigInput.addEventListener('input', function(){
                try {
                  if (!typeMode) return;
                  var name = (sigInput && sigInput.value ? sigInput.value : '').trim();
                  if (typedBox) typedBox.textContent = name;
                } catch(_) {}
              });

              if(sigToggle) sigToggle.addEventListener('click', function(e){
                try{ e.preventDefault(); }catch(_){}
                setMode(!typeMode);
              });

              if(sigClear) sigClear.addEventListener('click', function(e){
                try{ e.preventDefault(); }catch(_){}
                try {
                  if (canvas && ctx) { ctx.clearRect(0,0,canvas.width,canvas.height); resize(); }
                } catch(_){}
                try { if (typedBox) typedBox.textContent = ''; } catch(_){}
                try { if (sigInput) sigInput.value = ''; } catch(_){}
                dirty=false;
                try { if(dateBox) dateBox.textContent=''; }catch(_){}
              });

              if(sigApply) sigApply.addEventListener('click', function(e){
                try{ e.preventDefault(); }catch(_){}
                // Apply works for both draw and type. Always sets date.
                if (typeMode) {
                  var name = (sigInput && sigInput.value ? sigInput.value : '').trim();
                  if(!name) return;
                  applyTypedSignature(name);
                } else {
                  // Draw mode: don't modify signature; simply lock in the date.
                  setDate();
                }
              });

              // Preview/Download PDF (no printer dialog). Signature is optional.
              if(finalizeBtn) finalizeBtn.addEventListener('click', function(){
                try {
                  // If user drew or typed but didn't hit Apply, set a date anyway.
                  if ((dirty || typeMode) && (!dateBox || !dateBox.textContent)) { try{ setDate(); }catch(_){} }
                } catch(_) {}

                var sanitize = function(s){ return String(s||'').toString().replace(/[^a-z0-9\-\_\+]+/gi,'-').replace(/-{2,}/g,'-').replace(/^-+|-+$/g,''); };
                var base = 'Gadgetboy-Quote-' + sanitize(CUSTOMER_NAME || 'Customer');
                var SHOP_EMAIL = 'gadgetboysc@gmail.com';

                var ensureLib = function(src){
                  return new Promise(function(resolve, reject){
                    try {
                      var s = document.createElement('script');
                      s.src = src;
                      s.onload = function(){ resolve(true); };
                      s.onerror = function(e){ reject(e); };
                      document.head.appendChild(s);
                    } catch (e) { reject(e); }
                  });
                };

                var ensureLibAny = async function(sources){
                  var lastErr = null;
                  for (var i = 0; i < sources.length; i++) {
                    try { await ensureLib(sources[i]); return true; } catch (e) { lastErr = e; }
                  }
                  throw lastErr || new Error('Failed to load scripts');
                };

                var ensurePdfLibs = async function(){
                  var needH2C = !(window).html2canvas;
                  var needJspdf = !((window).jspdf && (window).jspdf.jsPDF);
                  var tasks = [];
                  if (needH2C) tasks.push(ensureLibAny([
                    'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
                    'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
                    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
                  ]));
                  if (needJspdf) tasks.push(ensureLibAny([
                    'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
                    'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js',
                    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
                  ]));
                  if (tasks.length) await Promise.all(tasks);
                };

                var showPdfActions = function(blob, filename){
                  try {
                    var wrap = document.createElement('div');
                    wrap.className = 'no-print';
                    wrap.style.margin = '14px auto 18px auto';
                    wrap.style.maxWidth = '920px';
                    wrap.style.padding = '12px';
                    wrap.style.border = '1px solid #111827';
                    wrap.style.borderRadius = '12px';
                    wrap.style.background = '#ffffff';
                    wrap.style.color = '#000000';
                    wrap.style.textAlign = 'center';
                    wrap.innerHTML =
                      '<div style="font-weight:800; margin-bottom:6px">PDF Ready</div>' +
                      '<div style="font-size:11.5pt; margin-bottom:10px">Download the PDF, then email it back to <b>' + SHOP_EMAIL + '</b>.</div>';

                    var row = document.createElement('div');
                    row.style.display = 'flex';
                    row.style.gap = '8px';
                    row.style.justifyContent = 'center';
                    row.style.flexWrap = 'wrap';

                    var mkBtn = function(label){
                      var b = document.createElement('button');
                      b.type = 'button';
                      b.textContent = label;
                      b.style.padding = '10px 14px';
                      b.style.borderRadius = '10px';
                      b.style.border = '2px solid #000';
                      b.style.background = '#39FF14';
                      b.style.color = '#000';
                      b.style.fontWeight = '800';
                      b.style.cursor = 'pointer';
                      return b;
                    };

                    var downloadBtn = mkBtn('Download PDF');
                    downloadBtn.addEventListener('click', function(){
                      try {
                        var url = URL.createObjectURL(blob);
                        try { window.open(url, '_blank'); } catch (_) {}
                        var a = document.createElement('a');
                        a.href = url;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(function(){ try { URL.revokeObjectURL(url); } catch(_) {} }, 15000);
                      } catch(e) {}
                    });

                    var shareBtn = mkBtn('Share PDF');
                    shareBtn.addEventListener('click', async function(){
                      try {
                        var name = filename;
                        try { name = String(name || 'Signed-Quote.pdf'); if (!/\.pdf$/i.test(name)) name = name + '.pdf'; } catch(_) { name = 'Signed-Quote.pdf'; }
                        var f = new File([blob], name, { type: 'application/pdf' });
                        var canShare = !!(navigator && navigator.share && navigator.canShare && navigator.canShare({ files: [f] }));
                        if (!canShare) { alert('Sharing is not supported in this browser. Use Download PDF instead.'); return; }
                        await navigator.share({ files: [f] });
                      } catch(e) { try { alert('Could not open share sheet. Use Download PDF instead.'); } catch(_) {} }
                    });

                    var emailBtn = document.createElement('a');
                    emailBtn.textContent = 'Open Email (prefilled)';
                    emailBtn.href = 'mailto:' + encodeURIComponent(SHOP_EMAIL) +
                      '?subject=' + encodeURIComponent('Signed Gadgetboy Quote') +
                      '&body=' + encodeURIComponent('Hi Gadgetboy,\\n\\nI signed the quote. I am attaching the PDF from this page.\\n\\nThanks,\\n' + (CUSTOMER_NAME || ''));
                    emailBtn.style.display = 'inline-flex';
                    emailBtn.style.alignItems = 'center';
                    emailBtn.style.justifyContent = 'center';
                    emailBtn.style.padding = '10px 14px';
                    emailBtn.style.borderRadius = '10px';
                    emailBtn.style.border = '2px solid #000';
                    emailBtn.style.background = '#111827';
                    emailBtn.style.color = '#fff';
                    emailBtn.style.fontWeight = '800';
                    emailBtn.style.textDecoration = 'none';

                    row.appendChild(shareBtn);
                    row.appendChild(downloadBtn);
                    row.appendChild(emailBtn);
                    wrap.appendChild(row);

                    document.body.appendChild(wrap);
                  } catch(e) {}
                };

                var toPdf = async function(){
                  try {
                    try { if (window.__gbFitQuotePages) window.__gbFitQuotePages(); } catch(e) {}
                    await ensurePdfLibs();
                    var h2c = (window).html2canvas;
                    var jsPDF = (window).jspdf.jsPDF;

                    var style = document.createElement('style');
                    style.setAttribute('data-pdf-style','1');
                    style.textContent = 'html, body { background: #ffffff !important; color: #000000 !important; } ' +
                                      '.print-page { background: #ffffff !important; color: #000000 !important; } ' +
                                      '.page-inner { color: #000000 !important; } ' +
                                      '* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }';
                    document.head.appendChild(style);

                    var pageEls = Array.prototype.slice.call(document.querySelectorAll('.print-page'));
                    var a4 = { w: 210, h: 297 }; // mm
                    var pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

                    for (var i = 0; i < pageEls.length; i++) {
                      var el = pageEls[i];
                      var canvas2 = await h2c(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
                      var img = canvas2.toDataURL('image/jpeg', 0.95);
                      var pw = a4.w, ph = a4.h;
                      var ratio = canvas2.width / canvas2.height;
                      var w = pw, h = w / ratio;
                      if (h > ph) { h = ph; w = h * ratio; }
                      var x = (pw - w) / 2, y = (ph - h) / 2;
                      if (i > 0) pdf.addPage('a4', 'portrait');
                      pdf.addImage(img, 'JPEG', x, y, w, h);
                    }

                    var filename = base + '-' + STAMP_SHORT + '.pdf';
                    var blob = pdf.output('blob');

                    showPdfActions(blob, filename);

                    // Best-effort: trigger download immediately
                    try {
                      var url = URL.createObjectURL(blob);
                      try { window.open(url, '_blank'); } catch (_) {}
                      var a = document.createElement('a');
                      a.href = url;
                      a.download = filename;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      setTimeout(function(){ try { URL.revokeObjectURL(url); } catch(_) {} }, 15000);
                    } catch(e) {}

                    try { document.head.removeChild(style); } catch(_) {}
                    try { if (window.__gbClearQuotePageFit) window.__gbClearQuotePageFit(); } catch(e) {}
                  } catch (e) {
                    try {
                      var prev = document.querySelector('style[data-pdf-style="1"]');
                      if (prev && prev.parentElement) prev.parentElement.removeChild(prev);
                    } catch(_) {}
                    try { if (window.__gbClearQuotePageFit) window.__gbClearQuotePageFit(); } catch(e) {}
                    try { alert('Could not generate PDF automatically. Your browser will open the print dialog, choose "Save as PDF".'); } catch(_) {}
                    try { window.print(); } catch(_) {}
                  }
                };

                toPdf();
              });
            });
          })();
        </script>
      </head>
      <body>
        <noscript>
          <div style="max-width:920px; margin:12px auto; padding:12px; border-radius:12px; background:#111827; border:1px solid #374151; color:#e5e7eb; font-size:12pt; text-align:center">
            <div style="font-weight:900; margin-bottom:6px">This quote needs JavaScript</div>
            This file must be opened in a browser to sign and generate the PDF.
            <br/>
            <b>iPhone/iPad:</b> If it opened in the iOS Files preview, tap <b>Share</b> → <b>Open in Safari</b>.
          </div>
        </noscript>
        <div class="no-print" style="max-width:920px; margin:12px auto; padding:12px; border-radius:12px; background:#111827; border:1px solid #374151; color:#e5e7eb; font-size:11.5pt; line-height:1.4; text-align:center">
          <div style="font-weight:900; font-size:12.5pt; margin-bottom:6px; color:#ffffff">How to fill & finalize this quote</div>
          <div><b style="color:#ffffff">1)</b> Fill out the Notes + Checklist.</div>
          <div><b style="color:#ffffff">2)</b> Scroll to <b style="color:#ffffff">Signature</b> and type your name + select a date.</div>
          <div><b style="color:#ffffff">3)</b> Tap <b style="color:#ffffff">Finalize (Download PDF)</b>.</div>
          <div style="margin-top:8px; font-size:11pt; color:#d1d5db">
            <b style="color:#ffffff">iPhone/iPad:</b> If it opens in the Files preview, tap <b style="color:#ffffff">Share</b> → <b style="color:#ffffff">Open in Safari</b> (Files preview blocks scripts).
            <br/>
            <b style="color:#ffffff">Gmail/Drive:</b> Attachment previews can block scripts—use “Open in Browser” or download and open in Safari/Chrome.
          </div>
        </div>
        ${partPagesHtml}
        ${summaryPage}
        ${approvalPage}
      </body>
      </html>`;
      return html;
    }
    pages.push(`
      <div class=\"print-page\" style=\"width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:12mm\">
        <div class=\"page-inner\">
          <div style=\"display:flex; gap:12px; align-items:flex-start; margin-bottom:8px\">
            ${logoBlock(35)}
            <div style=\"line-height:1.2; flex:1\">
              <div style=\"font-size:20pt; font-weight:700; letter-spacing:0.2px\">Gadgetboy Quote</div>
              <div style=\"font-size:13pt; font-weight:700\">GADGETBOY Repair & Retail</div>
              <div style=\"font-size:12pt\">2822 Devine Street, Columbia, SC 29205</div>
              <div style=\"font-size:12pt\">(803) 708-0101 | gadgetboysc@gmail.com</div>
              <div style=\"margin-top:8px; font-size:12pt\"><b>Customer:</b> ${esc(cust || '-')} | <b>Phone:</b> ${esc(phone)}${email ? ` | <b>Email:</b> ${esc(email)}` : ''}</div>
              <div style=\"font-size:12pt; color:#666\">Generated: ${esc(nowDate)}</div>
            </div>
          </div>
          ${first ? devicePageInteractive(first, firstTitle, false) : ''}
        </div>
      </div>`);

    // Additional device pages
    sales.items.slice(1).forEach((item, idx) => {
      const model = String(((item.model ?? (item as any).dynamic?.model) || '')).trim();
      const title = model ? [item.brand, model].filter(Boolean).join(' ').trim() : `Device ${idx + 2}`;
      pages.push(devicePageInteractive(item, title, true));
    });

    // Append final page for all non-custom device quotes
    pages.push(finalPageInteractive());

    return `<!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>Quote - ${esc(cust || 'Customer')} - ${stampTitle}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
      <link href="https://fonts.googleapis.com/css2?family=Alex+Brush&display=swap" rel="stylesheet" />
      <script>${HTML2PDF_BUNDLE_INLINE}</script>
      <style>
        @media print {
          @page { size: A4; margin: 0; }
          .print-page { page-break-after: always; page-break-inside: avoid; break-inside: avoid; }
          .print-page:last-of-type { page-break-after: auto; }
          .no-print { display:none !important; }
          html, body { background: #ffffff !important; color: #000000 !important; }
        }
        ${QUOTE_AUTOFIT_CSS}
        html, body { margin: 0; padding: 0; background: #1f2937; color: #e5e7eb; font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; -webkit-text-size-adjust: 100%; }
        #mobileHelp { max-width: 920px; margin: 12px auto; padding: 12px; border-radius: 12px; background: #111827; border: 1px solid #374151; color: #e5e7eb; font-size: 11.5pt; line-height: 1.35; }
        #mobileHelp b { color: #ffffff; }
        /* Keep instructions visible on all screen sizes (HTML only; never prints because of .no-print) */
        /* Mobile drawing reliability */
        #sigPad { touch-action: none; -webkit-user-select: none; user-select: none; }

        /* Screen layout: make pages readable on phones */
        .print-page { background: #ffffff; color: #000000; }
        @media screen and (max-width: 900px) {
          html, body { background: #ffffff; color: #000000; }
          #mobileHelp { margin: 8px; border-radius: 10px; }
          .print-page { width: calc(100vw - 16px) !important; min-height: auto !important; margin: 8px auto !important; padding: 14px !important; border-width: 2px !important; border-radius: 12px !important; }
          .gb-spec-grid { display: block !important; }
          .gb-total { display: block !important; text-align: center !important; margin-top: 10px !important; }
          #sigSection { flex-direction: column !important; gap: 12px !important; }
          #sigSection > div { width: 100% !important; }
          .sig-actions { flex-wrap: wrap !important; }
          textarea#clientNotes { height: 35vh !important; }
        }

        /* Image zoom helper */
        img[data-gbzoom="1"] { -webkit-tap-highlight-color: transparent; }
      </style>
      <script>${QUOTE_AUTOFIT_SCRIPT_INLINE}</script>
    </head>
    <body>
      <noscript>
        <div style="max-width:920px; margin:12px auto; padding:12px; border-radius:10px; background:#111827; border:1px solid #374151; color:#e5e7eb; font-size:12pt">
          <div style="font-weight:900; margin-bottom:6px; text-align:center">This quote needs JavaScript</div>
          <div style="text-align:center">Open this file in a browser (Safari/Chrome) to sign and generate the PDF.</div>
        </div>
      </noscript>
      <div id="mobileHelp" class="no-print">
        <div style="text-align:center">
          <div style="font-weight:900; font-size:12.5pt; margin-bottom:6px">How to fill & finalize this quote</div>
          <div><b>1)</b> Fill out Notes + Checklist.</div>
          <div><b>2)</b> Scroll to <b>Signature</b> and type your name + select a date.</div>
          <div><b>3)</b> Tap <b>Finalize (Download PDF)</b>.</div>
          <div style="margin-top:8px; font-size:11pt; color:#d1d5db">
            <b>iPhone/iPad:</b> If it opens in the Files preview, tap <b>Share</b> → <b>Open in Safari</b>.
            <br/>
            <b>Gmail/Drive:</b> Attachment previews can block scripts—use “Open in Browser” or download and open in Safari/Chrome.
          </div>
        </div>
      </div>
      ${pages.join('\n')}
      <script>
      (function(){
        function gbReady(fn){ try { if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fn); else fn(); } catch(_) { try { fn(); } catch(__) {} } }
        function setupImageZoom(){
          try {
            var imgs = Array.prototype.slice.call(document.querySelectorAll('img[data-gbzoom="1"]'));
            if (!imgs || !imgs.length) return;

            var overlay = document.getElementById('gbImgZoomOverlay');
            if (!overlay) {
              overlay = document.createElement('div');
              overlay.id = 'gbImgZoomOverlay';
              overlay.className = 'no-print';
              overlay.style.position = 'fixed';
              overlay.style.left = '0';
              overlay.style.top = '0';
              overlay.style.right = '0';
              overlay.style.bottom = '0';
              overlay.style.zIndex = '9999';
              overlay.style.display = 'none';
              overlay.style.alignItems = 'center';
              overlay.style.justifyContent = 'center';
              overlay.style.background = 'rgba(0,0,0,0.75)';
              overlay.innerHTML =
                '<div id="gbImgZoomInner" style="position:relative; max-width:92vw; max-height:92vh">' +
                  '<button id="gbImgZoomClose" type="button" aria-label="Close" style="position:absolute; right:-10px; top:-10px; width:40px; height:40px; border-radius:999px; border:2px solid #000; background:#39FF14; color:#000; font-weight:900; cursor:pointer">×</button>' +
                  '<img id="gbImgZoomImg" alt="" style="display:block; max-width:92vw; max-height:92vh; object-fit:contain; background:#fff; border-radius:10px" />' +
                '</div>';
              document.body.appendChild(overlay);
            }

            var zoomImg = document.getElementById('gbImgZoomImg');
            var closeBtn = document.getElementById('gbImgZoomClose');
            var hide = function(){ try { overlay.style.display = 'none'; } catch(_) {} };
            if (closeBtn) closeBtn.addEventListener('click', function(e){ try { e.preventDefault(); e.stopPropagation(); } catch(_) {} hide(); });
            overlay.addEventListener('click', function(e){
              try {
                var inner = document.getElementById('gbImgZoomInner');
                if (inner && inner.contains && inner.contains(e.target)) return; // clicking the image/inner shouldn't close
              } catch(_) {}
              hide();
            });
            document.addEventListener('keydown', function(e){ try { if (e && e.key === 'Escape') hide(); } catch(_) {} });

            imgs.forEach(function(img){
              img.addEventListener('click', function(e){
                try { e.preventDefault(); } catch(_) {}
                try {
                  if (zoomImg) zoomImg.setAttribute('src', img.getAttribute('src') || '');
                  overlay.style.display = 'flex';
                } catch(_) {}
              }, false);
            });
          } catch(_) {}
        }

        setupImageZoom();

        // Signing flow: Sign & Finalize opens an in-page signing screen (signature + date),
        // then generates a PDF download with signature/date auto-applied (not shown on the main quote screen).
        try {
          var gbShopEmail = 'gadgetboysc@gmail.com';
          var gbCustomerName = ${JSON.stringify(cust)};
          var gbCustomerPhone = ${JSON.stringify(phone)};
          var gbCustomerId = ${JSON.stringify(custId)};
          var gbItemsCount = ${JSON.stringify((sales.items || []).length)};
          var gbStampShort = ${JSON.stringify(stampShort)};

          var gbSigDataUrl = '';
          var gbSigDateStr = '';

          function sanitize(s){
            return String(s||'').toString().replace(/[^a-z0-9\-\_\+]+/gi,'-').replace(/-{2,}/g,'-').replace(/^-+|-+$/g,'');
          }
          function fmtDate(d){
            try {
              var pad=function(n){ return String(n).padStart(2,'0'); };
              var mm=pad(d.getMonth()+1), dd=pad(d.getDate()), yy=String(d.getFullYear());
              return mm + '/' + dd + '/' + yy;
            } catch(_) { return ''; }
          }

          function applySignature(dataUrl, dateStr){
            try {
              gbSigDataUrl = String(dataUrl || '');
              gbSigDateStr = String(dateStr || '');
            } catch(_) {}
          }

          function showThankYou(filename){
            try {
              var safeFile = filename ? String(filename) : 'the PDF';
              document.documentElement.style.background = '#ffffff';
              document.body.style.background = '#ffffff';
              document.body.style.color = '#000000';
              document.body.innerHTML =
                '<div style="max-width:720px; margin:20px auto; padding:18px; border:2px solid #111; border-radius:12px; background:#ffffff; color:#000; font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial">' +
                  '<div style="font-size:20pt; font-weight:900; margin-bottom:10px">Thank you!</div>' +
                  '<div style="font-size:12.5pt; line-height:1.45">Your signed PDF should download as <b>' + safeFile + '</b>.</div>' +
                  '<div id="gbPdfActions" style="display:none; margin-top:12px; gap:8px; flex-wrap:wrap; align-items:center; justify-content:center"></div>' +
                  '<div style="font-size:12pt; line-height:1.45; margin-top:10px">Please email the signed PDF back to us at <a href="mailto:' + encodeURIComponent(gbShopEmail) + '" style="font-weight:800; color:#000; text-decoration:underline">' + gbShopEmail + '</a>.</div>' +
                  '<div style="font-size:11.5pt; color:#333; margin-top:10px">If you do not see a download, tap <b>Open PDF</b> then use your browser Share/Save options.</div>' +
                '</div>';

              try {
                var pdfUrl = '';
                try { pdfUrl = String((window).__gbLastPdfUrl || ''); } catch(_) { pdfUrl = ''; }
                if (!pdfUrl) return;
                var actions = document.getElementById('gbPdfActions');
                if (!actions) return;
                actions.style.display = 'flex';

                function mkLink(text, href, isPrimary){
                  var a = document.createElement('a');
                  a.textContent = String(text || '');
                  a.href = String(href || '#');
                  a.target = '_blank';
                  a.rel = 'noopener noreferrer';
                  a.style.display = 'inline-flex';
                  a.style.alignItems = 'center';
                  a.style.justifyContent = 'center';
                  a.style.padding = '10px 14px';
                  a.style.borderRadius = '10px';
                  a.style.border = '2px solid #000';
                  a.style.fontWeight = '900';
                  a.style.textDecoration = 'none';
                  a.style.cursor = 'pointer';
                  a.style.background = isPrimary ? '#39FF14' : '#efefef';
                  a.style.color = '#000';
                  return a;
                }

                function mkBtn(text, isPrimary){
                  var b = document.createElement('button');
                  b.type = 'button';
                  b.textContent = String(text || '');
                  b.style.display = 'inline-flex';
                  b.style.alignItems = 'center';
                  b.style.justifyContent = 'center';
                  b.style.padding = '10px 14px';
                  b.style.borderRadius = '10px';
                  b.style.border = '2px solid #000';
                  b.style.fontWeight = '900';
                  b.style.cursor = 'pointer';
                  b.style.background = isPrimary ? '#39FF14' : '#efefef';
                  b.style.color = '#000';
                  return b;
                }

                var open = mkLink('Open PDF', pdfUrl, true);
                actions.appendChild(open);

                var dl = mkLink('Download PDF', pdfUrl, false);
                try { dl.setAttribute('download', safeFile); } catch(_) {}
                actions.appendChild(dl);

                try {
                  if (navigator && navigator.share && typeof File === 'function') {
                    var shareBtn = mkBtn('Share PDF', false);
                    shareBtn.addEventListener('click', async function(){
                      try {
                        var blob = null;
                        try { blob = (window).__gbLastPdfBlob || null; } catch(_) { blob = null; }
                        if (!blob) { try { alert('Share is not available yet. Please use Open PDF.'); } catch(_) {} return; }
                        var name = safeFile;
                        try {
                          name = String(name || 'Signed-Quote.pdf');
                          if (!/\.pdf$/i.test(name)) name = name + '.pdf';
                        } catch(_) { name = 'Signed-Quote.pdf'; }
                        var f = null;
                        try { f = new File([blob], name, { type: 'application/pdf' }); } catch(_) { f = null; }
                        if (!f) { try { alert('Sharing is not supported in this browser.'); } catch(_) {} return; }
                        try {
                          if (navigator && navigator.canShare && !navigator.canShare({ files: [f] })) {
                            try { alert('Sharing is not supported in this browser. Please use Download PDF.'); } catch(_) {}
                            return;
                          }
                        } catch(_) {}
                        await navigator.share({ files: [f] });
                      } catch(_) { }
                    });
                    actions.appendChild(shareBtn);
                  }
                } catch(_) {}
              } catch(_) {}
            } catch(_) {}
          }

          function bakeInputsForPdf(){
            try {
              // Notes: replace textarea with a static div so the PDF looks like the printout.
              var ta = document.getElementById('clientNotes');
              if (ta && ta.tagName === 'TEXTAREA') {
                var div = document.createElement('div');
                div.setAttribute('data-gb-baked', '1');
                try { div.setAttribute('style', ta.getAttribute('style') || ''); } catch(_) {}
                try {
                  div.style.whiteSpace = 'pre-wrap';
                  div.style.overflowWrap = 'break-word';
                  div.style.wordBreak = 'break-word';
                } catch(_) {}
                try { div.textContent = (ta).value ? String((ta).value) : ''; } catch(_) { div.textContent = ''; }
                try { if (ta.parentNode) ta.parentNode.replaceChild(div, ta); } catch(_) {}
              }

              // Checklist: replace checkbox inputs with static checked/unchecked boxes.
              var labels = document.querySelectorAll('label');
              for (var i = 0; i < labels.length; i++) {
                var lbl = labels[i];
                if (!lbl) continue;
                var cb = lbl.querySelector && lbl.querySelector('input[type="checkbox"]');
                if (!cb) continue;
                var span = lbl.querySelector && lbl.querySelector('span');
                var txt = '';
                try { txt = String(span ? span.textContent : lbl.textContent || '').trim(); } catch(_) { txt = ''; }

                var row = document.createElement('div');
                row.setAttribute('data-gb-baked', '1');
                row.style.display = 'flex';
                row.style.alignItems = 'flex-start';
                row.style.gap = '8px';
                row.style.margin = '0 0 6px 0';

                var box = document.createElement('div');
                try { box.textContent = (cb).checked ? '☑' : '☐'; } catch(_) { box.textContent = '☐'; }
                box.style.fontWeight = '900';
                box.style.width = '16px';
                box.style.lineHeight = '1';

                var text = document.createElement('div');
                text.textContent = txt;

                row.appendChild(box);
                row.appendChild(text);
                try { if (lbl.parentNode) lbl.parentNode.replaceChild(row, lbl); } catch(_) {}
              }
            } catch(_) {}
          }

          async function exportPdfAndThankYou(){
            var base = 'Gadgetboy-Quote-' + sanitize(gbCustomerName || 'Customer');
            var filename = base + '-' + (gbStampShort || '') + '.pdf';
            var api = (window).api;

            // Populate PDF-only signature/date slots (do not show on screen permanently)
            var pdfWrap = document.getElementById('gbPdfSigWrap');
            var pdfImg = document.getElementById('gbPdfSigImg');
            var pdfDate = document.getElementById('gbPdfDate');
            try {
              if (pdfImg && gbSigDataUrl) pdfImg.setAttribute('src', gbSigDataUrl);
              if (pdfDate) pdfDate.textContent = gbSigDateStr || fmtDate(new Date());
              if (pdfWrap && pdfWrap.style) pdfWrap.style.display = 'block';
            } catch(_) {}

            // Convert interactive inputs to static content before capturing the PDF.
            try { bakeInputsForPdf(); } catch(_) {}

            // Hide any interactive elements while capturing the PDF.
            var style = document.createElement('style');
            style.setAttribute('data-gb-hide','1');
            style.textContent = '.no-print{display:none !important} html,body{background:#ffffff !important; color:#000000 !important} .print-page{background:#ffffff !important; color:#000000 !important; box-sizing:border-box !important; page-break-after:always !important; break-after:page !important;} .print-page:last-of-type{page-break-after:auto !important; break-after:auto !important;} .print-page *{box-sizing:border-box !important;} *{-webkit-print-color-adjust:exact; print-color-adjust:exact;}';
            try { document.head.appendChild(style); } catch(_) {}

            try {
              if (api && typeof api.exportPdf === 'function') {
                var html = '<!doctype html>' + document.documentElement.outerHTML;
                var res = await api.exportPdf(html, base);
                try {
                  if (res && res.ok && res.filePath && typeof api.dbAdd === 'function') {
                    api.dbAdd('quoteFiles', { createdAt: new Date().toISOString(), customerId: gbCustomerId || null, customerName: gbCustomerName, customerPhone: gbCustomerPhone, filePath: res.filePath, title: document.title, itemsCount: gbItemsCount });
                  }
                } catch(_) {}
                showThankYou(filename);
                return;
              }

              // Browser path: use inlined html2pdf bundle (offline-friendly)
              if (typeof (window).html2pdf !== 'function') {
                try { alert('PDF export is not available in this viewer. Use Print to Save as PDF.'); } catch(_) {}
                try { window.print(); } catch(_) {}
                return;
              }
              var opt = {
                margin: 0,
                filename: filename,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                pagebreak: { mode: ['css', 'legacy'] }
              };
              // Blob-first export (more reliable than triggering a download directly in many browsers/viewers)
              var worker = (window).html2pdf().set(opt).from(document.body);
              var blob = null;
              try {
                if (worker && typeof worker.outputPdf === 'function') {
                  blob = await worker.outputPdf('blob');
                } else {
                  try { if (worker && typeof worker.toPdf === 'function') await worker.toPdf(); } catch(_) {}
                  var pdf = null;
                  try { if (worker && typeof worker.get === 'function') pdf = await worker.get('pdf'); } catch(_) { pdf = null; }
                  try { if (pdf && typeof pdf.output === 'function') blob = pdf.output('blob'); } catch(_) { blob = null; }
                }
              } catch(_) { blob = null; }

              if (blob) {
                try {
                  var file = null;
                  try { file = new File([blob], filename, { type: 'application/pdf' }); } catch(_) { file = null; }
                  if (navigator && navigator.share && file) {
                    try {
                      if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('cannot-share-files');
                    } catch(_) {}
                    try { await navigator.share({ files: [file] }); showThankYou(filename); return; } catch(_) {}
                  }
                } catch(_) {}

                try {
                  var url = URL.createObjectURL(blob);
                  try { (window).__gbLastPdfUrl = url; (window).__gbLastPdfBlob = blob; } catch(_) {}
                  // Try to download and also open in a new tab as a fallback.
                  try {
                    var a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.target = '_blank';
                    document.body.appendChild(a);
                    a.click();
                    try { a.parentNode && a.parentNode.removeChild(a); } catch(_) {}
                  } catch(_) {}
                  try { window.open(url, '_blank'); } catch(_) {}
                  try { setTimeout(function(){ try{ URL.revokeObjectURL(url); } catch(_){} }, 600000); } catch(_) {}
                } catch(_) {}

                showThankYou(filename);
                return;
              }

              // Last resort: library-managed download
              try {
                if (worker && typeof worker.save === 'function') {
                  await worker.save();
                } else {
                  await (window).html2pdf().set(opt).from(document.body).save();
                }
              } catch(_) {
                throw new Error('Could not generate PDF');
              }
              showThankYou(filename);
            } catch(e) {
              try { console.error(e); } catch(_) {}
              try { alert('Could not generate the PDF. Check Chrome Downloads / popups. Fallback: Print to Save as PDF.'); } catch(_) {}
              try { window.print(); } catch(_) {}
            } finally {
              try { if (style && style.parentNode) style.parentNode.removeChild(style); } catch(_) {}
              try { if (pdfWrap && pdfWrap.style) pdfWrap.style.display = 'none'; } catch(_) {}
            }
          }

          (window).__gbApplySignature = applySignature;
          (window).__gbFinalizeFromPopup = exportPdfAndThankYou;

          function gbPad(n){ return String(n).padStart(2,'0'); }
          function gbTodayIso(){ try{ var d=new Date(); return String(d.getFullYear())+'-'+gbPad(d.getMonth()+1)+'-'+gbPad(d.getDate()); }catch(_){ return ''; } }
          function gbIsoToSlash(iso){
            try {
              var s=String(iso||'');
              // This script is inside a TS template literal, so use double-backslashes
              // to preserve the intended regex escapes in the exported HTML.
              if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return '';
              return s.slice(5,7) + '/' + s.slice(8,10) + '/' + s.slice(0,4);
            } catch(_) { return ''; }
          }

          function setupInlineSigning(){
                  try { var warn = document.getElementById('gbJsWarn'); if (warn && warn.style) warn.style.display = 'none'; } catch(_) {}
            var nameInput = document.getElementById('gbSigName');
            var dateInput = document.getElementById('gbSigDate');
            var clearBtn = document.getElementById('gbSigClear');
            var finBtn = document.getElementById('signFinalize');
            var finText = '';
            try { finText = finBtn && finBtn.textContent ? String(finBtn.textContent) : ''; } catch(_) { finText = ''; }

            function setBusy(isBusy){
              try {
                if (!finBtn) return;
                finBtn.disabled = !!isBusy;
                finBtn.style.opacity = isBusy ? '0.75' : '1';
                finBtn.textContent = isBusy ? 'Generating PDF…' : (finText || 'Finalize (Download PDF)');
              } catch(_) {}
            }

            // Best-effort: start loading the signature font early.
            try { if (document.fonts && document.fonts.load) document.fonts.load('48px "Alex Brush"'); } catch(_) {}

            function sigDataUrlFromName(name){
              try {
                var n = String(name || '').trim();
                if (!n) return '';
                var c = document.createElement('canvas');
                c.width = 1200;
                c.height = 300;
                var t = c.getContext && c.getContext('2d');
                if (!t) return '';
                t.fillStyle = '#ffffff';
                t.fillRect(0,0,c.width,c.height);
                t.fillStyle = '#000000';
                t.textAlign = 'center';
                t.textBaseline = 'middle';

                var maxW = c.width * 0.92;
                var size = 140;
                while (size > 64) {
                  t.font = String(size) + 'px "Alex Brush", "Segoe Script", "Brush Script MT", cursive';
                  try { if (t.measureText(n).width <= maxW) break; } catch(_) { break; }
                  size -= 6;
                }
                t.font = String(size) + 'px "Alex Brush", "Segoe Script", "Brush Script MT", cursive';
                t.fillText(n, c.width/2, (c.height/2) + 8);
                return c.toDataURL('image/png');
              } catch(_) { return ''; }
            }

            function inlineFinalize(){
              try {
                setBusy(true);
                var typed = (nameInput && nameInput.value) ? String(nameInput.value).trim() : '';
                if (!typed) { try { alert('Please type your full name to sign.'); } catch(_) {} return false; }
                var iso = '';
                try { iso = (dateInput && dateInput.value) ? String(dateInput.value) : ''; } catch(_) { iso = ''; }
                if (!iso) { try { alert('Please select a date.'); } catch(_) {} return false; }
                var url = sigDataUrlFromName(typed);
                if (!url) { try { alert('Could not render the signature. Please try again.'); } catch(_) {} return false; }
                var ds = '';
                try { ds = gbIsoToSlash(iso) || fmtDate(new Date()); } catch(_) { ds = fmtDate(new Date()); }
                try { applySignature(url, ds); } catch(_) {}
                try {
                  var p = exportPdfAndThankYou();
                  if (p && typeof p.then === 'function') {
                    p.then(function(){ try{ setBusy(false); } catch(_){} }).catch(function(e){ try{ setBusy(false); } catch(_){} try{ console.error(e); } catch(_){} try{ alert('PDF export failed. Please try again, and check Chrome Downloads / popup settings.'); } catch(_){} });
                  } else {
                    setBusy(false);
                  }
                } catch(e) {
                  try { setBusy(false); } catch(_) {}
                  try { console.error(e); } catch(_) {}
                  try { alert('PDF export failed. Please try again.'); } catch(_) {}
                }
              } catch(e) {
                try { setBusy(false); } catch(_) {}
                try { console.error(e); } catch(_) {}
                try { alert('Finalize failed. Please refresh and try again.'); } catch(_) {}
              }
              return false;
            }

            try { (window).__gbInlineFinalize = inlineFinalize; } catch(_) {}

            try { if (dateInput && !dateInput.value) dateInput.value = gbTodayIso(); } catch(_) {}

            try { if (clearBtn) clearBtn.addEventListener('click', function(e){ try{ e.preventDefault(); }catch(_){} try{ if(nameInput) nameInput.value=''; }catch(_){} try{ if(dateInput) dateInput.value=''; }catch(_){} }); } catch(_) {}
            try { if (finBtn) finBtn.addEventListener('click', function(e){ try{ e.preventDefault(); }catch(_){} inlineFinalize(); }); } catch(_) {}
          }

          gbReady(function(){ try { setupInlineSigning(); } catch(_) {} });

          // Stop here; the legacy inline signature/PDF code below is kept for reference but no longer runs.
          return;
        } catch(_) {}

        // Exact single-canvas signature logic (preview parity)
        const canvas = document.getElementById('sigPad');
        const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
        const sigInput = document.getElementById('sigName');
        const sigApply = document.getElementById('sigApply');
        const sigClear = document.getElementById('sigClear');
        const dateBox = document.getElementById('dateBox');
        const finalizeBtn = document.getElementById('finalize');
        // Injected context for recording completed quote in-app
        const CUSTOMER_NAME = ${JSON.stringify(cust)};
        const CUSTOMER_ID = ${JSON.stringify(custId)};
        const CUSTOMER_NAME = ${JSON.stringify(cust)};
        const CUSTOMER_PHONE = ${JSON.stringify(phone)};
        const ITEMS_COUNT = ${JSON.stringify((sales.items || []).length)};
  const STAMP_TITLE = ${JSON.stringify(stampTitle)};
  const STAMP_SHORT = ${JSON.stringify(stampShort)};

        function resize(){
          if (!canvas || !ctx) return;
          const r = canvas.getBoundingClientRect();
          const dpr = (window.devicePixelRatio || 1);
          // On some mobile viewers the first layout pass reports width/height as 0.
          // Fall back to parent width and a fixed height so drawing/typed signature still works.
          let parentW = 0;
          try { parentW = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 0; } catch { parentW = 0; }
          const cssW = (r && r.width >= 2) ? r.width : (parentW >= 2 ? parentW : 600);
          const cssH = (r && r.height >= 2) ? r.height : 96;
          canvas.width = Math.max(1, Math.floor(cssW * dpr));
          canvas.height = Math.max(1, Math.floor(cssH * dpr));
          ctx.setTransform(1,0,0,1,0,0);
          ctx.scale(dpr, dpr);
          ctx.lineWidth = 2.5;
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#000000';
          try { if (canvas.style) canvas.style.touchAction = 'none'; } catch {}
        }

        let drawing=false, last=[0,0], dirty=false, typed=false;
        function pos(e){
          if (!canvas) return [0,0];
          const r=canvas.getBoundingClientRect();
          const touch = (e && e.touches && e.touches.length) ? e.touches[0]
                       : (e && e.changedTouches && e.changedTouches.length) ? e.changedTouches[0]
                       : null;
          const pt = touch || e || { clientX: 0, clientY: 0 };
          const x = (pt.clientX || 0) - r.left;
          const y = (pt.clientY || 0) - r.top;
          return [x,y];
        }
        function start(e){
          if (!ctx || typed) return;
          try { if (canvas && (canvas.width <= 2 || canvas.height <= 2)) resize(); } catch {}
          drawing=true;
          last=pos(e);
          try{ e.preventDefault(); }catch{}
        }
        function move(e){ if(!drawing||!ctx||typed) return; const p=pos(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last=p; dirty=true; try{ e.preventDefault(); }catch{} }
        function end(){ drawing=false; }

        if (canvas && ctx) {
          window.addEventListener('resize', resize, { passive: true });
          resize();
          // Mobile pinch-zoom doesn't always trigger 'resize'; observe layout changes.
          try {
            if (window.ResizeObserver && canvas.parentElement) {
              const ro = new ResizeObserver(function(){ try { resize(); } catch {} });
              ro.observe(canvas.parentElement);
            }
          } catch {}
          try { window.addEventListener('orientationchange', function(){ setTimeout(function(){ try{ resize(); }catch{} }, 60); }, { passive: true }); } catch {}
          try { setTimeout(function(){ try { resize(); } catch {} }, 80); } catch {}
          try { canvas.style.touchAction = 'none'; } catch {}
          canvas.addEventListener('pointerdown', function(e){ try{ start(e); if (typeof canvas.setPointerCapture==='function') canvas.setPointerCapture(e.pointerId); } catch{} }, { passive: false });
          canvas.addEventListener('pointermove', move, { passive: false });
          window.addEventListener('pointerup', function(e){ try{ end(); if (typeof canvas.releasePointerCapture==='function') canvas.releasePointerCapture(e.pointerId); } catch{} });
          window.addEventListener('pointercancel', function(){ try{ end(); } catch{} });
          canvas.addEventListener('mousedown', start);
          canvas.addEventListener('mousemove', move);
          window.addEventListener('mouseup', end);
          canvas.addEventListener('touchstart', start, {passive:false});
          canvas.addEventListener('touchmove', move, {passive:false});
          window.addEventListener('touchend', end);
          window.addEventListener('touchcancel', end);
          canvas.addEventListener('mouseleave', end);
        }

        if (sigClear && canvas && ctx) sigClear.addEventListener('click', function(){ try{ ctx.clearRect(0,0,canvas.width,canvas.height); }catch{} resize(); dirty=false; typed=false; try{ if (sigInput) sigInput.removeAttribute('disabled'); if (sigApply) sigApply.removeAttribute('disabled'); }catch{} });

        function placeTypedSignature(name){
          if (!canvas || !ctx) return;
          try { resize(); } catch {}
          ctx.clearRect(0,0,canvas.width,canvas.height);
          const dpr=(window.devicePixelRatio||1);
          const cssH = canvas.height / dpr;
          const size = Math.floor(Math.max(20, cssH * 0.5));
          ctx.fillStyle='#000';
          ctx.textAlign='center';
          ctx.textBaseline='middle';
          ctx.font = String(size) + 'px "Alex Brush", "Segoe Script", "Edwardian Script ITC", "Brush Script MT", "Lucida Handwriting", cursive';
          const cx=(canvas.width/dpr)/2;
          const cy=(canvas.height/dpr)/2;
          ctx.fillText(name, cx, cy);
          dirty=true;
          typed=true;
        }

        if (sigApply && sigInput) sigApply.addEventListener('click', function(e){ try{ e.preventDefault(); }catch{} const name = (sigInput instanceof HTMLInputElement ? sigInput.value : '').trim(); if (!name) { try{ alert('Please enter your full name to sign.'); }catch{} return; } placeTypedSignature(name); try{ sigInput.setAttribute('disabled',''); }catch{} try{ sigApply.setAttribute('disabled',''); }catch{} });

        if (finalizeBtn) finalizeBtn.addEventListener('click', function(){
          try {
            if (dateBox) { const now=new Date(); const pad=(n)=>String(n).padStart(2,'0'); const mm=pad(now.getMonth()+1), dd=pad(now.getDate()), yy=String(now.getFullYear()).slice(-2); dateBox.innerHTML=''; const d=document.createElement('div'); d.style.padding='8px 0'; d.style.textAlign='center'; d.style.fontWeight='600'; d.textContent='Date Signed: '+mm+'/'+dd+'/'+yy; dateBox.appendChild(d); try { const lbl=dateBox.nextElementSibling; if(lbl && lbl.textContent && lbl.textContent.trim().toLowerCase()==='date'){ lbl.parentElement.removeChild(lbl); } } catch{} }
            if (canvas && ctx && dirty) {
              const tmp = document.createElement('canvas'); tmp.width = canvas.width; tmp.height = canvas.height; const tctx = tmp.getContext('2d'); let dataUrl = '';
              if (tctx) { tctx.fillStyle = '#ffffff'; tctx.fillRect(0,0,tmp.width,tmp.height); tctx.drawImage(canvas,0,0); dataUrl = tmp.toDataURL('image/png'); }
              else { dataUrl = canvas.toDataURL('image/png'); }
              const img=document.createElement('img'); img.src=dataUrl; img.style.width='100%'; img.style.height='96px'; img.style.objectFit='contain'; img.style.border='1px solid #000'; img.style.borderRadius='4px';
              if (canvas.parentElement) { canvas.parentElement.replaceChild(img, canvas); }
            }
            try { const actions = document.querySelector('.sig-actions'); if (actions && actions.parentElement) actions.parentElement.removeChild(actions); } catch {}
          } catch(e) {}
          const html='<!doctype html>'+document.documentElement.outerHTML;
          const api = (window).api;
          // Build filename base: Gadgetboy-Quote-CLIENTNAME (sanitized)
          const sanitize = (s) => String(s||'').toString().replace(/[^a-z0-9\-\_\+]+/gi,'-').replace(/-{2,}/g,'-').replace(/^-+|-+$/g,'');
          const base = 'Gadgetboy-Quote-' + sanitize(CUSTOMER_NAME || 'Customer');
          if (api && typeof api.exportPdf==='function') {
            api.exportPdf(html, base).then((res)=>{ 
              if(res && res.ok && res.filePath && typeof api.dbAdd==='function'){
                try { api.dbAdd('quoteFiles', { createdAt: new Date().toISOString(), customerId: CUSTOMER_ID || null, customerName: CUSTOMER_NAME, customerPhone: CUSTOMER_PHONE, filePath: res.filePath, title: document.title, itemsCount: ITEMS_COUNT }); } catch {}
              } else if(!res || !res.ok) { try{ alert('Could not save PDF'); }catch{} }
            });
          } else {
            // Browser: generate a PDF client-side (no print dialog) using html2canvas + jsPDF
            const ensureLib = (src) => new Promise((resolve, reject)=>{ const s=document.createElement('script'); s.src=src; s.onload=()=>resolve(true); s.onerror=(e)=>reject(e); document.head.appendChild(s); });
            const ensureLibAny = async (sources) => {
              let lastErr = null;
              for (let i = 0; i < sources.length; i++) {
                try { await ensureLib(sources[i]); return true; } catch (e) { lastErr = e; }
              }
              throw lastErr || new Error('Failed to load scripts');
            };
            const ensurePdfLibs = async () => {
              const needH2C = !(window).html2canvas;
              const needJspdf = !((window).jspdf && (window).jspdf.jsPDF);
              const tasks = [];
              if (needH2C) tasks.push(ensureLibAny([
                'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
                'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
              ]));
              if (needJspdf) tasks.push(ensureLibAny([
                'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
                'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
              ]));
              if (tasks.length) await Promise.all(tasks);
            };
            const SHOP_EMAIL = 'gadgetboysc@gmail.com';

            const showPdfActions = (blob, filename) => {
              try {
                const wrap = document.createElement('div');
                wrap.className = 'no-print';
                wrap.style.margin = '14px auto 18px auto';
                wrap.style.maxWidth = '920px';
                wrap.style.padding = '12px';
                wrap.style.border = '1px solid #111827';
                wrap.style.borderRadius = '12px';
                wrap.style.background = '#ffffff';
                wrap.style.color = '#000000';
                wrap.style.textAlign = 'center';
                wrap.innerHTML =
                  '<div style="font-weight:800; margin-bottom:6px">PDF Ready</div>' +
                  '<div style="font-size:11.5pt; margin-bottom:10px">On mobile, use Share to send the PDF back to us.</div>';

                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.gap = '8px';
                row.style.justifyContent = 'center';
                row.style.flexWrap = 'wrap';

                const mkBtn = (label) => {
                  const b = document.createElement('button');
                  b.type = 'button';
                  b.textContent = label;
                  b.style.padding = '10px 14px';
                  b.style.borderRadius = '10px';
                  b.style.border = '2px solid #000';
                  b.style.background = '#39FF14';
                  b.style.color = '#000';
                  b.style.fontWeight = '800';
                  b.style.cursor = 'pointer';
                  return b;
                };

                const downloadBtn = mkBtn('Download PDF');
                downloadBtn.addEventListener('click', function(){
                  try {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    // iOS Safari sometimes ignores download; open the PDF in a new tab as fallback.
                    try {
                      const ua = String(navigator && navigator.userAgent ? navigator.userAgent : '');
                      const isIOS = /iP(hone|ad|od)/.test(ua);
                      if (isIOS) { window.open(url, '_blank'); }
                    } catch (e) {}
                    setTimeout(function(){ try { URL.revokeObjectURL(url); } catch {} }, 15000);
                  } catch(e) {}
                });

                const shareBtn = mkBtn('Share PDF');
                shareBtn.addEventListener('click', async function(){
                  try {
                    let name = filename;
                    try { name = String(name || 'Signed-Quote.pdf'); if (!/\.pdf$/i.test(name)) name = name + '.pdf'; } catch { name = 'Signed-Quote.pdf'; }
                    const f = new File([blob], name, { type: 'application/pdf' });
                    const canShare = !!(navigator && navigator.share && navigator.canShare && navigator.canShare({ files: [f] }));
                    if (!canShare) { alert('Sharing is not supported in this browser. Use Download PDF instead.'); return; }
                    await navigator.share({ files: [f] });
                  } catch(e) {
                    try { alert('Could not open share sheet. Use Download PDF instead.'); } catch {}
                  }
                });

                const emailBtn = document.createElement('a');
                emailBtn.textContent = 'Open Email (prefilled)';
                emailBtn.href = 'mailto:' + encodeURIComponent(SHOP_EMAIL) +
                  '?subject=' + encodeURIComponent('Signed Gadgetboy Quote') +
                  '&body=' + encodeURIComponent('Hi Gadgetboy,\\n\\nI signed the quote. I am attaching the PDF from this page.\\n\\nThanks,\\n' + (CUSTOMER_NAME || ''));
                emailBtn.style.display = 'inline-flex';
                emailBtn.style.alignItems = 'center';
                emailBtn.style.justifyContent = 'center';
                emailBtn.style.padding = '10px 14px';
                emailBtn.style.borderRadius = '10px';
                emailBtn.style.border = '2px solid #000';
                emailBtn.style.background = '#111827';
                emailBtn.style.color = '#fff';
                emailBtn.style.fontWeight = '800';
                emailBtn.style.textDecoration = 'none';

                const copyBtn = mkBtn('Copy Email');
                copyBtn.style.background = '#111827';
                copyBtn.style.color = '#ffffff';
                copyBtn.addEventListener('click', async function(){
                  try {
                    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                      await navigator.clipboard.writeText(SHOP_EMAIL);
                      alert('Copied: ' + SHOP_EMAIL);
                      return;
                    }
                  } catch(e) {}
                  try { prompt('Copy this email address:', SHOP_EMAIL); } catch(e) {}
                });

                row.appendChild(shareBtn);
                row.appendChild(downloadBtn);
                row.appendChild(emailBtn);
                row.appendChild(copyBtn);
                wrap.appendChild(row);

                document.body.appendChild(wrap);
              } catch(e) {}
            };

            const toPdf = async () => {
              try {
                try { if (window.__gbFitQuotePages) window.__gbFitQuotePages(); } catch(e) {}
                await ensurePdfLibs();
                const h2c = (window).html2canvas;
                const jsPDF = (window).jspdf.jsPDF;
                // Force white background and black text for PDF legibility
                const style = document.createElement('style');
                style.setAttribute('data-pdf-style','1');
                style.textContent = 'html, body { background: #ffffff !important; color: #000000 !important; } ' +
                                   '.print-page { background: #ffffff !important; color: #000000 !important; } ' +
                                   '.page-inner { color: #000000 !important; } ' +
                                   '* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }';
                document.head.appendChild(style);
                const pages = Array.from(document.querySelectorAll('.print-page'));
                const a4 = { w: 210, h: 297 }; // mm
                const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
                for (let i=0; i<pages.length; i++){
                  const el = pages[i];
                  // Scale canvas to fit A4 at decent resolution
                  const canvas = await h2c(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
                  const img = canvas.toDataURL('image/jpeg', 0.95);
                  const pw = a4.w, ph = a4.h;
                  // Maintain aspect ratio fit
                  const ratio = canvas.width / canvas.height;
                  let w = pw, h = w / ratio; if (h > ph) { h = ph; w = h * ratio; }
                  const x = (pw - w) / 2, y = (ph - h) / 2;
                  if (i>0) pdf.addPage('a4', 'portrait');
                  pdf.addImage(img, 'JPEG', x, y, w, h);
                }
                const filename = base + '-' + STAMP_SHORT + '.pdf';
                const blob = pdf.output('blob');
                // On mobile browsers, pdf.save() often fails. Prefer Share/Download.
                const isTouch = !!(navigator && (navigator.maxTouchPoints || 0) > 0);
                if (blob && (isTouch || (navigator && navigator.share))) {
                  showPdfActions(blob, filename);
                  // Best-effort auto-download for browsers that allow it.
                  try {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(function(){ try { URL.revokeObjectURL(url); } catch {} }, 15000);
                  } catch {}
                } else {
                  pdf.save(filename);
                }
                try { document.head.removeChild(style); } catch {}
                try { if (window.__gbClearQuotePageFit) window.__gbClearQuotePageFit(); } catch(e) {}
              } catch (e) {
                try {
                  const prev = document.querySelector('style[data-pdf-style="1"]');
                  if (prev) prev.parentElement.removeChild(prev);
                } catch {}
                try { if (window.__gbClearQuotePageFit) window.__gbClearQuotePageFit(); } catch(e) {}
                try { alert('Could not generate PDF automatically. Your browser will open the print dialog, choose "Save as PDF".'); } catch {}
                try { window.print(); } catch {}
              }
            };
            toPdf();
          }
        });
      })();
      </script>
    </body>
    </html>`;
  }
        

  // Build interactive HTML but embed the logo as data URL so it renders in the saved file
  async function generateInteractiveSalesHtml(): Promise<string> {
    // Try to fetch the logo from the current app and convert to data URL; fallback to no logo
    try {
  const res = await fetch(publicAsset('logo-spin.gif'));
      if (!res.ok) throw new Error('logo fetch failed');
      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      return buildInteractiveSalesHtml(dataUrl);
    } catch {
      return buildInteractiveSalesHtml(undefined);
    }
  }

  async function tryGetLogoDataUrl(): Promise<string | undefined> {
    try {
      const res = await fetch(publicAsset('logo-spin.gif'));
      if (!res.ok) return undefined;
      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      return dataUrl || undefined;
    } catch {
      return undefined;
    }
  }

  // Build a dedicated, print-only HTML document for Sales quotes.
  function buildSalesPrintHtml(logoDataUrl?: string) {
    const esc = (s: any) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
    const escAttr = (s: string) => esc(String(s || '')).replace(/"/g, '&quot;');
    const labels = sales.items.map((it, idx) => {
      const model = String(((it.model ?? (it as any).dynamic?.model) || '')).trim();
      return (model ? [it.brand, model].filter(Boolean).join(' ').trim() : '') || `Item ${idx + 1}`;
    });
    const cust = `${sales.customerName || ''}`.trim();
    const phoneRaw = `${sales.customerPhone || ''}`.trim();
    const phone = (formatPhone(phoneRaw) || phoneRaw).trim();
    const email = `${(sales as any).customerEmail || ''}`.trim();
    const now = new Date().toLocaleDateString();
    const logoSrc = logoDataUrl || publicAsset('logo-spin.gif');

    const first = sales.items[0];
    const firstTitleModel = first ? String(((first.model ?? (first as any).dynamic?.model) || '')).trim() : '';
    const firstTitle = firstTitleModel ? [first?.brand, firstTitleModel].filter(Boolean).join(' ').trim() : 'First Device';

    // Custom PC/Build: Full custom print rebuilt from scratch (keep top header on first page)
    if (first && /custom/i.test(String((first as any).deviceType || (first as any).deviceCategory || (first as any).category || ''))) {
      const TAX_RATE = 0.08;
      const dyn: any = first.dynamic || {};
      type Part = { label: string; key: string; desc: string; priceRaw: number; priceMarked: number; image?: string; image2?: string };
      const baseParts: Array<{ key: string; label: string }> = [
        { key: 'case', label: 'Case' },
        { key: 'motherboard', label: 'Motherboard' },
        { key: 'cpu', label: 'Processor' },
        { key: 'cooling', label: 'Cooling' },
        { key: 'ram', label: 'Memory' },
        { key: 'gpu', label: 'Graphics Card' },
        { key: 'storage', label: 'Primary Storage' },
        { key: 'psu', label: 'PSU' },
        { key: 'os', label: 'Operating System' },
      ];
      const parts: Part[] = [];
      const combine = (arr: (string | undefined)[]) => arr.filter(Boolean).map(String).map((s) => s.trim()).filter(Boolean).join(' | ');
      const buildDesc2 = (key: string) => {
        const raw = String(dyn[key] || dyn[`${key}Info`] || '').trim();
        switch (key) {
          case 'cpu':
            return combine([raw, dyn.cpuGen && `Gen ${dyn.cpuGen}`, dyn.cpuCores && `${dyn.cpuCores} cores`, dyn.cpuClock && `${dyn.cpuClock}`]) || raw;
          case 'ram':
            return combine([raw, dyn.ramSize && `${dyn.ramSize}`, dyn.ramSpeed && `${dyn.ramSpeed}`, dyn.ramType && `${dyn.ramType}`]) || raw;
          case 'gpu':
            return combine([raw, dyn.gpuModel || dyn.gpu, dyn.gpuVram && `${dyn.gpuVram}`]) || raw;
          case 'storage':
            return combine([raw, formatPrimaryStorageSummary(dyn)]) || raw;
          case 'motherboard':
            return combine([raw, dyn.moboChipset && `Chipset: ${dyn.moboChipset}`, dyn.formFactor && `${dyn.formFactor}`]) || raw;
          case 'psu':
            return combine([raw, dyn.psuWatt && `${dyn.psuWatt}W`]) || raw;
          case 'cooling':
            return combine([raw, dyn.coolingType]) || raw;
          case 'case':
            return combine([raw, dyn.caseFormFactor && `${dyn.caseFormFactor}`]) || raw;
          case 'os':
            return raw || dyn.os || '';
          default:
            return raw;
        }
      };
      baseParts.forEach((p) => {
        const desc = buildDesc2(p.key);
        const priceRaw = Number(dyn[`${p.key}Price`] || 0) || 0;
        const imagesArr = Array.isArray(dyn[`${p.key}Images`]) ? dyn[`${p.key}Images`] : [];
        let image: string | undefined = dyn[`${p.key}Image`] ? String(dyn[`${p.key}Image`]) : undefined;
        let image2: string | undefined = dyn[`${p.key}Image2`] ? String(dyn[`${p.key}Image2`]) : undefined;
        if (!image && imagesArr[0]) image = String(imagesArr[0]);
        if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
        if (!desc && !priceRaw && !image && !image2) return;
        parts.push({ label: p.label, key: p.key, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
      });

      // Secondary + Additional Storage as separate priced parts
      const secList2 = Array.isArray(dyn.pcSecondaryStorage) ? dyn.pcSecondaryStorage : [];
      secList2.forEach((d: any, i: number) => {
        const type = String(d?.type || '').trim();
        const size = String(d?.size || '').trim();
        const desc = [type, size].filter(Boolean).join(' ').trim();
        const priceRaw = Number(d?.price || 0) || 0;
        const image = d?.image ? String(d.image) : undefined;
        const image2 = d?.image2 ? String(d.image2) : undefined;
        if (!desc && !priceRaw && !image && !image2) return;
        const label = i === 0 ? 'Secondary Storage' : 'Additional Storage';
        parts.push({ label, key: `pc-storage-${i}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
      });
      const pcExtras = Array.isArray(dyn.pcExtras) ? dyn.pcExtras : [];
      pcExtras.forEach((e: any, i: number) => {
        const label = String(e?.label || e?.type || e?.name || '').trim() || 'Peripheral';
        const desc = String(e?.desc || '').trim();
        const priceRaw = Number(e?.price || 0) || 0;
        const imagesArr = Array.isArray(e?.images) ? e.images : [];
        let image: string | undefined = e?.image ? String(e.image) : undefined;
        let image2: string | undefined = e?.image2 ? String(e.image2) : undefined;
        if (!image && imagesArr[0]) image = String(imagesArr[0]);
        if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
        if (!desc && !priceRaw && !image && !image2) return;
        parts.push({ label, key: `pc-extra-${i}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
      });
      const extras = Array.isArray(dyn.extraParts) ? dyn.extraParts : [];
      extras.forEach((e: any) => {
        const label = String(e?.name || 'Extra');
        const desc = String(e?.desc || '').trim();
        const priceRaw = Number(e?.price || 0) || 0;
        const imagesArr = Array.isArray(e?.images) ? e.images : [];
        let image: string | undefined = e?.image ? String(e.image) : undefined;
        let image2: string | undefined = e?.image2 ? String(e.image2) : undefined;
        if (!image && imagesArr[0]) image = String(imagesArr[0]);
        if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
        if (!label && !desc && !priceRaw && !image && !image2) return;
        parts.push({ label, key: `extra-${label}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
      });
      const laborRaw = Number(dyn.buildLabor || 0) || 0;
      const chunk = <T,>(arr: T[], size: number) => { const out: T[][] = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };

      const headerBlock = () => `
        <div style="display:flex; gap:12px; align-items:flex-start; margin-bottom:12px">
          <img src="${escAttr(logoSrc)}" alt="GadgetBoy" style="height:30mm; width:auto" />
          <div style="line-height:1.15; flex:1">
            <div style="font-size:18pt; font-weight:700; letter-spacing:0.3px">Custom PC Build Quote</div>
            <div style="font-size:12pt; font-weight:700">GADGETBOY Repair & Retail</div>
            <div style="font-size:11pt">2822 Devine Street, Columbia, SC 29205</div>
            <div style="font-size:11pt">(803) 708-0101 | gadgetboysc@gmail.com</div>
            <div style="margin-top:6px; font-size:11pt"><b>Customer:</b> ${esc(cust || '-')} | <b>Phone:</b> ${esc(phone)}${email ? ` | <b>Email:</b> ${esc(email)}` : ''}</div>
            <div style="font-size:11pt; color:#555">Generated: ${esc(now)}</div>
          </div>
        </div>`;

      const partBox = (p: Part) => {
        if (String(p.key).toLowerCase() === 'os' || String(p.label).toLowerCase().includes('operating system')) {
          return `
          <div style="display:grid; grid-template-columns:42mm 1fr; column-gap:10px; align-items:stretch; margin-bottom:8px">
            <div></div>
            <div style="border:2px solid #f00; border-radius:6px; padding:8px; min-height:22mm">
              <div style="font-weight:700; margin-bottom:2px">${esc(p.label)}</div>
              <div style="font-size:10.5pt; line-height:1.35">${esc(p.desc || '-') }</div>
            </div>
          </div>`;
        }
        const imgs = [p.image, p.image2].filter(Boolean) as string[];
        const leftCol = imgs.length >= 2
          ? `
            <div style="width:44mm; height:34mm; display:flex; flex-direction:column; gap:4px; background:#fff; border:1px solid #e5e7eb; border-radius:4px; padding:4px; box-sizing:border-box">
              <div style="flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden"><img src="${imgs[0]}" style="max-width:100%; max-height:100%; object-fit:contain; display:block" /></div>
              <div style="flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden"><img src="${imgs[1]}" style="max-width:100%; max-height:100%; object-fit:contain; display:block" /></div>
            </div>`
          : (imgs.length === 1
            ? `<div style="width:44mm; height:34mm; display:flex; align-items:center; justify-content:center; background:#fff; border:1px solid #e5e7eb; border-radius:4px; overflow:hidden"><img src="${imgs[0]}" style="max-width:100%; max-height:100%; object-fit:contain; display:block" /></div>`
            : `<div style="width:44mm; height:34mm; display:flex; align-items:center; justify-content:center; background:#fff; border:1px solid #e5e7eb; border-radius:4px; overflow:hidden"><div style="font-size:9pt; color:#888">No Image</div></div>`);
        return `
          <div style="display:grid; grid-template-columns:44mm 1fr; column-gap:8px; align-items:stretch; margin-bottom:6px">
            ${leftCol}
            <div style="border:2px solid #f00; border-radius:6px; padding:6px; min-height:14mm; display:flex; align-items:center; justify-content:center; text-align:center; flex-direction:column">
              <div style="font-weight:700; margin-bottom:4px">${esc(p.label)}</div>
              <div style="font-size:10.5pt; line-height:1.35; margin-bottom:4px">${esc(p.desc || '-') }</div>
              <div style="font-weight:700; font-size:11pt">$${(p.priceMarked || 0).toFixed(2)}</div>
            </div>
          </div>`;
      };

      const firstPageParts = parts.slice(0, 6);
      const remainingChunks = chunk(parts.slice(6), 6);
      const promptHtmlBlock = first && first.prompt && String(first.prompt).trim().length > 0
        ? `\n            <div style="text-align:center; font-size:12.5pt; line-height:1.45; max-width:180mm; margin:12px auto 0 auto; border:2px solid #f00; border-radius:4px; padding:10px 12px">${esc(first.prompt || '')}</div>`
        : '';

      const firstPageHtml = `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm">
          <div class="page-inner">
            ${headerBlock()}
            ${firstPageParts.length ? firstPageParts.map(partBox).join('') : `<div style="border:1px dashed #f00; padding:10px; text-align:center; color:#666">No parts listed.</div>`}
          </div>
        </div>`;

      const otherPagesHtml = remainingChunks.map((group, i) => `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm">
          <div class="page-inner">
            ${group.map(partBox).join('')}${i === 0 ? promptHtmlBlock : ''}
          </div>
        </div>`).join('');

      const pricedParts = parts.filter((p) => !(String(p.key).toLowerCase() === 'os' || String(p.label).toLowerCase().includes('operating system')));
      const partsSubtotal = pricedParts.reduce((acc, p) => acc + (p.priceMarked || 0), 0);
      const taxAmount = partsSubtotal * TAX_RATE;
      const totalAfterTax = partsSubtotal + taxAmount + laborRaw;
      const summaryPage = `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm">
          <div class="page-inner">
            <div style="font-weight:700; font-size:13pt; margin-bottom:6px; text-align:center">Itemized Summary</div>
            <table style="border-collapse:collapse; width:100%; font-size:10pt">
              <thead>
                <tr><th style="border:1px solid #f00; padding:6px; text-align:left">Component</th><th style="border:1px solid #f00; padding:6px; text-align:right">Price</th></tr>
              </thead>
              <tbody>
                ${pricedParts.map((p) => `<tr><td style=\"border:1px solid #f00; padding:6px\"><b>${esc(p.label)}</b>${p.desc ? ` - ${esc(p.desc)}` : ''}</td><td style=\"border:1px solid #f00; padding:6px; text-align:right\">$${(p.priceMarked || 0).toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="2" style="border:1px solid #f00; padding:8px; text-align:center; color:#666">No components listed.</td></tr>'}
              </tbody>
              <tfoot>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:600">Parts Subtotal</td><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:600">$${partsSubtotal.toFixed(2)}</td></tr>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right">Build Labor (not taxed)</td><td style="border:1px solid #f00; padding:6px; text-align:right">$${laborRaw.toFixed(2)}</td></tr>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right">Tax on Parts (${(TAX_RATE*100).toFixed(0)}%)</td><td style="border:1px solid #f00; padding:6px; text-align:right">$${taxAmount.toFixed(2)}</td></tr>
                <tr><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:700">Total (after tax)</td><td style="border:1px solid #f00; padding:6px; text-align:right; font-weight:700">$${totalAfterTax.toFixed(2)}</td></tr>
              </tfoot>
            </table>
          </div>
        </div>`;

      const checklistHtml = (parts || []).map((p, i) => {
        const line = `<b>${esc(p.label || '')}</b>${p.desc ? ` - ${esc(p.desc)}` : ''}`;
        return `
          <label style="display:block; break-inside:avoid; margin:0 0 6px 0; font-size:10.5pt; line-height:1.25">
            <input type="checkbox" style="width:14px; height:14px; vertical-align:middle; margin-right:8px" />
            <span style="vertical-align:middle">${line}</span>
          </label>`;
      }).join('');

      const approvalPage = `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:11mm">
          <div class="page-inner" style="display:flex; flex-direction:column; min-height:273mm; padding-top:8px">
            <div style="font-weight:700; font-size:13pt; margin-bottom:10px; text-align:center">Client Notes & Parts Approval</div>

            <div style="font-weight:700; margin-bottom:6px; font-size:12pt">Client Notes</div>
            <textarea id="clientNotes" placeholder="Notes, requested changes, questions, or preferences..." style="width:100%; min-height:60mm; border:2px solid #f00; border-radius:4px; padding:10px; font: 11pt system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; box-sizing:border-box; resize:vertical"></textarea>

            <div style="font-weight:700; margin-top:14px; margin-bottom:6px; font-size:12pt">Parts Approval Checklist</div>
            <div style="border:2px solid #f00; border-radius:4px; padding:10px">
              <div style="font-size:10.5pt; color:#444; margin-bottom:8px">Check the components you approve. Leave items unchecked if you do not approve them yet or require changes.</div>
              <div style="columns:2; column-gap:16px">${checklistHtml || '<div style="color:#666">No parts listed.</div>'}</div>
            </div>

            <div style="margin-top:auto">
              <div style="font-weight:700; margin-top:14px; margin-bottom:6px; font-size:12pt">Terms and Conditions</div>
              <div style="border:2px solid #f00; border-radius:4px; padding:12px; font-size:11pt; line-height:1.45">
                <ul style="padding-left:1.1rem; margin:0">
                  <li style="margin-bottom:6px"><b>Quote Validity & Availability:</b> Quoted pricing is provided as of the date issued, is subject to parts availability, and may change prior to purchase.</li>
                  <li style="margin-bottom:6px"><b>Warranty & Exclusions:</b> 90-day limited hardware warranty for defects under normal use; exclusions include physical/impact damage, liquid exposure, unauthorized repairs/modifications, abuse/neglect, loss/theft, and third-party accessories.</li>
                  <li style="margin-bottom:0"><b>Data & Software:</b> Client is responsible for backups and licensing. Service may require updates/reinstall/reset; we are not responsible for data loss.</li>
                </ul>
              </div>

              <div style="margin-top:16px">
                <div style="display:flex; gap:24px; align-items:center">
                  <div style="flex:1">
                    <div style="display:flex; align-items:center; gap:10px">
                      <div style="font-weight:400; font-size:12pt; white-space:nowrap">Signature</div>
                      <div style="border-bottom:2px solid #000; height:24px; flex:1"></div>
                    </div>
                  </div>
                  <div style="width:220px">
                    <div style="display:flex; align-items:center; gap:10px">
                      <div style="font-weight:400; font-size:12pt; white-space:nowrap">Date</div>
                      <div style="border-bottom:2px solid #000; height:24px; flex:1"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>`;

      const html = `<!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Custom Build Quote</title>
        <base href="${(typeof window !== 'undefined' && (window as any).location) ? ((window as any).location.origin + '/') : '/'}">
        <style>
          @media print {
            @page { size:A4; margin:0; }
            .print-page { page-break-after: always; page-break-inside: avoid; break-inside: avoid; }
            .print-page:last-of-type { page-break-after: auto; }
          }
          ${QUOTE_AUTOFIT_CSS}
          html,body { margin:0; padding:0; background:#fff; color:#000; font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; }
        </style>
        <script>${QUOTE_AUTOFIT_SCRIPT_INLINE}</script>
      </head>
      <body>
        ${firstPageHtml + otherPagesHtml + summaryPage + approvalPage}
      </body>
      </html>`;
      return html;
    }

    const finalPagePrint = () => {
      const checklistHtml = (labels || [])
        .map((label, i) => {
          const safe = esc(label);
          return `<div style="display:flex; align-items:flex-start; gap:8px; margin:0 0 6px 0"><div style="width:14px; height:14px; border:1px solid #000; border-radius:2px; margin-top:2px"></div> <span>${safe || `Item ${i + 1}`}</span></div>`;
        })
        .join('');

      return `
        <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:12mm">
          <div class="page-inner" style="display:flex; flex-direction:column; min-height:273mm; padding-top:8px">
            <div style="font-weight:700; margin-bottom:6px; font-size:12pt">Notes</div>
            <textarea id="clientNotes" placeholder="Notes, requested changes, questions, or preferences..." style="width:100%; height:52mm; border:2px solid #f00; border-radius:4px; padding:10px; font: 11pt system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; box-sizing:border-box; resize:vertical"></textarea>

            <div style="font-weight:700; margin-top:14px; margin-bottom:6px; font-size:12pt">Checklist</div>
            <div style="border:2px solid #f00; border-radius:4px; padding:10px; font-size:11pt; line-height:1.35">
              <div style="columns:2; column-gap:16px">${checklistHtml || '<div style="color:#666">No items listed.</div>'}</div>
            </div>

            <div style="margin-top:auto">
              <div style="font-weight:700; margin-top:14px; margin-bottom:6px; font-size:12pt">Terms and Conditions</div>
              <div style="border:2px solid #f00; border-radius:4px; padding:12px; font-size:11pt; line-height:1.45">
                <ul style="padding-left:1.1rem; margin:0">
                  <li style="margin-bottom:6px"><b>Quote Validity & Availability:</b> Pricing is provided as of the date issued and may change prior to purchase.</li>
                  <li style="margin-bottom:6px"><b>Warranty & Exclusions:</b> 90-day limited hardware warranty for defects under normal use; exclusions include physical/impact damage, liquid exposure, unauthorized repairs/modifications, abuse/neglect, loss/theft, and third-party accessories.</li>
                  <li style="margin-bottom:6px"><b>Data & Software:</b> Client is responsible for backups and licensing. Service may require updates/reinstall/reset; we are not responsible for data loss.</li>
                  <li style="margin-bottom:6px"><b>Deposits & Special Orders:</b> Deposits may be required to order parts/products. Special-order items may be non-returnable and subject to supplier restocking policies.</li>
                  <li style="margin-bottom:6px"><b>Returns & Cancellations:</b> Returns/cancellations are subject to manufacturer/vendor policies and may incur restocking/processing fees. Labor and time spent is non-refundable.</li>
                  <li style="margin-bottom:6px"><b>Taxes & Fees:</b> Sales tax and applicable fees may apply at checkout; printed totals may be shown before tax.</li>
                  <li style="margin-bottom:0"><b>Limitation of Liability:</b> Liability is limited to amounts paid; incidental or consequential damages are excluded where permitted by law.</li>
                </ul>
              </div>

              <div style="margin-top:16px">
                <div id="sigSection" style="display:flex; gap:24px; align-items:flex-start; break-inside: avoid; page-break-inside: avoid">
                  <div style="flex:1">
                    <div style="display:flex; align-items:center; gap:10px">
                      <div style="font-weight:400; font-size:12pt; white-space:nowrap">Signature</div>
                      <div style="border-bottom:2px solid #000; height:24px; flex:1"></div>
                    </div>
                  </div>
                  <div style="width:220px">
                    <div style="display:flex; align-items:center; gap:10px">
                      <div style="font-weight:400; font-size:12pt; white-space:nowrap">Date</div>
                      <div id="dateBox" style="border-bottom:2px solid #000; height:24px; flex:1"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>`;
    };

    const specRows = (item: SaleItem) => {
      const rows: Array<[string, string]> = [];

      const asPrintableText = (x: any): string => {
        if (x == null) return '';
        if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return String(x);
        if (Array.isArray(x)) {
          const parts = x
            .map((y) => (typeof y === 'string' || typeof y === 'number' || typeof y === 'boolean') ? String(y) : '')
            .map((s) => s.trim())
            .filter(Boolean);
          return parts.join(', ');
        }
        if (typeof x === 'object') {
          // Common shapes from select/combobox components
          const v = (x as any).value;
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
          const l = (x as any).label;
          if (typeof l === 'string' || typeof l === 'number' || typeof l === 'boolean') return String(l);
          const t = (x as any).text;
          if (typeof t === 'string' || typeof t === 'number' || typeof t === 'boolean') return String(t);
          return '';
        }
        return '';
      };

      if (item.deviceType) rows.push(['Device Type', item.deviceType]);
      const appleFamily = (item.dynamic || ({} as any)).device as string | undefined;
      if (appleFamily) rows.push(['Apple Family', appleFamily]);
      if (item.model) rows.push(['Model', item.model]);
      if (item.condition) rows.push(['Condition', item.condition]);
      if (item.accessories) rows.push(['Accessories', item.accessories]);
      Object.entries(item.dynamic || {}).forEach(([k, v]) => {
        if (k === 'device') return;

        // 'Other' / 'Drone' ad-hoc spec rows are arrays of {desc,value}.
        if ((k === 'otherSpecs' || k === 'droneSpecs') && Array.isArray(v)) {
          (v as any[]).forEach((s: any, i: number) => {
            const rawDesc = s?.desc ?? s?.description ?? s?.name;
            const rawVal = s?.value ?? s?.val;
            const desc = asPrintableText(rawDesc == null ? '' : rawDesc).trim();
            const val = asPrintableText(rawVal == null ? '' : rawVal).trim();
            if (!desc && !val) return;
            rows.push([desc || `Spec ${i + 1}`, val]);
          });
          return;
        }

        if (Array.isArray(v)) {
          const primitiveList = (v as any[])
            .map((x) => asPrintableText(x))
            .map((s) => s.trim())
            .filter(Boolean);
          rows.push([k, primitiveList.length ? primitiveList.join(', ') : `${v.length} item(s)`]);
          return;
        }

        if (v && typeof v === 'object') {
          // Avoid printing "[object Object]" into customer-facing printouts, but
          // allow common select/combobox shapes (value/label/text).
          const t = asPrintableText(v).trim();
          if (t) rows.push([k, t]);
          return;
        }

        rows.push([k, asPrintableText(v)]);
      });
      const titleCase = (s: string) => s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map((w) => {
          const up = w.toUpperCase();
          if (w.length <= 3 && w === up) return up;
          return w.charAt(0).toUpperCase() + w.slice(1);
        })
        .join(' ');
      return rows.map(([k, v]) => `<tr><td style="border:1px solid #f00; padding:6px 14px; font-weight:600; white-space:nowrap">${esc(titleCase(k))}</td><td style="border:1px solid #f00; padding:6px 14px">${esc(v)}</td></tr>`).join('');
    };

    function devicePage(item: SaleItem, title: string, standalone: boolean = true) {
      const base = Number(item.price || 0);
      // Price is already the customer-facing total (before tax). Do not apply any additional multiplier here.
      const shown = Number.isFinite(base) && base > 0 ? base : null;
      const hasSpecs = !!(
        (item.dynamic && Object.keys(item.dynamic || {}).length > 0) ||
        item.deviceType || (item.dynamic && (item.dynamic as any).device) || item.model || item.condition || item.accessories
      );
      const images = (item.images || []).slice(0, 3);
  // Custom Build special layout
    if (item.deviceType === 'Custom Build') {
      // Align with Custom Build UI: use the same core parts
      const parts: Array<{ key: string; label: string }> = [
        { key: 'case', label: 'Case' },
        { key: 'motherboard', label: 'Motherboard' },
        { key: 'cpu', label: 'Processor' },
        { key: 'ram', label: 'Memory' },
        { key: 'gpu', label: 'Graphics Card' },
        { key: 'psu', label: 'PSU' },
      ];

      type PartLine = { label: string; val: string; img?: string; price: number };
      const partLines: PartLine[] = parts.map((p) => {
        const val = String((item.dynamic || ({} as any))[p.key] || '').trim();
        const img = String((item.dynamic || ({} as any))[`${p.key}Image`] || '');
        const raw = Number((item.dynamic || ({} as any))[`${p.key}Price`] || 0) || 0;
        return { label: p.label, val, img: img || undefined, price: raw * 1.05 };
      }).filter((pl) => (pl.val || pl.price || pl.img));

      const extras = Array.isArray((item.dynamic as any)?.extraParts) ? ((item.dynamic as any).extraParts as any[]) : [];
      const extraLines: PartLine[] = extras.map((e: any) => ({
        label: String(e?.name || 'Extra') || 'Extra',
        val: String(e?.desc || ''),
        img: e?.image ? String(e.image) : undefined,
        price: (Number(e?.price || 0) || 0) * 1.05,
      })).filter((pl) => (pl.label || pl.price || pl.img));

      const withImage = [...partLines, ...extraLines].filter((l) => !!l.img);
      const withoutImage = [...partLines, ...extraLines].filter((l) => !l.img);

      const lines = withImage.map((l) => `
          <tr>
            <td style=\"border:1px solid #f00; padding:8px; vertical-align:middle\">
              <div style=\"display:flex; align-items:center; gap:10px\">
                <div style=\"width:40px; height:40px; border:1px solid #e5e7eb; border-radius:4px; overflow:hidden; background:#fff\">${l.img ? `<img src=\"${l.img}\" style=\"width:100%; height:100%; object-fit:cover\"/>` : ''}</div>
                <div><div style=\"font-weight:600\">${esc(l.label)}</div><div>${esc(l.val || '-') }</div></div>
              </div>
            </td>
            <td style=\"border:1px solid #f00; padding:8px; text-align:right; white-space:nowrap\">$${(l.price || 0).toFixed(2)}</td>
          </tr>`).join('');

      const labor = Number((item.dynamic || ({} as any)).buildLabor || 0) || 0;
      const partsSumMain = partLines.reduce((acc, p) => acc + (Number((item.dynamic || ({} as any))[`${p.label.toLowerCase()}Price`] || 0) || 0) * 1.05, 0);
      // Recompute from original dynamic keys to avoid label mismatch
      const partsSumFromKeys = parts.reduce((acc, p) => acc + ((Number((item.dynamic || ({} as any))[`${p.key}Price`] || 0) || 0) * 1.05), 0);
      const partsSumExtras = extras.reduce((acc, e) => acc + ((Number(e?.price || 0) || 0) * 1.05), 0);
      const partsSum = partsSumFromKeys + partsSumExtras;
      const total = partsSum + labor;
      const innerCB = `
        <div class=\"text-base\" style=\"text-align:center; font-weight:600; margin-bottom:8px\">${esc(title || 'Custom Build')}</div>
        ${images.length ? `
          <div style=\"margin-bottom:10px; display:flex; gap:12px; flex-wrap:wrap; justify-content:center; align-items:center\">
            ${images.map((src) => `<img src=\"${src}\" style=\"max-height:55mm; max-width:55mm; object-fit:contain; border:1px solid #e5e7eb; border-radius:4px; padding:2px\" />`).join('')}
          </div>` : ''}
        <div style=\"border:2px solid #f00; border-radius:4px; padding:10px\">
          <div style=\"font-weight:700; margin-bottom:6px; text-align:center\">Build Components</div>
          <table style=\"border-collapse:collapse; width:100%\">
            <thead>
              <tr><th style=\"border:1px solid #f00; padding:6px; text-align:left\">Part</th><th style=\"border:1px solid #f00; padding:6px; text-align:right\">Price</th></tr>
            </thead>
            <tbody>
              ${lines || `<tr><td colspan=2 style='border:1px solid #f00; padding:8px; color:#666'>No image-based parts listed.</td></tr>`}
            </tbody>
            <tfoot>
              <tr><td style=\"border:1px solid #f00; padding:6px; text-align:right\">Build Labor</td><td style=\"border:1px solid #f00; padding:6px; text-align:right; font-weight:600\">$${labor.toFixed(2)}</td></tr>
              <tr><td style=\"border:1px solid #f00; padding:6px; text-align:right; font-weight:700\">Total (before tax)</td><td style=\"border:1px solid #f00; padding:6px; text-align:right; font-weight:700\">$${total.toFixed(2)}</td></tr>
            </tfoot>
          </table>
        </div>
        ${withoutImage.length ? `
        <div style=\"border:2px solid #f00; border-radius:4px; padding:10px; margin-top:10px\">
          <div style=\"font-weight:700; margin-bottom:6px; text-align:center\">Additional Specs (no image)</div>
          <ul style=\"margin:0; padding-left:1rem; line-height:1.4\">
            ${withoutImage.map((l) => `<li><b>${esc(l.label)}:</b> ${esc(l.val || '-')}${Number.isFinite(l.price) ? '' : ''}</li>`).join('')}
          </ul>
        </div>` : ''}`;
      // separate per-part image pages when standalone
      const imageEntries: Array<{ label: string; src: string }> = [
        { key: 'case', label: 'Case' },
        { key: 'motherboard', label: 'Motherboard' },
        { key: 'cpu', label: 'Processor' },
        { key: 'ram', label: 'Memory' },
        { key: 'gpu', label: 'Graphics Card' },
        { key: 'psu', label: 'PSU' },
      ].map((p: any) => {
        const src = String((item.dynamic || ({} as any))[`${p.key}Image`] || '');
        return src ? { label: p.label, src } : null;
      }).filter(Boolean) as any[];
      const extrasImgs = (Array.isArray((item.dynamic as any)?.extraParts) ? (item.dynamic as any).extraParts : []).map((e: any) => {
        const src = String(e?.image || ''); const label = String(e?.name || 'Extra');
        return src ? { label, src } : null;
      }).filter(Boolean) as any[];
      const imagePages = [...imageEntries, ...extrasImgs].map((e) => `
        <div class=\"print-page\" style=\"width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:10mm\">
          <div class=\"page-inner\" style=\"text-align:center\">
            <div style=\"font-weight:700; font-size:14pt; margin-bottom:8px\">${esc(e.label)}</div>
            <img src=\"${e.src}\" style=\"max-width:180mm; max-height:240mm; object-fit:contain; border:1px solid #e5e7eb; border-radius:4px; padding:2px\" />
          </div>
        </div>`).join('');
      return standalone
        ? `<div class=\"print-page\" style=\"width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:10mm\"><div class=\"page-inner\">${innerCB}</div></div>`
        : innerCB;
    }
    const inner = `
          <div class=\"text-base\" style=\"text-align:center; font-weight:600; margin-bottom:8px\">${esc(title)}</div>
          <div style=\"display:grid; grid-template-columns:${images.length ? '70mm 1fr' : '1fr'}; align-items:start; column-gap:12px; width:100%\">
            ${images.length ? `
              <div style=\"display:flex; flex-direction:column; gap:10px; align-items:center\">
                ${images.map((src) => `<img src=\"${src}\" style=\"max-height:55mm; max-width:65mm; object-fit:contain; border:1px solid #e5e7eb; border-radius:4px; padding:2px\" />`).join('')}
              </div>
            ` : ''}
            <div style=\"min-width:0; display:flex; flex-direction:column; gap:12px\">
              ${hasSpecs ? `
                <div style=\"font-size:12pt; border:2px solid #f00; padding:12px 14px; border-radius:4px; width:100%; box-sizing:border-box\">
                  <div style=\"font-weight:600; margin-bottom:6px; text-align:center\">Specifications</div>
                  <table style=\"border-collapse:collapse; width:100%; table-layout:auto\"><tbody>
                    ${specRows(item)}
                  </tbody></table>
                </div>
              ` : ''}
              ${shown != null ? `
                <div style=\"text-align:right\">
                  <div style=\"display:inline-block; border:2px solid #f00; padding:10px 14px; border-radius:6px; font-size:14pt; white-space:nowrap; font-weight:800\">Total (before tax): $${shown.toFixed(2)}</div>
                </div>
              ` : ''}
            </div>
          </div>
          ${item.prompt && String(item.prompt).trim().length > 0 ? `
            <div style=\"text-align:center; font-size:13pt; line-height:1.45; max-width:180mm; margin:18px auto 0 auto; border:2px solid #f00; border-radius:4px; padding:10px 12px\">${esc(item.prompt || '')}</div>
          ` : ''}`;
      return standalone
        ? `<div class=\"print-page\" style=\"width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:10mm\"><div class=\"page-inner\">${inner}</div></div>`
        : inner;
    }
    

    

          // Build document body
          const pages: string[] = [];
          // Page 1 header + first device (with header content at top)
          pages.push(`
            <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:12mm">
              <div class="page-inner">
              <div style="display:flex; gap:12px; align-items:flex-start; margin-bottom:8px">
                <img src="${escAttr(logoSrc)}" alt="GadgetBoy" style="height:35mm; width:auto" />
                <div style="line-height:1.2; flex:1">
                  <div style="font-size:20pt; font-weight:700; letter-spacing:0.2px">Gadgetboy Quote</div>
                  <div style="font-size:13pt; font-weight:700">GADGETBOY Repair & Retail</div>
                  <div style="font-size:12pt">2822 Devine Street, Columbia, SC 29205</div>
                  <div style="font-size:12pt">(803) 708-0101 | gadgetboysc@gmail.com</div>
                  <div style="margin-top:8px; font-size:12pt"><b>Customer:</b> ${esc(cust || '-')} | <b>Phone:</b> ${esc(phone)}${email ? ` | <b>Email:</b> ${esc(email)}` : ''}</div>
                  <div style="font-size:12pt; color:#666">Generated: ${esc(now)}</div>
                </div>
              </div>
              ${first ? devicePage(first, firstTitle, false) : ''}
              </div>
            </div>
          `);
          // Additional device pages
          sales.items.slice(1).forEach((item, idx) => {
            const model = String(((item.model ?? (item as any).dynamic?.model) || '')).trim();
            const title = model ? [item.brand, model].filter(Boolean).join(' ').trim() : `Device ${idx + 2}`;
            pages.push(devicePage(item, title, true));
          });
          // If first is Custom Build, append per-part image pages after page 1 and a final breakdown page
          if (first && first.deviceType === 'Custom Build') {
            const imageEntries: Array<{ label: string; src: string }> = [
              { key: 'case', label: 'Case' },
              { key: 'motherboard', label: 'Motherboard' },
              { key: 'cpu', label: 'Processor' },
              { key: 'ram', label: 'Memory' },
              { key: 'gpu', label: 'Graphics Card' },
              { key: 'psu', label: 'PSU' },
            ].map((p: any) => {
              const src = String((first.dynamic || ({} as any))[`${p.key}Image`] || '');
              return src ? { label: p.label, src } : null;
            }).filter(Boolean) as any[];
            const extrasImgs = (Array.isArray((first.dynamic as any)?.extraParts) ? (first.dynamic as any).extraParts : []).map((e: any) => {
              const src = String(e?.image || ''); const label = String(e?.name || 'Extra');
              return src ? { label, src } : null;
            }).filter(Boolean) as any[];
            const imagePages = [...imageEntries, ...extrasImgs].map((e) => `
              <div class=\"print-page\" style=\"width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:10mm\">
                <div class=\"page-inner\" style=\"text-align:center\">
                  <div style=\"font-weight:700; font-size:14pt; margin-bottom:8px\">${esc(e.label)}</div>
                  <img src=\"${e.src}\" style=\"max-width:180mm; max-height:240mm; object-fit:contain; border:1px solid #e5e7eb; border-radius:4px; padding:2px\" />
                </div>
              </div>`).join('');
            pages.push(imagePages);

            // Final breakdown page for Custom Build (cost summary + terms + signature)
            const cbParts: Array<{ key: string; label: string }> = [
              { key: 'case', label: 'Case' },
              { key: 'motherboard', label: 'Motherboard' },
              { key: 'cpu', label: 'Processor' },
              { key: 'ram', label: 'Memory' },
              { key: 'gpu', label: 'Graphics Card' },
              { key: 'psu', label: 'PSU' },
            ];
            const cbExtras = Array.isArray((first.dynamic as any)?.extraParts) ? ((first.dynamic as any).extraParts as any[]) : [];
            const cbLabor = Number((first.dynamic || ({} as any)).buildLabor || 0) || 0;
            const cbLines = cbParts.map((p) => {
              const name = p.label;
              const desc = String((first.dynamic || ({} as any))[p.key] || '');
              const raw = Number((first.dynamic || ({} as any))[`${p.key}Price`] || 0) || 0;
              const price = raw * 1.05;
              if (!desc && !raw) return '';
              return `<tr><td class=\"border p-2\"><b>${esc(name)}</b>${desc ? ` - ${esc(desc)}` : ''}</td><td class=\"border p-2\" style=\"text-align:right\">$${price.toFixed(2)}</td></tr>`;
            }).join('');
            const cbExtraLines = cbExtras.map((e: any) => {
              const name = String(e?.name || 'Extra');
              const desc = String(e?.desc || '');
              const raw = Number(e?.price || 0) || 0; const price = raw * 1.05;
              if (!name && !raw) return '';
              return `<tr><td class=\"border p-2\"><b>${esc(name)}</b>${desc ? ` - ${esc(desc)}` : ''}</td><td class=\"border p-2\" style=\"text-align:right\">$${price.toFixed(2)}</td></tr>`;
            }).join('');
            const cbPartsSum = cbParts.reduce((acc, p) => acc + ((Number((first.dynamic || ({} as any))[`${p.key}Price`] || 0) || 0) * 1.05), 0) + cbExtras.reduce((acc, e) => acc + ((Number(e?.price || 0) || 0) * 1.05), 0);
            const cbTotal = cbPartsSum + cbLabor;
            const breakdownPage = `
              <div class=\"print-page\" style=\"width:210mm; min-height:297mm; margin:0 auto; border:3px solid #f00; border-radius:8px; padding:12mm\">
                <div class=\"page-inner\">
                  <div style=\"font-weight:700; margin-bottom:6px; font-size:13pt\">Cost Breakdown</div>
                  <style>.border{border:1px solid #000}.p-2{padding:8px} table{border-collapse:collapse; width:100%}</style>
                  <table>
                    <thead><tr><th class=\"border p-2\" style=\"text-align:left\">Component</th><th class=\"border p-2\" style=\"text-align:right\">Price</th></tr></thead>
                    <tbody>${cbLines}${cbExtraLines || ''}</tbody>
                    <tfoot>
                      <tr><td class=\"border p-2\" style=\"text-align:right; font-weight:600\">Build Labor</td><td class=\"border p-2\" style=\"text-align:right; font-weight:600\">$${cbLabor.toFixed(2)}</td></tr>
                      <tr><td class=\"border p-2\" style=\"text-align:right; font-weight:700\">Total (before tax)</td><td class=\"border p-2\" style=\"text-align:right; font-weight:700\">$${cbTotal.toFixed(2)}</td></tr>
                    </tfoot>
                  </table>
                  <div style="font-weight:700; margin-top:16px; margin-bottom:6px; font-size:13pt">Terms and Conditions</div>
                  <div style="border:2px solid #f00; border-radius:4px; padding:12px; font-size:12pt; line-height:1.45">
                    <p style="margin:0 0 8px">By signing, the client agrees to the following:</p>
                    <ul style="padding-left:1.1rem; margin:0">
                        <li style="margin-bottom:6px"><b>Quote Validity, Price Changes & Availability:</b> Prices are provided as of the date issued, are subject to availability and vendor/distributor price changes, and may change prior to purchase. Any substitutions must be approved by the client. Special orders may require a deposit and may be non-returnable.</li>
                        <li style="margin-bottom:6px"><b>Warranty & Client-Caused Damage:</b> 90-day limited hardware warranty for defects under normal use; exclusions apply including physical/impact damage, liquid exposure, misuse/accidents, and unauthorized modifications. Damage occurring after delivery/pickup is the client’s responsibility and is not covered.</li>
                      <li style="margin-bottom:6px"><b>Data & Software:</b> Client responsible for backups and licensing; we are not liable for data loss.</li>
                      <li style="margin-bottom:6px"><b>Liability:</b> Liability limited to amount paid; incidental or consequential damages are excluded.</li>
                    </ul>
                  </div>
                  <div id=\"sigSection\" style=\"display:flex; gap:24px; align-items:flex-start; margin-top:24px\">
                    <div style=\"flex:1\">
                      <div id=\"sigBox\" style=\"min-height:96px; border-bottom:2px solid #000\"></div>
                    </div>
                    <div style=\"width:220px\">
                      <div id=\"dateBox\" style=\"border-bottom:2px solid #000; min-height:24px; margin-bottom:4px\"></div>
                    </div>
                  </div>
                </div>
              </div>`;
            pages.push(breakdownPage);
          }
          // Final page for all non-custom-build device quotes
          if (!(first && first.deviceType === 'Custom Build')) {
            pages.push(finalPagePrint());
          }

          const html = `<!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Gadgetboy Quote</title>
        <base href="${(typeof window !== 'undefined' && (window as any).location) ? ((window as any).location.origin + '/') : '/'}">
        <style>
          @media print {
            @page { size: A4; margin: 0; }
            .print-page { page-break-after: always; page-break-inside: avoid; break-inside: avoid; }
            .print-page:last-of-type { page-break-after: auto; }
            .no-print { display:none !important; }
          }
          ${QUOTE_AUTOFIT_CSS}
          html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; }
          .page-inner { transform-origin: top center; }
        </style>
        <script>${QUOTE_AUTOFIT_SCRIPT_INLINE}</script>
        </head>
      <body>
        ${pages.join('\n')}
      </body>
      </html>`;
    return html;
  }

  // Build a simple print HTML for Repairs quotes.
  function buildRepairsPrintHtml(logoDataUrl?: string) {
    const esc = (s: string) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
    const escAttr = (s: string) => esc(String(s || '')).replace(/"/g, '&quot;');
    const logoSrc = logoDataUrl || publicAsset('logo-spin.gif');
    const rows = (repairs.lines || []).map((ln) => {
      const pp = Number(ln.partPrice || 0);
      const lp = Number(ln.laborPrice || 0);
      return `<tr><td class="border p-2">${esc(ln.description || '')}</td><td class="border p-2" style="text-align:right">$${pp.toFixed(2)}</td><td class="border p-2" style="text-align:right">$${lp.toFixed(2)}</td><td class="border p-2" style="text-align:right">$${(pp+lp).toFixed(2)}</td></tr>`;
    }).join('');
  const html = `<!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gadgetboy Repairs Quote</title>
  <base href="${(typeof window !== 'undefined' && (window as any).location) ? ((window as any).location.origin + '/') : '/'}">
      <style>
        @media print {
          @page { size: A4; margin: 0; }
          .print-page { page-break-after: auto; }
        }
        ${QUOTE_AUTOFIT_CSS}
        html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; }
        .border { border: 1px solid #000; }
        .p-2 { padding: 8px; }
        table { border-collapse: collapse; width: 100%; }
      </style>
      <script>${QUOTE_AUTOFIT_SCRIPT_INLINE}</script>
    </head>
    <body>
      <div class="print-page" style="width:210mm; min-height:297mm; margin:0 auto; padding:12mm;">
        <div class="page-inner">
        <div style="display:flex; gap:12px; align-items:flex-start; margin-bottom:8px">
          <img src="${escAttr(logoSrc)}" alt="GadgetBoy" style="height:35mm; width:auto" />
          <div style="line-height:1.2; flex:1">
            <div style="font-size:20pt; font-weight:700; letter-spacing:0.2px">Gadgetboy Repairs Quote</div>
            <div style="font-size:13pt; font-weight:700">GADGETBOY Repair & Retail</div>
            <div style="font-size:12pt">2822 Devine Street, Columbia, SC 29205</div>
            <div style="font-size:12pt">(803) 708-0101 | gadgetboysc@gmail.com</div>
            <div style="margin-top:8px; font-size:12pt"><b>Customer:</b> ${esc(repairs.customerName || '-')} | <b>Phone:</b> ${esc(formatPhone(String(repairs.customerPhone || '')) || String(repairs.customerPhone || ''))}${repairs.customerEmail ? ` | <b>Email:</b> ${esc(repairs.customerEmail)}` : ''}</div>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th class="border p-2" style="text-align:left">Description</th>
              <th class="border p-2" style="text-align:right">Parts</th>
              <th class="border p-2" style="text-align:right">Labor</th>
              <th class="border p-2" style="text-align:right">Line</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
          <tfoot>
            <tr>
              <td class="border p-2" colspan="3" style="text-align:right; font-weight:600">Total</td>
              <td class="border p-2" style="text-align:right; font-weight:700">$${repairTotals.total.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
        ${repairs.notes ? `<div style="margin-top:12px; font-size:12pt"><b>Notes:</b> ${esc(repairs.notes)}</div>` : ''}
        </div>
      </div>
    </body>
    </html>`;
    return html;
  }

  // Print using a dedicated HTML document with auto-print
  async function printDocument() {
    const logoDataUrl = await tryGetLogoDataUrl();
    const html = mode === 'sales' ? buildSalesPrintHtml(logoDataUrl) : buildRepairsPrintHtml(logoDataUrl);
    // Use a hidden iframe to trigger the OS print dialog without opening a new visible window
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) { document.body.removeChild(iframe); return; }
    doc.open();
    doc.write(html);
    doc.close();
    const fitAndPrint = () => {
      const win = iframe.contentWindow;
      if (!win) return;
      try {
        try {
          // Prefer the shared fitter embedded in the HTML (also used for saved HTML + PDF generation).
          (win as any).__gbFitQuotePages?.();
        } catch {}
        win.focus();
        win.print();
      } finally {
        setTimeout(() => {
          try { document.body.removeChild(iframe); } catch {}
          setShowPreview(false);
        }, 100);
      }
    };
    // Wait for images and fonts to be ready before printing
    const onLoaded = () => {
      const win = iframe.contentWindow;
      if (!win) { setTimeout(fitAndPrint, 150); return; }
      try {
        const imgs = Array.from(win.document.images || []);
        if (imgs.length === 0) { setTimeout(fitAndPrint, 50); return; }
        let pending = 0;
        imgs.forEach((img: HTMLImageElement) => {
          if (!img.complete) pending++;
        });
        if (pending === 0) { setTimeout(fitAndPrint, 50); return; }
        const done = () => { pending--; if (pending <= 0) setTimeout(fitAndPrint, 50); };
        imgs.forEach((img: HTMLImageElement) => {
          if (img.complete) return;
          img.addEventListener('load', done, { once: true } as any);
          img.addEventListener('error', done, { once: true } as any);
        });
        // Fallback timeout so we don't hang if some resources never load
        setTimeout(() => { if (pending > 0) setTimeout(fitAndPrint, 50); }, 2500);
      } catch {
        setTimeout(fitAndPrint, 200);
      }
    };
    if (doc.readyState === 'complete') onLoaded(); else iframe.onload = onLoaded;
  }

  // Format createdAt timestamps in Saved Quotes
  function fmtWhen(iso?: string) {
    if (!iso) return '';
    try { const d = new Date(iso); return d.toLocaleString(); } catch { return String(iso); }
  }

  // Saved Quotes modal: load and delete
  async function openSavedQuotes() {
    try {
      const list = await (window as any).api.dbGet('quotes');
      const arr = Array.isArray(list) ? list : [];
      // This window is sales-only: only show 'sales' (or missing type treated as sales)
      const filtered = arr.filter((q: any) => (q?.type ?? 'sales') === 'sales');
      // Sort newest first by meaningful edit timestamp.
      filtered.sort((a: any, b: any) => {
        const ta = new Date(getQuoteActivityIso(a) || 0).getTime();
        const tb = new Date(getQuoteActivityIso(b) || 0).getTime();
        return tb - ta;
      });
      setQuotes(filtered);
    } catch {
      setQuotes([]);
    }
  }

  // Load saved quotes once on mount
  useEffect(() => {
    openSavedQuotes();
  }, []);

  useEffect(() => {
    const api = (window as any).api;
    if (typeof api?.onQuotesChanged !== 'function') return;
    return api.onQuotesChanged(() => {
      openSavedQuotes();
    });
  }, []);

  const groupedQuotes = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const quote of quotes || []) {
      const key = getQuoteMonthKey(quote);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(quote);
    }
    return Array.from(groups.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, items]) => ({ key, label: formatQuoteMonthLabel(key), items }));
  }, [quotes]);

  useEffect(() => {
    setExpandedQuoteMonths((prev) => {
      const next = { ...prev };
      let changed = false;
      groupedQuotes.forEach((group, index) => {
        if (typeof next[group.key] === 'undefined') {
          next[group.key] = index === 0;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [groupedQuotes]);

  async function deleteSavedQuote(q: any) {
    try {
      if (q?.id == null) return;
      const ok = await (window as any).api.dbDelete('quotes', q.id);
      if (ok) {
        setQuotes((prev) => prev.filter((x) => x.id !== q.id));
        setSaveMsg(`Deleted quote #${q.id}`);
        setTimeout(() => setSaveMsg(null), 1800);
      }
    } catch {}
  }

  const repairCategories: any[] = [];
  const repairCatalog: any[] = [];

  function addSaleItem() {
    setSales((s) => ({ ...s, items: [...s.items, { expanded: true, dynamic: {}, images: [] }] }));
  }
  function removeSaleItem(idx: number) {
    setSales((s) => ({ ...s, items: s.items.filter((_, i) => i !== idx) }));
    if (createSaleSelecting) {
      setCreateSaleSelected((prev) => {
        const next: Record<number, boolean> = {};
        for (const [k, v] of Object.entries(prev || {})) {
          if (!v) continue;
          const i = Number(k);
          if (!Number.isFinite(i)) continue;
          if (i < idx) next[i] = true;
          else if (i > idx) next[i - 1] = true;
        }
        return next;
      });
    }
  }
  function toggleSaleItemExpanded(idx: number) {
    setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, expanded: !x.expanded } : x)) }));
  }
  async function addImagesToItem(idx: number, fileList: FileList | null) {
    if (!fileList) return;
    const files = Array.from(fileList);
    setSales((current) => {
      const cur = (current.items[idx] || {}) as SaleItem;
      const room = 3 - (cur.images?.length || 0);
      const pick = files.slice(0, Math.max(0, room));
      const readers = pick.map(
        (f) =>
          new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(f);
          })
      );
      Promise.all(readers)
        .then((dataUrls) => {
          setSales((prev) => ({
            ...prev,
            items: prev.items.map((x, i) => (i === idx ? { ...x, images: [...(x.images || []), ...dataUrls].slice(0, 3) } : x)),
          }));
        })
        .catch(() => {});
      return current;
    });
  }
  function removeImageFromItem(idx: number, imageIdx: number) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => (i === idx ? { ...x, images: (x.images || []).filter((_, j) => j !== imageIdx) } : x)),
    }));
  }

  function formatStorageSummary(dyn: any): string {
    try {
      const parts: string[] = [];
      const fmtDrive = (typeVal: any, sizeVal: any, specsVal?: any) => {
        const type = String(typeVal || '').trim();
        const size = String(sizeVal || '').trim();
        const specs = String(specsVal || '').trim();

        // Avoid printing placeholder rows (e.g., type chosen but no size/specs)
        if (!size && !specs) return '';

        const base = [type, size].filter(Boolean).join(' ').trim();
        if (!base && !specs) return '';
        if (!base) return specs;
        return specs ? `${base} (${specs})` : base;
      };

      const primary = fmtDrive(dyn.storageType || dyn.bootDriveType, dyn.storageSize || dyn.bootDriveStorage, dyn.storageSpecs || dyn.bootDriveSpecs);
      if (primary) parts.push(primary);

      const secondaryList = Array.isArray(dyn.pcSecondaryStorage) ? dyn.pcSecondaryStorage : [];
      const secondaryFromList = secondaryList
        .filter((d: any) => {
          const type = String(d?.type || '').trim();
          const size = String(d?.size || '').trim();
          const specs = String(d?.specs || '').trim();
          // Type alone is not considered “entered”
          return Boolean(size || (type && specs));
        })
        .map((d: any) => fmtDrive(d?.type, d?.size, d?.specs))
        .filter(Boolean);

      if (secondaryFromList.length) {
        parts.push(...secondaryFromList);
      } else {
        const legacySecond = fmtDrive(dyn.secondaryStorage1Type, dyn.secondaryStorage1Storage, dyn.secondaryStorage1Specs);
        if (legacySecond) parts.push(legacySecond);
      }

      return parts.filter(Boolean).join(' + ');
    } catch {
      return '';
    }
  }

  function formatPrimaryStorageSummary(dyn: any): string {
    try {
      const type = String(dyn.storageType || dyn.bootDriveType || '').trim();
      const size = String(dyn.storageSize || dyn.bootDriveStorage || '').trim();
      const specs = String(dyn.storageSpecs || dyn.bootDriveSpecs || '').trim();

      // Avoid printing placeholder rows
      if (!size && !specs) return '';

      const base = [type, size].filter(Boolean).join(' ').trim();
      if (!base && !specs) return '';
      if (!base) return specs;
      return specs ? `${base} (${specs})` : base;
    } catch {
      return '';
    }
  }

  // Custom Build / Custom PC category images: support up to 2 images (Image + Image2)
  async function addImageForPart(idx: number, partKey: string, fileList: FileList | null, which?: 1 | 2) {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    const dataUrl: string = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const dyn = { ...(x.dynamic || {}) } as any;
        const k1 = `${partKey}Image`;
        const k2 = `${partKey}Image2`;
        const cur1 = String(dyn[k1] || '').trim();
        const cur2 = String(dyn[k2] || '').trim();
        const target: 1 | 2 = which || (!cur1 ? 1 : (!cur2 ? 2 : 2));
        if (target === 1) dyn[k1] = dataUrl;
        else dyn[k2] = dataUrl;
        dyn[`${partKey}Images`] = [dyn[k1], dyn[k2]].filter(Boolean);
        return { ...x, dynamic: dyn };
      }),
    }));
  }
  function removeImageForPart(idx: number, partKey: string, which?: 1 | 2) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const dyn = { ...(x.dynamic || {}) } as any;
        const k1 = `${partKey}Image`;
        const k2 = `${partKey}Image2`;
        if (!which) {
          delete dyn[k1];
          delete dyn[k2];
          delete dyn[`${partKey}Images`];
          return { ...x, dynamic: dyn };
        }
        if (which === 1) delete dyn[k1];
        if (which === 2) delete dyn[k2];
        dyn[`${partKey}Images`] = [dyn[k1], dyn[k2]].filter(Boolean);
        if (!(dyn[`${partKey}Images`] || []).length) delete dyn[`${partKey}Images`];
        return { ...x, dynamic: dyn };
      }),
    }));
  }

  // Custom PC: Secondary storage drives helpers (array of {type,size,specs,image,image2})
  async function addImageForPcSecondaryStorage(idx: number, driveIdx: number, fileList: FileList | null, which?: 1 | 2) {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    const dataUrl: string = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const dyn = { ...(x.dynamic || {}) } as any;
        const list = Array.isArray(dyn.pcSecondaryStorage) ? [ ...dyn.pcSecondaryStorage ] : [];
        const cur = { ...(list[driveIdx] || {}) };
        const cur1 = String(cur.image || '').trim();
        const cur2 = String(cur.image2 || '').trim();
        const target: 1 | 2 = which || (!cur1 ? 1 : (!cur2 ? 2 : 2));
        if (target === 2) cur.image2 = dataUrl;
        else cur.image = dataUrl;
        list[driveIdx] = cur;
        dyn.pcSecondaryStorage = list;
        // Legacy sync for first secondary drive
        if (driveIdx === 0) {
          dyn.secondaryStorage1Type = String(list[0]?.type || '');
          dyn.secondaryStorage1Storage = String(list[0]?.size || '');
        }
        return { ...x, dynamic: dyn };
      })
    }));
  }
  function removeImageForPcSecondaryStorage(idx: number, driveIdx: number, which?: 1 | 2) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const dyn = { ...(x.dynamic || {}) } as any;
        const list = Array.isArray(dyn.pcSecondaryStorage) ? [ ...dyn.pcSecondaryStorage ] : [];
        if (list[driveIdx]) {
          if (!which) {
            delete (list[driveIdx] as any).image;
            delete (list[driveIdx] as any).image2;
          } else if (which === 1) {
            delete (list[driveIdx] as any).image;
          } else {
            delete (list[driveIdx] as any).image2;
          }
        }
        dyn.pcSecondaryStorage = list;
        return { ...x, dynamic: dyn };
      })
    }));
  }

  // Custom PC: Extras helpers (array of items with optional image, desc, price)
  async function addImageForPcExtra(idx: number, extraIdx: number, fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    const dataUrl: string = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.pcExtras) ? [ ...(x.dynamic as any).pcExtras ] : [];
        list[extraIdx] = { ...(list[extraIdx] || {}), image: dataUrl };
        return { ...x, dynamic: { ...(x.dynamic || {}), pcExtras: list } };
      })
    }));
  }
  function removeImageForPcExtra(idx: number, extraIdx: number) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.pcExtras) ? [ ...(x.dynamic as any).pcExtras ] : [];
        if (list[extraIdx]) delete (list[extraIdx] as any).image;
        return { ...x, dynamic: { ...(x.dynamic || {}), pcExtras: list } };
      })
    }));
  }
  function addPcExtra(idx: number) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.pcExtras) ? [ ...(x.dynamic as any).pcExtras ] : [];
        list.push({ desc: '', price: '' });
        return { ...x, dynamic: { ...(x.dynamic || {}), pcExtras: list } };
      })
    }));
  }
  function removePcExtra(idx: number, extraIdx: number) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.pcExtras) ? [ ...(x.dynamic as any).pcExtras ] : [];
        list.splice(extraIdx, 1);
        return { ...x, dynamic: { ...(x.dynamic || {}), pcExtras: list } };
      })
    }));
  }

  // Helpers for 'Other' device type: dynamic spec lines (type/description)
  function addOtherSpec(idx: number) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.otherSpecs) ? [ ...(x.dynamic as any).otherSpecs ] : [];
        list.push({ desc: '', value: '' });
        return { ...x, dynamic: { ...(x.dynamic || {}), otherSpecs: list } };
      })
    }));
  }
  function removeOtherSpec(idx: number, specIdx: number) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.otherSpecs) ? [ ...(x.dynamic as any).otherSpecs ] : [];
        list.splice(specIdx, 1);
        return { ...x, dynamic: { ...(x.dynamic || {}), otherSpecs: list } };
      })
    }));
  }
  function updateOtherSpecField(idx: number, specIdx: number, field: 'desc' | 'value', value: string) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.otherSpecs) ? [ ...(x.dynamic as any).otherSpecs ] : [];
        list[specIdx] = { ...(list[specIdx] || {}), [field]: value };
        return { ...x, dynamic: { ...(x.dynamic || {}), otherSpecs: list } };
      })
    }));
  }

  // Drone: allow ad-hoc spec rows (description/value) similar to 'Other'
  function addDroneSpec(idx: number) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.droneSpecs) ? [ ...(x.dynamic as any).droneSpecs ] : [];
        list.push({ desc: '', value: '' });
        return { ...x, dynamic: { ...(x.dynamic || {}), droneSpecs: list } };
      })
    }));
  }
  function removeDroneSpec(idx: number, specIdx: number) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.droneSpecs) ? [ ...(x.dynamic as any).droneSpecs ] : [];
        list.splice(specIdx, 1);
        return { ...x, dynamic: { ...(x.dynamic || {}), droneSpecs: list } };
      })
    }));
  }
  function updateDroneSpecField(idx: number, specIdx: number, field: 'desc' | 'value', value: string) {
    setSales((prev) => ({
      ...prev,
      items: prev.items.map((x, i) => {
        if (i !== idx) return x;
        const list = Array.isArray((x.dynamic as any)?.droneSpecs) ? [ ...(x.dynamic as any).droneSpecs ] : [];
        list[specIdx] = { ...(list[specIdx] || {}), [field]: value };
        return { ...x, dynamic: { ...(x.dynamic || {}), droneSpecs: list } };
      })
    }));
  }

  function addRepairLine() {
    setRepairs((r) => ({ ...r, lines: [...r.lines, { description: '', partPrice: '', laborPrice: '' }] }));
  }
  function removeRepairLine(idx: number) {
    setRepairs((r) => ({ ...r, lines: r.lines.filter((_, i) => i !== idx) }));
  }
  function addSelectedRepairLine() {
    const rep = repairCatalog.find((r) => r.id === repairs.selectedRepairId);
    if (!rep) return;
    setRepairs((r) => ({ ...r, lines: [...r.lines, { description: rep.name, partPrice: String(rep.partCost || 0), laborPrice: String(rep.laborCost || 0) }] }));
  }

  function printPreview() {
    setShowPreview(true);
  }

  async function toggleQuotePreviewFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await quotePreviewRef.current?.requestFullscreen();
    } catch {}
  }

  async function openHtmlPreview() {
    try {
      if (mode !== 'sales') {
        setSaveMsg('HTML Preview currently available for Sales');
        setTimeout(() => setSaveMsg(null), 1800);
        return;
      }
      const html = await generateInteractiveSalesHtml();
      try { if (htmlPreviewUrl) URL.revokeObjectURL(htmlPreviewUrl); } catch {}
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      setHtmlPreviewUrl(url);
      setShowHtmlPreview(true);
    } catch (e) {
      console.error('openHtmlPreview failed', e);
      setSaveMsg('Could not open HTML Preview');
      setTimeout(() => setSaveMsg(null), 2000);
    }
  }

  function closeHtmlPreview() {
    setShowHtmlPreview(false);
    try { if (htmlPreviewUrl) URL.revokeObjectURL(htmlPreviewUrl); } catch {}
    setHtmlPreviewUrl(null);
  }

  function downloadTextFile(filename: string, content: string, mime: string) {
    try {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 250);
    } catch (e) {
      console.error('downloadTextFile failed', e);
    }
  }

  function htmlToPlainText(html: string): string {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
      const text = (doc.body?.innerText || doc.documentElement?.innerText || '').trim();
      return text;
    } catch {
      return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/[pdivtrlih\d]+>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  }

  async function sendHtmlToGmail() {
    // Keep the button label "Send to Email" but send from inside the app.
    try {
      if (mode !== 'sales') {
        setSaveMsg('HTML Preview currently available for Sales');
        setTimeout(() => setSaveMsg(null), 1800);
        return;
      }
      setEmailErr(null);
      const cfg = await window.api.emailGetConfig();
      if (cfg?.ok) {
        setEmailFromName(String(cfg.fromName || 'GadgetBoy Repair & Retail'));
        setEmailHasPassword(!!cfg.hasAppPassword);
        const savedTemplate = String(cfg.bodyTemplate || '');
        setEmailBodyTemplate(savedTemplate);
        setEmailBodyDraft(savedTemplate.trim() ? savedTemplate : getBuiltInQuoteEmailBody());
      }
      // Prefill recipient from the quote's client info if available
      if (!(emailTo || '').trim()) {
        setEmailTo(String(sales.customerEmail || '').trim());
      }

      // Default to PDF for each send (user can change per-email in the Send window)
      setQuoteEmailAttachmentMode('pdf');
      setShowEmailModal(true);
    } catch {
      setSaveMsg('Email setup unavailable');
      setTimeout(() => setSaveMsg(null), 2000);
    }
  }

  async function openEmailSettings() {
    try {
      setEmailSettingsErr(null);
      const cfg = await window.api.emailGetConfig();
      if (cfg?.ok) {
        setEmailFromName(String(cfg.fromName || 'GadgetBoy Repair & Retail'));
        setEmailHasPassword(!!cfg.hasAppPassword);
        setEmailBodyTemplate(String(cfg.bodyTemplate || ''));
      }
      setEmailAppPassword('');
      setShowEmailSettings(true);
    } catch {
      setEmailSettingsErr('Could not load email settings');
      setShowEmailSettings(true);
    }
  }

  async function saveEmailSettings() {
    try {
      setEmailSettingsErr(null);
      setEmailSettingsSaving(true);
      const name = emailFromName.trim() || 'GadgetBoy Repair & Retail';

      // If a password was provided, update both name + password.
      if (emailAppPassword.trim()) {
        const res = await window.api.emailSetGmailAppPassword(emailAppPassword.trim(), name);
        if (!res?.ok) {
          setEmailSettingsErr(String(res?.error || 'Could not save app password'));
          return;
        }
        setEmailHasPassword(true);
        setEmailAppPassword('');
      } else {
        const res = await window.api.emailSetFromName(name);
        if (!res?.ok) {
          setEmailSettingsErr(String(res?.error || 'Could not save sender name'));
          return;
        }
      }

      setSaveMsg('Email settings saved');
      setTimeout(() => setSaveMsg(null), 1800);
      setShowEmailSettings(false);
    } catch (e: any) {
      setEmailSettingsErr(String(e?.message || e || 'Could not save settings'));
    } finally {
      setEmailSettingsSaving(false);
    }
  }

  async function clearEmailPassword() {
    try {
      setEmailSettingsErr(null);
      setEmailSettingsSaving(true);
      const res = await window.api.emailClearGmailAppPassword();
      if (!res?.ok) {
        setEmailSettingsErr(String(res?.error || 'Could not clear password'));
        return;
      }
      setEmailHasPassword(false);
      setEmailAppPassword('');
      setSaveMsg('Email password cleared');
      setTimeout(() => setSaveMsg(null), 1800);
    } catch {
      setEmailSettingsErr('Could not clear password');
    } finally {
      setEmailSettingsSaving(false);
    }
  }

  async function doSendEmail() {
    try {
      if (mode !== 'sales') return;
      setEmailErr(null);
      const to = emailTo.trim();
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        setEmailErr('Enter a valid recipient email');
        return;
      }

      setEmailSending(true);
      // Password is configured only via Email Settings
      if (!emailHasPassword) {
        setEmailErr('Configure the Gmail App Password in Email Settings first');
        return;
      }

      const html = await generateInteractiveSalesHtml();
      const cust = (sales.customerName || '').trim() || 'Customer';
      const sanitize = (s: string) => String(s || '').replace(/[^a-z0-9\-\_\+]+/gi, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
      const base = `Gadgetboy-Quote-${sanitize(cust) || 'Customer'}`;
      const subject = 'Gadgetboy Quote';

      const bodyText = (emailBodyDraft || '').trim() ? emailBodyDraft : getBuiltInQuoteEmailBody();

      const sendRes = quoteEmailAttachmentMode === 'pdf'
        ? await (window as any).api.emailSendQuotePdf({ to, subject, bodyText, filename: `${base}.pdf`, html })
        : await window.api.emailSendQuoteHtml({ to, subject, bodyText, filename: `${base}.html`, html });
      if (!sendRes?.ok) {
        setEmailErr(String(sendRes?.error || 'Failed to send email'));
        return;
      }

      setShowEmailModal(false);
      setSaveMsg('Email sent');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (e: any) {
      setEmailErr(String(e?.message || e || 'Failed to send'));
    } finally {
      setEmailSending(false);
    }
  }

  async function saveQuote() {
    try {
      setSaving(true);
      setSaveMsg(null);
      const nowIso = new Date().toISOString();
      const payload = {
        ...currentQuoteRecord,
        createdAt: quoteMetaRef.current.createdAt || nowIso,
        contentUpdatedAt: nowIso,
      };
      const saved = quoteId
        ? await window.api.dbUpdate('quotes', quoteId, { ...payload, id: quoteId })
        : await window.api.dbAdd('quotes', payload);
      const idText = saved?.id != null ? ` #${saved.id}` : '';
      setSaveMsg(`Saved quote${idText}`);
      if (saved?.id != null) {
        setQuoteId(saved.id);
        quoteMetaRef.current = {
          createdAt: saved.createdAt || payload.createdAt,
          contentUpdatedAt: saved.contentUpdatedAt || payload.contentUpdatedAt,
        };
        quoteSnapshotRef.current = currentQuoteSnapshot;
      }
      // Refresh sidebar list
      openSavedQuotes();
    } catch (e: any) {
      setSaveMsg(`Failed to save: ${e?.message || e}`);
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 4000);
    }
  }

  // Autosave quote after 2s of inactivity
  useAutosave(currentQuoteSnapshot, async (currentSnapshot) => {
    const hasSalesData = !!(sales.customerName || sales.customerPhone || sales.customerEmail || (sales.items && sales.items.length));
    const hasRepairsData = !!(repairs.customerName || repairs.customerPhone || repairs.customerEmail || (repairs.lines && repairs.lines.length));
    if (mode === 'sales' && !hasSalesData) return;
    if (mode === 'repairs' && !hasRepairsData) return;
    if (quoteId && currentSnapshot === quoteSnapshotRef.current) return;
    const nowIso = new Date().toISOString();
    const payload = {
      ...currentQuoteRecord,
      id: quoteId || undefined,
      createdAt: quoteMetaRef.current.createdAt || nowIso,
      contentUpdatedAt: nowIso,
    };
    try {
      if (quoteId) {
        const updated = await (window as any).api.dbUpdate('quotes', quoteId, payload);
        if (!updated?.id) return;
        quoteMetaRef.current = {
          createdAt: updated.createdAt || payload.createdAt,
          contentUpdatedAt: updated.contentUpdatedAt || payload.contentUpdatedAt,
        };
      } else {
        const saved = await (window as any).api.dbAdd('quotes', payload);
        if (saved?.id) {
          setQuoteId(saved.id);
          quoteMetaRef.current = {
            createdAt: saved.createdAt || payload.createdAt,
            contentUpdatedAt: saved.contentUpdatedAt || payload.contentUpdatedAt,
          };
        }
      }
      quoteSnapshotRef.current = currentSnapshot;
      // Refresh sidebar list after autosave commits
      openSavedQuotes();
      try { window.opener?.postMessage({ type: 'sales:changed' }, '*'); } catch {}
      setSaveMsg('Autosaved');
      setTimeout(() => setSaveMsg(null), 1500);
    } catch {}
  }, { debounceMs: 1000, enabled: true, equals: (a, b) => a === b });

  function buildAIPrompt(it: SaleItem) {
    const lines: string[] = [];
    const isImageLike = (v: any) => {
      try {
        const s = String(v ?? '').trim();
        if (!s) return false;
        if (/^data:image\//i.test(s)) return true;
        if (s.length > 2000) return true; // likely a data URI
        if (/\.(jpe?g|png|gif|bmp|webp)(?:\?|$)/i.test(s)) return true;
        if (/^https?:\/\//i.test(s) && /\.(jpe?g|png|gif|bmp|webp)(?:\?|$)/i.test(s)) return true;
        return false;
      } catch { return false; }
    };
    const isPriceLike = (v: any) => {
      try {
        if (v == null) return false;
        if (typeof v === 'number') return true;
        const s = String(v).trim();
        if (!s) return false;
        // common currency/price patterns: $12.34, 12.34, 1234, 1,234.56
        if (/^\$?\s*\d{1,3}(?:[\,\s]\d{3})*(?:[.,]\d{1,2})?\s*$/.test(s)) return true;
        if (/^\d+(?:[.,]\d{1,2})?$/.test(s)) return true;
        return false;
      } catch { return false; }
    };
    const sanitizeVal = (v: any) => (isImageLike(v) || isPriceLike(v) ? '' : String(v ?? '').trim());
    // Custom Build: create a sectioned, fact-first prompt using only provided fields
    if (it.deviceType === 'Custom Build') {
      lines.push('Produce a concise, professional single paragraph (5-7 sentences) that summarizes the provided Custom PC components and explains how they work together as a balanced system.');
      lines.push('Use only the exact specifications supplied; do not infer or invent additional numbers, model details, or availability.');
      lines.push('Structure facts by component so the model can reference them clearly. For example: "CPU: <value>, Gen <value>, <cores> cores"; "GPU: <model>, <VRAM>"; "RAM: <size>, <speed>"; "Storage: <type>, <size>".');
      lines.push('Address real-world performance implications (speed, responsiveness, multitasking, workload throughput, and expected gaming frame-rates where applicable) and state whether the build favors gaming, content creation, or general productivity.');
      lines.push('Keep language factual, neutral, and to the point; avoid sales language, pricing, or calls to action.');

      const dyn: any = it.dynamic || {};
      const pushIf = (label: string, parts: Array<any>) => {
        const vals = parts.map(p => sanitizeVal(p)).filter(Boolean);
        if (vals.length) lines.push(`${label}: ${vals.join(', ')}`);
      };

      pushIf('Case', [dyn.case, dyn.caseFormFactor, dyn.caseInfo]);
      pushIf('Motherboard', [dyn.motherboard || dyn.mobo, dyn.moboChipset, dyn.formFactor]);
      pushIf('CPU', [dyn.cpu, dyn.cpuGen && `Gen ${dyn.cpuGen}`, dyn.cpuCores && `${dyn.cpuCores} cores`, dyn.cpuClock]);
      pushIf('RAM', [dyn.ram, dyn.ramSize && `${dyn.ramSize}`, dyn.ramSpeed && `${dyn.ramSpeed}`, dyn.ramType]);
      pushIf('GPU', [dyn.gpuModel || dyn.gpu || dyn.gpuBrand, dyn.gpuVram && `${dyn.gpuVram}`]);
      pushIf('Storage', [formatStorageSummary(dyn)]);
      pushIf('PSU', [dyn.psu, dyn.psuWatt && `${dyn.psuWatt}W`]);
      pushIf('Cooling', [dyn.cooling || dyn.coolingType]);
      pushIf('OS', [dyn.os]);

      if (Array.isArray(dyn.extraParts)) {
        dyn.extraParts.forEach((e: any, i: number) => {
          const name = e?.name || e?.label || `Extra-${i+1}`;
          const desc = sanitizeVal(e?.desc || e?.info || '');
          if (name || desc) lines.push(`Extra (${name}): ${desc}`);
        });
      }

      lines.push('Output: exactly one paragraph (5-7 sentences), no bullets or lists.');
      return lines.join('\n');
    }
    const titleParts = [it.brand, it.model].filter(Boolean);
    const title = titleParts.join(' ') || (it.deviceType || 'Device');
    const appleFamily = it.dynamic?.device ? `Apple ${it.dynamic.device}` : '';
    const deviceLabel = appleFamily || it.deviceType || 'Device';

    // Collect confirmed specs
    const confirmedSpecs: Array<[string, string]> = [];
    const addSpec = (label: string, val: any) => {
      const sv = sanitizeVal(val);
      if (sv) confirmedSpecs.push([label, sv]);
    };

    addSpec('Device Type', deviceLabel);
    addSpec('Brand', it.brand);
    addSpec('Model', it.model);
    addSpec('Condition', it.condition);
    if (it.dynamic) {
      Object.entries(it.dynamic).forEach(([k, v]) => {
        if (k === 'device') return;
        if (/image/i.test(k)) return;
        if (/price/i.test(k)) return;
        if (isImageLike(v)) return;
        if (isPriceLike(v)) return;
        addSpec(k, v);
      });
    }
    if (it.accessories) addSpec('Accessories', it.accessories);

    const specBlock = confirmedSpecs.map(([k, v]) => `  - ${k}: ${v}`).join('\n');
    const modelLine = title !== (it.deviceType || 'Device') ? `"${title}"` : `a ${deviceLabel}`;

    lines.push(`You are writing an enthusiastic sales description for ${modelLine} that we are selling to a customer.`);
    lines.push('');
    lines.push('== CONFIRMED SPECS (treat these as absolute truth) ==');
    lines.push(specBlock);
    lines.push('');
    lines.push('== YOUR TASK ==');
    lines.push(`1. Use your training knowledge to research the real-world highlights of the ${title}. Pull in genuine fun facts, standout features, awards, build quality, display quality, performance reputation, battery life, target audience, or anything that makes this specific model noteworthy and exciting.`);
    lines.push('2. CRITICAL – spec consistency: ONLY mention facts from your research that are COMPATIBLE with the confirmed specs above. If a confirmed spec (e.g., "Storage: 1TB SSD") differs from a common variant (e.g., the model also shipped with 256GB), do NOT mention the conflicting variant. Every researched claim must align with or be silent about any confirmed spec.');
    lines.push('3. Blend the confirmed specs naturally into the paragraph — do not just list them.');
    lines.push('4. Write with energy, genuine excitement, and upsell appeal. Highlight what makes this device special and why the customer should be excited to own it.');
    lines.push('5. Do NOT mention pricing, store names, warranties, or direct calls to action.');
    lines.push('');
    lines.push('== OUTPUT FORMAT ==');
    lines.push('Exactly one paragraph, 5–7 sentences, no heading/title, no bullet points, no emojis.');

    return lines.join('\n');
  }

  async function copyPromptForItem(idx: number) {
    const it = sales.items[idx];
    const prompt = buildQuoteSalesPrompt(it);
    try {
      await copyQuotePromptText(prompt);
      setSaveMsg('AI prompt copied to clipboard');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (_) {
      setSaveMsg('Could not copy to clipboard');
      setTimeout(() => setSaveMsg(null), 2000);
    }
  }

  function renderDynamicFields(it: SaleItem, idx: number) {
    const appleMap: Record<string, string> = {
      iPhone: 'Phone',
      iPad: 'Tablet',
      'iPad Air': 'Tablet',
      'iPad Pro': 'Tablet',
      'iPad mini': 'Tablet',
      MacBook: 'Laptop',
      'MacBook Air': 'Laptop',
      'MacBook Pro': 'Laptop',
      iMac: 'Laptop',
      'Mac mini': 'Laptop',
      'Mac Studio': 'Laptop',
      'Mac Pro': 'Laptop',
      'Apple Watch': 'Audio',
      AirPods: 'Audio',
      'AirPods Pro': 'Audio',
      'AirPods Max': 'Audio',
      'Apple TV': 'Other',
      HomePod: 'Audio',
    };
    const selectedApple = it.dynamic?.device as string | undefined;
    const effectiveType = it.deviceType === 'Apple Devices' && selectedApple ? appleMap[selectedApple] || 'Apple Devices' : it.deviceType;
  let dt = effectiveType ? deviceTypes.find((d) => d.type === effectiveType) : undefined;
  if (!dt) dt = deviceTypes.find((d) => d.type === it.deviceType);
  // Allow 'Other' deviceType even when there's no definition in deviceTypes
  if (!dt && it.deviceType !== 'Other') return null;

  // Special-case: Custom Build per-part UI (single-column rows: image | select | more info | price)
    if (dt?.type === 'Custom Build') {
      const parts: Array<{ key: string; label: string; options?: string[] }> = [
        { key: 'case', label: 'Case', options: ['NZXT H5','NZXT H7','Lian Li O11','Fractal North','Corsair 4000D','Corsair 5000D','Phanteks P400A'] },
        { key: 'motherboard', label: 'Motherboard', options: ['B550','B650','X670','Z690','Z790','H610','B760','X570'] },
        { key: 'cpu', label: 'Processor', options: ['Intel Core i5','Intel Core i7','Intel Core i9','AMD Ryzen 5','AMD Ryzen 7','AMD Ryzen 9','Ryzen 7 7800X3D','Intel i7-13700K','Intel i9-14900K'] },
        { key: 'ram', label: 'Memory', options: ['16 GB DDR4','32 GB DDR4','16 GB DDR5','32 GB DDR5','64 GB DDR5'] },
        { key: 'gpu', label: 'Graphics Card', options: ['RTX 4060','RTX 4060 Ti','RTX 4070','RTX 4070 Ti','RTX 4080','RX 7700 XT','RX 7800 XT'] },
        { key: 'psu', label: 'PSU', options: ['650W Gold','750W Gold','850W Gold','1000W Gold'] },
      ];

      const partRows = parts.map((p) => {
        const imageKey = `${p.key}Image`;
        const infoKey = `${p.key}Info`;
        const priceKey = `${p.key}Price`;
        const img = (it.dynamic || ({} as any))[imageKey] as string | undefined;
        return (
          <div key={`row-${p.key}`} className="col-span-16">
            <label className="block text-xs text-zinc-400 mb-1">{p.label}</label>
            <div className="grid grid-cols-16 gap-2 items-start">
              {/* Image (left) */}
              <div className="col-span-2">
                <div className="flex items-center gap-2">
                  <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden flex items-center justify-center bg-zinc-900">
                    {img ? (
                      <img src={img} alt={`${p.label}`} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[10px] text-zinc-500">No image</span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file'; input.accept = 'image/*';
                      input.onchange = (e: any) => addImageForPart(idx, p.key, (e.target as HTMLInputElement).files);
                      input.click();
                    }}>Add Image</button>
                    {img && (
                      <button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => removeImageForPart(idx, p.key)}>Remove</button>
                    )}
                  </div>
                </div>
              </div>
              {/* Part select */}
              <div className="col-span-5">
                <ComboInput
                  value={(it.dynamic || ({} as any))[p.key] || ''}
                  onChange={(v) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [p.key]: v } } : x)) }))}
                  options={p.options || []}
                    placeholder={`Select ${p.label.toLowerCase()}...`}
                />
              </div>
              {/* More info */}
              <div className="col-span-7">
                <input
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                  value={(it.dynamic || ({} as any))[infoKey] || ''}
                  onChange={(e) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [infoKey]: (e.target as HTMLInputElement).value } } : x)) }))}
                  placeholder={`More info (model/specs/notes)`}
                />
              </div>
              {/* Price */}
              <div className="col-span-2">
                <MoneyInput
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                  value={Number((it.dynamic || ({} as any))[priceKey] || 0) || 0}
                  onValueChange={(v) => setSales((s) => ({
                    ...s,
                    items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [priceKey]: Number(v || 0) } } : x)),
                  }))}
                  placeholder="0.00"
                />
                <div className="text-[10px] text-zinc-400 mt-0.5">Print shows +5%</div>
              </div>
            </div>
          </div>
        );
      });

      const extras = Array.isArray((it.dynamic as any)?.extraParts) ? ((it.dynamic as any).extraParts as any[]) : [];

      return (
        <>
          <div className="col-span-16">
            <div className="bg-zinc-900 border border-zinc-700 rounded p-2 text-xs text-zinc-300">Custom Build: Each row shows image, part, details, and raw price. Printout uses +5% on each part and adds Build Labor at the end.</div>
          </div>
          {partRows}
          {/* Operating System (text field) */}
          <div className="col-span-16">
            <label className="block text-xs text-zinc-400 mb-1">Operating System</label>
            <input
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
              value={(it.dynamic || ({} as any)).os || ''}
              onChange={(e) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), os: (e.target as HTMLInputElement).value } } : x)) }))}
              placeholder="e.g., Windows 11 Pro"
            />
          </div>
          {/* Additional parts */}
          <div className="col-span-16 mt-2 flex items-center justify-between">
            <div className="text-xs text-zinc-400">Additional Parts</div>
            <button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => setSales((s) => ({
              ...s,
              items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), extraParts: [...(Array.isArray((x.dynamic as any)?.extraParts) ? (x.dynamic as any).extraParts : []), { name: '', desc: '', price: '', image: '' }] } } : x))
            }))}>Add Part</button>
          </div>
          {extras.map((e, i) => (
            <div key={`extra-${i}`} className="col-span-16">
              <div className="grid grid-cols-16 gap-2 items-start">
                <div className="col-span-2">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden flex items-center justify-center bg-zinc-900">
                      {e?.image ? (<img src={e.image} alt={`Extra ${i+1}`} className="w-full h-full object-cover" />) : (<span className="text-[10px] text-zinc-500">No image</span>)}
                    </div>
                    <div className="flex flex-col gap-1">
                      <button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => { const input = document.createElement('input'); input.type='file'; input.accept='image/*'; input.onchange = (ev: any) => { const file=(ev.target as HTMLInputElement).files?.[0]; if(!file) return; const fr=new FileReader(); fr.onload=()=> setSales((s)=>({ ...s, items: s.items.map((x,ii)=>{ if(ii!==idx) return x; const list = Array.isArray((x.dynamic as any)?.extraParts)?[...(x.dynamic as any).extraParts]:[]; list[i] = { ...(list[i]||{}), image: String(fr.result||'') }; return { ...x, dynamic: { ...(x.dynamic||{}), extraParts: list } }; }) })); fr.readAsDataURL(file); }; input.click(); }}>Add Image</button>
                      {e?.image && (<button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => setSales((s)=>({ ...s, items: s.items.map((x,ii)=>{ if(ii!==idx) return x; const list = Array.isArray((x.dynamic as any)?.extraParts)?[...(x.dynamic as any).extraParts]:[]; list[i] = { ...(list[i]||{}), image: '' }; return { ...x, dynamic: { ...(x.dynamic||{}), extraParts: list } }; }) }))}>Remove</button>)}
                    </div>
                  </div>
                </div>
                <div className="col-span-4">
                  <input className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" value={e?.name || ''} onChange={(ev)=> setSales((s)=>({ ...s, items: s.items.map((x,ii)=>{ if(ii!==idx) return x; const list = Array.isArray((x.dynamic as any)?.extraParts)?[...(x.dynamic as any).extraParts]:[]; list[i] = { ...(list[i]||{}), name: ev.target.value }; return { ...x, dynamic: { ...(x.dynamic||{}), extraParts: list } }; }) }))} placeholder="Part Name" />
                </div>
                <div className="col-span-8">
                  <input className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" value={e?.desc || ''} onChange={(ev)=> setSales((s)=>({ ...s, items: s.items.map((x,ii)=>{ if(ii!==idx) return x; const list = Array.isArray((x.dynamic as any)?.extraParts)?[...(x.dynamic as any).extraParts]:[]; list[i] = { ...(list[i]||{}), desc: ev.target.value }; return { ...x, dynamic: { ...(x.dynamic||{}), extraParts: list } }; }) }))} placeholder="Part Description" />
                </div>
                <div className="col-span-2">
                  <MoneyInput
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                    value={Number(e?.price || 0) || 0}
                    onValueChange={(v) => setSales((s) => ({
                      ...s,
                      items: s.items.map((x, ii) => {
                        if (ii !== idx) return x;
                        const list = Array.isArray((x.dynamic as any)?.extraParts) ? [ ...(x.dynamic as any).extraParts ] : [];
                        list[i] = { ...(list[i] || {}), price: Number(v || 0) };
                        return { ...x, dynamic: { ...(x.dynamic || {}), extraParts: list } };
                      }),
                    }))}
                    placeholder="0.00"
                  />
                  <div className="text-[10px] text-zinc-400 mt-0.5">Print shows +5%</div>
                </div>
                <div className="col-span-1 flex items-end justify-end">
                  <button className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" title="Remove" onClick={() => setSales((s)=>({ ...s, items: s.items.map((x,ii)=>{ if(ii!==idx) return x; const list = Array.isArray((x.dynamic as any)?.extraParts)?[...(x.dynamic as any).extraParts]:[]; list.splice(i,1); return { ...x, dynamic: { ...(x.dynamic||{}), extraParts: list } }; }) }))}>Remove</button>
                </div>
              </div>
            </div>
          ))}

          {/* AI prompt for synergy */}
          <div className="col-span-16 mt-2">
            <label className="block text-xs text-zinc-400 mb-1">AI Response (parts synergy)</label>
            <textarea rows={8} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm resize-y" placeholder="Describe how these components work together; highlight how it performs data entry, web browsing, creative work, and gaming."
              value={it.prompt || ''}
              onChange={(e) => setSales((s)=>({ ...s, items: s.items.map((x,i)=> (i===idx ? { ...x, prompt: e.target.value } : x)) }))}
            />
            <div className="flex items-center justify-end mt-2"><button className="px-3 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded hover:bg-zinc-600" onClick={() => copyPromptForItem(idx)}>Copy AI Prompt</button></div>
          </div>

          {/* Build Labor at the bottom */}
          <div className="col-span-16">
            <label className="block text-xs text-zinc-400 mb-1">Build Labor Fee</label>
            <MoneyInput
              className="w-full bg-yellow-200 text-black border border-yellow-400 rounded px-2 py-1 text-sm"
              value={Number((it.dynamic || ({} as any)).buildLabor || 0) || 0}
              onValueChange={(v) => setSales((s) => ({
                ...s,
                items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), buildLabor: Number(v || 0) } } : x)),
              }))}
              placeholder="0.00"
            />
            <div className="text-[10px] text-zinc-800 mt-0.5">Labor has no markup</div>
          </div>
        </>
      );
    }
    // Special-case: Custom PC (Desktop) organized by categories with per-category image
  if (dt?.type === 'Custom PC') {
      // Build a quick index of field defs for lookup
      const fieldIndex: Record<string, any> = {};
      dt.fields.forEach((f: any) => { fieldIndex[f.key] = f; });
      type Category = { key: string; label: string; fieldKeys: string[] };
      const categories: Category[] = [
        { key: 'case', label: 'Case', fieldKeys: ['case'] },
        { key: 'motherboard', label: 'Motherboard', fieldKeys: ['motherboard'] },
        { key: 'cpu', label: 'Processor', fieldKeys: ['cpu','cpuGen'] },
        { key: 'cooling', label: 'Cooling', fieldKeys: ['cooling'] },
        { key: 'ram', label: 'Memory', fieldKeys: ['ram','ramSpeed'] },
        { key: 'gpu', label: 'Graphics Card', fieldKeys: ['gpuBrand','gpuModel','gpuVram'] },
        { key: 'storage', label: 'Primary Storage', fieldKeys: ['bootDriveType','bootDriveStorage','secondaryStorage1Type','secondaryStorage1Storage'] },
        { key: 'psu', label: 'PSU', fieldKeys: ['psu'] },
        { key: 'os', label: 'Operating System', fieldKeys: ['os'] },
        // Peripherals: now a simple text field
        { key: 'peripherals', label: 'Peripherals', fieldKeys: ['peripherals'] },
        // Special bottom category for Build Labor (no image, no markup)
        { key: 'buildLabor', label: 'Build Labor', fieldKeys: [] },
      ];
      const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').split(' ').filter(Boolean).map((w) => {
        const up = w.toUpperCase(); return (w.length <= 3 && w === up) ? up : (w.charAt(0).toUpperCase() + w.slice(1));
      }).join(' ');
      const idxKey = String(idx);
      const toggleCat = (catKey: string) => setOpenCats((prev) => ({
        ...prev,
        [idxKey]: { ...(prev[idxKey] || {}), [catKey]: !((prev[idxKey] || {})[catKey]) }
      }));
      const renderField = (fk: string) => {
        const def = fieldIndex[fk] || { key: fk, label: titleCase(fk), type: 'text' };
        const value = (it.dynamic || ({} as any))[fk] || '';
        const isLong = fk === 'ports';
        // Make inputs long and spaced comfortably
        const colClass = isLong ? 'col-span-16' : 'col-span-12';
        if (Array.isArray(def.options) && def.options.length > 0) {
          return (
            <div key={fk} className={colClass}>
              <label className="block text-xs text-zinc-400 mb-1">{def.label || titleCase(fk)}</label>
              <ComboInput
                value={value}
                onChange={(v) => setSales((s) => ({ ...s, items: s.items.map((x, i2) => (i2 === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [fk]: v } } : x)) }))}
                options={((): string[] => {
                  const opts = (def.options || []) as string[];
                  if (fk === 'os') {
                    return opts.map((o) => {
                      let s = String(o || '');
                      // remove trailing price patterns like " - $123.45" or " ($123.45)"
                      s = s.replace(/\s*(?:[-:])\s*\$?\d+(?:[.,]\d{2})?$/, '');
                      s = s.replace(/\s*\([^\)]*\$\d+[\d.,]*[^\)]*\)\s*$/, '');
                      return s.trim();
                    });
                  }
                  return opts;
                })()}
                placeholder={`Select ${(def.label || titleCase(fk)).toLowerCase()}...`}
              />
            </div>
          );
        }
        return (
          <div key={fk} className={colClass}>
            <label className="block text-xs text-zinc-400 mb-1">{def.label || titleCase(fk)}</label>
            <input
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
              value={value}
              onChange={(e) => setSales((s) => ({ ...s, items: s.items.map((x, i2) => (i2 === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [fk]: (e.target as HTMLInputElement).value } } : x)) }))}
              placeholder={String(def.label || titleCase(fk))}
            />
          </div>
        );
      };

      return (
        <>
          {/* Wrap categories in a single full-width column and stack vertically; ensure it starts below Device Type */}
          <div className="col-span-16 col-start-1 mt-3">
            <div className="flex flex-col gap-2">
          {categories.map((cat) => {
            const imageKey = `${cat.key}Image`;
            const img = (it.dynamic || ({} as any))[imageKey] as string | undefined;
            const img2 = (it.dynamic || ({} as any))[`${cat.key}Image2`] as string | undefined;
            const isOpen = (openCats[idxKey] && openCats[idxKey][cat.key]) ?? (cat.key === 'case');
            return (
              <div key={`cat-${cat.key}`}>
                {/* Category as dropdown header */}
                <button type="button" className="w-full flex items-center justify-between bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-left"
                  onClick={() => toggleCat(cat.key)}
                >
                  <span className="text-sm font-semibold text-zinc-200">{cat.label}</span>
                  <span className="text-zinc-400 text-xs">{isOpen ? 'v' : '>'}</span>
                </button>
                {isOpen && (
                  <div className="mt-2 border border-zinc-700 rounded p-2 bg-zinc-900 relative isolate z-10">
                    {/* Image controls and preview (skip for Build Labor, Peripherals, and OS) */}
                    {cat.key !== 'buildLabor' && cat.key !== 'peripherals' && cat.key !== 'os' && cat.key !== 'storage' && (
                      <div className="flex items-center gap-2 mb-2">
                        <button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded"
                          onClick={() => { const input = document.createElement('input'); input.type='file'; input.accept='image/*'; input.onchange = (ev: any) => addImageForPart(idx, cat.key, (ev.target as HTMLInputElement).files); input.click(); }}
                        >Add Image</button>
                        {(img || img2) && (
                          <button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => removeImageForPart(idx, cat.key)}>Remove</button>
                        )}
                        {(img || img2) ? (
                          <div className="ml-2 flex items-center gap-2">
                            {img && (
                              <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden bg-zinc-900 flex items-center justify-center">
                                <img src={img} alt={`${cat.label} Image 1`} className="w-full h-full object-cover" />
                              </div>
                            )}
                            {img2 && (
                              <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden bg-zinc-900 flex items-center justify-center">
                                <img src={img2} alt={`${cat.label} Image 2`} className="w-full h-full object-cover" />
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="ml-2 text-[10px] text-zinc-500">No image</div>
                        )}
                      </div>
                    )}
                    {/* Category fields */}
                    {cat.key !== 'buildLabor' ? (
                      <div className="grid grid-cols-16 gap-3">
                        {(() => {
                          if (cat.key === 'storage') {
                            const dyn: any = it.dynamic || {};
                            const driveTypeOptions = ['M.2 NVMe','SATA SSD','HDD','NVMe (SATA)','eMMC','Integrated','External','Other'];
                            const storageSizeOptions = ['128 GB','256 GB','500 GB','512 GB','1 TB','2 TB','4 TB','8 TB','Other'];
                            const enabled = Boolean(dyn.pcSecondaryStorageEnabled);
                            const secondaryList: any[] = Array.isArray(dyn.pcSecondaryStorage) ? dyn.pcSecondaryStorage : [];
                            const storageImg1 = String(dyn.storageImage || '').trim();
                            const storageImg2 = String(dyn.storageImage2 || '').trim();
                            const setDyn = (key: string, v: any) => setSales((s) => ({
                              ...s,
                              items: s.items.map((x, i2) => (i2 === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [key]: v } } : x)),
                            }));
                            const setSecondaryList = (nextList: any[]) => setSales((s) => ({
                              ...s,
                              items: s.items.map((x, i2) => {
                                if (i2 !== idx) return x;
                                const nextDyn: any = { ...(x.dynamic || {}) };
                                nextDyn.pcSecondaryStorage = nextList;
                                nextDyn.pcSecondaryStorageEnabled = nextList.length > 0;
                                nextDyn.secondaryStorage1Type = String(nextList[0]?.type || '');
                                nextDyn.secondaryStorage1Storage = String(nextList[0]?.size || '');
                                if (!nextList.length) {
                                  delete nextDyn.secondaryStorage1Type;
                                  delete nextDyn.secondaryStorage1Storage;
                                }
                                return { ...x, dynamic: nextDyn };
                              }),
                            }));
                            const toggleEnabled = (checked: boolean) => {
                              if (!checked) {
                                setSecondaryList([]);
                                setDyn('pcSecondaryStorageEnabled', false);
                                return;
                              }
                              if (secondaryList.length) {
                                setDyn('pcSecondaryStorageEnabled', true);
                                return;
                              }
                              setSecondaryList([{ type: '', size: '', price: '', image: '', image2: '' }]);
                            };
                            const updateSecondaryField = (driveIdx: number, key: 'type' | 'size' | 'price', value: string) => {
                              const next = [ ...secondaryList ];
                              next[driveIdx] = { ...(next[driveIdx] || {}), [key]: value };
                              setSecondaryList(next);
                            };
                            const removeSecondaryDrive = (driveIdx: number) => {
                              const next = [ ...secondaryList ];
                              next.splice(driveIdx, 1);
                              setSecondaryList(next);
                            };

                            return (
                              <>
                                <div className="col-span-8">
                                  <label className="block text-xs text-zinc-400 mb-1">Description / Type</label>
                                  <ComboInput value={String(dyn.bootDriveType || dyn.storageType || '')} onChange={(v) => setDyn('bootDriveType', v)} options={driveTypeOptions} placeholder="Select drive type..." />
                                </div>
                                <div className="col-span-6">
                                  <label className="block text-xs text-zinc-400 mb-1">Amount</label>
                                  <ComboInput value={String(dyn.bootDriveStorage || dyn.storageSize || '')} onChange={(v) => setDyn('bootDriveStorage', v)} options={storageSizeOptions} placeholder="Select storage size..." />
                                </div>
                                <div className="col-span-2 flex items-end">
                                  <label className="flex items-center gap-2 text-xs text-zinc-300 select-none">
                                    <input type="checkbox" className="accent-[#39FF14]" checked={enabled} onChange={(e) => toggleEnabled((e.target as HTMLInputElement).checked)} />
                                    Secondary
                                  </label>
                                </div>

                                <div className="col-span-12">
                                  <label className="block text-xs text-zinc-400 mb-1">Images</label>
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded"
                                      onClick={() => {
                                        const input = document.createElement('input');
                                        input.type = 'file';
                                        input.accept = 'image/*';
                                        input.onchange = (ev: any) => addImageForPart(idx, 'storage', (ev.target as HTMLInputElement).files);
                                        input.click();
                                      }}
                                    >Add Image</button>
                                    {(storageImg1 || storageImg2) && (
                                      <button
                                        type="button"
                                        className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded"
                                        onClick={() => removeImageForPart(idx, 'storage')}
                                      >Remove</button>
                                    )}
                                    <div className="ml-2 flex items-center gap-2">
                                      <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden bg-zinc-900 flex items-center justify-center">
                                        {storageImg1 ? (<img src={storageImg1} alt="Storage Image 1" className="w-full h-full object-cover" />) : (<span className="text-[10px] text-zinc-500">No image</span>)}
                                      </div>
                                      <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden bg-zinc-900 flex items-center justify-center">
                                        {storageImg2 ? (<img src={storageImg2} alt="Storage Image 2" className="w-full h-full object-cover" />) : (<span className="text-[10px] text-zinc-500">No image</span>)}
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                <div className="col-span-4">
                                  <label className="block text-xs text-zinc-400 mb-1">Price</label>
                                  <MoneyInput
                                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                                    value={Number(dyn.storagePrice || 0) || 0}
                                    onValueChange={(v) => setDyn('storagePrice', Number(v || 0))}
                                    placeholder="0.00"
                                  />
                                  <div className="text-[10px] text-zinc-400 mt-0.5">Print shows +5%</div>
                                </div>

                                {enabled && (
                                  <div className="col-span-16">
                                    <div className="mt-3 flex items-center justify-end">
                                      <button type="button" className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => setSecondaryList([ ...secondaryList, { type: '', size: '', price: '', image: '', image2: '' } ])}>+ Add additional storage</button>
                                    </div>

                                    <div className="mt-2 flex flex-col gap-2">
                                      {secondaryList.map((d, di) => {
                                        const cardKey = `storage-drive-${di}`;
                                        const cardOpen = (openCats[idxKey] && (openCats as any)[idxKey]?.[cardKey]) ?? true;
                                        const title = di === 0 ? 'Secondary Storage' : 'Additional Storage';
                                        return (
                                          <div key={`pc-sec-drive-${di}`}>
                                            <button
                                              type="button"
                                              className="w-full flex items-center justify-between bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-left"
                                              onClick={() => toggleCat(cardKey)}
                                            >
                                              <span className="text-sm font-semibold text-zinc-200">{title}</span>
                                              <span className="text-zinc-400 text-xs">{cardOpen ? 'v' : '>'}</span>
                                            </button>
                                            {cardOpen && (
                                              <div className="mt-2 border border-zinc-700 rounded p-2 bg-zinc-900">
                                                <div className="grid grid-cols-16 gap-3 items-start">
                                                  <div className="col-span-12">
                                                    <label className="block text-xs text-zinc-400 mb-1">Images</label>
                                                    <div className="flex items-center gap-2">
                                                      <button
                                                        type="button"
                                                        className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded"
                                                        onClick={() => {
                                                          const input = document.createElement('input');
                                                          input.type = 'file';
                                                          input.accept = 'image/*';
                                                          input.onchange = (ev: any) => addImageForPcSecondaryStorage(idx, di, (ev.target as HTMLInputElement).files);
                                                          input.click();
                                                        }}
                                                      >Add Image</button>
                                                      {(d?.image || d?.image2) && (
                                                        <button
                                                          type="button"
                                                          className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded"
                                                          onClick={() => removeImageForPcSecondaryStorage(idx, di)}
                                                        >Remove</button>
                                                      )}
                                                      <div className="ml-2 flex items-center gap-2">
                                                        <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden flex items-center justify-center bg-zinc-900">
                                                          {d?.image ? (<img src={String(d.image)} alt={`${title} Image 1`} className="w-full h-full object-cover" />) : (<span className="text-[10px] text-zinc-500">No image</span>)}
                                                        </div>
                                                        <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden flex items-center justify-center bg-zinc-900">
                                                          {d?.image2 ? (<img src={String(d.image2)} alt={`${title} Image 2`} className="w-full h-full object-cover" />) : (<span className="text-[10px] text-zinc-500">No image</span>)}
                                                        </div>
                                                      </div>
                                                    </div>
                                                  </div>
                                                  <div className="col-span-8">
                                                    <label className="block text-xs text-zinc-400 mb-1">Description / Type</label>
                                                    <ComboInput value={String(d?.type || '')} onChange={(v) => updateSecondaryField(di, 'type', v)} options={driveTypeOptions} placeholder="Select drive type..." />
                                                  </div>
                                                  <div className="col-span-6">
                                                    <label className="block text-xs text-zinc-400 mb-1">Amount</label>
                                                    <ComboInput value={String(d?.size || '')} onChange={(v) => updateSecondaryField(di, 'size', v)} options={storageSizeOptions} placeholder="Select storage size..." />
                                                  </div>
                                                  <div className="col-span-2">
                                                    <label className="block text-xs text-zinc-400 mb-1">Price</label>
                                                    <MoneyInput
                                                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                                                      value={Number(d?.price || 0) || 0}
                                                      onValueChange={(v) => updateSecondaryField(di, 'price', String(Number(v || 0)))}
                                                      placeholder="0.00"
                                                    />
                                                    <div className="text-[10px] text-zinc-400 mt-0.5">Print shows +5%</div>
                                                  </div>
                                                  <div className="col-span-16 flex justify-end">
                                                    <button type="button" className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" title="Remove" onClick={() => removeSecondaryDrive(di)}>Remove</button>
                                                  </div>
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                              </>
                            );
                          }

                          if (cat.key === 'peripherals') {
                            const pcExtras: any[] = Array.isArray((it.dynamic as any)?.pcExtras)
                              ? (it.dynamic as any).pcExtras
                              : [];
                            const updatePcExtra = (extraIdx: number, patch: any) =>
                              setSales((s) => ({
                                ...s,
                                items: s.items.map((x, i2) => {
                                  if (i2 !== idx) return x;
                                  const list = Array.isArray((x.dynamic as any)?.pcExtras)
                                    ? [ ...(x.dynamic as any).pcExtras ]
                                    : [];
                                  list[extraIdx] = { ...(list[extraIdx] || {}), ...(patch || {}) };
                                  return { ...x, dynamic: { ...(x.dynamic || {}), pcExtras: list } };
                                }),
                              }));
                            return (
                              <>
                                <div className="col-span-16 flex justify-between items-center">
                                  <div className="text-xs text-zinc-400">Add peripherals as individual line items.</div>
                                  <button type="button" className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => addPcExtra(idx)}>+ Add item</button>
                                </div>
                                {pcExtras.map((e: any, iExtra: number) => (
                                  <div key={`pc-extra-${iExtra}`} className="col-span-16">
                                    <div className="flex items-end gap-2">
                                      <div className="w-[220px]">
                                        <label className="block text-xs text-zinc-400 mb-1">Image</label>
                                        <div className="flex items-center gap-2">
                                          <div className="w-16 h-16 border border-zinc-700 rounded overflow-hidden flex items-center justify-center bg-zinc-900">
                                            {e?.image ? (<img src={String(e.image)} alt={String(e?.label || e?.type || 'Peripheral')} className="w-full h-full object-cover" />) : (<span className="text-[10px] text-zinc-500">No image</span>)}
                                          </div>
                                          <div className="flex flex-col gap-1">
                                            <button type="button" className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => { const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.onchange = (ev: any) => addImageForPcExtra(idx, iExtra, (ev.target as HTMLInputElement).files); input.click(); }}>Add Image</button>
                                            {e?.image && (<button type="button" className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => removeImageForPcExtra(idx, iExtra)}>Remove</button>)}
                                          </div>
                                        </div>
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <label className="block text-xs text-zinc-400 mb-1">Peripheral</label>
                                        <ComboInput
                                          value={String(e?.label || '')}
                                          onChange={(v) => updatePcExtra(iExtra, { label: v })}
                                          options={PERIPHERAL_TYPE_OPTIONS}
                                          placeholder="Select or type a peripheral..."
                                        />
                                        <div className="mt-2">
                                          <label className="block text-xs text-zinc-400 mb-1">Description</label>
                                          <input
                                            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                                            placeholder="Optional notes (brand/model, color, etc.)"
                                            value={e?.desc || ''}
                                            onChange={(ev) => updatePcExtra(iExtra, { desc: (ev.target as HTMLInputElement).value })}
                                          />
                                        </div>
                                      </div>
                                      <div className="w-32">
                                        <label className="block text-xs text-zinc-400 mb-1">Price</label>
                                        <MoneyInput
                                          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                                          placeholder="0.00"
                                          value={Number(e?.price || 0) || 0}
                                          onValueChange={(v) => updatePcExtra(iExtra, { price: Number(v || 0) })}
                                        />
                                        <div className="text-[10px] text-zinc-400 mt-0.5">Print shows +5%</div>
                                      </div>
                                      <div>
                                        <button type="button" className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" title="Remove" onClick={() => removePcExtra(idx, iExtra)}>Remove</button>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </>
                            );
                          }

                          return (
                            <>
                              {cat.fieldKeys.map(renderField)}
                              {/* Price field per category */}
                              <div className="col-span-4">
                                <label className="block text-xs text-zinc-400 mb-1">Price</label>
                                <MoneyInput
                                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                                  value={Number((it.dynamic || ({} as any))[`${cat.key}Price`] || 0) || 0}
                                  onValueChange={(v) => setSales((s) => ({
                                    ...s,
                                    items: s.items.map((x, i2) => (i2 === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [`${cat.key}Price`]: Number(v || 0) } } : x)),
                                  }))}
                                  placeholder="0.00"
                                />
                                <div className="text-[10px] text-zinc-400 mt-0.5">Print shows +5%</div>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    ) : (
                      <div className="grid grid-cols-16 gap-3">
                        <div className="col-span-6">
                          <label className="block text-xs text-zinc-400 mb-1">Build Labor</label>
                          <MoneyInput
                            className="w-full bg-yellow-200 text-black border border-yellow-400 rounded px-2 py-1 text-sm"
                            value={Number((it.dynamic || ({} as any)).buildLabor || 0) || 0}
                            onValueChange={(v) => setSales((s) => ({
                              ...s,
                              items: s.items.map((x, i2) => (i2 === idx ? { ...x, dynamic: { ...(x.dynamic || {}), buildLabor: Number(v || 0) } } : x)),
                            }))}
                            placeholder="0.00"
                          />
                          <div className="text-[10px] text-zinc-800 mt-0.5">Labor has no markup</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
            </div>
          </div>
        </>
      );
    }
  // Special-case: 'Other' device type - allow adding arbitrary spec rows (description/value)
  if (it.deviceType === 'Other') {
    const specs: Array<{ desc?: string; value?: string }> = Array.isArray((it.dynamic as any)?.otherSpecs) ? (it.dynamic as any).otherSpecs : [];
      return (
        <>
          <div className="col-span-16">
            <div className="text-xs text-zinc-400">Custom specifications</div>
            <div className="mt-2">
              <div className="flex items-center gap-2">
                <button type="button" className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => addOtherSpec(idx)}>+ Add spec</button>
              </div>
              <div className="mt-2">
                <div className="flex flex-col gap-2">
                  {specs.map((s, si) => (
                    <div key={`other-spec-${si}`} className="flex items-center gap-2">
                      <input className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" placeholder="Spec Description" value={s?.desc || ''} onChange={(e) => updateOtherSpecField(idx, si, 'desc', (e.target as HTMLInputElement).value)} />
                      <input className="w-48 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" placeholder="Spec Value" value={s?.value || ''} onChange={(e) => updateOtherSpecField(idx, si, 'value', (e.target as HTMLInputElement).value)} />
                      <button className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" title="Remove" onClick={() => removeOtherSpec(idx, si)}>Remove</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      );
    }
  // Non-Custom types: render fields simply
  const fields = (dt && dt.type === 'Apple Devices') ? dt.fields.filter((f: any) => f.key !== 'device') : (dt?.fields || []);
    const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').split(' ').filter(Boolean).map((w) => {
      const up = w.toUpperCase(); return (w.length <= 3 && w === up) ? up : (w.charAt(0).toUpperCase() + w.slice(1));
    }).join(' ');
  const wideKeys = new Set(['model','description','ports','accessories','notes','screen','screenSize','cpu','gpuModel','gpuBrand','storage']);

  // Detect MacBook/iMac/Mac mini contexts across any device type (brand/model or Apple Devices family)
    const isMacBookContext = (() => {
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      const brand = String(it.brand || '').toLowerCase();
      const model = String(it.model || '').toLowerCase();
      const macFamily = family.includes('macbook');
      const macBrandModel = brand === 'apple' && (model.includes('macbook') || model.includes('air') || model.includes('pro'));
      return macFamily || macBrandModel;
    })();
    const isIMacContext = (() => {
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      const brand = String(it.brand || '').toLowerCase();
      const model = String(it.model || '').toLowerCase();
      const iMacFamily = family.includes('imac');
      const iMacBrandModel = brand === 'apple' && model.includes('imac');
      return iMacFamily || iMacBrandModel;
    })();
    const isAppleWatchContext = (() => {
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      const brand = String(it.brand || '').toLowerCase();
      const model = String(it.model || '').toLowerCase();
      const watchFamily = family.includes('apple watch') || family.includes('watch');
      const watchBrandModel = brand === 'apple' && model.includes('watch');
      return watchFamily || watchBrandModel;
    })();
    const isHomePodContext = (() => {
      if (it.deviceType !== 'Apple Devices') return false;
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      return family.includes('homepod');
    })();
    const isAppleTVContext = (() => {
      if (it.deviceType !== 'Apple Devices') return false;
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      return family.includes('apple tv');
    })();
    const isAirPodsMaxContext = (() => {
      if (it.deviceType !== 'Apple Devices') return false;
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      return family.includes('airpods') && family.includes('max');
    })();
    const isAirPodsNonMaxContext = (() => {
      if (it.deviceType !== 'Apple Devices') return false;
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      const isAirPods = family.includes('airpods');
      const isMax = family.includes('max');
      return isAirPods && !isMax;
    })();
    const isAppleAudioContext = (() => {
      if (it.deviceType !== 'Apple Devices') return false;
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      const audioFamilies = ['apple watch','airpods','airpods pro','airpods max','homepod'];
      return audioFamilies.some((k) => family.includes(k));
    })();
    const isMacMiniContext = (() => {
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      const brand = String(it.brand || '').toLowerCase();
      const model = String(it.model || '').toLowerCase();
      const miniFamily = family.includes('mac mini');
      const miniBrandModel = brand === 'apple' && model.includes('mini');
      return miniFamily || miniBrandModel;
    })();
    const isMacStudioContext = (() => {
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      const brand = String(it.brand || '').toLowerCase();
      const model = String(it.model || '').toLowerCase();
      const studioFamily = family.includes('mac studio');
      const studioBrandModel = brand === 'apple' && model.includes('studio');
      return studioFamily || studioBrandModel;
    })();
    const isMacProContext = (() => {
      const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
      const brand = String(it.brand || '').toLowerCase();
      const model = String(it.model || '').toLowerCase();
      const macProFamily = family.includes('mac pro');
      const macProBrandModel = brand === 'apple' && model.includes('mac pro');
      return macProFamily || macProBrandModel;
    })();

  // Build the normal field nodes first
  let effectiveFields = fields as any[];
    const isAppleDevicesSelection = it.deviceType === 'Apple Devices';
    if (isMacBookContext || isIMacContext) {
      effectiveFields = effectiveFields.filter((f: any) => f.key !== 'cpuGen' && f.key !== 'gpuBrand');
    } else if (isMacMiniContext) {
      // For Mac mini, remove CPU Gen and GPU Brand as requested
      effectiveFields = effectiveFields.filter((f: any) => f.key !== 'cpuGen' && f.key !== 'gpuBrand');
    } else if (isMacStudioContext || isMacProContext) {
      // Copy Mac mini behavior for Mac Studio and Mac Pro
      effectiveFields = effectiveFields.filter((f: any) => f.key !== 'cpuGen' && f.key !== 'gpuBrand');
    }
    // For any Apple Devices selection, hide GPU-related fields entirely (most Apple devices use integrated GPU)
    if (isAppleDevicesSelection) {
      effectiveFields = effectiveFields.filter((f: any) => f.key !== 'gpuBrand' && f.key !== 'gpuModel' && f.key !== 'gpuVram');
      // For Apple Devices that map to audio-like families, remove the Audio "Type" field
      if (isAppleAudioContext) {
        effectiveFields = effectiveFields.filter((f: any) => f.key !== 'audioType');
      }
      // For AirPods (non-Max), remove Color field entirely
      if (isAirPodsNonMaxContext) {
        effectiveFields = effectiveFields.filter((f: any) => f.key !== 'color');
      }
      // For HomePod, keep minimal inputs: remove Color and Features
      if (isHomePodContext) {
        effectiveFields = effectiveFields.filter((f: any) => f.key !== 'color' && f.key !== 'features');
      }
      // For Apple Watch, remove Features (we already manage Color with a curated palette)
      if (isAppleWatchContext) {
        effectiveFields = effectiveFields.filter((f: any) => f.key !== 'features');
      }
      // For Apple TV, keep only model/condition in the general UI by removing Apple Devices-specific fields
      if (isAppleTVContext) {
        effectiveFields = effectiveFields.filter((f: any) => !['storage','color','ports','accessories'].includes(f.key));
      }
    }
    // Gaming Laptop: we'll render storage rows in a custom layout; remove the stock storage fields here
    if (dt?.type === 'Gaming Laptop') {
      effectiveFields = effectiveFields.filter((f: any) => !['bootDriveType','bootDriveStorage','secondaryStorage1Type','secondaryStorage1Storage'].includes(f.key));
    }
  const fieldNodes = effectiveFields.map((f: any) => {
      const value = (it.dynamic || ({} as any))[f.key] || '';
      const colClass = (f.key === 'ports' || f.key === 'accessories') ? 'col-span-12' : (f.type === 'text' || wideKeys.has(f.key) ? 'col-span-4' : 'col-span-2');
      // If this is a CPU field in a MacBook/iMac/Mac mini context, override options to family-appropriate CPUs
      let overriddenOptions: string[] | undefined = undefined;
      // Override Color for specific Apple families
      if (f.key === 'color') {
        if (isAppleWatchContext) {
          const watchColors = [
            // Aluminum and general
            'Midnight','Starlight','Silver','(PRODUCT)RED','Blue','Green','Pink','Yellow','Purple','White','Black','Space Gray',
            // Stainless
            'Graphite','Gold','Space Black',
            // Titanium / Ultra
            'Natural Titanium','Black Titanium',
            'Other'
          ];
          overriddenOptions = watchColors;
        } else if (isAirPodsMaxContext) {
          const maxColors = ['Space Gray','Silver','Sky Blue','Green','Pink','Other'];
          overriddenOptions = maxColors;
        }
      }
      if (f.key === 'cpu' && (isMacBookContext || isIMacContext || isMacMiniContext || isMacStudioContext || isMacProContext)) {
        if (isIMacContext) {
          // iMac: Intel i3/i5/i7/i9 and Apple M1/M3 (no Pro/Max/Ultra)
          const intelIMac = ['Intel Core i3','Intel Core i5','Intel Core i7','Intel Core i9','Intel Xeon W'];
          const appleIMac = ['M1','M3'];
          overriddenOptions = [...intelIMac, ...appleIMac, 'Other'];
        } else if (isMacMiniContext) {
          // Mac mini: Intel i3/i5/i7 and Apple M1/M2/M2 Pro (no Max/Ultra)
          const intelMini = ['Intel Core i3','Intel Core i5','Intel Core i7'];
          const appleMini = ['M1','M2','M2 Pro'];
          overriddenOptions = [...intelMini, ...appleMini, 'Other'];
        } else if (isMacStudioContext) {
          // Mac Studio: Apple Silicon only (Max/Ultra tiers)
          const appleStudio = ['M1 Max','M1 Ultra','M2 Max','M2 Ultra'];
          overriddenOptions = [...appleStudio, 'Other'];
        } else if (isMacProContext) {
          // Mac Pro: Intel Xeon W (2019) or Apple Silicon M2 Ultra (2023+)
          const xeonPro = ['Intel Xeon W-3223','Intel Xeon W-3235','Intel Xeon W-3245','Intel Xeon W-3265','Intel Xeon W-3275','Intel Xeon W (Other)'];
          const applePro = ['M2 Ultra'];
          overriddenOptions = [...xeonPro, ...applePro, 'Other'];
        } else {
          // MacBook: Intel i5/i7 and Apple M1-M4 (no Ultra)
          const intelMacBook = ['Intel Core i5', 'Intel Core i7'];
          const appleMacBook = ['M1','M1 Pro','M1 Max','M2','M2 Pro','M2 Max','M3','M3 Pro','M3 Max','M4','M4 Pro','M4 Max'];
          overriddenOptions = [...intelMacBook, ...appleMacBook, 'Other'];
        }
      }
      const hasOptions = Array.isArray(f.options) && f.options.length > 0;
      // Prefer overridden options, but for OS fields prefer device-specific lists
      let optionsToUse = overriddenOptions ?? (hasOptions ? (f.options as string[]) : undefined);
      if (f.key === 'os') {
        try {
          const family = (it.dynamic || ({} as any)).device || it.brand || undefined;
          optionsToUse = getOsOptions(it.deviceType, family as string | undefined);
        } catch {
          // fallback to existing optionsToUse
        }
      }
      const control = optionsToUse ? (
        <ComboInput
          value={value}
          onChange={(v) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [f.key]: v } } : x)) }))}
          options={optionsToUse}
          placeholder={`Select ${String(f.label || titleCase(f.key)).toLowerCase()}...`}
        />
      ) : (
        <input
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
          value={value}
          onChange={(e) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [f.key]: (e.target as HTMLInputElement).value } } : x)) }))}
          placeholder={String(f.label || titleCase(f.key))}
        />
      );
      return (
        <div key={f.key} className={colClass}>
          <label className="block text-xs text-zinc-400 mb-1">{f.label || titleCase(f.key)}</label>
          {control}
        </div>
      );
    });

    // MacBook/iMac additions: add Screen Size field globally; add CPU field if missing (Apple Devices family)
    if (isMacBookContext || isIMacContext) {
      const setField = (key: string, v: string) => setSales((s) => ({
        ...s,
        items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [key]: v } } : x))
      }));
      const screenSizeVal = (it.dynamic || ({} as any)).screenSize || '';
      // Comprehensive sizes per family
      const macBookSizes = [
        '11.6"', // MacBook Air 11"
        '12"',   // 12-inch MacBook
        '13.3"', // Classic Air/Pro
        '13.6"', // M2 Air 13.6
        '14"', '14.2"', // 14-inch MBP (marketed 14, actual 14.2)
        '15"', '15.3"', '15.4"', // 15-inch Air (15.3) and older Pro (15.4)
        '16"', '16.2"' // 16-inch MBP (marketed 16, actual 16.2)
      ];
      const iMacSizes = [
        '21.5"',
        '24"',
        '27"'
      ];
      const screenSizes = isIMacContext ? iMacSizes : macBookSizes;
      // If a screenSize control isn't already defined, insert it just before 'Ports' (or nearest fallback)
      const hasScreenSize = effectiveFields.some((f: any) => f.key === 'screenSize');
      if (!hasScreenSize) {
        // Determine insert index using base field order
        let insertAt = effectiveFields.findIndex((f: any) => f.key === 'ports');
        if (insertAt < 0) insertAt = effectiveFields.findIndex((f: any) => f.key === 'accessories');
        if (insertAt < 0) insertAt = fieldNodes.length; // fallback: append at end
        fieldNodes.splice(
          Math.max(0, Math.min(insertAt, fieldNodes.length)),
          0,
          (
            <div key="screenSize" className={wideKeys.has('screenSize') ? 'col-span-4' : 'col-span-2'}>
              <label className="block text-xs text-zinc-400 mb-1">Screen Size</label>
              <ComboInput value={screenSizeVal} onChange={(v) => setField('screenSize', v)} options={screenSizes} placeholder="Select screen size..." />
            </div>
          )
        );
      }
      // If in Apple Devices (no CPU field present), add CPU dropdown; else CPU exists and is already overridden above
      const cpuVal = (it.dynamic || ({} as any)).cpu || '';
      const hasCpuField = effectiveFields.some((f: any) => f.key === 'cpu');
      if (!hasCpuField && dt?.type === 'Apple Devices') {
        let cpuOptions: string[];
        if (isIMacContext) {
          const intelIMac = ['Intel Core i3','Intel Core i5','Intel Core i7','Intel Core i9','Intel Xeon W'];
          const appleIMac = ['M1','M3'];
          cpuOptions = [...intelIMac, ...appleIMac, 'Other'];
        } else if (isMacMiniContext) {
          const intelMini = ['Intel Core i3','Intel Core i5','Intel Core i7'];
          const appleMini = ['M1','M2','M2 Pro'];
          cpuOptions = [...intelMini, ...appleMini, 'Other'];
        } else if (isMacStudioContext) {
          const appleStudio = ['M1 Max','M1 Ultra','M2 Max','M2 Ultra'];
          cpuOptions = [...appleStudio, 'Other'];
        } else if (isMacProContext) {
          const xeonPro = ['Intel Xeon W-3223','Intel Xeon W-3235','Intel Xeon W-3245','Intel Xeon W-3265','Intel Xeon W-3275','Intel Xeon W (Other)'];
          const applePro = ['M2 Ultra'];
          cpuOptions = [...xeonPro, ...applePro, 'Other'];
        } else {
          const intelMacBook = ['Intel Core i5','Intel Core i7'];
          const appleMacBook = ['M1','M1 Pro','M1 Max','M2','M2 Pro','M2 Max','M3','M3 Pro','M3 Max','M4','M4 Pro','M4 Max'];
          cpuOptions = [...intelMacBook, ...appleMacBook, 'Other'];
        }
        fieldNodes.push(
          <div key="cpu-macbook" className={wideKeys.has('cpu') ? 'col-span-4' : 'col-span-2'}>
            <label className="block text-xs text-zinc-400 mb-1">CPU</label>
            <ComboInput value={cpuVal} onChange={(v) => setField('cpu', v)} options={cpuOptions} placeholder="Select CPU..." />
          </div>
        );
      }
    }

    // Apple Watch additions: add Size (mm) and Band Color fields; ensure Color list is overridden above
    if (it.deviceType === 'Apple Devices' && isAppleWatchContext) {
      const setField = (key: string, v: string) => setSales((s) => ({
        ...s,
        items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [key]: v } } : x))
      }));
      const sizeVal = (it.dynamic || ({} as any)).watchSize || '';
      const bandColorVal = (it.dynamic || ({} as any)).bandColor || '';
      const watchSizes = ['38 mm','40 mm','41 mm','42 mm','44 mm','45 mm','49 mm'];
      const bandColors = [
        'Midnight','Starlight','Black','White','Storm Blue','Clay','Cypress','Pink','(PRODUCT)RED','Orange','Yellow','Blue','Green','Purple','Beige','Brown','Gray','Graphite','Gold','Silver','Natural Titanium','Other'
      ];
      // Insert Size right after Color when possible
      let insertAfter = effectiveFields.findIndex((f: any) => f.key === 'color');
      if (insertAfter < 0) insertAfter = fieldNodes.length - 1;
      const sizeNode = (
        <div key="watchSize" className={wideKeys.has('screen') ? 'col-span-4' : 'col-span-2'}>
          <label className="block text-xs text-zinc-400 mb-1">Size (mm)</label>
          <ComboInput value={sizeVal} onChange={(v) => setField('watchSize', v)} options={watchSizes} placeholder="Select size..." />
        </div>
      );
      fieldNodes.splice(Math.max(0, insertAfter + 1), 0, sizeNode);
      // Insert Band Color right after Size
      const bandNode = (
        <div key="bandColor" className={wideKeys.has('screen') ? 'col-span-4' : 'col-span-2'}>
          <label className="block text-xs text-zinc-400 mb-1">Band Color</label>
          <ComboInput value={bandColorVal} onChange={(v) => setField('bandColor', v)} options={bandColors} placeholder="Select band color..." />
        </div>
      );
      // Recompute insertion point: after the just-inserted size
      insertAfter = Math.min(fieldNodes.length - 1, Math.max(0, insertAfter + 1));
      fieldNodes.splice(Math.max(0, insertAfter + 1), 0, bandNode);
    }

  // Apple Devices: ensure an Accessories text field exists for all Apple items (insert after Ports when present)
  if (it.deviceType === 'Apple Devices' && !isAppleTVContext) {
      const hasAccessories = effectiveFields.some((f: any) => f.key === 'accessories');
      if (!hasAccessories) {
        const accessoriesVal = (it.dynamic || ({} as any)).accessories || '';
        // Insert after 'ports' if present; else append at end
        let insertAt = effectiveFields.findIndex((f: any) => f.key === 'ports');
        if (insertAt < 0) insertAt = fieldNodes.length - 1;
        fieldNodes.splice(
          Math.max(0, insertAt + 1),
          0,
          (
            <div key="accessories" className="col-span-12">
              <label className="block text-xs text-zinc-400 mb-1">Accessories</label>
              <input
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                value={accessoriesVal}
                onChange={(e) => setSales((s) => ({
                  ...s,
                  items: s.items.map((x, i) => (i === idx
                    ? { ...x, dynamic: { ...(x.dynamic || {}), accessories: (e.target as HTMLInputElement).value } }
                    : x))
                }))}
                placeholder="Accessories (included items, cables, box, etc.)"
              />
            </div>
          )
        );
      }
    }

    // Gaming Laptop: add two simple text boxes under Display Resolution and above Ports
    if (dt?.type === 'Gaming Laptop') {
      const s1 = (it.dynamic || ({} as any)).bootDriveType || '';
      const s2 = (it.dynamic || ({} as any)).bootDriveStorage || '';
      const setField = (key: 'bootDriveType' | 'bootDriveStorage', v: string) => setSales((s) => ({
        ...s,
        items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [key]: v } } : x))
      }));
      // Options for dropdowns
      const driveTypeOptions = ['M.2 NVMe','SATA SSD','HDD','NVMe (SATA)','eMMC','Integrated','External','Other'];
      const storageSizeOptions = ['128 GB','256 GB','500 GB','512 GB','1 TB','2 TB','4 TB','8 TB','Other'];
  // Place directly above the Ports field; fallback above Accessories; else append at end
  // IMPORTANT: compute index from effectiveFields (not from fieldNodes element keys, which aren't accessible)
  let insertAt = effectiveFields.findIndex((f: any) => f.key === 'ports');
  if (insertAt < 0) insertAt = effectiveFields.findIndex((f: any) => f.key === 'accessories');
  if (insertAt < 0) insertAt = fieldNodes.length;

      // Insert a full-width break to force a brand-new row, then the boot row starting at the far left
      const bootBreak = (<div key="gl-boot-break" className="col-span-16" />);
      // Optional second storage toggle
      const addSecond = Boolean((it.dynamic as any)?.addSecondStorage);
      const setAddSecond = (v: boolean) => setSales((s) => ({
        ...s,
        items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), addSecondStorage: v } } : x))
      }));
      // Wrapper row spanning full width so fields start at left; single row with two columns
      const bootWrapper = (
        <div key="gl-boot-row" className="col-span-16 col-start-1 mt-3">
          <div className="flex items-end gap-2">
            <div className="grid grid-cols-16 gap-2 flex-1">
              <div className="col-span-8">
                <label className="block text-xs text-zinc-400 mb-1">Boot Drive Type</label>
                <ComboInput
                  value={s1}
                  onChange={(v) => setField('bootDriveType', v)}
                  options={driveTypeOptions}
                  placeholder="Select drive type..."
                />
              </div>
              <div className="col-span-8">
                <label className="block text-xs text-zinc-400 mb-1">Storage Size</label>
                <ComboInput
                  value={s2}
                  onChange={(v) => setField('bootDriveStorage', v)}
                  options={storageSizeOptions}
                  placeholder="Select storage size..."
                />
              </div>
            </div>
            {!addSecond && (
              <button
                type="button"
                className="self-end px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded whitespace-nowrap"
                onClick={() => setAddSecond(true)}
              >
                + Add second storage
              </button>
            )}
          </div>
        </div>
      );
      fieldNodes.splice(Math.max(0, insertAt), 0, bootBreak, bootWrapper);

      if (addSecond) {
        const s2t = (it.dynamic || ({} as any)).secondaryStorage1Type || '';
        const s2s = (it.dynamic || ({} as any)).secondaryStorage1Storage || '';
        const setSecond = (key: 'secondaryStorage1Type' | 'secondaryStorage1Storage', v: string) => setSales((s) => ({
          ...s,
          items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), [key]: v } } : x))
        }));
        const secondWrapper = (
          <div key="gl-second-row" className="col-span-16 col-start-1 mt-2">
            <div className="flex items-end gap-2">
              <div className="grid grid-cols-16 gap-2 flex-1">
                <div className="col-span-8">
                  <label className="block text-xs text-zinc-400 mb-1">2nd Storage Type</label>
                  <ComboInput
                    value={s2t}
                    onChange={(v) => setSecond('secondaryStorage1Type', v)}
                    options={driveTypeOptions}
                    placeholder="Select drive type..."
                  />
                </div>
                <div className="col-span-8">
                  <label className="block text-xs text-zinc-400 mb-1">2nd Storage Size</label>
                  <ComboInput
                    value={s2s}
                    onChange={(v) => setSecond('secondaryStorage1Storage', v)}
                    options={storageSizeOptions}
                    placeholder="Select storage size..."
                  />
                </div>
              </div>
              <button
                type="button"
                className="self-end px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded whitespace-nowrap"
                onClick={() => setAddSecond(false)}
              >
                Remove second storage
              </button>
            </div>
          </div>
        );
        fieldNodes.splice(Math.max(0, insertAt + 2), 0, secondWrapper);
      }
    }

    // TV: inject Smart TV checkbox + conditional OS dropdown after the HDR field
    if (dt?.type === 'TV') {
      const isSmart = Boolean((it.dynamic as any)?.tvIsSmart);
      const setIsSmart = (v: boolean) => setSales((s) => ({
        ...s,
        items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), tvIsSmart: v } } : x))
      }));
      const tvOsVal = (it.dynamic || ({} as any)).tvOs || '';
      const tvOsOptions = ['Android TV','Google TV','Roku TV','Fire TV (Amazon)','Tizen (Samsung)','webOS (LG)','VIDAA (Hisense)','MyHomeScreen (Philips)','SmartCast (Vizio)','Other'];
      const setTvOs = (v: string) => setSales((s) => ({
        ...s,
        items: s.items.map((x, i) => (i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), tvOs: v } } : x))
      }));
      // Insert after the HDR field node (or refreshRate, or append)
      let insertAt = effectiveFields.findIndex((f: any) => f.key === 'hdr');
      if (insertAt < 0) insertAt = effectiveFields.findIndex((f: any) => f.key === 'refreshRate');
      const insertIdx = insertAt >= 0 ? insertAt + 1 : fieldNodes.length;
      const smartNode = (
        <div key="tvIsSmart" className="col-span-16 col-start-1">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[#39FF14]"
                checked={isSmart}
                onChange={(e) => {
                  setIsSmart((e.target as HTMLInputElement).checked);
                  if (!(e.target as HTMLInputElement).checked) setTvOs('');
                }}
              />
              Smart TV?
            </label>
            {isSmart && (
              <div className="flex-1 max-w-xs">
                <ComboInput
                  value={tvOsVal}
                  onChange={setTvOs}
                  options={tvOsOptions}
                  placeholder="Select Smart TV OS..."
                />
              </div>
            )}
          </div>
        </div>
      );
      fieldNodes.splice(Math.max(0, Math.min(insertIdx, fieldNodes.length)), 0, smartNode);
    }

    // If this is a Drone, append the ad-hoc droneSpecs editor (behaves like 'Other')
    if (dt?.type === 'Drone') {
      const specs: Array<{ desc?: string; value?: string }> = Array.isArray((it.dynamic as any)?.droneSpecs) ? (it.dynamic as any).droneSpecs : [];
      const specsNode = (
        <div key="drone-specs" className="col-span-16">
          <div className="text-xs text-zinc-400">Additional Drone specifications</div>
          <div className="mt-2">
            <div className="flex items-center gap-2">
              <button type="button" className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={() => addDroneSpec(idx)}>+ Add spec</button>
            </div>
            <div className="mt-2">
              <div className="flex flex-col gap-2">
                {specs.map((s, si) => (
                  <div key={`drone-spec-${si}`} className="flex items-center gap-2">
                    <input className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" placeholder="Spec Description" value={s?.desc || ''} onChange={(e) => updateDroneSpecField(idx, si, 'desc', (e.target as HTMLInputElement).value)} />
                    <input className="w-48 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" placeholder="Spec Value" value={s?.value || ''} onChange={(e) => updateDroneSpecField(idx, si, 'value', (e.target as HTMLInputElement).value)} />
                    <button className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" title="Remove" onClick={() => removeDroneSpec(idx, si)}>Remove</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      );
      return [...fieldNodes, specsNode];
    }

    return fieldNodes;
  }

  return (
    <div className="gb-quote-window min-h-screen bg-zinc-900 text-gray-100 p-4">
      <div className="gb-quote-layout max-w-7xl mx-auto grid grid-cols-12 gap-4">
        {/* Main content */}
  <div className="gb-quote-main col-span-9 space-y-4">
          <div className="gb-quote-header flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={publicAsset('logo.png')} alt="Logo" className="w-10 h-10 object-contain" />
              <h1 className="text-2xl font-bold text-[#39FF14]">Generate Quote</h1>
            </div>
            <div className="gb-quote-mode-switch" role="tablist" aria-label="Quote type">
              <button
                type="button"
                className={mode === 'sales' ? 'active' : ''}
                aria-selected={mode === 'sales'}
                onClick={() => setMode('sales')}
              >
                Sales
              </button>
              <button
                type="button"
                className={mode === 'repairs' ? 'active' : ''}
                aria-selected={mode === 'repairs'}
                onClick={() => setMode('repairs')}
              >
                Repairs
              </button>
            </div>
          </div>

        {mode === 'sales' && (
          <div className="gb-quote-card bg-zinc-800 border border-zinc-700 rounded p-3 space-y-3">
            {renderQuoteClientPanel('sales')}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-200">Items</h3>
                <button className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={addSaleItem}>+ Add Item</button>
              </div>
              <div className="gb-quote-item-list space-y-2">
                {sales.items.map((it, idx) => (
                  <div key={idx} className="gb-quote-item-card border border-zinc-700 rounded p-2">
                    <div className="gb-quote-item-header flex items-center justify-between">
                      <label className="flex items-center gap-2 min-w-0">
                        {createSaleSelecting && (
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[#39FF14]"
                            checked={!!createSaleSelected[idx]}
                            onChange={(e) => setCreateSaleSelected((prev) => ({ ...prev, [idx]: (e.target as HTMLInputElement).checked }))}
                          />
                        )}
                        <div className="text-sm text-zinc-300 truncate">{quoteItemTitle(it, idx)}</div>
                      </label>
                      <div className="flex justify-end gap-1">
                        <button className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" title={it.expanded ? 'Hide details' : 'Show details'} onClick={() => toggleSaleItemExpanded(idx)}>{it.expanded ? 'v' : '>'}</button>
                        <button className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" title="Remove" onClick={() => removeSaleItem(idx)}>Remove</button>
                      </div>
                    </div>
                    {it.expanded && (
                      <div className="gb-quote-item-fields mt-2 grid grid-cols-16 gap-2">
                        {/* Images at the top */}
                        {it.deviceType !== 'Custom PC' && (
                        <div className="col-span-16">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-xs text-zinc-400">Images (max 3)</label>
                            <button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded disabled:opacity-50" disabled={(it.images?.length || 0) >= 3} onClick={() => {
                              const input = document.createElement('input');
                              input.type = 'file';
                              input.accept = 'image/*';
                              input.multiple = true;
                              input.onchange = (e: any) => addImagesToItem(idx, (e.target as HTMLInputElement).files);
                              input.click();
                            }}>Add Image</button>
                          </div>
                          <div className="flex gap-2 items-center overflow-x-auto whitespace-nowrap min-h-[40px] rounded border border-dashed border-zinc-700 p-2" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void addImagesToItem(idx, event.dataTransfer.files); }}>
                            {it.images && it.images.length > 0 ? (
                              it.images.map((src, i) => (
                                <div key={i} className="relative w-20 h-20 flex-none border border-zinc-700 rounded overflow-hidden">
                                  <img src={src} alt={`Item ${idx + 1} Image ${i + 1}`} className="w-full h-full object-cover" />
                                  <button className="absolute top-0 right-0 m-0.5 bg-black/70 text-white text-[10px] leading-none px-1 rounded" onClick={() => removeImageFromItem(idx, i)} title="Remove">X</button>
                                </div>
                              ))
                            ) : (
                              <div className="text-xs text-zinc-500">No images added</div>
                            )}
                          </div>
                        </div>
                        )}
                        <div className={it.deviceType === 'Custom PC' ? 'col-span-16' : 'col-span-4'}>
                          <label className="block text-xs text-zinc-400 mb-1">Device Type</label>
                          <ComboInput
                            value={it.deviceType || ''}
                            onChange={(v) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, deviceType: v || undefined, dynamic: {} } : x)) }))}
                            options={deviceTypeOptions}
                            placeholder="Type or select..."
                          />
                          {/* If Apple Devices, render the Apple family selector inline beneath Device Type to preserve a single row for Device Type/Model/Condition */}
                          {it.deviceType === 'Apple Devices' && (() => {
                            const appleDeviceOptions = deviceTypes
                              .find((d) => d.type === 'Apple Devices')?.fields
                              .find((f) => f.key === 'device')?.options || ['iPhone', 'iPad', 'MacBook', 'iMac'];
                            return (
                              <div className="mt-1">
                                <label className="sr-only">Apple Family</label>
                                <ComboInput
                                  value={it.dynamic?.device || ''}
                                  onChange={(v) =>
                                    setSales((s) => ({
                                      ...s,
                                      items: s.items.map((x, i) => (
                                        i === idx ? { ...x, dynamic: { ...(x.dynamic || {}), device: v } } : x
                                      )),
                                    }))
                                  }
                                  options={appleDeviceOptions}
                                  placeholder="Apple family..."
                                />
                              </div>
                            );
                          })()}
                        </div>
                        {it.deviceType !== 'Custom PC' && (
                          <>
                            <div className="col-span-8">
                              <label className="block text-xs text-zinc-400 mb-1">Model</label>
                              {it.deviceType === 'Apple Devices' && (() => {
                                // Provide a dropdown for Apple TV models; fallback to text for other families
                                const family = String(((it.dynamic || ({} as any)).device || '')).toLowerCase();
                                const isAppleTV = family.includes('apple tv');
                                const isHomePod = family.includes('homepod');
                                if (isAppleTV) {
                                  const appleTvModels = [
                                    'Apple TV (2nd Gen) - 8 GB',
                                    'Apple TV (3rd Gen) - 8 GB',
                                    'Apple TV HD (2015) - 32 GB',
                                    'Apple TV 4K (2017) - 32 GB',
                                    'Apple TV 4K (2017) - 64 GB',
                                    'Apple TV 4K (2021) - 32 GB',
                                    'Apple TV 4K (2021) - 64 GB',
                                    'Apple TV 4K (2022) - 64 GB (Wi-Fi)',
                                    'Apple TV 4K (2022) - 128 GB (Wi-Fi + Ethernet)',
                                    'Other'
                                  ];
                                  return (
                                    <ComboInput
                                      value={it.model || ''}
                                      onChange={(v) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, model: v } : x)) }))}
                                      options={appleTvModels}
                                      placeholder="Select model..."
                                    />
                                  );
                                } else if (isHomePod) {
                                  const homePodModels = [
                                    'HomePod (1st Gen)',
                                    'HomePod (2nd Gen)',
                                    'HomePod mini',
                                    'Other'
                                  ];
                                  return (
                                    <ComboInput
                                      value={it.model || ''}
                                      onChange={(v) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, model: v } : x)) }))}
                                      options={homePodModels}
                                      placeholder="Select model..."
                                    />
                                  );
                                }
                                return null;
                              })()}
                              {!(it.deviceType === 'Apple Devices' && (String(((it.dynamic || ({} as any)).device || '')).toLowerCase().includes('apple tv') || String(((it.dynamic || ({} as any)).device || '')).toLowerCase().includes('homepod'))) && (
                                <input
                                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                                  value={it.model || ''}
                                  onChange={(e) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, model: e.target.value } : x)) }))}
                                  placeholder={it.deviceType ? `${it.deviceType} model` : 'Model'}
                                />
                              )}
                            </div>
                            <div className="col-span-4">
                              <label className="block text-xs text-zinc-400 mb-1">Condition</label>
                              <ComboInput
                                value={it.condition || ''}
                                onChange={(v) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, condition: v } : x)) }))}
                                options={['New', 'Like New', 'Excellent', 'Good', 'Fair', 'Poor', 'For Parts']}
                                placeholder="Type or select..."
                              />
                            </div>
                          </>
                        )}
                        {renderDynamicFields(it, idx)}

                        {/* Price will be shown next to the AI paste box to improve alignment */}

                        {/* AI Copy Prompt button + response textarea under all fields (except Custom Build) */}
                        {it.deviceType !== 'Custom Build' && (
                        <div className="col-span-12 mt-2">
                          <div className="mb-2">
                            <div className="text-xs text-zinc-400">Generate a ready-to-use AI prompt for this item.</div>
                          </div>
                          <label className="block text-xs text-zinc-400 mb-1">AI Response (paste/edit)</label>
                          <textarea
                            rows={8}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm resize-y"
                            placeholder="Paste the AI-generated sales paragraph here."
                            value={it.prompt || ''}
                            onChange={(e) =>
                              setSales((s) => ({
                                ...s,
                                items: s.items.map((x, i) => (i === idx ? { ...x, prompt: e.target.value } : x)),
                              }))
                            }
                          />
                          <div className="flex items-center justify-end mt-2">
                            <button
                              className="px-3 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded hover:bg-zinc-600"
                              onClick={() => copyPromptForItem(idx)}
                              title="Copy AI prompt to clipboard"
                            >
                              Copy AI Prompt
                            </button>
                          </div>
                        </div>
                        )}
                        {it.deviceType !== 'Custom Build' && it.deviceType !== 'Custom PC' && (
                        <div className="col-span-8 grid grid-cols-8 gap-2 items-start">
                          <div className="col-span-4">
                            <label className="block text-xs text-zinc-400 mb-1">Source URL</label>
                            <div className="flex items-center gap-2">
                              <input
                                type="url"
                                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                                value={it.url || ''}
                                onChange={(e) => setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, url: (e.target as HTMLInputElement).value } : x)) }))}
                                placeholder="https://example.com/product"
                              />
                              <button
                                type="button"
                                className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded hover:bg-zinc-600"
                                onClick={async () => {
                                  try {
                                    const u = (it.url || '').trim();
                                    if (!u) return;
                                    // Try to open via preload API; fallback to window.open
                                    if ((window as any).api?.openUrl) {
                                      await (window as any).api.openUrl(u);
                                    } else {
                                      window.open(u, '_blank');
                                    }
                                  } catch (_) {
                                    try { window.open((it.url || ''), '_blank'); } catch {}
                                  }
                                }}
                                disabled={!it.url}
                                title="Open in default browser"
                              >Open</button>
                            </div>
                            <div className="text-[10px] text-zinc-400 mt-0.5">Optional link to supplier or reference</div>
                          </div>
                          <div className="col-span-4 mt-2">
                            <div className="flex gap-2 items-end">
                              <div className="flex-1">
                                <label className="block text-xs text-zinc-400 mb-1">Cost (pre-markup)</label>
                                <MoneyInput
                                  className="w-full bg-yellow-200 text-black border border-yellow-400 rounded px-2 py-1 text-sm"
                                  value={Number(it.internalCost || 0) || 0}
                                  onValueChange={(v) => {
                                    const cost = Number(v || 0);
                                    const pct = Number(it.markupPct || 0);
                                    const price = cost > 0 && pct > 0 ? Math.round(cost * (1 + pct / 100) * 100) / 100 : cost;
                                    setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, internalCost: v, price } : x)) }));
                                  }}
                                  placeholder="0.00"
                                />
                              </div>
                              <div className="w-24">
                                <label className="block text-xs text-zinc-400 mb-1">Markup %</label>
                                <PercentInput
                                  value={it.markupPct ?? ''}
                                  onChange={(pct) => {
                                    const cost = Number(it.internalCost || 0);
                                    const p = Number(pct || 0);
                                    const price = cost > 0 && p > 0 ? Math.round(cost * (1 + p / 100) * 100) / 100 : cost;
                                    setSales((s) => ({ ...s, items: s.items.map((x, i) => (i === idx ? { ...x, markupPct: pct, price } : x)) }));
                                  }}
                                  presets={[5, 10, 15, 20, 25, 30, 40, 50, 75, 100]}
                                />
                              </div>
                            </div>
                            {(() => { const cost = Number(it.internalCost || 0); const pct = Number(it.markupPct || 0); const price = Number(it.price || 0); return cost > 0 && pct > 0 && price > 0 ? (<div className="text-[10px] text-[#39FF14] mt-1">Sell price: ${price.toFixed(2)} (before tax)</div>) : (<div className="text-[10px] text-zinc-400 mt-1">Printed total is before tax</div>); })()}
                          </div>
                        </div>
                        )}
                        
                        
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {mode === 'repairs' && (
          <div className="gb-quote-card bg-zinc-800 border border-zinc-700 rounded p-3 space-y-3">
            {renderQuoteClientPanel('repairs')}
            <div className="gb-quote-repair-picker grid grid-cols-12 gap-3">
              <div className="col-span-4">
                <label className="block text-xs text-zinc-400 mb-1">Device Category</label>
                <select className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" value={repairs.selectedCategoryId} onChange={(e) => setRepairs((s) => ({ ...s, selectedCategoryId: e.target.value, selectedRepairId: '' }))} onFocus={(e) => (e.target as HTMLSelectElement).showPicker?.()}>
                  <option value="">All</option>
                </select>
              </div>
              <div className="col-span-6">
                <label className="block text-xs text-zinc-400 mb-1">Repair</label>
                <select className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" value={repairs.selectedRepairId} onChange={(e) => setRepairs((s) => ({ ...s, selectedRepairId: e.target.value }))} onFocus={(e) => (e.target as HTMLSelectElement).showPicker?.()}>
                  <option value="">Select...</option>
                </select>
              </div>
              <div className="col-span-2 flex items-end"><button className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-sm disabled:opacity-50" disabled={!repairs.selectedRepairId} onClick={addSelectedRepairLine}>Add</button></div>
            </div>
            <div className="flex items-center justify-between mt-2">
              <h3 className="text-sm font-semibold text-zinc-200">Lines</h3>
              <button className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={addRepairLine}>+ Add Line</button>
            </div>
            <div className="space-y-2">
              {repairs.lines.map((ln, idx) => (
                <div key={idx} className="space-y-1">
                  <div className="gb-quote-repair-line grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-7"><Field label="Description" value={ln.description} onChange={(v) => setRepairs((r) => ({ ...r, lines: r.lines.map((x, i) => (i === idx ? { ...x, description: v } : x)) }))} /></div>
                    <div className="col-span-2"><Field label="Part Price" value={ln.partPrice} onChange={(v) => setRepairs((r) => ({ ...r, lines: r.lines.map((x, i) => (i === idx ? { ...x, partPrice: v } : x)) }))} /></div>
                    <div className="col-span-2"><Field label="Labor Price" value={ln.laborPrice} onChange={(v) => setRepairs((r) => ({ ...r, lines: r.lines.map((x, i) => (i === idx ? { ...x, laborPrice: v } : x)) }))} /></div>
                    <div className="col-span-1 flex justify-end"><button className="px-2 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded" title="Remove" onClick={() => removeRepairLine(idx)}>Remove</button></div>
                  </div>
                  <div className="flex items-center gap-2 pl-1 flex-wrap">
                    <span className="text-xs text-zinc-500">Cost →</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={ln.lineCost ?? ''}
                      onChange={(e) => setRepairs((r) => ({ ...r, lines: r.lines.map((x, i) => (i === idx ? { ...x, lineCost: e.target.value } : x)) }))}
                      placeholder="0.00"
                      className="w-20 bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs focus:border-[#39FF14] focus:outline-none"
                    />
                    <select
                      value={ln.lineMarkupPct ?? ''}
                      onChange={(e) => setRepairs((r) => ({ ...r, lines: r.lines.map((x, i) => (i === idx ? { ...x, lineMarkupPct: e.target.value } : x)) }))}
                      className="bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs focus:border-[#39FF14] focus:outline-none"
                    >
                      <option value="">— markup —</option>
                      <option value="5">5%</option>
                      <option value="10">10%</option>
                      <option value="15">15%</option>
                      <option value="20">20%</option>
                      <option value="25">25%</option>
                      <option value="30">30%</option>
                      <option value="40">40%</option>
                      <option value="50">50%</option>
                      <option value="100">100%</option>
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={ln.lineMarkupPct ?? ''}
                      onChange={(e) => setRepairs((r) => ({ ...r, lines: r.lines.map((x, i) => (i === idx ? { ...x, lineMarkupPct: e.target.value } : x)) }))}
                      placeholder="%"
                      className="w-14 bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs focus:border-[#39FF14] focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={!ln.lineCost || !ln.lineMarkupPct}
                      onClick={() => {
                        const cost = Number(ln.lineCost || 0);
                        const pct = Number(ln.lineMarkupPct || 0);
                        if (cost > 0 && pct > 0) {
                          const price = (Math.round(cost * (1 + pct / 100) * 100) / 100).toFixed(2);
                          setRepairs((r) => ({ ...r, lines: r.lines.map((x, i) => (i === idx ? { ...x, partPrice: price } : x)) }));
                        }
                      }}
                      className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded text-xs disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      → Part Price
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="gb-quote-repair-total-grid grid grid-cols-3 gap-3 mt-2">
              <Field label="Notes" value={repairs.notes} onChange={(v) => setRepairs((s) => ({ ...s, notes: v }))} />
              <div className="col-span-2 bg-zinc-900 border border-zinc-700 rounded p-2">
                <div className="text-sm flex items-center justify-between"><span className="text-zinc-400">Parts</span><span className="font-semibold">${repairTotals.parts.toFixed(2)}</span></div>
                <div className="text-sm flex items-center justify-between mt-1"><span className="text-zinc-400">Labor</span><span className="font-semibold">${repairTotals.labor.toFixed(2)}</span></div>
                <div className="text-sm flex items-center justify-between mt-1"><span className="text-zinc-400">Total</span><span className="font-bold text-[#39FF14]">${repairTotals.total.toFixed(2)}</span></div>
              </div>
            </div>
          </div>
        )}

          <div className="gb-quote-action-bar flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-zinc-400 h-6 flex items-center">{saveMsg}</div>
          <div className="flex flex-wrap items-center gap-1">
            <button className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded text-xs disabled:opacity-50 whitespace-nowrap" disabled={saving} onClick={saveQuote}>{saving ? 'Saving...' : 'Save Quote'}</button>
            {mode === 'sales' && (
              <button
                className={`px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded text-xs disabled:opacity-50 whitespace-nowrap ${createSaleSelecting ? 'ring-2 ring-[#39FF14]' : ''}`}
                disabled={createSaleBusy}
                onClick={async () => {
                  if (createSaleBusy) return;
                  if (!createSaleSelecting) {
                    setCreateSaleSelecting(true);
                    setCreateSaleSelected({});
                    return;
                  }
                  await createSalesTicketFromSelection();
                }}
              >{createSaleBusy ? 'Creating...' : 'Create Sales form'}</button>
            )}
            <button
              className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded text-xs whitespace-nowrap"
              onClick={openHtmlPreview}
            >Digital</button>
            <button className="px-3 py-1.5 bg-violet-700 text-white rounded text-sm font-semibold hover:bg-violet-600 whitespace-nowrap" onClick={() => setShowOptionViewer(true)}>Option Viewer</button>
            <button className="px-3 py-1.5 bg-[#39FF14] text-black rounded text-sm font-semibold hover:bg-[#32E610] whitespace-nowrap" onClick={printPreview}>Show Preview</button>
          </div>
          </div>

          {showOptionViewer && <QuoteOptionViewer onClose={() => setShowOptionViewer(false)} />}

          {showHtmlPreview && (
            <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={closeHtmlPreview}>
              <div className={`absolute top-3 ${isModalShell ? 'right-16' : 'right-3'} flex items-center gap-2`} onClick={(e) => e.stopPropagation()}>
                <button
                  className="px-4 py-2 bg-blue-600 text-white rounded-md text-base font-semibold hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-400/50"
                  onClick={async () => {
                    try {
                      if (mode !== 'sales') return;
                      const html = await generateInteractiveSalesHtml();
                      const name = `Quote-${(sales.customerName || '').trim() || 'Customer'}`;
                      const api = (window as any).api;
                      if (api && typeof api.exportHtml === 'function') {
                        const res = await api.exportHtml(html, name);
                        if (res?.ok) { setSaveMsg('Saved interactive HTML'); } else if (!res?.canceled) { setSaveMsg('Could not save HTML'); }
                      } else {
                        downloadTextFile(`${name}.html`, html, 'text/html');
                        setSaveMsg('Downloaded interactive HTML');
                      }
                      setTimeout(() => setSaveMsg(null), 2000);
                    } catch {
                      setSaveMsg('Failed to export HTML'); setTimeout(() => setSaveMsg(null), 2000);
                    }
                  }}
                >Download</button>
                <button
                  className="px-4 py-2 bg-zinc-900 text-gray-100 border border-zinc-700 rounded-md text-base font-semibold hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-[#39FF14]/60"
                  onClick={sendHtmlToGmail}
                >Send to Email</button>
                <button
                  className="px-4 py-2 bg-zinc-800 text-gray-100 border border-zinc-700 rounded-md text-base font-semibold hover:bg-zinc-700"
                  onClick={openEmailSettings}
                >Email Settings</button>
                <button
                  className="px-4 py-2 bg-zinc-800 text-gray-100 border border-zinc-700 rounded-md text-base font-semibold hover:bg-zinc-700"
                  onClick={closeHtmlPreview}
                >Close</button>
              </div>

              {showEmailModal && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]" onClick={() => { if (!emailSending) setShowEmailModal(false); }}>
                  <div className="bg-zinc-900 text-gray-100 border border-zinc-700 rounded-lg w-[720px] max-w-[95vw] p-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-lg font-semibold">Send Quote Email</div>
                      <button className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded" onClick={() => { if (!emailSending) setShowEmailModal(false); }}>Close</button>
                    </div>
                    <div className="mt-3 grid grid-cols-12 gap-3 items-end">
                      <div className="col-span-12">
                        <div className="text-xs text-zinc-400 mb-1">To</div>
                        <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="customer@email.com" className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded" />
                      </div>
                      <div className="col-span-12">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-xs text-zinc-400 mb-1">From</div>
                            <div className="text-sm text-zinc-200">gadgetboysc@gmail.com</div>
                            <div className="text-[11px] text-zinc-400">Sender name: {emailFromName || 'GadgetBoy Repair & Retail'}</div>
                          </div>
                          <button type="button" className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm" disabled={emailSending} onClick={openEmailSettings}>Edit Email Settings</button>
                        </div>
                      </div>

                      <div className="col-span-12">
                        <div className="text-xs text-zinc-400 mb-1">Quote Email Attachment</div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className={`px-3 py-1.5 border rounded text-sm ${quoteEmailAttachmentMode === 'pdf' ? 'bg-[#39FF14] text-black border-[#39FF14]' : 'bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700'}`}
                            onClick={() => setQuoteEmailAttachmentMode('pdf')}
                            disabled={emailSending}
                          >PDF only</button>
                          <button
                            type="button"
                            className={`px-3 py-1.5 border rounded text-sm ${quoteEmailAttachmentMode === 'html' ? 'bg-[#39FF14] text-black border-[#39FF14]' : 'bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700'}`}
                            onClick={() => setQuoteEmailAttachmentMode('html')}
                            disabled={emailSending}
                          >HTML</button>
                          <div className="text-[11px] text-zinc-400">(PDF only sends a static copy)</div>
                        </div>
                      </div>

                      <div className="col-span-12">
                        <div className="flex items-end justify-between gap-2">
                          <div>
                            <div className="text-xs text-zinc-400 mb-1">Email Body</div>
                            <div className="text-[11px] text-zinc-400">Edit for this email, or save as the default for future emails.</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm"
                              disabled={emailSending || emailBodySavingDefault}
                              onClick={() => setEmailBodyDraft(getBuiltInQuoteEmailBody())}
                              title="Use the built-in default body for this send"
                            >Use built-in default</button>
                            <button
                              type="button"
                              className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm"
                              disabled={emailSending || emailBodySavingDefault}
                              onClick={async () => {
                                try {
                                  setEmailErr(null);
                                  setEmailBodySavingDefault(true);
                                  const res = await window.api.emailSetBodyTemplate(emailBodyDraft || '');
                                  if (!res?.ok) {
                                    setEmailErr(String(res?.error || 'Could not save default body'));
                                    return;
                                  }
                                  setEmailBodyTemplate(emailBodyDraft || '');
                                  setSaveMsg('Default email body saved');
                                  setTimeout(() => setSaveMsg(null), 1800);
                                } catch (e: any) {
                                  setEmailErr(String(e?.message || e || 'Could not save default body'));
                                } finally {
                                  setEmailBodySavingDefault(false);
                                }
                              }}
                              title="Save this body as the default for future emails"
                            >Save as default</button>
                            <button
                              type="button"
                              className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm"
                              disabled={emailSending || emailBodySavingDefault}
                              onClick={async () => {
                                try {
                                  setEmailErr(null);
                                  setEmailBodySavingDefault(true);
                                  const res = await window.api.emailSetBodyTemplate('');
                                  if (!res?.ok) {
                                    setEmailErr(String(res?.error || 'Could not clear saved default'));
                                    return;
                                  }
                                  setEmailBodyTemplate('');
                                  setEmailBodyDraft(getBuiltInQuoteEmailBody());
                                  setSaveMsg('Saved default body cleared');
                                  setTimeout(() => setSaveMsg(null), 1800);
                                } catch (e: any) {
                                  setEmailErr(String(e?.message || e || 'Could not clear saved default'));
                                } finally {
                                  setEmailBodySavingDefault(false);
                                }
                              }}
                              title="Clear the saved default and go back to the built-in body"
                            >Clear saved</button>
                          </div>
                        </div>
                        <textarea
                          value={emailBodyDraft}
                          onChange={(e) => setEmailBodyDraft(e.target.value)}
                          rows={6}
                          placeholder={getBuiltInQuoteEmailBody()}
                          className="mt-2 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm"
                        />
                        {!!emailBodyTemplate.trim() && (
                          <div className="mt-1 text-[11px] text-zinc-400">Using saved default body (edit above to override).</div>
                        )}
                        {!emailBodyTemplate.trim() && (
                          <div className="mt-1 text-[11px] text-zinc-400">No saved default body; using built-in default (edit above to override).</div>
                        )}
                      </div>

                      {!emailHasPassword && (
                        <div className="col-span-12">
                          <div className="text-sm text-yellow-200">Gmail App Password is not configured.</div>
                          <div className="text-[11px] text-zinc-400">Open Email Settings to paste the App Password for gadgetboysc@gmail.com.</div>
                        </div>
                      )}
                    </div>
                    {emailErr && (<div className="mt-3 text-sm text-red-300">{emailErr}</div>)}
                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded" disabled={emailSending} onClick={() => setShowEmailModal(false)}>Cancel</button>
                      <button className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded" disabled={emailSending} onClick={openEmailSettings}>Email Settings</button>
                      <button className="px-4 py-2 bg-[#39FF14] text-black font-semibold rounded" disabled={emailSending} onClick={doSendEmail}>{emailSending ? 'Sending...' : 'Send'}</button>
                    </div>
                  </div>
                </div>
              )}

              {showEmailSettings && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70]" onClick={() => { if (!emailSettingsSaving) setShowEmailSettings(false); }}>
                  <div className="bg-zinc-900 text-gray-100 border border-zinc-700 rounded-lg w-[760px] max-w-[95vw] p-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-lg font-semibold">Email Settings</div>
                      <button className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded" onClick={() => { if (!emailSettingsSaving) setShowEmailSettings(false); }}>Close</button>
                    </div>

                    <div className="mt-3">
                      <div className="text-xs text-zinc-400 mb-1">Sender Address</div>
                      <div className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm">gadgetboysc@gmail.com</div>
                    </div>

                    <div className="mt-3">
                      <div className="text-xs text-zinc-400 mb-1">Sender Display Name</div>
                      <input value={emailFromName} onChange={(e) => setEmailFromName(e.target.value)} className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded" />
                    </div>

                    <div className="mt-3">
                      <div className="text-xs text-zinc-400 mb-1">Gmail App Password</div>
                      <div className="text-[11px] text-zinc-400 mb-2">Required to send mail from inside the app. Stored encrypted in userData via Electron safeStorage.</div>
                      <div className="flex items-center gap-2">
                        <div className="text-sm">Status:</div>
                        <div className={`text-sm font-semibold ${emailHasPassword ? 'text-[#39FF14]' : 'text-yellow-200'}`}>{emailHasPassword ? 'Configured' : 'Not configured'}</div>
                        <div className="flex-1" />
                        {emailHasPassword && (
                          <button className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded" disabled={emailSettingsSaving} onClick={clearEmailPassword}>Clear Password</button>
                        )}
                      </div>
                      <input value={emailAppPassword} onChange={(e) => setEmailAppPassword(e.target.value)} placeholder={emailHasPassword ? 'Paste to replace password (optional)' : 'Paste app password'} className="mt-2 w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded" />
                    </div>

                    {emailSettingsErr && (<div className="mt-3 text-sm text-red-300">{emailSettingsErr}</div>)}

                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded" disabled={emailSettingsSaving} onClick={() => setShowEmailSettings(false)}>Cancel</button>
                      <button className="px-4 py-2 bg-[#39FF14] text-black font-semibold rounded" disabled={emailSettingsSaving} onClick={saveEmailSettings}>{emailSettingsSaving ? 'Saving...' : 'Save Settings'}</button>
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-white text-black w-[1100px] max-w-[95vw] max-h-[90vh] overflow-hidden rounded shadow-xl" onClick={(e) => e.stopPropagation()}>
                {htmlPreviewUrl ? (
                  <iframe
                    title="HTML Preview"
                    src={htmlPreviewUrl}
                    className="w-full h-[90vh]"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
                  />
                ) : (
                  <div className="p-6 text-sm">Loading...</div>
                )}
              </div>
            </div>
          )}

          {showPreview && (
            <div ref={quotePreviewRef} className="quote-customer-preview fixed inset-0 bg-zinc-950 flex items-center justify-center z-50" onClick={() => setShowPreview(false)}>
            <div className="quote-preview-toolbar absolute top-3 right-3 z-10" onClick={(e) => e.stopPropagation()}>
              <button className="px-4 py-2 bg-violet-700 text-white border border-violet-500 rounded-md text-base font-semibold hover:bg-violet-600" onClick={() => void toggleQuotePreviewFullscreen()}>Fullscreen</button>
            </div>
            <div id="quote-print-root" className="bg-white text-black overflow-auto shadow-xl" style={{ width: 'calc(100vw - 24px)', height: 'calc(100vh - 24px)' }} onClick={(e) => e.stopPropagation()}>
              <div className="p-6">
                {mode === 'sales' ? (
                  <div>
                    <style>{`
                      @media print {
                        @page { size: A4; margin: 0; }
                        /* Page control helpers */
                        .page-break { page-break-after: always; }
                        .print-page { page-break-after: always; page-break-inside: avoid; break-inside: avoid; }
                        .print-page:last-of-type { page-break-after: auto; }
                        /* Hide everything except the print root */
                        body * { visibility: hidden !important; }
                        #quote-print-root, #quote-print-root * { visibility: visible !important; }
                        /* Ensure the print container lays out from the top and is not clipped */
                        #quote-print-root { position: static !important; inset: auto !important; box-shadow: none !important; background: transparent !important; max-height: none !important; overflow: visible !important; width: auto !important; height: auto !important; }
                      }
                      @media screen {
                        .quote-customer-preview #quote-print-root .print-page { width:min(100%, 1200px) !important; min-height:auto !important; margin:12px auto !important; }
                        .quote-customer-preview #quote-print-root { scrollbar-color:#71717a #e4e4e7; scrollbar-width:thin; }
                        .quote-customer-preview:fullscreen .quote-preview-toolbar { display:none; }
                        .quote-customer-preview:fullscreen #quote-print-root { width:100vw !important; height:100vh !important; box-shadow:none !important; }
                      }
                    `}</style>
                    {/* Custom PC/Build preview pages OR default device view */}
                    {(() => {
                      const first = sales.items[0];
                      const isCustom = !!first && /custom/i.test(String(first?.deviceType || (first as any)?.deviceCategory || (first as any)?.category || ''));
                      if (!first) return null;
                      if (isCustom) {
                        const dyn: any = first.dynamic || {};
                        type Part = { label: string; key: string; desc: string; priceRaw: number; priceMarked: number; image?: string; image2?: string };
                        const baseParts: Array<{ key: string; label: string }> = [
                          { key: 'case', label: 'Case' },
                          { key: 'motherboard', label: 'Motherboard' },
                          { key: 'cpu', label: 'Processor' },
                          { key: 'cooling', label: 'Cooling' },
                          { key: 'ram', label: 'Memory' },
                          { key: 'gpu', label: 'Graphics Card' },
                          { key: 'storage', label: 'Primary Storage' },
                          { key: 'psu', label: 'PSU' },
                          { key: 'os', label: 'Operating System' },
                        ];
                        const parts: Part[] = [];
                        const buildDesc3 = (key: string) => {
                          const raw = String(dyn[key] || dyn[`${key}Info`] || '').trim();
                          const combine = (parts: (string|undefined)[]) => parts.filter(Boolean).map(String).map(s=>s.trim()).filter(Boolean).join(' | ');
                          switch (key) {
                            case 'cpu':
                              return combine([raw, dyn.cpuGen && `Gen ${dyn.cpuGen}`, dyn.cpuCores && `${dyn.cpuCores} cores`, dyn.cpuClock && `${dyn.cpuClock}`]) || raw;
                            case 'ram':
                              return combine([raw, dyn.ramSize && `${dyn.ramSize}`, dyn.ramSpeed && `${dyn.ramSpeed}`, dyn.ramType && `${dyn.ramType}`]) || raw;
                            case 'gpu':
                              return combine([raw, dyn.gpuModel || dyn.gpu, dyn.gpuVram && `${dyn.gpuVram}`]) || raw;
                            case 'storage':
                              return combine([raw, formatPrimaryStorageSummary(dyn)]) || raw;
                            case 'motherboard':
                              return combine([raw, dyn.moboChipset && `Chipset: ${dyn.moboChipset}`, dyn.formFactor && `${dyn.formFactor}`]) || raw;
                            case 'psu':
                              return combine([raw, dyn.psuWatt && `${dyn.psuWatt}W`]) || raw;
                            case 'cooling':
                              return combine([raw, dyn.coolingType]) || raw;
                            case 'case':
                              return combine([raw, dyn.caseFormFactor && `${dyn.caseFormFactor}`]) || raw;
                            case 'os':
                              return raw || dyn.os || '';
                            default:
                              return raw;
                          }
                        };
                        baseParts.forEach(p => {
                          const desc = buildDesc3(p.key);
                          const priceRaw = Number(dyn[`${p.key}Price`] || 0) || 0;
                          const imagesArr = Array.isArray(dyn[`${p.key}Images`]) ? dyn[`${p.key}Images`] : [];
                          let image: string | undefined = dyn[`${p.key}Image`] ? String(dyn[`${p.key}Image`]) : undefined;
                          let image2: string | undefined = dyn[`${p.key}Image2`] ? String(dyn[`${p.key}Image2`]) : undefined;
                          if (!image && imagesArr[0]) image = String(imagesArr[0]);
                          if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
                          if (!desc && !priceRaw && !image && !image2) return;
                          parts.push({ label: p.label, key: p.key, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
                        });

                        // Secondary + Additional Storage as separate priced parts
                        const secList3 = Array.isArray(dyn.pcSecondaryStorage) ? dyn.pcSecondaryStorage : [];
                        secList3.forEach((d: any, i: number) => {
                          const type = String(d?.type || '').trim();
                          const size = String(d?.size || '').trim();
                          const desc = [type, size].filter(Boolean).join(' ').trim();
                          const priceRaw = Number(d?.price || 0) || 0;
                          const image = d?.image ? String(d.image) : undefined;
                          const image2 = d?.image2 ? String(d.image2) : undefined;
                          if (!desc && !priceRaw && !image && !image2) return;
                          const label = i === 0 ? 'Secondary Storage' : 'Additional Storage';
                          parts.push({ label, key: `pc-storage-${i}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
                        });

                        // Peripherals (Custom PC) - render as line items directly under OS
                        const pcExtras = Array.isArray(dyn.pcExtras) ? dyn.pcExtras : [];
                        pcExtras.forEach((e: any, i: number) => {
                          const label = String(e?.label || e?.type || e?.name || '').trim() || 'Peripheral';
                          const desc = String(e?.desc || '').trim();
                          const priceRaw = Number(e?.price || 0) || 0;
                          const imagesArr = Array.isArray(e?.images) ? e.images : [];
                          let image: string | undefined = e?.image ? String(e.image) : undefined;
                          let image2: string | undefined = e?.image2 ? String(e.image2) : undefined;
                          if (!image && imagesArr[0]) image = String(imagesArr[0]);
                          if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
                          if (!desc && !priceRaw && !image && !image2) return;
                          parts.push({ label, key: `pc-extra-${i}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
                        });
                        const extras = Array.isArray(dyn.extraParts) ? dyn.extraParts : [];
                        extras.forEach((e: any) => {
                          const label = String(e?.name || 'Extra');
                          const desc = String(e?.desc || '').trim();
                          const priceRaw = Number(e?.price || 0) || 0;
                          const imagesArr = Array.isArray(e?.images) ? e.images : [];
                          let image: string | undefined = e?.image ? String(e.image) : undefined;
                          let image2: string | undefined = e?.image2 ? String(e.image2) : undefined;
                          if (!image && imagesArr[0]) image = String(imagesArr[0]);
                          if (!image2 && imagesArr[1]) image2 = String(imagesArr[1]);
                          if (!label && !desc && !priceRaw && !image && !image2) return;
                          parts.push({ label, key: `extra-${label}`, desc, priceRaw, priceMarked: priceRaw * 1.05, image, image2 });
                        });
                        const TAX_RATE = 0.08;
                        const laborRaw = Number(dyn.buildLabor || 0) || 0;
                        const chunk = <T,>(arr: T[], size: number) => { const out: T[][] = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
                        const firstPageParts = parts.slice(0, 6);
                        const remainingParts = parts.slice(6);
                        const remainingChunks = chunk(remainingParts, 6);
                        const PartBox = (p: Part, idx: number) => {
                          if (String(p.key).toLowerCase() === 'os' || String(p.label).toLowerCase().includes('operating system')) {
                            return (
                              <div key={`os-${idx}`} style={{ display: 'grid', gridTemplateColumns: '42mm 1fr', columnGap: 10, alignItems: 'stretch', marginBottom: 8 }}>
                                <div />
                                <div style={{ border: '2px solid #FF0000', borderRadius: 6, padding: 8, minHeight: '22mm' }}>
                                  <div style={{ fontWeight: 700, marginBottom: 2 }}>{p.label}</div>
                                  <div style={{ fontSize: '10.5pt', lineHeight: 1.35 }}>{p.desc || '-'}</div>
                                </div>
                              </div>
                            );
                          }
                          const imgs = [p.image, p.image2].filter(Boolean) as string[];
                          const left = imgs.length >= 2 ? (
                            <div style={{ width: '44mm', height: '34mm', display: 'flex', flexDirection: 'column', gap: 4, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, padding: 4, boxSizing: 'border-box' }}>
                              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}><img src={imgs[0]!} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} /></div>
                              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}><img src={imgs[1]!} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} /></div>
                            </div>
                          ) : imgs.length === 1 ? (
                            <div style={{ width: '44mm', height: '34mm', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
                              <img src={imgs[0]!} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} />
                            </div>
                          ) : (
                            <div style={{ width: '44mm', height: '34mm', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
                              <div style={{ fontSize: '9pt', color: '#888' }}>No Image</div>
                            </div>
                          );
                          return (
                            <div key={`p-${idx}`} style={{ display: 'grid', gridTemplateColumns: '44mm 1fr', columnGap: 8, alignItems: 'stretch', marginBottom: 6 }}>
                              {left}
                              <div style={{ border: '2px solid #FF0000', borderRadius: 6, padding: 8, minHeight: '14mm', position: 'relative', boxSizing: 'border-box', textAlign: 'center' }}>
                                <div style={{ fontWeight: 800, fontSize: '14pt', marginTop: 2 }}>{p.label}</div>
                                <div style={{ fontSize: '11pt', lineHeight: 1.35, marginTop: 6, paddingLeft: 6, paddingRight: 6 }}>{p.desc || '-'}</div>
                                <div style={{ position: 'absolute', right: 6, bottom: 6, fontWeight: 700, fontSize: '11pt' }}>${(p.priceMarked || 0).toFixed(2)}</div>
                              </div>
                            </div>
                          );
                        };
                        const pricedParts = parts.filter(p => !(String(p.key).toLowerCase() === 'os' || String(p.label).toLowerCase().includes('operating system')));
                        const partsSubtotal = pricedParts.reduce((acc, p) => acc + (p.priceMarked || 0), 0);
                        const taxableParts = partsSubtotal;
                        const taxAmount = taxableParts * TAX_RATE;
                        const subtotalBeforeTax = taxableParts;
                        const totalAfterTax = taxableParts + taxAmount + laborRaw;
                        return (
                          <>
                            {/* Page 1: header + first 3 part boxes */}
                            <div className="print-page" style={{ width: '210mm', minHeight: '297mm', margin: '0 auto', border: '3px solid #FF0000', borderRadius: 8, padding: '12mm' }}>
                              <div className="flex items-start gap-4" style={{ marginBottom: 8 }}>
                                <img src={publicAsset('logo.png')} alt="GadgetBoy" style={{ height: '35mm', width: 'auto' }} />
                                <div className="flex-1" style={{ lineHeight: 1.2 }}>
                                  <div style={{ fontSize: '20pt', fontWeight: 700, letterSpacing: 0.2 }}>Gadgetboy Quote</div>
                                  <div style={{ fontSize: '13pt', fontWeight: 700 }}>GADGETBOY Repair & Retail</div>
                                  <div style={{ fontSize: '12pt' }}>2822 Devine Street, Columbia, SC 29205</div>
                                  <div style={{ fontSize: '12pt' }}>(803) 708-0101 | gadgetboysc@gmail.com</div>
                                  <div style={{ marginTop: 8, fontSize: '12pt' }}><strong>Customer:</strong> {sales.customerName || '-'} | <strong>Phone:</strong> {formatPhone(sales.customerPhone || '') || (sales.customerPhone || '')}{sales.customerEmail ? (<> | <strong>Email:</strong> {sales.customerEmail}</>) : null}</div>
                                </div>
                              </div>
                              <div className="mt-2">
                                {firstPageParts.length ? firstPageParts.map(PartBox) : (
                                  <div style={{ border: '1px dashed #FF0000', padding: 10, textAlign: 'center', color: '#666' }}>No parts listed.</div>
                                )}
                              </div>
                            </div>
                            {/* Subsequent part pages */}
                            {remainingChunks.map((group, gi) => (
                              <React.Fragment key={`pg-${gi}`}>
                                <div className="page-break" style={{ height: 1 }} />
                                <div className="print-page" style={{ width: '210mm', minHeight: '297mm', margin: '0 auto', border: '3px solid #FF0000', borderRadius: 8, padding: '12mm' }}>
                                  <div className="page-inner">
                                    {group.map(PartBox)}
                                  </div>
                                </div>
                              </React.Fragment>
                            ))}
                            {/* Summary page */}
                            <div className="page-break" style={{ height: 1 }} />
                            <div className="print-page" style={{ width: '210mm', minHeight: '297mm', margin: '0 auto', border: '3px solid #FF0000', borderRadius: 8, padding: '12mm' }}>
                              <div className="page-inner">
                                <div style={{ fontWeight: 700, fontSize: '13pt', marginBottom: 6, textAlign: 'center' }}>Itemized Summary</div>
                                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '10pt' }}>
                                  <thead>
                                    <tr><th style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'left' }}>Component</th><th style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right' }}>Price</th></tr>
                                  </thead>
                                  <tbody>
                                    {pricedParts.length ? pricedParts.map((p, i) => (
                                      <tr key={`sum-${i}`}><td style={{ border: '1px solid #FF0000', padding: 6 }}><b>{p.label}</b>{p.desc ? ` - ${p.desc}` : ''}</td><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right' }}>${(p.priceMarked || 0).toFixed(2)}</td></tr>
                                    )) : (<tr><td colSpan={2} style={{ border: '1px solid #FF0000', padding: 8, textAlign: 'center', color: '#666' }}>No components listed.</td></tr>)}
                                  </tbody>
                                  <tfoot>
                                    <tr><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right', fontWeight: 600 }}>Parts Subtotal</td><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right', fontWeight: 600 }}>${partsSubtotal.toFixed(2)}</td></tr>
                                    <tr><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right' }}>Build Labor (not taxed)</td><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right' }}>${laborRaw.toFixed(2)}</td></tr>
                                    <tr><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right', fontWeight: 600 }}>Subtotal (before tax)</td><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right', fontWeight: 600 }}>${subtotalBeforeTax.toFixed(2)}</td></tr>
                                    <tr><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right' }}>Tax on Parts ({(TAX_RATE*100).toFixed(0)}%)</td><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right' }}>${taxAmount.toFixed(2)}</td></tr>
                                    <tr><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right', fontWeight: 700 }}>Total (after tax)</td><td style={{ border: '1px solid #FF0000', padding: 6, textAlign: 'right', fontWeight: 700 }}>${totalAfterTax.toFixed(2)}</td></tr>
                                  </tfoot>
                                </table>
                                {/* Notes removed from summary; see Terms page for extended notes */}
                              </div>
                            </div>
                          </>
                        );
                      }
                      // Default non-custom flow
                      return (
                        <>
                          <div className="print-page" style={{ width: '210mm', minHeight: '297mm', margin: '0 auto', border: '3px solid #FF0000', borderRadius: 8, padding: '12mm' }}>
                            <div className="flex items-start gap-4" style={{ marginBottom: 8 }}>
                              <img src={publicAsset('logo.png')} alt="GadgetBoy" style={{ height: '35mm', width: 'auto' }} />
                              <div className="flex-1" style={{ lineHeight: 1.2 }}>
                                <div style={{ fontSize: '20pt', fontWeight: 700, letterSpacing: 0.2 }}>Gadgetboy Quote</div>
                                <div style={{ fontSize: '13pt', fontWeight: 700 }}>GADGETBOY Repair & Retail</div>
                                <div style={{ fontSize: '12pt' }}>2822 Devine Street, Columbia, SC 29205</div>
                                <div style={{ fontSize: '12pt' }}>(803) 708-0101 | gadgetboysc@gmail.com</div>
                                <div style={{ marginTop: 8, fontSize: '12pt' }}><strong>Customer:</strong> {sales.customerName || '-'} | <strong>Phone:</strong> {formatPhone(sales.customerPhone || '') || (sales.customerPhone || '')}{sales.customerEmail ? (<> | <strong>Email:</strong> {sales.customerEmail}</>) : null}</div>
                              </div>
                            </div>
                            {sales.items.length > 0 && (() => {
                              const first = sales.items[0];
                              const modelForTitle = (String(((first.model ?? first.dynamic?.model) || '')).trim());
                              const title = (modelForTitle || '').length > 0 ? [first.brand, modelForTitle].filter(Boolean).join(' ').trim() : 'First Device';
                              const hasSpecs = !!(
                                (first.dynamic && Object.keys(first.dynamic || {}).length > 0) ||
                                first.deviceType || (first.dynamic && (first.dynamic as any).device) || first.model || first.condition || first.accessories
                              );
                              const imgs = (first.images || []).slice(0, 3);
                              const base = Number(first.price || 0);
                              const shown = Number.isFinite(base) && base > 0 ? base : null;
                              return (
                                <div className="mt-4">
                                  <div className="text-base font-semibold mb-2 text-center">{title}</div>
                                  <div style={{ display: 'grid', gridTemplateColumns: imgs.length ? '70mm 1fr' : '1fr', alignItems: 'start', columnGap: 12 }}>
                                    {imgs.length > 0 && (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
                                        {imgs.map((src, i) => (
                                          <img key={i} src={src} alt={`Device ${i + 1}`} style={{ maxHeight: '55mm', maxWidth: '65mm', objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: 4, padding: 2 }} />
                                        ))}
                                      </div>
                                    )}
                                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                                      {hasSpecs && (
                                        <div className="rounded" style={{ fontSize: '12pt', border: '2px solid #FF0000', borderRadius: 4, padding: '12px 14px', width: '100%', boxSizing: 'border-box' }}>
                                          <div className="font-semibold mb-2" style={{ textAlign: 'center' }}>Specifications</div>
                                          <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'auto' }}>
                                            <tbody>
                                              {(() => {
                                                const rows: Array<[string, string]> = [];
                                                if (first.deviceType) rows.push(['Device Type', first.deviceType]);
                                                const appleFamily = (first.dynamic || ({} as any)).device as string | undefined;
                                                if (appleFamily) rows.push(['Apple Family', appleFamily]);
                                                if (first.model) rows.push(['Model', first.model]);
                                                if (first.condition) rows.push(['Condition', first.condition]);
                                                if (first.accessories) rows.push(['Accessories', first.accessories]);
                                                const titleCase = (s: string) => s
                                                  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                                                  .replace(/[_-]+/g, ' ')
                                                  .split(' ')
                                                  .filter(Boolean)
                                                  .map((w) => {
                                                    const up = w.toUpperCase();
                                                    if (w.length <= 3 && w === up) return up; // keep acronyms
                                                    return w.charAt(0).toUpperCase() + w.slice(1);
                                                  })
                                                  .join(' ');
                                                const asPrintableText = (x: any): string => {
                                                  if (x == null) return '';
                                                  if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return String(x);
                                                  if (Array.isArray(x)) {
                                                    const parts = x
                                                      .map((y) => (typeof y === 'string' || typeof y === 'number' || typeof y === 'boolean') ? String(y) : '')
                                                      .map((s) => s.trim())
                                                      .filter(Boolean);
                                                    return parts.join(', ');
                                                  }
                                                  if (typeof x === 'object') {
                                                    const v = (x as any).value;
                                                    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
                                                    const l = (x as any).label;
                                                    if (typeof l === 'string' || typeof l === 'number' || typeof l === 'boolean') return String(l);
                                                    const t = (x as any).text;
                                                    if (typeof t === 'string' || typeof t === 'number' || typeof t === 'boolean') return String(t);
                                                    return '';
                                                  }
                                                  return '';
                                                };
                                                Object.entries(first.dynamic || {}).forEach(([k, v]) => {
                                                  if (k === 'device') return; // already included as Apple Family

                                                  if ((k === 'otherSpecs' || k === 'droneSpecs') && Array.isArray(v)) {
                                                    (v as any[]).forEach((s: any, i: number) => {
                                                      const rawDesc = s?.desc ?? s?.description ?? s?.name;
                                                      const rawVal = s?.value ?? s?.val;
                                                      const desc = asPrintableText(rawDesc == null ? '' : rawDesc).trim();
                                                      const val = asPrintableText(rawVal == null ? '' : rawVal).trim();
                                                      if (!desc && !val) return;
                                                      rows.push([desc || `Spec ${i + 1}`, val]);
                                                    });
                                                    return;
                                                  }

                                                  if (Array.isArray(v)) {
                                                    const list = (v as any[])
                                                      .map((x) => asPrintableText(x))
                                                      .map((s) => s.trim())
                                                      .filter(Boolean);
                                                    rows.push([titleCase(k), list.length ? list.join(', ') : `${v.length} item(s)`]);
                                                    return;
                                                  }

                                                  if (v && typeof v === 'object') {
                                                    const t = asPrintableText(v).trim();
                                                    if (t) rows.push([titleCase(k), t]);
                                                    return;
                                                  }

                                                  const t = asPrintableText(v).trim();
                                                  if (t) rows.push([titleCase(k), t]);
                                                });
                                                return rows.map(([k, v]) => (
                                                  <tr key={k}>
                                                    <td style={{ border: '1px solid #FF0000', padding: '6px 14px', fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</td>
                                                    <td style={{ border: '1px solid #FF0000', padding: '6px 14px' }}>{String(v)}</td>
                                                  </tr>
                                                ));
                                              })()}
                                            </tbody>
                                          </table>
                                        </div>
                                      )}
                                      {shown != null && (
                                        <div style={{ textAlign: 'right' }}>
                                          <div style={{ display: 'inline-block', border: '2px solid #FF0000', padding: '10px 14px', borderRadius: 6, fontSize: '14pt', whiteSpace: 'nowrap', fontWeight: 800 }}>
                                            Total (before tax): ${shown.toFixed(2)}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  {first.prompt && String(first.prompt).trim().length > 0 && (
                                    <div style={{ textAlign: 'center', fontSize: '13pt', lineHeight: 1.45, maxWidth: '180mm', marginLeft: 'auto', marginRight: 'auto', marginTop: 18, border: '2px solid #FF0000', borderRadius: 4, padding: '10px 12px' }}>
                                      {first.prompt}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                          {/* Additional device pages: one per remaining device */}
                          {sales.items.slice(1).map((item, idx) => (
                            <React.Fragment key={idx}>
                              <div className="page-break" style={{ height: 1 }} />
                              <div className="print-page" style={{ width: '210mm', minHeight: '297mm', margin: '0 auto', border: '3px solid #FF0000', borderRadius: 8, padding: '12mm' }}>
                                {(() => {
                                  const modelForTitle = String(((item.model ?? item.dynamic?.model) || '')).trim();
                                  const title = modelForTitle ? [item.brand, modelForTitle].filter(Boolean).join(' ').trim() : `Device ${idx + 2}`;
                                  const hasSpecs = !!(
                                    (item.dynamic && Object.keys(item.dynamic || {}).length > 0) ||
                                    item.deviceType || (item.dynamic && (item.dynamic as any).device) || item.model || item.condition || item.accessories
                                  );
                                  const imgs = (item.images || []).slice(0, 3);
                                  const base = Number(item.price || 0);
                                  const shown = Number.isFinite(base) && base > 0 ? base : null;
                                  return (
                                    <div>
                                      <div className="text-base font-semibold mb-2 text-center">{title}</div>
                                      <div style={{ display: 'grid', gridTemplateColumns: imgs.length ? '70mm 1fr' : '1fr', alignItems: 'start', columnGap: 12 }}>
                                        {imgs.length > 0 && (
                                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
                                            {imgs.map((src, i) => (
                                              <img key={i} src={src} alt={`Device ${i + 1}`} style={{ maxHeight: '55mm', maxWidth: '65mm', objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: 4, padding: 2 }} />
                                            ))}
                                          </div>
                                        )}
                                        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                                          {hasSpecs && (
                                            <div className="rounded" style={{ fontSize: '12pt', border: '2px solid #FF0000', borderRadius: 4, padding: '12px 14px', width: '100%', boxSizing: 'border-box' }}>
                                              <div className="font-semibold mb-2" style={{ textAlign: 'center' }}>Specifications</div>
                                              <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'auto' }}>
                                                <tbody>
                                                  {(() => {
                                                    const rows: Array<[string, string]> = [];
                                                    if (item.deviceType) rows.push(['Device Type', item.deviceType]);
                                                    const appleFamily = (item.dynamic || ({} as any)).device as string | undefined;
                                                    if (appleFamily) rows.push(['Apple Family', appleFamily]);
                                                    if (item.model) rows.push(['Model', item.model]);
                                                    if (item.condition) rows.push(['Condition', item.condition]);
                                                    if (item.accessories) rows.push(['Accessories', item.accessories]);
                                                    const titleCase = (s: string) => s
                                                      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                                                      .replace(/[_-]+/g, ' ')
                                                      .split(' ')
                                                      .filter(Boolean)
                                                      .map((w) => {
                                                        const up = w.toUpperCase();
                                                        if (w.length <= 3 && w === up) return up;
                                                        return w.charAt(0).toUpperCase() + w.slice(1);
                                                      })
                                                      .join(' ');
                                                    const asPrintableText = (x: any): string => {
                                                      if (x == null) return '';
                                                      if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return String(x);
                                                      if (Array.isArray(x)) {
                                                        const parts = x
                                                          .map((y) => (typeof y === 'string' || typeof y === 'number' || typeof y === 'boolean') ? String(y) : '')
                                                          .map((s) => s.trim())
                                                          .filter(Boolean);
                                                        return parts.join(', ');
                                                      }
                                                      if (typeof x === 'object') {
                                                        const v = (x as any).value;
                                                        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
                                                        const l = (x as any).label;
                                                        if (typeof l === 'string' || typeof l === 'number' || typeof l === 'boolean') return String(l);
                                                        const t = (x as any).text;
                                                        if (typeof t === 'string' || typeof t === 'number' || typeof t === 'boolean') return String(t);
                                                        return '';
                                                      }
                                                      return '';
                                                    };
                                                    Object.entries(item.dynamic || {}).forEach(([k, v]) => {
                                                      if (k === 'device') return;

                                                      if ((k === 'otherSpecs' || k === 'droneSpecs') && Array.isArray(v)) {
                                                        (v as any[]).forEach((s: any, i: number) => {
                                                          const rawDesc = s?.desc ?? s?.description ?? s?.name;
                                                          const rawVal = s?.value ?? s?.val;
                                                          const desc = asPrintableText(rawDesc == null ? '' : rawDesc).trim();
                                                          const val = asPrintableText(rawVal == null ? '' : rawVal).trim();
                                                          if (!desc && !val) return;
                                                          rows.push([desc || `Spec ${i + 1}`, val]);
                                                        });
                                                        return;
                                                      }

                                                      if (Array.isArray(v)) {
                                                        const list = (v as any[])
                                                          .map((x) => asPrintableText(x))
                                                          .map((s) => s.trim())
                                                          .filter(Boolean);
                                                        rows.push([titleCase(k), list.length ? list.join(', ') : `${v.length} item(s)`]);
                                                        return;
                                                      }

                                                      if (v && typeof v === 'object') {
                                                        const t = asPrintableText(v).trim();
                                                        if (t) rows.push([titleCase(k), t]);
                                                        return;
                                                      }

                                                      const t = asPrintableText(v).trim();
                                                      if (t) rows.push([titleCase(k), t]);
                                                    });
                                                    return rows.map(([k, v]) => (
                                                      <tr key={k}>
                                                        <td style={{ border: '1px solid #FF0000', padding: '6px 14px', fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</td>
                                                        <td style={{ border: '1px solid #FF0000', padding: '6px 14px' }}>{String(v)}</td>
                                                      </tr>
                                                    ));
                                                  })()}
                                                </tbody>
                                              </table>
                                            </div>
                                          )}
                                          {shown != null && (
                                            <div style={{ textAlign: 'right' }}>
                                              <div style={{ display: 'inline-block', border: '2px solid #FF0000', padding: '10px 14px', borderRadius: 6, fontSize: '14pt', whiteSpace: 'nowrap', fontWeight: 800 }}>
                                                Total (before tax): ${shown.toFixed(2)}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                      {item.prompt && String(item.prompt).trim().length > 0 && (
                                        <div style={{ textAlign: 'center', fontSize: '13pt', lineHeight: 1.45, maxWidth: '180mm', marginLeft: 'auto', marginRight: 'auto', marginTop: 18, border: '2px solid #FF0000', borderRadius: 4, padding: '10px 12px' }}>
                                          {item.prompt}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            </React.Fragment>
                          ))}
                          {/* Final page is rendered once after all devices (below). */}
                        </>
                      );
                    })()}
                    {/* Final page: Notes + Checklist + Terms + Signature */}
                    <div className="page-break" style={{ height: 1 }} />
                    {(() => {
                      const first = sales.items[0];
                      const isCustom = !!first && /custom/i.test(String(first?.deviceType || (first as any)?.deviceCategory || (first as any)?.category || ''));

                      if (isCustom) {
                        const dyn: any = first?.dynamic || {};
                        type Part = { label: string; key: string; desc: string };
                        const baseParts: Array<{ key: string; label: string }> = [
                          { key: 'case', label: 'Case' },
                          { key: 'motherboard', label: 'Motherboard' },
                          { key: 'cpu', label: 'Processor' },
                          { key: 'cooling', label: 'Cooling' },
                          { key: 'ram', label: 'Memory' },
                          { key: 'gpu', label: 'Graphics Card' },
                          { key: 'storage', label: 'Primary Storage' },
                          { key: 'psu', label: 'PSU' },
                          { key: 'os', label: 'Operating System' },
                        ];
                        const combine = (arr: (string | undefined)[]) => arr.filter(Boolean).map(String).map((s) => s.trim()).filter(Boolean).join(' | ');
                        const buildDesc = (key: string) => {
                          const raw = String(dyn[key] || dyn[`${key}Info`] || '').trim();
                          switch (key) {
                            case 'cpu':
                              return combine([raw, dyn.cpuGen && `Gen ${dyn.cpuGen}`, dyn.cpuCores && `${dyn.cpuCores} cores`, dyn.cpuClock && `${dyn.cpuClock}`]) || raw;
                            case 'ram':
                              return combine([raw, dyn.ramSize && `${dyn.ramSize}`, dyn.ramSpeed && `${dyn.ramSpeed}`, dyn.ramType && `${dyn.ramType}`]) || raw;
                            case 'gpu':
                              return combine([raw, dyn.gpuModel || dyn.gpu, dyn.gpuVram && `${dyn.gpuVram}`]) || raw;
                            case 'storage':
                              return combine([raw, formatPrimaryStorageSummary(dyn)]) || raw;
                            case 'motherboard':
                              return combine([raw, dyn.moboChipset && `Chipset: ${dyn.moboChipset}`, dyn.formFactor && `${dyn.formFactor}`]) || raw;
                            case 'psu':
                              return combine([raw, dyn.psuWatt && `${dyn.psuWatt}W`]) || raw;
                            case 'cooling':
                              return combine([raw, dyn.coolingType]) || raw;
                            case 'case':
                              return combine([raw, dyn.caseFormFactor && `${dyn.caseFormFactor}`]) || raw;
                            case 'os':
                              return raw || dyn.os || '';
                            default:
                              return raw;
                          }
                        };
                        const parts: Part[] = [];
                        baseParts.forEach((p) => {
                          const desc = buildDesc(p.key);
                          const priceRaw = Number(dyn[`${p.key}Price`] || 0) || 0;
                          const img1 = dyn[`${p.key}Image`] || dyn[`${p.key}Image2`];
                          if (!desc && !priceRaw && !img1) return;
                          parts.push({ label: p.label, key: p.key, desc });
                        });

                        // Secondary + Additional Storage checklist items
                        const secList4 = Array.isArray(dyn.pcSecondaryStorage) ? dyn.pcSecondaryStorage : [];
                        secList4.forEach((d: any, i: number) => {
                          const type = String(d?.type || '').trim();
                          const size = String(d?.size || '').trim();
                          const desc = [type, size].filter(Boolean).join(' ').trim();
                          const priceRaw = Number(d?.price || 0) || 0;
                          const img1 = d?.image || d?.image2;
                          if (!desc && !priceRaw && !img1) return;
                          const label = i === 0 ? 'Secondary Storage' : 'Additional Storage';
                          parts.push({ label, key: `pc-storage-${i}`, desc });
                        });
                        const pcExtras = Array.isArray(dyn.pcExtras) ? dyn.pcExtras : [];
                        pcExtras.forEach((e: any, i: number) => {
                          const label = String(e?.label || e?.type || e?.name || '').trim() || 'Peripheral';
                          const desc = String(e?.desc || '').trim();
                          const priceRaw = Number(e?.price || 0) || 0;
                          const img1 = e?.image || e?.image2;
                          if (!desc && !priceRaw && !img1) return;
                          parts.push({ label, key: `pc-extra-${i}`, desc });
                        });
                        const extras = Array.isArray(dyn.extraParts) ? dyn.extraParts : [];
                        extras.forEach((e: any) => {
                          const label = String(e?.name || 'Extra');
                          const desc = String(e?.desc || '').trim();
                          const priceRaw = Number(e?.price || 0) || 0;
                          const img1 = e?.image || e?.image2;
                          if (!label && !desc && !priceRaw && !img1) return;
                          parts.push({ label, key: `extra-${label}`, desc });
                        });

                        return (
                          <div className="print-page" style={{ width: '210mm', minHeight: '297mm', margin: '0 auto', border: '3px solid #FF0000', borderRadius: 8, padding: '12mm' }}>
                            <div style={{ paddingTop: 8, minHeight: '273mm', display: 'flex', flexDirection: 'column' }}>
                              <div style={{ fontWeight: 700, fontSize: '13pt', marginBottom: 10, textAlign: 'center' }}>Client Notes & Parts Approval</div>

                              <div style={{ fontWeight: 700, marginBottom: 6, fontSize: '12pt' }}>Client Notes</div>
                              <textarea placeholder="Notes, requested changes, questions, or preferences..." style={{ width: '100%', minHeight: '60mm', border: '2px solid #FF0000', borderRadius: 4, padding: 10, fontSize: '11pt', resize: 'vertical' } as any} />

                              <div style={{ fontWeight: 700, marginTop: 14, marginBottom: 6, fontSize: '12pt' }}>Parts Approval Checklist</div>
                              <div style={{ border: '2px solid #FF0000', borderRadius: 4, padding: 10 }}>
                                <div style={{ fontSize: '10.5pt', color: '#444', marginBottom: 8 }}>Check the components you approve. Leave items unchecked if you do not approve them yet or require changes.</div>
                                <div style={{ columns: 2, columnGap: 16 } as any}>
                                  {parts.length ? parts.map((p, i) => (
                                    <label key={p.key + ':' + i} style={{ display: 'block', breakInside: 'avoid', marginBottom: 6, fontSize: '10.5pt', lineHeight: 1.25 } as any}>
                                      <input type="checkbox" style={{ width: 14, height: 14, verticalAlign: 'middle', marginRight: 8 }} />
                                      <span style={{ verticalAlign: 'middle' }}><b>{p.label}</b>{p.desc ? ` - ${p.desc}` : ''}</span>
                                    </label>
                                  )) : (<div style={{ color: '#666' }}>No parts listed.</div>)}
                                </div>
                              </div>

                              <div style={{ marginTop: 'auto' }}>
                                <div style={{ fontWeight: 700, marginTop: 14, marginBottom: 6, fontSize: '12pt' }}>Terms and Conditions</div>
                                <div style={{ border: '2px solid #FF0000', borderRadius: 4, padding: 12, fontSize: '11pt', lineHeight: 1.45 }}>
                                  <ul style={{ paddingLeft: '1.1rem', margin: 0 }}>
                                    <li style={{ marginBottom: 6 }}><b>Quote Validity, Price Changes & Availability:</b> Quoted pricing is provided as of the date issued, is subject to parts availability and vendor/distributor price changes, and may change prior to purchase. Any substitutions must be approved by the client before purchase.</li>
                                    <li style={{ marginBottom: 6 }}><b>Warranty, Exclusions & Client-Caused Damage:</b> 90-day limited hardware warranty for defects under normal use; exclusions include physical/impact damage, liquid exposure, misuse/accidents, unauthorized repairs/modifications, abuse/neglect, loss/theft, and third-party accessories. Damage occurring after delivery/pickup is the client’s responsibility and is not covered.</li>
                                    <li style={{ marginBottom: 0 }}><b>Data & Software:</b> Client is responsible for backups and licensing. Service may require updates/reinstall/reset; we are not responsible for data loss.</li>
                                  </ul>
                                </div>

                                <div style={{ marginTop: 16 }}>
                                  <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <div style={{ fontWeight: 400, fontSize: '12pt', whiteSpace: 'nowrap' }}>Signature</div>
                                        <div style={{ borderBottom: '2px solid #000', height: 24, flex: 1 }} />
                                      </div>
                                    </div>
                                    <div style={{ width: 220 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <div style={{ fontWeight: 400, fontSize: '12pt', whiteSpace: 'nowrap' }}>Date</div>
                                        <div style={{ borderBottom: '2px solid #000', height: 24, flex: 1 }} />
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      const labels = sales.items.map((it, idx) => {
                        const modelForItem = String(((it.model ?? it.dynamic?.model) || '')).trim();
                        const label = (modelForItem ? [it.brand, modelForItem].filter(Boolean).join(' ').trim() : '') || `Item ${idx + 1}`;
                        return label;
                      });

                      return (
                        <div className="print-page" style={{ width: '210mm', minHeight: '297mm', margin: '0 auto', border: '3px solid #FF0000', borderRadius: 8, padding: '12mm' }}>
                          <div style={{ paddingTop: 8, minHeight: '273mm', display: 'flex', flexDirection: 'column' }}>
                            <div style={{ fontWeight: 700, marginBottom: 6, fontSize: '12pt' }}>Notes</div>
                            <textarea placeholder="Notes, requested changes, questions, or preferences..." style={{ width: '100%', height: '52mm', border: '2px solid #FF0000', borderRadius: 4, padding: 10, fontSize: '11pt', resize: 'vertical' } as any} />

                            <div style={{ fontWeight: 700, marginTop: 14, marginBottom: 6, fontSize: '12pt' }}>Checklist</div>
                            <div style={{ border: '2px solid #FF0000', borderRadius: 4, padding: 10, fontSize: '11pt', lineHeight: 1.35 }}>
                              <div style={{ columns: 2, columnGap: 16 } as any}>
                                {labels.map((l, i) => (
                                  <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, breakInside: 'avoid' } as any}>
                                    <input type="checkbox" style={{ width: 14, height: 14, marginTop: 2 }} />
                                    <span>{l || `Item ${i + 1}`}</span>
                                  </label>
                                ))}
                              </div>
                            </div>

                            <div style={{ marginTop: 'auto' }}>
                              <div style={{ fontWeight: 700, marginTop: 14, marginBottom: 6, fontSize: '12pt' }}>Terms and Conditions</div>
                              <div style={{ border: '2px solid #FF0000', borderRadius: 4, padding: 12, fontSize: '11pt', lineHeight: 1.45 }}>
                                <ul style={{ paddingLeft: '1.1rem', margin: 0 }}>
                                  <li style={{ marginBottom: 6 }}><b>Quote Validity, Price Changes & Availability:</b> Pricing is provided as of the date issued, is subject to parts availability and vendor/distributor price changes, and may change prior to purchase. Any substitutions must be approved by the client before purchase.</li>
                                  <li style={{ marginBottom: 6 }}><b>Warranty, Exclusions & Client-Caused Damage:</b> 90-day limited hardware warranty for defects under normal use; exclusions include physical/impact damage, liquid exposure, misuse/accidents, unauthorized repairs/modifications, abuse/neglect, loss/theft, and third-party accessories. Damage occurring after delivery/pickup is the client’s responsibility and is not covered.</li>
                                  <li style={{ marginBottom: 6 }}><b>Data & Software:</b> Client is responsible for backups and licensing. Service may require updates/reinstall/reset; we are not responsible for data loss.</li>
                                  <li style={{ marginBottom: 6 }}><b>Deposits & Special Orders:</b> Deposits may be required to order parts/products. Special-order items may be non-returnable and subject to supplier restocking policies.</li>
                                  <li style={{ marginBottom: 6 }}><b>Returns & Cancellations:</b> Returns/cancellations are subject to manufacturer/vendor policies. Labor and time spent is non-refundable.</li>
                                  <li style={{ marginBottom: 6 }}><b>Taxes & Fees:</b> Sales tax and applicable fees may apply at checkout; printed totals may be shown before tax.</li>
                                  <li style={{ marginBottom: 0 }}><b>Limitation of Liability:</b> Liability is limited to amounts paid; incidental or consequential damages are excluded where permitted by law.</li>
                                </ul>
                              </div>

                              <div style={{ marginTop: 16 }}>
                                <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                      <div style={{ fontWeight: 400, fontSize: '12pt', whiteSpace: 'nowrap' }}>Signature</div>
                                      <div style={{ borderBottom: '2px solid #000', height: 24, flex: 1 }} />
                                    </div>
                                  </div>
                                  <div style={{ width: 220 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                      <div style={{ fontWeight: 400, fontSize: '12pt', whiteSpace: 'nowrap' }}>Date</div>
                                      <div style={{ borderBottom: '2px solid #000', height: 24, flex: 1 }} />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div>
                    <div className="text-sm">Customer: <b>{repairs.customerName || '-'}</b> | {formatPhone(repairs.customerPhone || '') || (repairs.customerPhone || '')}</div>
                    <table className="w-full text-sm mt-3 border-collapse">
                      <thead><tr><th className="border p-2 text-left">Description</th><th className="border p-2 text-right">Parts</th><th className="border p-2 text-right">Labor</th><th className="border p-2 text-right">Line</th></tr></thead>
                      <tbody>
                        {repairs.lines.map((ln, idx) => {
                          const pp = Number(ln.partPrice || 0), lp = Number(ln.laborPrice || 0);
                          return (<tr key={idx}><td className="border p-2">{ln.description}</td><td className="border p-2 text-right">${pp.toFixed(2)}</td><td className="border p-2 text-right">${lp.toFixed(2)}</td><td className="border p-2 text-right">${(pp+lp).toFixed(2)}</td></tr>);
                        })}
                      </tbody>
                      <tfoot>
                        <tr><td colSpan={3} className="border p-2 text-right font-semibold">Total</td><td className="border p-2 text-right font-bold">${repairTotals.total.toFixed(2)}</td></tr>
                      </tfoot>
                    </table>
                    {repairs.notes && (<div className="mt-3 text-sm"><b>Notes:</b> {repairs.notes}</div>)}
                  </div>
                )}
              </div>
              </div>
            </div>
          )}

          {!isMobileShell && addingClientFor ? (
            <CustomerOverviewWindow
              customer={null}
              closeAfterSave
              onClose={() => setAddingClientFor(null)}
              onSaved={(c) => {
                applyQuoteClient(addingClientFor, {
                  id: c.id,
                  firstName: c.firstName,
                  lastName: c.lastName,
                  phone: c.phone || '',
                  email: c.email || '',
                });
                setAddingClientFor(null);
              }}
            />
          ) : null}

        </div>

        {/* Sidebar: Saved Quotes */}
  <aside className="gb-quote-saved col-span-3 bg-zinc-800 border border-zinc-700 rounded p-3 flex flex-col min-h-[calc(100vh-2rem)]">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-zinc-200">Saved Quotes</div>
            <button className="px-2 py-0.5 text-xs bg-zinc-700 border border-zinc-600 rounded" onClick={openSavedQuotes}>Refresh</button>
          </div>
          <div className="text-[10px] text-zinc-400 mb-2">Click a customer to load their quote.</div>
          <div className="flex-1 overflow-hidden space-y-2">
            {groupedQuotes.length === 0 ? (
              <div className="text-xs text-zinc-400">No saved quotes.</div>
            ) : (
              groupedQuotes.map((group) => {
                const expanded = expandedQuoteMonths[group.key] !== false;
                return (
                  <div key={group.key} className="rounded border border-zinc-700 overflow-hidden">
                    <button
                      className="w-full px-2 py-1.5 bg-zinc-900 border-b border-zinc-700 flex items-center justify-between text-left hover:bg-zinc-700/40"
                      onClick={() => setExpandedQuoteMonths((prev) => ({ ...prev, [group.key]: !expanded }))}
                    >
                      <div>
                        <div className="text-[11px] font-semibold text-zinc-200 uppercase tracking-wide">{group.label}</div>
                        <div className="text-[10px] text-zinc-400">{group.items.length} quote{group.items.length === 1 ? '' : 's'}</div>
                      </div>
                      <div className="text-xs text-zinc-400">{expanded ? 'Hide' : 'Show'}</div>
                    </button>
                    {expanded ? (
                      <div className="divide-y divide-zinc-700/70">
                        {group.items.map((q: any) => (
                          <div key={q.id ?? q.createdAt ?? Math.random()} className="p-2 hover:bg-zinc-700/40 cursor-pointer">
                            <div className="flex items-start justify-between gap-2" onClick={() => {
                              try {
                                setMode((q?.type ?? 'sales') === 'repairs' ? 'repairs' : 'sales');
                                setSales({
                                  customerId: q.customerId != null ? Number(q.customerId) : undefined,
                                  customerName: q.customerName || '',
                                  customerPhone: q.customerPhone || '',
                                  customerEmail: q.customerEmail || '',
                                  notes: q.notes || '',
                                  items: Array.isArray(q.items) ? q.items : [],
                                });
                                setRepairs({
                                  customerId: q.customerId != null ? Number(q.customerId) : undefined,
                                  customerName: q.customerName || '',
                                  customerPhone: q.customerPhone || '',
                                  customerEmail: q.customerEmail || '',
                                  notes: q.notes || '',
                                  lines: Array.isArray(q.lines) ? q.lines : [],
                                });
                                quoteMetaRef.current = {
                                  createdAt: q.createdAt,
                                  contentUpdatedAt: q.contentUpdatedAt || q.updatedAt || q.createdAt,
                                };
                                quoteSnapshotRef.current = normalizeQuoteSnapshot(q);
                                if (q.id != null) setQuoteId(q.id);
                                setSaveMsg(`Loaded quote #${q.id ?? ''}`);
                                setTimeout(() => setSaveMsg(null), 1800);
                              } catch {}
                            }}>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium truncate text-zinc-100">{q.customerName || '-'}</div>
                                <div className="text-[10px] text-zinc-400">Edited {fmtWhen(getQuoteActivityIso(q))}</div>
                                <div className="text-[10px] text-zinc-500 truncate">Created {fmtWhen(q.createdAt)}</div>
                              </div>
                              <button
                                className="px-1.5 py-0.5 text-[10px] border rounded border-red-700 text-red-300 hover:bg-red-900/30 disabled:opacity-50"
                                disabled={q.id == null}
                                onClick={(e) => { e.stopPropagation(); deleteSavedQuote(q); }}
                              >Delete</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default QuoteGeneratorWindow;
