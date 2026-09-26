import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import SidebarFilters from './components/SidebarFilters';
import Toolbar from './components/Toolbar';
import WorkOrdersTable from './components/WorkOrdersTable';
import SalesTable from './components/SalesTable';
import CustomerHoverCard from './components/CustomerHoverCard';
import ItemsDescriptionHoverCard from './components/ItemsDescriptionHoverCard';
import Pagination from './components/Pagination';
import RecentCustomers from './components/RecentCustomers';
import CustomerSearchWindow from './components/CustomerSearchWindow';
import GidgetChat from './components/GidgetChat';
import CommandCenter from './components/CommandCenter';
import ContextMenu, { ContextMenuItem } from './components/ContextMenu';
import { useContextMenu } from './lib/useContextMenu';
import { formatPhone } from './lib/format';
import { PaginationProvider, usePagination } from './lib/pagination';
import { dispatchOpenModal, registerOpenModal, unregisterOpenModal } from './lib/modalBus';
import { storeWindowPayload } from './lib/windowPayload';
import { openAdminTool, type AdminToolKey } from './lib/adminWindowNavigation';
import { LoginScreen } from './auth/LoginScreen';
import DurantApp from './durant/DurantApp';
import { getSupabaseRuntimeConfig, isTestEnvironment, supabase } from './lib/supabase';
import PlatformPermissionHandshake from './components/PlatformPermissionHandshake';
import { mainRecordKind, mainRecordTypeLabel } from './lib/consultationRecord';
import { publicAsset } from './lib/publicAsset';
import { reconcilePaidSaleInventory, reconcilePaidWorkOrderInventory } from './lib/inventoryConsumption';
import './styles/desktop-nav-preview.css';

// ── Lazy window components (shared chunk cache with main.tsx) ─────────────
const NewWorkOrderWindow        = React.lazy(() => import('./workorders/NewWorkOrderWindow'));
const SaleWindow                = React.lazy(() => import('./sales/SaleWindow'));
const CalendarWindow            = React.lazy(() => import('./components/CalendarWindow'));
const DailyLookWindow           = React.lazy(() => import('./components/DailyLookWindow'));
const ClockInWindow             = React.lazy(() => import('./components/ClockInWindow'));
const QuoteGeneratorWindow      = React.lazy(() => import('./components/QuoteGeneratorWindow'));
const EODWindow                 = React.lazy(() => import('./components/EODWindow'));
const ProductsWindow            = React.lazy(() => import('./components/ProductsWindow'));
const InventoryWindow           = React.lazy(() => import('./components/InventoryWindow'));
const VendorsWindow             = React.lazy(() => import('./components/VendorsWindow'));
const WorkOrderRepairPickerWindow = React.lazy(() => import('./workorders/WorkOrderRepairPickerWindow'));
const CustomerOverviewWindow    = React.lazy(() => import('./components/CustomerOverviewWindow'));
const QuickSaleWindow           = React.lazy(() => import('./components/QuickSaleWindow'));
const ConsultationBookingWindow = React.lazy(() => import('./components/ConsultationBookingWindow'));
const CheckoutWindow            = React.lazy(() => import('./workorders/CheckoutWindow'));
const DevMenuWindow             = React.lazy(() => import('./components/DevMenuWindow'));
const DataToolsWindow           = React.lazy(() => import('./components/DataToolsWindow'));
const ReportingWindow           = React.lazy(() => import('./components/ReportingWindow'));
const ReportEmailWindow         = React.lazy(() => import('./components/ReportEmailWindow'));
const ChartsWindow              = React.lazy(() => import('./components/ChartsWindow'));
const NotificationsWindow       = React.lazy(() => import('./components/NotificationsWindow'));
const NotificationSettingsWindow = React.lazy(() => import('./components/NotificationSettingsWindow'));
const JournalWindow             = React.lazy(() => import('./components/JournalWindow'));
const TechniciansWindow         = React.lazy(() => import('./components/TechniciansWindow'));
const ReleaseFormWindow         = React.lazy(() => import('./workorders/ReleaseFormWindow'));
const CustomerReceiptWindow     = React.lazy(() => import('./workorders/CustomerReceiptWindow'));
const ProductFormWindow         = React.lazy(() => import('./sales/ProductFormWindow'));
const BackupWindow              = React.lazy(() => import('./components/BackupWindow'));
const ClearDatabaseWindow       = React.lazy(() => import('./components/ClearDatabaseWindow'));
const RepairCategoriesWindow    = React.lazy(() => import('./repairs/RepairCategoriesWindow'));
const DeviceCategoriesWindow    = React.lazy(() => import('./components/DeviceCategoriesWindow'));
const CustomBuildItemWindow     = React.lazy(() => import('./workorders/CustomBuildItemWindow'));
const ClientUpdatePanel         = React.lazy(() => import('./workorders/ClientUpdatePanel'));
const FeedbackWindow            = React.lazy(() => import('./components/FeedbackWindow'));
const GameMenuWindow            = React.lazy(() => import('./components/GameMenuWindow'));

// ── map api method names → modal type ─────────────────────────────────────
const API_TO_MODAL: Record<string, string> = {
  openNewWorkOrder:          'newWorkOrder',
  openNewSale:               'newSale',
  openCalendar:              'calendar',
  openClockIn:               'clockIn',
  openQuoteGenerator:        'quoteGenerator',
  openEod:                   'eod',
  openProducts:              'products',
  openInventory:             'inventory',
  openVendors:               'vendors',
  openWorkOrderRepairPicker: 'workOrderRepairPicker',
  openCustomerOverview:      'customerOverview',
  openQuickSale:             'quickSale',
  openConsultation:          'consultation',
  openCheckout:              'checkout',
  openDevMenu:               'devMenu',
  openDataTools:             'dataTools',
  openReporting:             'reporting',
  openReportEmail:           'reportEmail',
  openCharts:                'charts',
  openNotifications:         'notifications',
  openNotificationSettings:  'notificationSettings',
  openReleaseForm:           'releaseForm',
  openCustomerReceipt:       'customerReceipt',
  openProductForm:           'productForm',
  openBackup:                'backup',
  openRepairCategories:      'repairCategories',
  openDeviceCategories:      'deviceCategories',
  openWorkOrder:             'newWorkOrder',
};

interface ModalEntry { id: string; type: string; }

// ── Overlay close button + content shell ─────────────────────────────────
function ModalShell({ entry, zIndex, onClose }: { entry: ModalEntry; zIndex: number; onClose: () => void }) {
  const contentOwnsClose = entry.type === 'customerSearch' || entry.type === 'customerOverview' || entry.type === 'addClient';
  const daughterWindow = !['newWorkOrder', 'newSale', 'consultation', 'repairCategories', 'inventory', 'reporting', 'dataTools', 'devMenu'].includes(entry.type);
  const windowProfile = entry.type === 'calendar'
    ? 'calendar'
    : ['quoteGenerator', 'eod', 'products', 'vendors', 'workOrderRepairPicker', 'backup', 'technicians'].includes(entry.type)
      ? 'dense'
      : ['notifications', 'notificationSettings', 'clockIn', 'journal', 'reportEmail', 'charts', 'releaseForm', 'customerReceipt', 'feedback'].includes(entry.type)
        ? 'compact'
        : 'standard';
  const popOut = async () => {
    const api: any = (window as any).api;
    const method = Object.entries(API_TO_MODAL).find(([, type]) => type === entry.type)?.[0];
    if (method && typeof api?.[method] === 'function') {
      await api[method]();
      onClose();
      return;
    }
    window.open(window.location.href, '_blank', 'width=1100,height=820,resizable=yes,scrollbars=yes');
  };
  // Close on Escape – only the top-most modal should fire.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [onClose]);

  return (
    <div
      className={daughterWindow ? 'gb-daughter-modal-layer fixed inset-0 overflow-y-auto overflow-x-hidden p-3 pt-12 sm:p-6 sm:pt-12' : 'fixed inset-0 bg-zinc-900 overflow-y-auto overflow-x-auto p-3 pt-12 sm:p-6 sm:pt-12'}
      style={{ zIndex }}
      data-modal-shell="1"
      data-modal-type={entry.type}
    >
      {/* Floating actions + close button */}
      <div
        className="fixed top-2 flex items-center gap-2"
        style={{ zIndex: zIndex + 1, right: 'calc(0.75rem + 32px)' }}
      >
        {daughterWindow ? <button
          type="button"
          onClick={() => void popOut()}
          title="Open in separate window"
          aria-label="Open in separate window"
          className="w-8 h-8 rounded bg-zinc-800 hover:border-blue-400 text-zinc-200 flex items-center justify-center text-base border border-zinc-600"
        >↗</button> : null}
        {entry.type === 'products' && (
          <button
            type="button"
            onClick={() => dispatchOpenModal('inventory')}
            title="Open Inventory"
            className="h-8 px-3 rounded-full bg-[#BC13FE] text-white font-semibold text-sm shadow-lg border border-[#BC13FE] hover:brightness-110 transition"
          >
            Inventory
          </button>
        )}
        {entry.type !== 'checkout' && !contentOwnsClose && (
          <button
            onClick={onClose}
            title="Close window (Esc)"
            className="w-8 h-8 rounded-full bg-zinc-700 hover:bg-red-600 text-zinc-300 hover:text-white flex items-center justify-center text-lg font-bold leading-none shadow-lg transition-colors select-none"
          >
            ✕
          </button>
        )}
      </div>
      <div className={daughterWindow ? `gb-daughter-modal-panel gb-window-profile-${windowProfile}` : undefined}><React.Suspense fallback={
        <div className="flex min-h-[100dvh] items-center justify-center text-zinc-500">Loading…</div>
      }>
        <ModalContent type={entry.type} onClose={onClose} />
      </React.Suspense></div>
    </div>
  );
}

// ── Route modal type → window component ──────────────────────────────────
function ModalContent({ type, onClose }: { type: string; onClose: () => void }) {
  switch (type) {
    case 'newWorkOrder':           return <NewWorkOrderWindow />;
    case 'newSale':                return <SaleWindow />;
    case 'calendar':               return <CalendarWindow />;
    case 'dailyLook':              return <DailyLookWindow />;
    case 'clockIn':                return <ClockInWindow />;
    case 'quoteGenerator':         return <QuoteGeneratorWindow />;
    case 'eod':                    return <EODWindow />;
    case 'products':               return <ProductsWindow />;
    case 'inventory':              return <InventoryWindow />;
    case 'vendors':                return <VendorsWindow />;
    case 'workOrderRepairPicker':  return <WorkOrderRepairPickerWindow />;
    case 'customerOverview':       return <CustomerOverviewWindow onClose={onClose} />;
    case 'customerSearch':         return <CustomerSearchWindow onClose={onClose} />;
    case 'quickSale':              return <QuickSaleWindow />;
    case 'consultation':           return <ConsultationBookingWindow />;
    case 'checkout':               return <CheckoutWindow />;
    case 'devMenu':                return <DevMenuWindow />;
    case 'dataTools':              return <DataToolsWindow />;
    case 'reporting':              return <ReportingWindow />;
    case 'reportEmail':            return <ReportEmailWindow />;
    case 'charts':                 return <ChartsWindow />;
    case 'notifications':          return <NotificationsWindow />;
    case 'notificationSettings':   return <NotificationSettingsWindow />;
    case 'journal':                return <JournalWindow />;
    case 'technicians':            return <TechniciansWindow onClose={onClose} />;
    case 'diagnosticTools':        return (
      <section className="mx-auto mt-12 max-w-3xl border border-zinc-700 bg-zinc-950 p-8">
        <h2 className="text-2xl font-bold text-blue-300">Diagnostic Tools</h2>
        <p className="mt-3 text-zinc-400">This workspace is ready for symptom checklists, electrical test references, intake helpers, and field diagnostics.</p>
      </section>
    );
    case 'releaseForm':            return <ReleaseFormWindow />;
    case 'customerReceipt':        return <CustomerReceiptWindow />;
    case 'productForm':            return <ProductFormWindow />;
    case 'backup':                 return <BackupWindow />;
    case 'clearDb':                return <ClearDatabaseWindow />;
    case 'repairCategories':       return <RepairCategoriesWindow mode="admin" />;
    case 'deviceCategories':       return <DeviceCategoriesWindow />;
    case 'customBuildItem':        return <CustomBuildItemWindow />;
    case 'feedback':               return <FeedbackWindow />;
    case 'gameMenu':               return <GameMenuWindow />;
    default:                       return <div className="p-8 text-zinc-400">Unknown modal: {type}</div>;
  }
}

function getActivityDate(record: any): Date {
  const raw = record?.activityAt || record?.checkoutDate || record?.repairCompletionDate || record?.clientPickupDate || record?.checkInAt || record?.createdAt || record?.updatedAt || 0;
  return new Date(raw);
}

type StaffProfile = {
  id: string;
  shop_id: string;
  role: 'admin' | 'manager' | 'technician' | 'durant';
  status: 'invited' | 'active' | 'disabled';
  first_name: string | null;
  last_name: string | null;
  email: string;
};

function removeInitialHtmlLoader() {
  try {
    document.getElementById('gbpos-initial-loader')?.remove();
  } catch {
    // ignore
  }
}

const StartupStatusScreen: React.FC<{ title: string; message?: string; error?: string }> = ({ title, message, error }) => {
  removeInitialHtmlLoader();
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center px-6">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="text-lg font-semibold text-[#39FF14]">{title}</div>
        {message ? <div className="mt-2 text-sm text-zinc-300">{message}</div> : null}
        {error ? <div className="mt-4 rounded border border-red-500/40 bg-red-950/50 px-3 py-2 text-sm text-red-100">{error}</div> : null}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const testEnvironment = isTestEnvironment();
  const clientUpdateToken = useRef<string>('');
  if (!clientUpdateToken.current) {
    try {
      clientUpdateToken.current = new URLSearchParams(window.location.search).get('clientUpdateToken') || '';
    } catch {
      clientUpdateToken.current = '';
    }
  }
  useEffect(() => {
    if (!clientUpdateToken.current) return;
    const previousTitle = document.title;
    document.title = 'GB Update Interface';
    return () => { document.title = previousTitle; };
  }, []);
  const [showCustomerSearch, setShowCustomerSearch] = useState(false);
  const [technicianFilter, setTechnicianFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [woQuery, setWoQuery] = useState<string>('');
  const [mode, setMode] = useState<'workorders'|'sales'|'all'>('all');
  const [refreshKey, setRefreshKey] = useState(0);

  const [authLoading, setAuthLoading] = useState(!testEnvironment);
  const [session, setSession] = useState<Session | null>(testEnvironment ? ({ access_token: 'test-environment', user: { id: 'test-environment' } } as Session) : null);
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(testEnvironment ? { id: 'test-environment', shop_id: 'test-environment', role: 'admin', status: 'active', first_name: 'Test', last_name: 'User', email: 'test@example.com' } : null);
  const [cloudReady, setCloudReady] = useState(testEnvironment);
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
    if (testEnvironment) {
      setAuthLoading(false);
      setCloudReady(true);
      return;
    }
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
  }, [loadStaffProfile, testEnvironment]);

  useEffect(() => {
    if (testEnvironment) {
      setCloudReady(true);
      void (window as any).api?.cloudClearSession?.();
      return;
    }
    const api = (window as any).api;
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
        setRefreshKey((v) => v + 1);
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
  }, [session?.access_token, staffProfile?.shop_id, testEnvironment]);

  useEffect(() => {
    if (testEnvironment) return;
    const shopId = staffProfile?.shop_id;
    const api = (window as any).api;
    if (!cloudReady || !shopId || !api?.cloudCollectionChanged) return;

    const channel = supabase
      .channel(`gbpos-desktop-technicians-${shopId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'staff_profiles', filter: `shop_id=eq.${shopId}` },
        () => { void api.cloudCollectionChanged('technicians'); },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [cloudReady, staffProfile?.shop_id, testEnvironment]);

  useEffect(() => {
    if (testEnvironment) return;
    const shopId = staffProfile?.shop_id;
    const api = (window as any).api;
    if (!cloudReady || !shopId || !api?.cloudCollectionChanged) return;
    const tables: Array<[string, string]> = [
      ['customers', 'customers'],
      ['work_orders', 'workOrders'],
      ['sales', 'sales'],
    ];
    const channel = tables.reduce((current, [table, collection]) => current.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `shop_id=eq.${shopId}` },
      () => { void api.cloudCollectionChanged(collection); },
    ), supabase.channel(`gbpos-desktop-records-${shopId}`)).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [cloudReady, staffProfile?.shop_id, testEnvironment]);

  useEffect(() => {
    if (testEnvironment || !cloudReady || !staffProfile?.shop_id) return;
    void (async () => {
      await reconcilePaidSaleInventory((window as any).api);
      await reconcilePaidWorkOrderInventory((window as any).api);
    })().catch((error) => {
      console.error('Startup inventory reconciliation failed', error);
    });
  }, [cloudReady, staffProfile?.shop_id, testEnvironment]);

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

        {accessError ? (
          <div className="fixed bottom-4 left-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 rounded-md border border-red-500/40 bg-red-950 px-4 py-3 text-sm text-red-100 shadow-xl">
            {accessError}
          </div>
        ) : null}
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

  if (clientUpdateToken.current) {
    return (
      <React.Suspense fallback={<StartupStatusScreen title="Loading Update Client" message="Opening the QR status panel..." />}>
        <ClientUpdatePanel
          token={clientUpdateToken.current}
          onClose={() => {
            try {
              window.history.replaceState({}, '', window.location.pathname);
            } catch {
              // ignore
            }
            clientUpdateToken.current = '';
            window.location.reload();
          }}
        />
      </React.Suspense>
    );
  }

  return (
    <PaginationProvider pageSize={30}>
      <AppInner
        showCustomerSearch={showCustomerSearch}
        setShowCustomerSearch={setShowCustomerSearch}
        technicianFilter={technicianFilter}
        setTechnicianFilter={setTechnicianFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        dateFrom={dateFrom}
        setDateFrom={setDateFrom}
        dateTo={dateTo}
        setDateTo={setDateTo}
        woQuery={woQuery}
        setWoQuery={setWoQuery}
        mode={mode}
        setMode={setMode}
        refreshKey={refreshKey}
        setRefreshKey={setRefreshKey}
        onSignOut={() => void supabase.auth.signOut()}
      />
      {cloudWarning ? (
        <div className="fixed bottom-4 left-1/2 z-50 w-[min(92vw,620px)] -translate-x-1/2 rounded-md border border-amber-500/40 bg-amber-950 px-4 py-3 text-sm text-amber-100 shadow-xl">
          {cloudWarning}
        </div>
      ) : null}
    </PaginationProvider>
  );
};

export default App;

const AppInner: React.FC<{
  showCustomerSearch: boolean;
  setShowCustomerSearch: (v: boolean) => void;
  technicianFilter: string;
  setTechnicianFilter: (v: string) => void;
  statusFilter: 'all' | 'open' | 'closed';
  setStatusFilter: (v: 'all' | 'open' | 'closed') => void;
  dateFrom: string;
  setDateFrom: (v: string) => void;
  dateTo: string;
  setDateTo: (v: string) => void;
  woQuery: string;
  setWoQuery: (v: string) => void;
  mode: 'workorders' | 'sales' | 'all';
  setMode: (v: 'workorders' | 'sales' | 'all') => void;
  refreshKey: number;
  setRefreshKey: (v: number) => void;
  onSignOut: () => void;
}> = ({
  showCustomerSearch,
  setShowCustomerSearch,
  technicianFilter,
  setTechnicianFilter,
  statusFilter,
  setStatusFilter,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  woQuery,
  setWoQuery,
  mode,
  setMode,
  refreshKey,
  setRefreshKey,
  onSignOut,
}) => {
  const { setPage } = usePagination();
  const [invoiceQuery, setInvoiceQuery] = useState<string>('');
  const [keyword, setKeyword] = useState<string>('');
  const [gidgetOpen, setGidgetOpen] = useState(false);
  const desktopNavigationEnabled = true;
  const desktopDrawerPreviewOpen = new URLSearchParams(window.location.search).get('desktopNavPreview') === '1';
  const [desktopDrawerOpen, setDesktopDrawerOpen] = useState(desktopDrawerPreviewOpen);
  const [desktopDrawerClosing, setDesktopDrawerClosing] = useState(false);
  const [desktopDrawerPinned, setDesktopDrawerPinned] = useState(desktopDrawerPreviewOpen);
  const [desktopFiltersOpen, setDesktopFiltersOpen] = useState(false);
  const [desktopAttentionRequest, setDesktopAttentionRequest] = useState(0);
  const [desktopView, setDesktopView] = useState<'command' | 'invoices'>('command');
  const desktopFiltersRef = useRef<HTMLDivElement>(null);
  const desktopDrawerCloseTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (desktopDrawerCloseTimerRef.current !== null) {
      window.clearTimeout(desktopDrawerCloseTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!desktopNavigationEnabled || !desktopFiltersOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!desktopFiltersRef.current?.contains(event.target as Node)) setDesktopFiltersOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDesktopFiltersOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [desktopFiltersOpen, desktopNavigationEnabled]);

  // ── Modal stack ──────────────────────────────────────────────────────────
  const [modalStack, setModalStack] = useState<ModalEntry[]>([]);
  const modalCounterRef = useRef(0);

  const openModal = useCallback((type: string, payload?: any) => {
    if (payload !== undefined && payload !== null) {
      storeWindowPayload(type, payload);
    }
    const id = `${type}-${++modalCounterRef.current}`;
    setModalStack(s => [...s, { id, type }]);
  }, []);

  const closeModal = useCallback((id: string) => {
    setModalStack(s => s.filter(m => m.id !== id));
  }, []);

  const closeTopModal = useCallback(() => {
    setModalStack(s => s.length > 0 ? s.slice(0, -1) : s);
  }, []);

  // Keep a ref so the window.close override always sees the latest callback.
  const closeTopModalRef = useRef(closeTopModal);
  useEffect(() => { closeTopModalRef.current = closeTopModal; });

  // Register bus + intercept window.api.open* calls
  useEffect(() => {
    registerOpenModal(openModal);

    const api = (window as any).api;
    if (!api) return () => { unregisterOpenModal(); };

    const canOverrideApiMethod = (method: string): boolean => {
      try {
        const d = Object.getOwnPropertyDescriptor(api, method);
        // contextBridge typically exposes non-writable, non-configurable props.
        // If we can't confirm it's writable/configurable, do not attempt to patch.
        return !!d && (d.writable === true || d.configurable === true);
      } catch {
        return false;
      }
    };

    // Save originals so we can restore on unmount.
    const saved: Record<string, any> = {};
    for (const [method, type] of Object.entries(API_TO_MODAL)) {
      if (method in api) {
        saved[method] = api[method];
        const capturedType = type;

        if (canOverrideApiMethod(method)) {
          try {
            (api as any)[method] = (payload?: any) => {
              openModal(capturedType, payload);
              return Promise.resolve();
            };
          } catch {
            // If the API object is read-only (contextBridge), skip patching.
          }
        }
      }
    }

    // closeSelfWindow → close top modal
    if ('closeSelfWindow' in api) {
      saved.closeSelfWindow = api.closeSelfWindow;
      if (canOverrideApiMethod('closeSelfWindow')) {
        try {
          api.closeSelfWindow = () => { closeTopModalRef.current(); return Promise.resolve(); };
        } catch {
          // read-only in packaged builds
        }
      }
    }

    // window.close → close top modal (falls back to real close when no modals are open)
    const origWindowClose = window.close.bind(window);
    try {
      (window as any).close = () => {
        if (modalCounterRef.current > 0 && document.querySelectorAll('[data-modal-shell]').length > 0) {
          closeTopModalRef.current();
        } else {
          origWindowClose();
        }
      };
    } catch { /* read-only in some envs */ }

    return () => {
      unregisterOpenModal();
      for (const [method, orig] of Object.entries(saved)) {
        if (canOverrideApiMethod(method)) {
          try { (api as any)[method] = orig; } catch {}
        }
      }
      try { (window as any).close = origWindowClose; } catch {}
    };
  }, [openModal]); // openModal is stable (useCallback [])

  useEffect(() => {
    // Keep invoice search scoped to Sales mode.
    if (mode !== 'sales' && invoiceQuery) setInvoiceQuery('');
  }, [mode, invoiceQuery]);

  useEffect(() => {
    // Keep WO# filter scoped to non-sales mode.
    if (mode === 'sales' && woQuery) setWoQuery('');
  }, [mode, woQuery, setWoQuery]);

  useEffect(() => {
    setPage(1);
  }, [mode, technicianFilter, dateFrom, dateTo, woQuery, setPage]);

  const handleClear = () => {
    setTechnicianFilter('');
    setStatusFilter('all');
    setDateFrom('');
    setDateTo('');
    setWoQuery('');
    setInvoiceQuery('');
    setKeyword('');
  };

  const showDesktopDrawer = (pinned = false) => {
    if (desktopDrawerCloseTimerRef.current !== null) {
      window.clearTimeout(desktopDrawerCloseTimerRef.current);
      desktopDrawerCloseTimerRef.current = null;
    }
    setDesktopDrawerClosing(false);
    setDesktopDrawerPinned(pinned);
    setDesktopDrawerOpen(true);
  };

  const closeDesktopDrawer = (immediate = false) => {
    setDesktopDrawerPinned(false);
    if (desktopDrawerCloseTimerRef.current !== null) {
      window.clearTimeout(desktopDrawerCloseTimerRef.current);
      desktopDrawerCloseTimerRef.current = null;
    }
    if (immediate || !desktopDrawerOpen) {
      setDesktopDrawerClosing(false);
      setDesktopDrawerOpen(false);
      return;
    }
    setDesktopDrawerClosing(true);
    desktopDrawerCloseTimerRef.current = window.setTimeout(() => {
      setDesktopDrawerOpen(false);
      setDesktopDrawerClosing(false);
      desktopDrawerCloseTimerRef.current = null;
    }, 180);
  };

  const openDrawerModal = (type: string, payload?: any) => {
    closeDesktopDrawer(true);
    openModal(type, payload);
  };

  const openDrawerAdmin = (tool: AdminToolKey) => {
    closeDesktopDrawer(true);
    void openAdminTool(tool, (window as any).api, key => openModal(key));
  };

  const openDrawerConsultation = () => {
    closeDesktopDrawer(true);
    const api: any = (window as any).api;
    if (typeof api?.openConsultation === 'function') void api.openConsultation();
    else openModal('consultation');
  };

  return (
    <div className={`bg-zinc-900 min-h-screen text-white flex flex-col relative${desktopNavigationEnabled ? ' desktop-nav-preview' : ''}`}>
      {desktopNavigationEnabled ? (
        <>
          <div
            className="desktop-drawer-hotspot"
            onMouseEnter={() => showDesktopDrawer(false)}
            aria-hidden="true"
          />
          {desktopDrawerOpen ? (
            <div className={`desktop-drawer-layer${desktopDrawerClosing ? ' closing' : ''}`}>
              <button type="button" className="desktop-drawer-scrim" onClick={() => closeDesktopDrawer()} aria-label="Close navigation menu" />
              <aside
                className="desktop-drawer"
                onMouseLeave={() => {
                  if (!desktopDrawerPinned) closeDesktopDrawer();
                }}
              >
                <header className="desktop-drawer-header">
                  <div className="desktop-drawer-close-row">
                    <button type="button" className="desktop-drawer-close" onClick={() => closeDesktopDrawer()} aria-label="Close navigation menu">x</button>
                  </div>
                  <button type="button" className="desktop-drawer-brand" onClick={() => setGidgetOpen(true)} title="Open Gidget">
                    <img src={publicAsset('logo.png')} alt="GadgetBoy" />
                  </button>
                </header>

                <div className="desktop-drawer-primary">
                  <button type="button" className="quote" onClick={() => openDrawerModal('quoteGenerator')}>Generate Quote</button>
                  <button type="button" className="consult" onClick={openDrawerConsultation}>Consultation</button>
                </div>

                <details className="desktop-drawer-section" open>
                  <summary>Technician Tools <span>+</span></summary>
                  <div>
                    <button type="button" onClick={() => openDrawerModal('technicians')}>Technicians</button>
                    <button type="button" onClick={() => openDrawerModal('journal')}>Journal</button>
                    <button type="button" onClick={() => openDrawerModal('diagnosticTools')}>Diagnostic Tools</button>
                  </div>
                </details>

                <details className="desktop-drawer-section admin">
                  <summary>Admin <span>+</span></summary>
                  <div>
                    <button type="button" onClick={() => openDrawerAdmin('repairCategories')}>Repairs</button>
                    <button type="button" onClick={() => openDrawerAdmin('inventory')}>Inventory</button>
                    <button type="button" onClick={() => openDrawerAdmin('reporting')}>Reporting</button>
                    <button type="button" onClick={() => openDrawerAdmin('dataTools')}>Data Tools</button>
                    <button type="button" onClick={() => openDrawerAdmin('devMenu')}>Dev Menu</button>
                  </div>
                </details>

                <footer className="desktop-drawer-footer">
                  <button type="button" className="desktop-drawer-feedback" onClick={() => openDrawerModal('feedback')}>Send Feedback</button>
                  <button type="button" onClick={onSignOut}>Sign out</button>
                </footer>
              </aside>
            </div>
          ) : null}
        </>
      ) : null}
      <div className={`flex flex-1${desktopNavigationEnabled ? ' desktop-preview-workspace' : ''}`}>
        {!desktopNavigationEnabled ? <aside className="w-[320px] shrink-0 bg-zinc-800 border-r border-zinc-700 p-4 flex flex-col gap-6 overflow-y-auto">
          <SidebarFilters
            technicianFilter={technicianFilter}
            onTechnicianFilterChange={setTechnicianFilter}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={setDateFrom}
            onDateToChange={setDateTo}
            onOpenCustomerSearch={() => setShowCustomerSearch(true)}
            onAddCustomer={() => openModal('customerOverview', 0)}
            mode={mode}
            onModeChange={setMode}
            invoiceQuery={invoiceQuery}
            onInvoiceQueryChange={setInvoiceQuery}
            woQuery={woQuery}
            onWoQueryChange={setWoQuery}
            onClear={handleClear}
            onRefresh={() => setRefreshKey(refreshKey + 1)}
            onSignOut={onSignOut}
            onOpenGidget={() => setGidgetOpen(true)}
          />
          <div>
            <RecentCustomers />
          </div>
        </aside> : null}
        <main className="flex-1 min-w-0 flex flex-col">
          <Toolbar
            mode={mode}
            onModeChange={setMode}
            keyword={keyword}
            onKeywordChange={setKeyword}
            drawerMode={desktopNavigationEnabled}
            onOpenMenu={() => {
              setDesktopFiltersOpen(false);
              showDesktopDrawer(true);
            }}
            onOpenNotifications={() => {
              closeDesktopDrawer(true);
              setDesktopFiltersOpen(false);
              openModal('notifications');
            }}
            onSearchClient={() => openModal('customerSearch')}
            onAddClient={() => openModal('customerOverview', 0)}
          />
          {desktopNavigationEnabled ? (
            <div className="desktop-preview-tabs" aria-label="Record type">
              <button type="button" className={desktopView === 'command' ? 'active' : ''} onClick={() => setDesktopView('command')}>Command Center</button>
              <button type="button" className={desktopView === 'invoices' && mode === 'all' ? 'active' : ''} onClick={() => { setDesktopView('invoices'); setMode('all'); }}>All Invoices</button>
              <span className="desktop-preview-tabs-spacer" />
              <button type="button" className="attention" onClick={() => { setDesktopView('command'); setDesktopAttentionRequest(value => value + 1); }}>Needs Attention</button>
              <div className="desktop-preview-filter-control" ref={desktopFiltersRef}>
                {desktopFiltersOpen ? (
                  <div className="desktop-preview-filter-menu" role="dialog" aria-label="List filters">
                    <header>
                      <strong>Filter Activity</strong>
                      <button type="button" onClick={() => setDesktopFiltersOpen(false)} aria-label="Close filters">x</button>
                    </header>
                    <SidebarFilters
                      technicianFilter={technicianFilter}
                      onTechnicianFilterChange={setTechnicianFilter}
                      statusFilter={statusFilter}
                      onStatusFilterChange={setStatusFilter}
                      dateFrom={dateFrom}
                      dateTo={dateTo}
                      onDateFromChange={setDateFrom}
                      onDateToChange={setDateTo}
                      mode={mode}
                      invoiceQuery={invoiceQuery}
                      onInvoiceQueryChange={setInvoiceQuery}
                      woQuery={woQuery}
                      onWoQueryChange={setWoQuery}
                      onClear={handleClear}
                      onRefresh={() => setRefreshKey(refreshKey + 1)}
                      navigationShell
                    />
                  </div>
                ) : null}
              </div>
              {desktopView === 'invoices' ? <><button type="button" className={mode === 'workorders' ? 'active' : ''} onClick={() => setMode('workorders')}>Work Orders</button>
              <button type="button" className={mode === 'sales' ? 'active' : ''} onClick={() => setMode('sales')}>Sales & Consultations</button></> : null}
            </div>
          ) : null}
          <div className="flex-1 min-h-0 overflow-auto">
            {desktopNavigationEnabled && desktopView === 'command' ? <CommandCenter
              keyword={keyword}
              attentionRequest={desktopAttentionRequest}
              onOpenInvoices={(nextMode = 'all') => { setMode(nextMode); setDesktopView('invoices'); }}
              onOpenModal={openModal}
            /> : null}
            {(!desktopNavigationEnabled || desktopView === 'invoices') ? <>
            {keyword === 'GADGETBOY' ? (
              <button
                type="button"
                className="gb-secret-game-result"
                onClick={() => {
                  const api: any = (window as any).api;
                  if (typeof api?.openGameMenu === 'function') void api.openGameMenu();
                  else openModal('gameMenu');
                }}
              >
                <strong>GAME MENU</strong>
                <span>Secret system entry</span>
              </button>
            ) : null}
            {keyword !== 'GADGETBOY' && mode === 'workorders' && (
              <WorkOrdersTable statusFilter={statusFilter} technicianFilter={technicianFilter} dateFrom={dateFrom} dateTo={dateTo} woQuery={woQuery} keyword={keyword} refreshKey={refreshKey} />
            )}
            {keyword !== 'GADGETBOY' && mode === 'sales' && (
              <SalesTable statusFilter={statusFilter} technicianFilter={technicianFilter} dateFrom={dateFrom} dateTo={dateTo} invoiceQuery={invoiceQuery} keyword={keyword} />
            )}
            {keyword !== 'GADGETBOY' && mode === 'all' && (
              <UnifiedList statusFilter={statusFilter} technicianFilter={technicianFilter} dateFrom={dateFrom} dateTo={dateTo} keyword={keyword} />
            )}
            </> : null}
          </div>
          {(!desktopNavigationEnabled || desktopView === 'invoices') ? <div className="border-t border-zinc-700 p-2 flex items-center justify-end bg-zinc-900">
            <Pagination />
          </div> : null}
        </main>
      </div>
      {/* Footer removed; table and pagination now consume extra space */}
      {showCustomerSearch && (
        <CustomerSearchWindow onClose={() => setShowCustomerSearch(false)} />
      )}
      {/* ── Internal modal windows ─────────────────────────────────────── */}
      {modalStack.map((entry, idx) => (
        <ModalShell
          key={entry.id}
          entry={entry}
          zIndex={200 + idx * 10}
          onClose={() => closeModal(entry.id)}
        />
      ))}
      <GidgetChat open={gidgetOpen} onClose={() => setGidgetOpen(false)} />
      <PlatformPermissionHandshake />
    </div>
  );
};

// Unified list of Work Orders and Sales in one table, ordered by id desc
const UnifiedList: React.FC<{ statusFilter?: 'all' | 'open' | 'closed'; technicianFilter?: string; dateFrom?: string; dateTo?: string; keyword?: string }> = ({ statusFilter = 'all', technicianFilter = '', dateFrom = '', dateTo = '', keyword = '' }) => {
  const [wo, setWo] = React.useState<any[]>([]);
  const [sa, setSa] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [techIndex, setTechIndex] = React.useState<Record<string,string>>({});
  const [customerIndex, setCustomerIndex] = React.useState<Record<number, { name: string; phone?: string; phoneAlt?: string; email?: string }>>({});
  const { page, setPage, pageSize, setTotalItems } = usePagination();

  const MAX_PAGES = 10;
  const MAX_ITEMS = pageSize * MAX_PAGES;

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      const [wos, sales, customers] = await Promise.all([
        (window as any).api.getWorkOrders({ limit: MAX_ITEMS, sortBy: 'activityAt', sortDir: 'desc' }),
        (window as any).api.dbGet('sales', { limit: MAX_ITEMS, sortBy: 'checkInAt', sortDir: 'desc' }).catch(() => []),
        ((window as any).api.getCustomers?.() ?? (window as any).api.dbGet('customers')).catch(() => []),
      ]);
      setWo(Array.isArray(wos) ? wos : []);
      setSa(Array.isArray(sales) ? sales : []);
      const nextCustomers: Record<number, { name: string; phone?: string; phoneAlt?: string; email?: string }> = {};
      (Array.isArray(customers) ? customers : []).forEach((customer: any) => {
        const id = Number(customer?.id);
        if (!Number.isFinite(id)) return;
        const composed = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim();
        nextCustomers[id] = {
          name: composed || customer.name || customer.email || `Customer #${id}`,
          phone: customer.phone || '',
          phoneAlt: customer.phoneAlt || '',
          email: customer.email || '',
        };
      });
      setCustomerIndex(nextCustomers);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  }, []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const api = (window as any).api;
    if (!api) {
      // Running in plain Vite/browser without Electron preload; skip IPC subscriptions
      return;
    }
    const offWO = api.onWorkOrdersChanged?.(() => load());
    const offSA = api.onSalesChanged?.(() => load());
    const offCU = api.onCustomersChanged?.(() => load());
    const onMessage = (event: MessageEvent) => {
      const type = String((event.data as any)?.type || '');
      if (type === 'workorders:changed' || type === 'sales:changed' || type === 'customers:changed') void load();
    };
    window.addEventListener('message', onMessage);
    return () => {
      try { offWO && offWO(); } catch {}
      try { offSA && offSA(); } catch {}
      try { offCU && offCU(); } catch {}
      window.removeEventListener('message', onMessage);
    };
  }, [load]);

  React.useEffect(() => {
    const refreshTechs = async () => {
      try {
        const admin = await import('./lib/admin');
        const techs = await admin.listTechnicians();
        const map: Record<string,string> = {};
        techs.forEach((t: any) => { map[t.id] = admin.technicianDisplayName(t); });
        setTechIndex(map);
      } catch {}
    };
    const refreshCustomers = async () => {
      try {
        const customers = await ((window as any).api.getCustomers?.() ?? (window as any).api.dbGet('customers'));
        const cMap: Record<number, { name: string; phone?: string; phoneAlt?: string; email?: string }> = {};
        (customers || []).forEach((c: any) => {
          const composed = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
          const name = composed || c.name || c.email || `Customer #${c.id}`;
          cMap[c.id] = { name, phone: c.phone || '', phoneAlt: c.phoneAlt || '', email: c.email || '' };
        });
        setCustomerIndex(cMap);
      } catch {}
    };
    refreshTechs();
    refreshCustomers();
    const api = (window as any).api;
    const offCustomers = api?.onCustomersChanged?.(() => refreshCustomers());
    const offTechs = api?.onTechniciansChanged?.(() => refreshTechs());
    return () => { try { offCustomers && offCustomers(); } catch {} try { offTechs && offTechs(); } catch {} };
  }, []);

  // Defer the keyword so fast typing doesn't trigger heavy recomputation on
  // every keystroke — the visible input always stays responsive.
  const deferredKeyword = React.useDeferredValue(keyword);

  // Expensive per-row mapping (customer/tech lookups, formatting) — independent
  // of filters/keyword so it only recomputes when the underlying data changes.
  const mappedRows = React.useMemo(() => {
    const normalizeWoStatus = (w: any, remaining: number): 'open' | 'in progress' | 'closed' => {
      const raw = String(w?.status || '').toLowerCase().trim();
      if (raw === 'closed') return 'closed';
      if (raw === 'in progress' || raw === 'inprogress') return 'in progress';
      if (raw === 'open') return 'open';
      return remaining <= 0 ? 'closed' : 'open';
    };

    return [
      ...wo.map(w => ({
        type: 'workorder' as const,
        displayType: mainRecordKind('workorder', w),
        id: w.id,
        customerId: (w as any).customerId as number | undefined,
        date: getActivityDate(w),
        originalDate: new Date(w.checkInAt || w.createdAt || 0),
        status: (() => {
          const total = Number(w.totals?.total || w.total || 0) || 0;
          const remaining = Math.max(0, total - Number(w.amountPaid || 0));
          return normalizeWoStatus(w, remaining);
        })(),
        desc: w.productDescription || w.summary || '',
        items: (() => {
          const list = Array.isArray((w as any).items) ? (w as any).items : [];
          const titles = list.map((it: any) => (it.repair || it.description || it.title || it.name || it.altDescription || '').toString().trim()).filter(Boolean);
          return titles.join(', ') || (w as any).diagnosticSelection?.label || '';
        })(),
        problem: w.problemInfo || (w as any).problem || '',
        customer: (() => {
          const id = (w as any).customerId as number | undefined;
          const fromIndex = id ? customerIndex[id]?.name : '';
          if (fromIndex) return fromIndex;
          const inline = (w as any).customerName as string | undefined;
          if (inline && inline.trim()) return inline.trim();
          const composed = `${(w as any).firstName || ''} ${(w as any).lastName || ''}`.trim();
          if (composed) return composed;
          return id ? `Customer #${id}` : '';
        })(),
        phone: (w.customerId && customerIndex[w.customerId]?.phone) || w.customerPhone || w.phone || '',
        tech: ((): string => {
          const at = (w.assignedTo || '').toString().trim();
          if (!at) return '';
          if (techIndex[at]) return techIndex[at];
          // Try match by known label or first name
          for (const [, label] of Object.entries(techIndex)) {
            if (!label) continue;
            if (label === at) return label;
            const first = label.split(' ')[0];
            if (first && first === at) return label;
          }
          return '';
        })(),
        total: Number(w.totals?.total || w.total || 0) || 0,
        remaining: Number(w.totals?.remaining || w.balance || 0) || 0,
      })),
      ...sa.map(s => ({
        type: 'sale' as const,
        displayType: mainRecordKind('sale', s),
        id: s.id,
        customerId: (s as any).customerId as number | undefined,
        date: new Date(s.checkInAt || s.createdAt || 0),
        status: ((Number(s.totals?.total || s.total || 0) || 0) - (Number(s.amountPaid || 0) || 0) <= 0 ? 'closed' : 'open') as 'open'|'closed',
        desc: (Array.isArray(s.items) && s.items[0]?.description) || s.itemDescription || '',
        items: (() => {
          const list = Array.isArray(s.items) ? s.items : [];
          const titles = list.map((it: any) => (it.description || it.name || it.title || '').toString().trim()).filter(Boolean);
          return titles.join(', ');
        })(),
        problem: '',
        customer: (() => {
          const id = (s as any).customerId as number | undefined;
          const fromIndex = id ? customerIndex[id]?.name : '';
          if (fromIndex) return fromIndex;
          const inline = (s as any).customerName as string | undefined;
          if (inline && inline.trim()) return inline.trim();
          return id ? `Customer #${id}` : '';
        })(),
        phone: (s.customerId && customerIndex[s.customerId]?.phone) || s.customerPhone || '',
        tech: ((): string => {
          const at = (s.assignedTo || '').toString().trim();
          if (!at) return '';
          if (techIndex[at]) return techIndex[at];
          for (const [, label] of Object.entries(techIndex)) {
            if (!label) continue;
            if (label === at) return label;
            const first = label.split(' ')[0];
            if (first && first === at) return label;
          }
          return '';
        })(),
        total: Number(s.totals?.total || s.total || 0) || 0,
        remaining: (Number(s.totals?.total || s.total || 0) || 0) - (Number(s.amountPaid || 0) || 0),
      })),
    ];
  }, [wo, sa, customerIndex, techIndex]);

  const rows = React.useMemo(() => {
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo) : null;

    return mappedRows
      .filter(r => {
        if (statusFilter !== 'all') {
          const st = String((r as any).status || '').toLowerCase().trim();
          const isClosed = st === 'closed';
          if (statusFilter === 'closed' && !isClosed) return false;
          if (statusFilter === 'open' && isClosed) return false;
        }
        if (technicianFilter) {
          const at = (r.tech || '').toString();
          if (technicianFilter === '__unassigned') { if (at) return false; }
          else {
            // allow match by tech id or by mapped label
            const match = Object.keys(techIndex).some(id => id === technicianFilter && (at === id || at === techIndex[id]));
            if (!match) return false;
          }
        }
        if (from && r.date < from) return false;
        if (to && r.date > to) return false;
        if (deferredKeyword) {
          const kw = deferredKeyword.trim().toLowerCase();
          if (kw) {
            const haystack = [
              String(r.id),
              r.customer || '',
              r.phone || '',
              r.desc || '',
              r.items || '',
              r.problem || '',
            ].join(' ').toLowerCase();
            if (!haystack.includes(kw)) return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        const bd = b.date?.getTime?.() || 0;
        const ad = a.date?.getTime?.() || 0;
        return (bd - ad) || (b.id - a.id);
      });
  }, [mappedRows, statusFilter, technicianFilter, dateFrom, dateTo, techIndex, deferredKeyword]);

  React.useEffect(() => {
    // Cap pagination to MAX_PAGES (older records stay stored, but not always loaded here)
    setTotalItems(Math.min(rows.length, MAX_ITEMS));
    return () => {
      // Clear when switching away from this view
      setTotalItems(0);
    };
  }, [rows.length, setTotalItems, MAX_ITEMS]);

  const totalPages = Math.max(1, Math.ceil(Math.min(rows.length, MAX_ITEMS) / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const capped = rows.slice(0, MAX_ITEMS);
  const endIdx = Math.min(startIdx + pageSize, capped.length);
  const pagedRows = React.useMemo(() => capped.slice(startIdx, endIdx), [capped, startIdx, endIdx]);

  React.useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage, setPage]);

  const ctx = useContextMenu<(typeof rows)[number]>();
  const ctxRow = ctx.state.data;

  const computeWOTotals = React.useCallback((w: any) => {
    const labor = Number(w.laborCost || 0);
    const parts = Number(w.partCosts || 0);
    const discount = Number(w.discount || 0);
    const taxRate = Number(w.taxRate || 0);
    const subTotal = Math.max(0, labor + parts - discount);
    const tax = Math.round((subTotal * (taxRate / 100)) * 100) / 100;
    const total = Math.round((subTotal + tax) * 100) / 100;
    const amountPaid = Number(w.amountPaid || 0);
    const remaining = Math.max(0, Math.round((total - amountPaid) * 100) / 100);
    return { subTotal, tax, total, remaining };
  }, []);

  const ctxItems: ContextMenuItem[] = React.useMemo(() => {
    if (!ctxRow) return [];

    const inv = `GB${String(ctxRow.id).padStart(7, '0')}`;
    const hasCustomer = !!ctxRow.customerId;
    const phone = (formatPhone(String(ctxRow.phone || '')) || String(ctxRow.phone || '')).trim();

    const api = (window as any).api;

    if (ctxRow.type === 'workorder') {
      return [
        { type: 'header', label: `Work Order ${inv}` },
        { label: 'Edit / Open', onClick: async () => { await api?.openNewWorkOrder?.({ workOrderId: ctxRow.id }); } },
        { label: 'View Customer', disabled: !hasCustomer, onClick: async () => { await api?.openCustomerOverview?.(ctxRow.customerId); } },
        { type: 'separator' },
        { label: 'Copy Invoice #', onClick: async () => { try { await navigator.clipboard.writeText(inv); } catch {} } },
        { label: 'Copy Phone', disabled: !phone, hint: phone || undefined, onClick: async () => { if (!phone) return; try { await navigator.clipboard.writeText(phone); } catch {} } },
        { type: 'separator' },
        { label: 'Print Customer Receipt', onClick: async () => { await api?.openCustomerReceipt?.({ workOrderId: ctxRow.id }); } },
        { label: 'Print Release Form', onClick: async () => { await api?.openReleaseForm?.({ workOrderId: ctxRow.id }); } },
        { type: 'separator' },
        {
          label: 'Mark Paid in Full',
          disabled: !(ctxRow.remaining > 0),
          onClick: async () => {
            // Load, compute totals, and update to closed/paid
            const found = await api?.findWorkOrders?.({ id: ctxRow.id }).catch(() => []);
            const full = Array.isArray(found) ? found[0] : null;
            if (!full) return;
            const totals = computeWOTotals(full);
            const updated = { ...full, amountPaid: totals.total, totals: { ...totals, remaining: 0 }, status: 'closed' };
            await api?.dbUpdate?.('workOrders', ctxRow.id, updated);
          },
        },
        {
          label: 'Reopen',
          disabled: !(ctxRow.remaining <= 0),
          onClick: async () => {
            const found = await api?.findWorkOrders?.({ id: ctxRow.id }).catch(() => []);
            const full = Array.isArray(found) ? found[0] : null;
            if (!full) return;
            const totals = computeWOTotals(full);
            const updated = { ...full, status: 'open', totals };
            await api?.dbUpdate?.('workOrders', ctxRow.id, updated);
          },
        },
        { type: 'separator' },
        {
          label: 'Delete…',
          danger: true,
          onClick: async () => {
            const ok = window.confirm(`Delete work order ${inv}? This cannot be undone.`);
            if (!ok) return;
            await api?.dbDelete?.('workOrders', ctxRow.id);
          },
        },
      ];
    }

    const saleTypeLabel = mainRecordTypeLabel(ctxRow.displayType);
    return [
      { type: 'header', label: `${saleTypeLabel} ${inv}` },
      { label: 'Edit / Open', onClick: async () => { await api?.openNewSale?.({ id: ctxRow.id }); } },
      { label: 'View Customer', disabled: !hasCustomer, onClick: async () => { await api?.openCustomerOverview?.(ctxRow.customerId); } },
      { type: 'separator' },
      { label: 'Copy Invoice #', onClick: async () => { try { await navigator.clipboard.writeText(inv); } catch {} } },
      { label: 'Copy Phone', disabled: !phone, hint: phone || undefined, onClick: async () => { if (!phone) return; try { await navigator.clipboard.writeText(phone); } catch {} } },
      { type: 'separator' },
      {
        label: 'Delete…',
        danger: true,
        onClick: async () => {
          const ok = window.confirm(`Delete ${saleTypeLabel.toLowerCase()} ${inv}? This cannot be undone.`);
          if (!ok) return;
          await api?.dbDelete?.('sales', ctxRow.id);
        },
      },
    ];
  }, [ctxRow, computeWOTotals]);

  return (
    <div className="gb-responsive-record-list p-2 overflow-x-auto">
      <table className="w-full table-fixed text-[13px] leading-tight">
        <thead className="bg-zinc-800 text-zinc-300">
          <tr>
            <th className="px-2 py-1 text-left w-[110px]">Invoice #</th>
            <th className="px-2 py-1 text-left w-[105px]">Date</th>
            <th className="px-2 py-1 text-left w-[70px]">Status</th>
            <th className="px-2 py-1 text-left w-[64px] xl:w-[112px]">Type</th>
            <th className="px-2 py-1 text-left w-[110px]">Tech</th>
            <th className="px-2 py-1 text-left">Customer</th>
            <th className="px-2 py-1 text-left">Items</th>
            <th className="px-2 py-1 text-left">Description</th>
            <th className="px-2 py-1 text-right w-[100px]">Total</th>
            <th className="px-2 py-1 text-right w-[110px]">Remaining</th>
          </tr>
        </thead>
        <tbody>
          {loading && (<tr><td colSpan={10} className="p-6 text-center text-zinc-500">Loading...</td></tr>)}
          {!loading && rows.length === 0 && (<tr><td colSpan={10} className="p-6 text-center text-zinc-500">No entries yet</td></tr>)}
          {!loading && pagedRows.map(r => {
            const customer = r.customerId ? ({ id: r.customerId, ...(customerIndex[r.customerId] || {}) } as any) : null;
            return (
              <tr
                key={`${r.type}-${r.id}`}
                className="odd:bg-zinc-900 even:bg-zinc-800/40 cursor-pointer"
                onContextMenu={(e) => ctx.openFromEvent(e, r)}
                onDoubleClick={async () => {
                  try {
                    const api = (window as any).api;
                    if (r.type === 'workorder') {
                      await api.openNewWorkOrder?.({ workOrderId: r.id });
                    } else {
                      const payload = { id: r.id };
                      await api.openNewSale?.(payload);
                    }
                  } catch (e) { console.error('Open editor failed', e); }
                }}
              >
                <td data-label="Invoice" className="px-2 py-1 font-mono">GB{String(r.id).padStart(7,'0')}</td>
                <td data-label="Date" className="px-2 py-1" title={r.type === 'workorder' && (r as any).originalDate && !isNaN((r as any).originalDate.getTime()) ? `Checked in: ${(r as any).originalDate.toISOString().slice(0,10)}` : undefined}>{isNaN(r.date.getTime()) ? '' : r.date.toISOString().slice(0,10)}</td>
                <td data-label="Status" className="px-2 py-1 capitalize">{r.status}</td>
                <td data-label="Type" className="px-2 py-1 font-semibold truncate" title={mainRecordTypeLabel(r.displayType)}>
                  <span className="xl:hidden">{mainRecordTypeLabel(r.displayType, true)}</span>
                  <span className="hidden xl:inline">{mainRecordTypeLabel(r.displayType)}</span>
                </td>
                <td data-label="Technician" className="px-2 py-1">{r.tech}</td>
                <td data-label="Client" className="px-2 py-1" title={r.customer}>
                  <CustomerHoverCard customerId={r.customerId} customer={customer} className="min-w-0">
                    <div className="truncate">{r.customer || (r.type === 'sale' ? ('Customer #' + r.id) : '')}</div>
                  </CustomerHoverCard>
                </td>
                <td data-label="Items" className="px-2 py-1" title={r.items || ''}>
                  <ItemsDescriptionHoverCard items={String(r.items || '')} description={String(r.desc || '')} problem={String((r as any).problem || '')} className="min-w-0">
                    <div className="truncate">{r.items || ''}</div>
                  </ItemsDescriptionHoverCard>
                </td>
                <td data-label="Description" className="px-2 py-1" title={r.desc}>
                  <ItemsDescriptionHoverCard items={String(r.items || '')} description={String(r.desc || '')} problem={String((r as any).problem || '')} className="min-w-0">
                    <div className="truncate">{r.desc}</div>
                  </ItemsDescriptionHoverCard>
                </td>
                <td data-label="Total" className="px-2 py-1 text-right">${r.total.toFixed(2)}</td>
                <td data-label="Remaining" className="px-2 py-1 text-right">${r.remaining.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ContextMenu
        id="home-ctx-menu"
        open={ctx.state.open}
        x={ctx.state.x}
        y={ctx.state.y}
        items={ctxItems}
        onClose={ctx.close}
      />
    </div>
  );
};
