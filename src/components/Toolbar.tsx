import React, { useEffect, useRef, useState } from 'react';
import { getUnreadCount, syncNotificationsFromCalendar, syncNotificationsFromRecords } from '@/lib/notifications';
import { dispatchOpenModal } from '@/lib/modalBus';
import { openAdminTool, type AdminToolKey } from '@/lib/adminWindowNavigation';

const Toolbar: React.FC<{
  mode: 'workorders' | 'sales' | 'all';
  onModeChange: (m: 'workorders' | 'sales' | 'all') => void;
  keyword?: string;
  onKeywordChange?: (v: string) => void;
  drawerMode?: boolean;
  onOpenMenu?: () => void;
  onOpenNotifications?: () => void;
  onSearchClient?: () => void;
  onAddClient?: () => void;
}> = ({ mode, onModeChange, keyword = '', onKeywordChange, drawerMode = false, onOpenMenu, onOpenNotifications, onSearchClient, onAddClient }) => {

  const [isFull, setIsFull] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    (async () => {
      try { const v = await (window as any).api.getFullScreen?.(); setIsFull(!!v); } catch {}
    })();
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = await (window as any).api?.getAppInfo?.();
        const v = String(info?.version || '').trim();
        if (alive) setAppVersion(v);
      } catch {
        // ignore
      }
    })();
    return () => { alive = false; };
  }, [])
  const [unread, setUnread] = useState<number>(0);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        await syncNotificationsFromCalendar();
        await syncNotificationsFromRecords();
      } catch {
        // ignore
      }
      try {
        const c = await getUnreadCount();
        if (alive) setUnread(c);
      } catch {
        // ignore
      }
    };
    refresh();
    const api: any = (window as any).api;
    // Calendar / tech changes need a full sync; notification writes just refresh the badge count.
    const refreshCountOnly = async () => {
      try {
        const c = await getUnreadCount();
        if (alive) setUnread(c);
      } catch {
        // ignore
      }
    };
    const offCal = api?.onCalendarEventsChanged?.(() => refresh());
    const offWO = api?.onWorkOrdersChanged?.(() => refresh());
    const offSales = api?.onSalesChanged?.(() => refresh());
    const offNot = api?.onNotificationsChanged?.(() => refreshCountOnly());
    const offTech = api?.onTechniciansChanged?.(() => refresh());
    const timer = window.setInterval(() => refresh(), 60_000);
    return () => {
      alive = false;
      try { offCal && offCal(); } catch {}
      try { offWO && offWO(); } catch {}
      try { offSales && offSales(); } catch {}
      try { offNot && offNot(); } catch {}
      try { offTech && offTech(); } catch {}
      try { window.clearInterval(timer); } catch {}
    };
  }, []);

  const openAdmin = (tool: AdminToolKey) => {
    void openAdminTool(tool, (window as any).api, key => dispatchOpenModal(key));
  };

  const [showAdmin, setShowAdmin] = useState(false);
  const adminRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (adminRef.current && !adminRef.current.contains(e.target as Node)) {
        setShowAdmin(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <>
    <div className={`relative flex flex-wrap items-center justify-between gap-2 border-b border-zinc-700 bg-zinc-900 px-4 py-2${drawerMode ? ' desktop-preview-toolbar' : ''}`}>
      {drawerMode ? (
        <div className="desktop-preview-brand">
          <button type="button" className="desktop-preview-menu-button" onClick={onOpenMenu} aria-label="Open navigation menu" title="Menu">
            <span /><span /><span />
          </button>
          <div>
            <strong>GADGETBOY POS</strong>
            {appVersion ? <span>v{appVersion}</span> : null}
          </div>
        </div>
      ) : null}
      {/* Left side: Admin dropdown + action buttons */}
      <div className={drawerMode ? 'hidden' : 'flex min-w-0 flex-1 flex-wrap items-center gap-2'}>
        {/* Admin dropdown */}
        <div ref={adminRef} className="relative">
          <button
            className="px-5 py-2 bg-zinc-800 text-zinc-100 font-semibold rounded shadow-sm border border-zinc-700 hover:border-[#BC13FE] hover:text-[#BC13FE] text-sm min-w-[110px]"
            onClick={() => setShowAdmin(v => !v)}
          >Admin ▾</button>
          {showAdmin && (
            <div className="absolute left-0 top-full mt-1 w-52 bg-zinc-900 border border-zinc-700 rounded shadow-xl z-50">
              {[
                { label: 'Repairs', action: () => openAdmin('repairCategories') },
                { label: 'Inventory',       action: () => openAdmin('inventory') },
                { label: 'Reporting',       action: () => openAdmin('reporting') },
                { label: 'Technicians',     action: () => openAdmin('technicians') },
                { label: 'Opening / Closing Checklist', action: () => dispatchOpenModal('dailyOperationsSettings') },
                { label: 'Data Tools',      action: () => openAdmin('dataTools') },
                { label: 'Dev Menu',        action: () => openAdmin('devMenu') },
              ].map(item => (
                <button key={item.label} type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-zinc-800" onClick={() => { setShowAdmin(false); item.action(); }}>{item.label}</button>
              ))}
            </div>
          )}
        </div>
        <button
          className="px-4 py-2 bg-[#39FF14] text-black font-semibold rounded shadow-sm border border-[#39FF14] hover:brightness-110 text-sm"
          onClick={() => dispatchOpenModal('quoteGenerator')}
        >
          Generate Quote
        </button>

        <button
          className="px-4 py-2 bg-zinc-800 text-zinc-100 font-semibold rounded shadow-sm border border-zinc-700 hover:border-[#39FF14] hover:text-white text-sm"
          onClick={() => dispatchOpenModal('quickSale')}
        >
          Quick Checkout
        </button>

        <button
          className="px-4 py-2 bg-blue-600 text-white font-semibold rounded shadow-sm border border-blue-500 hover:bg-blue-500 text-sm"
          onClick={() => {
            const api: any = (window as any).api;
            if (typeof api?.openConsultation === 'function') void api.openConsultation();
            else dispatchOpenModal('consultation');
          }}
        >
          Consultation
        </button>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {drawerMode ? <button
          className="desktop-command-eod"
          onClick={() => dispatchOpenModal('eod')}
        >EOD</button> : null}
        {!drawerMode ? <button
          className="px-3 py-2 bg-amber-500 text-black font-semibold rounded shadow-sm border border-amber-400 hover:brightness-110 text-sm"
          onClick={() => dispatchOpenModal('eod')}
        >
          End of Day Report
        </button> : null}
        {!drawerMode ? <button
          className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm"
          onClick={() => dispatchOpenModal('dailyLook')}
        >
          Daily Look
        </button> : null}
        {!drawerMode ? <button
          className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm"
          onClick={() => dispatchOpenModal('calendar')}
        >
          Calendar
        </button> : null}
        <button
          type="button"
          className="desktop-command-icon relative flex h-9 w-9 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-lg font-bold text-zinc-100 hover:border-[#39FF14] hover:text-[#39FF14]"
          onClick={() => onOpenNotifications ? onOpenNotifications() : dispatchOpenModal('notifications')}
          aria-label="Open notifications"
          title="Notifications"
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[11px] leading-[18px] text-center border border-zinc-900">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
        {drawerMode ? <button type="button" className="desktop-command-icon" onClick={() => dispatchOpenModal('calendar')} title="Calendar" aria-label="Open calendar">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>
        </button> : null}
        <button
          className="desktop-command-icon px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm flex items-center justify-center"
          title={isFull ? 'Exit full screen' : 'Enter full screen'}
          onClick={async () => {
            try { await (window as any).api.toggleFullScreen?.(); const v = await (window as any).api.getFullScreen?.(); setIsFull(!!v); } catch (e) { console.error('toggleFullScreen failed', e); }
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      {/* Reset DB button removed per request */}
     </div>
   </div>
   {/* Keyword search — full-width row below toolbar buttons */}
   {drawerMode ? (
     <div className="desktop-preview-client-row">
       <div className="desktop-preview-client-actions">
         <button type="button" className="search" onClick={onSearchClient}>Search Client</button>
         <button type="button" className="add" onClick={onAddClient}>Add Client</button>
         <button type="button" className="checkout" onClick={() => dispatchOpenModal('quickSale')}>Quick Checkout</button>
         <button type="button" className="dropoff" onClick={() => {
           const api: any = (window as any).api;
           if (typeof api?.openNewWorkOrder === 'function') void api.openNewWorkOrder({ clientDropoff: true });
           else dispatchOpenModal('newWorkOrder');
         }}>Client Dropoff</button>
       </div>
     </div>
   ) : null}
   <div className="px-4 py-1.5 border-b border-zinc-700 bg-zinc-900 flex items-center gap-2">
     <input
       type="text"
       className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-[#39FF14]"
       placeholder="Search by name, device, phone, WO#…"
       value={keyword}
       onChange={e => onKeywordChange && onKeywordChange(e.target.value)}
     />
     {keyword && (
       <button
         type="button"
         className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100 bg-zinc-800 border border-zinc-700 rounded"
         onClick={() => onKeywordChange && onKeywordChange('')}
       >✕ Clear</button>
     )}
   </div>
    </>
  );
};

export default Toolbar;
