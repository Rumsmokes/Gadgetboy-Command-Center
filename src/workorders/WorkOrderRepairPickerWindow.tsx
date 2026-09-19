import React, { useState, useEffect } from 'react';
import RepairItemList from '../repairs/RepairItemList';
import type { RepairItem } from '../lib/types';
import { sortRepairsForDevice } from '../lib/repairCompatibility';

export default function WorkOrderRepairPickerWindow() {
  const deviceContext = (() => { try { return JSON.parse(new URLSearchParams(window.location.search).get('deviceContext') || '{}'); } catch { return {}; } })();
  const [repairItems, setRepairItems] = useState<RepairItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<RepairItem | null>(null);
  const [filteredItems, setFilteredItems] = useState<RepairItem[]>([]);

  // Load repairs from DB on mount
  useEffect(() => {
    (async () => {
      if (window.api?.dbGet) {
        const items = await window.api.dbGet('repairCategories');
        if (Array.isArray(items)) setRepairItems(sortRepairsForDevice(items, deviceContext));
      }
    })();
  }, []);

  const handleItemSelect = (item: RepairItem) => {
    setSelectedItem(item);
  };

  const handleCancel = () => {
    window.close();
  };

  function finalize(item: RepairItem) {
    if (!item) return;
    try {
      console.log('[Picker] finalize selection', item);
      if (window.api && typeof window.api.sendRepairSelected === 'function') {
        window.api.sendRepairSelected(item);
      } else if (window.opener && typeof window.opener.postMessage === 'function') {
        window.opener.postMessage({ type: 'repair-selected', repair: item }, '*');
      }
    } catch (e) {
      console.error('Failed to send repair-selected', e);
    }
    window.close();
  }

  return (
    <div className="gb-repair-picker-window grid h-screen overflow-hidden bg-[#0c0c0f] p-4 text-gray-100">
      <section className="mx-auto flex h-full w-full max-w-6xl min-h-0 flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-[#17171c] shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-zinc-700 bg-[#1d1d23] px-5 py-4">
          <div><h1 className="text-lg font-semibold text-zinc-100">Pick catalog repair</h1><p className="mt-1 text-xs text-zinc-400">Choose a saved repair, then add it to this work order.</p></div>
          <button type="button" aria-label="Close repair picker" className="h-9 w-9 shrink-0 rounded-lg border border-zinc-600 bg-zinc-900 text-xl leading-none text-zinc-200" onClick={handleCancel}>×</button>
        </header>
        <div className="gb-repair-picker-layout grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(480px,1.35fr)_minmax(300px,0.65fr)]">
        {/* Left pane: Item list */}
        <div className="gb-repair-picker-list-pane flex flex-col min-h-0">
          <RepairItemList 
            items={repairItems}
            filteredItems={filteredItems}
            selectedItem={selectedItem}
            onItemSelect={handleItemSelect}
            onFilteredItemsChange={setFilteredItems}
          />
        </div>
        <aside className="gb-repair-picker-form-pane flex min-h-0 flex-col overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-4">
          <div className="border-b border-zinc-800 pb-3">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#39FF14]">Repair selection</div>
            <h2 className="mt-1 text-lg font-semibold">Add to work order</h2>
            <p className="mt-1 text-xs text-zinc-500">Catalog pricing and inventory links are managed in Admin → Repairs.</p>
          </div>
          {!selectedItem ? <div className="grid min-h-48 flex-1 place-items-center text-center text-sm text-zinc-500">Select a repair from the categorized list.</div> : <div className="flex flex-1 flex-col gap-3 pt-4">
            <div><div className="text-xs text-zinc-500">Repair</div><strong className="text-lg text-white">{selectedItem.title}</strong></div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs">{selectedItem.category || 'All devices'}</span>
              <span className="rounded-full border border-purple-500/50 bg-purple-500/10 px-2.5 py-1 text-xs text-purple-200">{selectedItem.repairCategory || 'General repair'}</span>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Inventory relationship</div>
              <div className="mt-1 text-sm font-semibold text-zinc-200">{Number((selectedItem as any).inventoryParentId || 0) > 0 ? 'Parent part family' : Number((selectedItem as any).inventoryProductId || 0) > 0 ? 'Exact inventory part' : 'No inventory part linked'}</div>
              {Number((selectedItem as any).inventoryParentId || 0) > 0 ? <p className="mt-1 text-xs text-fuchsia-200">The exact compatible variant will be selected next.</p> : null}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3"><div className="text-[10px] uppercase text-zinc-500">Parts</div><strong>${Number(selectedItem.partCost || 0).toFixed(2)}</strong></div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3"><div className="text-[10px] uppercase text-zinc-500">Labor</div><strong>${Number(selectedItem.laborCost || 0).toFixed(2)}</strong></div>
              <div className="rounded-lg border border-[#39FF14]/40 bg-[#39FF14]/5 p-3"><div className="text-[10px] uppercase text-[#39FF14]">Total</div><strong>${(Number(selectedItem.partCost || 0) + Number(selectedItem.laborCost || 0)).toFixed(2)}</strong></div>
            </div>
            <div className="mt-auto grid grid-cols-2 gap-2 border-t border-zinc-800 pt-4"><button type="button" onClick={handleCancel} className="rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm">Cancel</button><button type="button" onClick={() => finalize(selectedItem)} className="rounded bg-[#39FF14] px-4 py-2 text-sm font-bold text-black">Add Repair</button></div>
          </div>}
        </aside>
        </div>
      </section>
    </div>
  );
}
