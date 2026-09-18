import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { LoginScreen } from '../auth/LoginScreen';
import { formatPhone } from '../lib/format';
import { PaginationProvider } from '../lib/pagination';
import { dispatchOpenModal, registerOpenModal, unregisterOpenModal } from '../lib/modalBus';
import { getSupabaseRuntimeConfig, supabase } from '../lib/supabase';
import { publicAsset } from '../lib/publicAsset';
import { storeWindowPayload } from '../lib/windowPayload';
import { technicianDisplayName } from '../lib/admin';
import {
  syncNotificationsFromCalendar,
  syncNotificationsFromRecords,
} from '../lib/notifications';
import MobileUpdateCheck, { getLatestMobileUpdate, openMobileUpdateDownload, type MobileUpdate } from './MobileUpdateCheck';
import GidgetChat from '../components/GidgetChat';
import { installMobileLongPressContextMenu } from './longPressContextMenu';
import { mainRecordKind, mainRecordTypeLabel, type MainRecordKind } from '../lib/consultationRecord';
import { reconcilePaidSaleInventory, reconcilePaidWorkOrderInventory } from '../lib/inventoryConsumption';
import { reconcileLegacyWorkOrders } from '../lib/workOrderCleanup';
import DurantApp from '../durant/DurantApp';
import CommandCenter from '../components/CommandCenter';

const NewWorkOrderWindow = React.lazy(() => import('../workorders/NewWorkOrderWindow'));
const SaleWindow = React.lazy(() => import('../sales/SaleWindow'));
const CalendarWindow = React.lazy(() => import('../components/CalendarWindow'));
const JournalWindow = React.lazy(() => import('../components/JournalWindow'));
const DailyLookWindow = React.lazy(() => import('../components/DailyLookWindow'));
const ClockInWindow = React.lazy(() => import('../components/ClockInWindow'));
const QuoteGeneratorWindow = React.lazy(() => import('../components/QuoteGeneratorWindow'));
const EODWindow = React.lazy(() => import('../components/EODWindow'));
const ProductsWindow = React.lazy(() => import('../components/ProductsWindow'));
const InventoryWindow = React.lazy(() => import('../components/InventoryWindow'));
const VendorsWindow = React.lazy(() => import('../components/VendorsWindow'));
const WorkOrderRepairPickerWindow = React.lazy(() => import('../workorders/WorkOrderRepairPickerWindow'));
const CustomerOverviewWindow = React.lazy(() => import('../components/CustomerOverviewWindow'));
const CustomerSearchWindow = React.lazy(() => import('../components/CustomerSearchWindow'));
const QuickSaleWindow = React.lazy(() => import('../components/QuickSaleWindow'));
const ConsultationBookingWindow = React.lazy(() => import('../components/ConsultationBookingWindow'));
const CheckoutWindow = React.lazy(() => import('../workorders/CheckoutWindow'));
const DevMenuWindow = React.lazy(() => import('../components/DevMenuWindow'));
const DataToolsWindow = React.lazy(() => import('../components/DataToolsWindow'));
const ReportingWindow = React.lazy(() => import('../components/ReportingWindow'));
const ReportEmailWindow = React.lazy(() => import('../components/ReportEmailWindow'));
const ChartsWindow = React.lazy(() => import('../components/ChartsWindow'));
const NotificationsWindow = React.lazy(() => import('../components/NotificationsWindow'));
const NotificationSettingsWindow = React.lazy(() => import('../components/NotificationSettingsWindow'));
const ReleaseFormWindow = React.lazy(() => import('../workorders/ReleaseFormWindow'));
const CustomerReceiptWindow = React.lazy(() => import('../workorders/CustomerReceiptWindow'));
const ConsultSheetWindow = React.lazy(() => import('../sales/ConsultSheetWindow'));
const ProductFormWindow = React.lazy(() => import('../sales/ProductFormWindow'));
const BackupWindow = React.lazy(() => import('../components/BackupWindow'));
const ClearDatabaseWindow = React.lazy(() => import('../components/ClearDatabaseWindow'));
const RepairCategoriesWindow = React.lazy(() => import('../repairs/RepairCategoriesWindow'));
const CatalogSettingsWindow = React.lazy(() => import('../components/CatalogSettingsWindow'));
const DeviceCategoriesWindow = React.lazy(() => import('../components/DeviceCategoriesWindow'));
const FeedbackWindow = React.lazy(() => import('../components/FeedbackWindow'));
const CustomBuildItemWindow = React.lazy(() => import('../workorders/CustomBuildItemWindow'));
const TechniciansWindow = React.lazy(() => import('../components/TechniciansWindow'));
const ClientUpdatePanel = React.lazy(() => import('../workorders/ClientUpdatePanel'));
const GameMenuWindow = React.lazy(() => import('../components/GameMenuWindow'));
const RepairTutorialWindow = React.lazy(() => import('../repairs/RepairTutorialWindow'));

type StaffProfile = {
  id: string;
  shop_id: string;
  role: 'admin' | 'manager' | 'technician' | 'durant';
  status: 'invited' | 'active' | 'disabled';
  first_name: string | null;
  last_name: string | null;
  email: string;
};

type MobileMode = 'all' | 'workorders' | 'sales';
type StatusFilter = 'all' | 'open' | 'closed';
type ModalEntry = { id: string; type: string };
type MobileRow = {
  type: 'workorder' | 'sale';
  displayType: MainRecordKind;
  id: number;
  customerId?: number;
  customerName: string;
  phone: string;
  email: string;
  date: Date;
  originalDate: Date | null;
  status: 'open' | 'in progress' | 'closed';
  technicianId: string;
  technicianLabel: string;
  title: string;
  subtitle: string;
  notes: string;
  total: number;
  remaining: number;
  source: any;
};
type SheetAction = {
  label: string;
  detail?: string;
  kind?: 'call' | 'text';
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void | Promise<void>;
};

function removeInitialHtmlLoader() {
  try {
    document.getElementById('gbpos-initial-loader')?.remove();
  } catch {
    // ignore
  }
}

function invoiceNumber(id: number | string) {
  return `GB${String(id).padStart(7, '0')}`;
}

function money(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '$0.00';
}

function safeDate(value: any) {
  const d = new Date(value || 0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function dateLabel(d: Date | null) {
  if (!d || Number.isNaN(d.getTime()) || d.getTime() <= 0) return 'No date';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getActivityDate(record: any) {
  return safeDate(record?.activityAt || record?.checkoutDate || record?.repairCompletionDate || record?.clientPickupDate || record?.checkInAt || record?.createdAt || record?.updatedAt);
}

function getItemSummary(record: any) {
  const list = Array.isArray(record?.items) ? record.items : [];
  const fromItems = list
    .map((it: any) => (it.repair || it.description || it.title || it.name || it.altDescription || '').toString().trim())
    .filter(Boolean)
    .join(', ');
  return fromItems || record?.diagnosticSelection?.label || record?.itemDescription || record?.productDescription || record?.productCategory || record?.category || '';
}

function computeTotals(record: any) {
  const labor = Number(record?.laborCost || 0);
  const parts = Number(record?.partCosts || 0);
  const discount = Number(record?.discount || 0);
  const taxRate = Number(record?.taxRate || 0);
  const subTotal = Math.max(0, labor + parts - discount);
  const tax = Math.round(subTotal * (taxRate / 100) * 100) / 100;
  const total = Math.round((record?.totals?.total ?? record?.total ?? subTotal + tax) * 100) / 100;
  const amountPaid = Number(record?.amountPaid || 0);
  const remaining = Math.max(0, Math.round((record?.totals?.remaining ?? total - amountPaid) * 100) / 100);
  return { subTotal, tax, total, remaining };
}

function normalizeStatus(record: any, fallback: 'workorder' | 'sale'): 'open' | 'in progress' | 'closed' {
  const raw = String(record?.status || '').toLowerCase().trim();
  if (raw === 'closed') return 'closed';
  if (raw === 'in progress' || raw === 'inprogress') return 'in progress';
  if (raw === 'open') return 'open';
  const totals = computeTotals(record);
  if (fallback === 'sale') return totals.remaining <= 0 ? 'closed' : 'open';
  return totals.remaining <= 0 ? 'closed' : 'open';
}

function techLabelFor(value: any, techIndex: Record<string, string>) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (techIndex[raw]) return techIndex[raw];
  for (const label of Object.values(techIndex)) {
    if (!label) continue;
    if (label === raw || label.split(' ')[0] === raw) return label;
  }
  return raw;
}

const StartupStatusScreen: React.FC<{ title: string; message?: string; error?: string }> = ({ title, message, error }) => {
  removeInitialHtmlLoader();
  return (
    <main className="mobile-startup">
      <div className="mobile-startup-card">
        <div className="mobile-pulse-logo">GB</div>
        <h1>{title}</h1>
        {message ? <p>{message}</p> : null}
        {error ? <div className="mobile-error-banner">{error}</div> : null}
      </div>
    </main>
  );
};

function useLongPress(onLongPress: () => void, ms = 520) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const pointerRef = useRef({ id: -1, x: 0, y: 0 });

  const clear = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const start = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select')) return;
    firedRef.current = false;
    pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    clear();
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true;
      try {
        if (navigator.vibrate) navigator.vibrate(18);
      } catch {
        // ignore
      }
      onLongPress();
    }, ms);
  }, [clear, ms, onLongPress]);

  const move = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (pointerRef.current.id !== event.pointerId) return;
    const dx = event.clientX - pointerRef.current.x;
    const dy = event.clientY - pointerRef.current.y;
    if (Math.hypot(dx, dy) > 12) clear();
  }, [clear]);

  const end = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (pointerRef.current.id === event.pointerId) pointerRef.current.id = -1;
    clear();
    window.setTimeout(() => {
      firedRef.current = false;
    }, 0);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return {
    'data-mobile-long-press': 'managed',
    onPointerDown: start,
    onPointerMove: move,
    onPointerUp: end,
    onPointerLeave: end,
    onPointerCancel: end,
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      onLongPress();
    },
    wasLongPress: () => firedRef.current,
  };
}

function useSheetDrag(onClose: () => void) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({
    active: false,
    pointerId: -1,
    startY: 0,
    lastY: 0,
    lastAt: 0,
    velocity: 0,
    offset: 0,
  });

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>, canceled = false) => {
    const state = dragRef.current;
    if (!state.active || state.pointerId !== event.pointerId) return;
    state.active = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const shouldClose = !canceled && (state.offset > 104 || (state.offset > 34 && state.velocity > 0.65));
    setDragging(false);
    if (shouldClose) {
      onClose();
      return;
    }
    setOffset(0);
  }, [offset, onClose]);

  const handleProps = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      dragRef.current = {
        active: true,
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastAt: performance.now(),
        velocity: 0,
        offset: 0,
      };
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      event.preventDefault();
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const state = dragRef.current;
      if (!state.active || state.pointerId !== event.pointerId) return;
      const now = performance.now();
      const elapsed = Math.max(1, now - state.lastAt);
      const rawDelta = event.clientY - state.startY;
      const nextOffset = rawDelta < 0 ? Math.max(rawDelta * 0.18, -24) : rawDelta;
      state.velocity = (event.clientY - state.lastY) / elapsed;
      state.offset = nextOffset;
      state.lastY = event.clientY;
      state.lastAt = now;
      setOffset(nextOffset);
      event.preventDefault();
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => endDrag(event),
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => endDrag(event, true),
    onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => endDrag(event, true),
  };

  return {
    dragging,
    handleProps,
    sheetStyle: {
      transform: offset ? `translateY(${Math.max(-24, offset)}px)` : undefined,
      transition: dragging ? 'none' : undefined,
    } as React.CSSProperties,
  };
}

function MobileModalContent({ type, onClose }: { type: string; onClose: () => void }) {
  switch (type) {
    case 'repairTutorial': return <RepairTutorialWindow onClose={onClose} />;
    case 'clientUpdate': return (
      <ClientUpdatePanel
        embedded
        recordType="repair"
        recordId={1001}
        initialRecord={{ id: 1001, customerId: 501, productDescription: 'PlayStation 5', model: 'Disc Edition', status: 'Checked In' }}
        initialCustomer={{ id: 501, firstName: 'Preview', lastName: 'Customer', phone: '8035550100', email: 'preview@example.invalid' }}
        onClose={onClose}
      />
    );
    case 'newWorkOrder': return <NewWorkOrderWindow />;
    case 'newSale': return <SaleWindow />;
    case 'calendar': return <CalendarWindow />;
    case 'journal': return <JournalWindow />;
    case 'dailyLook': return <DailyLookWindow />;
    case 'clockIn': return <ClockInWindow />;
    case 'quoteGenerator': return <QuoteGeneratorWindow />;
    case 'eod': return <EODWindow />;
    case 'products': return <ProductsWindow />;
    case 'productPicker': return <ProductsWindow pickerMode onPick={(product) => {
      window.dispatchEvent(new CustomEvent('gbpos:mobile-product-picked', { detail: product }));
      onClose();
    }} />;
    case 'inventory': return <InventoryWindow />;
    case 'vendors': return <VendorsWindow />;
    case 'workOrderRepairPicker': return <WorkOrderRepairPickerWindow />;
    case 'addClient': return <CustomerOverviewWindow customer={null} onClose={onClose} />;
    case 'customerOverview': return <CustomerOverviewWindow onClose={onClose} />;
    case 'customerSearch': return <CustomerSearchWindow onClose={onClose} />;
    case 'diagnosticTools': return <DiagnosticToolsWindow />;
    case 'quickSale': return <QuickSaleWindow />;
    case 'consultation': return <ConsultationBookingWindow />;
    case 'checkout': return <CheckoutWindow />;
    case 'devMenu': return <DevMenuWindow />;
    case 'dataTools': return <DataToolsWindow />;
    case 'reporting': return <ReportingWindow />;
    case 'reportEmail': return <ReportEmailWindow />;
    case 'charts': return <ChartsWindow />;
    case 'notifications': return <NotificationsWindow />;
    case 'notificationSettings': return <NotificationSettingsWindow hideCloseButton />;
    case 'releaseForm': return <ReleaseFormWindow />;
    case 'customerReceipt': return <CustomerReceiptWindow />;
    case 'consultSheet': return <ConsultSheetWindow />;
    case 'productForm': return <ProductFormWindow />;
    case 'backup': return <BackupWindow />;
    case 'clearDb': return <ClearDatabaseWindow />;
    case 'repairCategories': return <RepairCategoriesWindow mode="admin" />;
    case 'catalogSettings': return <CatalogSettingsWindow />;
    case 'deviceCategories': return <DeviceCategoriesWindow />;
    case 'customBuildItem': return <CustomBuildItemWindow />;
    case 'technicians': return <TechniciansWindow onClose={onClose} />;
    case 'feedback': return <FeedbackWindow />;
    case 'gameMenu': return <GameMenuWindow />;
    default: return <div className="mobile-empty-state">Unknown window: {type}</div>;
  }
}

function MobileModalShell({ entry, zIndex, onClose }: { entry: ModalEntry; zIndex: number; onClose: () => void }) {
  const contentOwnsClose = entry.type === 'customerSearch' || entry.type === 'customerOverview' || entry.type === 'addClient';
  const requestClose = useCallback(() => {
    if (entry.type === 'productPicker') {
      window.dispatchEvent(new CustomEvent('gbpos:mobile-product-picker-cancelled'));
    }
    if (entry.type === 'workOrderRepairPicker') {
      window.dispatchEvent(new CustomEvent('gbpos:mobile-repair-picker-cancelled'));
    }
    if (entry.type === 'checkout') {
      window.dispatchEvent(new CustomEvent('gbpos:mobile-checkout-cancelled'));
    }
    onClose();
  }, [entry.type, onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [requestClose]);

  const title = titleForModal(entry.type);

  return (
    <section className="mobile-modal-shell" style={{ zIndex }} data-modal-shell="1" data-modal-type={entry.type}>
      <header className="mobile-modal-bar">
        {contentOwnsClose ? <span className="mobile-bar-spacer" /> : (
          <button type="button" className="mobile-icon-button" onClick={requestClose} aria-label="Close window">
            <span aria-hidden="true">x</span>
          </button>
        )}
        <div>
          <div className="mobile-modal-eyebrow">GadgetBoy POS</div>
          <h2>{title}</h2>
        </div>
        {entry.type === 'products' ? (
          <button type="button" className="mobile-mini-button" onClick={() => dispatchOpenModal('inventory')}>
            Inventory
          </button>
        ) : (
          <span className="mobile-bar-spacer" />
        )}
      </header>
      <div className="mobile-modal-content">
        <React.Suspense fallback={<div className="mobile-loading-inline">Loading {title}...</div>}>
          <MobileModalContent type={entry.type} onClose={onClose} />
        </React.Suspense>
      </div>
    </section>
  );
}

function titleForModal(type: string) {
  const titles: Record<string, string> = {
    newWorkOrder: 'Work Order',
    newSale: 'Sale',
    calendar: 'Calendar',
    journal: 'Journal',
    dailyLook: 'Daily Look',
    clockIn: 'Clock In',
    quoteGenerator: 'Quote Generator',
    eod: 'Reports',
    products: 'Products',
    productPicker: 'Select Product',
    inventory: 'Inventory',
    vendors: 'Distributors / Vendors',
    workOrderRepairPicker: 'Repair Selection',
    addClient: 'Add Client',
    customerOverview: 'Client',
    customerSearch: 'Clients',
    diagnosticTools: 'Diagnostic Tools',
    quickSale: 'Quick Checkout',
    consultation: 'Consultation',
    checkout: 'Checkout',
    devMenu: 'Developer Tools',
    dataTools: 'Data Tools',
    feedback: 'Feedback',
    reporting: 'Reporting',
    reportEmail: 'Report Email',
    charts: 'Charts',
    notifications: 'Notifications',
    notificationSettings: 'Notification Settings',
    releaseForm: 'Release Form',
    customerReceipt: 'Receipt',
    consultSheet: 'Consult Sheet',
    productForm: 'Product',
    backup: 'Local Backup',
    clearDb: 'Clear Database',
    repairCategories: 'Repairs',
    deviceCategories: 'Device Categories',
    customBuildItem: 'Custom Build',
    technicians: 'Technicians',
  };
  return titles[type] || 'Window';
}

function useMobileRecords(refreshKey: number) {
  const [workOrders, setWorkOrders] = useState<any[]>([]);
  const [sales, setSales] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [technicians, setTechnicians] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadedOnceRef = useRef(false);

  const loadCore = useCallback(async () => {
    if (!loadedOnceRef.current) setLoading(true);
    setError('');
    try {
      const api = window.api as any;
      const [wos, saleRows, customerRows, techRows] = await Promise.all([
        api.getWorkOrders?.({ limit: 2500, sortBy: 'activityAt', sortDir: 'desc' }) ?? api.dbGet('workOrders', { limit: 2500, sortBy: 'activityAt', sortDir: 'desc' }),
        api.dbGet('sales', { limit: 2500, sortBy: 'checkInAt', sortDir: 'desc' }).catch(() => []),
        api.getCustomers?.().catch(() => api.dbGet('customers')) ?? api.dbGet('customers'),
        api.dbGet('technicians').catch(() => []),
      ]);
      setWorkOrders(Array.isArray(wos) ? wos : []);
      setSales(Array.isArray(saleRows) ? saleRows : []);
      setCustomers(Array.isArray(customerRows) ? customerRows : []);
      setTechnicians(Array.isArray(techRows) ? techRows : []);
    } catch (e: any) {
      setError(e?.message || 'Mobile data load failed.');
    } finally {
      loadedOnceRef.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCore();
  }, [loadCore, refreshKey]);

  useEffect(() => {
    const api = window.api as any;
    const loadOne = async (key: string, setter: React.Dispatch<React.SetStateAction<any[]>>) => {
      const rows = await api.dbGet(key).catch(() => []);
      setter(Array.isArray(rows) ? rows : []);
    };
    const offWO = api.onWorkOrdersChanged?.(() => { void loadOne('workOrders', setWorkOrders); });
    const offSales = api.onSalesChanged?.(() => { void loadOne('sales', setSales); });
    const offCustomers = api.onCustomersChanged?.(() => { void loadOne('customers', setCustomers); });
    const offTechs = api.onTechniciansChanged?.(() => { void loadOne('technicians', setTechnicians); });
    return () => {
      try { offWO && offWO(); } catch {}
      try { offSales && offSales(); } catch {}
      try { offCustomers && offCustomers(); } catch {}
      try { offTechs && offTechs(); } catch {}
    };
  }, []);

  return { workOrders, sales, customers, technicians, loading, error, reload: loadCore };
}

function shouldOpenMobileDrawer() {
  try {
    return new URLSearchParams(window.location.search).get('drawerPreview') === '1';
  } catch {
    return false;
  }
}

function mobileWindowPreviewType() {
  if (!import.meta.env.DEV) return '';
  try {
    return new URLSearchParams(window.location.search).get('mobileWindowPreview') || '';
  } catch {
    return '';
  }
}

const MobileApp: React.FC = () => {
  useEffect(() => installMobileLongPressContextMenu(), []);
  return <MobileAppRuntime />;
};

const MobileAppRuntime: React.FC = () => {
  const previewWindow = mobileWindowPreviewType();
  const inventoryDeepLink = useMemo(() => {
    try { return Number(new URLSearchParams(window.location.search).get('inventoryId')) || 0; } catch { return 0; }
  }, []);
  const [clientUpdateToken, setClientUpdateToken] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('clientUpdateToken') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (!clientUpdateToken) return;
    const previousTitle = document.title;
    document.title = 'GB Update Interface';
    return () => { document.title = previousTitle; };
  }, [clientUpdateToken]);
  const [authLoading, setAuthLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudWarning, setCloudWarning] = useState('');
  const [accessError, setAccessError] = useState('');
  const currentAuthUserIdRef = useRef<string | null>(null);

  const loadStaffProfile = useCallback(async (nextSession: Session | null) => {
    const nextUserId = nextSession?.user?.id || null;
    const isSameUser = !!nextUserId && currentAuthUserIdRef.current === nextUserId;
    setSession(nextSession);

    if (!nextUserId) {
      currentAuthUserIdRef.current = null;
      setStaffProfile(null);
      setCloudReady(false);
      setCloudWarning('');
      setAccessError('');
      setAuthLoading(false);
      return;
    }

    if (!isSameUser) {
      setStaffProfile(null);
      setCloudReady(false);
      setCloudWarning('');
    }

    setAccessError('');
    currentAuthUserIdRef.current = nextUserId;

    const { data, error } = await supabase
      .from('staff_profiles')
      .select('id, shop_id, role, status, first_name, last_name, email')
      .eq('user_id', nextUserId)
      .maybeSingle();

    if (error) {
      setAccessError(error.message);
      setAuthLoading(false);
      return;
    }

    if (!data || data.status !== 'active') {
      setAccessError('Your login is valid, but no active POS staff profile is connected to this account.');
      await supabase.auth.signOut();
      setSession(null);
      setAuthLoading(false);
      return;
    }

    setStaffProfile(data as StaffProfile);
    setAuthLoading(false);
  }, []);

  useEffect(() => {
    if (previewWindow) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      void loadStaffProfile(data.session);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void loadStaffProfile(nextSession);
    });
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [loadStaffProfile, previewWindow]);

  useEffect(() => {
    if (previewWindow) return;
    const api = window.api as any;
    let cancelled = false;
    if (!api?.cloudSetSession) {
      setCloudReady(true);
      return () => { cancelled = true; };
    }
    if (!session?.access_token || !staffProfile?.shop_id) {
      setCloudReady(false);
      void api.cloudClearSession?.();
      return () => { cancelled = true; };
    }
    const cfg = getSupabaseRuntimeConfig();
    setCloudReady(false);
    setCloudWarning('');
    void api.cloudSetSession({
      supabaseUrl: cfg.supabaseUrl,
      supabasePublishableKey: cfg.supabasePublishableKey,
      accessToken: session.access_token,
      shopId: staffProfile.shop_id,
    }).then((res: any) => {
      if (cancelled) return;
      if (res?.ok) {
        setCloudReady(true);
        const limits: Record<string, number> = {
          customers: 2500, technicians: 250, workOrders: 2500, sales: 2500,
          calendarEvents: 2500, calendarNotes: 1000, purchaseOrders: 1000,
          settings: 25, products: 2500, productCategories: 500,
          deviceCategories: 500, repairCategories: 2500, partSources: 1000,
        };
        void Promise.all(Object.entries(limits).map(([key, bootstrapLimit]) =>
          api.cloudSyncCollection?.(key, { bootstrapLimit }).catch(() => null)
        ));
      } else {
        setCloudWarning(res?.error || 'Cloud session could not be started. Showing local cached data.');
        setCloudReady(true);
      }
    }).catch((e: any) => {
      if (cancelled) return;
      setCloudWarning(e?.message || 'Cloud session could not be started. Showing local cached data.');
      setCloudReady(true);
    });
    return () => { cancelled = true; };
  }, [previewWindow, session?.access_token, staffProfile?.shop_id]);

  useEffect(() => {
    if (previewWindow || !cloudReady || !staffProfile?.shop_id) return;
    void (async () => {
      await reconcilePaidSaleInventory(window.api as any);
      await reconcilePaidWorkOrderInventory(window.api as any);
      await reconcileLegacyWorkOrders(window.api as any);
    })().catch((error) => {
      console.error('Mobile startup inventory reconciliation failed', error);
    });
  }, [cloudReady, previewWindow, staffProfile?.shop_id]);

  if (previewWindow) {
    removeInitialHtmlLoader();
    const previewProfile: StaffProfile = {
      id: 'mobile-window-preview',
      shop_id: 'mobile-window-preview',
      role: 'admin',
      status: 'active',
      first_name: 'Preview',
      last_name: 'Technician',
      email: 'preview@example.invalid',
    };
    return (
      <PaginationProvider pageSize={30}>
        <MobileHome
          profile={previewProfile}
          cloudWarning="Read-only layout preview. No Supabase records are loaded or changed."
          onSignOut={() => undefined}
          initialWindow={previewWindow}
        />
      </PaginationProvider>
    );
  }

  if (authLoading) {
    return <StartupStatusScreen title="Checking login" message="Connecting to your POS session..." />;
  }

  if (!session || !staffProfile) {
    removeInitialHtmlLoader();
    return (
      <>
        <LoginScreen onSignedIn={() => {
          setAuthLoading(true);
          supabase.auth.getSession().then(({ data }) => {
            void loadStaffProfile(data.session);
          });
        }} />
        {accessError ? <div className="mobile-toast mobile-toast-danger">{accessError}</div> : null}
      </>
    );
  }

  if (staffProfile.role === 'durant') {
    removeInitialHtmlLoader();
    return <DurantApp session={session} shopId={staffProfile.shop_id} onSignOut={() => void supabase.auth.signOut()} />;
  }

  if (!cloudReady) {
    return <StartupStatusScreen title="Connecting to Supabase" message="Checking shop database access..." error={cloudWarning || undefined} />;
  }

  removeInitialHtmlLoader();
  if (clientUpdateToken) {
    return (
      <React.Suspense fallback={<StartupStatusScreen title="Loading Update Client" message="Opening the QR status panel..." />}>
        <ClientUpdatePanel
          token={clientUpdateToken}
          onClose={() => {
            try {
              window.history.replaceState({}, '', window.location.pathname);
            } catch {
              // The home screen can still open if the browser blocks history updates.
            }
            setClientUpdateToken('');
          }}
        />
      </React.Suspense>
    );
  }
  const updateCheckKey = `${staffProfile.shop_id}:${staffProfile.id}:${session.user.id}`;
  return (
    <PaginationProvider pageSize={30}>
      <MobileHome profile={staffProfile} cloudWarning={cloudWarning} onSignOut={() => void supabase.auth.signOut()} initialWindow={inventoryDeepLink ? 'inventory' : ''} />
      <MobileUpdateCheck checkKey={updateCheckKey} delayMs={900} />
    </PaginationProvider>
  );
};

function MobileBrandTitle() {
  return (
    <div className="mobile-brand-block" aria-label={`GadgetBoy POS version ${__APP_VERSION__}`}>
      <div className="mobile-brand">
        <span className="mobile-brand-word">GADGETBOY</span>
        <span className="mobile-brand-bottom">
          <span>POS</span>
          <span className="mobile-version">v{__APP_VERSION__}</span>
        </span>
      </div>
    </div>
  );
}

function MobileHome({ profile, cloudWarning, onSignOut, initialWindow = '' }: { profile: StaffProfile; cloudWarning: string; onSignOut: () => void; initialWindow?: string }) {
  const [drawerOpen, setDrawerOpen] = useState(shouldOpenMobileDrawer);
  const [mode, setMode] = useState<MobileMode>('all');
  const [homeView, setHomeView] = useState<'command' | 'invoices'>('command');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [technicianFilter, setTechnicianFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [visibleCount, setVisibleCount] = useState(35);
  const [sheetRow, setSheetRow] = useState<MobileRow | null>(null);
  const [modalStack, setModalStack] = useState<ModalEntry[]>(() => initialWindow ? [{ id: `${initialWindow}-preview`, type: initialWindow }] : []);
  const [mobileUpdate, setMobileUpdate] = useState<MobileUpdate | null>(null);
  const [mobileUpdateOpening, setMobileUpdateOpening] = useState(false);
  const [gidgetOpen, setGidgetOpen] = useState(false);
  const modalCounterRef = useRef(0);
  const deferredQuery = useDeferredValue(query);
  const { workOrders, sales, customers, technicians, loading, error, reload } = useMobileRecords(refreshKey);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;

    const runCheck = async () => {
      try {
        const next = await getLatestMobileUpdate();
        if (alive) setMobileUpdate(next);
      } catch {
        if (alive) setMobileUpdate(null);
      }
    };

    const scheduleCheck = (delay = 1200) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void runCheck();
      }, delay);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleCheck(600);
    };
    const onOnline = () => scheduleCheck(600);

    scheduleCheck();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const runNotificationSync = async () => {
      if (!alive) return;
      try { await syncNotificationsFromCalendar(); } catch {}
      try { await syncNotificationsFromRecords(); } catch {}
    };
    const api: any = window.api;
    const offCal = api?.onCalendarEventsChanged?.(() => { void runNotificationSync(); });
    const offWO = api?.onWorkOrdersChanged?.(() => { void runNotificationSync(); });
    const offSales = api?.onSalesChanged?.(() => { void runNotificationSync(); });
    const offTech = api?.onTechniciansChanged?.(() => { void runNotificationSync(); });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void runNotificationSync();
    }, 15 * 60_000);
    void runNotificationSync();
    return () => {
      alive = false;
      try { offCal && offCal(); } catch {}
      try { offWO && offWO(); } catch {}
      try { offSales && offSales(); } catch {}
      try { offTech && offTech(); } catch {}
      window.clearInterval(timer);
    };
  }, []);

  const openModal = useCallback((type: string, payload?: any) => {
    if (payload !== undefined && payload !== null) {
      storeWindowPayload(type, payload);
    }
    setDrawerOpen(false);
    const id = `${type}-${++modalCounterRef.current}`;
    setModalStack((stack) => [...stack, { id, type }]);
  }, []);

  const closeModal = useCallback((id: string) => {
    setModalStack((stack) => stack.filter((entry) => entry.id !== id));
    setRefreshKey((v) => v + 1);
  }, []);

  const openNotifications = useCallback(() => {
    openModal('notifications');
  }, [openModal]);

  useEffect(() => {
    const handleAndroidBack = (event: Event) => {
      event.preventDefault();
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
        .filter((dialog) => dialog.offsetParent !== null);
      const topDialog = dialogs[dialogs.length - 1];
      if (topDialog) {
        const closeControl = Array.from(topDialog.querySelectorAll<HTMLButtonElement>('button')).find((button) => {
          const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim();
          return /^(close|cancel|back|x)(\b|$)/i.test(label);
        });
        if (closeControl) {
          closeControl.click();
          return;
        }
      }
      const expandedActivity = document.querySelector<HTMLElement>('.gb-eod-activity.is-expanded');
      const collapseActivity = expandedActivity?.querySelector<HTMLButtonElement>('.gb-eod-activity-expand');
      if (collapseActivity) {
        collapseActivity.click();
        return;
      }
      if (gidgetOpen) {
        setGidgetOpen(false);
        return;
      }
      if (sheetRow) {
        setSheetRow(null);
        return;
      }
      if (filtersOpen) {
        setFiltersOpen(false);
        return;
      }
      if (drawerOpen) {
        setDrawerOpen(false);
        return;
      }
      if (modalStack.length) {
        setModalStack((stack) => stack.slice(0, -1));
        setRefreshKey((value) => value + 1);
        return;
      }
      window.GBPosAndroid?.moveAppToBackground?.();
    };
    window.addEventListener('gbpos:android-back', handleAndroidBack);
    return () => window.removeEventListener('gbpos:android-back', handleAndroidBack);
  }, [drawerOpen, filtersOpen, gidgetOpen, modalStack.length, sheetRow]);

  useEffect(() => {
    registerOpenModal(openModal);
    const api = window.api as any;
    const methods = {
      openNewWorkOrder: 'newWorkOrder',
      openWorkOrder: 'newWorkOrder',
      openNewSale: 'newSale',
      openCalendar: 'calendar',
      openClockIn: 'clockIn',
      openQuoteGenerator: 'quoteGenerator',
      openEod: 'eod',
      openProducts: 'products',
      openInventory: 'inventory',
      openCatalogSettings: 'catalogSettings',
      openWorkOrderRepairPicker: 'workOrderRepairPicker',
      openCustomerOverview: 'customerOverview',
      openQuickSale: 'quickSale',
      openConsultation: 'consultation',
      openCheckout: 'checkout',
      openDevMenu: 'devMenu',
      openDataTools: 'dataTools',
      openReporting: 'reporting',
      openReportEmail: 'reportEmail',
      openCharts: 'charts',
      openNotifications: 'notifications',
      openNotificationSettings: 'notificationSettings',
      openReleaseForm: 'releaseForm',
      openCustomerReceipt: 'customerReceipt',
      openConsultSheet: 'consultSheet',
      openProductForm: 'productForm',
      openBackup: 'backup',
      openRepairCategories: 'repairCategories',
      openDeviceCategories: 'deviceCategories',
      openClearDatabase: 'clearDb',
      openCustomBuildItem: 'customBuildItem',
      openRepairTutorial: 'repairTutorial',
    } as Record<string, string>;
    const originals = new Map<string, any>();
    Object.entries(methods).forEach(([method, type]) => {
      if (method === 'openCheckout') return;
      if (typeof api?.[method] !== 'function') return;
      originals.set(method, api[method]);
      api[method] = async (payload?: any) => {
        openModal(type, payload);
        return { ok: true };
      };
    });
    const originalProductPicker = api?.pickSaleProduct;
    const originalRepairPicker = api?.pickRepairItem;
    const originalCheckout = api?.openCheckout;
    const originalCheckoutSave = api?._emitCheckoutSave;
    const originalCheckoutCancel = api?._emitCheckoutCancel;
    if (api) {
      const closeCheckoutModal = () => {
        setModalStack((stack) => {
          const index = stack.map((entry) => entry.type).lastIndexOf('checkout');
          if (index < 0) return stack;
          return stack.filter((_, entryIndex) => entryIndex !== index);
        });
        setRefreshKey((value) => value + 1);
      };
      api.openCheckout = (payload?: any) => new Promise((resolve) => {
        let settled = false;
        const finish = (value: any) => {
          if (settled) return;
          settled = true;
          window.removeEventListener('gbpos:mobile-checkout-saved', onSaved as EventListener);
          window.removeEventListener('gbpos:mobile-checkout-cancelled', onCancelled);
          closeCheckoutModal();
          resolve(value);
        };
        const onSaved = (event: Event) => finish((event as CustomEvent).detail || null);
        const onCancelled = () => finish(null);
        window.addEventListener('gbpos:mobile-checkout-saved', onSaved as EventListener, { once: true });
        window.addEventListener('gbpos:mobile-checkout-cancelled', onCancelled, { once: true });
        openModal('checkout', payload || {});
      });
      api._emitCheckoutSave = (result: any) => {
        window.dispatchEvent(new CustomEvent('gbpos:mobile-checkout-saved', { detail: result }));
      };
      api._emitCheckoutCancel = () => {
        window.dispatchEvent(new CustomEvent('gbpos:mobile-checkout-cancelled'));
      };
      api.pickSaleProduct = () => new Promise((resolve) => {
        let settled = false;
        const finish = (value: any) => {
          if (settled) return;
          settled = true;
          window.removeEventListener('gbpos:mobile-product-picked', onPicked as EventListener);
          window.removeEventListener('gbpos:mobile-product-picker-cancelled', onCancelled);
          resolve(value);
        };
        const onPicked = (event: Event) => finish((event as CustomEvent).detail || null);
        const onCancelled = () => finish(null);
        window.addEventListener('gbpos:mobile-product-picked', onPicked as EventListener, { once: true });
        window.addEventListener('gbpos:mobile-product-picker-cancelled', onCancelled, { once: true });
        openModal('productPicker');
      });
      api.pickRepairItem = (filters?: { deviceCategory?: string; deviceName?: string }) => new Promise((resolve) => {
        let settled = false;
        const finish = (value: any) => {
          if (settled) return;
          settled = true;
          window.removeEventListener('gbpos:mobile-repair-picked', onPicked as EventListener);
          window.removeEventListener('gbpos:mobile-repair-picker-cancelled', onCancelled);
          resolve(value);
        };
        const onPicked = (event: Event) => finish((event as CustomEvent).detail || null);
        const onCancelled = () => finish(null);
        window.addEventListener('gbpos:mobile-repair-picked', onPicked as EventListener, { once: true });
        window.addEventListener('gbpos:mobile-repair-picker-cancelled', onCancelled, { once: true });
        openModal('workOrderRepairPicker', filters || {});
      });
    }
    return () => {
      unregisterOpenModal();
      originals.forEach((fn, method) => {
        try { api[method] = fn; } catch {}
      });
      if (api && originalProductPicker) api.pickSaleProduct = originalProductPicker;
      if (api && originalRepairPicker) api.pickRepairItem = originalRepairPicker;
      if (api && originalCheckout) api.openCheckout = originalCheckout;
      if (api && originalCheckoutSave) api._emitCheckoutSave = originalCheckoutSave;
      if (api && originalCheckoutCancel) api._emitCheckoutCancel = originalCheckoutCancel;
    };
  }, [openModal]);

  const customerIndex = useMemo(() => {
    const map: Record<number, any> = {};
    customers.forEach((customer) => {
      const id = Number(customer?.id);
      if (!Number.isFinite(id)) return;
      const composed = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim();
      map[id] = {
        ...customer,
        name: composed || customer.name || customer.email || `Client #${id}`,
        phone: customer.phone || '',
        phoneAlt: customer.phoneAlt || '',
        email: customer.email || '',
      };
    });
    return map;
  }, [customers]);

  const techIndex = useMemo(() => {
    const map: Record<string, string> = {};
    technicians.forEach((tech) => {
      const id = String(tech?.id || '').trim();
      if (!id) return;
      map[id] = technicianDisplayName(tech);
    });
    return map;
  }, [technicians]);

  const rows = useMemo(() => {
    const workOrderRows: MobileRow[] = workOrders.map((wo) => {
      const customerId = Number(wo?.customerId);
      const customer = Number.isFinite(customerId) ? customerIndex[customerId] : null;
      const totals = computeTotals(wo);
      const technicianId = String(wo?.assignedTo || '').trim();
      const title = getItemSummary(wo) || wo?.productDescription || wo?.productCategory || 'Work order';
      return {
        type: 'workorder',
        displayType: mainRecordKind('workorder', wo),
        id: Number(wo?.id || 0),
        customerId: Number.isFinite(customerId) ? customerId : undefined,
        customerName: customer?.name || wo?.customerName || [wo?.firstName, wo?.lastName].filter(Boolean).join(' ').trim() || 'No client attached',
        phone: customer?.phone || customer?.phoneAlt || wo?.customerPhone || wo?.phone || '',
        email: customer?.email || wo?.customerEmail || '',
        date: getActivityDate(wo),
        originalDate: wo?.checkInAt ? safeDate(wo.checkInAt) : null,
        status: normalizeStatus(wo, 'workorder'),
        technicianId,
        technicianLabel: techLabelFor(technicianId, techIndex),
        title,
        subtitle: wo?.productDescription || wo?.model || wo?.serial || '',
        notes: wo?.problemInfo || wo?.problem || wo?.internalNotes || '',
        total: totals.total,
        remaining: totals.remaining,
        source: wo,
      };
    });

    const saleRows: MobileRow[] = sales.map((sale) => {
      const customerId = Number(sale?.customerId);
      const customer = Number.isFinite(customerId) ? customerIndex[customerId] : null;
      const totals = computeTotals(sale);
      const technicianId = String(sale?.assignedTo || '').trim();
      return {
        type: 'sale',
        displayType: mainRecordKind('sale', sale),
        id: Number(sale?.id || 0),
        customerId: Number.isFinite(customerId) ? customerId : undefined,
        customerName: customer?.name || sale?.customerName || 'Walk-in sale',
        phone: customer?.phone || customer?.phoneAlt || sale?.customerPhone || '',
        email: customer?.email || sale?.customerEmail || '',
        date: getActivityDate(sale),
        originalDate: sale?.checkInAt ? safeDate(sale.checkInAt) : null,
        status: normalizeStatus(sale, 'sale'),
        technicianId,
        technicianLabel: techLabelFor(technicianId, techIndex),
        title: getItemSummary(sale) || 'Sale',
        subtitle: sale?.category || sale?.condition || '',
        notes: sale?.notes || '',
        total: totals.total,
        remaining: totals.remaining,
        source: sale,
      };
    });

    return [...workOrderRows, ...saleRows]
      .filter((row) => row.id > 0)
      .sort((a, b) => (b.date.getTime() - a.date.getTime()) || (b.id - a.id));
  }, [customerIndex, sales, techIndex, workOrders]);

  const filteredRows = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const from = dateFrom ? safeDate(`${dateFrom}T00:00:00`) : null;
    const to = dateTo ? safeDate(`${dateTo}T23:59:59`) : null;
    return rows.filter((row) => {
      if (mode === 'workorders' && row.type !== 'workorder') return false;
      if (mode === 'sales' && row.type !== 'sale') return false;
      if (statusFilter === 'closed' && row.status !== 'closed') return false;
      if (statusFilter === 'open' && row.status === 'closed') return false;
      if (technicianFilter === '__unassigned' && row.technicianId) return false;
      if (technicianFilter && technicianFilter !== '__unassigned' && row.technicianId !== technicianFilter) return false;
      if (from && row.date < from) return false;
      if (to && row.date > to) return false;
      if (!q) return true;
      const haystack = [
        invoiceNumber(row.id),
        String(row.id),
        row.customerName,
        row.phone,
        row.email,
        row.title,
        row.subtitle,
        row.notes,
        row.technicianLabel,
        row.status,
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [dateFrom, dateTo, deferredQuery, mode, rows, statusFilter, technicianFilter]);

  useEffect(() => {
    setVisibleCount(35);
  }, [dateFrom, dateTo, deferredQuery, mode, statusFilter, technicianFilter]);

  const visibleRows = filteredRows.slice(0, visibleCount);
  const filtersActive = statusFilter !== 'all' || !!technicianFilter || !!dateFrom || !!dateTo;

  const actionSheetActions = useMemo(() => sheetRow ? makeSheetActions(sheetRow, () => {
    setSheetRow(null);
    setRefreshKey((v) => v + 1);
  }) : [], [sheetRow]);

  return (
    <main className="mobile-shell">
      <header className="mobile-topbar">
        <button type="button" className="mobile-icon-button" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
          <span className="mobile-hamburger" aria-hidden="true"><i /><i /><i /></span>
        </button>
        <button type="button" className="mobile-logo-button" onClick={() => setGidgetOpen(true)} aria-label="Open Gidget assistant" title="Gidget">
          <img className="mobile-topbar-logo" src={publicAsset('logo.png')} alt="GadgetBoy logo" />
        </button>
        <MobileBrandTitle />
        <button type="button" className="mobile-icon-button" onClick={openNotifications} aria-label="Open notifications">
          <span aria-hidden="true">!</span>
        </button>
      </header>

      <section className="mobile-search-panel">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search invoice, client, phone, device..."
          aria-label="Search POS records"
        />
        <button
          type="button"
          className={`mobile-filter-button${filtersActive ? ' active' : ''}`}
          onClick={() => setFiltersOpen((open) => !open)}
          aria-label="Open filters"
          aria-expanded={filtersOpen}
        >
          <span aria-hidden="true"><i /><i /><i /></span>
        </button>
        {query ? <button type="button" onClick={() => setQuery('')}>Clear</button> : null}
      </section>

      {filtersOpen ? (
        <section className="mobile-filter-popover" aria-label="Filters">
          <div className="mobile-filter-header">
            <strong>Filters</strong>
            <button
              type="button"
              onClick={() => {
                setStatusFilter('all');
                setTechnicianFilter('');
                setDateFrom('');
                setDateTo('');
              }}
              disabled={!filtersActive}
            >
              Clear
            </button>
          </div>
          <label>
            Status
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
              <option value="all">All records</option>
              <option value="open">Open only</option>
              <option value="closed">Closed only</option>
            </select>
          </label>
          <label>
            Technician
            <select value={technicianFilter} onChange={(event) => setTechnicianFilter(event.target.value)}>
              <option value="">Any technician</option>
              <option value="__unassigned">Unassigned</option>
              {technicians.map((tech) => {
                const id = String(tech?.id || '').trim();
                if (!id) return null;
                const label = technicianDisplayName(tech);
                return <option key={id} value={id}>{label}</option>;
              })}
            </select>
          </label>
          <div className="mobile-date-grid">
            <label>
              From
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </label>
          </div>
        </section>
      ) : null}

      {cloudWarning ? <div className="mobile-cloud-warning">{cloudWarning}</div> : null}
      {error ? <div className="mobile-cloud-warning danger">{error}</div> : null}

      {homeView === 'command' ? (
        <section className="mobile-command-center" aria-live="polite">
          <CommandCenter
            keyword={deferredQuery}
            onOpenInvoices={(nextMode = 'all') => {
              setMode(nextMode);
              setHomeView('invoices');
            }}
            onOpenModal={openModal}
          />
          <button type="button" className="mobile-all-invoices-button" onClick={() => setHomeView('invoices')}>All Invoices</button>
        </section>
      ) : (
        <>
          <div className="mobile-invoice-heading">
            <button type="button" onClick={() => setHomeView('command')}>‹ Command Center</button>
            <strong>All Invoices</strong>
          </div>
          <section className="mobile-tabbar" aria-label="Record type">
            <button type="button" className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>All</button>
            <button type="button" className={mode === 'workorders' ? 'active' : ''} onClick={() => setMode('workorders')}>Work Orders</button>
            <button type="button" className={mode === 'sales' ? 'active' : ''} onClick={() => setMode('sales')}>Sales</button>
          </section>
          <section className="mobile-record-list" aria-live="polite">
        {query === 'GADGETBOY' ? <button type="button" className="gb-secret-game-result mobile" onClick={() => openModal('gameMenu')}><strong>GAME MENU</strong><span>Secret system entry</span></button> : null}
        {loading ? <div className="mobile-loading-inline">Loading shop data...</div> : null}
        {!loading && visibleRows.length === 0 && query !== 'GADGETBOY' ? (
          <div className="mobile-empty-state">
            <strong>No matching records</strong>
            <span>Try clearing filters or opening the menu to start a new ticket.</span>
          </div>
        ) : null}
        {query !== 'GADGETBOY' ? visibleRows.map((row) => (
          <MobileRecordCard
            key={`${row.type}-${row.id}`}
            row={row}
            onOpen={() => openRecord(row)}
            onActions={() => setSheetRow(row)}
          />
        )) : null}
        {!loading && filteredRows.length > visibleRows.length ? (
          <button type="button" className="mobile-load-more" onClick={() => setVisibleCount((count) => count + 35)}>
            Load {Math.min(35, filteredRows.length - visibleRows.length)} more
          </button>
        ) : null}
          </section>
        </>
      )}

      <nav className="mobile-quickbar" aria-label="Quick actions">
        <button type="button" className="quick-sale" onClick={() => openModal('quickSale')}>Quick Checkout</button>
        <button type="button" className="add-client" onClick={() => openModal('addClient')}>Add Client</button>
        <button type="button" className="search-client" onClick={() => openModal('customerSearch')}>Search Client</button>
      </nav>

      <MobileDrawer
        open={drawerOpen}
        profileName="Shop Access"
        role={profile.role}
        onClose={() => setDrawerOpen(false)}
        onOpenModal={openModal}
        onRefresh={() => {
          setRefreshKey((v) => v + 1);
          void reload();
        }}
        update={mobileUpdate}
        updateOpening={mobileUpdateOpening}
        onUpdate={() => {
          if (!mobileUpdate) return;
          openMobileUpdateDownload(mobileUpdate, true, setMobileUpdateOpening);
        }}
        onSignOut={onSignOut}
      />

      {sheetRow ? (
        <ActionSheet
          row={sheetRow}
          actions={actionSheetActions}
          onClose={() => setSheetRow(null)}
        />
      ) : null}

      {modalStack.map((entry, index) => (
        <MobileModalShell
          key={entry.id}
          entry={entry}
          zIndex={300 + index * 10}
          onClose={() => closeModal(entry.id)}
        />
      ))}
      <GidgetChat open={gidgetOpen} onClose={() => setGidgetOpen(false)} />
    </main>
  );
}

function MobileRecordCard({ row, onOpen, onActions }: { row: MobileRow; onOpen: () => void; onActions: () => void }) {
  const longPress = useLongPress(onActions);
  const { wasLongPress, ...longPressHandlers } = longPress;
  return (
    <article
      className={`mobile-record-card ${row.displayType} ${row.status === 'closed' ? 'closed' : 'open'}`}
      {...longPressHandlers}
      onClick={() => {
        if (wasLongPress()) return;
        onOpen();
      }}
    >
      <div className="mobile-card-top">
        <div>
          <div className="mobile-invoice">{invoiceNumber(row.id)}</div>
          <div className="mobile-card-date">{dateLabel(row.date)}</div>
        </div>
        <button
          type="button"
          className="mobile-card-menu"
          onClick={(event) => {
            event.stopPropagation();
            onActions();
          }}
          aria-label={`More actions for ${invoiceNumber(row.id)}`}
        >
          ...
        </button>
      </div>
      <div className="mobile-card-main">
        <h2>{row.title || mainRecordTypeLabel(row.displayType)}</h2>
        <p>{row.customerName}</p>
        {row.subtitle ? <span>{row.subtitle}</span> : null}
      </div>
      <div className="mobile-card-meta">
        <span className={`mobile-status-pill ${row.status.replace(' ', '-')}`}>{row.status}</span>
        <span>{mainRecordTypeLabel(row.displayType, true)}</span>
        {row.technicianLabel ? <span>{row.technicianLabel}</span> : <span>Unassigned</span>}
      </div>
      <div className="mobile-card-money">
        <span>Total <strong>{money(row.total)}</strong></span>
        <span>Due <strong>{money(row.remaining)}</strong></span>
      </div>
    </article>
  );
}

function MobileDrawer(props: {
  open: boolean;
  profileName: string;
  role: string;
  onClose: () => void;
  onOpenModal: (type: string, payload?: any) => void;
  onRefresh: () => void;
  update?: MobileUpdate | null;
  updateOpening?: boolean;
  onUpdate?: () => void;
  onSignOut: () => void;
}) {
  const { open, profileName, role, onClose, onOpenModal, onRefresh, update, updateOpening = false, onUpdate, onSignOut } = props;
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    technician: true,
    admin: false,
  });
  const technicianTools = [
    ['technicians', 'Technicians'],
    ['journal', 'Journal'],
    ['diagnosticTools', 'Diagnostic Tools'],
  ] as const;
  const adminTools = [
    ['repairCategories', 'Repairs'],
    ['inventory', 'Inventory'],
    ['reporting', 'Reporting'],
    ['dataTools', 'Data Tools'],
  ] as const;
  const toggleSection = (section: string) => setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  const handleOpenModal = (type: string, payload?: any) => {
    onClose();
    onOpenModal(type, payload);
  };

  if (!open) return null;

  return (
    <div className="mobile-drawer-layer is-open">
      <button type="button" className="mobile-drawer-scrim" onClick={onClose} aria-label="Close menu" />
      <aside className="mobile-drawer">
        <header className="mobile-drawer-header">
          <button type="button" className="mobile-icon-button" onClick={onClose} aria-label="Close menu">x</button>
          <div className="mobile-drawer-session">
            <strong>{profileName || 'Shop Access'}</strong>
            <span>{role} session</span>
          </div>
        </header>

        <div className="mobile-drawer-hero-actions" aria-label="Priority actions">
          <DrawerButton label="Generate Quote" tone="green" featured onClick={() => handleOpenModal('quoteGenerator')} />
          <DrawerButton label="Consultation" tone="blue" featured onClick={() => handleOpenModal('consultation')} />
        </div>

        <DrawerSection title="Technician Tools" open={openSections.technician} tone="blue" onToggle={() => toggleSection('technician')}>
          <DrawerButton label="Calendar" onClick={() => handleOpenModal('calendar')} />
          <DrawerButton label="Daily Look" onClick={() => handleOpenModal('dailyLook')} />
          {technicianTools.map(([type, label]) => <DrawerButton key={type} label={label} onClick={() => handleOpenModal(type)} />)}
        </DrawerSection>

        <DrawerSection title="Admin" open={openSections.admin} tone="red" onToggle={() => toggleSection('admin')}>
          {adminTools.map(([type, label]) => <DrawerButton key={type} label={label} onClick={() => handleOpenModal(type)} />)}
        </DrawerSection>

        <div className="mobile-drawer-footer">
          {update ? (
            <button
              type="button"
              className="mobile-drawer-update"
              onClick={onUpdate}
              disabled={updateOpening}
            >
              {updateOpening ? 'Opening update...' : `Update to ${update.version}`}
            </button>
          ) : null}
          <button type="button" onClick={onRefresh}>Sync now</button>
          <button type="button" onClick={() => handleOpenModal('feedback')}>Feedback</button>
          <button type="button" className="danger" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>
    </div>
  );
}

function DiagnosticToolsWindow() {
  return (
    <div className="mobile-empty-state">
      <strong>Diagnostic Tools</strong>
      <span>Mobile tech utilities can live here next: symptom checklists, quick tests, intake helpers, and field notes.</span>
    </div>
  );
}

function DrawerSection({ title, open, tone = 'default', onToggle, children }: { title: string; open: boolean; tone?: 'default' | 'blue' | 'red'; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className={`mobile-drawer-section mobile-drawer-section-${tone}`}>
      <button type="button" className="mobile-drawer-section-toggle" onClick={onToggle} aria-expanded={open}>
        <span>{title}</span>
        <span aria-hidden="true">{open ? 'v' : '>'}</span>
      </button>
      {open ? <div className="mobile-drawer-section-body">{children}</div> : null}
    </section>
  );
}

function DrawerButton({ label, onClick, tone = 'default', featured = false }: { label: string; onClick: () => void; tone?: 'default' | 'green' | 'blue' | 'purple' | 'amber'; featured?: boolean }) {
  return (
    <button type="button" className={`mobile-drawer-button mobile-drawer-button-${tone}${featured ? ' featured' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <span aria-hidden="true">&gt;</span>
    </button>
  );
}

function ActionSheet({ row, actions, onClose }: { row: MobileRow; actions: SheetAction[]; onClose: () => void }) {
  const drag = useSheetDrag(onClose);
  return (
    <div className="mobile-action-layer">
      <button type="button" className="mobile-action-scrim" onClick={onClose} aria-label="Close actions" />
      <section
        className={`mobile-action-sheet${drag.dragging ? ' is-dragging' : ''}`}
        style={drag.sheetStyle}
        role="dialog"
        aria-modal="true"
        aria-label={`Actions for ${invoiceNumber(row.id)}`}
      >
        <button
          type="button"
          className="mobile-sheet-grabber"
          aria-label="Drag down to close actions"
          {...drag.handleProps}
        />
        <header>
          <span>{mainRecordTypeLabel(row.displayType)}</span>
          <strong>{invoiceNumber(row.id)}</strong>
          <p>{row.customerName}</p>
        </header>
        <div className="mobile-action-list">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              className={[action.kind ? `contact ${action.kind}` : '', action.danger ? 'danger' : ''].filter(Boolean).join(' ')}
              onClick={async () => {
                if (action.disabled) return;
                await action.onPress();
                onClose();
              }}
            >
              <span>{action.label}</span>
              {action.detail ? <small>{action.detail}</small> : null}
            </button>
          ))}
        </div>
        <button type="button" className="mobile-sheet-cancel" onClick={onClose}>Cancel</button>
      </section>
    </div>
  );
}

function openRecord(row: MobileRow) {
  if (row.type === 'workorder') {
    void window.api.openNewWorkOrder?.({ workOrderId: row.id });
    return;
  }
  void window.api.openNewSale?.({ id: row.id });
}

function makeSheetActions(row: MobileRow, afterWrite: () => void): SheetAction[] {
  const hasCustomer = !!row.customerId;
  const formattedPhone = (formatPhone(String(row.phone || '')) || String(row.phone || '')).trim();
  const phoneDigits = String(row.phone || '').replace(/\D+/g, '');
  const contactPhone = phoneDigits.length >= 7 ? phoneDigits : '';
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  if (row.type === 'workorder') {
    return [
      { label: 'Edit / Open', onPress: () => window.api.openNewWorkOrder?.({ workOrderId: row.id }) },
      { label: 'Checkout', onPress: () => window.api.openCheckout?.({ workOrderId: row.id }) },
      { label: 'View Client', disabled: !hasCustomer, onPress: () => window.api.openCustomerOverview?.(row.customerId as number) },
      { label: 'Copy Invoice #', detail: invoiceNumber(row.id), onPress: () => copy(invoiceNumber(row.id)) },
      {
        label: 'Call Number',
        detail: formattedPhone || undefined,
        kind: 'call',
        disabled: !contactPhone,
        onPress: () => { window.location.href = `tel:${contactPhone}`; },
      },
      {
        label: 'Text Number',
        detail: formattedPhone || undefined,
        kind: 'text',
        disabled: !contactPhone,
        onPress: () => { window.location.href = `sms:${contactPhone}`; },
      },
      { label: 'Customer Receipt', onPress: () => window.api.openCustomerReceipt?.({ workOrderId: row.id }) },
      { label: 'Release Form', onPress: () => window.api.openReleaseForm?.({ workOrderId: row.id }) },
      {
        label: 'Duplicate',
        onPress: async () => {
          const nowIso = new Date().toISOString();
          const draft = { ...row.source };
          delete draft.id;
          draft.status = 'open';
          draft.amountPaid = 0;
          draft.checkInAt = nowIso;
          draft.activityAt = nowIso;
          draft.totals = computeTotals(draft);
          await window.api.dbAdd?.('workOrders', draft);
          afterWrite();
        },
      },
      row.remaining > 0 ? {
        label: 'Mark Paid in Full',
        onPress: async () => {
          const totals = computeTotals(row.source);
          await window.api.dbUpdate?.('workOrders', row.id, { ...row.source, amountPaid: totals.total, totals: { ...totals, remaining: 0 }, status: 'closed' });
          afterWrite();
        },
      } : {
        label: 'Reopen',
        onPress: async () => {
          const totals = computeTotals(row.source);
          await window.api.dbUpdate?.('workOrders', row.id, { ...row.source, totals, status: 'open' });
          afterWrite();
        },
      },
      {
        label: 'Delete',
        danger: true,
        onPress: async () => {
          const ok = window.confirm(`Delete work order ${invoiceNumber(row.id)}? This cannot be undone.`);
          if (!ok) return;
          await window.api.dbDelete?.('workOrders', row.id);
          afterWrite();
        },
      },
    ];
  }

  return [
    { label: 'Edit / Open', onPress: () => window.api.openNewSale?.({ id: row.id }) },
    { label: 'View Client', disabled: !hasCustomer, onPress: () => window.api.openCustomerOverview?.(row.customerId as number) },
    { label: 'Copy Invoice #', detail: invoiceNumber(row.id), onPress: () => copy(invoiceNumber(row.id)) },
    { label: 'Copy Phone', detail: formattedPhone || undefined, disabled: !formattedPhone, onPress: () => copy(formattedPhone) },
    {
      label: 'Delete',
      danger: true,
      onPress: async () => {
        const ok = window.confirm(`Delete sale ${invoiceNumber(row.id)}? This cannot be undone.`);
        if (!ok) return;
        await window.api.dbDelete?.('sales', row.id);
        afterWrite();
      },
    },
  ];
}

export default MobileApp;
