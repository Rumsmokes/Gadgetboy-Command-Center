import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCommandCenterModel, liveCommandCenterPanelRecords, removeCommandCenterRecord, searchCommandCenterRecords, upsertCommandCenterWorkOrder, type CommandCenterRecord } from '@/lib/commandCenter';
import { reconcileLegacyWorkOrders } from '@/lib/workOrderCleanup';
import { shouldOpenAttentionPanel } from '@/lib/commandCenterPresentation';
import { buildDiagnosticCheckInReopenPatch, diagnosticCheckInClosureNeedsReview, pickupLifecycleFor } from '@/lib/workOrderLifecycle';
import { supabase } from '@/lib/supabase';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import CommandCenterRecordHoverCard from './CommandCenterRecordHoverCard';
import { useContextMenu } from '@/lib/useContextMenu';
import { publishWorkOrderUpdate, subscribeWorkOrderUpdates } from '@/lib/workflowLiveRefresh';
import { shouldReconcile } from '@/lib/incrementalSync';
import { buildCommandCenterMoveRequest, commandCenterMoveFields, commandCenterMoveOptions, type CommandCenterMoveKey, type CommandCenterMoveValue } from '@/lib/commandCenterMove';
import { mapCloudRow } from '@/workorders/ClientUpdatePanel';
import '@/styles/command-center.css';

type Props = {
  keyword: string;
  onOpenInvoices: (mode?: 'all' | 'workorders' | 'sales') => void;
  onOpenModal: (type: string, payload?: any) => void;
  attentionRequest?: number;
};

const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
const relativeAge = (value: string) => {
  const then = new Date(value || 0).getTime();
  if (!Number.isFinite(then) || !then) return 'No activity time';
  const hours = Math.max(0, Math.floor((Date.now() - then) / 3_600_000));
  return hours < 1 ? 'Updated recently' : hours < 24 ? `${hours}h since activity` : `${Math.floor(hours / 24)}d since activity`;
};
const RESOLVED_RESPONSE_GUARD_KEY = 'gbpos.commandCenter.resolvedResponses';
const readResolvedResponseIds = () => {
  try { return new Set<string>(JSON.parse(localStorage.getItem(RESOLVED_RESPONSE_GUARD_KEY) || '[]').map(String)); }
  catch { return new Set<string>(); }
};
const persistResolvedResponseIds = (ids: Set<string>) => {
  try { localStorage.setItem(RESOLVED_RESPONSE_GUARD_KEY, JSON.stringify(Array.from(ids))); } catch {}
};

export default function CommandCenter(props: Props) {
  const [data, setData] = useState({ customers: [] as any[], technicians: [] as any[], workOrders: [] as any[], sales: [] as any[], calendarEvents: [] as any[], calendarNotes: [] as any[], purchaseOrders: [] as any[], attentionSettings: undefined as any });
  const [loading, setLoading] = useState(true);
  const [clientResponses,setClientResponses]=useState<any[]>([]);
  const [selectedResponse,setSelectedResponse]=useState<any|null>(null);
  const [staffReply,setStaffReply]=useState('');
  const [replyBusy,setReplyBusy]=useState(false);
  const [deliveryBusy,setDeliveryBusy]=useState('');
  const [moveDialog,setMoveDialog]=useState<{record:CommandCenterRecord;key:CommandCenterMoveKey;label:string}|null>(null);
  const [moveValue,setMoveValue]=useState<CommandCenterMoveValue>({});
  const [moveBusy,setMoveBusy]=useState(false);
  const [moveError,setMoveError]=useState('');
  const [syncStatus,setSyncStatus]=useState<{state:'idle'|'syncing'|'error';lastSuccessAt:string;pending:number;error:string}>({state:'idle',lastSuccessAt:'',pending:0,error:''});
  const [panel, setPanel] = useState<{ title: string; records?: CommandCenterRecord[]; kind?: 'today' | 'statistics' | 'product-delivery' } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ today: false });
  const recordMenu = useContextMenu<CommandCenterRecord>();
  const deliveryMenu = useContextMenu<{record:CommandCenterRecord;item:{index:number;name:string;eta:string;orderDate:string;orderUrl:string}}>();
  const responseMenu = useContextMenu<any>();
  const longPressTimer = useRef<number | null>(null);
  const longPressConsumed = useRef(false);
  const lastAttentionRequest = useRef(0);
  const loadGenerationRef = useRef(0);
  const closedWorkOrderIdsRef = useRef(new Set<string>());
  const resolvedResponseIdsRef = useRef(readResolvedResponseIds());
  const lastReconcileRef = useRef(0);

  const loadClientResponses = useCallback(async () => {
    const responseResult = await supabase.from('client_responses')
      .select('id,shop_id,work_order_id,legacy_record_id,customer_id,response_type,message,unread,resolved_at,created_at,delivery_status')
      .is('resolved_at', null)
      .order('created_at', { ascending: false })
      .limit(100);
    if (responseResult.error) return;
    const unresolvedRows = responseResult.data || [];
    const unresolvedIds = new Set(unresolvedRows.map((row:any)=>String(row.id)));
    for (const id of Array.from(resolvedResponseIdsRef.current)) if (!unresolvedIds.has(id)) resolvedResponseIdsRef.current.delete(id);
    persistResolvedResponseIds(resolvedResponseIdsRef.current);
    setClientResponses(unresolvedRows.filter((row:any)=>!resolvedResponseIdsRef.current.has(String(row.id))));
  }, []);

  const load = useCallback(async () => {
    const loadGeneration = loadGenerationRef.current += 1;
    const api: any = (window as any).api;
    if (!api) return setLoading(false);
    try {
      const [customers, technicians, workOrders, sales, calendarEvents, calendarNotes, purchaseOrders, settingsRows] = await Promise.all([
        (api.getCustomers?.() ?? api.dbGet('customers')).catch(() => []),
        api.dbGet('technicians').catch(() => []),
        (api.getWorkOrders?.({ limit: 2000, sortBy: 'activityAt', sortDir: 'desc' }) ?? api.dbGet('workOrders')).catch(() => []),
        api.dbGet('sales').catch(() => []),
        api.dbGet('calendarEvents').catch(() => []),
        api.dbGet('calendarNotes').catch(() => []),
        api.dbGet('purchaseOrders').catch(() => []),
        api.dbGet('settings').catch(() => []),
      ]);
      const cleanup = await reconcileLegacyWorkOrders(api, { workOrders: workOrders || [], settings: settingsRows?.[0]?.ticketCleanupSettings });
      const updatedById = new Map(cleanup.updatedRecords.map(record => [String(record.id), record]));
      const reconciledWorkOrders = (workOrders || [])
        .map((record: any) => updatedById.get(String(record.id)) || record)
        .filter((record: any) => !closedWorkOrderIdsRef.current.has(String(record.id)));
      const attentionSettings = settingsRows?.[0]?.ticketCleanupSettings;
      if (loadGeneration !== loadGenerationRef.current) return;
      setData({ customers: customers || [], technicians: technicians || [], workOrders: reconciledWorkOrders, sales: sales || [], calendarEvents: calendarEvents || [], calendarNotes: calendarNotes || [], purchaseOrders: purchaseOrders || [], attentionSettings });
      await loadClientResponses();
      for(const workOrder of reconciledWorkOrders){
        if(!pickupLifecycleFor(workOrder,new Date(),attentionSettings).reminderDue) continue;
        try{
          const {data:reminder}=await supabase.functions.invoke('client-updates',{body:{recordType:'repair',recordId:Number(workOrder.id),statusKey:'pickup_reminder',deliveryMode:'email'}});
          if(reminder?.ok) await api.dbUpdate('workOrders',workOrder.id,{...workOrder,pickupReminderSentAt:new Date().toISOString()});
        }catch(error){console.warn('Automatic pickup reminder is still pending',error)}
      }
    } finally { setLoading(false); }
  }, [loadClientResponses]);

  const refreshCollection = useCallback(async (key: string) => {
    const api: any = (window as any).api;
    if (!api?.dbGet) return;
    const rows = await api.dbGet(key).catch(() => []);
    if (key === 'settings') return setData(current => ({ ...current, attentionSettings: rows?.[0]?.ticketCleanupSettings }));
    const fieldByKey: Record<string, keyof typeof data> = {
      customers: 'customers', technicians: 'technicians', workOrders: 'workOrders', sales: 'sales',
      calendarEvents: 'calendarEvents', calendarNotes: 'calendarNotes', purchaseOrders: 'purchaseOrders',
    };
    const field = fieldByKey[key];
    if (field) setData(current => ({ ...current, [field]: Array.isArray(rows) ? rows : [] }));
  }, []);

  const reconcileCloud = useCallback(async (force = false) => {
    const api: any = (window as any).api;
    if (!api?.cloudSyncCollection) return;
    if (!force) {
      const status = await api.cloudGetSyncStatus?.().catch(() => null);
      const lastSuccessAt = Date.parse(status?.lastSuccessAt || '') || lastReconcileRef.current;
      if (!shouldReconcile(Date.now(), { lastSuccessAt, staleAfterMs: 15 * 60_000 }, document.visibilityState)) return;
    }
    setSyncStatus(current => ({ ...current, state: 'syncing', error: '' }));
    try {
      const limits: Record<string, number> = { customers: 2500, technicians: 250, workOrders: 2500, sales: 2500, calendarEvents: 2500, calendarNotes: 1000, purchaseOrders: 1000, settings: 25 };
      const results = await Promise.all(Object.entries(limits).map(([key, bootstrapLimit]) => api.cloudSyncCollection(key, { bootstrapLimit })));
      const failure = results.find((result:any) => result?.ok === false);
      const status = await api.cloudGetSyncStatus?.().catch(() => null);
      if (failure) setSyncStatus({state:'error',lastSuccessAt:String(status?.lastSuccessAt||''),pending:Number(status?.pendingSync||0),error:String(failure.error||'Cloud synchronization failed')});
      else setSyncStatus({state:'idle',lastSuccessAt:String(status?.lastSuccessAt||new Date().toISOString()),pending:Number(status?.pendingSync||0),error:''});
      lastReconcileRef.current = Date.now();
      await loadClientResponses();
    } catch (error:any) {
      setSyncStatus(current => ({ ...current, state: 'error', error: error?.message || 'Cloud synchronization failed' }));
    }
  }, [loadClientResponses]);

  useEffect(() => {
    void load();
    void reconcileCloud(false);
    const api: any = (window as any).api;
    const onWorkOrderChanged = (record?: any) => {
      loadGenerationRef.current += 1;
      const changedRows = Array.isArray(record) ? record : Array.isArray(record?.changedRows) ? record.changedRows : record?.id != null ? [record] : [];
      if (changedRows.length) {
        for (const changed of changedRows) {
          const key = String(changed.id);
          const terminal = (String(changed.status || '').toLowerCase() === 'closed' || !!changed.pickedUpAt || !!changed.clientPickupDate) && !diagnosticCheckInClosureNeedsReview(changed);
          if (terminal) closedWorkOrderIdsRef.current.add(key);
          else closedWorkOrderIdsRef.current.delete(key);
        }
        setData(current => ({ ...current, workOrders: changedRows.reduce((rows:any[], changed:any) => {
          const key = String(changed.id);
          return closedWorkOrderIdsRef.current.has(key) ? rows.filter(row => String(row.id) !== key) : upsertCommandCenterWorkOrder(rows, changed);
        }, current.workOrders) }));
      } else {
        void refreshCollection('workOrders');
      }
    };
    const offs = [
      api?.onWorkOrdersChanged?.(onWorkOrderChanged),
      api?.onSalesChanged?.(() => void refreshCollection('sales')),
      api?.onCustomersChanged?.(() => void refreshCollection('customers')),
      api?.onTechniciansChanged?.(() => void refreshCollection('technicians')),
      api?.onCalendarEventsChanged?.(() => void refreshCollection('calendarEvents')),
      api?.onCalendarNotesChanged?.(() => void refreshCollection('calendarNotes')),
      api?.onPurchaseOrdersChanged?.(() => void refreshCollection('purchaseOrders')),
    ];
    return () => offs.forEach(off => { try { off?.(); } catch {} });
  }, [load, reconcileCloud, refreshCollection]);
  useEffect(() => {
    const channel = supabase.channel('command-center-live-client-responses')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'client_responses' }, () => void loadClientResponses())
      .subscribe();
    const refreshVisible = () => { void reconcileCloud(false); };
    const timer = window.setInterval(refreshVisible, 15 * 60_000);
    window.addEventListener('focus', refreshVisible);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshVisible); void supabase.removeChannel(channel); };
  }, [loadClientResponses, reconcileCloud]);
  useEffect(()=>subscribeWorkOrderUpdates(record=>{loadGenerationRef.current += 1;const key=String(record?.id);const terminal=(String(record?.status||'').toLowerCase()==='closed'||!!record?.pickedUpAt||!!record?.clientPickupDate)&&!diagnosticCheckInClosureNeedsReview(record);if(terminal)closedWorkOrderIdsRef.current.add(key);else closedWorkOrderIdsRef.current.delete(key);setData(current=>({...current,workOrders:terminal?current.workOrders.filter(row=>String(row.id)!==key):upsertCommandCenterWorkOrder(current.workOrders,record)}));}),[]);

  const model = useMemo(() => buildCommandCenterModel(data), [data]);
  const panelRecords = useMemo(() => panel ? liveCommandCenterPanelRecords(panel.title, model, panel.records || []) : [], [panel, model]);
  const responseRecord=(reply:any)=>model.workOrders.find(row=>String(row.id)===String(reply.legacy_record_id));
  const resolveResponse=async(reply:any)=>{const key=String(reply.id);resolvedResponseIdsRef.current.add(key);persistResolvedResponseIds(resolvedResponseIdsRef.current);setClientResponses(rows=>rows.filter(row=>String(row.id)!==key));setSelectedResponse(null);const {data:updated,error}=await supabase.from('client_responses').update({resolved_at:new Date().toISOString(),unread:false}).eq('id',reply.id).select('id').maybeSingle();if(error||!updated){resolvedResponseIdsRef.current.delete(key);persistResolvedResponseIds(resolvedResponseIdsRef.current);window.alert(error?.message||'The reply could not be marked resolved.');await loadClientResponses();}};
  const unresolveResponse=async(reply:any)=>{resolvedResponseIdsRef.current.delete(String(reply.id));persistResolvedResponseIds(resolvedResponseIdsRef.current);const {error}=await supabase.from('client_responses').update({resolved_at:null,unread:true}).eq('id',reply.id);if(error)window.alert(error.message);await loadClientResponses();};
  const acknowledgeResponse=async(reply:any)=>{const action=reply.response_type==='approved'?'approval_received':reply.response_type==='declined'?'repair_declined':'';if(action){const {error}=await supabase.functions.invoke('client-updates',{body:{recordType:'repair',recordId:Number(reply.legacy_record_id),statusKey:action,notes:`Client response acknowledged: ${reply.message||reply.response_type}`,deliveryMode:'email',idempotencyKey:`client-response:${reply.id}:acknowledge`}});if(error)throw error;}await supabase.from('client_responses').update({acknowledged_at:new Date().toISOString(),unread:false}).eq('id',reply.id);await loadClientResponses();};
  const sendReply=async()=>{if(!selectedResponse||!staffReply.trim())return;setReplyBusy(true);try{const {data:sent,error}=await supabase.functions.invoke('client-updates',{body:{recordType:'repair',recordId:Number(selectedResponse.legacy_record_id),statusKey:'manual_update',notes:staffReply.trim(),deliveryMode:'email'}});if(error||!sent?.ok)throw error||new Error(sent?.error||'Reply failed');await supabase.from('client_responses').insert({shop_id:selectedResponse.shop_id,work_order_id:selectedResponse.work_order_id,legacy_record_id:selectedResponse.legacy_record_id,customer_id:selectedResponse.customer_id,response_type:'staff_reply',message:staffReply.trim(),unread:false,resolved_at:new Date().toISOString(),delivery_status:sent.deliveryStatus||'sent'});setStaffReply('');await resolveResponse(selectedResponse);}catch(error:any){window.alert(error?.message||'Reply could not be sent.');}finally{setReplyBusy(false)}};
  const searchResults = useMemo(() => searchCommandCenterRecords(model, props.keyword), [model, props.keyword]);
  const openRecord = async (record: CommandCenterRecord) => {
    const api: any = (window as any).api;
    if (record.kind === 'workorder') await api?.openNewWorkOrder?.({ workOrderId: record.id });
    else await api?.openNewSale?.({ id: record.id, customerId: record.customerId, customerName: record.customerName });
  };
  const showRecords = (title: string, records: CommandCenterRecord[]) => setPanel({ title, records });
  const showToday = (title: string, records: any[]) => setPanel({ title: `Today · ${title}`, records, kind: 'today' } as any);
  const refreshCommandCenter = async () => { setLoading(true); try { await reconcileCloud(true); } finally { setLoading(false); } };
  const markProductsDelivered = async (record: CommandCenterRecord, selectedIndexes?: number[], notifyClient = false) => {
    const indexes = selectedIndexes || record.productDelivery?.itemIndexes || [];
    if (!indexes.length || deliveryBusy) return;
    const busyKey = `${record.id}:${indexes.join(',')}`;
    setDeliveryBusy(busyKey);
    try {
      if (notifyClient) {
        const { data: delivery, error } = await supabase.functions.invoke('client-updates', { body: { recordType: 'sale', recordId: Number(record.id), statusKey: 'items_delivered', itemIndexes: indexes, deliveryMode: 'email' } });
        if (error || !delivery?.ok) throw error || new Error(delivery?.error || 'The products were marked delivered, but the client update could not be sent.');
      }
      const deliveredAt = new Date().toISOString();
      const selected = new Set(indexes);
      const items = (Array.isArray(record.source?.items) ? record.source.items : []).map((item:any,index:number)=>selected.has(index)?{...item,orderStatus:'received',partStatus:'delivered',receivedAt:deliveredAt,partDeliveredAt:deliveredAt}:item);
      const remainingIndexes = (record.productDelivery?.itemIndexes || []).filter(index=>!selected.has(index));
      const updated = {...record.source,items,status:remainingIndexes.length?'Partially Delivered':'Product Arrived',statusUpdate:remainingIndexes.length?'Some Products Delivered':'All Products Delivered',statusUpdatedAt:deliveredAt,updatedAt:deliveredAt};
      setData(current=>({...current,sales:current.sales.map((sale:any)=>String(sale.id)===String(record.id)?updated:sale)}));
      await (window as any).api?.dbUpdate?.('sales',record.id,updated);
    } catch(error:any) {
      window.alert(error?.message||'The delivered products could not be saved.');
    } finally { setDeliveryBusy(''); }
  };
  const todayRows: Record<string, any[]> = { Tasks: model.today.tasks, Events: model.today.events, Notes: model.today.notes, Consultations: model.today.consultations };
  const todayLabel = (row: any) => row?.subject || row?.title || row?.name || row?.partName || row?.deviceLabel || row?.source?.title || row?.source?.productDescription || 'Scheduled item';
  const todayDetail = (row: any) => row?.body || row?.description || row?.notes || row?.customerName || row?.source?.customerName || row?.distributor || row?.category || row?.type || 'No additional details';
  const todayTime = (row: any) => row?.time || row?.eventTime || row?.appointmentTime || row?.source?.appointmentTime || row?.expectedDeliveryDate || row?.eta || 'Today';
  const openTodayItem = (row: any) => {
    if (row?.source && (row?.kind === 'workorder' || row?.kind === 'sale' || row?.kind === 'consultation')) return void openRecord(row);
    const isNote = panel?.title === 'Today · Notes';
    props.onOpenModal('calendar', isNote ? { calendarNoteId: row.id } : { calendarEventId: row.id });
  };
  const recordLabel = (record: CommandCenterRecord) => record.kind === 'workorder' ? record.deviceLabel : record.title;
  const openRecordMenu = (event: React.MouseEvent, record: CommandCenterRecord) => recordMenu.openFromEvent(event, record);
  const openDeliveryMenu = (event: React.MouseEvent, record: CommandCenterRecord, item: {index:number;name:string;eta:string;orderDate:string;orderUrl:string}) => deliveryMenu.openFromEvent(event, {record,item});
  const cancelLongPress = () => {
    if (longPressTimer.current != null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  const longPressHandlers = (record: CommandCenterRecord) => ({
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      cancelLongPress();
      const { clientX, clientY } = event;
      longPressTimer.current = window.setTimeout(() => {
        longPressConsumed.current = true;
        recordMenu.openAt(clientX, clientY, record);
        try { navigator.vibrate?.(18); } catch {}
      }, 520);
    },
    onPointerMove: cancelLongPress,
    onPointerUp: cancelLongPress,
    onPointerCancel: cancelLongPress,
    onPointerLeave: cancelLongPress,
  });
  const responseLongPressHandlers = (reply: any) => ({
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      cancelLongPress();
      const { clientX, clientY } = event;
      longPressTimer.current = window.setTimeout(() => {
        longPressConsumed.current = true;
        responseMenu.openAt(clientX, clientY, reply);
        try { navigator.vibrate?.(18); } catch {}
      }, 520);
    },
    onPointerMove: cancelLongPress, onPointerUp: cancelLongPress, onPointerCancel: cancelLongPress, onPointerLeave: cancelLongPress,
  });
  const activateRecord = (record: CommandCenterRecord) => {
    if (longPressConsumed.current) { longPressConsumed.current = false; return; }
    void openRecord(record);
  };
  const beginMove = (record: CommandCenterRecord, key: CommandCenterMoveKey, label: string) => {
    const fields = commandCenterMoveFields(key);
    const today = new Date().toISOString().slice(0, 10);
    const defaults: CommandCenterMoveValue = key === 'part_delivered'
      ? { deliveredDate: today, itemIndexes: [] }
      : key === 'waiting_part' ? { orderDate: today } : {};
    if (!fields.length) { void submitMove(record, key, defaults); return; }
    setMoveValue(defaults); setMoveError(''); setMoveDialog({ record, key, label });
  };
  const submitMove = async (record: CommandCenterRecord, key: CommandCenterMoveKey, value: CommandCenterMoveValue) => {
    if (moveBusy) return;
    setMoveBusy(true); setMoveError('');
    try {
      const request = buildCommandCenterMoveRequest(record.source, key, value, `${record.id}:${key}:${crypto.randomUUID()}`);
      const { data: delivery, error } = await supabase.functions.invoke('client-updates', { body: request });
      if (error || !delivery?.ok || !delivery?.statusSaved || !delivery?.record) throw new Error(String((error as any)?.context?.body?.error || delivery?.error || error?.message || 'The workflow update could not be saved and sent.'));
      const mapped = mapCloudRow('repair', delivery.record);
      const merged = { ...record.source, ...mapped };
      setData(current => ({ ...current, workOrders: upsertCommandCenterWorkOrder(current.workOrders, merged) }));
      setPanel(current => current?.records ? { ...current, records: current.records.map(row => row.kind === 'workorder' && String(row.id) === String(record.id) ? { ...row, source: merged } : row) } : current);
      publishWorkOrderUpdate(merged);
      void (window as any).api?.dbUpdate?.('workOrders', record.id, merged);
      setMoveDialog(null); setMoveValue({});
    } catch (error: any) {
      const message = error?.message || 'The work order was not moved.';
      if (moveDialog) setMoveError(message); else window.alert(message);
    } finally { setMoveBusy(false); }
  };
  const menuRecord = recordMenu.state.data;
  const recordMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menuRecord) return [];
    const api: any = (window as any).api;
    const invoice = `GB${String(menuRecord.id).padStart(7, '0')}`;
    const isWorkOrder = menuRecord.kind === 'workorder';
    return [
      { type: 'header', label: `${isWorkOrder ? 'Work Order' : menuRecord.kind === 'consultation' ? 'Consultation' : 'Sale'} ${invoice}` },
      { label: 'Edit / Open', onClick: () => openRecord(menuRecord) },
      { label: 'View Customer', disabled: !menuRecord.customerId, onClick: async () => { await api?.openCustomerOverview?.(menuRecord.customerId); } },
      { type: 'separator' },
      { label: 'Copy Invoice #', onClick: async () => { try { await navigator.clipboard.writeText(invoice); } catch {} } },
      ...(isWorkOrder ? [
        { type: 'separator' } as ContextMenuItem,
        { label: 'Move To', children: commandCenterMoveOptions(menuRecord.source).map(option => ({ label: option.label, disabled: option.key === ({'Diagnosing':'diagnosis','Approval':'repair_approval','Parts':'waiting_part','Repair':'part_delivered','Testing':'testing_in_progress','Pickup':'repair_complete'} as Record<string,string>)[String(menuRecord.stage || '')], onClick: () => beginMove(menuRecord, option.key, option.label) })) } as ContextMenuItem,
        { type: 'separator' } as ContextMenuItem,
        ...(diagnosticCheckInClosureNeedsReview(menuRecord.source) ? [{ label: 'Restore Diagnostic Drop-Off to Active', onClick: async () => {
          if (!window.confirm(`Is the device for ${invoice} still in the shop? Restore it to Checked in without changing its payments?`)) return;
          const source = data.workOrders.find((record: any) => String(record.id) === String(menuRecord.id));
          if (!source) return;
          const restored = { ...source, ...buildDiagnosticCheckInReopenPatch(source) };
          const saved = await api?.dbUpdate?.('workOrders', source.id, restored);
          if (!saved) return window.alert('The ticket could not be restored. No payment has been changed.');
          closedWorkOrderIdsRef.current.delete(String(source.id));
          setData(current => ({ ...current, workOrders: upsertCommandCenterWorkOrder(current.workOrders, saved) }));
          await refreshCollection('workOrders');
        } } as ContextMenuItem] : []),
        { label: 'Close Work Order', onClick: async () => {
          const source = data.workOrders.find((record: any) => String(record.id) === String(menuRecord.id));
          if (!source || !window.confirm(`Close work order ${invoice}? No payment will be added.`)) return;
          const closed = { ...source, status: 'closed', workflowStage: 'Completed', updatedAt: new Date().toISOString() };
          const closedKey = String(menuRecord.id);
          closedWorkOrderIdsRef.current.add(closedKey);
          setData(current => ({ ...current, workOrders: current.workOrders.map((record:any) => String(record.id) === String(menuRecord.id) ? closed : record) }));
          setPanel(current => current?.records ? { ...current, records: removeCommandCenterRecord(current.records, menuRecord) } : current);
          const saved = await api?.dbUpdate?.('workOrders', menuRecord.id, closed);
          if (!saved) {
            closedWorkOrderIdsRef.current.delete(closedKey);
            window.alert('The work order could not be closed. It has been restored so it is not lost.');
          }
          await refreshCollection('workOrders');
        } } as ContextMenuItem,
        { label: 'Print Customer Receipt', onClick: async () => { await api?.openCustomerReceipt?.({ workOrderId: menuRecord.id }); } } as ContextMenuItem,
        { label: 'Print Release Form', onClick: async () => { await api?.openReleaseForm?.({ workOrderId: menuRecord.id }); } } as ContextMenuItem,
      ] : []),
      { type: 'separator' },
      { label: 'Delete…', danger: true, onClick: async () => { if (window.confirm(`Delete ${invoice}? This cannot be undone.`)) { await api?.dbDelete?.(isWorkOrder ? 'workOrders' : 'sales', menuRecord.id); setPanel(current => current?.records ? { ...current, records: removeCommandCenterRecord(current.records, menuRecord) } : current); await refreshCollection(isWorkOrder ? 'workOrders' : 'sales'); } } },
    ];
  }, [data.workOrders, menuRecord, refreshCollection]);
  const menuDelivery = deliveryMenu.state.data;
  const deliveryMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menuDelivery) return [];
    const { record, item } = menuDelivery;
    const api: any = (window as any).api;
    return [
      { type:'header', label:`${item.name} · Invoice #${record.id}` },
      { label:'Mark Delivered — Notify Client', onClick:()=>markProductsDelivered(record,[item.index],true) },
      { label:'Mark Delivered — Internal Only', onClick:()=>markProductsDelivered(record,[item.index],false) },
      { type:'separator' },
      { label:'Edit / Open Sale', onClick:()=>openRecord(record) },
      { label:'Open Order URL', disabled:!item.orderUrl, onClick:()=>api?.openUrl?.(item.orderUrl) },
    ];
  }, [menuDelivery, deliveryBusy]);
  const menuResponse=responseMenu.state.data;
  const responseMenuItems=useMemo<ContextMenuItem[]>(()=>{
    if(!menuResponse)return[];
    const record=responseRecord(menuResponse);
    const customer=data.customers.find((row:any)=>String(row.id)===String(record?.customerId));
    const phone=String(customer?.phone||record?.source?.customerPhone||'').trim();
    const contact=`${record?.customerName||`WO #${menuResponse.legacy_record_id}`}\n${phone}\n${customer?.email||record?.source?.customerEmail||''}`;
    return [
      {type:'header',label:`${record?.customerName||'Client'} · WO #${menuResponse.legacy_record_id}`},
      {label:'Open Work Order',onClick:()=>record&&openRecord(record)},
      {label:'Acknowledge & Advance',disabled:!!menuResponse.acknowledged_at,onClick:()=>acknowledgeResponse(menuResponse)},
      {label:'Respond by Email',onClick:()=>setSelectedResponse(menuResponse)},
      {label:'Call Client',disabled:!phone,onClick:()=>{window.location.href=`tel:${phone.replace(/[^\d+]/g,'')}`;}},
      {type:'separator'},
      menuResponse.resolved_at?{label:'Mark Unresolved',onClick:()=>unresolveResponse(menuResponse)}:{label:'Mark Resolved',onClick:()=>resolveResponse(menuResponse)},
      {label:'Reopen Conversation',onClick:async()=>{await unresolveResponse(menuResponse);setSelectedResponse(menuResponse);}},
      {label:'Copy Contact Information',onClick:async()=>{try{await navigator.clipboard.writeText(contact)}catch{}}},
    ];
  },[data.customers,menuResponse,model.workOrders]);
  const toggle = (key: string) => setCollapsed(current => ({ ...current, [key]: !current[key] }));
  useEffect(() => {
    const currentRequest = Number(props.attentionRequest || 0);
    const shouldOpen = shouldOpenAttentionPanel(lastAttentionRequest.current, currentRequest);
    lastAttentionRequest.current = currentRequest;
    if (shouldOpen) {
      const responseIds = new Set(clientResponses.filter(reply=>reply.unread||!reply.resolved_at).map(reply=>String(reply.legacy_record_id)));
      const records = model.records.filter(row => row.attentionReasons.length > 0 || (row.kind === 'workorder' && responseIds.has(String(row.id)))).map(row => responseIds.has(String(row.id)) && !row.attentionReasons.some(reason=>reason.code==='client-reply-unread') ? { ...row, attentionReasons: [...row.attentionReasons, { code:'client-reply-unread', label:'Unread client reply' }] } : row);
      setPanel({ title: 'Needs Attention', records });
    }
  }, [model, props.attentionRequest,clientResponses]);

  return <div className="command-center">
    <div className="command-center-heading">
      <div className="command-center-title"><h1>Command Center</h1><span>{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>
      <div className="command-center-agenda-strip" aria-label="Today's calendar overview">{(['Tasks','Events','Notes','Consultations'] as const).map(label=><button key={label} onClick={()=>showToday(label,todayRows[label])}><span>{label}</span><strong>{todayRows[label].length}</strong></button>)}</div>
      <div className="command-center-heading-actions"><span className={`command-center-sync ${syncStatus.state}`} title={syncStatus.error || `${syncStatus.pending} pending changes`}>{syncStatus.state==='syncing'?'Syncing…':syncStatus.state==='error'?'Sync issue':syncStatus.lastSuccessAt?`Synced ${new Date(syncStatus.lastSuccessAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`:'Cached data'}</span><button onClick={() => setPanel({title:'Repair Statistics',kind:'statistics'})}>Repair Statistics</button><button disabled={loading||syncStatus.state==='syncing'} onClick={() => void refreshCommandCenter()}>{loading||syncStatus.state==='syncing'?'Refreshing…':'Refresh'}</button></div>
    </div>
    {loading ? <div className="command-center-loading">Loading current shop activity…</div> : null}
    {props.keyword.trim() ? <div className="command-center-search-results"><header><strong>Search results</strong><span>{searchResults.length} matches · Command Center remains open</span></header>{searchResults.length ? searchResults.map(record => <button key={`${record.kind}-${record.id}`} onClick={() => activateRecord(record)} onContextMenu={event => openRecordMenu(event, record)} {...longPressHandlers(record)}><strong>{record.customerName}</strong><span>{recordLabel(record)}</span><em>{record.kind === 'workorder' ? `WO #${record.id}` : `Invoice #${record.id}`}</em></button>) : <p>No matching clients, work orders, sales, consultations, devices, or invoices.</p>}</div> : null}
    <div className="command-center-metrics">
      <button onClick={() => showRecords('Active Work Orders', model.activeWorkOrders)}><span>Active work orders</span><strong>{model.activeWorkOrders.length}</strong><small>{model.activeWorkOrders.filter(r => r.technician === 'Unassigned').length} unassigned</small></button>
      <button className="parts" onClick={() => showRecords('Awaiting Parts', model.awaitingParts)}><span>Awaiting parts</span><strong>{model.awaitingParts.length}</strong><small>{model.today.deliveries.length} arriving today</small></button>
      <button className="ready" onClick={() => showRecords('Ready for Pickup', model.readyForPickup)}><span>Ready for pickup</span><strong>{model.readyForPickup.length}</strong><small>{money(model.readyForPickup.reduce((sum, row) => sum + row.remaining, 0))} outstanding</small></button>
      <button onClick={() => showRecords('Collected Today', model.records.filter(row => new Date(row.activityAt).toDateString() === new Date().toDateString()))}><span>Collected today</span><strong>{money(model.collectedToday)}</strong><small>{model.paymentsToday} payments</small></button>
    </div>
    <div className="command-center-stages">{['Checked in', 'Diagnosing', 'Approval', 'Parts', 'Repair', 'Testing', 'Pickup'].map(stage => <button key={stage} onClick={() => showRecords(`${stage} Repairs`, model.stages[stage] || [])}><span>{stage}</span><strong>{model.stages[stage]?.length || 0}</strong></button>)}</div>
    <div className="command-center-grid">
      <section className="command-center-section queue"><header><strong>Today’s Repair Queue</strong><div><button onClick={() => showRecords('Today’s Repair Queue', model.repairQueue)}>Open Full Queue</button><button className="command-center-section-toggle" onClick={() => toggle('queue')} aria-expanded={!collapsed.queue}>{collapsed.queue ? '›' : '⌄'}</button></div></header>{!collapsed.queue ? <div className="command-center-section-scroll">{model.repairQueuePreview.map(record => <button className={record.expedited ? 'command-center-row expedited' : 'command-center-row'} key={record.id} onClick={() => activateRecord(record)} onContextMenu={event => openRecordMenu(event, record)} {...longPressHandlers(record)}><i className={record.expedited ? 'expedited' : record.stage === 'Checked in' ? 'urgent' : record.stage === 'Pickup' ? 'good' : ''} /><CommandCenterRecordHoverCard record={record} className="command-center-row-copy"><strong>{record.deviceLabel}{record.expedited ? <b className="command-center-expedited-badge">Expedited</b> : null}</strong><small>{record.customerName} · {record.problem}</small><small className="command-center-row-meta">WO #{record.id} · {relativeAge(record.activityAt)}</small></CommandCenterRecordHoverCard><em>{record.stage}</em></button>)}{!model.repairQueue.length ? <p className="command-center-empty">No actionable repairs right now.</p> : null}</div> : null}</section>
      <section className="command-center-section client-replies"><header><strong>Client Replies</strong><div><button onClick={()=>setPanel({title:'Client Replies',records:clientResponses.map(responseRecord).filter(Boolean) as CommandCenterRecord[]})}>View All ({clientResponses.length})</button><button className="command-center-section-toggle" onClick={()=>toggle('replies')}>{collapsed.replies?'›':'⌄'}</button></div></header>{!collapsed.replies?<div className="command-center-section-scroll">{clientResponses.map(reply=>{const record=responseRecord(reply);const preview=`${record?.customerName||'Client'} · WO #${reply.legacy_record_id}\n${record?.deviceLabel||'Device'}\n${record?.problem||''}\n${reply.message||`Client ${reply.response_type}`}`;return <button className="command-center-row" key={reply.id} title={preview} onClick={()=>setSelectedResponse(reply)} onContextMenu={event=>responseMenu.openFromEvent(event,reply)} {...responseLongPressHandlers(reply)}><i className={reply.response_type==='question'||reply.response_type==='pickup_change_requested'?'urgent':'good'}/><span><strong>{record?.customerName||`WO #${reply.legacy_record_id}`} · {String(reply.response_type).replaceAll('_',' ').toUpperCase()}</strong><small>{record?.deviceLabel||'Device'} · WO #{reply.legacy_record_id}</small><small>{reply.message||'No message included'}</small></span><em>{reply.unread?'New':'Open'}</em></button>})}</div>:null}</section>
      <section className="command-center-section product-delivery"><header><strong>Product Delivery</strong><div><button onClick={()=>setPanel({title:'Product Delivery',records:model.productDeliveries,kind:'product-delivery'})}>View All ({model.productDeliveries.length})</button><button className="command-center-section-toggle" onClick={()=>toggle('delivery')}>{collapsed.delivery?'›':'⌄'}</button></div></header>{!collapsed.delivery?<div className="command-center-section-scroll">{model.productDeliveries.map(record=><div className="command-center-delivery-row" key={record.id}>{(record.productDelivery?.items||[]).map(item=><div className="command-center-delivery-item" key={`${record.id}:${item.index}`} onContextMenu={event=>openDeliveryMenu(event,record,item)}><button onClick={()=>activateRecord(record)}><strong>{record.customerName} · Invoice #{record.id}</strong><small>{item.name} · Ordered {item.orderDate}</small><small>{item.eta?`ETA ${item.eta}`:'No ETA entered'}</small></button><button className="delivered" disabled={deliveryBusy.startsWith(`${record.id}:`)} onClick={()=>void markProductsDelivered(record,[item.index],false)}>{deliveryBusy.startsWith(`${record.id}:`)?'Saving…':'Delivered · No Email'}</button></div>)}</div>)}{!model.productDeliveries.length?<p className="command-center-empty">No cart-ordered sales products are awaiting delivery.</p>:null}</div>:null}</section>
    </div>
    {panel?.kind === 'statistics' ? <div className="command-center-panel-layer" onMouseDown={event=>{if(event.target===event.currentTarget)setPanel(null)}}><section className="command-center-panel"><header><h2>Repair Statistics</h2><button aria-label="Close" onClick={()=>setPanel(null)}>×</button></header><div className="command-center-statistics">{model.repairStatistics.completedSamples?<><div className="command-center-stat-grid"><article><span>Completed samples</span><strong>{model.repairStatistics.completedSamples}</strong></article><article><span>Average turnaround</span><strong>{model.repairStatistics.averageTurnaroundHours}h</strong></article><article><span>Average diagnosis</span><strong>{model.repairStatistics.averageDiagnosisHours}h</strong></article><article><span>Average testing</span><strong>{model.repairStatistics.averageTestingHours}h</strong></article><article><span>Median turnaround</span><strong>{model.repairStatistics.medianTurnaroundHours}h</strong></article><article><span>Quick turnarounds</span><strong>{model.repairStatistics.quickTurnaroundRate}%</strong></article></div><div className="command-center-stat-lists"><section><h3>Most Common Repairs</h3>{model.repairStatistics.mostCommonRepairs.map(row=><div key={row.name}><span>{row.name}</span><strong>{row.count}</strong></div>)}</section><section><h3>Learned Quick Patterns</h3>{model.repairStatistics.quickPatterns.map(row=><div key={row.key}><span>{row.label}</span><strong>{row.medianHours}h · {row.samples} jobs</strong></div>)}</section></div></>:<div className="command-center-stat-empty"><strong>Learning starts today</strong><span>Statistics will appear after repairs are started and completed through QR workflow updates.</span></div>}</div></section></div>:null}
    {panel?.kind === 'product-delivery' ? <div className="command-center-panel-layer" onMouseDown={event=>{if(event.target===event.currentTarget)setPanel(null)}}><section className="command-center-panel"><header><h2>Product Delivery</h2><button aria-label="Close" onClick={()=>setPanel(null)}>×</button></header><div className="command-center-delivery-list">{model.productDeliveries.flatMap(record=>(record.productDelivery?.items||[]).map(item=><article key={`${record.id}:${item.index}`} onContextMenu={event=>openDeliveryMenu(event,record,item)}><button onClick={()=>activateRecord(record)}><strong>{record.customerName} · Invoice #{record.id}</strong><span>{item.name}</span><small>Ordered {item.orderDate}{item.eta?` · ETA ${item.eta}`:' · No ETA entered'}</small></button><button disabled={deliveryBusy===`${record.id}:${item.index}`} onClick={()=>void markProductsDelivered(record,[item.index],false)}>{deliveryBusy===`${record.id}:${item.index}`?'Saving…':'Delivered · No Email'}</button></article>))}</div>{!model.productDeliveries.length?<p className="command-center-empty">No cart-ordered sales products are awaiting delivery.</p>:null}</section></div>:null}
    {panel && panel.kind !== 'statistics' && panel.kind !== 'product-delivery' ? <div className="command-center-panel-layer" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null); }}><section className="command-center-panel"><header><h2>{panel.title}</h2><div><button title="Open in separate window" onClick={() => window.open(window.location.href, '_blank', 'width=1100,height=800')}>↗</button><button aria-label="Close" onClick={() => setPanel(null)}>×</button></div></header>{panel.kind === 'today' ? <div className="command-center-today-preview">{((panel as any).records || []).map((row: any, index: number) => <button type="button" key={String(row?.id || index)} onClick={()=>openTodayItem(row)}><strong>{todayLabel(row)}</strong><span>{todayDetail(row)}</span><time>{todayTime(row)}</time></button>)}</div> : <div className="command-center-panel-table"><table><thead><tr><th>Record</th><th>Device / Client</th><th>{panel.title === 'Needs Attention' ? 'Attention required' : 'Status'}</th><th>Technician</th><th>Balance</th><th>Activity</th></tr></thead><tbody>{panelRecords.map(record => <tr className={record.expedited ? 'expedited' : ''} key={`${record.kind}-${record.id}`} onDoubleClick={() => activateRecord(record)} onContextMenu={event => openRecordMenu(event, record)} {...longPressHandlers(record)}><td>{record.kind === 'workorder' ? `WO #${record.id}` : `Invoice #${record.id}`}</td><td><CommandCenterRecordHoverCard record={record} className="command-center-panel-record"><strong>{recordLabel(record)}{record.expedited ? <b className="command-center-expedited-badge">Expedited</b> : null}</strong><small>{record.kind === 'workorder' ? `${record.customerName} · ${record.problem}` : record.customerName}</small></CommandCenterRecordHoverCard></td><td>{panel.title === 'Needs Attention' ? record.attentionReasons.map(reason=>reason.label).join(' · ') : record.stage || record.status}</td><td>{record.technician}</td><td>{money(record.remaining)}</td><td>{relativeAge(record.activityAt)}</td></tr>)}</tbody></table></div>}{!((panel as any).records || []).length ? <p className="command-center-empty">Nothing scheduled in this category today.</p> : null}</section></div> : null}
    <ContextMenu id="command-center-record-menu" open={recordMenu.state.open} x={recordMenu.state.x} y={recordMenu.state.y} items={recordMenuItems} onClose={recordMenu.close} zIndex={240} />
    <ContextMenu id="command-center-delivery-menu" open={deliveryMenu.state.open} x={deliveryMenu.state.x} y={deliveryMenu.state.y} items={deliveryMenuItems} onClose={deliveryMenu.close} zIndex={244} />
    <ContextMenu id="command-center-response-menu" open={responseMenu.state.open} x={responseMenu.state.x} y={responseMenu.state.y} items={responseMenuItems} onClose={responseMenu.close} zIndex={245} />
    {selectedResponse ? <div className="command-center-panel-layer" onMouseDown={event=>{if(event.target===event.currentTarget)setSelectedResponse(null)}}><section className="command-center-panel command-center-reply"><header><h2>Client Reply · WO #{selectedResponse.legacy_record_id}</h2><button aria-label="Close" onClick={()=>setSelectedResponse(null)}>×</button></header><div className="command-center-reply-body"><strong>{responseRecord(selectedResponse)?.customerName||'Client'} · {responseRecord(selectedResponse)?.deviceLabel||'Device'}</strong><p>{selectedResponse.message||`Client ${selectedResponse.response_type} the repair.`}</p><label>Send Reply<textarea value={staffReply} onChange={event=>setStaffReply(event.target.value)} placeholder="Type a response to the client…" /></label><div><button onClick={()=>{const record=responseRecord(selectedResponse);if(record)void openRecord(record)}}>Open Work Order</button><button onClick={()=>void resolveResponse(selectedResponse)}>Mark Resolved</button><button className="send" disabled={replyBusy||!staffReply.trim()} onClick={()=>void sendReply()}>{replyBusy?'Sending…':'Send Reply'}</button></div></div></section></div>:null}
    {moveDialog ? <div className="command-center-panel-layer command-center-move-layer" onMouseDown={event=>{if(event.target===event.currentTarget&&!moveBusy)setMoveDialog(null)}}><section className="command-center-move-dialog" role="dialog" aria-modal="true" aria-labelledby="command-center-move-title"><header><div><small>WO #{moveDialog.record.id}</small><h2 id="command-center-move-title">Move to {moveDialog.label}</h2><p>{moveDialog.record.customerName} · {moveDialog.record.deviceLabel}</p></div><button aria-label="Close" disabled={moveBusy} onClick={()=>setMoveDialog(null)}>×</button></header><div className="command-center-move-fields">{commandCenterMoveFields(moveDialog.key).includes('partsEstimate')?<div className="command-center-move-money"><label>Parts estimate<input type="number" min="0" step="0.01" value={moveValue.partsEstimate||''} onChange={event=>setMoveValue(current=>({...current,partsEstimate:event.target.value}))}/></label><label>Labor estimate<input type="number" min="0" step="0.01" value={moveValue.laborEstimate||''} onChange={event=>setMoveValue(current=>({...current,laborEstimate:event.target.value}))}/></label></div>:null}{commandCenterMoveFields(moveDialog.key).includes('orderDate')?<label>Part ordered date<input type="date" value={moveValue.orderDate||''} onChange={event=>setMoveValue(current=>({...current,orderDate:event.target.value}))}/></label>:null}{commandCenterMoveFields(moveDialog.key).includes('estimatedDate')?<label>{moveDialog.key==='waiting_part'?'Expected delivery date':'Expected completion / arrival'}<input type="date" value={moveValue.estimatedDate||''} onChange={event=>setMoveValue(current=>({...current,estimatedDate:event.target.value}))}/></label>:null}{commandCenterMoveFields(moveDialog.key).includes('deliveredDate')?<label>Delivered date<input type="date" value={moveValue.deliveredDate||''} onChange={event=>setMoveValue(current=>({...current,deliveredDate:event.target.value}))}/></label>:null}{commandCenterMoveFields(moveDialog.key).includes('itemIndexes')?<fieldset><legend>Delivered parts/products</legend>{(moveDialog.record.source?.items||[]).map((item:any,index:number)=>{const physical=(item?.requiresOrder===true||item?.inStock===false||/needed|ordered|received|delivered|transit|awaiting/i.test(String(item?.orderStatus||item?.partStatus||'')))&&!item?.isLabor&&!/labor|diagnostic|fee/i.test(String(item?.type||item?.category||''));return physical?<label className="command-center-move-check" key={item.id||index}><input type="checkbox" checked={(moveValue.itemIndexes||[]).includes(index)} onChange={event=>setMoveValue(current=>({...current,itemIndexes:event.target.checked?[...(current.itemIndexes||[]),index]:(current.itemIndexes||[]).filter(value=>value!==index)}))}/><span>{item.repair||item.description||item.title||`Item ${index+1}`}</span></label>:null})}</fieldset>:null}{commandCenterMoveFields(moveDialog.key).includes('notes')?<label>{moveDialog.key==='not_possible'?'Reason / client explanation':moveDialog.key==='testing_in_progress'?'Testing details':'Details for the client'}<textarea value={moveValue.notes||''} onChange={event=>setMoveValue(current=>({...current,notes:event.target.value}))} placeholder="Add only the information the client needs…"/></label>:null}{moveError?<p className="command-center-move-error">{moveError}</p>:null}</div><footer><span>This saves the status and emails the client.</span><div><button disabled={moveBusy} onClick={()=>setMoveDialog(null)}>Cancel</button><button className="confirm" disabled={moveBusy} onClick={()=>void submitMove(moveDialog.record,moveDialog.key,moveValue)}>{moveBusy?'Saving & sending…':`Confirm ${moveDialog.label}`}</button></div></footer></section></div>:null}
  </div>;
}
