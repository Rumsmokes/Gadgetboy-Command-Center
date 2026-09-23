export type AutomaticClientEmailKind = 'diagnostic-intake' | 'part-awaiting-delivery' | 'repair-completed' | 'in-stock-sale' | 'consultation-scheduled' | 'consultation-updated';

type Details = Record<string, unknown> & { changes?: string[] };

const communicatedConsultationFields = ['date', 'time', 'location', 'topic', 'device', 'duration', 'consultant'] as const;

function value(record: Record<string, unknown>, key: string, fallback = '') {
  return String(record?.[key] ?? fallback).trim();
}

function money(input: unknown) {
  const number = Number(input || 0);
  return `$${(Number.isFinite(number) ? number : 0).toFixed(2)}`;
}

function escapeHtml(input: unknown) {
  return String(input ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function classifyAcknowledgment(record: Record<string, any>, payment: Record<string, any>): AutomaticClientEmailKind | null {
  if (!(Number(payment?.applied ?? payment?.amount ?? 0) > 0)) return null;
  const type = value(record, 'recordType').toLowerCase();
  if (type === 'repair') {
    const diagnosticAmount = repairDiagnosticAmount(record);
    const priorLaborPaid = Math.max(0, Number(payment?.priorLaborPaid || 0));
    const appliedLabor = Math.max(0, Number(payment?.appliedLabor || 0));
    const appliedParts = Math.max(0, Number(payment?.appliedParts || 0));
    if (diagnosticAmount > priorLaborPaid && appliedLabor > 0) return 'diagnostic-intake';
    if (payment?.isFinalPayment === true && appliedLabor > 0) return 'repair-completed';
    if ((record?.orderedPart || record?.partOrdered || record?.awaitingPart) && appliedParts > 0) return 'part-awaiting-delivery';
  }
  if (type === 'sale' && record?.completed && record?.inStock !== false && !record?.requiresOrder) return 'in-stock-sale';
  return null;
}

function repairDiagnosticAmount(record: Record<string, any>) {
  const selected = Number(record?.diagnosticSelection?.amount ?? record?.diagnosticSelection?.price ?? record?.diagnosticFee ?? 0);
  if (selected > 0) return selected;
  const items = Array.isArray(record?.items) ? record.items : [];
  return items.reduce((total: number, item: Record<string, any>) => {
    const description = `${item?.repairCategory || ''} ${item?.repair || item?.description || ''}`;
    return /diagnostic/i.test(description) ? total + Math.max(0, Number(item?.labor ?? item?.amount ?? 0)) : total;
  }, 0);
}

export function acknowledgmentAmount(record: Record<string, any>, payment: Record<string, any>, kind: AutomaticClientEmailKind) {
  if (kind === 'diagnostic-intake') {
    const outstanding = Math.max(0, repairDiagnosticAmount(record) - Math.max(0, Number(payment?.priorLaborPaid || 0)));
    return Math.min(outstanding, Math.max(0, Number(payment?.appliedLabor || 0)));
  }
  if (kind === 'part-awaiting-delivery') return Math.max(0, Number(payment?.appliedParts || 0));
  if (kind === 'repair-completed') return Math.max(0, Number(payment?.appliedLabor || 0));
  return Math.max(0, Number(payment?.applied ?? payment?.amount ?? 0));
}

function normalizedConsultation(record: Record<string, unknown>) {
  return communicatedConsultationFields.map((key) => [key, value(record, key)] as const);
}

export function consultationDigest(record: Record<string, unknown>) {
  const stable = JSON.stringify(normalizedConsultation(record));
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) hash = Math.imul(hash ^ stable.charCodeAt(index), 16777619);
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function consultationChanges(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const labels: Record<string, string> = { date: 'Date', time: 'Time', location: 'Location/type', topic: 'Topic', device: 'Device', duration: 'Estimated duration', consultant: 'Consultant' };
  return communicatedConsultationFields.flatMap((key) => value(previous, key) === value(next, key) ? [] : [`${labels[key]}: ${value(previous, key, 'Not provided')} → ${value(next, key, 'Not provided')}`]);
}

export function renderAutomaticClientEmail(kind: AutomaticClientEmailKind, details: Details) {
  const firstName = value(details, 'firstName', 'there');
  const device = value(details, 'device', 'your device');
  const number = value(details, 'recordNumber');
  const amount = money(details.amount);
  const date = value(details, 'date', 'Date to be confirmed');
  const time = value(details, 'time', 'Time to be confirmed');
  const dateTime = `${date} at ${time}`;
  const rows: Array<[string, string]> = [];
  let subject = '';
  let intro = '';
  let followup = '';
  if (kind === 'diagnostic-intake') {
    subject = `We’ve received your ${device} — Work Order #${number}`;
    intro = `Thank you for trusting GadgetBoy with your ${device}. We’ve received your device and recorded your diagnostic payment of ${amount}.`;
    rows.push(['Device', device], ['Reported issue', value(details, 'problem', 'Not provided')], ['Work order', `#${number}`]);
    followup = 'We’ll begin evaluating the device and send you an update as soon as we know more. We’ll use this email address for repair updates, estimates, approvals, and completion notices.';
  } else if (kind === 'part-awaiting-delivery') {
    subject = `Your repair part has been ordered — Work Order #${number}`;
    intro = `Thank you for your payment of ${amount} toward the part needed for your ${device}.`;
    rows.push(['Device', device], ['Part', value(details, 'part', 'Repair part')], ['Work order', `#${number}`], ['Current status', 'Awaiting part delivery']);
    followup = 'We’ll send you another update when the part arrives or if the order status changes. Once it arrives, we’ll continue with the repair and keep you informed.';
  } else if (kind === 'repair-completed') {
    subject = `Your ${device} repair is complete — Work Order #${number}`;
    intro = `Thank you for choosing GadgetBoy. We’ve completed your ${device} repair and recorded your final labor payment of ${amount}.`;
    rows.push(['Device', device], ['Repair', value(details, 'itemSummary', 'Completed repair')], ['Work order', `#${number}`], ['Status', 'Completed and picked up']);
    followup = 'We appreciate your business and hope your device is working exactly as it should. If you have any questions about this repair or need help with another device, please reply to this email or visit us again.';
  } else if (kind === 'in-stock-sale') {
    subject = `Thank you for your purchase — Sale #${number}`;
    intro = 'Thank you for your purchase from GadgetBoy.';
    rows.push(['Purchase', value(details, 'itemSummary', 'Purchase')], ['Total paid', amount], ['Sale', `#${number}`]);
    followup = 'We appreciate your business and hope everything works perfectly for you. If you have another device problem or need help in the future, we’d be happy to see you again.';
  } else {
    subject = kind === 'consultation-scheduled' ? `Your GadgetBoy consultation is scheduled — ${dateTime}` : `Updated GadgetBoy consultation details — ${dateTime}`;
    intro = kind === 'consultation-scheduled' ? 'Your consultation with GadgetBoy has been scheduled.' : 'Your GadgetBoy consultation has been updated. Please review the current details below.';
    rows.push(['Date', date], ['Time', time], ['Location/type', value(details, 'location', 'To be confirmed')], ['Topic', value(details, 'topic', 'Consultation')]);
    if (value(details, 'device')) rows.push(['Device', device]);
    rows.push(['Estimated duration', value(details, 'duration', 'To be confirmed')]);
    if (value(details, 'consultant')) rows.push(['Consultant', value(details, 'consultant')]);
    if (kind === 'consultation-updated' && details.changes?.length) rows.push(['Changed', details.changes.join('; ')]);
    followup = kind === 'consultation-scheduled' ? 'Please reply to this message with any additional details, questions, photos, or information you’d like us to review before the consultation.' : 'Please reply to this email if anything is incorrect or if you’d like to add information before the consultation.';
  }
  const safeSender = 'Please add our email address to your contacts or safe-sender list so our updates do not go to spam.';
  const textRows = rows.map(([label, rowValue]) => `${label}: ${rowValue}`).join('\n');
  const statusUrl = value(details, 'statusUrl');
  const text = `Hi ${firstName},\n\n${intro}\n\n${textRows}\n\n${followup}\n\n${safeSender} You may reply to this message if there is anything else we should know.\n\nThank you,\nGadgetBoy`;
  const htmlRows = rows.map(([label, rowValue]) => `<div style="padding:7px 0;border-bottom:1px solid #e4e4e7"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(rowValue)}</div>`).join('');
  const statusButton = statusUrl && (kind === 'diagnostic-intake' || kind === 'part-awaiting-delivery') ? `<p style="margin:22px 0"><a href="${escapeHtml(statusUrl)}" style="display:inline-block;background:#39ff14;color:#09090b;padding:12px 18px;text-decoration:none;font-weight:800;border-radius:6px">View Repair Status</a></p>` : '';
  const completionButtons = (kind === 'repair-completed' || kind === 'in-stock-sale') ? `<p style="margin:22px 0"><a href="https://search.google.com/local/writereview?placeid=ChIJq5X1V5i7-IgR_P2o34Acjaw" style="display:inline-block;background:#39ff14;color:#09090b;padding:12px 18px;text-decoration:none;font-weight:800;border-radius:6px;margin-right:10px">Leave us a Review</a><a href="https://linktr.ee/gadgetboysc" style="display:inline-block;background:#27272a;color:#fff;padding:12px 18px;text-decoration:none;font-weight:800;border-radius:6px">Check out more from GadgetBoy</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#18181b"><div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #d4d4d8"><div style="padding:18px 22px;background:#18181b;border-bottom:4px solid #39ff14;color:#fff"><div style="font-size:18px;font-weight:800">GADGETBOY Repair &amp; Retail</div><div style="margin-top:4px;font-size:12px;color:#d4d4d8">2822 Devine Street, Columbia, SC 29205 | (803) 708-0101</div></div><div style="padding:24px"><p>Hi <strong>${escapeHtml(firstName)}</strong>,</p><p>${escapeHtml(intro)}</p><div style="margin:20px 0;padding:16px;border:1px solid #a1a1aa;border-left:5px solid #39ff14;background:#fafafa">${htmlRows}</div><p>${escapeHtml(followup)}</p>${statusButton}${completionButtons}<p style="font-size:13px;color:#52525b">${escapeHtml(safeSender)} You may reply to this message if there is anything else we should know.</p><p>Thank you,<br><strong>GadgetBoy</strong></p></div></div></body></html>`;
  return { subject, text, html };
}
