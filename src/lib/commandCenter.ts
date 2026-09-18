import { buildTechnicianIndex, resolveTechnician } from './technicianIdentity';
import { compareRepairQueuePriority, isExpeditedWorkOrder, partEtaFor, repairPresentationFor } from './commandCenterPresentation';
import { expandRecurringEvent } from './calendarRecurrence';
import { attentionReasonsForWorkOrder, workOrderAgeDays, type AttentionReason } from './workOrderLifecycle';
import { buildRepairStatistics, repairPatternKey, type RepairStatistics } from './repairStatistics';
import { productDeliveryFor } from './productDelivery';
import { deriveOperationalStage, isOperationallyTerminal } from './repairWorkflow';

export type CommandCenterKind = 'workorder' | 'sale' | 'consultation';

export interface CommandCenterRecord {
  id: string | number;
  kind: CommandCenterKind;
  customerId?: string | number;
  customerName: string;
  title: string;
  deviceLabel: string;
  deviceCategory: string;
  problem: string;
  model: string;
  serial: string;
  expedited: boolean;
  quickTurnaround: boolean;
  stagnant: boolean;
  partsReady: boolean;
  attentionReasons: AttentionReason[];
  productDelivery?: { itemIndexes: number[]; itemCount: number; itemNames: string[]; items: Array<{index:number;name:string;eta:string;orderDate:string;orderUrl:string}>; eta: string };
  status: string;
  technician: string;
  total: number;
  remaining: number;
  activityAt: string;
  stage?: string;
  partEta?: string;
  promisedAt?: string;
  promiseNote?: string;
  searchText: string;
  source: any;
}

export interface CommandCenterModel {
  records: CommandCenterRecord[];
  workOrders: CommandCenterRecord[];
  sales: CommandCenterRecord[];
  activeWorkOrders: CommandCenterRecord[];
  awaitingParts: CommandCenterRecord[];
  readyForPickup: CommandCenterRecord[];
  repairQueue: CommandCenterRecord[];
  repairQueuePreview: CommandCenterRecord[];
  needsAttention: CommandCenterRecord[];
  repairStatistics: RepairStatistics;
  productDeliveries: CommandCenterRecord[];
  collectedToday: number;
  paymentsToday: number;
  stages: Record<string, CommandCenterRecord[]>;
  today: { tasks: any[]; events: any[]; notes: any[]; consultations: CommandCenterRecord[]; deliveries: any[] };
}

type CommandCenterInput = { customers?: any[]; technicians?: any[]; workOrders?: any[]; sales?: any[]; calendarEvents?: any[]; calendarNotes?: any[]; purchaseOrders?: any[]; attentionSettings?: any; now?: Date };

const text = (value: any) => String(value ?? '').trim();
const number = (value: any) => Number(value || 0) || 0;
const lower = (value: any) => text(value).toLowerCase();
const timestamp = (value: any) => {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};
const sameLocalDay = (value: any, now: Date) => {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
};
const calendarKind = (event: any) => lower(event?.category || event?.type || event?.eventType);
const consultationDateFor = (record: CommandCenterRecord) => record.source?.appointmentDate || record.source?.appointment_date || record.source?.eventDate || record.source?.event_date || record.activityAt;

function customerNameFor(record: any, customers: Map<string, any>) {
  const customer = customers.get(text(record?.customerId));
  const composed = [customer?.firstName, customer?.lastName].filter(Boolean).join(' ').trim();
  return composed || text(customer?.name) || text(record?.customerName) || (record?.customerId ? `Client #${record.customerId}` : 'Walk-in');
}

function lineTitle(record: any) {
  const lines = Array.isArray(record?.items) ? record.items : [];
  const titles = lines.map((item: any) => text(item?.repair || item?.description || item?.title || item?.name)).filter(Boolean);
  return titles.join(', ') || text(record?.productDescription || record?.summary || record?.problemInfo || record?.problem) || 'Untitled record';
}

function sharedRecordAttention(record: CommandCenterRecord, customers: Map<string, any>): AttentionReason[] {
  const result: AttentionReason[] = [];
  const source = record.source || {};
  if (source?.customerId != null && !customers.has(text(source.customerId))) result.push({ code: 'client-unresolved', label: 'Linked client cannot be resolved' });
  if (source?.pendingSync === true || source?.pending_sync === true) result.push({ code: 'sync-pending', label: 'Record is waiting to synchronize' });
  if (lower(source?.emailDeliveryStatus || source?.email_delivery_status) === 'failed') result.push({ code: 'email-failed', label: 'Client email delivery failed' });
  const rawTotal = source?.totals?.total ?? source?.total;
  const rawBalance = source?.totals?.remaining ?? source?.balance;
  if ((rawTotal != null && (!Number.isFinite(Number(rawTotal)) || Number(rawTotal) < 0)) || (rawBalance != null && (!Number.isFinite(Number(rawBalance)) || Number(rawBalance) < 0))) result.push({ code: 'invalid-totals', label: 'Totals or balance are invalid' });
  return result;
}

function isFinishedWorkOrder(workOrder: any) {
  return isOperationallyTerminal(workOrder);
}

function orderedPartState(workOrder: any) {
  const items = (Array.isArray(workOrder?.items) ? workOrder.items : []).filter((item: any) => {
    if (item?.labor === true || item?.isLabor === true || item?.feeType) return false;
    return item?.requiresOrder === true || /needed|ordered|awaiting|in.?transit|delivered|received/i.test(lower(item?.orderStatus || item?.partStatus));
  });
  const delivered = (item: any) => /delivered|received|in.?stock/i.test(lower(item?.orderStatus || item?.partStatus));
  return { waiting: items.some((item: any) => !delivered(item)), ready: items.length > 0 && items.every(delivered) };
}

function paymentRecordedAt(payment: any) {
  return payment?.at || payment?.date || payment?.createdAt || payment?.paidAt || '';
}

function collectedPaymentAmount(payment: any) {
  const applied = Number(payment?.applied);
  if (Number.isFinite(applied) && applied >= 0) return applied;
  const tendered = number(payment?.amount ?? payment?.tendered ?? payment?.tender ?? payment?.paid);
  return Math.max(0, tendered - number(payment?.change ?? payment?.changeDue));
}

function outstandingBalance(record: any, total: number) {
  const payments = Array.isArray(record?.payments) ? record.payments : [];
  const ledgerPaid = payments.reduce((sum: number, payment: any) => sum + collectedPaymentAmount(payment), 0);
  const paid = Math.max(number(record?.amountPaid), number(record?.totals?.paid), ledgerPaid);
  if (record?.totals?.total != null || record?.total != null) {
    return Math.max(0, Math.round((total - paid) * 100) / 100);
  }
  return Math.max(0, number(record?.totals?.remaining ?? record?.balance));
}

function stageFor(workOrder: any, remaining: number, partState = orderedPartState(workOrder)) {
  return deriveOperationalStage(workOrder, { remaining, partsReady: partState.ready });
}

export function buildCommandCenterModel(input: CommandCenterInput): CommandCenterModel {
  const now = input.now || new Date();
  const repairStatistics = buildRepairStatistics(input.workOrders || []);
  const quickPatterns = new Set(repairStatistics.quickPatternKeys);
  const customers = new Map((input.customers || []).map(customer => [text(customer?.id), customer]));
  const technicians = buildTechnicianIndex(input.technicians || []);
  const workOrders = (input.workOrders || []).map((record): CommandCenterRecord => {
    const total = number(record?.totals?.total ?? record?.total);
    const remaining = outstandingBalance(record, total);
    const partState = orderedPartState(record);
    const stage = stageFor(record, remaining, partState);
    const customerName = customerNameFor(record, customers);
    const title = lineTitle(record);
    const presentation = repairPresentationFor(record);
    const activityAt = text(record?.lastTechnicianActivityAt || record?.last_technician_activity_at || record?.activityAt || record?.updatedAt || record?.checkInAt || record?.createdAt);
    const isPromise = /promise/i.test(text(record?.statusUpdate));
    const promisedAt = text(record?.promisedAt || record?.promised_at || (isPromise ? record?.estimatedDate : ''));
    const promiseNote = text(record?.promiseNote || record?.promise_note || (isPromise ? record?.techNotes : ''));
    const technicianIdentity = resolveTechnician(record?.assignedTo, technicians);
    const attentionReasons = attentionReasonsForWorkOrder(record, { now, settings: input.attentionSettings, technicianState: technicianIdentity.state });
    return { id: record?.id, kind: 'workorder', customerId: record?.customerId, customerName, title, ...presentation, expedited: isExpeditedWorkOrder(record), quickTurnaround: quickPatterns.has(repairPatternKey(record)), stagnant: attentionReasons.some(reason => ['not-started','workflow-stalled','client-update-unfollowed'].includes(reason.code)), partsReady: partState.ready, attentionReasons, status: text(record?.status || stage), technician: technicianIdentity.name, total, remaining, activityAt, stage, partEta: partEtaFor(record), promisedAt, promiseNote, searchText: `${record?.id} ${customerName} ${title} ${presentation.deviceLabel} ${presentation.problem} ${presentation.serial} ${promiseNote} ${record?.phone || ''} ${record?.email || ''}`.toLowerCase(), source: record };
  });
  const sales = (input.sales || []).map((record): CommandCenterRecord => {
    const total = number(record?.totals?.total ?? record?.total);
    const remaining = outstandingBalance(record, total);
    const customerName = customerNameFor(record, customers);
    const title = lineTitle(record);
    const kind: CommandCenterKind = lower(record?.type || record?.saleType).includes('consult') ? 'consultation' : 'sale';
    const activityAt = text(record?.activityAt || record?.checkoutDate || record?.checkInAt || record?.createdAt);
    return { id: record?.id, kind, customerId: record?.customerId, customerName, title, deviceLabel: title, deviceCategory: '', problem: '', model: '', serial: '', expedited: false, quickTurnaround: false, stagnant: false, partsReady: false, attentionReasons: [], status: text(record?.status), technician: resolveTechnician(record?.assignedTo, technicians).name, total, remaining, activityAt, searchText: `${record?.id} ${customerName} ${title} ${record?.phone || ''} ${record?.email || ''}`.toLowerCase(), source: record };
  });
  workOrders.forEach(record => {
    record.attentionReasons.push(...sharedRecordAttention(record, customers));
    const items = Array.isArray(record.source?.items) ? record.source.items : [];
    if (!isFinishedWorkOrder(record.source) && !items.length && workOrderAgeDays(record.source, now) >= Number(input.attentionSettings?.notStartedAttentionDays ?? 2)) record.attentionReasons.push({ code: 'missing-line-items', label: 'Work order still has no repair or diagnostic line items' });
    if (record.deviceLabel === 'Device not entered') record.attentionReasons.push({ code: 'missing-device', label: 'Device information is missing' });
  });
  sales.forEach(record => {
    record.productDelivery = productDeliveryFor(record.source);
    record.attentionReasons.push(...sharedRecordAttention(record, customers));
    if (!isFinishedWorkOrder(record.source) && !(Array.isArray(record.source?.items) && record.source.items.length)) record.attentionReasons.push({ code: 'missing-line-items', label: `${record.kind === 'consultation' ? 'Consultation' : 'Sale'} has no line items` });
    if (record.kind === 'consultation' && !text(record.source?.appointmentDate || record.source?.appointment_date || record.source?.eventDate || record.source?.event_date)) record.attentionReasons.push({ code: 'consultation-unscheduled', label: 'Consultation has no scheduled date' });
  });
  const stages: Record<string, CommandCenterRecord[]> = Object.fromEntries(['Checked in', 'Diagnosing', 'Approval', 'Parts', 'Repair', 'Testing', 'Pickup', 'Completed', 'Waiting Device'].map(stage => [stage, []]));
  workOrders.forEach(record => stages[record.stage || 'Checked in']?.push(record));
  const activeWorkOrders = workOrders.filter(record => record.stage !== 'Completed' && record.stage !== 'Pickup');
  const awaitingParts = stages.Parts;
  const readyForPickup = stages.Pickup;
  const needsAttention = [...workOrders, ...sales].filter(record => record.attentionReasons.length > 0);
  const productDeliveries = sales.filter(record => record.kind === 'sale' && Number(record.productDelivery?.itemCount || 0) > 0);
  const repairQueue = activeWorkOrders.filter(record => {
    if (record.stage === 'Waiting Device' || record.stage === 'Testing' || record.stage === 'Pickup' || record.stage === 'Completed') return false;
    return record.stage !== 'Parts';
  }).sort(compareRepairQueuePriority);
  const todayPayments = [...workOrders, ...sales].flatMap(record => {
    const payments = Array.isArray(record.source?.payments) ? record.source.payments : [];
    if (payments.length) return payments.filter((payment: any) => sameLocalDay(paymentRecordedAt(payment), now)).map(collectedPaymentAmount);
    return sameLocalDay(record.source?.checkoutDate || record.source?.paidAt, now) ? [number(record.source?.amountPaid || record.total)] : [];
  });
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const calendar = (input.calendarEvents || []).flatMap(event => {
    if (!event?.recurrenceRule) return [event];
    const occurrences = expandRecurringEvent(event, todayKey, todayKey);
    return occurrences.length ? occurrences : [];
  });
  return { records: [...workOrders, ...sales].sort((a, b) => timestamp(b.activityAt) - timestamp(a.activityAt)), workOrders, sales, activeWorkOrders, awaitingParts, readyForPickup, repairQueue, repairQueuePreview: repairQueue.slice(0, 8), needsAttention, repairStatistics, productDeliveries, collectedToday: todayPayments.reduce((sum, amount) => sum + amount, 0), paymentsToday: todayPayments.length, stages, today: { tasks: calendar.filter(event => sameLocalDay(event?.date || event?.start, now) && calendarKind(event).includes('task')), events: calendar.filter(event => sameLocalDay(event?.date || event?.start, now) && !/task|delivery|consult/.test(calendarKind(event))), notes: (input.calendarNotes || []).filter(note => sameLocalDay(note?.date, now)), consultations: sales.filter(record => record.kind === 'consultation' && sameLocalDay(consultationDateFor(record), now)), deliveries: [...calendar.filter(event => sameLocalDay(event?.date || event?.start, now) && calendarKind(event).includes('delivery')), ...(input.purchaseOrders || []).filter(order => sameLocalDay(order?.expectedDeliveryDate || order?.eta, now))] } };
}

export function searchCommandCenterRecords(model: CommandCenterModel, query: string) {
  const terms = lower(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return model.records.filter(record => terms.every(term => record.searchText.includes(term))).slice(0, 30);
}

export function removeCommandCenterRecord<T extends Pick<CommandCenterRecord, 'id' | 'kind'>>(records: T[] = [], target: Pick<CommandCenterRecord, 'id' | 'kind'>) {
  return records.filter(record => !(String(record.id) === String(target.id) && record.kind === target.kind));
}

export function upsertCommandCenterWorkOrder(records: any[] = [], record: any) {
  if (!record || record.id == null) return records;
  const index = records.findIndex(row => String(row?.id) === String(record.id));
  if (index < 0) return [record, ...records];
  const next = records.slice();
  next[index] = record;
  return next;
}

export function liveCommandCenterPanelRecords(title: string, model: CommandCenterModel, fallback: CommandCenterRecord[] = []) {
  if (title === 'Active Work Orders') return model.activeWorkOrders;
  if (title === 'Awaiting Parts') return model.awaitingParts;
  if (title === 'Ready for Pickup') return model.readyForPickup;
  if (title === 'Today’s Repair Queue') return model.repairQueue;
  if (title === 'Needs Attention') {
    const currentByKey = new Map(model.records.map(record => [`${record.kind}:${record.id}`, record]));
    return fallback.flatMap(previous => {
      const current = currentByKey.get(`${previous.kind}:${previous.id}`);
      if (!current) return [];
      const replyReasons = previous.attentionReasons.filter(reason => reason.code === 'client-reply-unread');
      const reasons = [...current.attentionReasons];
      replyReasons.forEach(reason => {
        if (!reasons.some(existing => existing.code === reason.code)) reasons.push(reason);
      });
      return reasons.length ? [{ ...current, attentionReasons: reasons }] : [];
    });
  }
  const stageMatch = title.match(/^(Checked in|Diagnosing|Approval|Parts|Repair|Testing|Pickup) Repairs$/);
  if (stageMatch) return model.stages[stageMatch[1]] || [];
  const currentByKey = new Map(model.records.map(record => [`${record.kind}:${record.id}`, record]));
  return fallback.map(record => currentByKey.get(`${record.kind}:${record.id}`)).filter(Boolean) as CommandCenterRecord[];
}
