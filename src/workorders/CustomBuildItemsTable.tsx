import React, { useMemo, useState } from 'react';
import ContextMenu, { ContextMenuItem } from '@/components/ContextMenu';
import { useContextMenu } from '@/lib/useContextMenu';
import type { CustomBuildItemResult } from './CustomBuildItemWindow';
import LineDiscountDialog from '@/components/LineDiscountDialog';
import { discountedWorkOrderItemAmounts } from '@/lib/ticketAccounting';

export type WorkOrderItemRow = {
  id: string;
  device: string;
  repair: string;
  parts: number;
  labor: number;
  status?: string;
  note?: string;
  discountType?: 'percent' | 'amount';
  discountValue?: number;
  quantity?: number;
  unitPrice?: number;
  internalCost?: number;
  partSource?: string;
  distributorSku?: string;
  orderSourceUrl?: string;
  partSourceKind?: 'stock' | 'order' | 'client';
  addToEodCart?: boolean;
  salvagedPart?: boolean;
  requiresOrder?: boolean;
  orderStatus?: 'needed' | 'ordered' | 'received' | 'in_stock';
  orderDate?: string;
  estimatedDeliveryDate?: string;
  trackingUrl?: string;
};

function roundedMoney(value: any): number {
  return Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
}

export function customBuildResultToRow(result: CustomBuildItemResult, id: string, existing?: WorkOrderItemRow): WorkOrderItemRow {
  const isPart = result.itemType === 'part';
  const quantity = isPart ? Math.max(1, Number(result.quantity) || 1) : 1;
  const unitPrice = roundedMoney(result.price);
  const orderStatus = isPart ? (result.orderStatus || 'in_stock') : undefined;
  return {
    ...(existing || {}),
    id,
    device: 'Custom PC Build',
    repair: String(result.description || '').trim(),
    parts: isPart ? unitPrice : 0,
    labor: isPart ? 0 : unitPrice,
    quantity,
    unitPrice,
    ...(isPart ? {
      internalCost: roundedMoney(result.internalCost),
      partSource: String(result.partSource || '').trim(),
      distributorSku: String(result.distributorSku || '').trim(),
      orderSourceUrl: String(result.orderSourceUrl || '').trim(),
      partSourceKind: result.partSourceKind || (result.addToEodCart || orderStatus === 'needed' || orderStatus === 'ordered' ? 'order' : 'stock'),
      addToEodCart: result.addToEodCart ?? (orderStatus === 'needed' || orderStatus === 'ordered'),
      ...(result.salvagedPart === true ? { salvagedPart: true } : {}),
      requiresOrder: result.addToEodCart ?? (orderStatus === 'needed' || orderStatus === 'ordered'),
      orderStatus,
      orderDate: String(result.orderDate || ''),
      estimatedDeliveryDate: String(result.estimatedDeliveryDate || ''),
      trackingUrl: String(result.trackingUrl || '').trim(),
    } : { requiresOrder: false }),
    status: existing?.status || 'pending',
  };
}

export function customBuildRowToPayload(row: WorkOrderItemRow): CustomBuildItemResult {
  const isPart = Number(row.parts || 0) > 0;
  const quantity = isPart ? Math.max(1, Number(row.quantity) || 1) : 1;
  const price = Number.isFinite(Number(row.unitPrice))
    ? roundedMoney(row.unitPrice)
    : roundedMoney((isPart ? row.parts : row.labor) / quantity);
  return {
    description: row.repair,
    itemType: isPart ? 'part' : 'labor',
    quantity,
    price,
    ...(isPart ? {
      internalCost: roundedMoney(row.internalCost),
      partSource: String(row.partSource || ''),
      distributorSku: String(row.distributorSku || ''),
      orderSourceUrl: String(row.orderSourceUrl || ''),
      partSourceKind: row.partSourceKind || (row.requiresOrder ? 'order' : 'stock'),
      addToEodCart: row.addToEodCart ?? row.requiresOrder === true,
      ...(row.salvagedPart === true ? { salvagedPart: true } : {}),
      orderStatus: row.orderStatus || (row.requiresOrder ? 'needed' : 'in_stock'),
      orderDate: String(row.orderDate || ''),
      estimatedDeliveryDate: String(row.estimatedDeliveryDate || ''),
      trackingUrl: String(row.trackingUrl || ''),
    } : {}),
  };
}

interface Props {
  items: WorkOrderItemRow[];
  onChange: (items: WorkOrderItemRow[]) => void;
  onAddProduct?: () => void | Promise<void>;
  addProductDisabled?: boolean;
  /** Read-only rows (e.g., linked retail add-ons) shown in the table. */
  readonlyItems?: WorkOrderItemRow[];
  /** Optional handler for removing a read-only row from its backing record (e.g., attached retail Sale). */
  onRemoveReadonlyItem?: (row: WorkOrderItemRow) => void | Promise<void>;
}

function newId(): string {
  try {
    const c: any = (globalThis as any).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {}
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function money(n: any) {
  const v = Number(n || 0);
  return Number.isFinite(v) && v > 0 ? `$${v.toFixed(2)}` : '';
}

const CustomBuildItemsTable: React.FC<Props> = ({ items, onChange, onAddProduct, addProductDisabled, readonlyItems, onRemoveReadonlyItem }) => {
  const [selected, setSelected] = useState<string | null>(items[0]?.id || null);
  const [discounting, setDiscounting] = useState<WorkOrderItemRow | null>(null);

  const ro = Array.isArray(readonlyItems) ? readonlyItems : [];

  const ctx = useContextMenu<WorkOrderItemRow>();
  const ctxRow = ctx.state.data;

  async function openEditor(title: string, existing?: WorkOrderItemRow | null): Promise<CustomBuildItemResult | null> {
    const api: any = (window as any).api;
    if (!api?.openCustomBuildItem) {
      alert('Custom Build item editor requires the desktop app.');
      return null;
    }

    const payload = {
      title,
      item: existing
        ? customBuildRowToPayload(existing)
        : null,
    };

    const res = await api.openCustomBuildItem(payload);
    return res || null;
  }

  async function addItem() {
    const res = await openEditor('Add Line Item', null);
    if (!res) return;

    const row = customBuildResultToRow(res, newId());

    onChange([...(items || []), row]);
    setSelected(row.id);
  }

  async function editItem(row: WorkOrderItemRow) {
    const res = await openEditor('Edit Line Item', row);
    if (!res) return;

    const next = customBuildResultToRow(res, row.id, row);

    onChange(items.map((it) => (it.id === row.id ? next : it)));
  }

  function removeItem(row: WorkOrderItemRow) {
    onChange(items.filter((it) => it.id !== row.id));
    if (selected === row.id) setSelected(null);
  }

  function duplicateItem(row: WorkOrderItemRow) {
    const copy: WorkOrderItemRow = { ...row, id: newId() };
    onChange([...(items || []), copy]);
    setSelected(copy.id);
  }

  const ctxItems = useMemo<ContextMenuItem[]>(() => {
    if (!ctxRow) return [];

    const isReadonly = ro.some(r => r.id === ctxRow.id);
    if (isReadonly) {
      return [
        { type: 'header', label: ctxRow.repair || 'Line Item' },
        { label: 'Edit…', disabled: true, hint: 'Read-only' },
        { type: 'separator' },
        {
          label: 'Remove…',
          danger: true,
          disabled: typeof onRemoveReadonlyItem !== 'function',
          hint: ctxRow.note || 'Sale',
          onClick: async () => {
            await onRemoveReadonlyItem?.(ctxRow);
          },
        },
      ];
    }

    return [
      { type: 'header', label: ctxRow.repair || 'Line Item' },
      { label: 'Edit…', onClick: () => editItem(ctxRow) },
      { label: 'Duplicate', onClick: () => duplicateItem(ctxRow) },
      { label: ctxRow.discountType ? 'Edit Discount…' : 'Add Discount…', onClick: () => setDiscounting(ctxRow) },
      { type: 'separator' },
      { label: 'Remove…', danger: true, onClick: () => removeItem(ctxRow) },
    ];
  }, [ctxRow, items, ro, onRemoveReadonlyItem]);

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-sm font-semibold text-zinc-200">Build Line Items</h4>
        <div className="text-xs text-zinc-400">Parts are taxed • Labor is not</div>
      </div>

      <div className="overflow-y-auto border border-zinc-800 rounded" style={{ maxHeight: '14rem' }}>
        <table className="w-full text-sm">
          <thead className="bg-zinc-800 text-zinc-400">
            <tr>
              <th className="px-2 py-1 text-left font-semibold">Description</th>
              <th className="px-2 py-1 text-right font-semibold">Parts</th>
              <th className="px-2 py-1 text-right font-semibold">Labor</th>
            </tr>
          </thead>
          <tbody>
            {(items || []).map((it) => {
              const isSel = selected === it.id;
              return (
                <tr
                  key={it.id}
                  onClick={() => setSelected(it.id)}
                  onDoubleClick={() => editItem(it)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    ctx.openFromEvent(e, it);
                  }}
                  className={`cursor-pointer transition-colors border-l-4 ${
                    isSel
                      ? 'border-[#39FF14] bg-zinc-800/80 shadow-[inset_0_0_0_1px_#1f1f21,0_0_5px_1px_rgba(57,255,20,0.25)]'
                      : 'border-transparent hover:bg-zinc-800/60'
                  }`}
                >
                  <td className="px-2 py-1 font-medium overflow-hidden text-ellipsis">{it.repair}{it.discountType ? <span className="ml-2 text-[10px] font-semibold text-neon-green">Discount {it.discountType === 'percent' ? `${it.discountValue || 0}%` : `$${Number(it.discountValue || 0).toFixed(2)}`}</span> : null}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(it.parts)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(it.labor)}</td>
                </tr>
              );
            })}

            {ro.map((it, idx) => {
              const isSel = selected === it.id;
              return (
                <tr
                  key={`readonly-${it.id || idx}`}
                  onClick={() => setSelected(it.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelected(it.id);
                    ctx.openFromEvent(e, it);
                  }}
                  className={`cursor-pointer transition-colors border-l-4 ${
                    isSel
                      ? 'border-[#39FF14] bg-zinc-800/80 shadow-[inset_0_0_0_1px_#1f1f21,0_0_5px_1px_rgba(57,255,20,0.25)]'
                      : 'border-transparent bg-zinc-950/30 hover:bg-zinc-800/40'
                  }`}
                >
                  <td className="px-2 py-1 font-medium overflow-hidden text-ellipsis">{it.repair}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(it.parts)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(it.labor)}</td>
                </tr>
              );
            })}

            {(!items || items.length === 0) && ro.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-8 text-center text-zinc-500">
                  No line items yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 mt-2">
        <button className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded" onClick={addItem}>
          Add line item
        </button>
        {onAddProduct ? (
          <button
            className="px-3 py-1 rounded bg-neon-green text-zinc-900 font-semibold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => { void onAddProduct(); }}
            disabled={!!addProductDisabled}
          >
            Add Product
          </button>
        ) : null}
      </div>

      <ContextMenu
        id="custom-build-items-ctx"
        open={ctx.state.open}
        x={ctx.state.x}
        y={ctx.state.y}
        items={ctxItems}
        onClose={ctx.close}
      />
      {discounting ? (() => { const amounts = discountedWorkOrderItemAmounts(discounting); return <LineDiscountDialog title={discounting.repair} gross={amounts.gross} value={discounting} onClose={() => setDiscounting(null)} onApply={(discount) => { onChange(items.map((item) => item.id === discounting.id ? { ...item, ...discount } : item)); setDiscounting(null); }} />; })() : null}
    </div>
  );
};

export default CustomBuildItemsTable;
