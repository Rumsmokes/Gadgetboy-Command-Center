export interface CleanupSettings { enabled: boolean; diagnosticOnlyDays: number; closeAllDays: number; notRepairableAttentionDays: number; notStartedAttentionDays: number; staleAttentionDays: number; clientResponseAttentionDays: number; pickupReminderDays: number; pickupAttentionDays: number }
export interface CleanupClassification { reason: 'diagnostic-only' | 'universal-age'; ageDays: number }
export interface AttentionReason { code: string; label: string }
export interface PickupLifecycle { active:boolean; anchor:string; daysWaiting:number; reminderDue:boolean; needsAttention:boolean; suggestedStorageFee:number }
export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = { enabled: true, diagnosticOnlyDays: 20, closeAllDays: 30, notRepairableAttentionDays: 1, notStartedAttentionDays: 2, staleAttentionDays: 3, clientResponseAttentionDays: 2, pickupReminderDays: 8, pickupAttentionDays: 12 };
const text = (value: unknown) => String(value ?? '').trim().toLowerCase();
const days = (value: unknown, fallback: number) => Math.max(0, Math.floor(Number(value ?? fallback) || fallback));

export function normalizeCleanupSettings(value: any): CleanupSettings {
  const diagnosticOnlyDays = Math.max(1, days(value?.diagnosticOnlyDays, 20));
  const pickupReminderDays = days(value?.pickupReminderDays, 8);
  return {
    enabled: value?.enabled !== false,
    diagnosticOnlyDays,
    closeAllDays: Math.max(diagnosticOnlyDays, days(value?.closeAllDays, 30)),
    notRepairableAttentionDays: days(value?.notRepairableAttentionDays, 1),
    notStartedAttentionDays: days(value?.notStartedAttentionDays, 2),
    staleAttentionDays: days(value?.staleAttentionDays, 3),
    clientResponseAttentionDays: days(value?.clientResponseAttentionDays, 2),
    pickupReminderDays,
    pickupAttentionDays: Math.max(pickupReminderDays, days(value?.pickupAttentionDays, 12)),
  };
}
export function workOrderAgeDays(workOrder: any, now = new Date()) {
  const anchor = new Date(workOrder?.checkInAt || workOrder?.createdAt || 0).getTime();
  return Number.isFinite(anchor) && anchor > 0 ? Math.floor(Math.max(0, now.getTime() - anchor) / 86400000) : 0;
}
export function isDiagnosticOnlyWorkOrder(workOrder: any) {
  const lines = Array.isArray(workOrder?.items) ? workOrder.items : [];
  const hasSelection = /diagnostic/.test(text(workOrder?.diagnosticSelection?.label || workOrder?.diagnosticSelection?.name));
  const lineNames: string[] = lines.map((line: any) => text(line?.repair || line?.description || line?.title || line?.name || line?.altDescription));
  const hasDiagnostic = hasSelection || lineNames.some(name => /diagnostic/.test(name));
  const hasOther = lineNames.some(name => name && !/diagnostic|evaluation|assessment/.test(name));
  return hasDiagnostic && !hasOther;
}
export function shouldCloseWorkOrderAfterPayment(workOrder: any, remaining: number, result: { markClosed?: boolean }) {
  if (result.markClosed) return true;
  if (!Number.isFinite(remaining) || remaining > 0.009) return false;
  // A zero current balance is not device completion: diagnostics and parts can
  // be prepaid at check-in. Only a pickup-ready device can auto-close on payment.
  const stage = text(deriveOperationalStage(workOrder));
  if (stage && (workOrder?.workflowUpdatedAt || workOrder?.workflow_updated_at)) return stage === 'pickup';
  const status = text([workOrder?.repairStatus, workOrder?.statusUpdate, workOrder?.status].filter(Boolean).join(' '));
  return stage === 'pickup' || /ready.*pickup|repair.*complete|not.*repairable|repair not possible/.test(status);
}
export function diagnosticCheckInClosureNeedsReview(workOrder: any, now = new Date()) {
  if (text(workOrder?.status) !== 'closed' || !workOrder?.checkoutDate || !isDiagnosticOnlyWorkOrder(workOrder)) return false;
  if (workOrder?.pickedUpAt || workOrder?.clientPickupDate || workOrder?.legacyCleanup?.closedAt) return false;
  const stage = text(workOrder?.workflowStage || workOrder?.workflow_stage);
  if (stage && stage !== 'checked in') return false;
  if (workOrder?.repairStatus || workOrder?.statusUpdate || workOrder?.patternSequence?.length) return false;
  if (workOrderAgeDays(workOrder, now) >= DEFAULT_CLEANUP_SETTINGS.diagnosticOnlyDays) return false;
  const checkIn = Date.parse(workOrder?.checkInAt || workOrder?.createdAt || '');
  const checkout = Date.parse(workOrder.checkoutDate);
  const payments = Array.isArray(workOrder.payments) ? workOrder.payments : [];
  return Number.isFinite(checkIn) && Number.isFinite(checkout) && checkout >= checkIn && checkout - checkIn <= 4 * 3600000
    && payments.length > 0 && payments.every((payment: any) => Date.parse(payment?.at || '') === checkout);
}
export function buildDiagnosticCheckInReopenPatch(workOrder: any, now = new Date()) {
  if (!diagnosticCheckInClosureNeedsReview(workOrder, now)) throw new Error('This ticket is not a recent diagnostic check-in closure.');
  return { status: 'open', checkoutDate: null, workflowStage: 'Checked in', workflowUpdatedAt: now.toISOString(), updatedAt: now.toISOString() };
}
export function classifyLegacyCleanup(workOrder: any, input: any, now = new Date()): CleanupClassification | null {
  const settings = normalizeCleanupSettings(input);
  if (!settings.enabled || text(workOrder?.status) === 'closed' || workOrder?.checkoutDate || workOrder?.legacyCleanup?.closedAt) return null;
  const ageDays = workOrderAgeDays(workOrder, now);
  if (ageDays >= settings.closeAllDays) return { reason: 'universal-age', ageDays };
  if (ageDays >= settings.diagnosticOnlyDays && isDiagnosticOnlyWorkOrder(workOrder)) return { reason: 'diagnostic-only', ageDays };
  return null;
}
export function buildLegacyClosePatch(classification: CleanupClassification, now = new Date(), input?: any) {
  const settings = normalizeCleanupSettings(input);
  return { status: 'closed', legacyCleanup: { rule: classification.reason, ageDays: classification.ageDays, diagnosticOnlyDays: settings.diagnosticOnlyDays, closeAllDays: settings.closeAllDays, closedAt: now.toISOString() }, updatedAt: now.toISOString() };
}
export function isRepairNotPossible(workOrder: any) { return /repair not possible|not repairable|cannot be repaired|unrepairable/.test(text(workOrder?.repairStatus || workOrder?.workflowStatus || workOrder?.status)); }
export function pickupLifecycleFor(workOrder:any, now=new Date(), input?:any):PickupLifecycle {
  const settings=normalizeCleanupSettings(input);
  const closed=text(workOrder?.status)==='closed' || !!(workOrder?.pickedUpAt || workOrder?.clientPickupDate || workOrder?.checkoutDate);
  const anchorValue=workOrder?.scheduledPickupAt || workOrder?.pickupReadyAt || workOrder?.repairCompletionDate || workOrder?.repairStatusAt;
  const anchor=new Date(anchorValue || 0); const valid=Number.isFinite(anchor.getTime()) && anchor.getTime()>0;
  if(closed || !valid) return {active:false,anchor:'',daysWaiting:0,reminderDue:false,needsAttention:false,suggestedStorageFee:0};
  const daysWaiting=Math.floor(Math.max(0,now.getTime()-anchor.getTime())/86400000);
  const scheduled=!!workOrder?.scheduledPickupAt;
  return {active:true,anchor:anchor.toISOString(),daysWaiting,reminderDue:daysWaiting>=settings.pickupReminderDays && !workOrder?.pickupReminderSentAt,needsAttention:daysWaiting>=settings.pickupAttentionDays,suggestedStorageFee:Math.max(0,scheduled?daysWaiting:daysWaiting-7)*25};
}
export function buildPickedUpPatch(workOrder:any, actor:string, now=new Date(), allowBalance=false) {
  const remaining=Number(workOrder?.totals?.remaining ?? workOrder?.balance ?? 0)||0;
  if(remaining>0 && !allowBalance) throw new Error(`This work order has a remaining balance of $${remaining.toFixed(2)}.`);
  const at=now.toISOString(); return {status:'closed',repairStatus:'Picked Up',statusUpdate:'Picked Up / Ticket Closed',pickedUpAt:at,clientPickupDate:at,pickedUpBy:String(actor||'Technician'),updatedAt:at};
}
export function attentionReasonsForWorkOrder(workOrder: any, context: { now?: Date; settings?: any; technicianState?: string } = {}): AttentionReason[] {
  const now = context.now || new Date(); const settings = normalizeCleanupSettings(context.settings); const result: AttentionReason[] = [];
  if (diagnosticCheckInClosureNeedsReview(workOrder, now)) result.push({ code: 'diagnostic-closed-at-checkin', label: 'Diagnostic payment closed the ticket at check-in — verify device is still here and restore if needed' });
  const status = text(workOrder?.status); const pickup = workOrder?.clientPickupDate || workOrder?.pickupDate || workOrder?.checkoutDate;
  const stage=text(deriveOperationalStage(workOrder));
  const overdue=(value:any,days=0)=>{const at=new Date(value||0).getTime();return !!at&&Number.isFinite(at)&&now.getTime()-at>=days*86400000;};
  const closed=isOperationallyTerminal(workOrder);
  const checkInAt=workOrder?.checkInAt||workOrder?.createdAt;
  const lastTechnicianAt=workOrder?.lastTechnicianActivityAt||workOrder?.last_technician_activity_at||workOrder?.lastUpdateAt||workOrder?.last_update_at;
  const statusUpdatedAt=workOrder?.statusUpdatedAt||workOrder?.status_updated_at;
  const internalNoteAt=workOrder?.lastUpdateAt||workOrder?.last_update_at;
  const partEta=workOrder?.partEta||workOrder?.part_eta||workOrder?.partsEstDelivery||workOrder?.parts_est_delivery;
  const futurePartEta=stage==='parts'&&!!partEta&&!overdue(partEta);
  const futurePickup=stage==='pickup'&&!overdue(workOrder?.scheduledPickupAt||workOrder?.scheduled_pickup_at);
  if (context.technicianState === 'unassigned') result.push({ code:'technician-unassigned', label:'No technician assigned' });
  if (context.technicianState === 'unknown') result.push({ code:'technician-unknown', label:'Technician assignment cannot be resolved' });
  if(stage==='approval'&&overdue(workOrder?.approvalRequestedAt||workOrder?.approval_requested_at,2)&&!workOrder?.clientDecision&&!workOrder?.client_decision) result.push({code:'approval-overdue',label:'Repair approval has not received a response'});
  if(overdue(workOrder?.promisedAt||workOrder?.promised_at)&&!workOrder?.promiseCompletedAt) result.push({code:'promise-overdue',label:'Customer promise is overdue'});
  if(stage==='parts'&&!partEta) result.push({code:'part-missing-eta',label:'Ordered part has no delivery estimate'});
  if(stage==='parts'&&overdue(partEta)) result.push({code:'part-overdue',label:'Part delivery estimate has passed'});
  if(text(workOrder?.emailDeliveryStatus||workOrder?.email_delivery_status)==='failed') result.push({code:'email-failed',label:'Client email delivery failed'});
  if(Number(workOrder?.unreadClientReplies||workOrder?.unread_client_replies||0)>0) result.push({code:'client-reply-unread',label:'Unread client reply'});
  if(workOrder?.pendingSync===true||workOrder?.pending_sync===true) result.push({code:'sync-pending',label:'Workflow update is waiting to synchronize'});
  if(!closed&&stage==='checked in'&&!workOrder?.diagnosisStartedAt&&!workOrder?.diagnosis_started_at&&overdue(checkInAt,settings.notStartedAttentionDays)) result.push({code:'not-started',label:`Checked in for ${settings.notStartedAttentionDays}+ days without diagnosis starting`});
  if(!closed&&!['checked in','approval','parts','pickup','completed','waiting device'].includes(stage)&&!futurePartEta&&!futurePickup&&overdue(lastTechnicianAt||statusUpdatedAt||checkInAt,settings.staleAttentionDays)) result.push({code:'workflow-stalled',label:`No repair progress for ${settings.staleAttentionDays}+ days`});
  const statusTime=new Date(statusUpdatedAt||0).getTime();
  const internalNoteTime=new Date(internalNoteAt||0).getTime();
  const clientUpdateUnfollowed=!closed&&!!statusUpdatedAt&&(!internalNoteTime||internalNoteTime<statusTime)&&overdue(statusUpdatedAt,settings.clientResponseAttentionDays)&&(!lastTechnicianAt||new Date(lastTechnicianAt).getTime()<=statusTime)&&!workOrder?.clientDecisionAt&&!workOrder?.client_decision_at;
  if(clientUpdateUnfollowed&&!futurePartEta&&!futurePickup&&!['pickup','completed','waiting device'].includes(stage)) result.push({code:'client-update-unfollowed',label:`Client update sent ${settings.clientResponseAttentionDays}+ days ago with no follow-up activity`});
  if (pickup && status !== 'closed') result.push({ code:'pickup-still-open', label:'Pickup was recorded but the ticket is still open' });
  if (isRepairNotPossible(workOrder) && !pickup && status !== 'closed') {
    const markedAt = new Date(workOrder?.repairStatusAt || workOrder?.updatedAt || workOrder?.activityAt || workOrder?.checkInAt || 0).getTime();
    if (markedAt && now.getTime() - markedAt >= settings.notRepairableAttentionDays * 86400000) result.push({ code:'not-repairable-awaiting-pickup', label:'Not repairable and still awaiting pickup' });
  }
  if (isRepairNotPossible(workOrder) && status === 'closed' && !pickup && !workOrder?.legacyCleanup?.closedAt) result.push({ code:'not-repairable-closed-without-pickup', label:'Not-repairable ticket closed without pickup' });
  const lifecycle=pickupLifecycleFor(workOrder,now,settings);
  if(lifecycle.reminderDue) result.push({code:'pickup-reminder-due',label:`Pickup reminder is due after ${settings.pickupReminderDays} days`});
  if(lifecycle.needsAttention) result.push({code:'pickup-storage-review',label:`Pickup overdue — review suggested $${lifecycle.suggestedStorageFee} storage fee`});
  return result;
}
import { deriveOperationalStage, isOperationallyTerminal } from './repairWorkflow';
