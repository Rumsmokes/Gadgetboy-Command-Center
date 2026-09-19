export type RepairPresentation = {
  deviceLabel: string;
  deviceCategory: string;
  model: string;
  serial: string;
  problem: string;
};

const clean = (value: unknown) => String(value ?? '').trim();

export function repairPresentationFor(record: any): RepairPresentation {
  const deviceCategory = clean(record?.productCategory || record?.deviceCategory || record?.category);
  const description = clean(record?.productDescription || record?.deviceName || record?.device);
  const model = clean(record?.model || record?.deviceModel);
  const serial = clean(record?.serial || record?.serialNumber);
  const base = description || model || deviceCategory || 'Device not entered';
  const deviceLabel = model && model.toLowerCase() !== base.toLowerCase() ? `${base} - ${model}` : base;
  return {
    deviceLabel,
    deviceCategory,
    model,
    serial,
    problem: clean(record?.problemInfo || record?.problem) || 'Problem not entered',
  };
}

export function shouldOpenAttentionPanel(previousRequest: number, currentRequest: number) {
  return currentRequest > 0 && currentRequest !== previousRequest;
}

export function isExpeditedWorkOrder(record: any) {
  const items = Array.isArray(record?.items) ? record.items : [];
  return items.some((item: any) => /\b(expedit(?:e|ed|ing)?|rush)\b/i.test([
    item?.repairCategory,
    item?.repair,
    item?.description,
    item?.title,
    item?.name,
  ].filter(Boolean).join(' ')));
}

export function compareRepairQueuePriority(a: { expedited?: boolean; partsReady?: boolean; stage?: string; quickTurnaround?: boolean; stagnant?: boolean; promisedAt?: string; activityAt?: string }, b: { expedited?: boolean; partsReady?: boolean; stage?: string; quickTurnaround?: boolean; stagnant?: boolean; promisedAt?: string; activityAt?: string }) {
  if (!!a.expedited !== !!b.expedited) return a.expedited ? -1 : 1;
  if (!!a.partsReady !== !!b.partsReady) return a.partsReady ? -1 : 1;
  const aInProgress = /^(Diagnosing|Testing)$/i.test(String(a.stage || ''));
  const bInProgress = /^(Diagnosing|Testing)$/i.test(String(b.stage || ''));
  if (aInProgress !== bInProgress) return aInProgress ? -1 : 1;
  if (!!a.quickTurnaround !== !!b.quickTurnaround) return a.quickTurnaround ? -1 : 1;
  if (!!a.stagnant !== !!b.stagnant) return a.stagnant ? -1 : 1;
  const aPromise = new Date(a.promisedAt || 0).getTime();
  const bPromise = new Date(b.promisedAt || 0).getTime();
  if (!!aPromise !== !!bPromise) return aPromise ? -1 : 1;
  if (aPromise && bPromise && aPromise !== bPromise) return aPromise - bPromise;
  return new Date(a.activityAt || 0).getTime() - new Date(b.activityAt || 0).getTime();
}

export function partEtaFor(record: any) {
  const explicit = clean(record?.partsEstDelivery || record?.partsEstimatedDelivery || record?.partEta || record?.part_eta || record?.expectedDeliveryDate);
  if (explicit) return explicit;
  return /part.*(ordered|delivery)|waiting.*part/i.test(clean(record?.repairStatus || record?.workflowStatus || record?.statusUpdate))
    ? clean(record?.estimatedDate)
    : '';
}

export type AttentionAuditGroup = 'Urgent follow-up' | 'Money & inventory review' | 'Client communication & ticket details';
export type AttentionAuditEntry = { record: any; reasons: any[]; group: AttentionAuditGroup; priority: 'urgent' | 'review' | 'follow-up'; detail: string; action: string };

const moneyAndInventoryCodes = new Set(['part-missing-eta', 'transaction-missing-cost', 'inventory-low', 'inventory-reconciliation', 'missing-order-url', 'restock-pending']);
const urgentCodes = new Set(['client-reply-unread', 'pickup-storage-review', 'pickup-still-open', 'not-repairable-awaiting-pickup', 'email-failed', 'sync-pending', 'sync-failed', 'approval-pending-action']);
const actionForAttentionCode = (code: string) => {
  if (/reply/.test(code)) return 'Read & reply';
  if (/pickup|not-repairable/.test(code)) return 'Review pickup';
  if (/part|inventory|cost|order/.test(code)) return 'Review order';
  if (/technician/.test(code)) return 'Assign technician';
  return 'Open record';
};

export function buildAttentionAudit(records: any[], options: { cutoff?: string } = {}) {
  const cutoffTime = new Date(options.cutoff || '2026-09-01T00:00:00').getTime();
  const entries: AttentionAuditEntry[] = (Array.isArray(records) ? records : []).flatMap(record => {
    const createdValue = record?.source?.createdAt || record?.source?.created_at || record?.source?.date || record?.activityAt;
    const createdTime = new Date(createdValue || 0).getTime();
    const reasons = Array.isArray(record?.attentionReasons) ? record.attentionReasons : [];
    if (!Number.isFinite(createdTime) || createdTime < cutoffTime || !reasons.length) return [];
    const codes = reasons.map((reason: any) => String(reason?.code || ''));
    const group: AttentionAuditGroup = codes.some((code: string) => urgentCodes.has(code)) ? 'Urgent follow-up' : codes.some((code: string) => moneyAndInventoryCodes.has(code)) ? 'Money & inventory review' : 'Client communication & ticket details';
    const priority = group === 'Urgent follow-up' ? 'urgent' : group === 'Money & inventory review' ? 'review' : 'follow-up';
    return [{ record, reasons, group, priority, detail: reasons.map((reason: any) => String(reason?.label || 'Needs review')).join(' · '), action: actionForAttentionCode(codes[0] || '') }];
  });
  const groups = (['Urgent follow-up', 'Money & inventory review', 'Client communication & ticket details'] as AttentionAuditGroup[]).map(group => ({ group, entries: entries.filter(entry => entry.group === group) }));
  const inScope = (Array.isArray(records) ? records : []).filter(record => new Date(record?.source?.createdAt || record?.source?.created_at || record?.source?.date || record?.activityAt || 0).getTime() >= cutoffTime);
  return { entries, groups, metrics: { urgent: groups[0].entries.length, money: groups[1].entries.length, communication: groups[2].entries.length, completeness: inScope.length ? Math.round(((inScope.length - entries.length) / inScope.length) * 100) : 100 } };
}
