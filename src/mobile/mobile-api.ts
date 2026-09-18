import { supabase } from '../lib/supabase';
import { dispatchOpenModal } from '../lib/modalBus';
import { storeWindowPayload } from '../lib/windowPayload';
import { extractPartMetadataFromHtml, extractPartMetadataFromReader, normalizePartOrderUrl, derivePartVendorFromUrl } from '../lib/partOrdering';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getCloudEmailStatus, sendCloudEmail } from '../lib/cloudEmail';
import { preserveNewerWorkflow } from '../lib/workorderWorkflowSync';
import { cursorAfterRows, isRowAfterCursor, mergeIncrementalRows, type CloudCursor } from '../lib/incrementalSync';

type SortOptions = { limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' };
type CloudSession = {
  shopId: string;
  accessToken: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
};

const CLOUD_TABLE_BY_KEY: Record<string, string> = {
  customers: 'customers',
  workOrders: 'work_orders',
  sales: 'sales',
  calendarEvents: 'calendar_events',
  calendarNotes: 'calendar_notes',
  feedbackEntries: 'feedback_entries',
  deviceCategories: 'device_categories',
  productCategories: 'product_categories',
  products: 'products',
  repairCategories: 'repair_categories',
  repairItems: 'repair_items',
  partSources: 'part_sources',
  intakeSources: 'intake_sources',
  suppliers: 'suppliers',
  vendors: 'vendors',
  invoices: 'invoices',
  payments: 'payments',
  purchaseOrders: 'purchase_orders',
  timeEntries: 'time_entries',
  quotes: 'quotes',
  settings: 'shop_settings',
  preferences: 'preferences',
  systemLogs: 'system_logs',
  technicians: 'staff_profiles',
};

const COLLECTION_CHANGED_EVENT: Record<string, string> = {
  workOrders: 'workorders:changed',
  customers: 'customers:changed',
  sales: 'sales:changed',
  quotes: 'quotes:changed',
  technicians: 'technicians:changed',
  deviceCategories: 'deviceCategories:changed',
  productCategories: 'productCategories:changed',
  products: 'products:changed',
  purchaseOrders: 'purchaseOrders:changed',
  partSources: 'partSources:changed',
  calendarEvents: 'calendarEvents:changed',
  calendarNotes: 'calendarNotes:changed',
  feedbackEntries: 'feedbackEntries:changed',
  timeEntries: 'timeEntries:changed',
  notifications: 'notifications:changed',
  notificationSettings: 'notificationSettings:changed',
  settings: 'settings:changed',
  repairTypes: 'repairTypes:changed',
  repairCategories: 'repairCategories:changed',
};

const API_TO_MODAL: Record<string, string> = {
  openNewWorkOrder: 'newWorkOrder',
  openWorkOrder: 'newWorkOrder',
  openNewSale: 'newSale',
  openCalendar: 'calendar',
  openClockIn: 'clockIn',
  openQuoteGenerator: 'quoteGenerator',
  openEod: 'eod',
  openProducts: 'products',
  openInventory: 'inventory',
  openCatalogSettings: 'catalogSettings',
  openWorkOrderRepairPicker: 'workOrderRepairPicker',
  openCustomerOverview: 'customerOverview',
  openQuickSale: 'quickSale',
  openConsultation: 'consultation',
  openCheckout: 'checkout',
  openDevMenu: 'devMenu',
  openDataTools: 'dataTools',
  openReporting: 'reporting',
  openReportEmail: 'reportEmail',
  openCharts: 'charts',
  openNotifications: 'notifications',
  openNotificationSettings: 'notificationSettings',
  openReleaseForm: 'releaseForm',
  openCustomerReceipt: 'customerReceipt',
  openConsultSheet: 'consultSheet',
  openProductForm: 'productForm',
  openBackup: 'backup',
  openRepairCategories: 'repairCategories',
  openDeviceCategories: 'deviceCategories',
  openClearDatabase: 'clearDb',
  openCustomBuildItem: 'customBuildItem',
};

let cloudSession: CloudSession | null = null;
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
const listeners = new Map<string, Set<(payload?: any) => void>>();
const localFallback = new Map<string, any[]>();
const pendingQueueKey = 'gbpos-mobile-pending-sync';
const mobileSyncStateKey = 'gbpos-mobile-sync-state:v1';
const mobileBatchInfoKey = 'gbpos-mobile-batch-info:v1';

function mobileLocalDateKey(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function mobileBatchDayKey(now: Date, cutoffTime?: string) {
  const [hourText = '21', minuteText = '00'] = String(cutoffTime || '21:00').split(':');
  const cutoff = new Date(now);
  cutoff.setHours(Math.min(23, Math.max(0, Number(hourText) || 0)), Math.min(59, Math.max(0, Number(minuteText) || 0)), 0, 0);
  if (now < cutoff) cutoff.setDate(cutoff.getDate() - 1);
  return mobileLocalDateKey(cutoff);
}

function readMobileBatchInfo() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(mobileBatchInfoKey) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function recordMobileBatchOut(batchOutTime?: string) {
  const now = new Date();
  const info = {
    ok: true,
    lastBatchOutDate: now.toISOString(),
    lastBatchOutDayKey: mobileBatchDayKey(now, batchOutTime),
  };
  try { window.localStorage.setItem(mobileBatchInfoKey, JSON.stringify(info)); } catch {}
  return info;
}

function ensureMobileBatchOut() {
  const settings = readLocalList('eodSettings')[0] || {};
  const cutoffTime = settings.batchOutTime || settings.sendTime || '21:00';
  const dueDayKey = mobileBatchDayKey(new Date(), cutoffTime);
  const current = readMobileBatchInfo();
  return current.lastBatchOutDayKey === dueDayKey ? { ok: true, ...current } : recordMobileBatchOut(cutoffTime);
}

function normalizeCloudId(row: any): number | string | null {
  const rawLegacy = row?.legacy_id;
  if (rawLegacy !== null && typeof rawLegacy !== 'undefined' && String(rawLegacy).trim()) {
    const numericLegacy = Number(rawLegacy);
    return Number.isFinite(numericLegacy) ? numericLegacy : String(rawLegacy);
  }
  return row?.id || null;
}

function cloudDate(v: any): string | undefined {
  return v ? String(v) : undefined;
}

function cloudNumber(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cloudNullableNumber(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function cloudArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

function cloudObject(v: any): any {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function toCloudIntId(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toCloudTextId(v: any): string | null {
  if (v === null || typeof v === 'undefined') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function toCloudString(v: any): string {
  if (v === null || typeof v === 'undefined') return '';
  return String(v);
}

function calendarRequestStatus(value: any): 'pending' | 'approved' | 'declined' | null {
  const status = String(value || '').trim().toLowerCase();
  return status === 'pending' || status === 'approved' || status === 'declined' ? status : null;
}

function toCloudIso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toCloudDateOnly(v: any): string | null {
  const iso = toCloudIso(v);
  if (iso) return iso.slice(0, 10);
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function toCloudNumber(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toCloudMoney(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function toCloudBool(v: any): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function toCloudNullableBool(v: any): boolean | null {
  if (v === null || typeof v === 'undefined' || v === '') return null;
  return toCloudBool(v);
}

function toCloudArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

function toCloudObject(v: any): any {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function toCloudPayload(v: any): any {
  if (v && typeof v === 'object') return v;
  return { value: v };
}

function getWorkOrderActivityAt(it: any): string {
  if (!it || typeof it !== 'object') return '';
  return String(it.activityAt || it.checkoutDate || it.repairCompletionDate || it.clientPickupDate || it.checkInAt || it.createdAt || '');
}

function stableActivityValue(value: any): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value ?? '');
  }
}

function computeWorkOrderActivityAt(previous: any, next: any, updatedAt: string): string {
  if (next?.activityAt) return String(next.activityAt);
  const existingActivityAt = getWorkOrderActivityAt(previous);
  if (!previous || typeof previous !== 'object' || !previous?.id) {
    return getWorkOrderActivityAt({ ...next, activityAt: updatedAt }) || updatedAt;
  }
  const keys = ['amountPaid', 'payments', 'paymentHistory', 'paymentLogs'];
  const changed = keys.some((key) => stableActivityValue(previous?.[key]) !== stableActivityValue(next?.[key]));
  return changed ? updatedAt : (existingActivityAt || getWorkOrderActivityAt(next) || updatedAt);
}

function fromCloudRow(key: string, row: any, extra?: any): any {
  const id = normalizeCloudId(row);
  if (key === 'customers') {
    return {
      id,
      firstName: row.first_name || '',
      lastName: row.last_name || '',
      email: row.email || '',
      phone: row.phone || '',
      phoneAlt: row.phone_alt || '',
      declinedPhone: !!row.declined_phone,
      declinedEmail: !!row.declined_email,
      zip: row.zip || '',
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'workOrders') {
    return {
      id,
      customerId: cloudNullableNumber(row.legacy_customer_id),
      addonSaleId: cloudNullableNumber(row.legacy_addon_sale_id),
      status: row.status || '',
      assignedTo: row.assigned_to || '',
      checkInAt: cloudDate(row.check_in_at),
      repairCompletionDate: cloudDate(row.repair_completion_date),
      checkoutDate: cloudDate(row.checkout_date),
      productCategory: row.product_category || '',
      productDescription: row.product_description || '',
      model: row.model || '',
      serial: row.serial || '',
      intakeSource: row.intake_source || '',
      problemInfo: row.problem_info || '',
      workOrderType: row.work_order_type || '',
      diagnosticSelection: cloudObject(row.diagnostic_selection),
      durantFullTransfer: !!row.durant_full_transfer,
      partsOrdered: !!row.parts_ordered,
      partsDates: row.parts_dates || '',
      partsOrderUrl: row.parts_order_url || '',
      partsTrackingUrl: row.parts_tracking_url || '',
      partsOrderDate: cloudDate(row.parts_order_date),
      partsEstimatedDelivery: cloudDate(row.parts_estimated_delivery),
      partsEstDelivery: cloudDate(row.parts_est_delivery),
      discount: cloudNumber(row.discount),
      discountType: row.discount_type || '',
      discountPctValue: cloudNullableNumber(row.discount_pct_value),
      amountPaid: cloudNumber(row.amount_paid),
      taxRate: cloudNumber(row.tax_rate),
      laborCost: cloudNumber(row.labor_cost),
      partCosts: cloudNumber(row.part_costs),
      paymentType: row.payment_type || '',
      totals: cloudObject(row.totals),
      items: cloudArray(row.items),
      payments: cloudArray(row.payments),
      internalNotes: row.internal_notes || '',
      internalNotesLog: cloudArray(row.internal_notes_log),
      statusUpdate: row.status_update || '',
      statusUpdatedAt: cloudDate(row.status_updated_at),
      repairStatus: row.repair_status || '',
      estimatedDate: row.estimated_date || '',
      techNotes: row.tech_notes || '',
      lastUpdateNote: row.last_update_note || '',
      lastUpdateAt: cloudDate(row.last_update_at),
      pickupReadyAt: cloudDate(row.pickup_ready_at),
      scheduledPickupAt: cloudDate(row.scheduled_pickup_at),
      pickupReminderSentAt: cloudDate(row.pickup_reminder_sent_at),
      pickedUpAt: cloudDate(row.picked_up_at),
      pickedUpBy: row.picked_up_by || '',
      workflowStage: row.workflow_stage || '',
      workflowUpdatedAt: cloudDate(row.workflow_updated_at),
      diagnosisStartedAt: cloudDate(row.diagnosis_started_at),
      testingStartedAt: cloudDate(row.testing_started_at),
      lastTechnicianActivityAt: cloudDate(row.last_technician_activity_at),
      promisedAt: cloudDate(row.promised_at),
      promiseNote: row.promise_note || '',
      partEta: row.part_eta || '',
      clientDecision: row.client_decision || '',
      clientDecisionAt: cloudDate(row.client_decision_at),
      patternSequence: cloudArray(row.pattern_sequence),
      droneChecklist: cloudObject(row.drone_checklist),
      dropoffAccessories: cloudArray(row.dropoff_accessories),
      activityAt: cloudDate(row.activity_at),
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate([row.legacy_updated_at, row.updated_at, row.workflow_updated_at].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0]),
      cloudId: row.id,
    };
  }
  if (key === 'sales') {
    return {
      id,
      customerId: cloudNullableNumber(row.legacy_customer_id),
      customerName: row.customer_name || '',
      customerPhone: row.customer_phone || '',
      customerEmail: row.customer_email || '',
      status: row.status || '',
      assignedTo: row.assigned_to || '',
      category: row.category || '',
      itemDescription: row.item_description || '',
      condition: row.condition || '',
      intakeSource: row.intake_source || '',
      notes: row.notes || '',
      inStock: row.in_stock,
      quantity: cloudNullableNumber(row.quantity),
      price: cloudNullableNumber(row.price),
      total: cloudNullableNumber(row.total),
      discount: cloudNumber(row.discount),
      discountType: row.discount_type || '',
      discountPctValue: cloudNullableNumber(row.discount_pct_value),
      amountPaid: cloudNumber(row.amount_paid),
      taxRate: cloudNumber(row.tax_rate),
      laborCost: cloudNumber(row.labor_cost),
      partCosts: cloudNumber(row.part_costs),
      paymentType: row.payment_type || '',
      orderedDate: cloudDate(row.ordered_date),
      estimatedDeliveryDate: cloudDate(row.estimated_delivery_date),
      checkInAt: cloudDate(row.check_in_at),
      repairCompletionDate: cloudDate(row.repair_completion_date),
      checkoutDate: cloudDate(row.checkout_date),
      clientPickupDate: cloudDate(row.client_pickup_date),
      partsOrderUrl: row.parts_order_url || '',
      partsTrackingUrl: row.parts_tracking_url || '',
      consultationHours: cloudNullableNumber(row.consultation_hours),
      consultationType: row.consultation_type || '',
      consultationAddress: row.consultation_address || '',
      driverFee: cloudNullableNumber(row.driver_fee),
      appointmentDate: row.appointment_date || '',
      appointmentTime: row.appointment_time || '',
      appointmentEndTime: row.appointment_end_time || '',
      items: cloudArray(row.items),
      payments: cloudArray(row.payments),
      totals: cloudObject(row.totals),
      statusUpdate: row.status_update || '',
      statusUpdatedAt: cloudDate(row.status_updated_at),
      estimatedDate: row.estimated_date || '',
      techNotes: row.tech_notes || '',
      lastUpdateNote: row.last_update_note || '',
      lastUpdateAt: cloudDate(row.last_update_at),
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'quotes') {
    const payload = cloudObject(row.payload);
    return {
      ...payload,
      id,
      customerId: cloudNullableNumber(row.legacy_customer_id) ?? payload.customerId,
      customerName: row.customer_name || payload.customerName || '',
      customerPhone: row.customer_phone || payload.customerPhone || '',
      customerEmail: row.customer_email || payload.customerEmail || '',
      type: row.quote_type || payload.type || 'sales',
      createdAt: cloudDate(row.legacy_created_at || payload.createdAt || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || payload.updatedAt || row.updated_at),
      contentUpdatedAt: cloudDate(row.content_updated_at || payload.contentUpdatedAt || row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'calendarEvents') {
    return {
      id,
      customerId: cloudNullableNumber(row.legacy_customer_id),
      workOrderId: cloudNullableNumber(row.legacy_work_order_id),
      saleId: cloudNullableNumber(row.legacy_sale_id),
      date: row.event_date || '',
      title: row.title || '',
      time: row.event_time || '',
      endTime: row.end_time || '',
      category: row.category || '',
      location: row.location || '',
      customerName: row.customer_name || '',
      customerPhone: row.customer_phone || '',
      technician: row.technician || '',
      notes: row.notes || '',
      partName: row.part_name || '',
      source: row.source || '',
      requestStatus: row.request_status || undefined,
      shiftRequestOff: row.shift_request_off === true,
      requestedAt: cloudDate(row.requested_at),
      reviewedAt: cloudDate(row.reviewed_at),
      orderUrl: row.order_url || '',
      trackingUrl: row.tracking_url || '',
      partsStatus: row.parts_status || '',
      consultationType: row.consultation_type || '',
      taskCompleted: row.task_completed === true,
      taskCompletedAt: cloudDate(row.task_completed_at),
      taskCompletedBy: row.task_completed_by || '',
      recurrenceRule: row.recurrence_rule && typeof row.recurrence_rule === 'object' ? row.recurrence_rule : null,
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'calendarNotes') {
    return {
      id: row.legacy_id || row.id,
      date: row.note_date || '',
      subject: row.subject || '',
      body: row.body || '',
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'feedbackEntries') {
    return {
      id: row.legacy_id || row.id,
      subject: row.subject || '',
      body: row.body || '',
      completed: !!row.completed,
      completedAt: cloudDate(row.completed_at),
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'deviceCategories' || key === 'productCategories') {
    return {
      id,
      name: row.name || '',
      title: row.title || row.name || '',
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'products') {
    return {
      id,
      itemDescription: row.item_description || '',
      itemType: row.item_type || 'Product',
      deviceModel: row.device_model || '',
      price: cloudNumber(row.price),
      internalCost: cloudNumber(row.internal_cost),
      markupPct: cloudNumber(row.markup_pct),
      notes: row.notes || '',
      condition: row.condition || '',
      category: row.category || '',
      repairType: row.repair_type || '',
      partCategory: row.part_category || '',
      distributor: row.distributor || '',
      vendorRelationship: row.vendor_relationship || 'wholesale',
      vendorSharePct: cloudNullableNumber(row.vendor_share_pct),
      vendorTaxExempt: !!row.vendor_tax_exempt,
      distributorSku: row.distributor_sku || '',
      reorderQty: cloudNumber(row.reorder_qty) || 1,
      reorderUrlTemplate: row.reorder_url_template || '',
      associatedDevices: Array.isArray(row.associated_devices) ? row.associated_devices : [],
      trackStock: !!row.track_stock,
      stockCount: cloudNumber(row.stock_count),
      lowStockThreshold: cloudNumber(row.low_stock_threshold),
      purchaseRestockKeys: Array.isArray(row.purchase_restock_keys) ? row.purchase_restock_keys.map(String) : [],
      inventoryConsumptionKeys: Array.isArray(row.inventory_consumption_keys) ? row.inventory_consumption_keys.map(String) : [],
      isParentPart: !!row.is_parent_part,
      parentProductId: cloudNumber(row.parent_product_legacy_id),
      variantAttributes: cloudObject(row.variant_attributes),
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'repairCategories') {
    return {
      id,
      category: row.category || '',
      repairCategory: row.repair_category || '',
      title: row.title || '',
      altDescription: row.alt_description || '',
      partCost: cloudNumber(row.part_cost),
      laborCost: cloudNumber(row.labor_cost),
      internalCost: cloudNumber(row.internal_cost),
      markupPct: cloudNumber(row.markup_pct),
      orderDate: row.order_date || '',
      estDelivery: row.est_delivery || '',
      partSource: row.part_source || '',
      orderSourceUrl: row.order_source_url || '',
      tutorialUrl: row.tutorial_url || '',
      tutorialMediaType: row.tutorial_media_type || '',
      tutorialUpdatedAt: cloudDate(row.tutorial_updated_at),
      type: row.type || '',
      model: row.model || '',
      trackStock: !!row.track_stock,
      inventoryProductId: cloudNumber(row.inventory_product_id),
      inventoryParentId: cloudNumber(row.inventory_parent_legacy_id),
      repairFamily: row.repair_family || '',
      serviceKey: row.service_key || '',
      compatibleDevices: Array.isArray(row.compatible_devices) ? row.compatible_devices.map(String) : [],
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'timeEntries') {
    return {
      ...(cloudObject(row.payload)),
      id,
      technicianId: row.legacy_technician_id || cloudObject(row.payload).technicianId,
      clockIn: cloudDate(row.clock_in_at),
      clockOut: cloudDate(row.clock_out_at),
      createdAt: cloudDate(row.created_at),
      updatedAt: cloudDate(row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'settings') {
    return {
      ...(cloudObject(row.payload)),
      id,
      shopAddress: row.shop_address || cloudObject(row.payload).shopAddress || '',
      shopLat: cloudNullableNumber(row.shop_lat),
      shopLng: cloudNullableNumber(row.shop_lng),
      createdAt: cloudDate(row.legacy_created_at || row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
    };
  }
  if (key === 'technicians') {
    const credential = extra?.credentialsByStaffId?.get(String(row.id)) || extra?.credentialsByLegacyId?.get(String(row.legacy_id || '')) || {};
    return {
      id: row.legacy_id || row.id,
      legacyId: row.legacy_id || '',
      firstName: row.first_name || '',
      lastName: row.last_name || '',
      nickname: row.nickname || '',
      phone: row.phone || '',
      email: row.email || '',
      profileIcon: row.profile_icon || '',
      passcode: credential.legacy_passcode || '',
      schedule: cloudObject(row.schedule),
      role: row.role || 'technician',
      status: row.status || 'active',
      createdAt: cloudDate(row.created_at),
      updatedAt: cloudDate(row.legacy_updated_at || row.updated_at),
      cloudId: row.id,
      isLoginProfile: !row.legacy_id,
    };
  }
  return {
    ...(cloudObject(row.payload || row.value)),
    id,
    name: row.name || cloudObject(row.payload).name,
    createdAt: cloudDate(row.created_at),
    updatedAt: cloudDate(row.updated_at),
    cloudId: row.id,
  };
}

function hasScheduleValue(schedule: any): boolean {
  return !!schedule && typeof schedule === 'object' && Object.keys(schedule).length > 0;
}

function isAssignableTechnicianRow(row: any): boolean {
  if (!row || row.active === false || row.status === 'disabled') return false;
  if (!row.isLoginProfile) return true;
  return !!(
    String(row.nickname || '').trim()
    || String(row.passcode || '').trim()
    || String(row.phone || '').trim()
    || hasScheduleValue(row.schedule)
  );
}

function cloudConflictForKey(key: string): string {
  if (key === 'preferences') return 'shop_id,key';
  if (key === 'technicians') return 'shop_id,legacy_id';
  return 'shop_id,legacy_id';
}

function toCloudRow(key: string, item: any): any | null {
  if (!cloudSession || !item || typeof item !== 'object') return null;
  const shop_id = cloudSession.shopId;
  if (key === 'customers') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      first_name: toCloudString(item.firstName),
      last_name: toCloudString(item.lastName),
      email: toCloudString(item.email),
      phone: toCloudString(item.phone),
      phone_alt: toCloudString(item.phoneAlt || item.altPhone),
      declined_phone: toCloudBool(item.declinedPhone),
      declined_email: toCloudBool(item.declinedEmail),
      zip: toCloudString(item.zip),
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'workOrders') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      legacy_customer_id: toCloudIntId(item.customerId),
      legacy_addon_sale_id: toCloudIntId(item.addonSaleId),
      status: toCloudString(item.status),
      assigned_to: toCloudString(item.assignedTo),
      check_in_at: toCloudIso(item.checkInAt),
      repair_completion_date: toCloudIso(item.repairCompletionDate),
      checkout_date: toCloudIso(item.checkoutDate),
      product_category: toCloudString(item.productCategory),
      product_description: toCloudString(item.productDescription),
      model: toCloudString(item.model),
      serial: toCloudString(item.serial),
      intake_source: toCloudString(item.intakeSource),
      problem_info: toCloudString(item.problemInfo),
      work_order_type: toCloudString(item.workOrderType),
      diagnostic_selection: item.diagnosticSelection == null ? null : toCloudObject(item.diagnosticSelection),
      durant_full_transfer: toCloudBool(item.durantFullTransfer),
      parts_ordered: toCloudBool(item.partsOrdered),
      parts_dates: toCloudString(item.partsDates),
      parts_order_url: toCloudString(item.partsOrderUrl),
      parts_tracking_url: toCloudString(item.partsTrackingUrl),
      parts_order_date: toCloudIso(item.partsOrderDate),
      parts_estimated_delivery: toCloudIso(item.partsEstimatedDelivery),
      parts_est_delivery: toCloudIso(item.partsEstDelivery),
      discount: toCloudMoney(item.discount),
      discount_type: toCloudString(item.discountType),
      discount_pct_value: toCloudNumber(item.discountPctValue),
      amount_paid: toCloudMoney(item.amountPaid),
      tax_rate: toCloudNumber(item.taxRate) || 0,
      labor_cost: toCloudMoney(item.laborCost),
      part_costs: toCloudMoney(item.partCosts),
      payment_type: toCloudString(item.paymentType),
      totals: toCloudObject(item.totals),
      items: toCloudArray(item.items),
      payments: toCloudArray(item.payments),
      internal_notes: toCloudString(item.internalNotes),
      internal_notes_log: toCloudArray(item.internalNotesLog),
      status_update: typeof item.statusUpdate === 'undefined' ? undefined : toCloudString(item.statusUpdate),
      status_updated_at: typeof item.statusUpdatedAt === 'undefined' ? undefined : toCloudIso(item.statusUpdatedAt),
      repair_status: typeof item.repairStatus === 'undefined' ? undefined : toCloudString(item.repairStatus),
      estimated_date: typeof item.estimatedDate === 'undefined' ? undefined : toCloudString(item.estimatedDate),
      tech_notes: typeof item.techNotes === 'undefined' ? undefined : toCloudString(item.techNotes),
      last_update_note: typeof item.lastUpdateNote === 'undefined' ? undefined : toCloudString(item.lastUpdateNote),
      last_update_at: typeof item.lastUpdateAt === 'undefined' ? undefined : toCloudIso(item.lastUpdateAt),
      pickup_ready_at: typeof item.pickupReadyAt === 'undefined' ? undefined : toCloudIso(item.pickupReadyAt),
      scheduled_pickup_at: typeof item.scheduledPickupAt === 'undefined' ? undefined : toCloudIso(item.scheduledPickupAt),
      pickup_reminder_sent_at: typeof item.pickupReminderSentAt === 'undefined' ? undefined : toCloudIso(item.pickupReminderSentAt),
      picked_up_at: typeof item.pickedUpAt === 'undefined' ? undefined : toCloudIso(item.pickedUpAt),
      picked_up_by: typeof item.pickedUpBy === 'undefined' ? undefined : toCloudString(item.pickedUpBy),
      workflow_stage: typeof item.workflowStage === 'undefined' ? undefined : toCloudString(item.workflowStage),
      diagnosis_started_at: typeof item.diagnosisStartedAt === 'undefined' ? undefined : toCloudIso(item.diagnosisStartedAt),
      testing_started_at: typeof item.testingStartedAt === 'undefined' ? undefined : toCloudIso(item.testingStartedAt),
      last_technician_activity_at: typeof item.lastTechnicianActivityAt === 'undefined' ? undefined : toCloudIso(item.lastTechnicianActivityAt),
      promised_at: typeof item.promisedAt === 'undefined' ? undefined : toCloudIso(item.promisedAt),
      promise_note: typeof item.promiseNote === 'undefined' ? undefined : toCloudString(item.promiseNote),
      part_eta: typeof item.partEta === 'undefined' ? undefined : toCloudDateOnly(item.partEta),
      client_decision: typeof item.clientDecision === 'undefined' ? undefined : toCloudString(item.clientDecision),
      client_decision_at: typeof item.clientDecisionAt === 'undefined' ? undefined : toCloudIso(item.clientDecisionAt),
      pattern_sequence: toCloudArray(item.patternSequence),
      drone_checklist: toCloudObject(item.droneChecklist),
      dropoff_accessories: toCloudArray(item.dropoffAccessories),
      activity_at: toCloudIso(item.activityAt),
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'sales') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      legacy_customer_id: toCloudIntId(item.customerId),
      customer_name: toCloudString(item.customerName),
      customer_phone: toCloudString(item.customerPhone),
      customer_email: toCloudString(item.customerEmail),
      status: toCloudString(item.status),
      assigned_to: toCloudString(item.assignedTo),
      category: toCloudString(item.category),
      item_description: toCloudString(item.itemDescription),
      condition: toCloudString(item.condition),
      intake_source: toCloudString(item.intakeSource),
      notes: toCloudString(item.notes),
      in_stock: toCloudNullableBool(item.inStock),
      quantity: toCloudNumber(item.quantity),
      price: toCloudNumber(item.price),
      total: toCloudNumber(item.total),
      discount: toCloudMoney(item.discount),
      discount_type: toCloudString(item.discountType),
      discount_pct_value: toCloudNumber(item.discountPctValue),
      amount_paid: toCloudMoney(item.amountPaid),
      tax_rate: toCloudNumber(item.taxRate) || 0,
      labor_cost: toCloudMoney(item.laborCost),
      part_costs: toCloudMoney(item.partCosts),
      payment_type: toCloudString(item.paymentType),
      ordered_date: toCloudIso(item.orderedDate),
      estimated_delivery_date: toCloudIso(item.estimatedDeliveryDate),
      check_in_at: toCloudIso(item.checkInAt),
      repair_completion_date: toCloudIso(item.repairCompletionDate),
      checkout_date: toCloudIso(item.checkoutDate),
      client_pickup_date: toCloudIso(item.clientPickupDate),
      parts_order_url: toCloudString(item.partsOrderUrl),
      parts_tracking_url: toCloudString(item.partsTrackingUrl),
      consultation_hours: toCloudNumber(item.consultationHours),
      consultation_type: toCloudString(item.consultationType),
      consultation_address: toCloudString(item.consultationAddress),
      driver_fee: toCloudNumber(item.driverFee),
      appointment_date: toCloudDateOnly(item.appointmentDate),
      appointment_time: toCloudString(item.appointmentTime),
      appointment_end_time: toCloudString(item.appointmentEndTime),
      items: toCloudArray(item.items),
      payments: toCloudArray(item.payments),
      totals: toCloudObject(item.totals),
      status_update: typeof item.statusUpdate === 'undefined' ? undefined : toCloudString(item.statusUpdate),
      status_updated_at: typeof item.statusUpdatedAt === 'undefined' ? undefined : toCloudIso(item.statusUpdatedAt),
      estimated_date: typeof item.estimatedDate === 'undefined' ? undefined : toCloudString(item.estimatedDate),
      tech_notes: typeof item.techNotes === 'undefined' ? undefined : toCloudString(item.techNotes),
      last_update_note: typeof item.lastUpdateNote === 'undefined' ? undefined : toCloudString(item.lastUpdateNote),
      last_update_at: typeof item.lastUpdateAt === 'undefined' ? undefined : toCloudIso(item.lastUpdateAt),
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'quotes') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      legacy_customer_id: toCloudIntId(item.customerId),
      quote_type: toCloudString(item.type || 'sales'),
      customer_name: toCloudString(item.customerName),
      customer_phone: toCloudString(item.customerPhone),
      customer_email: toCloudString(item.customerEmail),
      payload: toCloudPayload(item),
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
      content_updated_at: toCloudIso(item.contentUpdatedAt || item.updatedAt || item.createdAt),
    };
  }
  if (key === 'calendarEvents') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      legacy_customer_id: toCloudIntId(item.customerId),
      legacy_work_order_id: toCloudIntId(item.workOrderId),
      legacy_sale_id: toCloudIntId(item.saleId),
      event_date: toCloudDateOnly(item.date),
      title: toCloudString(item.title),
      event_time: toCloudString(item.time),
      end_time: toCloudString(item.endTime),
      category: toCloudString(item.category),
      location: toCloudString(item.location),
      customer_name: toCloudString(item.customerName),
      customer_phone: toCloudString(item.customerPhone),
      technician: toCloudString(item.technician),
      notes: toCloudString(item.notes),
      part_name: toCloudString(item.partName),
      source: toCloudString(item.source),
      request_status: calendarRequestStatus(item.requestStatus),
      shift_request_off: typeof item.shiftRequestOff === 'boolean' ? item.shiftRequestOff : null,
      requested_at: toCloudIso(item.requestedAt),
      reviewed_at: toCloudIso(item.reviewedAt),
      order_url: toCloudString(item.orderUrl),
      tracking_url: toCloudString(item.trackingUrl),
      parts_status: toCloudString(item.partsStatus),
      consultation_type: toCloudString(item.consultationType),
      task_completed: toCloudBool(item.taskCompleted),
      task_completed_at: item.taskCompleted ? toCloudIso(item.taskCompletedAt) : null,
      task_completed_by: toCloudString(item.taskCompletedBy),
      recurrence_rule: item.recurrenceRule && typeof item.recurrenceRule === 'object' ? toCloudObject(item.recurrenceRule) : null,
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'calendarNotes') {
    const legacy_id = toCloudTextId(item.id);
    if (!legacy_id) return null;
    return {
      shop_id,
      legacy_id,
      note_date: toCloudDateOnly(item.date),
      subject: toCloudString(item.subject),
      body: toCloudString(item.body),
      attachments: Array.isArray(item.attachments) ? item.attachments.slice(0, 4) : [],
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'feedbackEntries') {
    const legacy_id = toCloudTextId(item.id);
    if (!legacy_id) return null;
    return {
      shop_id,
      legacy_id,
      subject: toCloudString(item.subject),
      body: toCloudString(item.body),
      completed: !!item.completed,
      completed_at: toCloudIso(item.completedAt),
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'deviceCategories' || key === 'productCategories') {
    const legacy_id = toCloudIntId(item.id);
    const name = toCloudString(item.name || item.title).trim();
    if (legacy_id === null || !name) return null;
    return {
      shop_id,
      legacy_id,
      name,
      title: toCloudString(item.title),
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'products') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      item_description: toCloudString(item.itemDescription),
      item_type: toCloudString(item.itemType || 'Product'),
      device_model: toCloudString(item.deviceModel),
      price: toCloudMoney(item.price),
      internal_cost: toCloudMoney(item.internalCost),
      markup_pct: toCloudNumber(item.markupPct),
      notes: toCloudString(item.notes),
      condition: toCloudString(item.condition),
      category: toCloudString(item.category),
      repair_type: toCloudString(item.repairType),
      part_category: toCloudString(item.partCategory),
      distributor: toCloudString(item.distributor),
      vendor_relationship: toCloudString(item.vendorRelationship || 'wholesale'),
      vendor_share_pct: toCloudNumber(item.vendorSharePct),
      vendor_tax_exempt: toCloudBool(item.vendorTaxExempt),
      distributor_sku: toCloudString(item.distributorSku),
      reorder_qty: toCloudIntId(item.reorderQty) || 1,
      reorder_url_template: toCloudString(item.reorderUrlTemplate),
      associated_devices: Array.isArray(item.associatedDevices) ? item.associatedDevices.map((value: any) => String(value || '').trim()).filter(Boolean) : [],
      track_stock: toCloudBool(item.trackStock),
      stock_count: toCloudIntId(item.stockCount) || 0,
      low_stock_threshold: toCloudIntId(item.lowStockThreshold) || 0,
      purchase_restock_keys: Array.isArray(item.purchaseRestockKeys) ? item.purchaseRestockKeys.map((value: any) => String(value)).filter(Boolean).slice(-100) : [],
      inventory_consumption_keys: Array.isArray(item.inventoryConsumptionKeys) ? item.inventoryConsumptionKeys.map((value: any) => String(value)).filter(Boolean) : [],
      is_parent_part: toCloudBool(item.isParentPart),
      parent_product_legacy_id: toCloudIntId(item.parentProductId),
      variant_attributes: toCloudPayload(item.variantAttributes || {}),
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'repairCategories') {
    const legacy_id = toCloudTextId(item.id);
    if (!legacy_id) return null;
    return {
      shop_id,
      legacy_id,
      category: toCloudString(item.category),
      repair_category: toCloudString(item.repairCategory),
      title: toCloudString(item.title),
      alt_description: toCloudString(item.altDescription),
      part_cost: toCloudMoney(item.partCost),
      labor_cost: toCloudMoney(item.laborCost),
      internal_cost: toCloudMoney(item.internalCost),
      markup_pct: toCloudNumber(item.markupPct),
      order_date: toCloudString(item.orderDate),
      est_delivery: toCloudString(item.estDelivery),
      part_source: toCloudString(item.partSource),
      order_source_url: toCloudString(item.orderSourceUrl),
      tutorial_url: toCloudString(item.tutorialUrl),
      tutorial_media_type: toCloudString(item.tutorialMediaType),
      tutorial_updated_at: toCloudIso(item.tutorialUpdatedAt),
      type: toCloudString(item.type),
      model: toCloudString(item.model),
      track_stock: toCloudBool(item.trackStock),
      inventory_product_id: toCloudIntId(item.inventoryProductId),
      inventory_parent_legacy_id: toCloudIntId(item.inventoryParentId),
      repair_family: toCloudString(item.repairFamily),
      service_key: toCloudString(item.serviceKey),
      compatible_devices: Array.isArray(item.compatibleDevices) ? item.compatibleDevices.map((value: any) => String(value || '').trim()).filter(Boolean) : [],
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'settings') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      shop_address: toCloudString(item.shopAddress),
      shop_lat: toCloudNumber(item.shopLat),
      shop_lng: toCloudNumber(item.shopLng),
      payload: toCloudPayload(item),
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'preferences') {
    const keyName = toCloudString(item.key || item.name || item.id).trim();
    if (!keyName) return null;
    return {
      shop_id,
      legacy_id: toCloudIntId(item.id),
      key: keyName,
      value: toCloudPayload(item.value !== undefined ? item.value : item),
    };
  }
  if (key === 'technicians') {
    const legacyId = toCloudTextId(item.id);
    const email = toCloudString(item.email).trim() || `legacy-technician-${legacyId || Date.now()}@local.gbpos.invalid`;
    return {
      shop_id,
      legacy_id: legacyId,
      first_name: toCloudString(item.firstName),
      last_name: toCloudString(item.lastName),
      nickname: toCloudString(item.nickname),
      phone: toCloudString(item.phone),
      email,
      profile_icon: toCloudString(item.profileIcon),
      schedule: toCloudObject(item.schedule),
      status: item.status || 'active',
      role: item.role || 'technician',
      legacy_updated_at: toCloudIso(item.updatedAt),
    };
  }
  if (key === 'partSources' || key === 'intakeSources' || key === 'suppliers' || key === 'vendors') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      name: toCloudString(item.name || item.title || item.label),
      payload: toCloudPayload(item),
    };
  }
  if (key === 'timeEntries') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      legacy_technician_id: toCloudTextId(item.technicianId),
      clock_in_at: toCloudIso(item.clockIn),
      clock_out_at: toCloudIso(item.clockOut),
      payload: toCloudPayload(item),
    };
  }
  if (key === 'systemLogs') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      level: toCloudString(item.level),
      message: toCloudString(item.message),
      payload: toCloudPayload(item),
      logged_at: toCloudIso(item.loggedAt || item.createdAt) || new Date().toISOString(),
    };
  }
  if (key === 'invoices' || key === 'payments' || key === 'repairItems' || key === 'purchaseOrders') {
    const legacy_id = toCloudIntId(item.id);
    if (legacy_id === null) return null;
    return {
      shop_id,
      legacy_id,
      payload: toCloudPayload(item),
    };
  }
  return null;
}

function cloudSortColumn(key: string, sortBy?: string): string {
  const s = String(sortBy || '').trim();
  const map: Record<string, Record<string, string>> = {
    workOrders: { id: 'legacy_id', activityAt: 'activity_at', checkInAt: 'check_in_at', updatedAt: 'updated_at' },
    sales: { id: 'legacy_id', activityAt: 'check_in_at', checkInAt: 'check_in_at', updatedAt: 'updated_at' },
    quotes: { id: 'legacy_id', updatedAt: 'updated_at', contentUpdatedAt: 'content_updated_at', createdAt: 'created_at' },
    customers: { id: 'legacy_id', updatedAt: 'updated_at', createdAt: 'created_at' },
    technicians: { id: 'legacy_id', updatedAt: 'updated_at', firstName: 'first_name', lastName: 'last_name' },
    calendarNotes: { id: 'legacy_id', date: 'note_date', updatedAt: 'updated_at', createdAt: 'created_at' },
  };
  if (map[key]?.[s]) return map[key][s];
  if (!s) {
    if (key === 'workOrders') return 'activity_at';
    if (key === 'sales') return 'check_in_at';
    if (key === 'quotes') return 'content_updated_at';
    if (key === 'technicians') return 'first_name';
    if (key === 'calendarNotes') return 'note_date';
    return 'legacy_id';
  }
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) ? s : 'legacy_id';
}

function requireCloudSession(): CloudSession {
  if (!cloudSession?.shopId) throw new Error('Cloud session is not ready. Sign in again.');
  return cloudSession;
}

function normalizeQrStatusType(value: any): 'repair' | 'sale' | 'consult' {
  const raw = String(value || '').trim().toLowerCase();
  if (/^(sale|sales|invoice|inv)$/.test(raw)) return 'sale';
  if (/^(consult|consultation|appointment)$/.test(raw)) return 'consult';
  return 'repair';
}

function cloudRecordKeyForQrType(type: 'repair' | 'sale' | 'consult'): string {
  if (type === 'sale') return 'sales';
  if (type === 'consult') return 'calendarEvents';
  return 'workOrders';
}

function getHostedAppUrl(): string {
  const envUrl = String((import.meta as any)?.env?.VITE_PUBLIC_APP_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/+$/, '');
  try {
    const origin = String(window.location.origin || '').trim();
    if (/^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, '');
  } catch {
    // ignore
  }
  return 'https://mattstechwisdom.github.io/GB-POS';
}

function makeQrToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let raw = '';
  bytes.forEach((b) => { raw += String.fromCharCode(b); });
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function ensureCloudQrStatusUrl(typeInput: any, idInput: any): Promise<string | null> {
  const session = requireCloudSession();
  const type = normalizeQrStatusType(typeInput);
  const id = Number(idInput) || 0;
  if (!id) return null;

  const existing = await supabase
    .from('qr_status_tokens')
    .select('token')
    .eq('shop_id', session.shopId)
    .eq('record_type', type)
    .eq('legacy_record_id', id)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(`Cloud QR token lookup failed: ${existing.error.message}`);
  if (existing.data?.token) {
    return type === 'consult'
      ? `${getHostedAppUrl()}/consultation.html?token=${encodeURIComponent(existing.data.token)}`
      : `${getHostedAppUrl()}/?clientUpdateToken=${encodeURIComponent(existing.data.token)}`;
  }

  const recordKey = cloudRecordKeyForQrType(type);
  const recordTable = CLOUD_TABLE_BY_KEY[recordKey];
  let recordCloudId: string | null = null;
  if (recordTable) {
    const recordRes = await supabase
      .from(recordTable)
      .select('id')
      .eq('shop_id', session.shopId)
      .eq('legacy_id', id)
      .maybeSingle();
    if (!recordRes.error && recordRes.data?.id) recordCloudId = recordRes.data.id;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = makeQrToken();
    const inserted = await supabase
      .from('qr_status_tokens')
      .insert({
        shop_id: session.shopId,
        token,
        record_type: type,
        legacy_record_id: id,
        record_id: recordCloudId,
        metadata: { createdBy: 'gb-pos-mobile' },
      })
      .select('token')
      .single();
    if (!inserted.error && inserted.data?.token) {
      return type === 'consult'
        ? `${getHostedAppUrl()}/consultation.html?token=${encodeURIComponent(inserted.data.token)}`
        : `${getHostedAppUrl()}/?clientUpdateToken=${encodeURIComponent(inserted.data.token)}`;
    }
    if (!/duplicate|unique/i.test(String(inserted.error?.message || ''))) {
      throw new Error(`Cloud QR token create failed: ${inserted.error?.message || 'Unknown error'}`);
    }
  }
  throw new Error('Cloud QR token create failed after duplicate retries.');
}

async function resolveCloudQrStatusToken(token: string) {
  const session = requireCloudSession();
  const cleaned = String(token || '').trim();
  if (!cleaned) throw new Error('Missing QR token.');

  const tokenRes = await supabase
    .from('qr_status_tokens')
    .select('*')
    .eq('shop_id', session.shopId)
    .eq('token', cleaned)
    .is('revoked_at', null)
    .maybeSingle();
  if (tokenRes.error) throw new Error(`Cloud QR token read failed: ${tokenRes.error.message}`);
  const tokenRow = tokenRes.data;
  if (!tokenRow) throw new Error('QR token was not found for this shop.');
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
    throw new Error('This QR token is expired.');
  }

  void supabase.from('qr_status_tokens').update({ last_opened_at: new Date().toISOString() }).eq('id', tokenRow.id);

  const type = normalizeQrStatusType(tokenRow.record_type);
  const recordKey = cloudRecordKeyForQrType(type);
  const table = CLOUD_TABLE_BY_KEY[recordKey];
  const recordRes = await supabase
    .from(table)
    .select('*')
    .eq('shop_id', session.shopId)
    .eq('legacy_id', Number(tokenRow.legacy_record_id))
    .maybeSingle();
  if (recordRes.error) throw new Error(`Cloud QR record read failed: ${recordRes.error.message}`);
  if (!recordRes.data) throw new Error('The QR record no longer exists.');

  const record = fromCloudRow(recordKey, recordRes.data);
  let customer: any = null;
  const customerId = Number((record as any)?.customerId || 0) || 0;
  if (customerId > 0) {
    const customerRes = await supabase
      .from('customers')
      .select('*')
      .eq('shop_id', session.shopId)
      .eq('legacy_id', customerId)
      .maybeSingle();
    if (!customerRes.error && customerRes.data) customer = fromCloudRow('customers', customerRes.data);
  }

  return { token: tokenRow, type, record, customer };
}

function localKey(key: string): string {
  return `gbpos-mobile-cache:${key}`;
}

function readLocalList(key: string): any[] {
  if (localFallback.has(key)) return localFallback.get(key) || [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(localKey(key)) || '[]');
    const list = Array.isArray(parsed) ? parsed : [];
    localFallback.set(key, list);
    return list;
  } catch {
    return [];
  }
}

function writeLocalList(key: string, list: any[]) {
  localFallback.set(key, Array.isArray(list) ? list : []);
  try {
    window.localStorage.setItem(localKey(key), JSON.stringify(Array.isArray(list) ? list : []));
  } catch {
    // Local cache is best effort.
  }
}

function readCachedList(key: string, opts?: SortOptions): any[] {
  const rows = readLocalList(key).slice();
  const sortBy = String(opts?.sortBy || '');
  if (sortBy) rows.sort((a, b) => {
    const left = a?.[sortBy];
    const right = b?.[sortBy];
    const compared = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left || '').localeCompare(String(right || ''));
    return opts?.sortDir === 'asc' ? compared : -compared;
  });
  return opts?.limit && opts.limit > 0 ? rows.slice(0, Math.floor(opts.limit)) : rows;
}

function readMobileSyncState(): { lastSuccessAt: string; collections: Record<string, CloudCursor | null> } {
  try {
    const value = JSON.parse(window.localStorage.getItem(mobileSyncStateKey) || '{}');
    return { lastSuccessAt: String(value?.lastSuccessAt || ''), collections: value?.collections && typeof value.collections === 'object' ? value.collections : {} };
  } catch {
    return { lastSuccessAt: '', collections: {} };
  }
}

function writeMobileSyncState(state: { lastSuccessAt: string; collections: Record<string, CloudCursor | null> }) {
  try { window.localStorage.setItem(mobileSyncStateKey, JSON.stringify(state)); } catch {}
}

function emitChanged(key: string, payload?: any) {
  const name = COLLECTION_CHANGED_EVENT[key];
  if (!name) return;
  const set = listeners.get(name);
  if (!set) return;
  for (const cb of Array.from(set)) {
    try {
      cb(payload);
    } catch {
      // Listener failures should not break data saves.
    }
  }
}

function addListener(event: string, cb: (payload?: any) => void) {
  const set = listeners.get(event) || new Set<(payload?: any) => void>();
  set.add(cb);
  listeners.set(event, set);
  return () => set.delete(cb);
}

function matchesDbQuery(it: any, q: any): boolean {
  const query = q || {};
  for (const k of Object.keys(query)) {
    const rawQ = query[k];
    if (rawQ === null || typeof rawQ === 'undefined') continue;
    const isIdLike = /^id$/i.test(k) || /Id$/i.test(k) || /_id$/i.test(k);
    if (typeof rawQ === 'boolean') {
      if (Boolean(it?.[k]) !== rawQ) return false;
      continue;
    }
    if (typeof rawQ === 'number') {
      if (!Number.isFinite(rawQ)) continue;
      const itemNum = Number(it?.[k]);
      if (!Number.isFinite(itemNum) || itemNum !== rawQ) return false;
      continue;
    }
    const qStr = rawQ.toString();
    if (!qStr.trim()) continue;
    if (isIdLike) {
      const qNum = Number(qStr);
      const itemNum = Number(it?.[k]);
      if (Number.isFinite(qNum) && Number.isFinite(itemNum)) {
        if (itemNum !== qNum) return false;
        continue;
      }
      if (String(it?.[k] ?? '') !== qStr) return false;
      continue;
    }
    if (!String(it?.[k] ?? '').toLowerCase().includes(qStr.toLowerCase())) return false;
  }
  return true;
}

async function getTechnicianCredentials() {
  const session = requireCloudSession();
  const res = await supabase
    .from('technician_private_credentials')
    .select('staff_profile_id,legacy_technician_id,legacy_passcode')
    .eq('shop_id', session.shopId);
  if (res.error) return { credentialsByStaffId: new Map<string, any>(), credentialsByLegacyId: new Map<string, any>() };
  const credentialsByStaffId = new Map<string, any>();
  const credentialsByLegacyId = new Map<string, any>();
  for (const row of Array.isArray(res.data) ? res.data : []) {
    if (row.staff_profile_id) credentialsByStaffId.set(String(row.staff_profile_id), row);
    if (row.legacy_technician_id) credentialsByLegacyId.set(String(row.legacy_technician_id), row);
  }
  return { credentialsByStaffId, credentialsByLegacyId };
}

async function cloudDbGet(key: string, opts?: SortOptions): Promise<any[]> {
  const session = requireCloudSession();
  const table = CLOUD_TABLE_BY_KEY[key];
  if (!table) return readLocalList(key);
  if (key === 'notificationSettings') return getPreferenceBackedList('notificationSettings');

  const credentialExtra = key === 'technicians' ? await getTechnicianCredentials() : undefined;
  const sortColumn = cloudSortColumn(key, opts?.sortBy);
  const requestedLimit = typeof opts?.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : 0;
  const pageSize = 1000;
  const rawRows: any[] = [];
  let pageStart = 0;

  do {
    let q = supabase
      .from(table)
      .select('*')
      .eq('shop_id', session.shopId)
      .order(sortColumn, { ascending: opts?.sortDir === 'asc', nullsFirst: false });
    if (sortColumn !== 'legacy_id') q = q.order('legacy_id', { ascending: true, nullsFirst: false });
    if (requestedLimit > 0) q = q.limit(requestedLimit);
    else q = q.range(pageStart, pageStart + pageSize - 1);
    const res = await q;
    if (res.error) throw new Error(`Cloud ${key} read failed: ${res.error.message}`);
    const page = Array.isArray(res.data) ? res.data : [];
    rawRows.push(...page);
    if (requestedLimit > 0 || page.length < pageSize) break;
    pageStart += pageSize;
  } while (true);

  let rows = rawRows.map((row: any) => fromCloudRow(key, row, credentialExtra));
  if (key === 'technicians') rows = rows.filter(isAssignableTechnicianRow);
  if (key === 'workOrders' && rows.length > 0) {
    try {
      const customerIds = Array.from(new Set(
        rows
          .map((row: any) => Number(row?.customerId || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0)
      ));
      if (customerIds.length > 0) {
        const customerRes = await supabase
          .from('customers')
          .select('legacy_id, first_name, last_name, phone, phone_alt, email')
          .eq('shop_id', session.shopId)
          .in('legacy_id', customerIds);
        if (!customerRes.error && Array.isArray(customerRes.data)) {
          const customersByLegacyId = new Map<number, any>();
          for (const customer of customerRes.data) {
            const id = Number(customer?.legacy_id || 0);
            if (Number.isFinite(id) && id > 0) customersByLegacyId.set(id, customer);
          }
          for (const row of rows) {
            const customer = customersByLegacyId.get(Number(row?.customerId || 0));
            if (!customer) continue;
            const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
            if (fullName && !row.customerName) row.customerName = fullName;
            if (customer.phone && !row.customerPhone) row.customerPhone = customer.phone;
            if (customer.phone_alt && !row.customerPhoneAlt) row.customerPhoneAlt = customer.phone_alt;
            if (customer.email && !row.customerEmail) row.customerEmail = customer.email;
          }
        }
      }
    } catch {
      // Customer snapshots are best effort; work-order reads still succeed without them.
    }
  }
  writeLocalList(key, rows);
  return rows;
}

function mobilePendingIds(key: string): Set<string> {
  try {
    const queue = JSON.parse(window.localStorage.getItem(pendingQueueKey) || '[]');
    return new Set((Array.isArray(queue) ? queue : [])
      .filter((operation: any) => operation?.key === key)
      .map((operation: any) => String(operation?.item?.id ?? operation?.id ?? ''))
      .filter(Boolean));
  } catch {
    return new Set<string>();
  }
}

function isTerminalMobileWorkOrder(record: any): boolean {
  return /^(closed|cancelled|canceled|void|refunded|deleted|archived)$/i.test(String(record?.status || ''))
    || !!record?.checkoutDate || !!record?.pickedUpAt || !!record?.clientPickupDate;
}

async function syncMobileCollection(key: string, options: { bootstrapLimit?: number } = {}) {
  const session = requireCloudSession();
  const table = CLOUD_TABLE_BY_KEY[key];
  if (!table) return { ok: true, key, changedRows: [], cached: readLocalList(key).length };
  if (key === 'notificationSettings') {
    const rows = await getPreferenceBackedList(key);
    return { ok: true, key, changedRows: rows, cached: rows.length };
  }

  const state = readMobileSyncState();
  const cursor = state.collections[key] || null;
  const pageSize = 1000;
  const bootstrapLimit = cursor ? 0 : Math.max(0, Number(options.bootstrapLimit || 0));
  const rawRows: any[] = [];
  let pageStart = 0;
  do {
    const remaining = bootstrapLimit > 0 ? Math.max(0, bootstrapLimit - rawRows.length) : pageSize;
    if (bootstrapLimit > 0 && remaining === 0) break;
    const take = bootstrapLimit > 0 ? Math.min(pageSize, remaining) : pageSize;
    let query = supabase.from(table)
      .select('*')
      .eq('shop_id', session.shopId)
      .order('updated_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true, nullsFirst: false });
    if (cursor?.updatedAt) query = query.gte('updated_at', cursor.updatedAt);
    const response = await query.range(pageStart, pageStart + take - 1);
    if (response.error) throw new Error(`Cloud ${key} incremental read failed: ${response.error.message}`);
    const page = Array.isArray(response.data) ? response.data : [];
    rawRows.push(...page);
    if (page.length < take) break;
    pageStart += take;
  } while (bootstrapLimit <= 0 || rawRows.length < bootstrapLimit);

  const credentialExtra = key === 'technicians' ? await getTechnicianCredentials() : undefined;
  let changedRows = rawRows.map((row: any) => ({
    ...fromCloudRow(key, row, credentialExtra),
    cloudUpdatedAt: cloudDate(row.updated_at),
    cloudCursorId: String(row.id || ''),
  })).filter((row: any) => isRowAfterCursor(row, cursor));
  if (key === 'technicians') changedRows = changedRows.filter(isAssignableTechnicianRow);
  const existing = readLocalList(key);
  const merged = mergeIncrementalRows(existing, changedRows, mobilePendingIds(key), {
    terminal: key === 'workOrders' ? isTerminalMobileWorkOrder : undefined,
  });
  writeLocalList(key, merged);
  const nextCursor = cursorAfterRows(changedRows) || cursor;
  const syncedAt = new Date().toISOString();
  writeMobileSyncState({ lastSuccessAt: syncedAt, collections: { ...state.collections, [key]: nextCursor } });
  if (changedRows.length) emitChanged(key, changedRows.length === 1 ? changedRows[0] : { changedRows });
  return { ok: true, key, changedRows, cached: merged.length, lastSuccessAt: syncedAt };
}

async function getPreferenceBackedList(key: string): Promise<any[]> {
  const session = requireCloudSession();
  const res = await supabase
    .from('preferences')
    .select('*')
    .eq('shop_id', session.shopId)
    .eq('key', key)
    .maybeSingle();
  if (res.error) throw new Error(`Cloud ${key} read failed: ${res.error.message}`);
  const value = cloudObject(res.data?.value);
  const list = Array.isArray(value.items) ? value.items : (value && Object.keys(value).length ? [value] : []);
  writeLocalList(key, list);
  return list;
}

async function setPreferenceBackedList(key: string, list: any[]): Promise<any[]> {
  const session = requireCloudSession();
  const res = await supabase.from('preferences').upsert({
    shop_id: session.shopId,
    key,
    value: { items: list },
  }, { onConflict: 'shop_id,key' });
  if (res.error) throw new Error(`Cloud ${key} write failed: ${res.error.message}`);
  writeLocalList(key, list);
  emitChanged(key);
  return list;
}

async function getCloudCount(key: string): Promise<number | null> {
  const session = requireCloudSession();
  const table = CLOUD_TABLE_BY_KEY[key];
  if (!table) return null;
  const res = await supabase.from(table).select('id', { count: 'exact', head: true }).eq('shop_id', session.shopId);
  if (res.error) throw new Error(`Cloud ${key} count failed: ${res.error.message}`);
  return typeof res.count === 'number' ? res.count : null;
}

async function nextLegacyId(key: string): Promise<number | string> {
  if (key === 'repairCategories' || key === 'technicians' || key === 'calendarNotes' || key === 'feedbackEntries') return crypto.randomUUID();
  if (key === 'calendarEvents') {
    const random = new Uint16Array(1);
    crypto.getRandomValues(random);
    return (Date.now() * 1000) + (random[0] % 1000);
  }
  const table = CLOUD_TABLE_BY_KEY[key];
  const session = requireCloudSession();
  let max = 0;

  const scanTables = key === 'workOrders' || key === 'sales'
    ? ['work_orders', 'sales']
    : table ? [table] : [];

  for (const tableName of scanTables) {
    const res = await supabase
      .from(tableName)
      .select('legacy_id')
      .eq('shop_id', session.shopId)
      .not('legacy_id', 'is', null)
      .order('legacy_id', { ascending: false })
      .limit(1);
    if (res.error) throw new Error(`Cloud ${key} id check failed: ${res.error.message}`);
    const n = Number(res.data?.[0]?.legacy_id);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return max + 1;
}

function legacyIdForCloudItem(key: string, item: any): number | string | null {
  if (!item || typeof item !== 'object') return null;
  if (key === 'preferences') return toCloudString(item.key || item.name || item.id).trim() || null;
  if (key === 'repairCategories' || key === 'technicians' || key === 'calendarNotes' || key === 'feedbackEntries') return toCloudTextId(item.id);
  return toCloudIntId(item.id);
}

function queuePending(op: any) {
  try {
    const list = JSON.parse(window.localStorage.getItem(pendingQueueKey) || '[]');
    const next = Array.isArray(list) ? list : [];
    next.push({ ...op, createdAt: new Date().toISOString() });
    window.localStorage.setItem(pendingQueueKey, JSON.stringify(next.slice(-500)));
  } catch {
    // ignore
  }
}

async function drainPending() {
  let list: any[] = [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(pendingQueueKey) || '[]');
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    return;
  }
  if (!list.length || !cloudSession) return;
  const remaining: any[] = [];
  for (const op of list) {
    try {
      if (op.op === 'delete') await cloudDbDelete(op.key, op.id, false);
      if (op.op === 'upsert') await cloudDbUpsert(op.key, op.item, false);
    } catch {
      remaining.push(op);
    }
  }
  try {
    window.localStorage.setItem(pendingQueueKey, JSON.stringify(remaining));
  } catch {
    // ignore
  }
}

async function cloudDbUpsert(key: string, item: any, queueOnFailure = true): Promise<any> {
  if (key === 'notificationSettings') {
    const list = await getPreferenceBackedList(key);
    const id = item?.id ?? 'notification-settings';
    const next = [{ ...cloudObject(list[0]), ...item, id }];
    return (await setPreferenceBackedList(key, next))[0] || null;
  }

  const table = CLOUD_TABLE_BY_KEY[key];
  if (!table) {
    return upsertLocalOnly(key, item);
  }
  let row = toCloudRow(key, item);
  if (!row) throw new Error(`Cloud ${key} write skipped: unsupported row.`);
  try {
    if (key === 'workOrders') {
      const latest = await supabase.from(table).select('*').eq('shop_id', row.shop_id).eq('legacy_id', item.id).maybeSingle();
      if (latest.error) throw new Error(`Cloud workflow reconciliation failed: ${latest.error.message}`);
      if (latest.data) row = toCloudRow(key, preserveNewerWorkflow(item, fromCloudRow(key, latest.data)));
    }
    let res = await supabase.from(table).upsert(row, {
      onConflict: cloudConflictForKey(key),
      ignoreDuplicates: false,
    }).select('*').maybeSingle();
    if (res.error && key === 'products' && /item_type|device_model|repair_type|part_category|distributor|distributor_sku|reorder_qty|reorder_url_template|associated_devices|purchase_restock_keys|inventory_consumption_keys|markup_pct|is_parent_part|parent_product_legacy_id|variant_attributes|schema cache|column/i.test(String(res.error.message || ''))) {
      const fallbackRow = { ...row };
      delete fallbackRow.item_type;
      delete fallbackRow.part_category;
      delete fallbackRow.repair_type;
      delete fallbackRow.distributor;
      delete fallbackRow.vendor_relationship;
      delete fallbackRow.vendor_share_pct;
      delete fallbackRow.vendor_tax_exempt;
      delete fallbackRow.device_model;
      delete fallbackRow.distributor_sku;
      delete fallbackRow.reorder_qty;
      delete fallbackRow.reorder_url_template;
      delete fallbackRow.associated_devices;
      delete fallbackRow.markup_pct;
      delete fallbackRow.purchase_restock_keys;
      delete fallbackRow.inventory_consumption_keys;
      delete fallbackRow.is_parent_part;
      delete fallbackRow.parent_product_legacy_id;
      delete fallbackRow.variant_attributes;
      res = await supabase.from(table).upsert(fallbackRow, {
        onConflict: cloudConflictForKey(key),
        ignoreDuplicates: false,
      }).select('*').maybeSingle();
    }
    if (res.error && key === 'repairCategories' && /markup_pct|inventory_product_id|inventory_parent_legacy_id|repair_family|service_key|schema cache|column/i.test(String(res.error.message || ''))) {
      const fallbackRow = { ...row };
      delete fallbackRow.markup_pct;
      delete fallbackRow.inventory_product_id;
      delete fallbackRow.inventory_parent_legacy_id;
      delete fallbackRow.repair_family;
      delete fallbackRow.service_key;
      res = await supabase.from(table).upsert(fallbackRow, {
        onConflict: cloudConflictForKey(key),
        ignoreDuplicates: false,
      }).select('*').maybeSingle();
    }
    if (res.error) throw new Error(`Cloud ${key} write failed: ${res.error.message}`);
    await syncTechnicianCredential(key, item, res.data);
    const saved = fromCloudRow(key, res.data || row);
    const current = readLocalList(key);
    writeLocalList(key, [...current.filter((entry) => String(entry?.id) !== String(saved?.id)), saved]);
    emitChanged(key, saved);
    return saved;
  } catch (e) {
    if (queueOnFailure) queuePending({ op: 'upsert', key, item });
    throw e;
  }
}

async function cloudDbInsert(key: string, item: any): Promise<any> {
  if (key === 'notificationSettings') return cloudDbUpsert(key, item);
  const table = CLOUD_TABLE_BY_KEY[key];
  if (!table) return upsertLocalOnly(key, item);
  let lastError: any = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = { ...(item || {}) };
    if (!candidate.id) candidate.id = await nextLegacyId(key);
    if ((key === 'workOrders' || key === 'sales') && attempt > 0) candidate.id = Number(candidate.id) + 1;
    const row = toCloudRow(key, candidate);
    if (!row) throw new Error(`Cloud ${key} insert skipped: unsupported row.`);
    let res = await supabase.from(table).insert(row).select('*').single();
    if (res.error && key === 'products' && /item_type|device_model|repair_type|part_category|distributor|distributor_sku|reorder_qty|reorder_url_template|associated_devices|purchase_restock_keys|inventory_consumption_keys|markup_pct|is_parent_part|parent_product_legacy_id|variant_attributes|schema cache|column/i.test(String(res.error.message || ''))) {
      const fallbackRow = { ...row };
      delete fallbackRow.item_type;
      delete fallbackRow.device_model;
      delete fallbackRow.part_category;
      delete fallbackRow.repair_type;
      delete fallbackRow.distributor;
      delete fallbackRow.vendor_relationship;
      delete fallbackRow.vendor_share_pct;
      delete fallbackRow.vendor_tax_exempt;
      delete fallbackRow.distributor_sku;
      delete fallbackRow.reorder_qty;
      delete fallbackRow.reorder_url_template;
      delete fallbackRow.associated_devices;
      delete fallbackRow.markup_pct;
      delete fallbackRow.purchase_restock_keys;
      delete fallbackRow.inventory_consumption_keys;
      delete fallbackRow.is_parent_part;
      delete fallbackRow.parent_product_legacy_id;
      delete fallbackRow.variant_attributes;
      res = await supabase.from(table).insert(fallbackRow).select('*').single();
    }
    if (res.error && key === 'repairCategories' && /markup_pct|inventory_product_id|inventory_parent_legacy_id|repair_family|service_key|schema cache|column/i.test(String(res.error.message || ''))) {
      const fallbackRow = { ...row };
      delete fallbackRow.markup_pct;
      delete fallbackRow.inventory_product_id;
      delete fallbackRow.inventory_parent_legacy_id;
      delete fallbackRow.repair_family;
      delete fallbackRow.service_key;
      res = await supabase.from(table).insert(fallbackRow).select('*').single();
    }
    if (!res.error) {
      await syncTechnicianCredential(key, candidate, res.data);
      const saved = fromCloudRow(key, res.data || row);
      const current = readLocalList(key);
      writeLocalList(key, [...current.filter((entry) => String(entry?.id) !== String(saved?.id)), saved]);
      emitChanged(key, saved);
      return saved;
    }
    lastError = res.error;
    const message = String(res.error.message || '');
    if (!message.includes('duplicate key')) break;
    item = { ...candidate, id: Number(candidate.id) + 1 };
  }

  queuePending({ op: 'upsert', key, item });
  throw new Error(`Cloud ${key} insert failed: ${lastError?.message || 'Unknown error'}`);
}

async function syncTechnicianCredential(key: string, item: any, savedRow: any) {
  if (key !== 'technicians' || !cloudSession) return;
  if (typeof item?.passcode === 'undefined') return;
  const legacyId = toCloudTextId(item.id);
  if (!legacyId) return;
  const res = await supabase.from('technician_private_credentials').upsert({
    shop_id: cloudSession.shopId,
    staff_profile_id: savedRow?.id || null,
    legacy_technician_id: legacyId,
    legacy_passcode: String(item.passcode || '').slice(0, 4),
  }, { onConflict: 'shop_id,legacy_technician_id' });
  if (res.error) throw new Error(`Technician passcode write failed: ${res.error.message}`);
}

async function cloudDbDelete(key: string, legacyId: any, queueOnFailure = true): Promise<boolean> {
  if (key === 'notificationSettings') {
    await setPreferenceBackedList(key, []);
    return true;
  }
  const table = CLOUD_TABLE_BY_KEY[key];
  if (!table) return deleteLocalOnly(key, legacyId);
  const session = requireCloudSession();
  const id = key === 'repairCategories' || key === 'technicians' || key === 'calendarNotes' || key === 'feedbackEntries' ? toCloudTextId(legacyId) : toCloudIntId(legacyId);
  if (id === null) throw new Error(`Cloud ${key} delete skipped: missing legacy id.`);
  try {
    let q = supabase.from(table).delete().eq('shop_id', session.shopId);
    if (key === 'preferences') q = q.eq('key', String(legacyId));
    else q = q.eq('legacy_id', id);
    const res = key === 'repairCategories' ? await q.select('legacy_id') : await q;
    if (res.error) throw new Error(`Cloud ${key} delete failed: ${res.error.message}`);
    if (key === 'repairCategories' && (!Array.isArray(res.data) || res.data.length === 0)) {
      throw new Error(`Cloud ${key} delete failed: no matching saved record was removed.`);
    }
    writeLocalList(key, readLocalList(key).filter((entry) => String(entry?.id) !== String(legacyId)));
    emitChanged(key, { id: legacyId, deleted: true });
    return true;
  } catch (e) {
    if (queueOnFailure) queuePending({ op: 'delete', key, id: legacyId });
    throw e;
  }
}

function upsertLocalOnly(key: string, item: any) {
  const list = readLocalList(key);
  const now = new Date().toISOString();
  const nextItem = { ...(item || {}) };
  if (!nextItem.id) nextItem.id = Math.max(0, ...list.map((x) => Number(x?.id || 0)).filter(Number.isFinite)) + 1;
  if (!nextItem.createdAt) nextItem.createdAt = now;
  nextItem.updatedAt = now;
  const idx = list.findIndex((x) => String(x?.id) === String(nextItem.id));
  const next = idx >= 0 ? list.map((x, i) => (i === idx ? { ...x, ...nextItem } : x)) : [...list, nextItem];
  writeLocalList(key, next);
  emitChanged(key);
  return nextItem;
}

function deleteLocalOnly(key: string, id: any) {
  const list = readLocalList(key);
  writeLocalList(key, list.filter((x) => String(x?.id) !== String(id)));
  emitChanged(key);
  return true;
}

async function dbAdd(key: string, item: any): Promise<any> {
  const now = new Date().toISOString();
  const nextItem = { ...(item || {}) };
  if (!nextItem.createdAt) nextItem.createdAt = now;
  if (!nextItem.updatedAt) nextItem.updatedAt = now;
  if (key === 'workOrders' && !nextItem.activityAt) nextItem.activityAt = getWorkOrderActivityAt(nextItem) || now;
  if (key === 'workOrders' && !/^(closed|cancelled|canceled|void|refunded|deleted|archived)$/i.test(String(nextItem.status || '')) && !nextItem.checkoutDate && !nextItem.pickedUpAt && !nextItem.clientPickupDate && !nextItem.workflowStage && !nextItem.repairStatus && !nextItem.statusUpdate) {
    nextItem.workflowStage = 'Checked in';
    nextItem.workflowUpdatedAt = now;
  }
  if (!nextItem.id) nextItem.id = await nextLegacyId(key).catch(() => undefined);
  return cloudDbInsert(key, nextItem);
}

async function dbUpdate(key: string, a: any, b?: any): Promise<any> {
  const incoming = typeof b !== 'undefined' ? b : a;
  const targetId = typeof b !== 'undefined' ? a : incoming?.id;
  const list = readLocalList(key);
  const previous = list.find((it) => String(it?.id) === String(targetId));
  const now = new Date().toISOString();
  const updated = { ...(previous || {}), ...(incoming || {}), id: targetId, updatedAt: now };
  if (key === 'workOrders') updated.activityAt = computeWorkOrderActivityAt(previous, updated, now);
  return cloudDbUpsert(key, updated);
}

async function dbCount(key: string, q: any): Promise<number> {
  const rows = readLocalList(key);
  return rows.filter((it) => matchesDbQuery(it, q)).length;
}

async function dbFind(key: string, q: any): Promise<any[]> {
  const rows = readLocalList(key);
  return rows.filter((it) => matchesDbQuery(it, q));
}

function openModalApi(method: string) {
  return async (payload?: any) => {
    const type = API_TO_MODAL[method];
    if (!type) return null;
    if (payload !== undefined) storeWindowPayload(type, payload);
    dispatchOpenModal(type, payload);
    return { ok: true };
  };
}

function downloadText(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportCurrentBackup() {
  const keys = Object.keys(CLOUD_TABLE_BY_KEY).filter((key) => key !== 'systemLogs');
  const collections: Record<string, any[]> = {};
  for (const key of keys) {
    collections[key] = await cloudDbGet(key).catch(() => readLocalList(key));
  }
  const payload = {
    source: 'GadgetBoy POS Mobile',
    timestamp: new Date().toISOString(),
    dataComplete: true,
    collections,
  };
  downloadText(`GB-POS-Mobile-Backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
  return { ok: true };
}

function setupRealtime() {
  if (!cloudSession?.shopId) return;
  if (realtimeChannel) {
    try {
      supabase.removeChannel(realtimeChannel);
    } catch {
      // ignore
    }
  }
  realtimeChannel = supabase.channel(`gbpos-mobile-${cloudSession.shopId}`);
  for (const [key, table] of Object.entries(CLOUD_TABLE_BY_KEY)) {
    realtimeChannel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `shop_id=eq.${cloudSession.shopId}` },
      (payload: any) => {
        if (payload.eventType === 'DELETE') {
          const deletedId = normalizeCloudId(payload.old);
          if (deletedId !== null) writeLocalList(key, readLocalList(key).filter((row) => String(row?.id) !== String(deletedId)));
          emitChanged(key, { id: deletedId, deleted: true });
          return;
        }
        if (!payload.new) return;
        const changed = { ...fromCloudRow(key, payload.new), cloudUpdatedAt: cloudDate(payload.new.updated_at), cloudCursorId: String(payload.new.id || '') };
        const existing = readLocalList(key);
        const merged = mergeIncrementalRows(existing, [changed], mobilePendingIds(key), {
          terminal: key === 'workOrders' ? isTerminalMobileWorkOrder : undefined,
        });
        writeLocalList(key, merged);
        emitChanged(key, changed);
      },
    );
  }
  realtimeChannel.subscribe();
}

function makeApi() {
  const api: any = {
    getAppInfo: async () => ({ version: __APP_VERSION__, platform: 'android', arch: 'mobile-webview' }),
    storageGetInfo: async () => ({ ok: true, configured: true, dataRoot: 'Supabase cloud + Android local cache' }),
    storageEnsure: async () => ({ ok: true, configured: true, dataRoot: 'Supabase cloud + Android local cache', isFirstRun: false }),
    runDiagnostics: async () => ({
      ok: true,
      results: [
        { name: 'Mobile runtime', ok: true },
        { name: 'Supabase session', ok: !!cloudSession?.shopId },
      ],
    }),
    cloudSetSession: async (payload: any) => {
      const accessToken = String(payload?.accessToken || '').trim();
      const shopId = String(payload?.shopId || '').trim();
      if (!accessToken || !shopId) {
        cloudSession = null;
        return { ok: false, error: 'Missing cloud session values.' };
      }
      cloudSession = {
        shopId,
        accessToken,
        supabaseUrl: payload?.supabaseUrl,
        supabasePublishableKey: payload?.supabasePublishableKey,
      };
      setupRealtime();
      await drainPending();
      return {
        ok: true,
        counts: {
          customers: readLocalList('customers').length,
          workOrders: readLocalList('workOrders').length,
          sales: readLocalList('sales').length,
        },
        pendingSync: mobilePendingIds('workOrders').size + mobilePendingIds('sales').size,
      };
    },
    cloudClearSession: async () => {
      cloudSession = null;
      if (realtimeChannel) {
        try {
          await supabase.removeChannel(realtimeChannel);
        } catch {
          // ignore
        }
      }
      realtimeChannel = null;
      return { ok: true };
    },
    cloudSyncCollection: (key: string, options?: { bootstrapLimit?: number }) => syncMobileCollection(key, options),
    cloudGetSyncStatus: async () => ({ ok: !!cloudSession?.shopId, ...readMobileSyncState() }),
    getCustomers: (opts?: SortOptions) => Promise.resolve(readCachedList('customers', opts)),
    addCustomer: (item: any) => dbAdd('customers', item),
    findCustomers: (q: any) => dbFind('customers', q),
    getWorkOrders: (opts?: SortOptions) => Promise.resolve(readCachedList('workOrders', opts)),
    addWorkOrder: (item: any) => dbAdd('workOrders', item),
    findWorkOrders: (q: any) => dbFind('workOrders', q),
    getDeviceCategories: () => Promise.resolve(readCachedList('deviceCategories')),
    addDeviceCategory: (item: any) => dbAdd('deviceCategories', item),
    getProductCategories: () => Promise.resolve(readCachedList('productCategories')),
    addProductCategory: (item: any) => dbAdd('productCategories', item),
    update: (key: string, item: any) => dbUpdate(key, item),
    dbGet: (key: string, opts?: SortOptions) => Promise.resolve(readCachedList(key, opts)),
    dbCount,
    dbAdd,
    dbUpdate,
    dbDelete: (key: string, id: any) => cloudDbDelete(key, id),
    deleteFromCollection: (key: string, id: any) => cloudDbDelete(key, id),
    dbResetAll: async () => ({ ok: false, error: 'Database reset is disabled on Android.' }),
    backupExport: exportCurrentBackup,
    backupExportPayload: async (payload: any) => {
      downloadText(`GB-POS-Export-${Date.now()}.json`, JSON.stringify(payload, null, 2));
      return { ok: true };
    },
    backupExportPayloadNamed: async (payload: any, label?: string) => {
      downloadText(`${label || 'GB-POS-Export'}-${Date.now()}.json`, JSON.stringify(payload, null, 2));
      return { ok: true };
    },
    backupImport: async () => ({ ok: false, error: 'Restore is not available in the Android app. Use the desktop import tool.' }),
    backupPickAndRead: async () => ({ ok: false, canceled: true, error: 'File restore is not available in the Android app.' }),
    runBatchOut: async () => {
      const result = await exportCurrentBackup();
      if (result?.ok === false) return result;
      return { ...result, ...recordMobileBatchOut((readLocalList('eodSettings')[0] || {}).batchOutTime) };
    },
    getBatchOutInfo: async () => ensureMobileBatchOut(),
    serverSyncGetConfig: async () => ({ ok: true, config: { enabled: false, autoSync: true } }),
    serverSyncSetConfig: async () => ({ ok: false, error: 'Server/NAS sync is replaced by Supabase on Android.' }),
    serverSyncBrowse: async () => ({ ok: false, canceled: true }),
    serverSyncTest: async () => ({ ok: true }),
    serverSyncNow: async () => ({ ok: true, action: 'noop' }),
    serverBackupNow: async () => exportCurrentBackup(),
    serverSyncStatus: async () => ({ ok: true, config: { enabled: false } }),
    createEncryptedBackup: async (backupData: any) => ({ ok: true, data: backupData }),
    restoreEncryptedBackup: async () => ({ ok: false, error: 'Encrypted restore is desktop-only.' }),
    getLastBackupPath: async () => '',
    exportHtml: async (html: string, filenameBase?: string) => {
      downloadText(`${filenameBase || 'gbpos-export'}.html`, html, 'text/html');
      return { ok: true };
    },
    exportPdf: async (html: string, filenameBase?: string) => {
      downloadText(`${filenameBase || 'gbpos-export'}.html`, html, 'text/html');
      return { ok: true, warning: 'Android exports printable HTML; use system print to save PDF.' };
    },
    openInteractiveHtml: async (html: string) => {
      const win = window.open('', '_blank');
      if (win) {
        win.document.open();
        win.document.write(html);
        win.document.close();
      }
      return { ok: !!win };
    },
    openUrl: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
      return { ok: true };
    },
    openRepairTutorial: async (payload: any) => {
      dispatchOpenModal('repairTutorial', payload);
      return { ok: true };
    },
    scrapePartUrl: async (rawUrl: string) => {
      const url = normalizePartOrderUrl(rawUrl);
      if (!url) return { ok: false, error: 'Missing URL.' };
      if (Capacitor.getPlatform() !== 'android') return null;
      const readFallback = async () => {
        if (!CapacitorHttp?.get) return null;
        const parsed = new URL(url);
        const suffix = `${parsed.host}${parsed.pathname}${parsed.search}`;
        const source = await Promise.any([
          `https://r.jina.ai/https://${suffix}`,
          `https://r.jina.ai/http://${suffix}`,
        ].map(async (readerUrl) => {
          const readerRes = await CapacitorHttp.get({
            url: readerUrl,
            responseType: 'text',
            connectTimeout: 25000,
            readTimeout: 25000,
            headers: { Accept: 'text/plain', 'User-Agent': 'GadgetBoy-POS/1.0 product metadata reader' },
          });
          if (readerRes.status < 200 || readerRes.status >= 300) throw new Error(`Product reader failed (${readerRes.status}).`);
          return typeof readerRes.data === 'string' ? readerRes.data : JSON.stringify(readerRes.data || '');
        }));
        return extractPartMetadataFromReader(source, url);
      };
      try {
        if (CapacitorHttp?.get) {
          const nativeRes = await CapacitorHttp.get({
            url,
            responseType: 'text',
            connectTimeout: 12000,
            readTimeout: 12000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36 GBPOS/1.0',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          });
          if (nativeRes.status < 200 || nativeRes.status >= 300) {
            return await readFallback() || { ok: false, url, vendor: derivePartVendorFromUrl(url), error: `HTTP ${nativeRes.status}` };
          }
          const html = typeof nativeRes.data === 'string' ? nativeRes.data : JSON.stringify(nativeRes.data || '');
          const metadata = extractPartMetadataFromHtml(html, url);
          return metadata.ok ? metadata : await readFallback() || metadata;
        }
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) return { ok: false, url, vendor: derivePartVendorFromUrl(url), error: `HTTP ${res.status}` };
        const html = await res.text();
        return extractPartMetadataFromHtml(html, url);
      } catch (error: any) {
        try {
          return await readFallback() || { ok: false, url, vendor: derivePartVendorFromUrl(url), error: error?.message || 'Could not scrape URL from this device.' };
        } catch {
          return { ok: false, url, vendor: derivePartVendorFromUrl(url), error: error?.message || 'Could not scrape URL from this device.' };
        }
      }
    },
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
      return { ok: true };
    },
    emailGetConfig: async () => {
      const status = await getCloudEmailStatus(cloudSession?.shopId || '');
      return {
        ok: status.ok,
        hasAppPassword: status.configured,
        fromEmail: status.fromEmail || 'gadgetboysc@gmail.com',
        fromName: status.fromName || 'GadgetBoy Repair & Retail',
        bodyTemplate: null,
        error: status.error,
      };
    },
    emailSetGmailAppPassword: async () => ({ ok: false, error: 'The Gmail App Password is managed securely in Supabase Edge Function secrets.' }),
    emailSetFromName: async () => ({ ok: true }),
    emailSetBodyTemplate: async () => ({ ok: true }),
    emailClearGmailAppPassword: async () => ({ ok: true }),
    emailSendQuoteHtml: async (payload: any) => sendCloudEmail({
      shopId: cloudSession?.shopId || '',
      to: String(payload?.to || ''),
      subject: String(payload?.subject || 'Gadgetboy Quote'),
      text: String(payload?.bodyText || ''),
      attachments: [{
        filename: String(payload?.filename || 'gadgetboy-quote.html'),
        content: String(payload?.html || ''),
        contentType: 'text/html; charset=utf-8',
      }],
    }),
    emailSendQuotePdf: async (payload: any) => {
      const requested = String(payload?.filename || 'gadgetboy-quote.pdf');
      const htmlFilename = requested.replace(/\.pdf$/i, '') + '.html';
      return sendCloudEmail({
        shopId: cloudSession?.shopId || '',
        to: String(payload?.to || ''),
        subject: String(payload?.subject || 'Gadgetboy Quote'),
        text: String(payload?.bodyText || ''),
        attachments: [{
          filename: htmlFilename,
          content: String(payload?.html || ''),
          contentType: 'text/html; charset=utf-8',
        }],
      });
    },
    emailSendReportCsv: async (payload: any) => sendCloudEmail({
      shopId: cloudSession?.shopId || '',
      to: String(payload?.to || ''),
      subject: String(payload?.subject || 'GadgetBoy Report'),
      text: String(payload?.bodyText || ''),
      attachments: [{
        filename: String(payload?.filename || 'gadgetboy-report.csv'),
        content: String(payload?.csv || ''),
        contentType: 'text/csv; charset=utf-8',
      }],
    }),
    emailSendReportHtml: async (payload: any) => sendCloudEmail({
      shopId: cloudSession?.shopId || '',
      to: String(payload?.to || ''),
      subject: String(payload?.subject || 'Daily batch report'),
      text: String(payload?.bodyText || ''),
      html: payload?.html ? String(payload.html) : undefined,
    }),
    getFullScreen: async () => false,
    setFullScreen: async () => ({ ok: true }),
    toggleFullScreen: async () => ({ ok: true }),
    closeSelfWindow: async () => ({ ok: true }),
    focusMainWindow: async () => ({ ok: true }),
    notifyCustomerReceiptReady: () => undefined,
    notifyCustomerReceiptQrFailed: (_message: string) => undefined,
    notifyConsultSheetReady: () => undefined,
    sendRepairSelected: () => undefined,
    pickSaleProduct: async () => null,
    _emitCheckoutSave: () => undefined,
    _emitCheckoutCancel: () => undefined,
    _emitSaleProductSelected: () => undefined,
    _emitCustomBuildItemSave: () => undefined,
    _emitCustomBuildItemCancel: () => undefined,
    qrGetStatusUrl: async (type: 'repair' | 'sale' | 'consult', id: number) => {
      try {
        const url = await ensureCloudQrStatusUrl(type, id);
        return url ? { ok: true, url, cloud: true } : { ok: false, error: 'Missing record id.' };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    qrResolveStatusToken: async (token: string) => {
      try {
        const resolved = await resolveCloudQrStatusToken(token);
        return { ok: true, ...resolved };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    qrGetDataUrl: async () => ({ ok: false, error: 'QR generation is desktop-only.' }),
    qrGetServerInfo: async () => ({ ok: true, hostUrl: getHostedAppUrl(), ipUrl: getHostedAppUrl() }),
  };

  for (const method of Object.keys(API_TO_MODAL)) {
    api[method] = openModalApi(method);
  }

  const eventMethods: Record<string, string> = {
    onWorkOrdersChanged: 'workorders:changed',
    onCustomersChanged: 'customers:changed',
    onDeviceCategoriesChanged: 'deviceCategories:changed',
    onTechniciansChanged: 'technicians:changed',
    onProductCategoriesChanged: 'productCategories:changed',
    onProductsChanged: 'products:changed',
    onPurchaseOrdersChanged: 'purchaseOrders:changed',
    onSettingsChanged: 'settings:changed',
    onRepairTypesChanged: 'repairTypes:changed',
    onRepairCategoriesChanged: 'repairCategories:changed',
    onSalesChanged: 'sales:changed',
    onQuotesChanged: 'quotes:changed',
    onPartSourcesChanged: 'partSources:changed',
    onCalendarEventsChanged: 'calendarEvents:changed',
    onCalendarNotesChanged: 'calendarNotes:changed',
    onNotificationsChanged: 'notifications:changed',
    onNotificationSettingsChanged: 'notificationSettings:changed',
    onTimeEntriesChanged: 'timeEntries:changed',
  };
  for (const [method, event] of Object.entries(eventMethods)) {
    api[method] = (cb: () => void) => addListener(event, cb);
  }

  return api;
}

export function installMobileApi() {
  if ((window as any).api?.__gbposMobile) return;
  (window as any).api = { ...makeApi(), __gbposMobile: true };
  window.addEventListener('online', () => {
    drainPending().catch(() => undefined);
  });
}

export function installMobilePreviewApi() {
  if (!import.meta.env.DEV) return;
  const params = new URLSearchParams(window.location.search);
  if (!params.get('mobileWindowPreview')) return;
  const api = (window as any).api || {};
  const empty = async () => [];
  const unchanged = async (...args: any[]) => args[1] ?? args[0] ?? { ok: true };
  Object.assign(api, {
    cloudSetSession: async () => ({ ok: true, preview: true }),
    cloudClearSession: async () => ({ ok: true, preview: true }),
    dbGet: empty,
    dbCount: async () => 0,
    dbAdd: unchanged,
    dbUpdate: unchanged,
    dbDelete: async () => ({ ok: true, preview: true }),
    deleteFromCollection: async () => ({ ok: true, preview: true }),
    getCustomers: empty,
    findCustomers: empty,
    getWorkOrders: empty,
    findWorkOrders: empty,
    getDeviceCategories: empty,
    getProductCategories: empty,
    getBatchOutInfo: async () => ({ ok: true, preview: true }),
    emailGetConfig: async () => ({ ok: true, hasAppPassword: false, fromEmail: '', fromName: 'GadgetBoy Repair & Retail' }),
  });
  (window as any).api = api;
}
