const { contextBridge, ipcRenderer } = require('electron');
const IS_TEST_ENVIRONMENT = (process.env.GBPOS_TEST_ENVIRONMENT || process.env.GBPOS_SEED_TEST_DATA || '').toString().trim() === '1';

// Renderer-side caching (per-window) to avoid repeatedly transferring large collections
// across IPC during autosave bursts.
let customersCache: any[] | null = null;
let customersInFlight: Promise<any[]> | null = null;

function getCustomersCached(): Promise<any[]> {
  try {
    if (customersCache) return Promise.resolve(customersCache);
    if (customersInFlight) return customersInFlight;
    const p = ipcRenderer.invoke('db-get', 'customers')
      .then((list: any) => {
        customersCache = Array.isArray(list) ? list : [];
        customersInFlight = null;
        return customersCache;
      })
      .catch((e: any) => {
        customersInFlight = null;
        throw e;
      });
    customersInFlight = p;
    return p;
  } catch (e: any) {
    customersInFlight = null;
    return Promise.reject(e);
  }
}

// Invalidate cache whenever customers collection changes.
try {
  ipcRenderer.on('customers:changed', () => {
    customersCache = null;
    customersInFlight = null;
  });
} catch {}

contextBridge.exposeInMainWorld('api', {
  __GB_POS_TEST_ENVIRONMENT__: IS_TEST_ENVIRONMENT,
  getAppInfo: (): Promise<{ version: string; platform: string; arch: string }> => ipcRenderer.invoke('app:getInfo'),
  gidgetLocalStatus: (): Promise<any> => ipcRenderer.invoke('gidget:localStatus'),
  gidgetLocalSetup: (): Promise<any> => ipcRenderer.invoke('gidget:localSetup'),
  gidgetLocalGenerate: (payload: any): Promise<any> => ipcRenderer.invoke('gidget:localGenerate', payload),
  gidgetLocalCancel: (): Promise<any> => ipcRenderer.invoke('gidget:localCancel'),
  gidgetLocalRemove: (): Promise<any> => ipcRenderer.invoke('gidget:localRemove'),
  onGidgetModelProgress: (cb: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => cb(progress);
    ipcRenderer.on('gidget:model-progress', handler);
    return () => ipcRenderer.removeListener('gidget:model-progress', handler);
  },
  onGidgetLocalToken: (cb: (payload: { requestId: string; text: string }) => void) => {
    const handler = (_event: any, payload: { requestId: string; text: string }) => cb(payload);
    ipcRenderer.on('gidget:localToken', handler);
    return () => ipcRenderer.removeListener('gidget:localToken', handler);
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('os:openUrl', url),
  // Storage / diagnostics
  storageGetInfo: (): Promise<any> => ipcRenderer.invoke('storage:getInfo'),
  storageEnsure: (): Promise<any> => ipcRenderer.invoke('storage:ensure'),
  runDiagnostics: (): Promise<any> => ipcRenderer.invoke('diagnostics:run'),
  pickRepairItem: (context?: { deviceCategory?: string; deviceName?: string; deviceModel?: string }): Promise<any> => ipcRenderer.invoke('pick-repair-item', context),
  getCustomers: (opts?: { limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }): Promise<any[]> => {
    if (opts) return ipcRenderer.invoke('db-get', 'customers', opts);
    return getCustomersCached();
  },
  addCustomer: (c: any): Promise<any> => ipcRenderer.invoke('db-add', 'customers', c),
  findCustomers: (q: any): Promise<any[]> => ipcRenderer.invoke('db-find', 'customers', q),
  getWorkOrders: (opts?: { limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }): Promise<any[]> => ipcRenderer.invoke('db-get', 'workOrders', opts),
  addWorkOrder: (w: any): Promise<any> => ipcRenderer.invoke('db-add', 'workOrders', w),
  findWorkOrders: (q: any): Promise<any[]> => ipcRenderer.invoke('db-find', 'workOrders', q),
  update: (key: string, item: any): Promise<any> => ipcRenderer.invoke('db-update', key, item),
  openNewWorkOrder: (payload: any): Promise<any> => ipcRenderer.invoke('open-new-workorder', payload),
  openDeviceCategories: (): Promise<any> => ipcRenderer.invoke('open-device-categories'),
  openRepairCategories: (payload?: any): Promise<any> => ipcRenderer.invoke('open-repair-categories', payload),
  openRepairTutorial: (payload: any): Promise<any> => ipcRenderer.invoke('open-repair-tutorial', payload),
  openCalendar: (): Promise<any> => ipcRenderer.invoke('open-calendar'),
  openClockIn: (): Promise<any> => ipcRenderer.invoke('open-clock-in'),
  openQuoteGenerator: (): Promise<any> => ipcRenderer.invoke('open-quote-generator'),
  openEod: (): Promise<any> => ipcRenderer.invoke('open-eod'),
  openProducts: (): Promise<any> => ipcRenderer.invoke('open-products'),
  openInventory: (): Promise<any> => ipcRenderer.invoke('open-inventory'),
  openVendors: (): Promise<any> => ipcRenderer.invoke('open-vendors'),
  openTechnicians: (): Promise<any> => ipcRenderer.invoke('open-technicians'),
  openCatalogSettings: (tab?: 'inventory' | 'repairs'): Promise<any> => ipcRenderer.invoke('open-catalog-settings', tab),
  openWorkOrderRepairPicker: (): Promise<any> => ipcRenderer.invoke('open-workorder-repair-picker'),
  openCustomerOverview: (customerId: number): Promise<any> => ipcRenderer.invoke('open-customer-overview', customerId),
  openNewSale: (payload: any): Promise<any> => ipcRenderer.invoke('open-new-sale', payload),
  openQuickSale: (): Promise<any> => ipcRenderer.invoke('open-quick-sale'),
  openConsultation: (payload?: any): Promise<any> => ipcRenderer.invoke('open-consultation', payload),
  openGameMenu: (): Promise<any> => ipcRenderer.invoke('open-game-menu'),
  openCheckout: (payload: { amountDue: number }): Promise<any> => ipcRenderer.invoke('workorder:openCheckout', payload),
  completeCheckout: (result: any): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('workorder:checkout:complete', result),
  openDevMenu: (): Promise<any> => ipcRenderer.invoke('open-dev-menu'),
  devOpenUserDataFolder: (): Promise<any> => ipcRenderer.invoke('dev:openUserDataFolder'),
  devBackupDatabase: (): Promise<any> => ipcRenderer.invoke('dev:backupDb'),
  devEnvironmentInfo: (): Promise<any> => ipcRenderer.invoke('dev:environmentInfo'),
  devOpenAllDevTools: (): Promise<any> => ipcRenderer.invoke('dev:openAllDevTools'),
  openDataTools: (): Promise<any> => ipcRenderer.invoke('open-data-tools'),
  openClearDatabase: (): Promise<any> => ipcRenderer.invoke('open-clear-database'),
  backupPickAndRead: (): Promise<any> => ipcRenderer.invoke('backup:pickAndRead'),
  backupExportPayload: (payload: any): Promise<any> => ipcRenderer.invoke('backup:exportPayload', payload),
  backupExportPayloadNamed: (payload: any, label?: string): Promise<any> => ipcRenderer.invoke('backup:exportPayloadNamed', payload, label),
  runBatchOut: (): Promise<any> => ipcRenderer.invoke('backup:runBatchOut'),
  getBatchOutInfo: (): Promise<any> => ipcRenderer.invoke('backup:getBatchOutInfo'),
  backupExport: (): Promise<any> => ipcRenderer.invoke('backup:export'),
  backupImport: (): Promise<any> => ipcRenderer.invoke('backup:import'),
  exportHtml: (html: string, filenameBase?: string): Promise<any> => ipcRenderer.invoke('export-html', html, filenameBase),
  exportPdf: (html: string, filenameBase?: string): Promise<any> => ipcRenderer.invoke('export-pdf', html, filenameBase),
  openInteractiveHtml: (html: string, title?: string): Promise<any> => ipcRenderer.invoke('open-interactive-html', html, title),
  // Email
  emailGetConfig: (): Promise<any> => ipcRenderer.invoke('email:getConfig'),
  emailSetGmailAppPassword: (appPassword: string, fromName?: string): Promise<any> => ipcRenderer.invoke('email:setGmailAppPassword', appPassword, fromName),
  emailSetFromName: (fromName: string): Promise<any> => ipcRenderer.invoke('email:setFromName', fromName),
  emailSetBodyTemplate: (bodyTemplate: string): Promise<any> => ipcRenderer.invoke('email:setBodyTemplate', bodyTemplate),
  emailClearGmailAppPassword: (): Promise<any> => ipcRenderer.invoke('email:clearGmailAppPassword'),
  emailSendQuoteHtml: (payload: any): Promise<any> => ipcRenderer.invoke('email:sendQuoteHtml', payload),
  emailSendQuotePdf: (payload: any): Promise<any> => ipcRenderer.invoke('email:sendQuotePdf', payload),
  emailSendReportCsv: (payload: any): Promise<any> => ipcRenderer.invoke('email:sendReportCsv', payload),
  emailSendReportHtml: (payload: any): Promise<any> => ipcRenderer.invoke('email:sendReportHtml', payload),
  // OS helpers
  openFile: (filePath: string): Promise<any> => ipcRenderer.invoke('os:openFile', filePath),
  openUrl: (url: string): Promise<any> => ipcRenderer.invoke('os:openUrl', url),
  openReporting: (): Promise<any> => ipcRenderer.invoke('open-reporting'),
  openReportEmail: (payload: any): Promise<any> => ipcRenderer.invoke('open-report-email', payload),
  openCustomBuildItem: (payload: any): Promise<any> => ipcRenderer.invoke('customBuild:openItem', payload),
  openCharts: (): Promise<any> => ipcRenderer.invoke('open-charts'),
  openNotifications: (): Promise<any> => ipcRenderer.invoke('open-notifications'),
  openNotificationSettings: (): Promise<any> => ipcRenderer.invoke('open-notification-settings'),
  openCloverSettings: (): Promise<any> => ipcRenderer.invoke('open-clover-settings'),
  cloverGetConfig: (): Promise<any> => ipcRenderer.invoke('clover:rest:getConfig'),
  cloverSaveConfig: (data: any): Promise<any> => ipcRenderer.invoke('clover:saveConfig', data),
  cloverSetAccessToken: (token: string): Promise<any> => ipcRenderer.invoke('clover:setAccessToken', token),
  cloverTestConnection: (): Promise<any> => ipcRenderer.invoke('clover:testConnection'),
  cloverTestLocalConnection: (): Promise<any> => ipcRenderer.invoke('clover:testLocalConnection'),
  cloverLocalCharge: (payload: any): Promise<any> => ipcRenderer.invoke('clover:localCharge', payload),
  cloverChargeCard: (payload: any): Promise<any> => ipcRenderer.invoke('clover:chargeCard', payload),
  cloverCashSale: (payload: any): Promise<any> => ipcRenderer.invoke('clover:cashSale', payload),
  openTwilioSettings: (): Promise<any> => ipcRenderer.invoke('open-twilio-settings'),
  twilioGetConfig: (): Promise<any> => ipcRenderer.invoke('twilio:getConfig'),
  twilioSetConfig: (patch: any): Promise<any> => ipcRenderer.invoke('twilio:setConfig', patch),
  twilioSendSms: (payload: any): Promise<any> => ipcRenderer.invoke('twilio:sendSms', payload),
  twilioGetMessages: (customerId: number): Promise<any> => ipcRenderer.invoke('twilio:getMessages', customerId),
  twilioLogMessage: (msg: any): Promise<any> => ipcRenderer.invoke('twilio:logMessage', msg),
  openReleaseForm: (payload: any): Promise<any> => ipcRenderer.invoke('open-release-form', payload),
  notifyReleaseFormReady: (): void => ipcRenderer.send('release-form:ready'),
  openCustomerReceipt: (payload: any): Promise<any> => ipcRenderer.invoke('open-customer-receipt', payload),
  notifyCustomerReceiptReady: (): void => ipcRenderer.send('customer-receipt:ready'),
  notifyCustomerReceiptQrFailed: (message: string): void => ipcRenderer.send('customer-receipt:qr-failed', message),
  openConsultSheet: (payload: any): Promise<any> => ipcRenderer.invoke('open-consult-sheet', payload),
  notifyConsultSheetReady: (): void => ipcRenderer.send('consult-sheet:ready'),
  openProductForm: (payload: any): Promise<any> => ipcRenderer.invoke('open-product-form', payload),
  pickSaleProduct: (): Promise<any> => ipcRenderer.invoke('pick-sale-product'),
  getDeviceCategories: (): Promise<any[]> => ipcRenderer.invoke('db-get', 'deviceCategories'),
  addDeviceCategory: (c: any): Promise<any> => ipcRenderer.invoke('db-add', 'deviceCategories', c),
  getProductCategories: (): Promise<any[]> => ipcRenderer.invoke('db-get', 'productCategories'),
  addProductCategory: (c: any): Promise<any> => ipcRenderer.invoke('db-add', 'productCategories', c),
  deleteFromCollection: (key: string, id: number): Promise<boolean> => ipcRenderer.invoke('db-delete', key, id),
  dbGet: (key: string, opts?: { limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }): Promise<any[]> => {
    if (String(key) === 'customers' && !opts) return getCustomersCached();
    return ipcRenderer.invoke('db-get', key, opts);
  },
  dbCount: (key: string, q: any): Promise<number> => ipcRenderer.invoke('db-count', key, q),
  dbAdd: (key: string, item: any): Promise<any> => ipcRenderer.invoke('db-add', key, item),
  dbUpdate: (key: string, id: any, item: any): Promise<any> => ipcRenderer.invoke('db-update', key, id, item),
  dbDelete: (key: string, id: any): Promise<boolean> => ipcRenderer.invoke('db-delete', key, id),
  dbResetAll: (): Promise<any> => ipcRenderer.invoke('db-reset-all'),
  cloudSetSession: (payload: any): Promise<any> => ipcRenderer.invoke('cloud:setSession', payload),
  cloudClearSession: (): Promise<any> => ipcRenderer.invoke('cloud:clearSession'),
  cloudCollectionChanged: (key: string): Promise<any> => ipcRenderer.invoke('cloud:collectionChanged', key),
  cloudSyncCollection: (key: string, options?: { bootstrapLimit?: number }): Promise<any> => ipcRenderer.invoke('cloud:syncCollection', key, options),
  cloudGetSyncStatus: (): Promise<any> => ipcRenderer.invoke('cloud:getSyncStatus'),
  sendRepairSelected: (repair: any) => ipcRenderer.send('repair-selected', repair),
  _emitCheckoutSave: (result: any) => ipcRenderer.send('workorder:checkout:save', result),
  _emitCheckoutCancel: () => ipcRenderer.send('workorder:checkout:cancel'),
  _emitCustomBuildItemSave: (result: any) => ipcRenderer.send('customBuild:item:save', result),
  _emitCustomBuildItemCancel: () => ipcRenderer.send('customBuild:item:cancel'),
  onWorkOrdersChanged: (cb: (record?: any) => void) => {
    const handler = (_event: any, record?: any) => cb(record);
    ipcRenderer.on('workorders:changed', handler);
    return () => ipcRenderer.removeListener('workorders:changed', handler);
  },
  onCustomersChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('customers:changed', handler);
    return () => ipcRenderer.removeListener('customers:changed', handler);
  },
  onDeviceCategoriesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('deviceCategories:changed', handler);
    return () => ipcRenderer.removeListener('deviceCategories:changed', handler);
  },
  onTechniciansChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('technicians:changed', handler);
    return () => ipcRenderer.removeListener('technicians:changed', handler);
  },
  onProductCategoriesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('productCategories:changed', handler);
    return () => ipcRenderer.removeListener('productCategories:changed', handler);
  },
  onProductsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('products:changed', handler);
    return () => ipcRenderer.removeListener('products:changed', handler);
  },
  onRepairTypesChanged: (cb: () => void) => {
    const handler = () => cb(); ipcRenderer.on('repairTypes:changed', handler); return () => ipcRenderer.removeListener('repairTypes:changed', handler);
  },
  onRepairCategoriesChanged: (cb: () => void) => {
    const handler = () => cb(); ipcRenderer.on('repairCategories:changed', handler); return () => ipcRenderer.removeListener('repairCategories:changed', handler);
  },
  onPurchaseOrdersChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('purchaseOrders:changed', handler);
    return () => ipcRenderer.removeListener('purchaseOrders:changed', handler);
  },
  onSettingsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },
  onSalesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('sales:changed', handler);
    return () => ipcRenderer.removeListener('sales:changed', handler);
  },
  onQuotesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('quotes:changed', handler);
    return () => ipcRenderer.removeListener('quotes:changed', handler);
  },
  onPartSourcesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('partSources:changed', handler);
    return () => ipcRenderer.removeListener('partSources:changed', handler);
  },
  onCalendarEventsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('calendarEvents:changed', handler);
    return () => ipcRenderer.removeListener('calendarEvents:changed', handler);
  },
  onCalendarNotesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('calendarNotes:changed', handler);
    return () => ipcRenderer.removeListener('calendarNotes:changed', handler);
  },
  onNotificationsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('notifications:changed', handler);
    return () => ipcRenderer.removeListener('notifications:changed', handler);
  },
  onNotificationSettingsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('notificationSettings:changed', handler);
    return () => ipcRenderer.removeListener('notificationSettings:changed', handler);
  },
  onTimeEntriesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('timeEntries:changed', handler);
    return () => ipcRenderer.removeListener('timeEntries:changed', handler);
  },
  _emitSaleProductSelected: (payload: any) => ipcRenderer.send('sale-product-selected', payload),
  // window controls
  getFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:getFullScreen'),
  setFullScreen: (flag: boolean): Promise<any> => ipcRenderer.invoke('window:setFullScreen', flag),
  toggleFullScreen: (): Promise<any> => ipcRenderer.invoke('window:toggleFullScreen'),

  // Safe window helpers
  closeSelfWindow: (opts?: { focusMain?: boolean }): Promise<any> => ipcRenderer.invoke('window:closeSelf', opts),
  focusMainWindow: (): Promise<any> => ipcRenderer.invoke('window:focusMain'),
  
  // backup & restore
  openBackup: (): Promise<any> => ipcRenderer.invoke('open-backup'),
  // server/NAS sync (offline-first)
  serverSyncGetConfig: (): Promise<any> => ipcRenderer.invoke('server-sync-get-config'),
  serverSyncSetConfig: (patch: any): Promise<any> => ipcRenderer.invoke('server-sync-set-config', patch),
  serverSyncBrowse: (opts?: { basePath?: string }): Promise<any> => ipcRenderer.invoke('server-sync-browse', opts),
  serverSyncTest: (): Promise<any> => ipcRenderer.invoke('server-sync-test'),
  serverSyncNow: (direction?: 'auto' | 'push' | 'pull'): Promise<any> => ipcRenderer.invoke('server-sync-sync-now', direction),
  serverBackupNow: (label?: string): Promise<any> => ipcRenderer.invoke('server-sync-backup-now', label),
  serverSyncStatus: (): Promise<any> => ipcRenderer.invoke('server-sync-status'),
  createEncryptedBackup: (backupData: any, password: string): Promise<any> => ipcRenderer.invoke('create-encrypted-backup', backupData, password),
  restoreEncryptedBackup: (password: string): Promise<any> => ipcRenderer.invoke('restore-encrypted-backup', password),
  getLastBackupPath: (): Promise<string> => ipcRenderer.invoke('get-last-backup-path'),
  // QR Code status server
  qrGetStatusUrl: (type: 'repair' | 'sale' | 'consult', id: number): Promise<{ ok: boolean; url?: string; error?: string }> => ipcRenderer.invoke('qr:getStatusUrl', type, id),
  qrGetDataUrl: (url: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> => ipcRenderer.invoke('qr:getDataUrl', url),
  qrGetServerInfo: (): Promise<{ ok: boolean; hostname?: string; ip?: string; port?: number; hostUrl?: string; ipUrl?: string; error?: string }> => ipcRenderer.invoke('qr:getServerInfo'),
});
