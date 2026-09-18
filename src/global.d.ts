export {};

declare module '*.css';

declare global {
  const __APP_VERSION__: string;

  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
    readonly VITE_SHOP_LOGIN_USERNAME?: string;
    readonly VITE_SHOP_LOGIN_EMAIL?: string;
    readonly VITE_PUBLIC_APP_URL?: string;
    readonly VITE_DURANT_LOGIN_EMAIL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    GBPosAndroid?: any;
    __GB_POS_CONFIG__?: {
      VITE_SUPABASE_URL?: string;
      VITE_SUPABASE_PUBLISHABLE_KEY?: string;
      VITE_SHOP_LOGIN_USERNAME?: string;
      VITE_SHOP_LOGIN_EMAIL?: string;
    };
  }

  // Temporary: QuoteGeneratorWindow has a legacy reference to itemsPage()
  // in the print pipeline; at runtime it is guarded by try/catch.
  // This keeps TypeScript from failing if the helper is out of scope.
  function itemsPage(): string;

  interface Window {
    api: {
    getAppInfo: () => Promise<{ version: string; platform: string; arch: string; error?: string }>;
    gidgetLocalStatus?: () => Promise<any>;
    gidgetLocalSetup?: () => Promise<any>;
    gidgetLocalGenerate?: (payload: any) => Promise<any>;
    gidgetLocalCancel?: () => Promise<any>;
    gidgetLocalRemove?: () => Promise<any>;
    onGidgetModelProgress?: (cb: (progress: any) => void) => () => void;
    onGidgetLocalToken?: (cb: (payload: { requestId: string; text: string }) => void) => () => void;
    storageGetInfo: () => Promise<{ ok: boolean; configured?: boolean; dataRoot?: string | null; recommended?: string; userData?: string; error?: string }>;
    storageEnsure: () => Promise<{ ok: boolean; configured?: boolean; dataRoot?: string; isFirstRun?: boolean; migration?: any; error?: string }>;
    runDiagnostics: () => Promise<{ ok: boolean; dataRoot?: string; results?: any[]; error?: string }>;
    getCustomers: () => Promise<any[]>;
    addCustomer: (c: any) => Promise<any>;
    findCustomers: (q: any) => Promise<any[]>;
    getWorkOrders: (opts?: { limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }) => Promise<any[]>;
    addWorkOrder: (w: any) => Promise<any>;
    findWorkOrders: (q: any) => Promise<any[]>;
    update: (key: string, item: any) => Promise<any>;
    openNewWorkOrder: (payload: any) => Promise<any>;
    openGameMenu?: () => Promise<any>;
    openDeviceCategories: () => Promise<any>;
    openRepairCategories: (payload?: any) => Promise<any>;
    openCalendar: () => Promise<any>;
    openClockIn: () => Promise<any>;
    openProducts: () => Promise<any>;
    openInventory: () => Promise<any>;
    openVendors: () => Promise<any>;
    openTechnicians: () => Promise<any>;
    openCatalogSettings: (tab?: 'inventory' | 'repairs') => Promise<any>;
    onRepairTypesChanged?: (cb: () => void) => (() => void);
    onRepairCategoriesChanged?: (cb: () => void) => (() => void);
    openWorkOrderRepairPicker: () => Promise<any>;
    openCustomerOverview: (customerId: number) => Promise<any>;
  openNewSale: (payload: any) => Promise<any>;
  openQuickSale: () => Promise<any>;
  openConsultation: (payload?: any) => Promise<any>;
  openCheckout: (payload: any) => Promise<any>;
  completeCheckout?: (result: any) => Promise<{ ok: boolean; error?: string }>;
  openEod: () => Promise<any>;
    getDeviceCategories: () => Promise<any[]>;
    addDeviceCategory: (c: any) => Promise<any>;
  getProductCategories: () => Promise<any[]>;
  addProductCategory: (c: any) => Promise<any>;
    deleteFromCollection: (key: string, id: number) => Promise<boolean>;
    dbGet: (key: string, opts?: { limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }) => Promise<any[]>;
    dbCount: (key: string, q: any) => Promise<number>;
    dbAdd: (key: string, item: any) => Promise<any>;
    dbUpdate: (key: string, id: any, item: any) => Promise<any>;
  dbDelete: (key: string, id: any) => Promise<boolean>;
    dbResetAll: () => Promise<{ ok: boolean; removed?: string[]; errors?: string[]; dataRoot?: string }>;
    cloudSetSession: (payload: any) => Promise<any>;
    cloudClearSession: () => Promise<any>;
    cloudCollectionChanged?: (key: string) => Promise<any>;
    cloudSyncCollection?: (key: string, options?: { bootstrapLimit?: number }) => Promise<any>;
    cloudGetSyncStatus?: () => Promise<{ ok: boolean; shopId?: string; lastSuccessAt?: string; lastError?: string; pendingSync?: number; collections?: Record<string, any> }>;
  sendRepairSelected: (repair: any) => void;
    openDevMenu: () => Promise<any>;
    devOpenUserDataFolder: () => Promise<any>;
    devBackupDatabase: () => Promise<any>;
    devEnvironmentInfo: () => Promise<any>;
    devOpenAllDevTools: () => Promise<any>;
  openDataTools: () => Promise<any>;
  openClearDatabase: () => Promise<any>;
  backupPickAndRead: () => Promise<any>;
  backupExportPayload: (payload: any) => Promise<any>;
  backupExportPayloadNamed: (payload: any, label?: string) => Promise<any>;
  runBatchOut: () => Promise<any>;
  getBatchOutInfo: () => Promise<{ ok: boolean; lastBackupPath?: string; lastBackupDate?: string; lastBatchOutDate?: string }>;
    backupExport: () => Promise<any>;
    backupImport: () => Promise<any>;
    // backup window & encryption helpers
    openBackup: () => Promise<any>;
    serverSyncGetConfig: () => Promise<{ ok: boolean; config?: { enabled?: boolean; serverPath?: string; serverHost?: string; serverShare?: string; serverBackupsPath?: string; autoSync?: boolean; backupToLocal?: boolean; backupToServer?: boolean; lastSyncAt?: string; lastTestAt?: string; lastOkAt?: string; lastError?: string } | any; error?: string }>;
    serverSyncSetConfig: (patch: any) => Promise<{ ok: boolean; config?: { enabled?: boolean; serverPath?: string; serverHost?: string; serverShare?: string; serverBackupsPath?: string; autoSync?: boolean; backupToLocal?: boolean; backupToServer?: boolean; lastSyncAt?: string; lastTestAt?: string; lastOkAt?: string; lastError?: string } | any; error?: string }>;
    serverSyncBrowse: (opts?: { basePath?: string }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; serverRoot?: string; error?: string }>;
    serverSyncTest: () => Promise<{ ok: boolean; serverRoot?: string; error?: string }>;
    serverSyncNow: (direction?: 'auto' | 'push' | 'pull') => Promise<{ ok: boolean; action?: 'push' | 'pull' | 'noop'; serverDbPath?: string; error?: string }>;
    serverBackupNow: (label?: string) => Promise<{ ok: boolean; localBackupPath?: string; serverBackupPath?: string; serverError?: string; error?: string }>;
    serverSyncStatus: () => Promise<{ ok: boolean; config?: any; error?: string }>;
    createEncryptedBackup: (backupData: any, password: string) => Promise<any>;
    restoreEncryptedBackup: (password: string) => Promise<any>;
    getLastBackupPath: () => Promise<string>;
    // export helpers
    exportHtml: (html: string, filenameBase?: string) => Promise<any>;
    exportPdf: (html: string, filenameBase?: string) => Promise<any>;
    openInteractiveHtml: (html: string, title?: string) => Promise<any>;
    openUrl: (url: string) => Promise<any>;
    openRepairTutorial: (payload: { normalizedUrl: string; mediaType: 'youtube' | 'direct-video' | 'webpage'; youtubeId?: string }) => Promise<any>;
    scrapePartUrl?: (url: string) => Promise<{ ok: boolean; url?: string; title?: string; price?: number; currency?: string; vendor?: string; description?: string; images?: string[]; specs?: Array<{ name: string; value: string }>; error?: string }>;
    qrGetStatusUrl: (type: 'repair' | 'sale' | 'consult', id: number) => Promise<{ ok: boolean; url?: string; error?: string }>;
    qrResolveStatusToken: (token: string) => Promise<{ ok: boolean; token?: any; type?: 'repair' | 'sale' | 'consult'; record?: any; customer?: any; error?: string }>;
    qrGetDataUrl: (url: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
    qrGetServerInfo: () => Promise<{ ok: boolean; hostname?: string; ip?: string; port?: number; hostUrl?: string; ipUrl?: string; error?: string }>;
    // email
    emailGetConfig: () => Promise<{ ok: boolean; fromEmail?: string; fromName?: string; bodyTemplate?: string | null; hasAppPassword?: boolean; error?: string }>;
    emailSetGmailAppPassword: (appPassword: string, fromName?: string) => Promise<{ ok: boolean; error?: string }>;
    emailSetFromName: (fromName: string) => Promise<{ ok: boolean; error?: string }>;
    emailSetBodyTemplate: (bodyTemplate: string) => Promise<{ ok: boolean; error?: string }>;
    emailClearGmailAppPassword: () => Promise<{ ok: boolean; error?: string }>;
    emailSendQuoteHtml: (payload: { to: string; subject: string; bodyText: string; filename: string; html: string }) => Promise<{ ok: boolean; messageId?: string | null; error?: string }>;
    emailSendReportCsv: (payload: { to: string; subject: string; bodyText: string; filename: string; csv: string }) => Promise<{ ok: boolean; messageId?: string | null; error?: string }>;
    openReporting: () => Promise<any>;
    openReportEmail: (payload: any) => Promise<any>;
    openCustomBuildItem: (payload: any) => Promise<any>;
  openCharts: () => Promise<any>;
    openNotifications: () => Promise<any>;
    openNotificationSettings: () => Promise<any>;
    openReleaseForm: (payload: any) => Promise<any>;
    openCustomerReceipt: (payload: any | { data: any; autoPrint?: boolean; silent?: boolean; autoCloseMs?: number; show?: boolean }) => Promise<any>;
    notifyCustomerReceiptReady: () => void;
    notifyCustomerReceiptQrFailed: (message: string) => void;
    openConsultSheet: (payload: any | { data: any; autoPrint?: boolean; silent?: boolean; autoCloseMs?: number; show?: boolean }) => Promise<any>;
    notifyConsultSheetReady: () => void;
  openProductForm: (payload: any) => Promise<any>;
  pickSaleProduct: () => Promise<any>;
  onSalesChanged: (cb: () => void) => () => void;
  onQuotesChanged: (cb: () => void) => () => void;
      onCustomersChanged: (cb: () => void) => () => void;
      onDeviceCategoriesChanged: (cb: () => void) => () => void;
      onPartSourcesChanged: (cb: () => void) => () => void;
  onTechniciansChanged: (cb: () => void) => () => void;
  onCalendarEventsChanged: (cb: () => void) => () => void;
  onCalendarNotesChanged: (cb: () => void) => () => void;
  onNotificationsChanged: (cb: () => void) => () => void;
  onNotificationSettingsChanged: (cb: () => void) => () => void;
  onTimeEntriesChanged: (cb: () => void) => () => void;
  onProductCategoriesChanged: (cb: () => void) => () => void;
  onProductsChanged: (cb: () => void) => () => void;
  onPurchaseOrdersChanged: (cb: () => void) => () => void;
  onSettingsChanged: (cb: () => void) => () => void;
  // window controls
  getFullScreen: () => Promise<boolean>;
  setFullScreen: (flag: boolean) => Promise<any>;
  toggleFullScreen: () => Promise<any>;

  closeSelfWindow: (opts?: { focusMain?: boolean }) => Promise<any>;
  focusMainWindow: () => Promise<any>;

  _emitCustomBuildItemSave: (result: any) => void;
  _emitCustomBuildItemCancel: () => void;
    };
  }
  declare module '*?raw' {
    const content: string;
    export default content;
  }
}
