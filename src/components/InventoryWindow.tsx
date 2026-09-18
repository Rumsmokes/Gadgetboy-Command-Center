import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MoneyInput from './MoneyInput';
import PercentInput from './PercentInput';
import type { VendorRecord } from './VendorsWindow';
import { applyInventoryUrlAutofill, scrapePartUrl } from '../lib/partOrdering';
import { applyInventoryDefaults, normalizeInventoryDefaults, type InventoryDefaults } from '../lib/catalogDefaults';
import { resolveCanonicalVendor } from '../lib/vendorCatalog';
import { buildInventoryReorderPurchase, fillInventoryReorderUrl, inventoryIncomingQuantity, inventoryReorderQuantity, isInventoryLowStock } from '../lib/inventoryReorder';
import { consumeWindowPayload } from '../lib/windowPayload';
import { reconcilePaidSaleInventory } from '../lib/inventoryConsumption';
import QRCode from 'qrcode';
import { INVENTORY_LABEL_SIZES, inventoryItemNumber, inventoryLabelUrl, type InventoryLabelSizeId } from '../lib/inventoryLabels';
import { inventoryAggregateStock, inventoryHierarchyRows, inventoryParentId, inventoryVariantAttributes, isInventoryParent } from '../lib/inventoryVariants';
import { buildInventoryDeviceGroups } from '../lib/inventoryDeviceGroups';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { useContextMenu } from '../lib/useContextMenu';
import { duplicateInventoryVariant, findExactDeviceMatch, inventoryRowActions } from '../lib/inventoryNavigation';
import InventoryPriceReviewWindow from './InventoryPriceReviewWindow';

type InventoryMode = 'parts' | 'products';
type PartsView = 'all' | 'device';

type InventoryItem = {
  id?: number;
  cloudId?: string;
  itemDescription: string;
  itemType?: 'Product' | 'Part';
  category?: string;
  deviceModel?: string;
  associatedDevices?: string[];
  repairType?: string;
  partCategory?: string;
  condition?: string;
  price?: number;
  internalCost?: number;
  markupPct?: number | string;
  notes?: string;
  distributor?: string;
  vendorRelationship?: 'wholesale' | 'consignment';
  vendorSharePct?: number;
  vendorTaxExempt?: boolean;
  distributorSku?: string;
  reorderQty?: number;
  reorderUrlTemplate?: string;
  trackStock?: boolean;
  stockCount?: number;
  lowStockThreshold?: number;
  purchaseRestockKeys?: string[];
  isParentPart?: boolean;
  parentProductId?: number;
  variantAttributes?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
};

const DEVICE_CATEGORY_OPTIONS = ['Phone', 'Tablet', 'Laptop', 'Desktop', 'Game Console', 'TV', 'Audio', 'Drone', 'Accessory', 'Other'];
const PART_CATEGORY_OPTIONS = ['Screen', 'Battery', 'Charging Port', 'Camera', 'Speaker', 'Microphone', 'Buttons', 'Housing', 'Motherboard', 'Power Supply', 'Cable', 'Adhesive', 'Other'];
const PART_CONDITIONS = ['New', 'Used'];
const PRODUCT_CONDITIONS = ['New', 'Like New', 'Excellent', 'Good', 'Fair', 'Poor'];
const MARKUP_PRESETS = [5, 10, 15, 20, 25];
const DEFAULT_MARKUP_PCT = '5';

const INVENTORY_PREVIEW_PART: InventoryItem = {
  id: 99001,
  itemDescription: 'HDMI Port',
  itemType: 'Part',
  category: 'Game Console',
  repairType: 'Port Repair',
  deviceModel: 'PlayStation 5',
  associatedDevices: ['PlayStation 5', 'PlayStation 5 Slim', 'PlayStation 5 Pro'],
  partCategory: 'Charging Port',
  condition: 'New',
  internalCost: 8.5,
  markupPct: 10,
  price: 9.35,
  distributor: 'Console Parts Direct',
  distributorSku: 'GB-HDMI-PS5',
  reorderQty: 10,
  reorderUrlTemplate: 'https://example.com/ps5-hdmi-port',
  trackStock: true,
  stockCount: 10,
  lowStockThreshold: 3,
};

const INVENTORY_PREVIEW_PARENT: InventoryItem = {
  id: 99000,
  itemDescription: 'iPhone 7 Screen',
  itemType: 'Part',
  category: 'Phone',
  repairType: 'Screen Repair',
  partCategory: 'Screen',
  isParentPart: true,
  trackStock: false,
};

const INVENTORY_PREVIEW_VARIANTS: InventoryItem[] = [
  { ...INVENTORY_PREVIEW_PART, id: 99001, itemDescription: 'iPhone 7 Screen', category: 'Phone', repairType: 'Screen Repair', partCategory: 'Screen', parentProductId: 99000, variantAttributes: { Color: 'Black', Quality: 'Premium' }, distributorSku: 'IP7-SCR-BLK-P', stockCount: 5 },
  { ...INVENTORY_PREVIEW_PART, id: 99002, itemDescription: 'iPhone 7 Screen', category: 'Phone', repairType: 'Screen Repair', partCategory: 'Screen', parentProductId: 99000, variantAttributes: { Color: 'White', Quality: 'Standard' }, distributorSku: 'IP7-SCR-WHT-S', stockCount: 2 },
];

function blankItem(mode: InventoryMode): InventoryItem {
  return {
    itemDescription: '',
    itemType: mode === 'parts' ? 'Part' : 'Product',
    category: '',
    deviceModel: '',
    associatedDevices: [],
    repairType: '',
    partCategory: mode === 'parts' ? 'Screen' : '',
    condition: 'New',
    price: undefined,
    internalCost: undefined,
    markupPct: DEFAULT_MARKUP_PCT,
    notes: '',
    distributor: '',
    distributorSku: '',
    reorderQty: 1,
    reorderUrlTemplate: '',
    trackStock: true,
    stockCount: 0,
    lowStockThreshold: 1,
    isParentPart: false,
    variantAttributes: {},
  };
}

function money(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '-';
}

function markedUpPrice(cost: unknown, pct: unknown): number | undefined {
  const c = Number(cost);
  const p = Number(pct);
  if (!Number.isFinite(c) || c < 0 || !Number.isFinite(p) || p < 0) return undefined;
  return Math.round(c * (1 + p / 100) * 100) / 100;
}

function normalizeOrderUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export default function InventoryWindow() {
  const api = (window as any).api;
  const isInventoryPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get('inventoryPreview') === '1';
  const requestedInventoryIdRef = useRef<number | undefined>(undefined);
  const requestedInventoryIdInitializedRef = useRef(false);
  const skipNextModeResetRef = useRef(false);
  if (!requestedInventoryIdInitializedRef.current) {
    const modalPayload = consumeWindowPayload('inventory');
    const queryId = new URLSearchParams(window.location.search).get('inventoryId');
    const requested = Number(modalPayload?.inventoryId ?? queryId);
    requestedInventoryIdRef.current = Number.isFinite(requested) && requested > 0 ? requested : undefined;
    requestedInventoryIdInitializedRef.current = true;
  }
  const [mode, setMode] = useState<InventoryMode>('parts');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<any[]>([]);
  const [vendors, setVendors] = useState<VendorRecord[]>([]);
  const [deviceCategories, setDeviceCategories] = useState<any[]>([]);
  const [repairCategories, setRepairCategories] = useState<any[]>([]);
  const [repairTypes, setRepairTypes] = useState<any[]>([]);
  const [inventoryPartTypes, setInventoryPartTypes] = useState<string[]>(PART_CATEGORY_OPTIONS);
  const [inventoryDefaults, setInventoryDefaults] = useState<InventoryDefaults>(() => normalizeInventoryDefaults());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [deviceFilter, setDeviceFilter] = useState('');
  const [compatibleDeviceSearch, setCompatibleDeviceSearch] = useState('');
  const [compatibleDeviceMenuOpen, setCompatibleDeviceMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined);
  const [priceCheckIds, setPriceCheckIds] = useState<Set<number>>(() => new Set());
  const [priceReviewItems, setPriceReviewItems] = useState<InventoryItem[] | null>(null);
  const [expandedParentIds, setExpandedParentIds] = useState<Set<number>>(() => new Set());
  const [partsView, setPartsView] = useState<PartsView>('all');
  const [expandedDeviceGroups, setExpandedDeviceGroups] = useState<Set<string>>(() => new Set());
  const [expandedDeviceCategories, setExpandedDeviceCategories] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<InventoryItem>(() => blankItem('parts'));
  const [editingOrderUrl, setEditingOrderUrl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scrapingUrl, setScrapingUrl] = useState(false);
  const [showCartAdder, setShowCartAdder] = useState(false);
  const [cartQuantity, setCartQuantity] = useState(1);
  const [cartTotalCost, setCartTotalCost] = useState<number | undefined>(undefined);
  const [addingToCart, setAddingToCart] = useState(false);
  const [cartMessage, setCartMessage] = useState('');
  const [labelItem, setLabelItem] = useState<InventoryItem | null>(null);
  const [labelSizeId, setLabelSizeId] = useState<InventoryLabelSizeId>('2.25x1.25');
  const [labelQr, setLabelQr] = useState('');
  const inventoryContext = useContextMenu<InventoryItem>();
  const scrapeSequenceRef = useRef(0);
  const lastScrapedUrlRef = useRef('');

  useEffect(() => {
    if (!labelItem?.id) { setLabelQr(''); return; }
    let cancelled = false;
    const publicBase = String((import.meta as any).env?.VITE_PUBLIC_APP_URL || 'https://rumsmokes.github.io/Gadgetboy-Command-Center').replace(/\/$/, '');
    QRCode.toDataURL(inventoryLabelUrl(labelItem.id, publicBase, `${new URL(publicBase).pathname}/`), { width: 360, margin: 1, errorCorrectionLevel: 'M' })
      .then((value) => { if (!cancelled) setLabelQr(value); })
      .catch((error) => console.error('Inventory label QR generation failed', error));
    return () => { cancelled = true; };
  }, [labelItem]);

  const printInventoryLabel = () => {
    const size = INVENTORY_LABEL_SIZES.find((candidate) => candidate.id === labelSizeId) || INVENTORY_LABEL_SIZES[1];
    const style = document.createElement('style');
    style.textContent = `@page { size: ${size.widthIn}in ${size.heightIn}in; margin: 0; }`;
    document.head.appendChild(style);
    const cleanup = () => {
      document.body.classList.remove('gb-printing-inventory-label');
      style.remove();
    };
    document.body.classList.add('gb-printing-inventory-label');
    window.addEventListener('afterprint', cleanup, { once: true });
    try {
      window.print();
    } finally {
      // Electron fires afterprint; this fallback also restores the app if a
      // browser cancels printing without dispatching that event.
      window.setTimeout(cleanup, 500);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (isInventoryPreview) {
        skipNextModeResetRef.current = true;
        setItems([INVENTORY_PREVIEW_PARENT, ...INVENTORY_PREVIEW_VARIANTS]);
        setVendors([{ id: 99001, name: 'Console Parts Direct', inventoryMode: 'Part', relationship: 'wholesale', taxExempt: true } as VendorRecord]);
        setDeviceCategories([
          { id: 99001, title: 'Game Console', name: 'PlayStation 5' },
          { id: 99002, title: 'Game Console', name: 'PlayStation 5 Slim' },
          { id: 99003, title: 'Game Console', name: 'PlayStation 5 Pro' },
        ]);
        setRepairCategories([{ id: 99001, category: 'Game Console', repairCategory: 'Port Repair', title: 'HDMI Port Replacement' }]);
        setRepairTypes([{ id: 99001, name: 'Port Repair' }]);
        setSelectedId(INVENTORY_PREVIEW_PARENT.id);
        setEditing({ ...blankItem('parts'), ...INVENTORY_PREVIEW_PARENT });
        setEditingOrderUrl(false);
        return;
      }
      await reconcilePaidSaleInventory(api).catch((error) => {
        console.error('Paid-sale inventory reconciliation failed', error);
      });
      const [products, purchaseRows, vendorRows, deviceRows, repairRows, repairTypeRows, settingsRows] = await Promise.all([
        api?.dbGet?.('products').catch(() => []),
        api?.dbGet?.('purchaseOrders').catch(() => []),
        api?.dbGet?.('vendors').catch(() => []),
        api?.dbGet?.('deviceCategories').catch(() => []),
        api?.dbGet?.('repairCategories').catch(() => []),
        api?.dbGet?.('repairTypes').catch(() => []),
        api?.dbGet?.('settings').catch(() => []),
      ]);
      setItems(Array.isArray(products) ? products : []);
      setPurchaseOrders(Array.isArray(purchaseRows) ? purchaseRows : []);
      setVendors(Array.isArray(vendorRows) ? vendorRows : []);
      setDeviceCategories(Array.isArray(deviceRows) ? deviceRows : []);
      setRepairCategories(Array.isArray(repairRows) ? repairRows : []);
      setRepairTypes(Array.isArray(repairTypeRows) ? repairTypeRows : []);
      const settings = Array.isArray(settingsRows) ? settingsRows[0] : null;
      setInventoryPartTypes(Array.isArray(settings?.inventoryPartTypes) && settings.inventoryPartTypes.length ? settings.inventoryPartTypes : PART_CATEGORY_OPTIONS);
      setInventoryDefaults(normalizeInventoryDefaults(settings?.inventoryDefaults));
    } finally {
      setLoading(false);
    }
  }, [api, isInventoryPreview]);

  useEffect(() => {
    load();
    const off = api?.onProductsChanged?.(() => load());
    const offPurchases = api?.onPurchaseOrdersChanged?.(() => load());
    const offTypes = api?.onRepairTypesChanged?.(() => load());
    const offRepairs = api?.onRepairCategoriesChanged?.(() => load());
    const offSettings = api?.onSettingsChanged?.(() => load());
    return () => { try { off && off(); offPurchases && offPurchases(); offTypes && offTypes(); offRepairs && offRepairs(); offSettings && offSettings(); } catch {} };
  }, [api, load]);

  useEffect(() => {
    if (skipNextModeResetRef.current) {
      skipNextModeResetRef.current = false;
      return;
    }
    setSelectedId(undefined);
    setEditing(applyInventoryDefaults(blankItem(mode), inventoryDefaults));
    setSearch('');
    setDeviceFilter('');
    setFiltersOpen(false);
    setExpandedParentIds(new Set());
  }, [mode, inventoryDefaults]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((item) => (mode === 'parts' ? (item.itemType || 'Product') === 'Part' : (item.itemType || 'Product') !== 'Part'))
      .filter((item) => !lowOnly || isInventoryLowStock(item))
      .filter((item) => {
        if (!deviceFilter) return true;
        const devices = Array.isArray(item.associatedDevices) ? item.associatedDevices : [];
        return item.category === deviceFilter || devices.includes(deviceFilter);
      })
      .filter((item) => {
        if (!q) return true;
        return [
          item.itemDescription,
          item.category,
          item.deviceModel,
          ...(Array.isArray(item.associatedDevices) ? item.associatedDevices : []),
          item.repairType,
          item.partCategory,
          item.condition,
          item.distributor,
          item.distributorSku,
        ].some((value) => String(value || '').toLowerCase().includes(q));
      })
      .sort((a, b) => {
        const aGroup = inventoryParentId(a) || (isInventoryParent(a) ? Number(a.id || 0) : Number.MAX_SAFE_INTEGER);
        const bGroup = inventoryParentId(b) || (isInventoryParent(b) ? Number(b.id || 0) : Number.MAX_SAFE_INTEGER);
        return String(a.category || '').localeCompare(String(b.category || ''))
          || aGroup - bGroup
          || Number(isInventoryParent(b)) - Number(isInventoryParent(a))
          || String(a.itemDescription || '').localeCompare(String(b.itemDescription || ''));
      });
  }, [deviceFilter, items, lowOnly, mode, search]);

  const listedItems = useMemo(() => inventoryHierarchyRows(visibleItems, expandedParentIds), [expandedParentIds, visibleItems]);

  const deviceGroups = useMemo(() => buildInventoryDeviceGroups(visibleItems), [visibleItems]);
  const exactDeviceMatch = useMemo(() => findExactDeviceMatch(search, deviceGroups.map((group) => group.device)), [deviceGroups, search]);
  const displayedDeviceGroups = useMemo(() => exactDeviceMatch ? deviceGroups.filter((group) => group.device === exactDeviceMatch) : deviceGroups, [deviceGroups, exactDeviceMatch]);

  const counts = useMemo(() => {
    const parts = items.filter((item) => (item.itemType || 'Product') === 'Part');
    const products = items.filter((item) => (item.itemType || 'Product') !== 'Part');
    return {
      parts: parts.length,
      products: products.length,
      low: items.filter(isInventoryLowStock).length,
      tracked: items.filter((item) => item.trackStock).length,
      incoming: items.reduce((total, item) => total + inventoryIncomingQuantity(Number(item.id || 0), purchaseOrders), 0),
    };
  }, [items, purchaseOrders]);

  useEffect(() => {
    const requestedId = requestedInventoryIdRef.current;
    if (loading || !requestedId) return;
    const requestedItem = items.find((item) => Number(item.id) === requestedId);
    requestedInventoryIdRef.current = undefined;
    if (requestedItem) {
      const requestedMode: InventoryMode = (requestedItem.itemType || 'Product') === 'Part' ? 'parts' : 'products';
      if (requestedMode !== mode) skipNextModeResetRef.current = true;
      setMode(requestedMode);
      selectItem(requestedItem);
    }
  }, [items, loading, mode]);

  const visibleVendors = useMemo(() => vendors
    .filter((vendor) => (vendor.inventoryMode || 'Product') === (mode === 'parts' ? 'Part' : 'Product'))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))), [mode, vendors]);

  const deviceModels = useMemo(() => {
    const deviceType = String(editing.category || '').trim().toLowerCase();
    const models = deviceCategories
      .filter((row) => deviceType && String(row?.title || '').trim().toLowerCase() === deviceType)
      .map((row) => String(row?.name || '').trim())
      .filter(Boolean);
    repairCategories
      .filter((row) => String(row?.type || row?.category || '').trim().toLowerCase() === deviceType)
      .map((row) => String(row?.model || row?.deviceModel || '').trim())
      .filter(Boolean)
      .forEach((model) => models.push(model));
    items.forEach((item) => {
      if (String(item.category || '').trim().toLowerCase() === deviceType && String(item.deviceModel || '').trim()) {
        models.push(String(item.deviceModel).trim());
      }
    });
    (Array.isArray(editing.associatedDevices) ? editing.associatedDevices : []).forEach((model) => {
      if (String(model || '').trim()) models.push(String(model).trim());
    });
    return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
  }, [deviceCategories, editing.associatedDevices, editing.category, items, repairCategories]);

  const filteredDeviceModels = useMemo(() => {
    const query = compatibleDeviceSearch.trim().toLowerCase();
    return deviceModels.filter((model) => !query || model.toLowerCase().includes(query));
  }, [compatibleDeviceSearch, deviceModels]);

  const productTypeOptions = useMemo(() => Array.from(new Set([
    ...DEVICE_CATEGORY_OPTIONS,
    ...items
      .filter((item) => (item.itemType || 'Product') !== 'Part')
      .map((item) => String(item.category || '').trim())
      .filter(Boolean),
  ])).sort((a, b) => a.localeCompare(b)), [items]);

  const partDeviceCategoryOptions = useMemo(() => Array.from(new Set([
    ...DEVICE_CATEGORY_OPTIONS,
    ...deviceCategories.map((row) => String(row?.title || '').trim()).filter(Boolean),
    ...items
      .filter((item) => (item.itemType || 'Product') === 'Part')
      .map((item) => String(item.category || '').trim())
      .filter(Boolean),
  ])).sort((a, b) => a.localeCompare(b)), [deviceCategories, items]);

  const repairTypeOptions = useMemo(() => Array.from(new Set([
    ...repairTypes.map((row) => String(row?.name || '').trim()).filter(Boolean),
    ...repairCategories.map((row) => String(row?.repairCategory || '').trim()).filter(Boolean),
    ...items
      .filter((item) => (item.itemType || 'Product') === 'Part')
      .map((item) => String(item.repairType || '').trim())
      .filter(Boolean),
  ])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })), [items, repairCategories, repairTypes]);

  const selectItem = (item: InventoryItem) => {
    const associatedDevices = Array.from(new Set([
      ...(Array.isArray(item.associatedDevices) ? item.associatedDevices : []),
      item.deviceModel,
    ].map((value) => String(value || '').trim()).filter(Boolean)));
    setSelectedId(item.id);
    setEditing({ ...blankItem(mode), ...item, associatedDevices, markupPct: item.markupPct ?? DEFAULT_MARKUP_PCT });
    setEditingOrderUrl(!item.reorderUrlTemplate);
    lastScrapedUrlRef.current = String(item.reorderUrlTemplate || '');
    const quantity = Math.max(1, Math.round(Number(item.reorderQty || 1)));
    const unitCost = Number(item.internalCost);
    setShowCartAdder(false);
    setCartQuantity(quantity);
    setCartTotalCost(Number.isFinite(unitCost) ? unitCost * quantity : undefined);
    setCartMessage('');
    setCompatibleDeviceSearch('');
    setCompatibleDeviceMenuOpen(false);
  };

  const startNew = () => {
    setSelectedId(undefined);
    setEditing(applyInventoryDefaults(blankItem(mode), inventoryDefaults));
    setEditingOrderUrl(false);
    lastScrapedUrlRef.current = '';
    setShowCartAdder(false);
    setCartMessage('');
    setCompatibleDeviceSearch('');
    setCompatibleDeviceMenuOpen(false);
  };

  const startParentPart = () => {
    setMode('parts');
    setSelectedId(undefined);
    setEditing({ ...blankItem('parts'), isParentPart: true, trackStock: false, stockCount: undefined, lowStockThreshold: undefined });
    setEditingOrderUrl(false);
  };

  const startVariant = (parent: InventoryItem) => {
    setMode((parent.itemType || 'Product') === 'Part' ? 'parts' : 'products');
    setSelectedId(undefined);
    setEditing({
      ...blankItem((parent.itemType || 'Product') === 'Part' ? 'parts' : 'products'),
      itemType: parent.itemType,
      itemDescription: parent.itemDescription,
      category: parent.category,
      partCategory: parent.partCategory,
      repairType: parent.repairType,
      associatedDevices: parent.associatedDevices || [],
      deviceModel: parent.deviceModel,
      parentProductId: parent.id,
      isParentPart: false,
      variantAttributes: {},
    });
  };

  const duplicateVariant = () => {
    if (!selectedId || isInventoryParent(editing)) return;
    setSelectedId(undefined);
    setEditing({
      ...editing,
      id: undefined,
      distributorSku: '',
      stockCount: 0,
      purchaseRestockKeys: [],
      createdAt: undefined,
      updatedAt: undefined,
      variantAttributes: { ...inventoryVariantAttributes(editing) },
    });
  };

  const duplicateVariantItem = (item: InventoryItem) => {
    setMode((item.itemType || 'Product') === 'Part' ? 'parts' : 'products');
    setSelectedId(undefined);
    setEditing({ ...blankItem((item.itemType || 'Product') === 'Part' ? 'parts' : 'products'), ...duplicateInventoryVariant(item), purchaseRestockKeys: [], variantAttributes: { ...inventoryVariantAttributes(item) } });
  };

  const ensureVendor = async (nameValue: string) => {
    const name = nameValue.trim();
    if (!name) return;
    const inventoryMode = mode === 'parts' ? 'Part' : 'Product';
    const existing = vendors.find((vendor) => (vendor.inventoryMode || 'Product') === inventoryMode
      && String(vendor.name || '').trim().toLowerCase() === name.toLowerCase());
    if (existing) return;
    const now = new Date().toISOString();
    const saved = await api?.dbAdd?.('vendors', {
      name,
      inventoryMode,
      relationship: 'wholesale',
      taxExempt: false,
      createdAt: now,
      updatedAt: now,
    });
    if (saved) setVendors((current) => [...current, saved]);
  };

  const save = async (action: 'update' | 'create') => {
    if (action === 'update' && !selectedId) {
      alert(`Select a ${mode === 'parts' ? 'part' : 'product'} to update.`);
      return;
    }
    const description = String(editing.itemDescription || '').trim();
    if (!description) {
      alert(mode === 'parts' ? 'Part name is required.' : 'Product name is required.');
      return;
    }
    if (!String(editing.category || '').trim()) {
      alert(mode === 'parts' ? 'Device Category is required for repair parts.' : 'Product Type is required.');
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const associatedDevices = Array.from(new Set([
        ...(Array.isArray(editing.associatedDevices) ? editing.associatedDevices : []),
        editing.deviceModel,
      ].map((value) => String(value || '').trim()).filter(Boolean)));
      const payload: InventoryItem = {
        ...editing,
        id: action === 'update' ? selectedId : undefined,
        itemDescription: description,
        itemType: mode === 'parts' ? 'Part' : 'Product',
        category: String(editing.category || '').trim(),
        deviceModel: mode === 'parts' ? (associatedDevices[0] || '') : '',
        associatedDevices,
        repairType: mode === 'parts' ? String(editing.repairType || '').trim() : '',
        partCategory: mode === 'parts' ? (String(editing.partCategory || 'Other').trim() || 'Other') : '',
        condition: String(editing.condition || 'New').trim() || 'New',
        markupPct: editing.markupPct ?? DEFAULT_MARKUP_PCT,
        distributor: String(editing.distributor || '').trim(),
        distributorSku: String(editing.distributorSku || '').trim(),
        reorderUrlTemplate: normalizeOrderUrl(editing.reorderUrlTemplate),
        reorderQty: Math.max(1, Math.round(Number(editing.reorderQty || 1))),
        isParentPart: !!editing.isParentPart,
        parentProductId: editing.isParentPart ? undefined : inventoryParentId(editing),
        variantAttributes: editing.isParentPart ? {} : inventoryVariantAttributes(editing),
        trackStock: editing.isParentPart ? false : !!editing.trackStock,
        stockCount: !editing.isParentPart && editing.trackStock ? Math.max(0, Math.round(Number(editing.stockCount || 0))) : undefined,
        lowStockThreshold: !editing.isParentPart && editing.trackStock ? Math.max(0, Math.round(Number(editing.lowStockThreshold || 0))) : undefined,
        updatedAt: now,
      };

      const selectedVendor = vendors.find((vendor) =>
        (vendor.inventoryMode || 'Product') === (mode === 'parts' ? 'Part' : 'Product')
        && String(vendor.name || '').trim().toLowerCase() === String(payload.distributor || '').trim().toLowerCase());
      payload.vendorRelationship = selectedVendor?.relationship === 'consignment' ? 'consignment' : 'wholesale';
      payload.vendorSharePct = selectedVendor?.relationship === 'consignment' ? Number(selectedVendor.vendorSharePct || 0) : undefined;
      payload.vendorTaxExempt = !!selectedVendor?.taxExempt;

      await ensureVendor(payload.distributor || '');

      let saved: InventoryItem | undefined;
      if (action === 'update') {
        saved = await api?.update?.('products', payload);
      } else {
        const { id: _existingId, ...newListing } = payload;
        saved = await api?.dbAdd?.('products', { ...newListing, createdAt: now });
      }
      if (!saved?.id) throw new Error('Inventory save did not return a saved listing.');
      const merged = { ...payload, ...saved };
      setItems((current) => {
        const id = merged.id;
        if (!id) return current;
        const idx = current.findIndex((item) => item.id === id);
        if (idx === -1) return [...current, merged];
        const next = [...current];
        next[idx] = merged;
        return next;
      });
      setSelectedId(merged.id);
      setEditing(merged);
      setEditingOrderUrl(!merged.reorderUrlTemplate);
    } catch (err) {
      console.error('Inventory save failed', err);
      alert('Inventory item could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (target?: InventoryItem) => {
    const targetItem = target || (selectedId ? { ...editing, id: selectedId } : undefined);
    const targetId = targetItem?.id;
    if (!targetItem || !targetId) return;
    if (isInventoryParent(targetItem) && items.some((item) => inventoryParentId(item) === Number(targetId))) {
      alert('Remove or move its variants before deleting this parent part.');
      return;
    }
    if (targetItem.parentProductId && Object.keys(inventoryVariantAttributes(targetItem)).length === 0) {
      alert('Add at least one complete Variant Attribute, such as Color: Black.');
      return;
    }
    if (!confirm(mode === 'parts' ? 'Delete this repair part listing?' : 'Delete this product listing?')) return;
    setSaving(true);
    try {
      await api?.dbDelete?.('products', targetId);
      setItems((current) => current.filter((item) => item.id !== targetId));
      if (selectedId === targetId) startNew();
    } catch (err) {
      console.error('Inventory delete failed', err);
      alert('Inventory item could not be deleted.');
    } finally {
      setSaving(false);
    }
  };

  const inventoryContextItems = useMemo<ContextMenuItem[]>(() => {
    const item = inventoryContext.state.data;
    if (!item) return [];
    const parent = isInventoryParent(item);
    const parentId = Number(item.id || 0);
    const expanded = parent && expandedParentIds.has(parentId);
    return inventoryRowActions(parent ? 'parent' : 'variant', expanded).map((action): ContextMenuItem => {
      if (action === 'edit') return { label: parent ? 'Edit Parent Part' : 'Edit Variant', onClick: () => selectItem(item) };
      if (action === 'add-variant') return { label: 'Add Variant', onClick: () => startVariant(item) };
      if (action === 'expand' || action === 'collapse') return { label: action === 'expand' ? 'Expand Variants' : 'Collapse Variants', onClick: () => setExpandedParentIds((current) => { const next = new Set(current); if (action === 'expand') next.add(parentId); else next.delete(parentId); return next; }) };
      if (action === 'duplicate') return { label: 'Duplicate Variant', onClick: () => duplicateVariantItem(item) };
      if (action === 'print-label') return { label: 'Print Label', onClick: () => setLabelItem(item) };
      return { label: parent ? 'Delete Parent Part' : 'Delete Variant', danger: true, onClick: () => { void remove(item); } };
    });
  }, [expandedParentIds, inventoryContext.state.data, items, selectedId]);

  const adjustStock = async (item: InventoryItem, delta: number) => {
    const nextCount = Math.max(0, Math.round(Number(item.stockCount || 0) + delta));
    const updated = { ...item, trackStock: true, stockCount: nextCount, updatedAt: new Date().toISOString() };
    setItems((current) => current.map((row) => row.id === item.id ? updated : row));
    if (selectedId === item.id) setEditing(updated);
    try {
      await api?.update?.('products', updated);
    } catch (err) {
      console.error('Inventory stock update failed', err);
      load();
    }
  };

  const openReorder = async (item: InventoryItem) => {
    const template = String(item.reorderUrlTemplate || '').trim();
    if (!template) return;
    const url = fillInventoryReorderUrl(template, item);
    try { await api?.openUrl?.(url); } catch { window.open(url, '_blank', 'noopener,noreferrer'); }
  };

  const beginAddToCart = () => {
    const quantity = inventoryReorderQuantity(editing);
    const unitCost = Number(editing.internalCost);
    setCartQuantity(quantity);
    setCartTotalCost(Number.isFinite(unitCost) && unitCost >= 0 ? Math.round(unitCost * quantity * 100) / 100 : undefined);
    setCartMessage('');
    setShowCartAdder(true);
  };

  const addInventoryItemToCart = async () => {
    if (!selectedId) return;
    const title = String(editing.itemDescription || '').trim();
    const distributor = String(editing.distributor || '').trim();
    const quantity = Math.max(1, Math.round(Number(cartQuantity || 1)));
    const totalCost = Number(cartTotalCost);
    if (!title || !distributor || !Number.isFinite(totalCost) || totalCost < 0) {
      setCartMessage('A title, distributor, quantity, and full supplier cost are required.');
      return;
    }
    setAddingToCart(true);
    setCartMessage('');
    try {
      const existing = await api?.dbGet?.('purchaseOrders').catch(() => []);
      if (Array.isArray(existing) && existing.some((row: any) => row?.status === 'pending' && row?.sourceType === 'inventory' && Number(row?.inventoryId) === Number(selectedId))) {
        setCartMessage('This inventory item is already waiting in the EOD purchasing cart.');
        return;
      }
      const now = new Date().toISOString();
      const payload = buildInventoryReorderPurchase({ ...editing, id: selectedId, itemType: mode === 'parts' ? 'Part' : 'Product', internalCost: totalCost / quantity, reorderQty: quantity }, now);
      await api?.dbAdd?.('purchaseOrders', payload);
      setCartMessage(`Added ${quantity} to the EOD purchasing cart.`);
      setShowCartAdder(false);
    } catch (err) {
      console.error('Inventory add to purchasing cart failed', err);
      setCartMessage('This item could not be added to the purchasing cart.');
    } finally {
      setAddingToCart(false);
    }
  };

  const autofillFromOrderUrl = useCallback(async (url: string) => {
    if (!url || lastScrapedUrlRef.current === url) return;
    const sequence = ++scrapeSequenceRef.current;
    lastScrapedUrlRef.current = url;
    setEditing((current) => applyInventoryUrlAutofill(current, null, url));
    setScrapingUrl(true);
    try {
      const meta = await scrapePartUrl(url);
      if (sequence !== scrapeSequenceRef.current) return;
      if (!meta?.ok && !meta?.title && typeof meta?.price !== 'number' && !meta?.vendor) return;
      setEditing((current) => { const filled = applyInventoryUrlAutofill(current, meta, url); const canonical = resolveCanonicalVendor(filled.distributor, vendors); return canonical ? { ...filled, distributor: canonical.name } : filled; });
    } catch (err) {
      console.error('Inventory URL autofill failed', err);
    } finally {
      if (sequence === scrapeSequenceRef.current) setScrapingUrl(false);
    }
  }, [vendors]);

  const modeLabel = mode === 'parts' ? 'Repair Parts' : 'Products';
  const categoryOptions = mode === 'parts' ? partDeviceCategoryOptions : productTypeOptions;
  const conditionOptions = mode === 'parts' ? inventoryDefaults.conditions : PRODUCT_CONDITIONS;

  return (
    <div className="h-screen bg-zinc-900 text-gray-100 overflow-hidden">
      {priceReviewItems ? <InventoryPriceReviewWindow items={priceReviewItems} onClose={() => setPriceReviewItems(null)} onApproved={() => void load()} /> : null}
      <div className="flex h-full flex-col">
        <header className="shrink-0 border-b border-zinc-700 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold tracking-wide">Inventory</h1>
              <div className="text-xs text-zinc-400">{counts.tracked} tracked items, {counts.low} low-stock alerts, {counts.incoming} incoming</div>
            </div>
            <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setPriceReviewItems(items.filter(item => !isInventoryParent(item) && Boolean(String(item.reorderUrlTemplate || '').trim())))} className="rounded-lg bg-[#39FF14] px-4 py-2 text-sm font-black text-black">Check All Prices</button><button type="button" disabled={!priceCheckIds.size} onClick={() => setPriceReviewItems(items.filter(item => item.id && priceCheckIds.has(item.id)))} className="rounded-lg border border-[#39FF14] px-4 py-2 text-sm font-bold text-[#39FF14] disabled:opacity-40">Check Selected</button><button type="button" onClick={() => api?.openCatalogSettings ? void api.openCatalogSettings('inventory') : undefined} className="rounded-lg border border-purple-400/70 bg-purple-500/10 px-4 py-2 text-sm font-bold text-purple-200 hover:bg-purple-500/20">⚙ Inventory Settings</button></div>
          </div>
        </header>

        <main className="gb-inventory-layout grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-[minmax(400px,38%)_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[minmax(460px,36%)_minmax(0,1fr)]">
          <section className="gb-inventory-list-pane flex min-h-[320px] flex-col overflow-hidden rounded border border-zinc-700 bg-zinc-950">
            <div className="shrink-0 border-b border-zinc-800 p-3">
              {mode === 'parts' ? <div className="mb-2 grid grid-cols-2 rounded border border-zinc-700 bg-zinc-900 p-1" role="group" aria-label="Parts inventory view">
                <button type="button" aria-pressed={partsView === 'all'} onClick={() => setPartsView('all')} className={`rounded px-3 py-1.5 text-xs font-bold ${partsView === 'all' ? 'bg-[#BC13FE] text-white' : 'text-zinc-400'}`}>All Parts</button>
                <button type="button" aria-pressed={partsView === 'device'} onClick={() => setPartsView('device')} className={`rounded px-3 py-1.5 text-xs font-bold ${partsView === 'device' ? 'bg-[#39FF14] text-black' : 'text-zinc-400'}`}>By Device</button>
              </div> : null}
              <div className="relative flex flex-wrap gap-2">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={`Search ${modeLabel.toLowerCase()}...`}
                  className="min-w-[180px] flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                />
                <button
                  type="button"
                  onClick={() => setFiltersOpen((open) => !open)}
                  className={`rounded border px-3 py-2 text-sm ${filtersOpen || lowOnly || deviceFilter ? 'border-[#BC13FE] bg-[#BC13FE]/20 text-white' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`}
                  aria-label="Open inventory filters"
                  aria-expanded={filtersOpen}
                >
                  ☰
                </button>
                <button
                  type="button"
                  onClick={() => setLowOnly((current) => !current)}
                  className={`rounded border px-3 py-2 text-sm ${lowOnly ? 'border-red-500 bg-red-950 text-red-200' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`}
                >
                  Low Stock
                </button>
                {mode === 'parts' ? <button type="button" onClick={startParentPart} className="rounded border border-[#39FF14] bg-[#39FF14]/10 px-3 py-2 text-sm font-semibold text-[#39FF14]">Create Parent Part</button> : null}
                {filtersOpen ? (
                  <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded border border-zinc-700 bg-zinc-950 p-3 shadow-xl">
                    <label className="block">
                      <span className="mb-1 block text-xs text-zinc-400">{mode === 'parts' ? 'Device Category' : 'Product Type'}</span>
                      <select
                        value={deviceFilter}
                        onChange={(event) => setDeviceFilter(event.target.value)}
                        className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                      >
                        <option value="">{mode === 'parts' ? 'All device categories' : 'All product types'}</option>
                        {categoryOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setLowOnly(false);
                        setDeviceFilter('');
                      }}
                      className="mt-3 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm hover:border-[#39FF14]"
                    >
                      Clear Filters
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <div className="p-4 text-sm text-zinc-400">Loading...</div>
              ) : visibleItems.length === 0 ? (
                <div className="p-4 text-sm text-zinc-500">No {modeLabel.toLowerCase()} found.</div>
              ) : (
                mode === 'parts' && partsView === 'device' ? <div className="divide-y divide-zinc-800" aria-label="Parts grouped by compatible device">
                  {displayedDeviceGroups.map((group) => {
                    const deviceOpen = search.trim() ? true : expandedDeviceGroups.has(group.device);
                    return <section key={group.device}>
                      <button type="button" aria-expanded={deviceOpen} onClick={() => setExpandedDeviceGroups(current => { const next = new Set(current); if (deviceOpen) next.delete(group.device); else next.add(group.device); return next; })} className="flex w-full items-center justify-between gap-3 bg-zinc-900 px-3 py-3 text-left font-bold hover:bg-zinc-800"><span className="truncate">{group.device}</span><span className="flex items-center gap-2 text-xs text-zinc-400"><span>{group.categories.reduce((count, category) => count + category.items.length, 0)} parts</span><span aria-hidden="true">{deviceOpen ? '−' : '+'}</span></span></button>
                      {deviceOpen ? <div className="border-t border-zinc-800 bg-zinc-950">{group.categories.map((category) => {
                        const categoryKey = `${group.device}::${category.category}`;
                        const categoryOpen = search.trim() ? true : expandedDeviceCategories.has(categoryKey);
                        const rows = inventoryHierarchyRows(category.items, expandedParentIds);
                        return <section key={categoryKey} className="border-b border-zinc-800 last:border-b-0">
                          <button type="button" aria-expanded={categoryOpen} onClick={() => setExpandedDeviceCategories(current => { const next = new Set(current); if (categoryOpen) next.delete(categoryKey); else next.add(categoryKey); return next; })} className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm font-semibold text-fuchsia-200 hover:bg-zinc-900"><span>{category.category}</span><span className="text-xs text-zinc-500">{category.items.length} · {categoryOpen ? '−' : '+'}</span></button>
                          {categoryOpen ? <div className="divide-y divide-zinc-800/70">{rows.map(item => { const parent = isInventoryParent(item); const parentId = Number(item.id || 0); const expanded = parent && expandedParentIds.has(parentId); const low = !parent && isInventoryLowStock(item); const incoming = parent ? items.filter(candidate => inventoryParentId(candidate) === parentId).reduce((sum, candidate) => sum + inventoryIncomingQuantity(Number(candidate.id || 0), purchaseOrders), 0) : inventoryIncomingQuantity(Number(item.id || 0), purchaseOrders); return <div key={`${group.device}-${category.category}-${item.id}`} onClick={() => selectItem(item)} onContextMenu={(event) => inventoryContext.openFromEvent(event, item)} className={`cursor-pointer border-l-4 px-4 py-2 ${inventoryParentId(item) ? 'pl-9' : ''} ${selectedId === item.id ? 'bg-zinc-800' : 'hover:bg-zinc-900'} ${low ? 'border-red-500' : parent ? 'border-[#39FF14]' : 'border-transparent'}`}><div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2">{parent ? <button type="button" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} variants for ${item.itemDescription || 'parent part'}`} onClick={event => { event.stopPropagation(); setExpandedParentIds(current => { const next = new Set(current); if (expanded) next.delete(parentId); else next.add(parentId); return next; }); }} className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-700">{expanded ? '−' : '+'}</button> : null}<strong className="truncate">{item.itemDescription || '(unnamed)'}</strong>{parent ? <span className="rounded bg-[#39FF14]/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-[#39FF14]">Parent</span> : null}</div><div className="mt-1 text-[11px] text-zinc-500">{item.condition || 'New'} · {item.distributorSku || 'No SKU'}</div></div><div className="shrink-0 text-right"><div className="text-xs font-bold">{parent ? inventoryAggregateStock(items, parentId) : item.trackStock ? item.stockCount ?? 0 : '—'} on hand</div>{incoming > 0 ? <div className="text-[11px] font-semibold text-sky-300">+{incoming} incoming</div> : null}<div className="text-xs text-zinc-400">{money(item.price)}</div></div></div></div>; })}</div> : null}
                        </section>;
                      })}</div> : null}
                    </section>;
                  })}
                </div> : <div className="divide-y divide-zinc-800">
                  {listedItems.map((item) => {
                    const parent = isInventoryParent(item);
                    const parentId = Number(item.id || 0);
                    const expanded = parent && expandedParentIds.has(parentId);
                    const low = !parent && isInventoryLowStock(item);
                    const selected = selectedId === item.id;
                    const devices = Array.isArray(item.associatedDevices) ? item.associatedDevices : [];
                    const attributes = inventoryVariantAttributes(item);
                    return (
                      <div
                        key={item.id}
                        onClick={() => selectItem(item)}
                        onContextMenu={(event) => inventoryContext.openFromEvent(event, item)}
                        className={`w-full border-l-4 px-3 py-2 text-left transition ${inventoryParentId(item) ? 'pl-7' : ''} ${selected ? 'bg-zinc-800' : 'hover:bg-zinc-900'} ${low ? 'border-red-500' : parent ? 'border-[#39FF14]' : 'border-transparent'}`}
                      >
                        <div className="grid grid-cols-[minmax(0,1fr)_58px] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_72px_58px_auto]">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              {!parent && item.id ? <input type="checkbox" aria-label={`Select ${item.itemDescription || 'inventory item'} for price check`} checked={priceCheckIds.has(item.id)} onClick={event => event.stopPropagation()} onChange={event => setPriceCheckIds(current => { const next = new Set(current); if (event.target.checked) next.add(Number(item.id)); else next.delete(Number(item.id)); return next; })} /> : null}
                              {parent ? <button type="button" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} variants for ${item.itemDescription || 'parent part'}`} onClick={(event) => { event.stopPropagation(); setExpandedParentIds((current) => { const next = new Set(current); if (expanded) next.delete(parentId); else next.add(parentId); return next; }); }} className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-700 text-xs text-zinc-300 hover:border-[#39FF14] hover:text-[#39FF14]">{expanded ? '−' : '+'}</button> : null}
                              <div className="truncate font-semibold text-zinc-100">{item.itemDescription || '(unnamed)'}</div>{parent ? <span className="shrink-0 rounded bg-[#39FF14]/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-[#39FF14]">Parent</span> : null}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-zinc-400">
                              <span>{item.category || 'Other'}</span>
                              {devices.length ? <span>- {devices.slice(0, 2).join(', ')}{devices.length > 2 ? ` +${devices.length - 2}` : ''}</span> : null}
                              {mode === 'parts' && item.repairType ? <span>• {item.repairType}</span> : null}
                              {mode === 'parts' ? <span>• {item.partCategory || 'Part'}</span> : null}
                              <span>• {item.condition || 'New'}</span>
                              {item.distributor ? <span>• {item.distributor}</span> : null}
                              {Object.entries(attributes).map(([key, value]) => <span key={key}>• {key}: {value}</span>)}
                            </div>
                          </div>
                          <div className="hidden text-right sm:block">
                            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Price</div>
                            <div className="font-mono text-sm font-semibold text-zinc-100">{money(item.price)}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] uppercase tracking-wide text-zinc-500">On Hand</div>
                            <div className={`font-mono text-sm font-semibold ${low ? 'text-red-300' : 'text-zinc-200'}`}>
                              {parent && item.id ? inventoryAggregateStock(items, item.id) : item.trackStock ? (item.stockCount ?? 0) : '-'}
                            </div>
                            {(() => { const incoming = parent && item.id ? items.filter(candidate => inventoryParentId(candidate) === Number(item.id)).reduce((sum, candidate) => sum + inventoryIncomingQuantity(Number(candidate.id || 0), purchaseOrders), 0) : inventoryIncomingQuantity(Number(item.id || 0), purchaseOrders); return incoming > 0 ? <div className="text-[11px] font-semibold text-sky-300">+{incoming} incoming</div> : null; })()}
                          </div>
                          {parent ? <button type="button" onClick={(event) => { event.stopPropagation(); startVariant(item); }} className="col-span-2 rounded border border-[#BC13FE]/70 bg-[#BC13FE]/10 px-2 py-1.5 text-[11px] font-semibold text-fuchsia-200 hover:bg-[#BC13FE]/20 sm:col-span-1">Add Variant</button> : <button type="button" onClick={(event) => { event.stopPropagation(); setLabelItem(item); }} className="col-span-2 rounded border border-[#39FF14]/70 bg-[#39FF14]/10 px-2 py-1.5 text-[11px] font-semibold text-[#39FF14] hover:bg-[#39FF14]/20 sm:col-span-1">Print Label</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="gb-inventory-form-pane min-w-0 rounded border border-zinc-700 bg-zinc-950 p-4 lg:overflow-y-auto xl:p-5">
            <div className="mb-4 flex flex-col gap-3 border-b border-zinc-800 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">{editing.isParentPart ? (selectedId ? 'Edit Parent Part' : 'Create Parent Part') : selectedId ? `Edit ${mode === 'parts' ? 'Repair Part' : 'Product'}` : `Add ${mode === 'parts' ? 'Repair Part' : 'Product'}`}</h2>
                <div className="text-xs text-zinc-500">Saved here syncs through the Products collection.</div>
                {editing.isParentPart ? <div className="mt-1 text-xs text-[#39FF14]">Parent parts organize variants and are never sold or deducted.</div> : null}
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
                <div className="gb-inventory-mode-toggle grid w-full grid-cols-2 rounded border border-zinc-700 bg-zinc-900 p-1 sm:w-[260px]" role="group" aria-label="Inventory section">
                  <button
                    type="button"
                    onClick={() => setMode('products')}
                    aria-pressed={mode === 'products'}
                    className={`rounded px-3 py-2 text-sm font-semibold transition ${mode === 'products' ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'}`}
                  >
                    Products ({counts.products})
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('parts')}
                    aria-pressed={mode === 'parts'}
                    className={`rounded px-3 py-2 text-sm font-semibold transition ${mode === 'parts' ? 'bg-[#BC13FE] text-white' : 'text-zinc-400 hover:text-white'}`}
                  >
                    Parts ({counts.parts})
                  </button>
                </div>
                {selectedId && !editing.isParentPart ? <button type="button" disabled={!String(editing.reorderUrlTemplate || '').trim()} onClick={() => setPriceReviewItems([{ ...editing, id: selectedId }])} className="w-full rounded-lg border border-blue-400/70 px-3 py-2 text-xs font-bold text-blue-200 disabled:opacity-40">Check Price</button> : null}
                {mode === 'parts' && selectedId ? <div className="flex w-full gap-2 sm:w-auto"><button type="button" onClick={() => api?.openRepairCategories?.({ inventoryPart: { ...editing, id: selectedId }, linkMode: 'existing' })} className="flex-1 rounded-lg border border-purple-400/70 bg-purple-500/10 px-3 py-2 text-xs font-bold text-purple-200">Link to Repair</button><button type="button" onClick={() => api?.openRepairCategories?.({ inventoryPart: { ...editing, id: selectedId }, linkMode: 'new' })} className="flex-1 rounded-lg bg-purple-500 px-3 py-2 text-xs font-bold text-white">New Linked Repair</button></div> : null}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="md:col-span-2 rounded-xl border border-purple-400/30 bg-purple-500/5 px-4 py-3"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-purple-500 text-xs font-black">1</span><strong>Identify and source the item</strong><span className="ml-2 text-xs text-zinc-500">Name, URL, vendor, and parent family</span></div>
              {!editing.isParentPart ? <div className="rounded border border-[#BC13FE]/40 bg-[#BC13FE]/5 p-3 md:col-span-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-fuchsia-200">Move to Parent</span>
                  <select value={editing.parentProductId || ''} onChange={(event) => setEditing((current) => ({ ...current, parentProductId: event.target.value ? Number(event.target.value) : undefined }))} className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#BC13FE]">
                    <option value="">Standalone inventory item</option>
                    {items.filter((item) => isInventoryParent(item) && item.itemType === editing.itemType).map((parent) => <option key={parent.id} value={parent.id}>{parent.itemDescription}</option>)}
                  </select>
                </label>
                {editing.parentProductId ? <div className="mt-3">
                  <div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-semibold text-zinc-200">Variant Attributes</span><button type="button" onClick={() => setEditing((current) => ({ ...current, variantAttributes: { ...inventoryVariantAttributes(current), '': '' } }))} className="rounded border border-zinc-600 px-2 py-1 text-xs">Add Attribute</button></div>
                  <div className="space-y-2">
                    {Object.entries(editing.variantAttributes || {}).map(([name, value], index) => <div key={`variant-attribute-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                      <input aria-label={`Variant attribute ${index + 1} name`} value={name} placeholder="Color" onChange={(event) => setEditing((current) => { const entries = Object.entries(current.variantAttributes || {}); entries[index] = [event.target.value, entries[index]?.[1] || '']; return { ...current, variantAttributes: Object.fromEntries(entries) }; })} className="min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm" />
                      <input aria-label={`Variant attribute ${index + 1} value`} value={value} placeholder="Black" onChange={(event) => setEditing((current) => { const entries = Object.entries(current.variantAttributes || {}); entries[index] = [entries[index]?.[0] || '', event.target.value]; return { ...current, variantAttributes: Object.fromEntries(entries) }; })} className="min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm" />
                      <button type="button" aria-label={`Remove variant attribute ${index + 1}`} onClick={() => setEditing((current) => ({ ...current, variantAttributes: Object.fromEntries(Object.entries(current.variantAttributes || {}).filter((_, rowIndex) => rowIndex !== index)) }))} className="rounded border border-red-800 px-2 text-red-200">×</button>
                    </div>)}
                    {!Object.keys(editing.variantAttributes || {}).length ? <button type="button" onClick={() => setEditing((current) => ({ ...current, variantAttributes: { Color: '' } }))} className="w-full rounded border border-dashed border-zinc-600 px-3 py-2 text-left text-xs text-zinc-400">Add Color, Quality, Connector, Position, or another attribute…</button> : null}
                  </div>
                </div> : null}
              </div> : null}
              <div className="block md:col-span-2">
                <span className="mb-1 block text-xs text-zinc-400">Order URL {scrapingUrl && <span className="text-[#39FF14]">· Looking up details…</span>}</span>
                {editing.reorderUrlTemplate && !editingOrderUrl ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => openReorder(editing)} className="rounded border border-red-500 bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500">Order URL</button>
                    <button type="button" onClick={() => setEditingOrderUrl(true)} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">Edit</button>
                    <button type="button" onClick={() => { setEditing((current) => ({ ...current, reorderUrlTemplate: '' })); setEditingOrderUrl(true); lastScrapedUrlRef.current = ''; }} className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-100">Clear URL</button>
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-500" title={editing.reorderUrlTemplate}>{editing.reorderUrlTemplate}</span>
                  </div>
                ) : (
                  <input
                    value={editing.reorderUrlTemplate || ''}
                    onChange={(event) => setEditing((current) => ({ ...current, reorderUrlTemplate: event.target.value }))}
                    onBlur={() => { const url = normalizeOrderUrl(editing.reorderUrlTemplate); if (url) { setEditing((current) => ({ ...current, reorderUrlTemplate: url })); setEditingOrderUrl(false); void autofillFromOrderUrl(url); } }}
                    onKeyDown={(event) => { if (event.key !== 'Enter') return; const url = normalizeOrderUrl(editing.reorderUrlTemplate); if (!url) return; event.preventDefault(); setEditing((current) => ({ ...current, reorderUrlTemplate: url })); setEditingOrderUrl(false); void autofillFromOrderUrl(url); }}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                    placeholder="Paste the distributor product URL"
                  />
                )}
                {selectedId && String(editing.distributor || '').trim() && Number(editing.internalCost) > 0 && String(editing.condition || '').toLowerCase() !== 'used' ? (
                  <div className="mt-3 rounded border border-zinc-700 bg-zinc-900/80 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-white">Restock this listing</div>
                        <div className="text-xs text-zinc-400">Adds a pending supplier purchase. Stock changes only after verified checkout.</div>
                      </div>
                      {!showCartAdder ? <button type="button" onClick={beginAddToCart} className="rounded bg-[#39FF14] px-4 py-2 text-sm font-semibold text-black">Add to Cart</button> : null}
                    </div>
                    {showCartAdder ? (
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(100px,0.45fr)_minmax(150px,1fr)_auto] sm:items-end">
                        <label className="block">
                          <span className="mb-1 block text-xs text-zinc-400">Quantity</span>
                          <input type="number" min="1" step="1" value={cartQuantity} onChange={(event) => {
                            const nextQuantity = Math.max(1, Math.round(Number(event.target.value || 1)));
                            const previousQuantity = Math.max(1, cartQuantity);
                            setCartQuantity(nextQuantity);
                            if (cartTotalCost != null) setCartTotalCost(Math.round((cartTotalCost / previousQuantity) * nextQuantity * 100) / 100);
                          }} className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-[#39FF14]" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-zinc-400">Full Supplier Cost</span>
                          <MoneyInput value={cartTotalCost} onValueChange={(value) => setCartTotalCost(value == null ? undefined : Number(value))} allowEmpty className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-[#39FF14]" />
                        </label>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => setShowCartAdder(false)} className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm">Cancel</button>
                          <button type="button" onClick={addInventoryItemToCart} disabled={addingToCart} className="rounded bg-[#39FF14] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">{addingToCart ? 'Adding...' : 'Add to Cart'}</button>
                        </div>
                      </div>
                    ) : null}
                    {cartMessage ? <div className={`mt-2 text-xs ${cartMessage.startsWith('Added') ? 'text-[#39FF14]' : 'text-red-300'}`}>{cartMessage}</div> : null}
                  </div>
                ) : null}
              </div>

              <label className="block md:col-span-2 md:mx-auto md:w-[72%]">
                <span className="mb-1 block text-center text-xs text-zinc-400">Vendor / Distributor{mode === 'parts' && String(editing.condition || '').toLowerCase() === 'used' ? ' (Optional for Used Parts)' : ''}</span>
                <input
                  list={`inventory-vendors-${mode}`}
                  value={editing.distributor || ''}
                  onChange={(event) => setEditing((current) => ({ ...current, distributor: event.target.value }))}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-center text-sm outline-none focus:border-[#39FF14]"
                  placeholder={mode === 'parts' ? 'Select or enter a parts distributor' : 'Select or enter a product vendor'}
                />
                <datalist id={`inventory-vendors-${mode}`}>
                  {visibleVendors.map((vendor) => <option key={`${vendor.id}-${vendor.name}`} value={vendor.name} />)}
                </datalist>
                <span className="mt-1 block text-center text-[11px] text-zinc-500">{mode === 'parts' && String(editing.condition || '').toLowerCase() === 'used' ? 'Used parts pulled from another device do not require a distributor.' : `New names are saved to the ${mode === 'parts' ? 'Parts' : 'Products'} vendor list when this listing is saved.`}</span>
              </label>

              <label className="block md:col-span-2">
                <span className="mb-1 block text-xs text-zinc-400">{mode === 'parts' ? 'Part Name' : 'Product Name'}</span>
                <input
                  value={editing.itemDescription || ''}
                  onChange={(event) => setEditing((current) => ({ ...current, itemDescription: event.target.value }))}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                  placeholder={mode === 'parts' ? 'iPhone 14 Digi/LCD Assembly' : 'iPhone 14 Pro 256GB'}
                />
              </label>

              <div className="md:col-span-2 mt-1 rounded-xl border border-blue-400/30 bg-blue-500/5 px-4 py-3"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-xs font-black">2</span><strong>Categorize compatibility</strong><span className="ml-2 text-xs text-zinc-500">Device, compatible models, and physical part type</span></div>
              <div className="grid min-w-0 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">{mode === 'parts' ? 'Device Category' : 'Product Type'}</span>
                  <input
                    list="inventory-device-types"
                    value={editing.category || ''}
                    onChange={(event) => setEditing((current) => mode === 'parts'
                      ? { ...current, category: event.target.value, associatedDevices: [], deviceModel: '' }
                      : { ...current, category: event.target.value })}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                  />
                </label>
                {mode === 'parts' ? (
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-400">Linked Repair Service (optional)</span>
                    <input
                      list="inventory-repair-types"
                      value={editing.repairType || ''}
                      onChange={(event) => setEditing((current) => ({ ...current, repairType: event.target.value }))}
                      className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                      placeholder="Select the repair this part supports"
                    />
                    <datalist id="inventory-repair-types">
                      {repairTypeOptions.map((value) => <option key={value} value={value} />)}
                    </datalist>
                    <span className="mt-1 block text-[11px] text-zinc-500">This helps automatic work-order matching; it does not categorize the physical part.</span>
                  </label>
                ) : null}
              </div>
              <datalist id="inventory-device-types">
                {categoryOptions.map((value) => <option key={value} value={value} />)}
              </datalist>

              {mode === 'parts' ? (
                <div className="block">
                  <span className="mb-1 block text-xs text-zinc-400">Compatible Devices</span>
                  <div className="relative">
                    <input
                      type="search"
                      value={compatibleDeviceSearch}
                      onChange={(event) => { setCompatibleDeviceSearch(event.target.value); setCompatibleDeviceMenuOpen(true); }}
                      onFocus={() => setCompatibleDeviceMenuOpen(true)}
                      onBlur={() => window.setTimeout(() => setCompatibleDeviceMenuOpen(false), 120)}
                      disabled={!editing.category || deviceModels.length === 0}
                      className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 focus:border-[#39FF14]"
                      placeholder="Search and select compatible devices"
                      role="combobox"
                      aria-expanded={compatibleDeviceMenuOpen}
                      aria-label="Search compatible devices"
                    />
                    {compatibleDeviceMenuOpen && editing.category && deviceModels.length > 0 ? (
                      <div className="absolute z-30 mt-1 max-h-48 w-full overflow-y-auto rounded border border-zinc-600 bg-zinc-950 p-1 shadow-xl">
                        {filteredDeviceModels.length ? filteredDeviceModels.map((model) => {
                          const selected = (editing.associatedDevices || []).includes(model);
                          return (
                            <button
                              type="button"
                              key={model}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => setEditing((current) => {
                                const existing = Array.isArray(current.associatedDevices) ? current.associatedDevices : [];
                                const associatedDevices = existing.includes(model) ? existing.filter((value) => value !== model) : [...existing, model];
                                return { ...current, associatedDevices, deviceModel: associatedDevices[0] || '' };
                              })}
                              className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${selected ? 'bg-[#BC13FE]/20 text-white' : 'text-zinc-300 hover:bg-zinc-800'}`}
                            >
                              <span className="truncate">{model}</span><span aria-hidden="true">{selected ? '✓' : ''}</span>
                            </button>
                          );
                        }) : <div className="px-3 py-2 text-sm text-zinc-500">No matching devices.</div>}
                      </div>
                    ) : null}
                  </div>
                  {(editing.associatedDevices || []).length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(editing.associatedDevices || []).map((model) => (
                        <button type="button" key={model} onClick={() => setEditing((current) => {
                          const associatedDevices = (current.associatedDevices || []).filter((value) => value !== model);
                          return { ...current, associatedDevices, deviceModel: associatedDevices[0] || '' };
                        })} className="rounded border border-[#BC13FE]/60 bg-[#BC13FE]/15 px-2 py-1 text-xs text-zinc-100" title={`Remove ${model}`}>
                          {model} ×
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <span className="mt-1 block text-[11px] text-zinc-500">
                    {!editing.category ? 'Select a device category first.' : deviceModels.length === 0 ? 'No devices are saved for this category yet.' : 'Select one or more devices, then save the part.'}
                  </span>
                </div>
              ) : null}

              {mode === 'parts' ? (
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">Part Type</span>
                  <input
                    list="inventory-part-types"
                    value={editing.partCategory || ''}
                    onChange={(event) => setEditing((current) => ({ ...current, partCategory: event.target.value }))}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                  />
                  <datalist id="inventory-part-types">
                    {inventoryPartTypes.map((value) => <option key={value} value={value} />)}
                  </datalist>
                </label>
              ) : (
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">Condition</span>
                  <select
                    value={editing.condition || 'New'}
                    onChange={(event) => setEditing((current) => ({ ...current, condition: event.target.value }))}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                  >
                    {conditionOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              )}

              {mode === 'parts' ? (
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">Condition</span>
                  <select
                    value={editing.condition || 'New'}
                    onChange={(event) => setEditing((current) => ({ ...current, condition: event.target.value }))}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                  >
                    {conditionOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              ) : null}

              <div className="md:col-span-2 mt-1 rounded-xl border border-amber-400/30 bg-amber-500/5 px-4 py-3"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-xs font-black text-black">3</span><strong>Set pricing</strong><span className="ml-2 text-xs text-zinc-500">Cost, markup, and selling price</span></div>
              <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">Cost{mode === 'parts' && String(editing.condition || '').toLowerCase() === 'used' ? ' (Optional for Used Parts)' : ''}</span>
                <MoneyInput
                  value={typeof editing.internalCost === 'number' ? editing.internalCost : undefined}
                  onValueChange={(value) => setEditing((current) => {
                    const internalCost = value == null ? undefined : Number(value || 0);
                    const price = internalCost == null ? current.price : markedUpPrice(internalCost, current.markupPct ?? DEFAULT_MARKUP_PCT);
                    return { ...current, internalCost, ...(price == null ? {} : { price }) };
                  })}
                  allowEmpty
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                />
                {mode === 'parts' && String(editing.condition || '').toLowerCase() === 'used' ? <span className="mt-1 block text-[11px] text-zinc-500">Leave blank for a reclaimed part. Costless items are excluded from supplier checkout.</span> : null}
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-zinc-400">Markup %</span>
                <PercentInput
                  value={editing.markupPct ?? DEFAULT_MARKUP_PCT}
                  onChange={(value) => setEditing((current) => {
                    const markupPct = value || DEFAULT_MARKUP_PCT;
                    const price = markedUpPrice(current.internalCost, markupPct);
                    return { ...current, markupPct, ...(price == null ? {} : { price }) };
                  })}
                  presets={MARKUP_PRESETS}
                  className="w-full rounded border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                />
              </label>

              <label className="block md:col-span-2">
                <span className="mb-1 block text-xs text-zinc-400">{mode === 'parts' ? 'Part Sold Price' : 'Sale Price'}</span>
                <MoneyInput
                  value={typeof editing.price === 'number' ? editing.price : undefined}
                  onValueChange={(value) => setEditing((current) => ({ ...current, price: value == null ? undefined : Number(value || 0) }))}
                  allowEmpty
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                />
              </label>

              <div className="md:col-span-2 mt-1 rounded-xl border border-[#39FF14]/30 bg-[#39FF14]/5 px-4 py-3"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#39FF14] text-xs font-black text-black">4</span><strong>Track and reorder</strong><span className="ml-2 text-xs text-zinc-500">Stock, alerts, SKU, MOQ, and notes</span></div>
              <div className="rounded border border-zinc-800 bg-zinc-900 p-3 md:col-span-2">
                <label className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={!!editing.trackStock}
                    disabled={!!editing.isParentPart}
                    onChange={(event) => setEditing((current) => ({ ...current, trackStock: event.target.checked }))}
                    className="accent-[#39FF14]"
                  />
                  Track stock
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-400">On Hand</span>
                    <input
                      type="number"
                      min="0"
                      value={editing.stockCount ?? ''}
                      disabled={!editing.trackStock || !!editing.isParentPart}
                      onChange={(event) => setEditing((current) => ({ ...current, stockCount: event.target.value === '' ? undefined : Number(event.target.value) }))}
                      className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none disabled:opacity-50 focus:border-[#39FF14]"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-400">Incoming</span>
                    <input type="number" value={selectedId ? inventoryIncomingQuantity(selectedId, purchaseOrders) : 0} readOnly className="w-full rounded border border-sky-800 bg-sky-950/30 px-3 py-2 text-sm text-sky-200 outline-none" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-400">Low Alert At</span>
                    <input
                      type="number"
                      min="0"
                      value={editing.lowStockThreshold ?? ''}
                      disabled={!editing.trackStock || !!editing.isParentPart}
                      onChange={(event) => setEditing((current) => ({ ...current, lowStockThreshold: event.target.value === '' ? undefined : Number(event.target.value) }))}
                      className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none disabled:opacity-50 focus:border-[#39FF14]"
                    />
                  </label>
                </div>
                {selectedId && !editing.isParentPart ? (
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => adjustStock(editing, -1)} className="rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm">-1</button>
                    <button type="button" onClick={() => adjustStock(editing, 1)} className="rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm">+1</button>
                  </div>
                ) : null}
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-zinc-400">SKU</span>
                <input
                  value={editing.distributorSku || ''}
                  onChange={(event) => setEditing((current) => ({ ...current, distributorSku: event.target.value }))}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-zinc-400">MOQ / Reorder Qty</span>
                <input
                  type="number"
                  min="1"
                  value={editing.reorderQty ?? 1}
                  onChange={(event) => setEditing((current) => ({ ...current, reorderQty: event.target.value === '' ? 1 : Number(event.target.value) }))}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                />
                <span className="mt-1 block text-[11px] text-zinc-500">Quantity added to the EOD cart when this item reaches its low-stock threshold.</span>
              </label>

              <label className="block md:col-span-2">
                <span className="mb-1 block text-xs text-zinc-400">Notes</span>
                <textarea
                  value={editing.notes || ''}
                  onChange={(event) => setEditing((current) => ({ ...current, notes: event.target.value }))}
                  className="min-h-[88px] w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-[#39FF14]"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {selectedId && editing.isParentPart ? <button type="button" onClick={() => startVariant({ ...editing, id: selectedId })} className="rounded border border-[#BC13FE] bg-[#BC13FE]/10 px-4 py-2 text-sm font-semibold text-fuchsia-200">Add Variant</button> : null}
              {selectedId && !editing.isParentPart ? <button type="button" onClick={duplicateVariant} className="rounded border border-[#BC13FE] bg-[#BC13FE]/10 px-4 py-2 text-sm font-semibold text-fuchsia-200">Duplicate Variant</button> : null}
              {selectedId && !editing.isParentPart ? <button type="button" onClick={() => setLabelItem({ ...editing, id: selectedId })} className="rounded border border-[#39FF14] bg-[#39FF14]/10 px-4 py-2 text-sm font-semibold text-[#39FF14]">Print Label</button> : null}
              <button type="button" onClick={() => { void remove(); }} disabled={!selectedId || saving} className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-100 disabled:opacity-40">Delete</button>
              <button type="button" onClick={() => save('update')} disabled={!selectedId || saving} className="rounded border border-blue-500 bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
                {saving ? 'Saving...' : editing.isParentPart ? 'Update Parent Part' : `Update ${mode === 'parts' ? 'Part' : 'Product'}`}
              </button>
              <button type="button" onClick={() => save('create')} disabled={saving} className="rounded bg-[#39FF14] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">
                {saving ? 'Saving...' : editing.isParentPart ? 'Create Parent Part' : `Add New ${mode === 'parts' ? 'Part' : 'Product'}`}
              </button>
            </div>
          </section>
        </main>
        {labelItem ? (() => {
          const size = INVENTORY_LABEL_SIZES.find((candidate) => candidate.id === labelSizeId) || INVENTORY_LABEL_SIZES[1];
          return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Inventory label preview">
            <div className="w-full max-w-xl rounded-xl border border-zinc-600 bg-zinc-900 p-4 shadow-2xl">
              <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="text-lg font-bold">Inventory Label Preview</h2><p className="text-xs text-zinc-400">Choose the loaded label size. Select the thermal printer in the system print dialog.</p></div><button type="button" onClick={() => setLabelItem(null)} className="rounded border border-zinc-600 px-3 py-2">Close</button></div>
              <label className="mb-4 block text-sm"><span className="mb-1 block text-xs text-zinc-400">Label paper size</span><select value={labelSizeId} onChange={(event) => setLabelSizeId(event.target.value as InventoryLabelSizeId)} className="w-full rounded border border-zinc-600 bg-zinc-950 px-3 py-2">{INVENTORY_LABEL_SIZES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
              <div className="overflow-auto rounded-lg bg-zinc-800 p-6"><div className="gb-inventory-label-print mx-auto grid bg-white p-[0.08in] text-black shadow-xl" style={{ width: `${size.widthIn}in`, height: `${size.heightIn}in`, gridTemplateColumns: 'minmax(0,1fr) auto', gap: '0.06in', overflow: 'hidden' }}><div className="min-w-0 self-center"><div className="line-clamp-3 text-[11pt] font-black leading-tight">{labelItem.itemDescription || 'Inventory Item'}</div><div className="mt-1 text-[7pt] font-semibold uppercase tracking-wide">SKU / Item #</div><div className="break-all font-mono text-[8pt] font-bold">{inventoryItemNumber(labelItem)}</div></div>{labelQr ? <img src={labelQr} alt="Inventory item QR code" className="h-full max-h-[0.92in] w-auto self-center" /> : <div className="self-center text-[8pt]">Creating QR…</div>}</div></div>
              <button type="button" onClick={printInventoryLabel} disabled={!labelQr} className="mt-4 w-full rounded bg-[#39FF14] px-4 py-3 font-bold text-black disabled:opacity-40">Print Label</button>
            </div>
          </div>;
        })() : null}
        <ContextMenu open={inventoryContext.state.open} x={inventoryContext.state.x} y={inventoryContext.state.y} items={inventoryContextItems} onClose={inventoryContext.close} id="inventory-row-context-menu" zIndex={90} />
      </div>
    </div>
  );
}
