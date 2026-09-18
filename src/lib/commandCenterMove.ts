import { deliverableItemIndexes, type ClientUpdateDetail } from './clientUpdateOptions';

export type CommandCenterMoveKey = 'diagnosis' | 'repair_approval' | 'waiting_part' | 'part_delivered' | 'testing_in_progress' | 'repair_complete' | 'not_possible';
export type CommandCenterMoveValue = {
  estimatedDate?: string;
  deliveredDate?: string;
  orderDate?: string;
  notes?: string;
  partsEstimate?: string;
  laborEstimate?: string;
  itemIndexes?: number[];
};

export type CommandCenterMoveOption = { key: CommandCenterMoveKey; label: string; detail?: ClientUpdateDetail | 'delivered' };

const OPTIONS: CommandCenterMoveOption[] = [
  { key: 'diagnosis', label: 'Diagnosing' },
  { key: 'repair_approval', label: 'Awaiting Approval', detail: 'approval' },
  { key: 'waiting_part', label: 'Awaiting Parts', detail: 'dateNotes' },
  { key: 'part_delivered', label: 'Ready for Repair / Part Delivered', detail: 'delivered' },
  { key: 'testing_in_progress', label: 'Testing', detail: 'notes' },
  { key: 'repair_complete', label: 'Ready for Pickup / Repair Complete', detail: 'notes' },
  { key: 'not_possible', label: 'Not Repairable / Ready for Pickup', detail: 'notes' },
];

export function commandCenterMoveOptions(_record: any): CommandCenterMoveOption[] {
  return OPTIONS.map((option) => ({ ...option }));
}

export function commandCenterMoveFields(key: CommandCenterMoveKey): string[] {
  if (key === 'repair_approval') return ['partsEstimate', 'laborEstimate', 'estimatedDate', 'notes'];
  if (key === 'waiting_part') return ['orderDate', 'estimatedDate', 'notes'];
  if (key === 'part_delivered') return ['itemIndexes', 'deliveredDate', 'notes'];
  if (key === 'testing_in_progress' || key === 'repair_complete' || key === 'not_possible') return ['notes'];
  return [];
}

const amount = (value: unknown) => Math.max(0, Number(value || 0));

export function buildCommandCenterMoveRequest(record: any, key: CommandCenterMoveKey, value: CommandCenterMoveValue, idempotencyKey: string) {
  if (!record?.id) throw new Error('The work order could not be identified.');
  const notes = String(value.notes || '').trim();
  const request: Record<string, unknown> = {
    recordType: 'repair', recordId: Number(record.id), statusKey: key, deliveryMode: 'email', idempotencyKey,
  };
  if (key === 'repair_approval') {
    if (!value.estimatedDate) throw new Error('Enter the expected completion or part arrival date.');
    const parts = amount(value.partsEstimate);
    const labor = amount(value.laborEstimate);
    request.estimatedDate = value.estimatedDate;
    request.notes = `Parts: $${parts.toFixed(2)}\nLabor: $${labor.toFixed(2)}\nEstimated total: $${(parts + labor).toFixed(2)}${notes ? `\n${notes}` : ''}`;
  } else if (key === 'waiting_part') {
    if (!value.orderDate) throw new Error('Enter the date the part was ordered.');
    if (!value.estimatedDate) throw new Error('Enter the expected delivery date.');
    request.statusKey = 'part_ordered';
    request.estimatedDate = value.estimatedDate;
    request.notes = `Ordered: ${value.orderDate}${notes ? `\n${notes}` : ''}`;
  } else if (key === 'part_delivered') {
    const allowed = new Set(deliverableItemIndexes(record.items || []).filter((index) => {
      const item = record.items[index] || {};
      const text = `${item.type || ''} ${item.category || ''} ${item.description || ''} ${item.repair || ''}`.toLowerCase();
      return !item.isLabor && !/\b(labor|diagnostic|additional fee|expedited fee|service fee)\b/.test(text);
    }));
    const selected = (value.itemIndexes || []).filter((index) => allowed.has(index));
    if (!selected.length) throw new Error('Select at least one ordered part or product.');
    request.statusKey = 'items_delivered';
    request.itemIndexes = selected;
    request.notes = `Delivered: ${value.deliveredDate || new Date().toISOString().slice(0, 10)}${notes ? `\n${notes}` : ''}`;
  } else if (notes) request.notes = notes;
  return request;
}
