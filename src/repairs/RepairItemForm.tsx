import React, { useMemo, useState, useEffect, useRef } from 'react';
import type { RepairItem } from '../lib/types';
import MoneyInput from '../components/MoneyInput';
import PartInventoryPicker, { type InventoryPartSelection } from '../components/PartInventoryPicker';
import { normalizeServiceKey } from '../lib/repairServiceHierarchy';
import { applyInventoryPartToRepair } from '../lib/repairPartLinking';
import { applyRepairDefaults, normalizeRepairDefaults, type RepairDefaults } from '../lib/catalogDefaults';
import { classifyRepairTutorialUrl } from '../lib/repairTutorial';

interface RepairItemFormProps {
  selectedItem: RepairItem | null;
  onSave: (item: RepairItem) => void;
  onCancel: () => void;
  onDelete?: (itemId: string | number | undefined) => void;
  mode?: 'admin' | 'workorder' | 'workorderpicker';
  // When true (default), show the internal Edit Repair action at the top
  showCreateAction?: boolean;
  initialInventoryPart?: InventoryPartSelection;
}

// Dummy device categories for now; replace with prop or API as needed
const DUMMY_DEVICE_CATEGORIES = [
  'iPhone 13',
  'iPhone 14',
  'iPad Pro',
  'Samsung Galaxy S22',
  'MacBook Air',
  'Dell XPS',
  'Other'
];

const DEFAULT_MARKUP_PCT = '10';

function repairCategoryRank(value: unknown): number {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (normalized === 'diagnostic' || normalized.startsWith('diagnostic ')) return 0;
  if (
    normalized === 'additional fees' ||
    normalized === 'additional fee' ||
    normalized.startsWith('additional fee ')
  ) return 1;
  return 2;
}

function sortRepairCategoryNames(names: string[]): string[] {
  return Array.from(new Set(names.map(name => String(name || '').trim()).filter(Boolean))).sort((a, b) => {
    const rankDiff = repairCategoryRank(a) - repairCategoryRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  });
}

function normalizeOrderUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^(https?:)?\/\//i.test(raw) ? raw.replace(/^\/\//, 'https://') : `https://${raw}`;
}

export default function RepairItemForm({ selectedItem, onSave, onCancel, onDelete, mode = 'admin', showCreateAction = true, initialInventoryPart }: RepairItemFormProps) {
  // treat 'workorderpicker' as 'workorder' for UI logic
  const effectiveMode = mode === 'workorderpicker' ? 'workorder' : mode;
  // Device Category search/dropdown state
  const [deviceCategoryInput, setDeviceCategoryInput] = useState('');
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [compatibleDeviceSearch, setCompatibleDeviceSearch] = useState('');
  const [compatibleDeviceMenuOpen, setCompatibleDeviceMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Repair Category search/dropdown state
  const [repairCategoryInput, setRepairCategoryInput] = useState('');
  const [showRepairCategoryDropdown, setShowRepairCategoryDropdown] = useState(false);
  const repairCategoryRef = useRef<HTMLInputElement>(null);
  // Whether to show the device category field
  const [hasDeviceCategory, setHasDeviceCategory] = useState(false);
  const [markupPct, setMarkupPct] = useState<string>(DEFAULT_MARKUP_PCT);
  const [orderUrlEditing, setOrderUrlEditing] = useState(false);
  const [tutorialUrlEditing, setTutorialUrlEditing] = useState(false);
  const [partPickerOpen, setPartPickerOpen] = useState(false);
  const [formData, setFormData] = useState<Partial<RepairItem>>({
    category: '',
    repairCategory: '',
    title: '',
    altDescription: '',
    partCost: 0,
    laborCost: 0,
    internalCost: undefined,
    markupPct: DEFAULT_MARKUP_PCT,
    taxExempt: false,
    orderDate: '',
    estDelivery: '',
    partSource: '',
    orderSourceUrl: '',
    tutorialUrl: '',
    type: 'service',
    model: '',
    compatibleDevices: [],
    trackStock: false,
    stockCount: undefined,
    lowStockThreshold: undefined,
  });
  // Device types (Titles) from DB
  const [deviceCategories, setDeviceCategories] = useState<string[]>([]);
  const [deviceRecords, setDeviceRecords] = useState<Array<{ name: string; title: string }>>([]);
  const deviceModelsForCategory = useMemo(() => Array.from(new Set(deviceRecords
    .filter((device) => device.title.trim().toLowerCase() === deviceCategoryInput.trim().toLowerCase())
    .map((device) => device.name.trim())
    .filter(Boolean))).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })), [deviceCategoryInput, deviceRecords]);
  // Repair types from DB + existing repair items (merged, deduped)
  const [repairTypes, setRepairTypes] = useState<string[]>([]);
  const [repairDefaults, setRepairDefaults] = useState<RepairDefaults>(() => normalizeRepairDefaults());
  // no external partSources list anymore; free-text with optional autofill
  // Search/filter logic
  const filteredCategories = deviceCategories.filter(cat =>
    cat.toLowerCase().includes(deviceCategoryInput.toLowerCase())
  );
  const filteredRepairTypes = repairTypes.filter(rt =>
    rt.toLowerCase().includes(repairCategoryInput.toLowerCase())
  );

  // Fetch device categories and repair types from DB on mount
  useEffect(() => {
    (async () => {
      if (window.api?.dbGet) {
        const cats = await window.api.dbGet('deviceCategories');
        const titles = Array.isArray(cats)
          ? Array.from(new Set(cats.map((c: any) => String(c?.title || '').trim()).filter(Boolean)))
          : [];
        setDeviceCategories(titles);
        setDeviceRecords(Array.isArray(cats) ? cats.map((entry: any) => ({
          name: String(entry?.name || '').trim(),
          title: String(entry?.title || '').trim(),
        })).filter((entry: any) => entry.name && entry.title) : []);

        // Pull from repairTypes master list AND from existing repair items' repairCategory values
        const [rt, repairItems, settingsRows] = await Promise.all([
          window.api.dbGet('repairTypes').catch(() => []),
          window.api.dbGet('repairCategories').catch(() => []),
          window.api.dbGet('settings').catch(() => []),
        ]);
        const fromTypes = Array.isArray(rt)
          ? rt.map((r: any) => String(r?.name || '').trim()).filter(Boolean)
          : [];
        const fromItems = Array.isArray(repairItems)
          ? repairItems.map((r: any) => String(r?.repairCategory || '').trim()).filter(Boolean)
          : [];
        const merged = sortRepairCategoryNames([...fromTypes, ...fromItems]);
        setRepairTypes(merged);
        setRepairDefaults(normalizeRepairDefaults(Array.isArray(settingsRows) ? settingsRows[0]?.repairDefaults : undefined));
      }
    })();
  }, []);

  // Part sources are now free-text; no subscription needed
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  // Device Category input change
  const handleDeviceCategoryInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDeviceCategoryInput(e.target.value);
    setShowCategoryDropdown(true);
    setFormData(prev => ({ ...prev, category: e.target.value, model: '', compatibleDevices: [] }));
  };

  // Select from dropdown
  const handleCategorySelect = (cat: string) => {
    setDeviceCategoryInput(cat);
    setShowCategoryDropdown(false);
    setFormData(prev => ({ ...prev, category: cat, model: '', compatibleDevices: [] }));
    inputRef.current?.blur();
  };

  // Hide dropdown on blur (with delay for click)
  const handleCategoryBlur = () => {
    setTimeout(() => setShowCategoryDropdown(false), 100);
  };

  // Update form when selectedItem changes
  useEffect(() => {
    if (selectedItem) {
      setFormData({
        ...selectedItem,
        orderDate: selectedItem.orderDate || '',
        estDelivery: selectedItem.estDelivery || '',
        markupPct: (selectedItem as any).markupPct ?? DEFAULT_MARKUP_PCT,
      });
      setMarkupPct(String((selectedItem as any).markupPct ?? DEFAULT_MARKUP_PCT));
      setOrderUrlEditing(!selectedItem.orderSourceUrl);
      setTutorialUrlEditing(!selectedItem.tutorialUrl);
      setDeviceCategoryInput(selectedItem.category || '');
      setRepairCategoryInput(selectedItem.repairCategory || '');
      setHasDeviceCategory(!!(selectedItem.category || '').trim());
      setCompatibleDeviceSearch('');
    } else {
      const blank = applyRepairDefaults<Partial<RepairItem>>({
        category: '',
        repairCategory: '',
        title: '',
        altDescription: '',
        partCost: 0,
        laborCost: 0,
        internalCost: undefined,
        markupPct: DEFAULT_MARKUP_PCT,
        taxExempt: false,
        orderDate: '',
        estDelivery: '',
        partSource: '',
        orderSourceUrl: '',
        tutorialUrl: '',
        type: 'service' as const,
        model: '',
        compatibleDevices: [],
        trackStock: false,
        stockCount: undefined,
        lowStockThreshold: undefined,
      }, repairDefaults);
      setFormData(blank);
      setMarkupPct(DEFAULT_MARKUP_PCT);
      setOrderUrlEditing(false);
      setTutorialUrlEditing(true);
      setDeviceCategoryInput('');
      setRepairCategoryInput(String(blank.repairCategory || ''));
      setHasDeviceCategory(false);
      setCompatibleDeviceSearch('');
    }
  }, [selectedItem, repairDefaults]);

  useEffect(() => {
    if (!initialInventoryPart) return;
    setFormData(current => applyInventoryPartToRepair(current, initialInventoryPart));
    setHasDeviceCategory(true);
    setDeviceCategoryInput(String(initialInventoryPart.category || ''));
  }, [initialInventoryPart, selectedItem?.id]);

  // no date fields in this form; dates are managed in Work Order and Calendar

  const clearFormFields = () => {
    setFormData({
      category: '',
      repairCategory: '',
      title: '',
      altDescription: '',
      partCost: 0,
      laborCost: 0,
      internalCost: undefined,
      markupPct: DEFAULT_MARKUP_PCT,
      taxExempt: false,
      orderDate: '',
      estDelivery: '',
      partSource: '',
      orderSourceUrl: '',
      tutorialUrl: '',
      type: 'service',
      model: '',
      compatibleDevices: [],
      trackStock: false,
      stockCount: undefined,
      lowStockThreshold: undefined,
      inventoryProductId: undefined,
    });
    setDeviceCategoryInput('');
    setRepairCategoryInput('');
    setHasDeviceCategory(false);
    setCompatibleDeviceSearch('');
    setShowCategoryDropdown(false);
    setShowRepairCategoryDropdown(false);
    setMarkupPct(DEFAULT_MARKUP_PCT);
    setOrderUrlEditing(false);
    setTutorialUrlEditing(true);
  };

  const submitDisabled =
    !formData.repairCategory ||
    !formData.title ||
    formData.partCost === undefined || isNaN(Number(formData.partCost)) ||
    formData.laborCost === undefined || isNaN(Number(formData.laborCost));

  function focusRepairCategorySoon() {
    window.setTimeout(() => {
      try { repairCategoryRef.current?.focus(); } catch {}
      try { repairCategoryRef.current?.select?.(); } catch {}
    }, 0);
  }

  function submitPrimaryAction(action: 'update' | 'create' | 'auto' = 'auto') {
    if (submitDisabled) return;

    const partCost = Number(formData.partCost);
    const laborCost = Number(formData.laborCost);
    if (!Number.isFinite(partCost) || !Number.isFinite(laborCost)) return;

    const payload: RepairItem = {
      ...(formData as any),
      partCost,
      laborCost,
      internalCost: formData.internalCost === undefined || formData.internalCost === null ? undefined : Number(formData.internalCost),
      markupPct: markupPct || DEFAULT_MARKUP_PCT,
      orderSourceUrl: normalizeOrderUrl(formData.orderSourceUrl),
      ...(() => {
        const tutorial = classifyRepairTutorialUrl(formData.tutorialUrl);
        return {
          tutorialUrl: tutorial?.normalizedUrl || '',
          tutorialMediaType: tutorial?.mediaType,
          tutorialUpdatedAt: tutorial ? new Date().toISOString() : undefined,
        };
      })(),
      repairFamily: String(formData.repairFamily || formData.repairCategory || '').trim(),
      serviceKey: normalizeServiceKey(formData.serviceKey || formData.title || formData.repairCategory),
      id: mode === 'admin'
        ? (action === 'create' ? undefined : (formData.id || undefined))
        : (formData.id || Math.random().toString(36).slice(2, 10)),
    } as RepairItem;

    onSave(payload);
    if (mode === 'admin' && (action === 'create' || !formData.id)) {
      clearFormFields();
      focusRepairCategorySoon();
    }
  }

  function selectInventoryPart(part: InventoryPartSelection) {
    setFormData((current) => applyInventoryPartToRepair(current, {
      ...part,
      reorderUrlTemplate: normalizeOrderUrl(part.reorderUrlTemplate),
    }));
    if (part.category) {
      setHasDeviceCategory(true);
      setDeviceCategoryInput(part.category);
    }
    if (!part.isParentPart) {
      setMarkupPct(String(part.markupPct ?? DEFAULT_MARKUP_PCT));
      setOrderUrlEditing(!part.reorderUrlTemplate);
    }
    setPartPickerOpen(false);
  }

  const handleEnterToSubmit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitPrimaryAction('auto');
  };

  function openTutorial() {
    const tutorial = classifyRepairTutorialUrl(formData.tutorialUrl);
    if (!tutorial) return;
    const api = (window as any).api;
    if (api?.openRepairTutorial) void api.openRepairTutorial(tutorial);
    else if (api?.openUrl) void api.openUrl(tutorial.normalizedUrl);
    else window.open(tutorial.normalizedUrl, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="gb-repair-item-form flex flex-col h-full">
      {/* Edit Repair button at top (admin only) */}
      {effectiveMode === 'admin' && showCreateAction && (
        <div className="flex justify-end mb-4">
          <button
            type="button"
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-zinc-900"
            onClick={clearFormFields}
          >
            Edit Repair
          </button>
        </div>
      )}
      <div className="gb-repair-form-body flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
        {/* Repair Info Section */}
        <div className="gb-repair-form-grid grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 1. Repair Category — always required, comes first */}
          <div className="md:col-span-2 relative">
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Repair Category <span className="text-red-400">*</span>
            </label>
            <input
              ref={repairCategoryRef}
              type="text"
              autoComplete="off"
              value={repairCategoryInput}
              onChange={e => {
                const v = e.target.value;
                setRepairCategoryInput(v);
                setFormData(prev => ({ ...prev, repairCategory: v }));
                setShowRepairCategoryDropdown(true);
              }}
              onFocus={() => setShowRepairCategoryDropdown(true)}
              onBlur={() => setTimeout(() => setShowRepairCategoryDropdown(false), 100)}
              onKeyDown={handleEnterToSubmit}
              placeholder="e.g. Diagnostic, Screen Repair, Liquid Damage, Extra Fee\u2026"
              className="w-full bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm focus:border-[#39FF14] focus:outline-none"
            />
            {showRepairCategoryDropdown && filteredRepairTypes.length > 0 && (
              <ul className="absolute z-10 left-0 right-0 bg-zinc-900 border border-zinc-700 mt-1 rounded shadow-lg max-h-40 overflow-y-auto">
                {filteredRepairTypes.map(rt => (
                  <li
                    key={rt}
                    className="px-3 py-2 hover:bg-[#39FF14] hover:text-black cursor-pointer text-sm"
                    onMouseDown={() => {
                      setRepairCategoryInput(rt);
                      setFormData(prev => ({ ...prev, repairCategory: rt }));
                      setShowRepairCategoryDropdown(false);
                      repairCategoryRef.current?.blur();
                    }}
                  >
                    {rt}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Repair Family</label>
            <input name="repairFamily" value={formData.repairFamily || ''} onChange={handleChange} placeholder="e.g. Port Repair" className="w-full rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-[#39FF14]" />
            <span className="mt-1 block text-[11px] text-zinc-500">Groups related services without duplicating a long repair list.</span>
          </div>
          <div className="rounded border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
            The service matching key is generated automatically from the repair name.
          </div>
          {/* 2. Device Category — optional, behind a checkbox */}
          <div className="md:col-span-2">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-300 cursor-pointer select-none mb-2">
              <input
                type="checkbox"
                checked={hasDeviceCategory}
                onChange={e => {
                  setHasDeviceCategory(e.target.checked);
                  if (!e.target.checked) {
                    setDeviceCategoryInput('');
                    setFormData(prev => ({ ...prev, category: '', model: '', compatibleDevices: [] }));
                  }
                }}
                className="w-4 h-4 rounded accent-[#39FF14]"
              />
              Specific to a device?
            </label>
            {hasDeviceCategory && (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="relative">
                <input
                  id="category"
                  name="category"
                  type="text"
                  ref={inputRef}
                  value={deviceCategoryInput}
                  onChange={handleDeviceCategoryInput}
                  onFocus={() => setShowCategoryDropdown(true)}
                  onBlur={handleCategoryBlur}
                  onKeyDown={handleEnterToSubmit}
                  autoComplete="off"
                  placeholder="e.g. iPhone, Game Console, Android Tablet…"
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm focus:border-[#39FF14] focus:outline-none"
                />
                {showCategoryDropdown && filteredCategories.length > 0 && (
                  <ul className="absolute z-10 left-0 right-0 bg-zinc-900 border border-zinc-700 mt-1 rounded shadow-lg max-h-40 overflow-y-auto">
                    {filteredCategories.map(cat => (
                      <li
                        key={cat}
                        className="px-3 py-2 hover:bg-[#39FF14] hover:text-black cursor-pointer"
                        onMouseDown={() => handleCategorySelect(cat)}
                      >
                        {cat}
                      </li>
                    ))}
                  </ul>
                )}
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-zinc-400">Compatible Devices</span>
                  <div className="relative">
                    <input type="search" value={compatibleDeviceSearch}
                      onChange={(event) => { setCompatibleDeviceSearch(event.target.value); setCompatibleDeviceMenuOpen(true); }}
                      onFocus={() => setCompatibleDeviceMenuOpen(true)}
                      onBlur={() => window.setTimeout(() => setCompatibleDeviceMenuOpen(false), 120)}
                      disabled={!deviceCategoryInput.trim() || deviceModelsForCategory.length === 0}
                      placeholder="Search and select devices"
                      className="w-full rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 focus:border-[#39FF14]" />
                    {compatibleDeviceMenuOpen && deviceModelsForCategory.length > 0 ? <div className="absolute z-30 mt-1 max-h-48 w-full overflow-y-auto rounded border border-zinc-600 bg-zinc-950 p-1 shadow-xl">
                      {deviceModelsForCategory.filter((device) => device.toLowerCase().includes(compatibleDeviceSearch.trim().toLowerCase())).map((device) => {
                        const selected = (formData.compatibleDevices || []).includes(device);
                        return <button type="button" key={device} onMouseDown={(event) => event.preventDefault()} onClick={() => setFormData((previous) => {
                          const current = previous.compatibleDevices || [];
                          const compatibleDevices = current.includes(device) ? current.filter((value) => value !== device) : [...current, device];
                          return { ...previous, compatibleDevices, model: compatibleDevices.length === 1 ? compatibleDevices[0] : '' };
                        })} className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${selected ? 'bg-[#BC13FE]/20 text-white' : 'text-zinc-300 hover:bg-zinc-800'}`}><span>{device}</span><span>{selected ? '✓' : ''}</span></button>;
                      })}
                    </div> : null}
                  </div>
                  {(formData.compatibleDevices || []).length ? <div className="mt-2 flex flex-wrap gap-1.5">{(formData.compatibleDevices || []).map((device) => <button type="button" key={device} onClick={() => setFormData((previous) => {
                    const compatibleDevices = (previous.compatibleDevices || []).filter((value) => value !== device);
                    return { ...previous, compatibleDevices, model: compatibleDevices.length === 1 ? compatibleDevices[0] : '' };
                  })} className="rounded border border-[#BC13FE]/60 bg-[#BC13FE]/15 px-2 py-1 text-xs">{device} ×</button>)}</div> : null}
                  <span className="mt-1 block text-[11px] text-zinc-500">Select one or more exact devices, or leave empty to make this repair available to the whole category.</span>
                </label>
              </div>
            )}
          </div>

          {/* 3. Repair Description */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Repair Description <span className="text-red-400">*</span>
            </label>
            <input type="text" value={formData.title || ''} name="title" onChange={handleChange} onKeyDown={handleEnterToSubmit} placeholder="Short name for this repair or service" className="w-full bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm focus:border-[#39FF14] focus:outline-none cursor-text" />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-300 mb-1">Alt. description</label>
            <input type="text" value={formData.altDescription || ''} name="altDescription" onChange={handleChange} onKeyDown={handleEnterToSubmit} className="w-full bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm focus:border-[#39FF14] focus:outline-none cursor-text" />
          </div>
          <div className="md:col-span-2">
            {formData.tutorialUrl && !tutorialUrlEditing ? (
              <div className="rounded-lg border border-[#39FF14]/35 bg-[#39FF14]/5 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={openTutorial} className="rounded bg-[#39FF14] px-4 py-2 text-sm font-bold text-black hover:bg-[#32E610]">Repair Tutorial</button>
                  <button type="button" onClick={() => setTutorialUrlEditing(true)} className="rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-xs hover:border-zinc-400">Change URL</button>
                  <button type="button" onClick={() => { setFormData((current) => ({ ...current, tutorialUrl: '', tutorialMediaType: undefined, tutorialUpdatedAt: undefined })); setTutorialUrlEditing(true); }} className="rounded border border-red-500/50 bg-red-950/30 px-3 py-2 text-xs text-red-200 hover:bg-red-950/60">Remove URL</button>
                </div>
                <div className="mt-2 truncate text-xs text-zinc-400" title={formData.tutorialUrl}>{formData.tutorialUrl}</div>
              </div>
            ) : (
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-300">Tutorial URL</span>
                <div className="flex gap-2">
                  <input type="url" name="tutorialUrl" value={formData.tutorialUrl || ''} onChange={handleChange} placeholder="YouTube or direct video URL" className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-[#39FF14]" />
                  {classifyRepairTutorialUrl(formData.tutorialUrl) ? <button type="button" onClick={() => setTutorialUrlEditing(false)} className="rounded border border-[#39FF14]/60 bg-[#39FF14]/10 px-3 py-2 text-xs font-semibold text-[#39FF14]">Save URL</button> : null}
                </div>
                {formData.tutorialUrl && !classifyRepairTutorialUrl(formData.tutorialUrl) ? <span className="mt-1 block text-xs text-red-300">Enter a valid HTTPS tutorial URL.</span> : <span className="mt-1 block text-[11px] text-zinc-500">YouTube and direct video links play inside the POS when supported.</span>}
              </label>
            )}
          </div>
          <section className="md:col-span-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="text-sm font-semibold text-zinc-100">Linked Inventory</h3><p className="text-[11px] text-zinc-500">Inventory quantities and reorder settings are managed in Inventory.</p></div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setPartPickerOpen(true)} className="rounded bg-[#BC13FE] px-3 py-2 text-xs font-bold text-white">Select Inventory Part or Family</button>
                {(formData.inventoryProductId || formData.inventoryParentId) ? <button type="button" onClick={() => setFormData((current) => ({ ...current, inventoryProductId: undefined, inventoryParentId: undefined, internalCost: undefined, partSource: '', orderSourceUrl: '', trackStock: false, stockCount: undefined, lowStockThreshold: undefined }))} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs">Unlink</button> : null}
              </div>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
              {formData.inventoryParentId ? `Parent family linked · exact variant selected when added to a work order` : formData.inventoryProductId ? `Exact inventory part linked${formData.partSource ? ` · ${formData.partSource}` : ''}` : 'No inventory part linked · pricing can be entered manually'}
            </div>
            {(formData as any).compatibleDevices?.length ? <div className="mt-2 rounded-lg border border-[#39FF14]/30 bg-[#39FF14]/5 p-3"><div className="text-[10px] font-bold uppercase tracking-wider text-[#39FF14]">Compatibility synced from Inventory</div><div className="mt-2 flex flex-wrap gap-1.5">{(formData as any).compatibleDevices.map((device: string) => <span key={device} className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px]">✓ {device}</span>)}</div></div> : null}
          </section>

          <section className="md:col-span-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">Pricing</h3>
            <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">Inventory Cost</label>
              <MoneyInput
                className="w-full rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-[#39FF14]"
                value={typeof formData.internalCost === 'number' ? formData.internalCost : undefined}
                onValueChange={(v) => setFormData(prev => ({ ...prev, internalCost: v == null ? undefined : Number(v || 0) }))}
                onKeyDown={handleEnterToSubmit}
                allowEmpty
                placeholder={formData.inventoryParentId ? 'Set by chosen variant' : '0.00'}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">Part Charged</label>
              <MoneyInput
                className="w-full bg-yellow-200 text-black border border-zinc-600 rounded px-3 py-2 text-sm focus:border-[#39FF14] focus:outline-none cursor-text appearance-none"
                value={Number(formData.partCost || 0)}
                onValueChange={(v) => setFormData(prev => ({ ...prev, partCost: Number(v || 0) }))}
                onKeyDown={handleEnterToSubmit}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">Labor Charged</label>
              <MoneyInput
                className="w-full bg-yellow-200 text-black border border-zinc-600 rounded px-3 py-2 text-sm focus:border-[#39FF14] focus:outline-none cursor-text appearance-none"
                value={Number(formData.laborCost || 0)}
                onValueChange={(v) => setFormData(prev => ({ ...prev, laborCost: Number(v || 0) }))}
                onKeyDown={handleEnterToSubmit}
                placeholder="0.00"
              />
            </div>
            </div>
            <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900/70 p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                <input type="checkbox" checked={!formData.warrantyExcluded && Number(formData.warrantyDays || 0) > 0} onChange={event => setFormData(current => ({ ...current, warrantyExcluded: !event.target.checked, warrantyDays: event.target.checked ? Number(current.warrantyDays || 90) : 0 }))} className="h-4 w-4 accent-[#39FF14]" />
                Add warranty
              </label>
              {!formData.warrantyExcluded && Number(formData.warrantyDays || 0) > 0 ? <div className="mt-3 grid gap-3 md:grid-cols-[180px_1fr]"><label className="text-sm text-zinc-300">Warranty coverage (days)<input type="number" min="1" step="1" value={Number(formData.warrantyDays || 90)} onChange={event => setFormData(current => ({ ...current, warrantyDays: Math.max(1, Number(event.target.value || 0)) }))} className="mt-1 w-full rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#39FF14]" /></label><p className="self-end text-xs text-zinc-500">Saved on the repair at completion. Existing completed repairs are never changed by later catalog edits.</p></div> : <p className="mt-2 text-xs text-zinc-500">No warranty is offered for this repair.</p>}
            </div>
            {formData.inventoryParentId ? <p className="mt-2 text-[11px] text-fuchsia-200">This is the default charge. A selected variant with its own selling price will replace it on the work order.</p> : null}
          </section>
        </div>
      </div>

      {partPickerOpen ? <PartInventoryPicker deviceModel={formData.model || ''} onSelect={selectInventoryPart} onClose={() => setPartPickerOpen(false)} /> : null}

      {/* Footer buttons */}
      {mode === 'admin' && (
        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-zinc-700">
          <button
            type="button"
            disabled={submitDisabled || !formData.id}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => submitPrimaryAction('update')}
          >
            Update Repair
          </button>
          <button
            type="button"
            disabled={submitDisabled}
            className="px-4 py-2 bg-[#39FF14] hover:bg-[#32E610] text-black font-semibold rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => submitPrimaryAction('create')}
          >
            Add New Repair
          </button>
        </div>
      )}
      {/* In workorder mode, do not show any admin controls */}
  {effectiveMode === 'workorder' && (
        <div style={{ display: 'none' }} />
      )}
      {(mode === 'workorder' || mode === 'workorderpicker') && (
        <div className="flex justify-end gap-2 mt-3 pt-3 border-t border-zinc-700">
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded text-sm focus:border-[#39FF14] focus:outline-none"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={clearFormFields}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded text-sm focus:border-[#39FF14] focus:outline-none"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={submitDisabled}
            className="px-4 py-2 bg-[#39FF14] hover:bg-[#32E610] text-black font-medium rounded text-sm focus:outline-none focus:ring-2 focus:ring-[#39FF14] focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => submitPrimaryAction('auto')}
          >
            Add to Work Order
          </button>
        </div>
      )}
    </div>
  );
}
