const electron = require('electron');
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, safeStorage, Notification, session } = electron;
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { pathToFileURL } = require('url');
const os = require('os');
const nodeCrypto = require('crypto');
const { spawn } = require('child_process');
const { seedTestDataIfNeeded } = require('./seed-test-data');
const { registerGidgetLocalIpc } = require('./gidget-local');
const { resolveDownloadedInstallerPath } = require('./update-launcher');
const { createCheckoutSessionRegistry } = require('./checkout-session');
import { preserveNewerWorkflow } from '../../src/lib/workorderWorkflowSync';
import { synchronizeIncrementalCollection } from '../../src/lib/incrementalCloudSync';
import type { CloudCursor } from '../../src/lib/incrementalSync';

registerGidgetLocalIpc({ ipcMain, app });

let autoUpdater: any = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  autoUpdater = null;
}

let createSupabaseClient: any = null;
try {
  createSupabaseClient = require('@supabase/supabase-js').createClient;
} catch {
  createSupabaseClient = null;
}

// Track the main window so we can avoid accidentally closing it from renderer actions.
let mainWindow: any | null = null;
let stopQrStatusServerForUpdate: () => Promise<void> = async () => {};

function isTrustedRendererPermissionRequest(requestingUrl: string) {
  try {
    const url = new URL(String(requestingUrl || ''));
    return url.protocol === 'file:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname));
  } catch {
    return false;
  }
}

function isExternalUrl(url: string, sourceUrl?: string) {
  try {
    const u = String(url || '').trim();
    if (!u) return false;

    // Always treat mailto/tel as external
    if (/^(mailto:|tel:)/i.test(u)) return true;

    // Treat http(s) as external unless it matches the current (dev) app origin.
    // This prevents the app from opening its own localhost URL in the user's browser.
    if (/^https?:/i.test(u)) {
      try {
        if (sourceUrl) {
          const target = new URL(u);
          const source = new URL(String(sourceUrl));
          const sameOrigin = target.origin === source.origin;
          const host = (source.hostname || '').toLowerCase();
          const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
          if (sameOrigin && isLocalHost) return false;
        }
      } catch {}
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// Prevent random blank popup windows (often caused by window.open or target=_blank)
// and route external links to the default browser.
app.on('web-contents-created', (_event: any, contents: any) => {
  try {
    if (typeof contents.setWindowOpenHandler === 'function') {
      contents.setWindowOpenHandler(({ url }: any) => {
        try {
          const sourceUrl = (() => {
            try { return typeof contents.getURL === 'function' ? contents.getURL() : ''; } catch { return ''; }
          })();
          if (isExternalUrl(url, sourceUrl)) {
            try { shell.openExternal(url); } catch {}
          }
        } catch {}
        return { action: 'deny' };
      });
    }

    contents.on('will-navigate', (event: any, url: string) => {
      try {
        const sourceUrl = (() => {
          try { return typeof contents.getURL === 'function' ? contents.getURL() : ''; } catch { return ''; }
        })();
        if (!isExternalUrl(url, sourceUrl)) return;
        event.preventDefault();
        try { shell.openExternal(url); } catch {}
      } catch {}
    });
  } catch {
    // ignore
  }
});

// -------------------------------------------------------------
// NAS / server sync config (offline-first)
// -------------------------------------------------------------

type ServerSyncConfig = {
  enabled?: boolean;
  serverPath?: string; // UNC path or local folder for testing (e.g. \\\\NAS\\Share or C:\\temp\\gbpos-nas-test)
  serverHost?: string; // NAS IP/hostname
  serverShare?: string; // NAS share name
  serverBackupsPath?: string; // Optional: override backups folder location on server
  autoSync?: boolean; // attempt sync after local DB writes
  backupToLocal?: boolean;
  backupToServer?: boolean;
  lastSyncAt?: string;
  lastTestAt?: string;
  lastOkAt?: string;
  lastError?: string;
};

const SERVER_SYNC_CONFIG_PATH = () => path.join(resolveDataRoot(), 'server-sync.json');

function readServerSyncConfig(): ServerSyncConfig {
  try {
    const p = SERVER_SYNC_CONFIG_PATH();
    if (!fs.existsSync(p)) return { enabled: false, autoSync: true, backupToLocal: true, backupToServer: true };
    const raw = fs.readFileSync(p, 'utf-8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return { enabled: false, autoSync: true, backupToLocal: true, backupToServer: true };
    return {
      enabled: (json as any).enabled === true,
      serverPath: typeof (json as any).serverPath === 'string' ? String((json as any).serverPath) : '',
      serverHost: typeof (json as any).serverHost === 'string' ? String((json as any).serverHost) : '',
      serverShare: typeof (json as any).serverShare === 'string' ? String((json as any).serverShare) : '',
      serverBackupsPath: typeof (json as any).serverBackupsPath === 'string' ? String((json as any).serverBackupsPath) : '',
      autoSync: (json as any).autoSync !== false,
      backupToLocal: (json as any).backupToLocal !== false,
      backupToServer: (json as any).backupToServer !== false,
      lastSyncAt: typeof (json as any).lastSyncAt === 'string' ? String((json as any).lastSyncAt) : undefined,
      lastTestAt: typeof (json as any).lastTestAt === 'string' ? String((json as any).lastTestAt) : undefined,
      lastOkAt: typeof (json as any).lastOkAt === 'string' ? String((json as any).lastOkAt) : undefined,
      lastError: typeof (json as any).lastError === 'string' ? String((json as any).lastError) : undefined,
    };
  } catch {
    return { enabled: false, autoSync: true, backupToLocal: true, backupToServer: true };
  }
}

function writeServerSyncConfig(patch: Partial<ServerSyncConfig>) {
  try {
    const current = readServerSyncConfig();
    const next: ServerSyncConfig = { ...current, ...patch };
    ensureDir(path.dirname(SERVER_SYNC_CONFIG_PATH()));
    fs.writeFileSync(SERVER_SYNC_CONFIG_PATH(), JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

function normalizeServerDataRoot(inputPath: string): string {
  const base = String(inputPath || '').trim();
  if (!base) return '';
  try {
    const bn = path.basename(base).toLowerCase();
    if (bn === APP_DATA_DIRNAME.toLowerCase()) return base;
  } catch {}
  return path.join(base, APP_DATA_DIRNAME);
}

function serverDataRootFromConfig(cfg?: ServerSyncConfig): string {
  const c = cfg || readServerSyncConfig();
  if (!c?.enabled) return '';
  // If a custom path is explicitly set (e.g. selected via Browse), treat it as the final root.
  const explicit = (c.serverPath || '').toString().trim();
  const host = (c.serverHost || '').toString().trim();
  const share = (c.serverShare || '').toString().trim().replace(/^\\+/, '').replace(/^\/+/, '');
  if (explicit) {
    // Back-compat: older builds persisted serverPath as the bare share root.
    // If host/share are present and serverPath equals \\host\share, treat it as inferred.
    if (host && share) {
      const inferredBase = `\\\\${host}\\${share}`;
      if (explicit === inferredBase) return normalizeServerDataRoot(inferredBase);
    }
    return explicit;
  }

  // Otherwise infer from host/share, and keep data under a dedicated app folder.
  if (!(host && share)) return '';
  const inferredBase = `\\\\${host}\\${share}`;
  return normalizeServerDataRoot(inferredBase);
}

function serverBackupsDirFromConfig(cfg?: ServerSyncConfig, serverRoot?: string): string {
  const c = cfg || readServerSyncConfig();
  const explicit = (c.serverBackupsPath || '').toString().trim();
  if (explicit) return explicit;
  const root = serverRoot || serverDataRootFromConfig(c);
  if (!root) return '';
  return path.join(root, 'backups');
}

function ensureServerLayout(serverRoot: string) {
  if (!serverRoot) return;
  ensureDir(serverRoot);
  ensureDir(path.join(serverRoot, 'backups'));
  ensureDir(path.join(serverRoot, 'quote-previews'));
}

async function canWriteToFolderAsync(folderPath: string): Promise<{ ok: boolean; error?: string }>
{
  try {
    ensureDir(folderPath);
    const testPath = path.join(folderPath, `.__gbpos_write_test_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    await (fs.promises as any).writeFile(testPath, 'ok', 'utf-8');
    await (fs.promises as any).unlink(testPath);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function serverTestConnection(): Promise<{ ok: boolean; serverRoot?: string; error?: string }>
{
  try {
    const cfg = readServerSyncConfig();
    const serverRoot = serverDataRootFromConfig(cfg);
    if (!cfg?.enabled) return { ok: false, error: 'Server sync is disabled.' };
    if (!serverRoot) return { ok: false, error: 'Server path is not set.' };
    ensureServerLayout(serverRoot);
    const writeCheck = await canWriteToFolderAsync(serverRoot);
    if (!writeCheck.ok) {
      writeServerSyncConfig({ lastTestAt: new Date().toISOString(), lastError: writeCheck.error || 'Cannot write to server folder.' });
      return { ok: false, error: writeCheck.error || 'Cannot write to server folder.', serverRoot };
    }

    // If server backups are enabled, also validate the backups target folder is writable.
    if (cfg.backupToServer !== false) {
      const backupsDir = serverBackupsDirFromConfig(cfg, serverRoot);
      if (backupsDir) {
        const backupsCheck = await canWriteToFolderAsync(backupsDir);
        if (!backupsCheck.ok) {
          writeServerSyncConfig({ lastTestAt: new Date().toISOString(), lastError: backupsCheck.error || 'Cannot write to server backups folder.' });
          return { ok: false, error: backupsCheck.error || 'Cannot write to server backups folder.', serverRoot };
        }
      }
    }
    writeServerSyncConfig({ lastTestAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), lastError: '' });
    return { ok: true, serverRoot };
  } catch (e: any) {
    const msg = e?.message || String(e);
    writeServerSyncConfig({ lastTestAt: new Date().toISOString(), lastError: msg });
    return { ok: false, error: msg };
  }
}

async function copyFileAtomic(src: string, dst: string): Promise<void> {
  const dir = path.dirname(dst);
  ensureDir(dir);
  const tmp = path.join(dir, `.__gbpos_tmp_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  await (fs.promises as any).copyFile(src, tmp);
  try {
    await (fs.promises as any).rename(tmp, dst);
  } catch {
    // Fallback: overwrite (e.g., cross-device oddities)
    await (fs.promises as any).copyFile(tmp, dst);
    try { await (fs.promises as any).unlink(tmp); } catch {}
  }
}

async function writeJsonAtomic(dst: string, obj: any): Promise<void> {
  const dir = path.dirname(dst);
  ensureDir(dir);
  const tmp = dst + `.tmp_${Date.now()}`;
  await (fs.promises as any).writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  await (fs.promises as any).rename(tmp, dst);
}

function emitAllDataChanged() {
  try {
    const wins = BrowserWindow.getAllWindows();
    const events = [
      'workorders:changed',
      'customers:changed',
      'sales:changed',
      'quotes:changed',
      'technicians:changed',
      'deviceCategories:changed',
      'productCategories:changed',
      'products:changed',
      'partSources:changed',
      'calendarEvents:changed',
      'timeEntries:changed',
      'notifications:changed',
      'notificationSettings:changed',
    ];
    for (const w of wins) {
      for (const ev of events) {
        try { w.webContents.send(ev); } catch {}
      }
    }
  } catch {
    // ignore
  }
}

async function snapshotDbToRoot(targetRoot: string, label: string): Promise<string> {
  const backupsDir = path.join(targetRoot, 'backups');
  ensureDir(backupsDir);
  const ts = new Date();
  const stamp = formatStamp(ts);
  const backupPath = path.join(backupsDir, `gbpos-${label}-${stamp}.json`);
  const db = readDb();
  await writeJsonAtomic(backupPath, db);
  return backupPath;
}

async function snapshotDbToBackupsDir(backupsDir: string, label: string): Promise<string> {
  ensureDir(backupsDir);
  const ts = new Date();
  const stamp = formatStamp(ts);
  const backupPath = path.join(backupsDir, `gbpos-${label}-${stamp}.json`);
  const db = readDb();
  await writeJsonAtomic(backupPath, db);
  return backupPath;
}

async function syncDbWithServer(direction: 'auto' | 'push' | 'pull' = 'auto') {
  const cfg = readServerSyncConfig();
  if (!cfg?.enabled) return { ok: false, error: 'Server sync is disabled.' };
  const test = await serverTestConnection();
  if (!test.ok || !test.serverRoot) return { ok: false, error: test.error || 'Server not reachable.' };

  const serverRoot = test.serverRoot;
  const localDbPath = dbFilePath();
  const serverDbPath = path.join(serverRoot, 'gbpos-db.json');

  // Ensure pending local writes are flushed before comparing/copying.
  try { await drainDbWrites(); } catch {}

  const localExists = fs.existsSync(localDbPath);
  const serverExists = fs.existsSync(serverDbPath);

  const localStat = (() => { try { return localExists ? fs.statSync(localDbPath) : null; } catch { return null; } })();
  const serverStat = (() => { try { return serverExists ? fs.statSync(serverDbPath) : null; } catch { return null; } })();

  const decide = (): 'push' | 'pull' | 'noop' => {
    if (direction === 'push') return 'push';
    if (direction === 'pull') return 'pull';
    if (!localExists && serverExists) return 'pull';
    if (localExists && !serverExists) return 'push';
    if (!localExists && !serverExists) return 'noop';
    const lm = localStat?.mtimeMs || 0;
    const sm = serverStat?.mtimeMs || 0;
    if (Math.abs(lm - sm) < 1500) return 'noop';
    return lm > sm ? 'push' : 'pull';
  };

  const action = decide();
  if (action === 'noop') {
    writeServerSyncConfig({ lastSyncAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), lastError: '' });
    return { ok: true, action: 'noop', serverDbPath };
  }

  try {
    // Pre-overwrite safety backups
    if (action === 'push') {
      if (serverExists) {
        try {
          const serverBackupsDir = serverBackupsDirFromConfig(cfg, serverRoot);
          if (serverBackupsDir) await snapshotDbToBackupsDir(serverBackupsDir, 'pre-sync-server');
        } catch {}
      }
      if (localExists) {
        await copyFileAtomic(localDbPath, serverDbPath);
      }
    } else {
      if (localExists) {
        try { await snapshotDbToRoot(resolveDataRoot(), 'pre-sync-local'); } catch {}
      }
      if (serverExists) {
        await copyFileAtomic(serverDbPath, localDbPath);
        // Refresh cache to reflect pulled data
        try {
          dbCache = null;
          readDb();
        } catch {}
        try { emitAllDataChanged(); } catch {}
      }
    }

    writeServerSyncConfig({ lastSyncAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), lastError: '' });
    return { ok: true, action, serverDbPath };
  } catch (e: any) {
    const msg = e?.message || String(e);
    writeServerSyncConfig({ lastError: msg });
    return { ok: false, error: msg };
  }
}

let serverAutoSyncTimer: NodeJS.Timeout | null = null;
let serverAutoSyncRunning = false;
function scheduleServerAutoSync() {
  try {
    const cfg = readServerSyncConfig();
    if (!cfg?.enabled) return;
    if (cfg.autoSync === false) return;
    if (serverAutoSyncTimer) return;
    serverAutoSyncTimer = setTimeout(async () => {
      serverAutoSyncTimer = null;
      if (serverAutoSyncRunning) return;
      serverAutoSyncRunning = true;
      try {
        await syncDbWithServer('push');
      } catch {
        // ignore
      } finally {
        serverAutoSyncRunning = false;
      }
    }, 1200);
  } catch {
    // ignore
  }
}

// -------------------------------------------------------------
// App data location (ProgramData default, user-approved)
// -------------------------------------------------------------
const APP_DATA_DIRNAME = 'GadgetBoy POS';
const DATA_LOCATION_FILE = 'data-location.json';

type DataLocationConfig = {
  version: number;
  dataRoot: string;
  chosenAt: string;
};

function defaultProgramDataRoot(): string {
  if (process.platform === 'win32') {
    const base = process.env.ProgramData || 'C:\\ProgramData';
    return path.join(base, APP_DATA_DIRNAME);
  }
  // Non-Windows fallback
  try {
    return path.join(app.getPath('userData'), 'data');
  } catch {
    return path.join(process.cwd(), 'data');
  }
}

function dataLocationPath(): string {
  // Pointer stays in Electron userData so we can find it reliably.
  // All business data goes under the chosen dataRoot.
  return path.join(app.getPath('userData'), DATA_LOCATION_FILE);
}

let dataRootCache: string | null = null;

function readDataLocationConfig(): DataLocationConfig | null {
  try {
    const p = dataLocationPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return null;
    const dr = (json as any).dataRoot;
    if (!dr || typeof dr !== 'string') return null;
    return {
      version: Number((json as any).version) || 1,
      dataRoot: dr,
      chosenAt: String((json as any).chosenAt || ''),
    };
  } catch {
    return null;
  }
}

function ensureDir(p: string) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function canWriteToFolder(folderPath: string): { ok: boolean; error?: string } {
  try {
    ensureDir(folderPath);
    const testPath = path.join(folderPath, `.__gbpos_write_test_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(testPath, 'ok', 'utf-8');
    fs.unlinkSync(testPath);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function resolveDataRoot(): string {
  if (dataRootCache !== null) return dataRootCache;

  // Optional: allow a transient data root override (does not persist).
  // Used for local test profiles / sandboxes.
  const envRootRaw = (process.env.GBPOS_DATA_ROOT || '').toString().trim();
  if (envRootRaw) {
    try {
      const envRoot = path.resolve(envRootRaw);
      const writeCheck = canWriteToFolder(envRoot);
      if (writeCheck.ok) {
        dataRootCache = envRoot;
        ensureDir(envRoot);
        return envRoot;
      }
    } catch {
      // ignore
    }
  }

  let resolved: string = '';
  try {
    const cfg = readDataLocationConfig();
    if (cfg?.dataRoot) resolved = cfg.dataRoot;
  } catch {
    // ignore
  }

  // Default for now: per-user (until user approves ProgramData)
  if (!resolved) {
    try {
      resolved = app.getPath('userData');
    } catch {
      resolved = '';
    }
  }

  if (!resolved) resolved = path.join(process.cwd(), 'userData');

  dataRootCache = resolved;
  ensureDir(resolved);
  return resolved;
}

function setDataRoot(newRoot: string) {
  dataRootCache = newRoot;
  ensureDir(newRoot);
  try {
    const cfg: DataLocationConfig = {
      version: 1,
      dataRoot: newRoot,
      chosenAt: new Date().toISOString(),
    };
    ensureDir(path.dirname(dataLocationPath()));
    fs.writeFileSync(dataLocationPath(), JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

function setDataRootTransient(newRoot: string) {
  dataRootCache = newRoot;
  ensureDir(newRoot);
}

function copyDirRecursive(srcDir: string, dstDir: string) {
  try {
    if (!fs.existsSync(srcDir)) return;
    ensureDir(dstDir);
    if (typeof (fs as any).cpSync === 'function') {
      (fs as any).cpSync(srcDir, dstDir, { recursive: true, force: false, errorOnExist: false });
      return;
    }
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const ent of entries) {
      const s = path.join(srcDir, ent.name);
      const d = path.join(dstDir, ent.name);
      if (ent.isDirectory()) {
        copyDirRecursive(s, d);
      } else if (ent.isFile()) {
        if (!fs.existsSync(d)) {
          try { fs.copyFileSync(s, d); } catch {}
        }
      }
    }
  } catch {
    // ignore
  }
}

function migrateUserDataToDataRoot(oldUserData: string, newRoot: string) {
  const moved: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  function copyFileIfMissing(src: string, dst: string) {
    try {
      if (!fs.existsSync(src)) return;
      if (fs.existsSync(dst)) {
        skipped.push(dst);
        return;
      }
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
      moved.push(dst);
    } catch (e: any) {
      errors.push(`${src} -> ${dst}: ${String(e?.message || e)}`);
    }
  }

  try {
    // Files we own
    copyFileIfMissing(path.join(oldUserData, 'gbpos-db.json'), path.join(newRoot, 'gbpos-db.json'));
    copyFileIfMissing(path.join(oldUserData, 'update-config.json'), path.join(newRoot, 'update-config.json'));
    copyFileIfMissing(path.join(oldUserData, 'email-config.json'), path.join(newRoot, 'email-config.json'));
    copyFileIfMissing(path.join(oldUserData, 'backup-config.json'), path.join(newRoot, 'backup-config.json'));

    // Folders we own
    const backupsOld = path.join(oldUserData, 'backups');
    const backupsNew = path.join(newRoot, 'backups');
    if (fs.existsSync(backupsOld) && !fs.existsSync(backupsNew)) {
      copyDirRecursive(backupsOld, backupsNew);
      moved.push(backupsNew);
    }

    const previewsOld = path.join(oldUserData, 'quote-previews');
    const previewsNew = path.join(newRoot, 'quote-previews');
    if (fs.existsSync(previewsOld) && !fs.existsSync(previewsNew)) {
      copyDirRecursive(previewsOld, previewsNew);
      moved.push(previewsNew);
    }
  } catch (e: any) {
    errors.push(String(e?.message || e));
  }

  return { moved, skipped, errors };
}

function looksLikeGbposDataRoot(rootPath: string): boolean {
  try {
    if (!rootPath) return false;
    const markers = [
      'gbpos-db.json',
      'email-config.json',
      'update-config.json',
      'backup-config.json',
      'backups',
      'quote-previews',
    ];
    return markers.some((m) => fs.existsSync(path.join(rootPath, m)));
  } catch {
    return false;
  }
}

// -------------------------------------------------------------
// Startup crash logging (helps diagnose packaged SyntaxError)
// -------------------------------------------------------------
function safeGetUserDataPath(): string {
  // Goal: a writable folder even if Electron isn't fully initialized yet.
  // Prefer Electron's userData when available, otherwise use OS env vars.
  try {
    const p = app.getPath('userData');
    if (p) return p;
  } catch {
    // ignore
  }

  try {
    if (process.platform === 'win32') {
      const base = process.env.APPDATA || process.env.LOCALAPPDATA;
      if (base) return path.join(base, 'GadgetBoy POS');
    }
  } catch {
    // ignore
  }

  try {
    return path.join(os.homedir?.() || process.cwd(), '.gadgetboy-pos');
  } catch {
    return path.join(process.cwd(), 'userData');
  }
}

function appendStartupLog(line: string) {
  try {
    const msg = `${new Date().toISOString()} ${line}\n`;

    // Try chosen data root first (if configured), then fall back.
    try {
      const chosen = readDataLocationConfig()?.dataRoot;
      if (chosen) {
        try { fs.mkdirSync(chosen, { recursive: true }); } catch {}
        try {
          const logPath = path.join(chosen, 'gbpos-startup.log');
          fs.appendFileSync(logPath, msg, 'utf-8');
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    const dir = safeGetUserDataPath();
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    try {
      const logPath = path.join(dir, 'gbpos-startup.log');
      fs.appendFileSync(logPath, msg, 'utf-8');
    } catch {
      // ignore
    }

    // Also write to temp (useful if Program Files / userData isn't writable yet)
    try {
      const tmpDir = os.tmpdir?.() || null;
      if (tmpDir) {
        const tmpPath = path.join(tmpDir, 'gbpos-startup.log');
        fs.appendFileSync(tmpPath, msg, 'utf-8');
      }
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

function createAutoUpdateLogger() {
  const write = (level: string, values: any[]) => {
    try {
      const detail = values.map((value) => {
        if (value instanceof Error) return value.stack || value.message;
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch { return String(value); }
      }).join(' ');
      appendStartupLog(`auto-update ${level}: ${detail}`);
    } catch {
      // Logging must never interrupt an update.
    }
  };
  return {
    info: (...values: any[]) => write('info', values),
    warn: (...values: any[]) => write('warn', values),
    error: (...values: any[]) => write('error', values),
    debug: (...values: any[]) => write('debug', values),
  };
}

function setupStartupCrashLogging() {
  // Capture the most common “Uncaught exception / SyntaxError” details.
  try {
    appendStartupLog('--- app start ---');
    appendStartupLog(`versions node=${process.versions?.node} electron=${process.versions?.electron} chrome=${process.versions?.chrome}`);

    process.on('uncaughtException', (err: any) => {
      try {
        const msg = err?.stack || err?.message || String(err);
        appendStartupLog(`uncaughtException: ${msg}`);
      } catch {}
    });

    process.on('unhandledRejection', (reason: any) => {
      try {
        const msg = reason?.stack || reason?.message || String(reason);
        appendStartupLog(`unhandledRejection: ${msg}`);
      } catch {}
    });
  } catch {
    // ignore
  }
}

setupStartupCrashLogging();

// Determine dev mode early so it is available for handlers
const isDev = !app.isPackaged;
// Control whether DevTools auto-open. Disable by default to avoid noisy DevTools protocol warnings (e.g., Autofill.enable)
const OPEN_MAIN_DEVTOOLS = process.env.OPEN_MAIN_DEVTOOLS === '1';
const OPEN_CHILD_DEVTOOLS = process.env.OPEN_CHILD_DEVTOOLS === '1';

// Silence Electron security warnings in development to avoid the dev popup/console banner
if (!app.isPackaged && process.env.ELECTRON_DISABLE_SECURITY_WARNINGS !== 'true') {
  // Note: Keep contextIsolation true and nodeIntegration false (already configured) for safety
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

// Central dev server base (adjust here if port changes)
const DEV_SERVER_URL = 'http://localhost:5173';

function getProdIndexUrl(): string {
  // Use a proper file:// URL so Windows paths/spaces work reliably.
  return pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).toString();
}

function normalizeVersion(v: string): string {
  return String(v || '0.0.0').trim().replace(/^v/i, '');
}

function getAppDisplayVersion(): string {
  try {
    return normalizeVersion(app.getVersion());
  } catch {
    return '0.0.0';
  }
}

function getAppDisplayTitle(): string {
  return `GadgetBoy POS v${getAppDisplayVersion()}`;
}

function windowTitle(prefix?: string): string {
  const base = getAppDisplayTitle();
  const p = String(prefix || '').trim();
  if (!p) return base;
  // Avoid duplicated titles if caller passes full title.
  if (p.includes(base)) return p;
  if (p === 'GadgetBoy POS' || p.startsWith('GadgetBoy POS v')) return base;
  return `${p} — ${base}`;
}

function compareVersions(aRaw: string, bRaw: string): number {
  const a = normalizeVersion(aRaw).split(/[.+-]/)[0].split('.').map((x) => parseInt(x, 10));
  const b = normalizeVersion(bRaw).split(/[.+-]/)[0].split('.').map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i += 1) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function stableActivityValue(value: any): string {
  try { return JSON.stringify(value ?? null); } catch { return String(value ?? ''); }
}

function getWorkOrderActivityAt(it: any): string {
  if (!it || typeof it !== 'object') return '';
  return String(
    it.activityAt
    || it.checkoutDate
    || it.repairCompletionDate
    || it.clientPickupDate
    || it.checkInAt
    || it.createdAt
    || ''
  );
}

function getSaleActivityAt(it: any): string {
  if (!it || typeof it !== 'object') return '';
  return String(
    it.checkoutDate
    || it.checkInAt
    || it.invoiceDate
    || it.saleDate
    || it.transactionDate
    || it.updatedAt
    || it.createdAt
    || ''
  );
}

function isMeaningfulWorkOrderActivityChange(previous: any, next: any): boolean {
  if (!previous || typeof previous !== 'object') return true;
  // Only bump activityAt (and therefore list position) when a payment is recorded.
  // Editing items, notes, status, parts, labor, etc. intentionally does NOT move the
  // work order to the top of the list — only actual money collected does.
  const keys = [
    'amountPaid',
    'payments',
    'paymentHistory',
    'paymentLogs',
  ];
  return keys.some((key) => stableActivityValue(previous?.[key]) !== stableActivityValue(next?.[key]));
}

function computeWorkOrderActivityAt(previous: any, next: any, updatedAt: string): string {
  if (next?.activityAt) return String(next.activityAt);
  const existingActivityAt = getWorkOrderActivityAt(previous);
  if (!previous || typeof previous !== 'object' || !previous?.id) {
    return getWorkOrderActivityAt({ ...next, activityAt: updatedAt }) || updatedAt;
  }
  if (isMeaningfulWorkOrderActivityChange(previous, next)) return updatedAt;
  return existingActivityAt || getWorkOrderActivityAt(next) || updatedAt;
}

// -------------------------------------------------------------
// Email (Company sender via SMTP)
// -------------------------------------------------------------
function emailConfigPath(): string {
  return path.join(resolveDataRoot(), 'email-config.json');
}

function readEmailConfig(): any {
  try {
    const p = emailConfigPath();
    if (!fs.existsSync(p)) return { fromEmail: 'gadgetboysc@gmail.com', fromName: 'GadgetBoy Repair & Retail', bodyTemplate: null };
    const raw = fs.readFileSync(p, 'utf-8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return { fromEmail: 'gadgetboysc@gmail.com', fromName: 'GadgetBoy Repair & Retail', bodyTemplate: null };
    return {
      fromEmail: json.fromEmail || 'gadgetboysc@gmail.com',
      fromName: json.fromName || 'GadgetBoy Repair & Retail',
      bodyTemplate: typeof json.bodyTemplate === 'string' ? json.bodyTemplate : null,
      // Stored encrypted (base64)
      gmailAppPasswordEnc: json.gmailAppPasswordEnc || null,
    };
  } catch {
    return { fromEmail: 'gadgetboysc@gmail.com', fromName: 'GadgetBoy Repair & Retail', bodyTemplate: null };
  }
}

function writeEmailConfig(cfg: any) {
  try {
    const p = emailConfigPath();
    fs.writeFileSync(p, JSON.stringify(cfg || {}, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

function decryptAppPassword(cfg: any): string | null {
  try {
    const enc = cfg?.gmailAppPasswordEnc;
    if (!enc || typeof enc !== 'string') return null;
    const buf = Buffer.from(enc, 'base64');
    if (safeStorage && typeof safeStorage.decryptString === 'function') {
      return safeStorage.decryptString(buf);
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Clover REST config helpers ───────────────────────────────────────────
function cloverRestConfigPath(): string {
  return path.join(resolveDataRoot(), 'clover-config.json');
}

function readCloverRestConfig(): any {
  try {
    const p = cloverRestConfigPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeCloverRestConfig(cfg: any) {
  try {
    fs.writeFileSync(cloverRestConfigPath(), JSON.stringify(cfg || {}, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

function decryptCloverToken(cfg: any): string | null {
  try {
    const enc = cfg?.accessTokenEnc;
    if (!enc || typeof enc !== 'string') return null;
    const buf = Buffer.from(enc, 'base64');
    if (safeStorage && typeof safeStorage.decryptString === 'function') {
      return safeStorage.decryptString(buf);
    }
    return null;
  } catch {
    return null;
  }
}

function cloverApiRequest(opts: {
  method: string;
  urlPath: string;
  accessToken: string;
  body?: any;
  baseUrl?: string;
}): Promise<any> {
  return new Promise((resolve, reject) => {
    const base = opts.baseUrl || 'https://api.clover.com';
    const url = new URL(opts.urlPath, base);
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const reqOpts: any = {
      method: opts.method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${opts.accessToken}`,
        'Accept': 'application/json',
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(reqOpts, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`Clover API error ${res.statusCode}: ${parsed?.message || data}`));
          }
        } catch {
          reject(new Error(`Clover API non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (e: any) => reject(e));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function sendConfiguredEmail(payload: { to: string; subject: string; text?: string; html?: string; attachments?: any[]; bcc?: string }) {
  const cfg = readEmailConfig();
  const appPass = decryptAppPassword(cfg);
  if (!appPass) return { ok: false, error: 'Email not configured. Set Gmail App Password first.' };

  const to = String(payload?.to || '').trim();
  if (!to) return { ok: false, error: 'Missing recipient email' };

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'gadgetboysc@gmail.com',
      pass: appPass,
    },
  });

  const fromName = String(cfg.fromName || 'GadgetBoy Repair & Retail').trim() || 'GadgetBoy Repair & Retail';
  const from = `${fromName} <gadgetboysc@gmail.com>`;

  const info = await transporter.sendMail({
    from,
    to,
    bcc: payload?.bcc ? String(payload.bcc) : undefined,
    subject: String(payload?.subject || 'GadgetBoy POS Report'),
    text: String(payload?.text || ''),
    html: payload?.html ? String(payload.html) : undefined,
    attachments: Array.isArray(payload?.attachments) ? payload.attachments : undefined,
  });

  return { ok: true, messageId: info?.messageId || null };
}

ipcMain.handle('email:sendReportHtml', async (_event: any, payload: any) => {
  try {
    const to = String(payload?.to || '').trim();
    const subject = String(payload?.subject || 'Daily batch report').trim() || 'Daily batch report';
    const bodyText = String(payload?.bodyText || '').trim();
    const html = payload?.html ? String(payload.html) : undefined;
    return await sendConfiguredEmail({
      to,
      subject,
      text: bodyText,
      html,
    });
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function configDateKey(value: any): string | null {
  try {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return localDateKey(d);
  } catch {
    return null;
  }
}

function getReleasesUrl(): string {
  try {
    // In production this resolves inside app.asar; require works fine.
    const pkg = require(path.join(app.getAppPath(), 'package.json'));
    const repoUrl = pkg?.repository?.url;
    if (typeof repoUrl === 'string' && repoUrl.length) {
      // Support https://github.com/owner/repo(.git)
      const cleaned = repoUrl.replace(/\.git$/i, '');
      if (cleaned.includes('github.com/')) return `${cleaned}/releases`;
    }
  } catch {
    // ignore
  }
  return 'https://github.com/Mattstechwisdom/GB-POS/releases';
}

let autoUpdateInitialized = false;
let autoUpdateCheckStarted = false;
let autoUpdatePromptOpen = false;
let autoUpdateDownloading = false;
let autoInstallAfterDownload = false;
let downloadedUpdateInstallerPath = '';
let updateUiWindow: any | null = null;
let updateUiInfo: any | null = null;
let updateUiIpcRegistered = false;

function updaterWindow(): any {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    return BrowserWindow.getAllWindows().find((w: any) => !w.isDestroyed()) || undefined;
  } catch {
    return undefined;
  }
}

function getUpdateLogoDataUrl(): string {
  try {
    const candidates = [
      path.join(app.getAppPath(), 'dist', 'logo.png'),
      path.join(app.getAppPath(), 'logo.png'),
      path.join(process.cwd(), 'public', 'logo.png'),
      path.join(process.cwd(), 'dist', 'logo.png'),
    ];
    const logoPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!logoPath) return '';
    return `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
  } catch {
    return '';
  }
}

function getUpdateLabel(info: any): string {
  const version = String(info?.version || '').trim();
  const releaseName = String(info?.releaseName || '').trim();
  return releaseName || (version ? `v${version}` : 'a newer version');
}

function updateUiHtml(initialState: any): string {
  const logoDataUrl = getUpdateLogoDataUrl();
  const stateJson = JSON.stringify(initialState || {});
  const logoMarkup = logoDataUrl
    ? `<img class="logo-img" src="${logoDataUrl}" alt="GadgetBoy POS" />`
    : `<div class="logo-fallback" aria-label="GadgetBoy POS">GB</div>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' data: 'unsafe-inline'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: 'self';" />
  <title>GadgetBoy POS Update</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #18181b;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --line: rgba(255,255,255,.12);
      --green: #39ff14;
      --danger: #fb7185;
    }
    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    }
    body {
      display: flex;
      align-items: stretch;
      justify-content: center;
      border: 1px solid rgba(57,255,20,.28);
    }
    .wrap {
      width: 100%;
      padding: 28px 30px 24px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 20px;
      background:
        radial-gradient(circle at 20% 0%, rgba(57,255,20,.12), transparent 34%),
        linear-gradient(180deg, rgba(255,255,255,.03), transparent 44%);
    }
    .top {
      display: flex;
      align-items: center;
      gap: 16px;
      min-width: 0;
    }
    .logo-slot {
      width: 74px;
      height: 74px;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
    }
    .logo-img {
      max-width: 74px;
      max-height: 74px;
      object-fit: contain;
      filter: drop-shadow(0 0 18px rgba(57,255,20,.25));
      animation: pulse 1.35s ease-in-out infinite;
    }
    .logo-fallback {
      width: 70px;
      height: 70px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      border: 1px solid rgba(57,255,20,.58);
      color: var(--green);
      font-weight: 800;
      font-size: 28px;
      box-shadow: 0 0 26px rgba(57,255,20,.16);
      animation: pulse 1.35s ease-in-out infinite;
    }
    .eyebrow {
      margin: 0 0 5px;
      color: var(--green);
      font-size: 12px;
      line-height: 1.2;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-weight: 750;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.18;
      letter-spacing: 0;
      font-weight: 760;
    }
    .body {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 15px;
      min-height: 116px;
    }
    .message {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
      max-width: 520px;
    }
    .bar-wrap {
      display: none;
      gap: 10px;
      align-items: center;
    }
    .progress-track {
      position: relative;
      height: 12px;
      flex: 1;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.11);
    }
    .progress-fill {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #24d40d, var(--green), #a3ff93);
      box-shadow: 0 0 16px rgba(57,255,20,.36);
      transition: width .18s ease;
    }
    .percent {
      width: 48px;
      text-align: right;
      color: var(--text);
      font-variant-numeric: tabular-nums;
      font-size: 13px;
      font-weight: 700;
    }
    .footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      border-top: 1px solid var(--line);
      padding-top: 16px;
    }
    .footer .spacer { flex: 1; }
    button {
      min-width: 116px;
      height: 36px;
      padding: 0 14px;
      border-radius: 7px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.07);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { border-color: rgba(255,255,255,.22); background: rgba(255,255,255,.1); }
    button.primary {
      color: #071007;
      background: var(--green);
      border-color: var(--green);
      box-shadow: 0 0 18px rgba(57,255,20,.2);
    }
    button.primary:hover { background: #6bff52; }
    button:disabled {
      cursor: default;
      opacity: .62;
      box-shadow: none;
    }
    .error { color: var(--danger); }
    .dots { display: inline-flex; gap: 4px; transform: translateY(-1px); }
    .dot {
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: var(--green);
      opacity: .45;
      animation: bounce 1s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: .18s; }
    .dot:nth-child(3) { animation-delay: .36s; }
    @keyframes bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: .45; }
      40% { transform: translateY(-5px); opacity: 1; }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: .94; }
      50% { transform: scale(1.035); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="logo-slot">${logoMarkup}</div>
      <div>
        <p class="eyebrow">GadgetBoy POS</p>
        <h1 id="title">Update Available</h1>
      </div>
    </div>
    <div class="body">
      <p id="message" class="message"></p>
      <div id="barWrap" class="bar-wrap" aria-label="Download progress">
        <div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>
        <div id="percent" class="percent">0%</div>
      </div>
    </div>
    <div class="footer">
      <button id="secondaryBtn">Skip for Now</button>
      <span class="spacer" aria-hidden="true"></span>
      <button id="downloadBtn">Download Only</button>
      <button id="primaryBtn" class="primary">Auto Update and Relaunch</button>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const titleEl = document.getElementById('title');
    const messageEl = document.getElementById('message');
    const barWrap = document.getElementById('barWrap');
    const progressFill = document.getElementById('progressFill');
    const percentEl = document.getElementById('percent');
    const primaryBtn = document.getElementById('primaryBtn');
    const secondaryBtn = document.getElementById('secondaryBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const busyDots = '<span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';

    function pct(value) {
      const n = Number(value || 0);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(100, n));
    }

    window.__setUpdateState = function(state) {
      const phase = state && state.phase ? state.phase : 'available';
      const label = state && state.label ? state.label : 'a newer version';
      const percent = pct(state && state.percent);
      messageEl.classList.remove('error');
      barWrap.style.display = 'none';
      primaryBtn.disabled = false;
      secondaryBtn.disabled = false;
      downloadBtn.disabled = false;
      downloadBtn.style.display = 'inline-flex';
      downloadBtn.style.alignItems = 'center';
      downloadBtn.style.justifyContent = 'center';

      if (phase === 'available') {
        titleEl.textContent = 'Update Available';
        messageEl.textContent = 'GadgetBoy POS ' + label + ' is ready. Auto Update and Relaunch will download, install, close, and reopen the app automatically.';
        primaryBtn.textContent = 'Auto Update and Relaunch';
        primaryBtn.onclick = () => ipcRenderer.send('updater-window-action', 'auto-download-install');
        downloadBtn.textContent = 'Download Only';
        downloadBtn.onclick = () => ipcRenderer.send('updater-window-action', 'download');
        secondaryBtn.textContent = 'Skip for Now';
        secondaryBtn.onclick = () => ipcRenderer.send('updater-window-action', 'skip');
      } else if (phase === 'downloading') {
        titleEl.textContent = 'Downloading Update';
        messageEl.innerHTML = 'Downloading GadgetBoy POS ' + label + ' ' + busyDots;
        barWrap.style.display = 'flex';
        progressFill.style.width = percent.toFixed(0) + '%';
        percentEl.textContent = percent.toFixed(0) + '%';
        primaryBtn.textContent = 'Downloading';
        primaryBtn.disabled = true;
        primaryBtn.onclick = null;
        downloadBtn.style.display = 'none';
        secondaryBtn.textContent = 'Keep Open';
        secondaryBtn.disabled = true;
        secondaryBtn.onclick = null;
      } else if (phase === 'downloaded') {
        titleEl.textContent = 'Update Ready';
        messageEl.textContent = 'GadgetBoy POS ' + label + ' has downloaded. The app will close, install the update, and relaunch when you choose Install and Relaunch.';
        barWrap.style.display = 'flex';
        progressFill.style.width = '100%';
        percentEl.textContent = '100%';
        primaryBtn.textContent = 'Install and Relaunch';
        primaryBtn.onclick = () => ipcRenderer.send('updater-window-action', 'install');
        downloadBtn.style.display = 'none';
        secondaryBtn.textContent = 'Later';
        secondaryBtn.onclick = () => ipcRenderer.send('updater-window-action', 'later');
      } else if (phase === 'applying') {
        titleEl.textContent = 'Applying Update';
        messageEl.innerHTML = 'Closing GadgetBoy POS and applying the update ' + busyDots;
        barWrap.style.display = 'flex';
        progressFill.style.width = '100%';
        percentEl.textContent = '100%';
        primaryBtn.textContent = 'Applying';
        primaryBtn.disabled = true;
        primaryBtn.onclick = null;
        downloadBtn.style.display = 'none';
        secondaryBtn.textContent = 'Please Wait';
        secondaryBtn.disabled = true;
        secondaryBtn.onclick = null;
      } else if (phase === 'error') {
        titleEl.textContent = 'Update Failed';
        messageEl.classList.add('error');
        messageEl.textContent = state && state.detail ? state.detail : 'The update could not be completed. You can try again the next time you open the app.';
        primaryBtn.textContent = 'Close';
        primaryBtn.onclick = () => ipcRenderer.send('updater-window-action', 'skip');
        downloadBtn.style.display = 'none';
        secondaryBtn.textContent = 'Open Download Page';
        secondaryBtn.onclick = () => ipcRenderer.send('updater-window-action', 'releases');
      }
    };

    window.__setUpdateState(${stateJson});
  </script>
</body>
</html>`;
}

function ensureUpdateUiIpc() {
  if (updateUiIpcRegistered) return;
  updateUiIpcRegistered = true;
  ipcMain.on('updater-window-action', (_event: any, action: string) => {
    try {
      if (action === 'download') {
        autoInstallAfterDownload = false;
        void startUpdateDownload();
      } else if (action === 'auto-download-install') {
        autoInstallAfterDownload = true;
        void startUpdateDownload();
      } else if (action === 'install') {
        void installDownloadedUpdate();
      } else if (action === 'releases') {
        void shell.openExternal(getReleasesUrl());
      } else if (action === 'skip' || action === 'later') {
        closeUpdateUi();
      }
    } catch (e: any) {
      try { console.error('[AutoUpdate] action failed:', e?.message || e); } catch {}
    }
  });
}

function sendUpdateUiState(state: any) {
  try {
    if (!updateUiWindow || updateUiWindow.isDestroyed()) return;
    updateUiWindow.webContents.executeJavaScript(`window.__setUpdateState(${JSON.stringify(state || {})});`).catch(() => {});
  } catch {
    // ignore
  }
}

function closeUpdateUi() {
  autoUpdatePromptOpen = false;
  try {
    if (updateUiWindow && !updateUiWindow.isDestroyed()) updateUiWindow.close();
  } catch {
    // ignore
  }
  updateUiWindow = null;
}

function showUpdateUi(state: any) {
  ensureUpdateUiIpc();
  autoUpdatePromptOpen = true;
  const parent = updaterWindow();
  try {
    if (updateUiWindow && !updateUiWindow.isDestroyed()) {
      sendUpdateUiState(state);
      updateUiWindow.show();
      updateUiWindow.focus();
      return;
    }

    updateUiWindow = new BrowserWindow({
      width: 560,
      height: 390,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'GadgetBoy POS Update',
      parent,
      modal: false,
      show: false,
      backgroundColor: '#18181b',
      icon: WINDOW_ICON,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    updateUiWindow.removeMenu();
    updateUiWindow.on('closed', () => {
      updateUiWindow = null;
      if (!autoUpdateDownloading) autoUpdatePromptOpen = false;
    });
    updateUiWindow.once('ready-to-show', () => {
      try { updateUiWindow.show(); } catch {}
    });
    updateUiWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(updateUiHtml(state))}`);
  } catch (e: any) {
    autoUpdatePromptOpen = false;
    try { console.error('[AutoUpdate] update window failed:', e?.message || e); } catch {}
  }
}

async function startUpdateDownload() {
  if (autoUpdateDownloading || !autoUpdater) return;
  autoUpdateDownloading = true;
  showUpdateUi({ phase: 'downloading', label: getUpdateLabel(updateUiInfo), percent: 0 });
  try {
    const downloadedFiles = await autoUpdater.downloadUpdate();
    downloadedUpdateInstallerPath = resolveDownloadedInstallerPath(downloadedFiles);
    appendStartupLog(`auto-update downloaded installer path captured=${downloadedUpdateInstallerPath ? 'yes' : 'no'}`);
  } catch (e: any) {
    autoUpdateDownloading = false;
    showUpdateUi({
      phase: 'error',
      detail: `GadgetBoy POS could not download the update. ${String(e?.message || e || 'Unknown update error.')}`,
    });
  }
}

async function installDownloadedUpdate() {
  if (!autoUpdater) return;
  showUpdateUi({ phase: 'applying', label: getUpdateLabel(updateUiInfo), percent: 100 });
  await prepareForUpdateInstall();
  setTimeout(() => {
    try {
      appendStartupLog(`auto-update install requested version=${getUpdateLabel(updateUiInfo)} platform=${process.platform}`);
      // electron-updater preserves the actual install directory and handles
      // per-user/per-machine elevation before quitting the current app.
      autoUpdater.quitAndInstall(true, true);
    } catch (e: any) {
      appendStartupLog(`auto-update install request failed: ${String(e?.stack || e?.message || e)}`);
      showUpdateUi({
        phase: 'error',
        detail: `GadgetBoy POS could not apply the update. ${String(e?.message || e || 'Unknown update error.')}`,
      });
    }
  }, 450);
}

async function prepareForUpdateInstall() {
  // Finish writes before NSIS starts replacing application files.
  try { await drainDbWrites(); } catch {}
  try {
    await Promise.race([
      drainCloudSyncQueue(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {}

  // Release background resources that can keep Electron or installed files open.
  try { disposeCloverConnector(); } catch {}
  try { await stopQrStatusServerForUpdate(); } catch {}

  // Daughter windows can retain their own renderer processes. Close those now;
  // quitAndInstall will close the main and updater windows during handoff.
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win === mainWindow || win === updateUiWindow || win.isDestroyed()) continue;
      try { win.destroy(); } catch {}
    }
  } catch {}
}

async function promptToDownloadUpdate(info: any) {
  if (autoUpdatePromptOpen || autoUpdateDownloading || !autoUpdater) return;
  updateUiInfo = info;
  showUpdateUi({ phase: 'available', label: getUpdateLabel(info), percent: 0 });
}

async function promptToInstallDownloadedUpdate(info: any) {
  if (!autoUpdater) return;
  updateUiInfo = info;
  autoUpdateDownloading = false;
  if (autoInstallAfterDownload) {
    autoInstallAfterDownload = false;
    await installDownloadedUpdate();
    return;
  }
  showUpdateUi({ phase: 'downloaded', label: getUpdateLabel(info), percent: 100 });
}

function setupAutoUpdater() {
  if (autoUpdateInitialized) return;
  autoUpdateInitialized = true;
  if (!autoUpdater) {
    try { console.warn('[AutoUpdate] electron-updater is unavailable.'); } catch {}
    return;
  }

  autoUpdater.logger = createAutoUpdateLogger();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => {
    try { console.log('[AutoUpdate] checking for update'); } catch {}
  });
  autoUpdater.on('update-available', (info: any) => {
    try { console.log('[AutoUpdate] update available:', info?.version || info); } catch {}
    void promptToDownloadUpdate(info);
  });
  autoUpdater.on('update-not-available', (info: any) => {
    try { console.log('[AutoUpdate] no update available:', info?.version || info); } catch {}
  });
  autoUpdater.on('download-progress', (progress: any) => {
    try { console.log('[AutoUpdate] download progress:', Math.round(Number(progress?.percent || 0)) + '%'); } catch {}
    showUpdateUi({
      phase: 'downloading',
      label: getUpdateLabel(updateUiInfo),
      percent: Number(progress?.percent || 0),
    });
  });
  autoUpdater.on('update-downloaded', (info: any) => {
    try { console.log('[AutoUpdate] update downloaded:', info?.version || info); } catch {}
    void promptToInstallDownloadedUpdate(info);
  });
  autoUpdater.on('error', (err: any) => {
    autoUpdateDownloading = false;
    autoInstallAfterDownload = false;
    try { console.error('[AutoUpdate] error:', err?.message || err); } catch {}
    showUpdateUi({
      phase: 'error',
      detail: `GadgetBoy POS could not complete the update. ${String(err?.message || err || 'Unknown update error.')}`,
    });
  });
}

function checkForAppUpdatesSoon() {
  try {
    if (autoUpdateCheckStarted) return;
    autoUpdateCheckStarted = true;
    if (isDev || !app.isPackaged) return;
    if ((process.env.GBPOS_DISABLE_AUTO_UPDATE || '').toString().trim() === '1') return;
    setupAutoUpdater();
    if (!autoUpdater) return;
    setTimeout(() => {
      try {
        void autoUpdater.checkForUpdates();
      } catch (e: any) {
        try { console.error('[AutoUpdate] check failed:', e?.message || e); } catch {}
      }
    }, 2500);
  } catch (e: any) {
    try { console.error('[AutoUpdate] setup failed:', e?.message || e); } catch {}
  }
}

function runInstallerExe(installerPathRaw: string, opts?: { silent?: boolean; forceRunAfter?: boolean }) {
  try {
    if (!installerPathRaw) return { ok: false, error: 'Missing installer path.' };
    const installerPath = path.resolve(String(installerPathRaw));
    if (!fs.existsSync(installerPath)) return { ok: false, error: 'Installer file not found.' };
    if (path.extname(installerPath).toLowerCase() !== '.exe') return { ok: false, error: 'Please select a .exe installer.' };

    const args: string[] = ['--updated'];
    if (opts?.silent) args.push('/S');
    if (opts?.forceRunAfter !== false) args.push('--force-run');
    const child = spawn(installerPath, args, { detached: true, stdio: 'ignore' });
    child.unref();

    // Quit this app so files can be replaced.
    setTimeout(() => {
      try { app.quit(); } catch {}
    }, 250);

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function getWindowIconPath(): string | undefined {
  try {
    const devCandidate = path.join(process.cwd(), 'build', 'icon.ico');
    const resourcesPath = (process as any).resourcesPath || app.getAppPath();
    const prodCandidate = path.join(resourcesPath, 'build', 'icon.ico');
    const candidate = app.isPackaged ? prodCandidate : devCandidate;
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch (_e) {
    // ignore
  }
  return undefined;
}

const WINDOW_ICON = getWindowIconPath();

// Helper: center a window either over its parent (if any) or the active screen
function centerWindow(win: any) {
  try {
    const parent = typeof win.getParentWindow === 'function' ? win.getParentWindow() : null;
    if (parent) {
      const pb = parent.getBounds();
      const wb = win.getBounds();
      const x = Math.max(pb.x + Math.round((pb.width - wb.width) / 2), 0);
      const y = Math.max(pb.y + Math.round((pb.height - wb.height) / 2), 0);
      win.setPosition(x, y);
    } else {
      // Fallback to Electron's built-in centering on the active display
      if (typeof win.center === 'function') win.center();
    }
  } catch (_e) {
    // best-effort; ignore positioning errors
  }
}

function showWindowFast(win: any, onBeforeShow?: () => void, opts?: { focus?: boolean; fallbackDelayMs?: number }) {
  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    fitWindowIntoWorkArea(win);
    try { onBeforeShow?.(); } catch {}
    try { if (!win.isDestroyed()) win.show(); } catch {}
    if (opts?.focus !== false) {
      try { if (!win.isDestroyed()) win.focus(); } catch {}
    }
  };

  const fallbackDelayMs = opts?.fallbackDelayMs ?? (app.isPackaged ? 120 : 220);
  win.once('ready-to-show', reveal);
  try {
    win.webContents.once('dom-ready', () => {
      setTimeout(reveal, 0);
    });
  } catch {}
  setTimeout(reveal, fallbackDelayMs);
}

const SILENT_PRINT_RENDERER_READY_TIMEOUT_MS = 7000;

function scheduleSilentPrint(win: any, opts?: { delayMs?: number; onDone?: () => void }) {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const delayMs = opts?.delayMs ?? 60;
    setTimeout(() => {
      try {
        if (win.isDestroyed()) return;
        win.webContents.print({ silent: true, printBackground: true }, (_success: boolean, failureReason: string) => {
          if (failureReason) {
            console.warn('[SilentPrint] failed:', failureReason);
          }
          try { opts?.onDone?.(); } catch {}
        });
      } catch (e: any) {
        console.warn('[SilentPrint] threw:', e?.message || String(e));
        try { opts?.onDone?.(); } catch {}
      }
    }, delayMs);
  };
  return start;
}

// Global context menu: enable Cut/Copy/Paste/Select All and Inspect (dev)
function setupContextMenu(win: typeof BrowserWindow.prototype) {
  try {
    win.webContents.on('context-menu', (event: any, params: any) => {
      const { isEditable, selectionText } = params || {};
      const template: any[] = [];
      if (isEditable) {
        template.push(
          { role: 'cut', label: 'Cut' },
          { role: 'copy', label: 'Copy' },
          { role: 'paste', label: 'Paste' },
          { type: 'separator' },
          { role: 'selectAll', label: 'Select All' },
        );
      } else {
        if (selectionText && String(selectionText).trim().length) {
          template.push({ role: 'copy', label: 'Copy' });
        }
        template.push({ role: 'selectAll', label: 'Select All' });
      }
      if (template.length && isDev) {
        template.push({ type: 'separator' });
      }
      if (isDev) {
        template.push({ label: 'Inspect Element', click: () => { try { win.webContents.inspectElement(params.x, params.y); } catch {} } });
      }
      if (!template.length) return;
      const menu = Menu.buildFromTemplate(template);
      const x = typeof params?.x === 'number' ? params.x : undefined;
      const y = typeof params?.y === 'number' ? params.y : undefined;
      // On Windows, omitting x/y can cause the first popup to appear at (0,0).
      if (typeof x === 'number' && typeof y === 'number') menu.popup({ window: win, x, y });
      else menu.popup({ window: win });
    });
  } catch {}
}

// Application menu: enables standard keyboard shortcuts (Undo/Redo/Cut/Copy/Paste, etc.)
function setupApplicationMenu() {
  try {
    const isMac = process.platform === 'darwin';
    const template: any[] = [];

    if (isMac) {
      template.push({
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      });
    }

    // Edit menu provides the accelerators for Ctrl/Cmd + C/V, etc.
    template.push({
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    });

    // Keep a minimal View menu for dev convenience; hidden menu still enables accelerators
    template.push({
      label: 'View',
      submenu: [
        { role: 'reload', visible: isDev },
        { role: 'forceReload', visible: isDev },
        { role: 'toggleDevTools', visible: isDev },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    });

    template.push({
      label: 'Window',
      submenu: isMac
        ? [ { role: 'minimize' }, { role: 'zoom' }, { role: 'close' } ]
        : [ { role: 'minimize' }, { role: 'close' } ],
    });

    template.push({
      label: 'Help',
      submenu: [
        {
          label: 'Open Releases Page',
          click: async () => {
            try { await shell.openExternal(getReleasesUrl()); } catch {}
          },
        },
        {
          label: 'Install Update From File…',
          click: async () => {
            try {
              const res = await dialog.showOpenDialog({
                title: 'Select GadgetBoy POS update installer (.exe)',
                properties: ['openFile'],
                filters: [
                  { name: 'Installer', extensions: ['exe'] },
                  { name: 'All Files', extensions: ['*'] },
                ],
              });
              if (res.canceled || !res.filePaths?.length) return;
              const picked = res.filePaths[0];

              const confirm = await dialog.showMessageBox({
                type: 'question',
                buttons: ['Run Installer', 'Cancel'],
                defaultId: 0,
                cancelId: 1,
                title: 'Install Update',
                message: 'This will close GadgetBoy POS and launch the installer to update the application.',
                detail: 'Your ProgramData (or chosen data folder) is not deleted by the installer.',
              });
              if (confirm.response !== 0) return;
              runInstallerExe(picked);
            } catch {}
          },
        },
      ],
    });

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  } catch {
    // best effort; if menu fails, keyboard shortcuts might be limited
  }
}

app.on('browser-window-created', (_event: any, win: typeof BrowserWindow.prototype) => {
  setupContextMenu(win);
});

// IPC handler for promise-based repair picker (returns selected repair)
ipcMain.handle('pick-repair-item', async (event: any, context?: { deviceCategory?: string; deviceName?: string; deviceModel?: string }) => {
  return new Promise((resolve) => {
    const parentFromSender = (() => {
      try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
    })();
    const child = new BrowserWindow({
      width: 1200,
      height: 960,
      resizable: true,
      parent: parentFromSender || BrowserWindow.getAllWindows()[0] || undefined,
      modal: true,
      ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
      backgroundColor: '#18181b',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      },
      show: false,
      title: windowTitle('Add Repair to Work Order'),
    });
    showWindowFast(child, () => { centerWindow(child); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
    const encodedContext = encodeURIComponent(JSON.stringify(context || {}));
    const url = isDev
      ? `${DEV_SERVER_URL}/?workOrderRepairPicker=true&deviceContext=${encodedContext}`
      : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?workOrderRepairPicker=true&deviceContext=${encodedContext}`;
    child.loadURL(url);

    // Listen for repair-selected event from picker window
    const handler = (_event: any, repair: any) => {
      resolve(repair);
      child.close();
      ipcMain.off('repair-selected', handler);
    };
    ipcMain.on('repair-selected', handler);

    child.on('closed', () => {
      ipcMain.off('repair-selected', handler);
      resolve(null); // If closed without selection
    });
  });
});

// Forward 'repair-selected' from picker window to the first main window
ipcMain.on('repair-selected', (_event: any, repair: any) => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length > 0) {
    allWindows[0].webContents.send('repair-selected', repair);
    console.log('Sent repair-selected to first main window');
  } else {
    console.log('No main window found for repair-selected');
  }
});

// Open a file with the OS default application
ipcMain.handle('os:openFile', async (_e: any, filePath: string) => {
  try {
    if (!filePath) return { ok: false, error: 'No file path' };
    const res = await shell.openPath(String(filePath));
    if (res) return { ok: false, error: res };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Open a URL in the user's default browser
ipcMain.handle('os:openUrl', async (_e: any, url: string) => {
  try {
    if (!url) return { ok: false, error: 'No URL' };
    const success = await shell.openExternal(String(url));
    // openExternal returns void in recent Electron, so assume success if no exception
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// -------------------------
// Email IPC
// -------------------------
ipcMain.handle('email:getConfig', async () => {
  try {
    const cfg = readEmailConfig();
    // Never return secrets to the renderer
    return {
      ok: true,
      fromEmail: cfg.fromEmail || 'gadgetboysc@gmail.com',
      fromName: cfg.fromName || 'GadgetBoy Repair & Retail',
      bodyTemplate: typeof cfg.bodyTemplate === 'string' ? cfg.bodyTemplate : null,
      hasAppPassword: !!decryptAppPassword(cfg),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('email:setGmailAppPassword', async (_e: any, appPassword: string, fromName?: string) => {
  try {
    const pass = String(appPassword || '').trim();
    if (!pass) return { ok: false, error: 'Missing app password' };
    if (!(safeStorage && typeof safeStorage.encryptString === 'function')) {
      return { ok: false, error: 'safeStorage not available on this system' };
    }
    const cfg = readEmailConfig();
    const encBuf = safeStorage.encryptString(pass);
    cfg.fromEmail = 'gadgetboysc@gmail.com';
    if (fromName != null) cfg.fromName = String(fromName || '').trim() || 'GadgetBoy Repair & Retail';
    cfg.gmailAppPasswordEnc = Buffer.from(encBuf).toString('base64');
    writeEmailConfig(cfg);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('email:setFromName', async (_e: any, fromName: string) => {
  try {
    const cfg = readEmailConfig();
    cfg.fromEmail = 'gadgetboysc@gmail.com';
    cfg.fromName = String(fromName || '').trim() || 'GadgetBoy Repair & Retail';
    writeEmailConfig(cfg);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('email:setBodyTemplate', async (_e: any, bodyTemplate: string) => {
  try {
    const cfg = readEmailConfig();
    const raw = String(bodyTemplate ?? '');
    const normalized = raw.replace(/\r\n/g, '\n').trim();
    cfg.bodyTemplate = normalized ? normalized : null;
    writeEmailConfig(cfg);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('email:clearGmailAppPassword', async () => {
  try {
    const cfg = readEmailConfig();
    cfg.gmailAppPasswordEnc = null;
    writeEmailConfig(cfg);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('email:sendQuoteHtml', async (_e: any, payload: any) => {
  try {
    const subject = String(payload?.subject || 'Gadgetboy Quote');
    const bodyText = String(payload?.bodyText || '');
    const htmlAttachment = String(payload?.html || '');
    if (!htmlAttachment) return { ok: false, error: 'Missing HTML attachment content' };
    const filename = String(payload?.filename || 'gadgetboy-quote.html').trim() || 'gadgetboy-quote.html';

    return await sendConfiguredEmail({
      to: String(payload?.to || '').trim(),
      subject,
      text: bodyText,
      attachments: [
        {
          filename,
          content: htmlAttachment,
          contentType: 'text/html; charset=utf-8',
        },
      ],
    });
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('email:sendQuotePdf', async (_e: any, payload: any) => {
  let win: any | null = null;
  let tempHtmlPath: string | null = null;

  try {
    const to = String(payload?.to || '').trim();
    const subject = String(payload?.subject || 'Gadgetboy Quote');
    const bodyText = String(payload?.bodyText || '');
    const html = String(payload?.html || '');
    const filenameRaw = String(payload?.filename || 'gadgetboy-quote.pdf').trim() || 'gadgetboy-quote.pdf';

    if (!to) return { ok: false, error: 'Missing recipient (to)' };
    if (!html) return { ok: false, error: 'Missing quote HTML content' };

    const pdfFilename = filenameRaw.toLowerCase().endsWith('.pdf') ? filenameRaw : `${filenameRaw}.pdf`;
    const safeBase = pdfFilename
      .replace(/\.pdf$/i, '')
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'quote';

    const tempDir = path.join(resolveDataRoot(), 'quote-previews');
    fs.mkdirSync(tempDir, { recursive: true });
    tempHtmlPath = path.join(tempDir, `${safeBase}-${Date.now()}-email.html`);
    fs.writeFileSync(tempHtmlPath, html, 'utf-8');

    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    await win.loadFile(tempHtmlPath);
    await new Promise((r) => setTimeout(r, 200));

    // Best-effort: wait for images, then shrink-to-fit pages before printing to PDF.
    // The Quote Generator HTML defines window.__gbFitQuotePages when loaded.
    try {
      await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          try {
            const imgs = Array.from(document.images || []);
            let pending = imgs.filter((img) => !img.complete).length;
            if (!pending) return resolve(true);
            const done = () => { pending--; if (pending <= 0) resolve(true); };
            imgs.forEach((img) => {
              if (img.complete) return;
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', done, { once: true });
            });
            setTimeout(() => resolve(true), 2000);
          } catch (e) { resolve(true); }
        });
      `);
    } catch {}

    try {
      await win.webContents.executeJavaScript(`
        try { window.__gbFitQuotePages && window.__gbFitQuotePages(); } catch (e) {}
        true;
      `);
      await new Promise((r) => setTimeout(r, 80));
    } catch {}

    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
      margins: { marginType: 'none' },
    });

    return await sendConfiguredEmail({
      to,
      subject,
      text: bodyText,
      attachments: [
        {
          filename: pdfFilename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try {
      if (win) win.destroy();
    } catch {}
    try {
      if (tempHtmlPath) fs.unlinkSync(tempHtmlPath);
    } catch {}
  }
});

ipcMain.handle('email:sendReportCsv', async (_e: any, payload: any) => {
  try {
    const subject = String(payload?.subject || 'GadgetBoy Report');
    const bodyText = String(payload?.bodyText || '');
    const csvAttachment = String(payload?.csv || '');
    if (!csvAttachment.trim()) return { ok: false, error: 'Missing report CSV content' };
    const filename = String(payload?.filename || 'gadgetboy-report.csv').trim() || 'gadgetboy-report.csv';

    return await sendConfiguredEmail({
      to: String(payload?.to || '').trim(),
      subject,
      text: bodyText,
      attachments: [
        {
          filename,
          content: csvAttachment,
          contentType: 'text/csv; charset=utf-8',
        },
      ],
    });
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// App info (used for update/version gating)
ipcMain.handle('app:getInfo', async () => {
  try {
    // app.getVersion() returns the Electron runtime version in dev mode.
    // Read from package.json directly so it always reflects the app version.
    let version = '0.0.0';
    try {
      const pkgPath = path.join(app.getAppPath(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      version = String(pkg.version || '0.0.0');
    } catch {
      version = app.getVersion();
    }
    return {
      version,
      platform: process.platform,
      arch: process.arch,
    };
  } catch (e) {
    return {
      version: '0.0.0',
      platform: process.platform,
      arch: process.arch,
      error: String(e),
    };
  }
});

// isDev already declared above

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle(),
  });
  showWindowFast(win, () => { try { win.maximize(); } catch {} });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  if (isDev && OPEN_MAIN_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  let url;
  if (isDev) {
    url = DEV_SERVER_URL;
  } else {
    // In production, load the bundled index.html from the app path
    url = getProdIndexUrl();
  }
  win.webContents.on('did-fail-load', (_e: any, errorCode: number, errorDescription: string, validatedURL: string) => {
    appendStartupLog(`did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });
  win.loadURL(url).catch((e: any) => {
    appendStartupLog(`main loadURL failed: ${String(e?.message || e)}`);
  });
  // After loading, check for ?newWorkOrder= in the URL and set the title
  win.webContents.on('did-finish-load', () => {
  win.webContents.executeJavaScript('window.location.search').then((search: string) => {
      if (search && search.includes('newWorkOrder=')) {
        win.setTitle(windowTitle('New Work Order'));
      }
    });
  });
}

// Close the current window safely (never closes the main window)
ipcMain.handle('window:closeSelf', async (event: any, opts?: { focusMain?: boolean }) => {
  try {
    const w = BrowserWindow.fromWebContents(event?.sender);
    if (!w) return { ok: false, error: 'no-window' };
    if (mainWindow && w.id === mainWindow.id) {
      // Refuse to close the main window via renderer request.
      try {
        if (opts?.focusMain) {
          mainWindow.show();
          mainWindow.focus();
        }
      } catch {}
      return { ok: false, blocked: true };
    }
    try { w.close(); } catch {}
    try {
      if (opts?.focusMain && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    } catch {}
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('window:focusMain', async () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      return { ok: true };
    }
    return { ok: false, error: 'no-main-window' };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Window fullscreen controls (renderer-triggered)
ipcMain.handle('window:getFullScreen', async (event: any) => {
  try { const w = BrowserWindow.fromWebContents(event.sender); return !!w?.isFullScreen(); } catch { return false; }
});
ipcMain.handle('window:setFullScreen', async (event: any, flag: boolean) => {
  try { const w = BrowserWindow.fromWebContents(event.sender); w?.setFullScreen(!!flag); return { ok: true, value: !!w?.isFullScreen() }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
});
ipcMain.handle('window:toggleFullScreen', async (event: any) => {
  try { const w = BrowserWindow.fromWebContents(event.sender); if (!w) return { ok: false, error: 'no-window' }; const next = !w.isFullScreen(); w.setFullScreen(next); return { ok: true, value: next }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
});
// Open Calendar window
ipcMain.handle('open-calendar', async () => {
  console.log('[IPC] open-calendar invoked');
  const { screen } = electron;
  const primary = screen.getPrimaryDisplay();
  const bounds = primary && primary.bounds ? primary.bounds : ({ x: 0, y: 0, width: 1920, height: 1080 } as any);
  const child = new BrowserWindow({
    x: (bounds as any).x ?? 0,
    y: (bounds as any).y ?? 0,
    width: Math.max(1400, (bounds as any).width ?? bounds.width),
    height: Math.max(900, (bounds as any).height ?? bounds.height),
    minWidth: Math.min(1200, (bounds as any).width ?? bounds.width),
    minHeight: Math.min(800, (bounds as any).height ?? bounds.height),
    useContentSize: true,
    resizable: true,
    maximizable: true,
    frame: true,
    parent: undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Calendar'),
  });
  try { child.setFullScreen(false); } catch {}
  try { if (typeof child.setFullScreenable === 'function') child.setFullScreenable(true); } catch {}
  // Ensure bounds are set to full display bounds prior to showing
  try { child.setBounds({ x: (bounds as any).x ?? 0, y: (bounds as any).y ?? 0, width: (bounds as any).width, height: (bounds as any).height }); } catch {}
  showWindowFast(child, () => {
    try { child.setBounds({ x: (bounds as any).x ?? 0, y: (bounds as any).y ?? 0, width: (bounds as any).width, height: (bounds as any).height }); } catch {}
    try { child.maximize(); } catch {}
  });
  child.on('show', () => { try { child.maximize(); child.focus(); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?calendar=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?calendar=true`;
  console.log('[Calendar] Loading URL:', url);
  child.loadURL(url).catch((e: any) => console.error('[Calendar] loadURL failed', e));
  return { ok: true };
});

// Open Notifications window (viewer)
ipcMain.handle('open-notifications', async (event: any) => {
  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const child = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    resizable: true,
    parent: parentFromSender || mainWindow || BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Notifications'),
  });
  showWindowFast(child, () => { try { centerWindow(child); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?notifications=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?notifications=true`;
  child.loadURL(url).catch((e: any) => console.error('[Notifications] loadURL failed', e));
  return { ok: true };
});

// Open Notification Settings window (admin)
ipcMain.handle('open-notification-settings', async (event: any) => {
  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const child = new BrowserWindow({
    width: 820,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    resizable: true,
    parent: parentFromSender || mainWindow || BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Notification Settings'),
  });
  showWindowFast(child, () => { try { centerWindow(child); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?notificationSettings=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?notificationSettings=true`;
  child.loadURL(url).catch((e: any) => console.error('[NotificationSettings] loadURL failed', e));
  return { ok: true };
});

// ─── Clover IPC handlers ───────────────────────────────────────────────────

ipcMain.handle('clover:rest:getConfig', async () => {
  const cfg = readCloverRestConfig();
  return {
    merchantId: cfg.merchantId || '',
    deviceSerial: cfg.deviceSerial || '',
    environment: cfg.environment || 'production',
    hasToken: !!cfg.accessTokenEnc,
    deviceIp: cfg.deviceIp || '',
    devicePort: cfg.devicePort || 12346,
    hasLocalToken: !!cfg.localAuthTokenEnc,
    remoteAppId: cfg.remoteAppId || '',
  };
});

ipcMain.handle('clover:saveConfig', async (_e: any, data: any) => {
  try {
    const cfg = readCloverRestConfig();
    if (data.merchantId !== undefined) cfg.merchantId = String(data.merchantId).trim();
    if (data.deviceSerial !== undefined) cfg.deviceSerial = String(data.deviceSerial).trim();
    if (data.environment !== undefined) cfg.environment = data.environment === 'sandbox' ? 'sandbox' : 'production';
    if (data.deviceIp !== undefined) cfg.deviceIp = String(data.deviceIp).trim();
    if (data.devicePort !== undefined) cfg.devicePort = Number(data.devicePort) || 12346;
    if (data.remoteAppId !== undefined) cfg.remoteAppId = String(data.remoteAppId).trim();
    if (data.localAuthToken !== undefined) {
      const tok = String(data.localAuthToken || '').trim();
      if (!tok) {
        delete cfg.localAuthTokenEnc;
      } else if (safeStorage && typeof safeStorage.encryptString === 'function') {
        cfg.localAuthTokenEnc = safeStorage.encryptString(tok).toString('base64');
      } else {
        cfg.localAuthToken = tok;
      }
    }
    writeCloverRestConfig(cfg);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('clover:setAccessToken', async (_e: any, token: string) => {
  try {
    const trimmed = String(token || '').trim();
    const cfg = readCloverRestConfig();
    if (!trimmed) {
      delete cfg.accessTokenEnc;
    } else if (safeStorage && typeof safeStorage.encryptString === 'function') {
      cfg.accessTokenEnc = safeStorage.encryptString(trimmed).toString('base64');
    } else {
      return { ok: false, error: 'safeStorage not available' };
    }
    writeCloverRestConfig(cfg);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('clover:testConnection', async () => {
  try {
    const cfg = readCloverRestConfig();
    const token = decryptCloverToken(cfg);
    if (!token) return { ok: false, error: 'No access token saved' };
    if (!cfg.merchantId) return { ok: false, error: 'No Merchant ID configured' };
    const base = cfg.environment === 'sandbox' ? 'https://sandbox.dev.clover.com' : 'https://api.clover.com';
    const merchant = await cloverApiRequest({ method: 'GET', urlPath: `/v3/merchants/${cfg.merchantId}`, accessToken: token, baseUrl: base });
    return { ok: true, merchantName: merchant?.name || cfg.merchantId };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('clover:chargeCard', async (_e: any, payload: any) => {
  try {
    const cfg = readCloverRestConfig();
    const token = decryptCloverToken(cfg);
    if (!token) return { ok: false, error: 'No access token saved' };
    if (!cfg.merchantId) return { ok: false, error: 'No Merchant ID configured' };
    const base = cfg.environment === 'sandbox' ? 'https://sandbox.dev.clover.com' : 'https://api.clover.com';
    const mId = cfg.merchantId;
    const amountCents: number = Math.round(Number(payload?.amountCents) || 0);
    const label: string = String(payload?.label || 'Service');

    // 1. Create order
    const order = await cloverApiRequest({ method: 'POST', urlPath: `/v3/merchants/${mId}/orders`, accessToken: token, body: { currency: 'USD' }, baseUrl: base });
    const orderId: string = order?.id;
    if (!orderId) return { ok: false, error: 'Failed to create Clover order' };

    // 2. Add line item
    await cloverApiRequest({ method: 'POST', urlPath: `/v3/merchants/${mId}/orders/${orderId}/line_items`, accessToken: token, body: { name: label, price: amountCents, unitQty: 1000 }, baseUrl: base });

    // 3. Get device ID by serial
    let deviceId: string | null = null;
    if (cfg.deviceSerial) {
      const devResp = await cloverApiRequest({ method: 'GET', urlPath: `/v3/merchants/${mId}/devices?filter=serial%3D${encodeURIComponent(cfg.deviceSerial)}`, accessToken: token, baseUrl: base });
      deviceId = devResp?.elements?.[0]?.id || null;
    }
    if (!deviceId) {
      // Fall back to first device
      const devResp = await cloverApiRequest({ method: 'GET', urlPath: `/v3/merchants/${mId}/devices`, accessToken: token, baseUrl: base });
      deviceId = devResp?.elements?.[0]?.id || null;
    }
    if (!deviceId) return { ok: false, error: 'No Clover device found on this account' };

    // 4. Send order to Pay Display
    await cloverApiRequest({ method: 'POST', urlPath: `/v3/merchants/${mId}/devices/${deviceId}/pay_display`, accessToken: token, body: { action: 'SHOW_ORDER', order: { id: orderId } }, baseUrl: base });

    return { ok: true, orderId };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// ─── Clover Local Pay Display (LAN direct to Flex on port 12346) ───────────

function decryptLocalCloverToken(cfg: any): string | null {
  try {
    const enc = cfg?.localAuthTokenEnc;
    if (enc && typeof enc === 'string' && safeStorage && typeof safeStorage.decryptString === 'function') {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
    if (typeof cfg?.localAuthToken === 'string' && cfg.localAuthToken.trim()) return cfg.localAuthToken.trim();
    return null;
  } catch { return null; }
}

function cloverLocalRequest(opts: {
  deviceIp: string;
  devicePort: number;
  path: string;
  method: string;
  authToken?: string | null;
  body?: any;
  timeoutMs?: number;
  forceHttps?: boolean;
  bearerPrefix?: 'Bearer' | 'token';
}): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  return new Promise((resolve) => {
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const mod = opts.forceHttps ? https : http;
    const authHeaders: Record<string, string> = {};
    if (opts.authToken) {
      // Clover REST Pay API accepts either format depending on firmware version
      if (opts.bearerPrefix === 'token') {
        authHeaders['Authorization'] = `token ${opts.authToken}`;
      } else {
        authHeaders['Authorization'] = `Bearer ${opts.authToken}`;
      }
    }
    const reqOpts: any = {
      method: opts.method,
      hostname: opts.deviceIp,
      port: opts.devicePort,
      path: opts.path,
      headers: {
        'Accept': 'application/json',
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...authHeaders,
      },
      ...(opts.forceHttps ? { rejectUnauthorized: false } : {}),
      timeout: opts.timeoutMs || 30000,
    };
    try {
      const req = mod.request(reqOpts, (res: any) => {
        let data = '';
        res.on('data', (c: any) => { data += String(c ?? ''); });
        res.on('end', () => {
          const status = Number(res?.statusCode || 0);
          const ok = status >= 200 && status < 300;
          try {
            const json = data.trim() ? JSON.parse(data) : null;
            resolve({ ok, status, data: json });
          } catch {
            resolve({ ok, status, data: data.trim() || null });
          }
        });
      });
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
      req.on('error', (err: any) => { resolve({ ok: false, error: String(err?.message || err) }); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    } catch (e: any) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

// Probe several path/protocol/auth combos; return first success or best error
async function cloverProbeDevice(deviceIp: string, devicePort: number, authToken: string | null, remoteAppId?: string, timeoutMs = 6000) {
  type Probe = { path: string; forceHttps: boolean; bearerPrefix?: 'Bearer' | 'token'; label: string };
  const probes: Probe[] = [
    { path: '/status', forceHttps: false, bearerPrefix: 'Bearer', label: 'HTTP /status Bearer' },
    { path: '/status', forceHttps: false, bearerPrefix: 'token',  label: 'HTTP /status token'  },
    { path: '/status', forceHttps: false,                          label: 'HTTP /status (no auth)' },
    { path: '/ping',   forceHttps: false, bearerPrefix: 'Bearer', label: 'HTTP /ping Bearer'   },
    { path: '/ping',   forceHttps: false, bearerPrefix: 'token',  label: 'HTTP /ping token'    },
    { path: '/',       forceHttps: false,                          label: 'HTTP / (no auth)'    },
    { path: '/status', forceHttps: true,  bearerPrefix: 'Bearer', label: 'HTTPS /status Bearer' },
    { path: '/status', forceHttps: true,  bearerPrefix: 'token',  label: 'HTTPS /status token'  },
    { path: '/',       forceHttps: true,                           label: 'HTTPS / (no auth)'   },
  ];
  const errors: string[] = [];
  for (const p of probes) {
    const res = await cloverLocalRequest({ deviceIp, devicePort, path: p.path, method: 'GET', authToken, timeoutMs, forceHttps: p.forceHttps, bearerPrefix: p.bearerPrefix });
    if (res.ok || (res.status && res.status < 500)) {
      return { ok: true, probe: p.label, status: res.status };
    }
    errors.push(`${p.label}: ${res.error || `HTTP ${res.status}`}`);
  }
  const uniqueErrors = [...new Set(errors.map(e => e.replace(/^[^:]+: /, '')))];
  return { ok: false, error: `Device not reachable. Errors: ${uniqueErrors.join(', ')}. Check IP (${deviceIp}:${devicePort}), that Pay Display app is open, and enter the Auth Token shown in the Pay Display app settings on the Flex.` };
}

ipcMain.handle('clover:testLocalConnection', async () => {
  try {
    const cfg = readCloverRestConfig();
    const deviceIp = String(cfg.deviceIp || '').trim();
    const devicePort = Number(cfg.devicePort || 12346);
    if (!deviceIp) return { ok: false, error: 'No device IP configured.' };
    if (!cfg.remoteAppId) return { ok: false, error: 'Remote App ID is required. Get it from developer.clover.com → your app → App ID.' };
    const authToken = decryptLocalCloverToken(cfg);
    const res = await cloverProbeDevice(deviceIp, devicePort, authToken, cfg.remoteAppId);
    if (res.ok) return { ok: true, message: `Clover Flex reachable at ${deviceIp}:${devicePort} (${res.probe})` };
    return { ok: false, error: res.error || 'Device not reachable. Check IP, port, and that the Pay Display app is open.' };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('clover:localCharge', async (_e: any, payload: any) => {
  try {
    const cfg = readCloverRestConfig();
    const deviceIp = String(cfg.deviceIp || '').trim();
    const devicePort = Number(cfg.devicePort || 12346);
    if (!deviceIp) return { ok: false, error: 'No device IP configured. Go to Admin → Integrations → Clover to set up.' };
    const authToken = decryptLocalCloverToken(cfg);
    const amountCents = Math.round(Number(payload?.amountCents) || 0);
    if (amountCents <= 0) return { ok: false, error: 'Amount must be greater than zero.' };
    const externalId = `GB-${Date.now()}`;
    const body: any = { externalId, amount: amountCents, tipMode: 'NO_TIP' };
    if (cfg.remoteAppId) body.appId = cfg.remoteAppId;
    // Try HTTP first; fall back to HTTPS if ECONNRESET (some devices use HTTPS)
    let res = await cloverLocalRequest({ deviceIp, devicePort, path: '/sale', method: 'POST', authToken, body, timeoutMs: 30000, forceHttps: false });
    if (!res.ok && (res.error || '').includes('ECONNRESET')) {
      res = await cloverLocalRequest({ deviceIp, devicePort, path: '/sale', method: 'POST', authToken, body, timeoutMs: 30000, forceHttps: true });
    }
    if (res.ok) return { ok: true, result: res.data, externalId };
    return { ok: false, error: res.error || `Device returned HTTP ${res.status}. Check that Pay Display is open on the Flex.` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('clover:cashSale', async (_e: any, payload: any) => {
  try {
    const cfg = readCloverRestConfig();
    const token = decryptCloverToken(cfg);
    if (!token) return { ok: false, error: 'No access token saved' };
    if (!cfg.merchantId) return { ok: false, error: 'No Merchant ID configured' };
    const base = cfg.environment === 'sandbox' ? 'https://sandbox.dev.clover.com' : 'https://api.clover.com';
    const mId = cfg.merchantId;
    const amountCents: number = Math.round(Number(payload?.amountCents) || 0);
    const tenderedCents: number = Math.round(Number(payload?.tenderedCents) || amountCents);
    const label: string = String(payload?.label || 'Service');

    // 1. Create order
    const order = await cloverApiRequest({ method: 'POST', urlPath: `/v3/merchants/${mId}/orders`, accessToken: token, body: { currency: 'USD' }, baseUrl: base });
    const orderId: string = order?.id;
    if (!orderId) return { ok: false, error: 'Failed to create Clover order' };

    // 2. Add line item
    await cloverApiRequest({ method: 'POST', urlPath: `/v3/merchants/${mId}/orders/${orderId}/line_items`, accessToken: token, body: { name: label, price: amountCents, unitQty: 1000 }, baseUrl: base });

    // 3. Record cash payment (triggers drawer)
    await cloverApiRequest({
      method: 'POST',
      urlPath: `/v3/merchants/${mId}/orders/${orderId}/payments`,
      accessToken: token,
      body: {
        tender: { labelKey: 'com.clover.tender.cash' },
        amount: amountCents,
        cashTendered: tenderedCents,
      },
      baseUrl: base,
    });

    return { ok: true, orderId };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('open-clover-settings', async (event: any) => {
  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const child = new BrowserWindow({
    width: 680,
    height: 580,
    resizable: false,
    parent: parentFromSender || mainWindow || BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Clover Settings'),
  });
  showWindowFast(child, () => { try { centerWindow(child); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?cloverSettings=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?cloverSettings=true`;
  child.loadURL(url).catch((e: any) => console.error('[CloverSettings] loadURL failed', e));
  return { ok: true };
});

// Open Backup (Data Management) window
ipcMain.handle('open-backup', async () => {
  const child = new BrowserWindow({
    width: 1100,
    height: 800,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Data Management'),
  });
  showWindowFast(child, () => { centerWindow(child); }, { focus: false });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?backup=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?backup=true`;
  child.loadURL(url);
  return { ok: true };
});

// Server/NAS sync + backup (offline-first)
ipcMain.handle('server-sync-get-config', async () => {
  return { ok: true, config: readServerSyncConfig() };
});

ipcMain.handle('server-sync-set-config', async (_e: any, patch: Partial<ServerSyncConfig>) => {
  writeServerSyncConfig(patch || {});
  return { ok: true, config: readServerSyncConfig() };
});

ipcMain.handle('server-sync-browse', async (event: any, opts?: { basePath?: string }) => {
  const parentWin = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  try {
    const test = await serverTestConnection();
    if (!test.ok) return { ok: false, error: test.error || 'Server not reachable', serverRoot: test.serverRoot };
    const basePath = (opts?.basePath || '').toString().trim();
    const open = await dialog.showOpenDialog(parentWin as any, {
      title: 'Select NAS/Server Folder',
      defaultPath: basePath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (open.canceled || !open.filePaths || !open.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    return { ok: true, path: open.filePaths[0] };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('server-sync-test', async () => {
  const res = await serverTestConnection();
  return res.ok ? { ok: true, serverRoot: res.serverRoot } : { ok: false, error: res.error || 'Test failed', serverRoot: res.serverRoot };
});

ipcMain.handle('server-sync-sync-now', async (_e: any, direction?: 'auto' | 'push' | 'pull') => {
  const res = await syncDbWithServer(direction || 'auto');
  return res;
});

ipcMain.handle('server-sync-backup-now', async (_e: any, label?: string) => {
  const cfg = readServerSyncConfig();
  const safeLabel = (label || 'manual').toString().trim() || 'manual';
  const out: any = { ok: true };
  try {
    const doLocal = cfg.backupToLocal !== false;
    if (doLocal) {
      out.localBackupPath = await snapshotDbToRoot(resolveDataRoot(), safeLabel);
    }
  } catch (e: any) {
    out.ok = false;
    out.error = e?.message || String(e);
  }
  try {
    const doServer = cfg.enabled === true && cfg.backupToServer !== false;
    if (doServer) {
      const test = await serverTestConnection();
      if (test.ok && test.serverRoot) {
        const serverBackupsDir = serverBackupsDirFromConfig(cfg, test.serverRoot);
        out.serverBackupPath = await snapshotDbToBackupsDir(serverBackupsDir, safeLabel);
      } else {
        out.serverError = test.error || 'Server not reachable';
      }
    }
  } catch (e: any) {
    out.serverError = e?.message || String(e);
  }
  return out;
});

ipcMain.handle('server-sync-status', async () => {
  const cfg = readServerSyncConfig();
  return { ok: true, config: cfg };
});

// -------------------------------------------------------------
// Clover Remote Pay (LAN)
// -------------------------------------------------------------

type CloverConnectionConfig = {
  ipAddress?: string;
  // Stored encrypted (base64) when safeStorage is available.
  authTokenEnc?: string | null;
  // Fallback when safeStorage is unavailable.
  authToken?: string | null;
  updatedAt?: string;
};

function cloverConfigPath(): string {
  return path.join(resolveDataRoot(), 'clover-connection.json');
}

function encryptToBase64(value: string): string | null {
  try {
    const v = String(value || '').trim();
    if (!v) return null;
    if (safeStorage && typeof safeStorage.encryptString === 'function') {
      const buf = safeStorage.encryptString(v);
      return Buffer.from(buf).toString('base64');
    }
  } catch {
    // ignore
  }
  return null;
}

function decryptFromBase64(enc: string): string | null {
  try {
    const e = String(enc || '').trim();
    if (!e) return null;
    const buf = Buffer.from(e, 'base64');
    if (safeStorage && typeof safeStorage.decryptString === 'function') {
      return safeStorage.decryptString(buf);
    }
  } catch {
    // ignore
  }
  return null;
}

function readCloverConfig(): CloverConnectionConfig {
  try {
    const p = cloverConfigPath();
    if (!fs.existsSync(p)) return { ipAddress: '', authTokenEnc: null, authToken: null };
    const raw = fs.readFileSync(p, 'utf-8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return { ipAddress: '', authTokenEnc: null, authToken: null };
    return {
      ipAddress: typeof (json as any).ipAddress === 'string' ? String((json as any).ipAddress) : '',
      authTokenEnc: typeof (json as any).authTokenEnc === 'string' ? String((json as any).authTokenEnc) : null,
      authToken: typeof (json as any).authToken === 'string' ? String((json as any).authToken) : null,
      updatedAt: typeof (json as any).updatedAt === 'string' ? String((json as any).updatedAt) : undefined,
    };
  } catch {
    return { ipAddress: '', authTokenEnc: null, authToken: null };
  }
}

function writeCloverConfig(patch: Partial<CloverConnectionConfig>) {
  try {
    const current = readCloverConfig();
    const next: CloverConnectionConfig = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    ensureDir(path.dirname(cloverConfigPath()));
    fs.writeFileSync(cloverConfigPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

function getCloverAuthToken(cfg?: CloverConnectionConfig): string | null {
  const c = cfg || readCloverConfig();
  const dec = c?.authTokenEnc ? decryptFromBase64(c.authTokenEnc) : null;
  if (dec && dec.trim()) return dec.trim();
  const plain = typeof c?.authToken === 'string' ? c.authToken : null;
  if (plain && plain.trim()) return plain.trim();
  return null;
}

function persistCloverAuthToken(token: string) {
  const t = String(token || '').trim();
  if (!t) return;
  const enc = encryptToBase64(t);
  if (enc) {
    writeCloverConfig({ authTokenEnc: enc, authToken: null });
  } else {
    writeCloverConfig({ authToken: t, authTokenEnc: null });
  }
}

type CloverStatus = {
  ok: true;
  state: 'disconnected' | 'connecting' | 'pairing' | 'connected' | 'ready' | 'error' | string;
  endpoint?: string;
  pairingCode?: string | null;
  lastError?: string | null;
  updatedAt?: string;
};

let cloverConnector: any | null = null;
let cloverStatus: CloverStatus = {
  ok: true,
  state: 'disconnected',
  endpoint: '',
  pairingCode: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
};

const pendingCloverSales = new Map<string, { resolve: (resp: any) => void; reject: (err: any) => void; timer: any }>();

function emitToAllWindows(channel: string, payload: any) {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      try { w.webContents.send(channel, payload); } catch {}
    }
  } catch {
    // ignore
  }
}

function setCloverStatus(patch: Partial<CloverStatus>) {
  cloverStatus = {
    ...cloverStatus,
    ...patch,
    ok: true,
    updatedAt: new Date().toISOString(),
  };
  emitToAllWindows('clover:status', cloverStatus);
}

function rejectAllPendingCloverSales(message: string) {
  try {
    for (const [, p] of pendingCloverSales) {
      try { clearTimeout(p.timer); } catch {}
      try { p.reject(new Error(message)); } catch {}
    }
  } catch {
    // ignore
  }
  pendingCloverSales.clear();
}

function disposeCloverConnector() {
  try {
    if (cloverConnector && typeof cloverConnector.dispose === 'function') {
      cloverConnector.dispose();
    }
  } catch {
    // ignore
  }
  cloverConnector = null;
  rejectAllPendingCloverSales('Clover disconnected');
}

function buildCloverEndpoint(ipAddress: string): string {
  const raw = String(ipAddress || '').trim();
  if (!raw) return '';

  // If a full ws/wss URL is provided, normalize path to /remote_pay.
  if (/^wss?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (!u.pathname || u.pathname === '/') u.pathname = '/remote_pay';
      return u.toString();
    } catch {
      const noTrail = raw.replace(/\/+$/, '');
      return /\/remote_pay$/i.test(noTrail) ? noTrail : `${noTrail}/remote_pay`;
    }
  }

  const cleaned = raw.replace(/\/+$/, '');
  let hostPort = cleaned;
  let pathPart = '/remote_pay';
  if (cleaned.includes('/')) {
    const idx = cleaned.indexOf('/');
    hostPort = cleaned.slice(0, idx);
    const p = cleaned.slice(idx);
    if (p && p !== '/') pathPart = p;
  }
  if (!hostPort) return '';
  const withPort = hostPort.includes(':') ? hostPort : `${hostPort}:12346`;
  const finalPath = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return `wss://${withPort}${finalPath}`;
}

function cloverSaleResponseToSummary(resp: any): any {
  try {
    const success = Boolean(resp?.getSuccess?.());
    const result = resp?.getResult?.();
    const reason = resp?.getReason?.();
    const message = resp?.getMessage?.();
    const payment = resp?.getPayment?.();
    const paymentId = payment?.getId?.();
    const externalPaymentId = payment?.getExternalPaymentId?.();
    const amount = payment?.getAmount?.();
    const tipAmount = payment?.getTipAmount?.();
    return {
      success,
      result: typeof result !== 'undefined' ? String(result) : null,
      reason: reason ? String(reason) : null,
      message: message ? String(message) : null,
      paymentId: paymentId ? String(paymentId) : null,
      externalPaymentId: externalPaymentId ? String(externalPaymentId) : null,
      amount: typeof amount === 'number' ? amount : null,
      tipAmount: typeof tipAmount === 'number' ? tipAmount : null,
    };
  } catch {
    return { success: false, result: null, reason: null, message: null };
  }
}

function makeCloverListener(): any {
  const noop = () => {};
  return {
    onDisconnected: () => {
      setCloverStatus({ state: 'disconnected', pairingCode: null });
      rejectAllPendingCloverSales('Clover disconnected');
    },
    onDeviceDisconnected: () => {
      setCloverStatus({ state: 'disconnected', pairingCode: null });
      rejectAllPendingCloverSales('Clover disconnected');
    },
    onDeviceConnected: () => {
      setCloverStatus({ state: 'connected', lastError: null });
    },
    onReady: (_merchantInfo: any) => {
      setCloverStatus({ state: 'ready', pairingCode: null, lastError: null });
    },
    onDeviceReady: (_merchantInfo: any) => {
      setCloverStatus({ state: 'ready', pairingCode: null, lastError: null });
    },
    onDeviceActivityStart: noop,
    onDeviceActivityEnd: noop,
    onDeviceError: (deviceErrorEvent: any) => {
      const msg = String(deviceErrorEvent?.getMessage?.() || deviceErrorEvent?.message || 'Clover device error');
      setCloverStatus({ state: 'error', lastError: msg });
    },
    onAuthResponse: noop,
    onTipAdjustAuthResponse: noop,
    onCapturePreAuthResponse: noop,
    onVerifySignatureRequest: noop,
    onConfirmPaymentRequest: noop,
    onCloseoutResponse: noop,
    onSaleResponse: (response: any) => {
      const summary = cloverSaleResponseToSummary(response);
      emitToAllWindows('clover:saleResponse', summary);

      const key = String(summary?.externalPaymentId || '').trim();
      const pending = key ? pendingCloverSales.get(key) : null;
      if (pending) {
        try { clearTimeout(pending.timer); } catch {}
        pendingCloverSales.delete(key);
        try { pending.resolve(response); } catch {}
        return;
      }

      // Fallback: if we couldn't correlate and there is exactly one pending sale, resolve it.
      if (pendingCloverSales.size === 1) {
        const [[onlyKey, onlyPending]] = Array.from(pendingCloverSales.entries());
        try { clearTimeout(onlyPending.timer); } catch {}
        pendingCloverSales.delete(onlyKey);
        try { onlyPending.resolve(response); } catch {}
      }
    },
    onManualRefundResponse: noop,
    onRefundPaymentResponse: noop,
    onTipAdded: noop,
    onVoidPaymentResponse: noop,
    onVoidPaymentRefundResponse: noop,
    onVaultCardResponse: noop,
    onPreAuthResponse: noop,
    onRetrievePendingPaymentsResponse: noop,
    onReadCardDataResponse: noop,
    onMessageFromActivity: noop,
    onCustomActivityResponse: noop,
    onRetrieveDeviceStatusResponse: noop,
    onInvalidStateTransitionResponse: noop,
    onResetDeviceResponse: noop,
    onRetrievePaymentResponse: noop,
    onRetrievePrintersResponse: noop,
    onPrintJobStatusResponse: noop,
    onPrintManualRefundReceipt: noop,
    onPrintManualRefundDeclineReceipt: noop,
    onPrintPaymentReceipt: noop,
    onPrintPaymentDeclineReceipt: noop,
    onPrintPaymentMerchantCopyReceipt: noop,
    onPrintRefundPaymentReceipt: noop,
    onCustomerProvidedData: noop,
    onDisplayReceiptOptionsResponse: noop,
  };
}

function requireCloverReady(): { ok: true } | { ok: false; error: string } {
  if (!cloverConnector) return { ok: false, error: 'Clover is not connected.' };
  if (cloverConnector?.isReady !== true) return { ok: false, error: 'Clover is not ready yet. Finish pairing and wait for Ready.' };
  return { ok: true };
}

// Best-effort cleanup on quit.
try {
  app.on('before-quit', () => {
    try { disposeCloverConnector(); } catch {}
  });
} catch {}

ipcMain.handle('clover:getConfig', async () => {
  const cfg = readCloverConfig();
  return {
    ok: true,
    ipAddress: String(cfg.ipAddress || ''),
    hasAuthToken: Boolean(getCloverAuthToken(cfg)),
  };
});

ipcMain.handle('clover:setConfig', async (_e: any, patch: any) => {
  try {
    const p = (patch && typeof patch === 'object') ? patch : {};
    const next: Partial<CloverConnectionConfig> = {};
    if (typeof p.ipAddress === 'string') next.ipAddress = String(p.ipAddress || '').trim();
    if (p.clearAuthToken === true) {
      next.authToken = null;
      next.authTokenEnc = null;
    }
    if (Object.keys(next).length > 0) writeCloverConfig(next);
    const cfg = readCloverConfig();
    return {
      ok: true,
      ipAddress: String(cfg.ipAddress || ''),
      hasAuthToken: Boolean(getCloverAuthToken(cfg)),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('clover:getStatus', async () => {
  return cloverStatus;
});

ipcMain.handle('clover:connect', async () => {
  try {
    const cfg = readCloverConfig();
    const ip = String(cfg.ipAddress || '').trim();
    if (!ip) return { ok: false, error: 'Clover IP address is not set.' };

    const endpoint = buildCloverEndpoint(ip);
    if (!endpoint) return { ok: false, error: 'Invalid Clover IP address.' };

    // Dispose any prior connection.
    disposeCloverConnector();

    setCloverStatus({ state: 'connecting', endpoint, pairingCode: null, lastError: null });

    const remotePayCloud = require('remote-pay-cloud');
    const CloverWebSocketInterface = remotePayCloud.CloverWebSocketInterface;

    class NodeWebSocketImpl extends CloverWebSocketInterface {
      constructor(ep: string) { super(ep); }
      public createWebSocket(ep: string): any {
        const WS = require('ws');
        // Clover devices frequently use self-signed certs on LAN.
        return new WS(ep, { rejectUnauthorized: false });
      }
      public sendPong(): any {
        try { (this as any).webSocket?.pong?.(); } catch {}
        return this;
      }
      public sendPing(): any {
        try { (this as any).webSocket?.ping?.(); } catch {}
        return this;
      }
      public static createInstance(ep: string): any { return new NodeWebSocketImpl(ep); }
    }

    const appVersion = (() => { try { return app.getVersion(); } catch { return '0.0.0'; } })();
    const applicationId = `com.gadgetboy.pos:${appVersion}`;
    const posName = 'GadgetBoy POS';
    const serialNumber = `GBPOS-${String(os.hostname?.() || 'POS')}`;
    const authToken = getCloverAuthToken(cfg);

    const onPairingCode = (code: string) => {
      const c = String(code || '').trim();
      if (!c) return;
      setCloverStatus({ state: 'pairing', pairingCode: c });
      emitToAllWindows('clover:pairingCode', c);
    };

    const onPairingSuccess = (token: string) => {
      try { persistCloverAuthToken(token); } catch {}
      setCloverStatus({ pairingCode: null });
    };

    const builder = new remotePayCloud.WebSocketPairedCloverDeviceConfigurationBuilder(
      applicationId,
      endpoint,
      posName,
      serialNumber,
      authToken || null,
      onPairingCode,
      onPairingSuccess,
    );
    builder.setWebSocketFactoryFunction(NodeWebSocketImpl.createInstance);

    const deviceConfig = builder.build();
    cloverConnector = new remotePayCloud.CloverConnector(deviceConfig);
    cloverConnector.addCloverConnectorListener(makeCloverListener());
    cloverConnector.initializeConnection();

    return { ok: true, endpoint };
  } catch (e: any) {
    const msg = e?.message || String(e);
    setCloverStatus({ state: 'error', lastError: msg });
    return { ok: false, error: msg };
  }
});

ipcMain.handle('clover:disconnect', async () => {
  try {
    disposeCloverConnector();
    setCloverStatus({ state: 'disconnected', pairingCode: null });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('clover:sale', async (_e: any, amountCents: any) => {
  try {
    const ready = requireCloverReady();
    if (!ready.ok) return { ok: false, error: ready.error };

    const amt = Number(amountCents);
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'Invalid amount.' };
    if (pendingCloverSales.size > 0) return { ok: false, error: 'Another Clover sale is already in progress.' };

    const remotePayCloud = require('remote-pay-cloud');
    const req = new remotePayCloud.remotepay.SaleRequest();
    req.setAmount(Math.round(amt));
    const externalId = `GBPOS-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    req.setExternalId(externalId);

    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCloverSales.delete(externalId);
        reject(new Error('Timed out waiting for Clover sale response.'));
      }, 120000);
      pendingCloverSales.set(externalId, { resolve, reject, timer });
      cloverConnector.sale(req);
    });

    return { ok: true, response: cloverSaleResponseToSummary(response) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('clover:openCashDrawer', async (_e: any, payload: any) => {
  try {
    const ready = requireCloverReady();
    if (!ready.ok) return { ok: false, error: ready.error };

    const remotePayCloud = require('remote-pay-cloud');
    const reason = String(payload?.reason || 'GadgetBoy POS').trim() || 'GadgetBoy POS';
    const deviceId = String(payload?.deviceId || '').trim();
    if (deviceId) {
      const req = new remotePayCloud.remotepay.OpenCashDrawerRequest();
      req.setReason(reason);
      req.setDeviceId(deviceId);
      cloverConnector.openCashDrawer(req);
    } else {
      cloverConnector.openCashDrawer(reason);
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// -------------------------------------------------------------
// Twilio SMS
// -------------------------------------------------------------

type TwilioSmsConfig = {
  accountSid?: string;
  // Optional: when using Twilio API Keys, this can be the API Key SID (SK...).
  // When omitted, accountSid is used as the HTTP Basic auth username.
  authSid?: string;
  fromNumber?: string;
  // Stored encrypted (base64) when safeStorage is available.
  authTokenEnc?: string | null;
  // Fallback when safeStorage is unavailable.
  authToken?: string | null;
  updatedAt?: string;
};

function twilioConfigPath(): string {
  return path.join(resolveDataRoot(), 'twilio-config.json');
}

function readTwilioConfig(): TwilioSmsConfig {
  try {
    const p = twilioConfigPath();
    if (!fs.existsSync(p)) return { accountSid: '', authSid: '', fromNumber: '', authTokenEnc: null, authToken: null };
    const raw = fs.readFileSync(p, 'utf-8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return { accountSid: '', authSid: '', fromNumber: '', authTokenEnc: null, authToken: null };
    return {
      accountSid: typeof (json as any).accountSid === 'string' ? String((json as any).accountSid) : '',
      authSid: typeof (json as any).authSid === 'string' ? String((json as any).authSid) : '',
      fromNumber: typeof (json as any).fromNumber === 'string' ? String((json as any).fromNumber) : '',
      authTokenEnc: typeof (json as any).authTokenEnc === 'string' ? String((json as any).authTokenEnc) : null,
      authToken: typeof (json as any).authToken === 'string' ? String((json as any).authToken) : null,
      updatedAt: typeof (json as any).updatedAt === 'string' ? String((json as any).updatedAt) : undefined,
    };
  } catch {
    return { accountSid: '', authSid: '', fromNumber: '', authTokenEnc: null, authToken: null };
  }
}

function writeTwilioConfig(patch: Partial<TwilioSmsConfig>) {
  try {
    const current = readTwilioConfig();
    const next: TwilioSmsConfig = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    ensureDir(path.dirname(twilioConfigPath()));
    fs.writeFileSync(twilioConfigPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

function getTwilioAuthToken(cfg?: TwilioSmsConfig): string | null {
  const c = cfg || readTwilioConfig();
  const dec = c?.authTokenEnc ? decryptFromBase64(String(c.authTokenEnc)) : null;
  if (dec && dec.trim()) return dec.trim();
  const plain = typeof c?.authToken === 'string' ? c.authToken : null;
  if (plain && plain.trim()) return plain.trim();
  return null;
}

function normalizePhoneE164(raw: any): string | null {
  try {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (s.startsWith('+')) {
      const digits = s.replace(/[^0-9]/g, '');
      if (digits.length < 10) return null;
      return `+${digits}`;
    }
    const digits = s.replace(/\D+/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null;
  } catch {
    return null;
  }
}

async function twilioSendSms(toRaw: any, bodyRaw: any): Promise<{ ok: true; sid?: string | null } | { ok: false; error: string }> {
  try {
    const cfg = readTwilioConfig();
    const accountSid = String(cfg.accountSid || '').trim();
    const authSid = String((cfg as any).authSid || accountSid).trim();
    const authToken = String(getTwilioAuthToken(cfg) || '').trim();
    const fromNumberRaw = String(cfg.fromNumber || '').trim();

    if (!accountSid) return { ok: false, error: 'Twilio not configured: missing Account SID.' };
    if (!authSid) return { ok: false, error: 'Twilio not configured: missing Auth SID (API Key SID) / Account SID.' };
    if (!authToken) return { ok: false, error: 'Twilio not configured: missing Auth Token.' };
    if (!fromNumberRaw) return { ok: false, error: 'Twilio not configured: missing From Number.' };

    const to = normalizePhoneE164(toRaw);
    if (!to) return { ok: false, error: 'Invalid recipient phone number.' };

    const from = normalizePhoneE164(fromNumberRaw);
    if (!from) return { ok: false, error: 'Invalid From phone number. Use +E.164 or a 10-digit US number.' };

    const body = String(bodyRaw || '').trim();
    if (!body) return { ok: false, error: 'Message body is empty.' };

    const postData = new URLSearchParams({ To: to, From: from, Body: body }).toString();
    const auth = Buffer.from(`${authSid}:${authToken}`).toString('base64');

    const result = await new Promise<{ ok: true; sid?: string | null } | { ok: false; error: string }>((resolve) => {
      try {
        const req = https.request({
          method: 'POST',
          hostname: 'api.twilio.com',
          path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 15000,
        }, (res: any) => {
          let data = '';
          res.on('data', (chunk: any) => { data += String(chunk ?? ''); });
          res.on('end', () => {
            const status = Number(res?.statusCode || 0);
            const ok = status >= 200 && status < 300;
            if (ok) {
              try {
                const json = JSON.parse(data || '{}');
                resolve({ ok: true, sid: json?.sid || null });
              } catch {
                resolve({ ok: true, sid: null });
              }
              return;
            }

            try {
              const json = JSON.parse(data || '{}');
              const msg = String(json?.message || '').trim();
              resolve({ ok: false, error: msg || `Twilio error (${status || 'unknown'})` });
            } catch {
              resolve({ ok: false, error: `Twilio error (${status || 'unknown'})` });
            }
          });
        });

        req.on('timeout', () => {
          try { req.destroy(new Error('Request timed out')); } catch {}
        });
        req.on('error', (err: any) => {
          resolve({ ok: false, error: String(err?.message || err) });
        });
        req.write(postData);
        req.end();
      } catch (e: any) {
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });

    return result;
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function normalizeStatusForCompare(raw: any): string {
  try {
    return String(raw || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function maybeAutoTextOnStatusChange(key: string, previousItem: any, updatedItem: any, db: any) {
  try {
    const k = String(key || '').trim();
    if (k !== 'workOrders' && k !== 'sales') return;

    const cfg = readTwilioConfig();
    const hasConfig = Boolean(String(cfg?.accountSid || '').trim())
      && Boolean(String(cfg?.fromNumber || '').trim())
      && Boolean(getTwilioAuthToken(cfg));
    if (!hasConfig) return;

    const prevStatus = normalizeStatusForCompare(previousItem?.status);
    const nextStatus = normalizeStatusForCompare(updatedItem?.status);
    if (!prevStatus || !nextStatus || prevStatus === nextStatus) return;

    const statusDisplay = String(updatedItem?.status || '').trim();
    if (!statusDisplay) return;

    let phoneRaw = String(updatedItem?.customerPhone || updatedItem?.phone || '').trim();
    const cid = Number(updatedItem?.customerId || 0);
    if (Number.isFinite(cid) && cid > 0) {
      try {
        const customers: any[] = Array.isArray(db?.customers) ? db.customers : [];
        const c = customers.find((x: any) => Number(x?.id || 0) === cid);
        if (c) {
          const p1 = String((c as any)?.phone || '').trim();
          const p2 = String((c as any)?.phoneAlt || '').trim();
          phoneRaw = p1 || p2 || phoneRaw;
        }
      } catch {
        // ignore
      }
    }
    if (!normalizePhoneE164(phoneRaw)) return;

    const idNum = Number(updatedItem?.id || 0);
    const invoice = (Number.isFinite(idNum) && idNum > 0) ? `GB${String(idNum).padStart(7, '0')}` : '';
    const label = invoice || (Number.isFinite(idNum) && idNum > 0 ? `#${idNum}` : 'ticket');
    const typeLabel = k === 'sales' ? 'sale' : 'ticket';
    const body = `GadgetBoy Update: Your ${typeLabel} ${label} status is now ${statusDisplay}.`;

    // Fire-and-forget: never block DB writes.
    void twilioSendSms(phoneRaw, body).then((res) => {
      if (!res?.ok) {
        console.warn('[Twilio] auto status SMS failed:', res?.error || 'unknown error');
      }
    });
  } catch {
    // ignore
  }
}

ipcMain.handle('twilio:getConfig', async () => {
  const cfg = readTwilioConfig();
  return {
    ok: true,
    accountSid: String(cfg.accountSid || ''),
    authSid: String((cfg as any).authSid || ''),
    fromNumber: String(cfg.fromNumber || ''),
    hasAuthToken: Boolean(getTwilioAuthToken(cfg)),
  };
});

ipcMain.handle('twilio:setConfig', async (_e: any, patch: any) => {
  try {
    const p = (patch && typeof patch === 'object') ? patch : {};
    const next: Partial<TwilioSmsConfig> = {};

    if (typeof p.accountSid === 'string') next.accountSid = String(p.accountSid || '').trim();
    if (typeof p.authSid === 'string') (next as any).authSid = String(p.authSid || '').trim();
    if (typeof p.fromNumber === 'string') next.fromNumber = String(p.fromNumber || '').trim();

    if (p.clearAuthToken === true) {
      next.authToken = null;
      next.authTokenEnc = null;
    }

    if (typeof p.authToken === 'string') {
      const token = String(p.authToken || '').trim();
      if (token) {
        const enc = encryptToBase64(token);
        if (enc) {
          next.authTokenEnc = enc;
          next.authToken = null;
        } else {
          next.authToken = token;
          next.authTokenEnc = null;
        }
      }
    }

    if (Object.keys(next).length > 0) writeTwilioConfig(next);
    const cfg = readTwilioConfig();
    return {
      ok: true,
      accountSid: String(cfg.accountSid || ''),
      authSid: String((cfg as any).authSid || ''),
      fromNumber: String(cfg.fromNumber || ''),
      hasAuthToken: Boolean(getTwilioAuthToken(cfg)),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('twilio:sendSms', async (_e: any, payload: any) => {
  try {
    const to = payload?.to;
    const body = payload?.body;
    return await twilioSendSms(to, body);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('twilio:getMessages', async (_e: any, customerId: any) => {
  try {
    const cid = Number(customerId || 0);
    if (!cid) return { ok: true, messages: [] };
    const db = readDb();
    const msgs: any[] = Array.isArray(db['smsMessages']) ? db['smsMessages'] : [];
    const result = msgs
      .filter((m: any) => Number(m?.customerId || 0) === cid)
      .sort((a: any, b: any) => new Date(String(a.sentAt || 0)).getTime() - new Date(String(b.sentAt || 0)).getTime());
    return { ok: true, messages: result };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), messages: [] };
  }
});

ipcMain.handle('twilio:logMessage', async (_e: any, msg: any) => {
  try {
    const m = (msg && typeof msg === 'object') ? msg : {};
    const db = readDb();
    const msgs: any[] = Array.isArray(db['smsMessages']) ? db['smsMessages'] : [];
    const maxId = msgs.reduce((acc: number, x: any) => Math.max(acc, Number(x?.id || 0)), 0);
    const entry = {
      id: maxId + 1,
      customerId: Number(m.customerId || 0),
      to: String(m.to || '').trim(),
      body: String(m.body || '').trim(),
      sentAt: m.sentAt || new Date().toISOString(),
      direction: m.direction || 'out',
      twilioSid: m.twilioSid || null,
    };
    msgs.push(entry);
    db['smsMessages'] = msgs;
    writeDb(db);
    return { ok: true, message: entry };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('open-twilio-settings', async (event: any) => {
  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const child = new BrowserWindow({
    width: 580,
    height: 640,
    resizable: false,
    parent: parentFromSender || mainWindow || BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('SMS / Twilio Settings'),
  });
  showWindowFast(child, () => { try { centerWindow(child); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?twilioSettings=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?twilioSettings=true`;
  child.loadURL(url).catch((e: any) => console.error('[TwilioSettings] loadURL failed', e));
  return { ok: true };
});

// Open Clock In window
ipcMain.handle('open-clock-in', async () => {
  console.log('[IPC] open-clock-in invoked');
  const child = new BrowserWindow({
    width: 900,
    height: 700,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Employee Clock In/Out'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?clockIn=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?clockIn=true`;
  console.log('[ClockIn] Loading URL:', url);
  child.loadURL(url).catch((e: any) => console.error('[ClockIn] loadURL failed', e));
  return { ok: true };
});

// Open Quote Generator window
ipcMain.handle('open-quote-generator', async () => {
  // If the quote generator is already open, focus it and reload in dev so UI changes appear immediately.
  try {
    const existing = BrowserWindow.getAllWindows().find((w: any) => {
      try { return String(w?.webContents?.getURL?.() || '').includes('quote=true'); } catch { return false; }
    });
    if (existing && !existing.isDestroyed()) {
      try { existing.show(); } catch {}
      try { existing.focus(); } catch {}
      try { if (isDev) existing.webContents.reloadIgnoringCache(); } catch {}
      return { ok: true, reused: true };
    }
  } catch {}

  const { screen } = electron;
  const primary = screen.getPrimaryDisplay();
  const bounds = primary && primary.bounds ? primary.bounds : ({ x: 0, y: 0, width: 1920, height: 1080 } as any);
  const child = new BrowserWindow({
    x: (bounds as any).x ?? 0,
    y: (bounds as any).y ?? 0,
    width: Math.max(1400, (bounds as any).width ?? bounds.width),
    height: Math.max(900, (bounds as any).height ?? bounds.height),
    minWidth: Math.min(1200, (bounds as any).width ?? bounds.width),
    minHeight: Math.min(800, (bounds as any).height ?? bounds.height),
    useContentSize: true,
    resizable: true,
    maximizable: true,
    frame: true,
    parent: undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Generate Quote'),
  });
  try { child.setFullScreen(false); } catch {}
  try { if (typeof child.setFullScreenable === 'function') child.setFullScreenable(true); } catch {}
  // Ensure bounds are set to full display bounds prior to showing
  try { child.setBounds({ x: (bounds as any).x ?? 0, y: (bounds as any).y ?? 0, width: (bounds as any).width, height: (bounds as any).height }); } catch {}
  showWindowFast(child, () => {
    try { child.setBounds({ x: (bounds as any).x ?? 0, y: (bounds as any).y ?? 0, width: (bounds as any).width, height: (bounds as any).height }); } catch {}
    try { child.maximize(); } catch {}
  });
  child.on('show', () => { try { child.maximize(); child.focus(); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev
    ? `${DEV_SERVER_URL}/?quote=true&t=${Date.now()}`
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?quote=true`;
  child.loadURL(url).catch((e: any) => console.error('[Quote] loadURL failed', e));
  return { ok: true };
});

// Simple JSON file DB stored in userData
function dbFilePath(): string {
  return path.join(resolveDataRoot(), 'gbpos-db.json');
}

const DB_DEBUG = isDev && process.env.GBPOS_DB_DEBUG === '1';
function dbLog(...args: any[]) {
  try { if (DB_DEBUG) console.log(...args); } catch {}
}

let lastPerfLogAt = 0;
function appendPerfLog(line: string) {
  try {
    const msg = `${new Date().toISOString()} ${line}\n`;
    const p = path.join(resolveDataRoot(), 'gbpos-perf.log');
    // Async, fire-and-forget to avoid blocking the main thread.
    try { void (fs.promises as any).appendFile(p, msg, 'utf-8').catch(() => {}); } catch {}
  } catch {
    // ignore
  }
}

function logSlowDbWrite(details: { bytes: number; stringifyMs: number; totalMs: number; filePath: string }) {
  // Throttle perf logs to avoid noisy I/O.
  const now = Date.now();
  if (now - lastPerfLogAt < 15000) return;
  lastPerfLogAt = now;
  try {
    appendPerfLog(`db-write bytes=${details.bytes} stringifyMs=${details.stringifyMs} totalMs=${details.totalMs} file=${details.filePath}`);
  } catch {
    // ignore
  }
}

const COLLECTION_CHANGED_EVENT: Record<string, string> = {
  workOrders: 'workorders:changed',
  customers: 'customers:changed',
  sales: 'sales:changed',
  quotes: 'quotes:changed',
  technicians: 'technicians:changed',
  deviceCategories: 'deviceCategories:changed',
  productCategories: 'productCategories:changed',
  repairTypes: 'repairTypes:changed',
  repairCategories: 'repairCategories:changed',
  products: 'products:changed',
  purchaseOrders: 'purchaseOrders:changed',
  partSources: 'partSources:changed',
  calendarEvents: 'calendarEvents:changed',
  calendarNotes: 'calendarNotes:changed',
  timeEntries: 'timeEntries:changed',
  notifications: 'notifications:changed',
  notificationSettings: 'notificationSettings:changed',
  settings: 'settings:changed',
};

let changedEmitTimer: NodeJS.Timeout | null = null;
const pendingChangedEvents = new Set<string>();
const pendingChangedPayloads = new Map<string, any>();
function scheduleCollectionChanged(key: string, payload?: any) {
  try {
    const ev = COLLECTION_CHANGED_EVENT[String(key || '')];
    if (!ev) return;
    pendingChangedEvents.add(ev);
    if (payload !== undefined) pendingChangedPayloads.set(ev, payload);
    if (changedEmitTimer) return;
    // Coalesce rapid updates (autosaves/typing) to avoid renderer thrash.
    changedEmitTimer = setTimeout(() => {
      changedEmitTimer = null;
      const events = Array.from(pendingChangedEvents);
      pendingChangedEvents.clear();
      const wins = BrowserWindow.getAllWindows();
      for (const w of wins) {
        for (const name of events) {
          try { w.webContents.send(name, pendingChangedPayloads.get(name)); } catch {}
        }
      }
      for (const name of events) pendingChangedPayloads.delete(name);
    }, 120);
  } catch {
    // ignore
  }
}

let dbCache: any | null = null;

function defaultDb() {
  return { customers: [], workOrders: [], calendarNotes: [] };
}

function readDb() {
  try {
    if (dbCache) return dbCache;
    const p = dbFilePath();
    if (!fs.existsSync(p)) {
      // Main file missing — try .bak before returning empty
      try {
        const bak = p + '.bak';
        if (fs.existsSync(bak)) {
          const bakRaw = fs.readFileSync(bak, 'utf-8');
          const bakParsed = JSON.parse(bakRaw || '{}');
          if (bakParsed && typeof bakParsed === 'object') {
            console.warn('[DB] Main DB missing — loaded from .bak');
            dbCache = bakParsed;
            if (!Array.isArray((dbCache as any).customers)) (dbCache as any).customers = [];
            if (!Array.isArray((dbCache as any).workOrders)) (dbCache as any).workOrders = [];
            return dbCache;
          }
        }
      } catch {}
      return defaultDb();
    }
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    dbCache = (parsed && typeof parsed === 'object') ? parsed : defaultDb();
    if (!Array.isArray((dbCache as any).customers)) (dbCache as any).customers = [];
    if (!Array.isArray((dbCache as any).workOrders)) (dbCache as any).workOrders = [];
    return dbCache;
  } catch (e) {
    // Parse/read error: do NOT cache the empty default — a subsequent write would
    // overwrite all data with an empty DB. Leave dbCache null so the next call
    // retries from disk. Try .bak as a fallback first.
    try {
      const bak = dbFilePath() + '.bak';
      if (fs.existsSync(bak)) {
        const bakRaw = fs.readFileSync(bak, 'utf-8');
        const bakParsed = JSON.parse(bakRaw || '{}');
        if (bakParsed && typeof bakParsed === 'object') {
          console.warn('[DB] Main DB corrupted — loaded from .bak:', String(e));
          dbCache = bakParsed;
          if (!Array.isArray((dbCache as any).customers)) (dbCache as any).customers = [];
          if (!Array.isArray((dbCache as any).workOrders)) (dbCache as any).workOrders = [];
          return dbCache;
        }
      }
    } catch {}
    console.error('[DB] readDb failed, returning empty (not caching):', e);
    // Return empty WITHOUT setting dbCache — safe fallback that does not persist.
    return defaultDb();
  }
}

// Simple atomic write with a tiny in-process queue to serialize writes
let writeQueue: Promise<void> = Promise.resolve();
let writeTimer: NodeJS.Timeout | null = null;
let writePending = false;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    try { setImmediate(resolve); } catch { resolve(); }
  });
}

async function writeCompactJsonStreamAtomic(tmpPath: string, snapshot: any): Promise<{ bytes: number; stringifyMs: number }> {
  const t0 = Date.now();
  const ws = fs.createWriteStream(tmpPath, { encoding: 'utf-8' });
  let streamError: any = null;
  try {
    ws.on('error', (e: any) => {
      streamError = e || new Error('write stream error');
    });
  } catch {
    // ignore
  }
  let bytes = 0;
  let lastYieldAt = Date.now();

  const writeChunk = async (chunk: string) => {
    if (streamError) throw streamError;
    bytes += Buffer.byteLength(chunk, 'utf8');
    try {
      const ok = ws.write(chunk);
      if (!ok) {
        await new Promise<void>((resolve, reject) => {
          ws.once('drain', resolve);
          ws.once('error', reject);
        });
      }
    } catch (e) {
      try { ws.destroy(); } catch {}
      throw e;
    }
    if (streamError) throw streamError;
  };

  const maybeYield = async () => {
    const now = Date.now();
    if (now - lastYieldAt >= 25) {
      lastYieldAt = now;
      await yieldToEventLoop();
    }
  };

  const safeStringify = (v: any, forArrayElement: boolean): string | undefined => {
    try {
      let s: any;
      try {
        s = JSON.stringify(v);
      } catch {
        // BigInt-safe fallback to avoid hard failure.
        s = JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
      }
      if (typeof s !== 'string') return forArrayElement ? 'null' : undefined;
      return s;
    } catch {
      return forArrayElement ? 'null' : undefined;
    }
  };

  const obj = (snapshot && typeof snapshot === 'object') ? snapshot : defaultDb();
  await writeChunk('{');
  let firstProp = true;
  for (const key of Object.keys(obj)) {
    const value = (obj as any)[key];
    if (Array.isArray(value)) {
      if (!firstProp) await writeChunk(',');
      firstProp = false;
      await writeChunk(JSON.stringify(key));
      await writeChunk(':[');
      for (let i = 0; i < value.length; i++) {
        if (i > 0) await writeChunk(',');
        const elStr = safeStringify(value[i], true) || 'null';
        await writeChunk(elStr);
        if ((i & 0xff) === 0) await maybeYield();
      }
      await writeChunk(']');
      await maybeYield();
      continue;
    }

    // Non-array: omit undefined/function/symbol values (matches JSON.stringify object behavior).
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') continue;
    const valStr = safeStringify(value, false);
    if (typeof valStr !== 'string') continue;

    if (!firstProp) await writeChunk(',');
    firstProp = false;
    await writeChunk(JSON.stringify(key));
    await writeChunk(':');
    await writeChunk(valStr);
    await maybeYield();
  }
  await writeChunk('}');

  if (streamError) {
    try { ws.destroy(); } catch {}
    throw streamError;
  }

  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.once('close', () => resolve());
    try { ws.end(); } catch (e) { reject(e); }
  });

  if (streamError) throw streamError;

  return { bytes, stringifyMs: Date.now() - t0 };
}

function flushWriteDb() {
  if (!writePending) return;
  writePending = false;
  // Guard: if dbCache is null (e.g. nulled by server sync between writeDb() and flush),
  // skip this flush rather than writing an empty defaultDb() to disk.
  const snapshot = dbCache;
  if (!snapshot) return;
  writeQueue = writeQueue
    .then(async () => {
      const p = dbFilePath();
      const tmp = p + '.tmp';
      const bak = p + '.bak';
      const t0 = Date.now();
      let stringifyMs = 0;
      let bytes = 0;
      try {
        // Streamed compact JSON prevents long main-thread stalls during large DB writes.
        const res = await writeCompactJsonStreamAtomic(tmp, snapshot);
        bytes = res.bytes;
        stringifyMs = res.stringifyMs;
      } catch (writeErr) {
        // Stream write failed — clean up the partial tmp file and preserve the
        // real DB file intact. Do NOT write defaultDb() here as that would wipe all data.
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        throw writeErr; // outer .catch() swallows it to keep queue moving
      }
      // Keep a rolling backup (.bak) of the previous DB before committing the new one.
      // This provides a recovery path if the rename succeeds but the new file is later
      // found to be unreadable.
      try {
        if (fs.existsSync(p)) {
          fs.copyFileSync(p, bak);
        }
      } catch {
        // Non-fatal: .bak failure must never block the main write.
      }
      await (fs.promises as any).rename(tmp, p);
      const totalMs = Date.now() - t0;
      if (stringifyMs > 120 || totalMs > 350) {
        try { logSlowDbWrite({ bytes, stringifyMs, totalMs, filePath: p }); } catch {}
      }
      // Opportunistic server push; never blocks local writes.
      try { scheduleServerAutoSync(); } catch {}
    })
    .catch(() => {
      /* swallow to keep queue moving */
    });
}
async function drainDbWrites() {
  try {
    if (writeTimer) {
      try { clearTimeout(writeTimer); } catch {}
      writeTimer = null;
    }
    flushWriteDb();
    await writeQueue;
  } catch {
    // ignore
  }
}
function writeDb(db: any) {
  // Keep an in-memory copy so reads don't re-parse a potentially huge file on every IPC call.
  dbCache = db;
  writePending = true;
  if (writeTimer) return true;
  // Coalesce rapid updates (autosave, typing) into fewer disk writes.
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushWriteDb();
  }, 300);
  return true;
}

type CloudSessionState = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  accessToken: string;
  shopId: string;
};

let cloudSession: CloudSessionState | null = null;
let cloudClient: any | null = null;

type CloudCollectionSyncStatus = {
  cursor: CloudCursor | null;
  syncedAt: string;
  rowsReceived: number;
  approximateBytes: number;
  lastError?: string;
};

type CloudSyncState = {
  shopId: string;
  lastSuccessAt: string;
  lastError: string;
  collections: Record<string, CloudCollectionSyncStatus>;
};

let cloudSyncState: CloudSyncState = { shopId: '', lastSuccessAt: '', lastError: '', collections: {} };

type CloudSyncOperation = {
  id: string;
  op: 'upsert' | 'delete';
  key: string;
  item?: any;
  legacyId?: number | string | null;
  createdAt: string;
  attempts?: number;
  lastError?: string;
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

function shouldUseCloudDb(key: string): boolean {
  if ((process.env.GBPOS_DISABLE_CLOUD_DB || '').toString().trim() === '1') return false;
  return !!(cloudSession?.accessToken && cloudSession?.shopId && CLOUD_TABLE_BY_KEY[String(key || '')]);
}

class NoopRealtimeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = NoopRealtimeWebSocket.CLOSED;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  onopen: any = null;
  onerror: any = null;
  onmessage: any = null;
  onclose: any = null;

  constructor() {
    setTimeout(() => {
      try { this.onerror?.(new Error('Realtime is disabled in GB POS main process.')); } catch {}
      this.close();
    }, 0);
  }

  send() {
    // Realtime channels are intentionally unused by the Electron main process.
  }

  close() {
    this.readyState = NoopRealtimeWebSocket.CLOSED;
    try { this.onclose?.({ code: 1000, reason: 'Realtime disabled', wasClean: true }); } catch {}
  }
}

function getCloudClient() {
  if (!cloudSession || !createSupabaseClient) return null;
  if (cloudClient) return cloudClient;
  cloudClient = createSupabaseClient(cloudSession.supabaseUrl, cloudSession.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: NoopRealtimeWebSocket as any },
    global: {
      headers: {
        Authorization: `Bearer ${cloudSession.accessToken}`,
      },
    },
  });
  return cloudClient;
}

ipcMain.handle('cloud:setSession', async (_e: any, payload: any) => {
  const supabaseUrl = String(payload?.supabaseUrl || '').trim();
  const supabasePublishableKey = String(payload?.supabasePublishableKey || '').trim();
  const accessToken = String(payload?.accessToken || '').trim();
  const shopId = String(payload?.shopId || '').trim();
  if (!supabaseUrl || !supabasePublishableKey || !accessToken || !shopId) {
    cloudSession = null;
    cloudClient = null;
    return { ok: false, error: 'Missing cloud session values.' };
  }
  cloudSession = { supabaseUrl, supabasePublishableKey, accessToken, shopId };
  cloudClient = null;
  cloudSyncState = readCloudSyncState(shopId);
  try {
    const [customersCount, workOrdersCount, salesCount] = await Promise.all([
      getCloudCount('customers'),
      getCloudCount('workOrders'),
      getCloudCount('sales'),
    ]);
    scheduleCloudSyncQueueDrain(100);
    return {
      ok: true,
      counts: {
        customers: customersCount,
        workOrders: workOrdersCount,
        sales: salesCount,
      },
      pendingSync: readCloudSyncQueue().length,
    };
  } catch (e: any) {
    cloudSession = null;
    cloudClient = null;
    return { ok: false, error: e?.message || 'Cloud database check failed.' };
  }
});

ipcMain.handle('cloud:clearSession', async () => {
  cloudSession = null;
  cloudClient = null;
  cloudSyncState = { shopId: '', lastSuccessAt: '', lastError: '', collections: {} };
  return { ok: true };
});

ipcMain.handle('cloud:collectionChanged', async (_e: any, key: string) => {
  const collection = String(key || '').trim();
  if (!CLOUD_TABLE_BY_KEY[collection]) return { ok: false, error: 'Unknown cloud collection.' };
  try {
    // A realtime notification only tells us that cloud state changed. Refresh the
    // durable local cache before notifying renderers so they never reread stale
    // rows and resurrect a ticket that another device just closed or moved.
    return await synchronizeDesktopCollection(collection);
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
});

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

function cloudSyncQueuePath(): string {
  return path.join(resolveDataRoot(), 'cloud-sync-queue.json');
}

function cloudCursorPath(): string {
  return path.join(resolveDataRoot(), 'cloud-sync-cursors.json');
}

function readCloudSyncState(shopId = cloudSession?.shopId || ''): CloudSyncState {
  try {
    const parsed = JSON.parse(fs.readFileSync(cloudCursorPath(), 'utf8'));
    if (parsed?.shopId === shopId && parsed?.collections && typeof parsed.collections === 'object') {
      return {
        shopId,
        lastSuccessAt: String(parsed.lastSuccessAt || ''),
        lastError: String(parsed.lastError || ''),
        collections: parsed.collections,
      };
    }
  } catch {}
  return { shopId, lastSuccessAt: '', lastError: '', collections: {} };
}

function writeCloudSyncState(next: CloudSyncState) {
  cloudSyncState = next;
  try {
    ensureDir(path.dirname(cloudCursorPath()));
    fs.writeFileSync(cloudCursorPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch {}
}

function readCloudSyncQueue(): CloudSyncOperation[] {
  try {
    const p = cloudSyncQueuePath();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const json = JSON.parse(raw || '[]');
    return Array.isArray(json) ? json.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}

function writeCloudSyncQueue(queue: CloudSyncOperation[]) {
  try {
    ensureDir(path.dirname(cloudSyncQueuePath()));
    fs.writeFileSync(cloudSyncQueuePath(), JSON.stringify(Array.isArray(queue) ? queue : [], null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

function cloudSyncOperationId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      clientPickupDate: cloudDate(row.client_pickup_date),
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
    const credential = extra?.credentialsByStaffId?.get(String(row.id))
      || extra?.credentialsByLegacyId?.get(String(row.legacy_id || ''))
      || {};
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
    ...(cloudObject(row.payload)),
    id,
    name: row.name || cloudObject(row.payload).name,
    createdAt: cloudDate(row.created_at),
    updatedAt: cloudDate(row.updated_at),
    cloudId: row.id,
  };
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
      client_pickup_date: typeof item.clientPickupDate === 'undefined' ? undefined : toCloudIso(item.clientPickupDate),
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
      legacy_created_at: toCloudIso(item.createdAt),
      legacy_updated_at: toCloudIso(item.updatedAt),
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
  if (key === 'technicians') {
    const legacyId = toCloudTextId(item.id);
    if (!legacyId) return null;
    return {
      shop_id,
      legacy_id: legacyId,
      first_name: toCloudString(item.firstName),
      last_name: toCloudString(item.lastName),
      nickname: toCloudString(item.nickname),
      phone: toCloudString(item.phone),
      email: toCloudString(item.email).trim() || `legacy-technician-${legacyId}@local.gbpos.invalid`,
      profile_icon: toCloudString(item.profileIcon),
      schedule: toCloudObject(item.schedule),
      status: item.status || 'active',
      role: item.role || 'technician',
      legacy_updated_at: toCloudIso(item.updatedAt),
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
    calendarNotes: { id: 'legacy_id', date: 'note_date', updatedAt: 'updated_at', createdAt: 'created_at' },
    technicians: { id: 'legacy_id', updatedAt: 'updated_at', firstName: 'first_name', lastName: 'last_name' },
  };
  if (map[key]?.[s]) return map[key][s];
  if (!s) {
    if (key === 'workOrders') return 'activity_at';
    if (key === 'sales') return 'check_in_at';
    if (key === 'quotes') return 'content_updated_at';
    if (key === 'calendarNotes') return 'note_date';
    if (key === 'technicians') return 'first_name';
    return 'legacy_id';
  }
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) ? s : 'legacy_id';
}

async function getDesktopTechnicianCredentials() {
  const client = getCloudClient();
  if (!client || !cloudSession) return { credentialsByStaffId: new Map<string, any>(), credentialsByLegacyId: new Map<string, any>() };
  const res = await client.from('technician_private_credentials')
    .select('staff_profile_id,legacy_technician_id,legacy_passcode')
    .eq('shop_id', cloudSession.shopId);
  if (res.error) return { credentialsByStaffId: new Map<string, any>(), credentialsByLegacyId: new Map<string, any>() };
  const credentialsByStaffId = new Map<string, any>();
  const credentialsByLegacyId = new Map<string, any>();
  for (const row of Array.isArray(res.data) ? res.data : []) {
    if (row.staff_profile_id) credentialsByStaffId.set(String(row.staff_profile_id), row);
    if (row.legacy_technician_id) credentialsByLegacyId.set(String(row.legacy_technician_id), row);
  }
  return { credentialsByStaffId, credentialsByLegacyId };
}

function displayAwareWindowSize(
  parent: any,
  preferred: { width: number; height: number },
  minimum: { width: number; height: number },
  margin = 24,
) {
  let display: any = null;
  try {
    if (parent && !parent.isDestroyed?.() && electron.screen?.getDisplayMatching) {
      display = electron.screen.getDisplayMatching(parent.getBounds());
    }
  } catch {}
  try {
    display ||= electron.screen?.getPrimaryDisplay?.();
  } catch {}

  const workArea = display?.workArea || display?.workAreaSize || display?.bounds || { width: preferred.width, height: preferred.height };
  const availableWidth = Math.max(480, Math.floor(Number(workArea.width || preferred.width) - margin * 2));
  const availableHeight = Math.max(420, Math.floor(Number(workArea.height || preferred.height) - margin * 2));
  const width = Math.min(preferred.width, availableWidth);
  const height = Math.min(preferred.height, availableHeight);
  return {
    width,
    height,
    minWidth: Math.min(minimum.width, width),
    minHeight: Math.min(minimum.height, height),
  };
}

function fitWindowIntoWorkArea(win: any, margin = 12) {
  try {
    if (!win || win.isDestroyed?.()) return;
    const parent = win.getParentWindow?.() || null;
    const display = parent && electron.screen?.getDisplayMatching
      ? electron.screen.getDisplayMatching(parent.getBounds())
      : electron.screen?.getDisplayMatching?.(win.getBounds()) || electron.screen?.getPrimaryDisplay?.();
    const workArea = display?.workArea || display?.bounds;
    if (!workArea) return;

    const availableWidth = Math.max(480, Math.floor(Number(workArea.width) - margin * 2));
    const availableHeight = Math.max(420, Math.floor(Number(workArea.height) - margin * 2));
    const [minimumWidth, minimumHeight] = win.getMinimumSize?.() || [0, 0];
    if (minimumWidth > availableWidth || minimumHeight > availableHeight) {
      win.setMinimumSize?.(Math.min(minimumWidth, availableWidth), Math.min(minimumHeight, availableHeight));
    }

    const current = win.getBounds();
    const width = Math.min(current.width, availableWidth);
    const height = Math.min(current.height, availableHeight);
    const minX = Number(workArea.x) + margin;
    const minY = Number(workArea.y) + margin;
    const maxX = Number(workArea.x) + Number(workArea.width) - margin - width;
    const maxY = Number(workArea.y) + Number(workArea.height) - margin - height;
    const x = Math.min(Math.max(current.x, minX), Math.max(minX, maxX));
    const y = Math.min(Math.max(current.y, minY), Math.max(minY, maxY));
    if (width !== current.width || height !== current.height || x !== current.x || y !== current.y) {
      win.setBounds({ x, y, width, height });
    }
  } catch {
    // Best-effort fitting must never prevent a daughter window from opening.
  }
}

function isAssignableDesktopTechnicianRow(row: any): boolean {
  if (!row || row.active === false || row.status === 'disabled') return false;
  if (!row.isLoginProfile) return true;
  return !!(String(row.nickname || '').trim() || String(row.passcode || '').trim() || String(row.phone || '').trim()
    || (row.schedule && typeof row.schedule === 'object' && Object.keys(row.schedule).length > 0));
}

async function cloudDbGet(key: string, opts?: { limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }) {
  const client = getCloudClient();
  const table = CLOUD_TABLE_BY_KEY[String(key || '')];
  if (!client || !cloudSession || !table) return null;
  let q = client.from(table).select('*').eq('shop_id', cloudSession.shopId);
  const sortColumn = cloudSortColumn(key, opts?.sortBy);
  q = q.order(sortColumn, { ascending: opts?.sortDir === 'asc', nullsFirst: false });
  if (typeof opts?.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0) {
    q = q.limit(Math.floor(opts.limit));
  }
  const res = await q;
  if (res.error) throw new Error(`Cloud ${key} read failed: ${res.error.message}`);
  const extra = key === 'technicians' ? await getDesktopTechnicianCredentials() : undefined;
  let rows = (Array.isArray(res.data) ? res.data : []).map((row: any) => fromCloudRow(key, row, extra));
  if (key === 'technicians') rows = rows.filter(isAssignableDesktopTechnicianRow);
  return rows;
}

async function cloudDbGetChanged(key: string, cursor: CloudCursor | null, limit = 0) {
  const client = getCloudClient();
  const table = CLOUD_TABLE_BY_KEY[String(key || '')];
  if (!client || !cloudSession || !table) throw new Error('Cloud session is not ready.');
  const pageSize = 1000;
  const rawRows: any[] = [];
  let pageStart = 0;
  do {
    const remaining = limit > 0 ? Math.max(0, limit - rawRows.length) : pageSize;
    if (limit > 0 && remaining === 0) break;
    const take = limit > 0 ? Math.min(pageSize, remaining) : pageSize;
    let query = client.from(table)
      .select('*')
      .eq('shop_id', cloudSession.shopId)
      .order('updated_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true, nullsFirst: false });
    if (cursor?.updatedAt) query = query.gte('updated_at', cursor.updatedAt);
    const response = await query.range(pageStart, pageStart + take - 1);
    if (response.error) throw new Error(`Cloud ${key} incremental read failed: ${response.error.message}`);
    const page = Array.isArray(response.data) ? response.data : [];
    rawRows.push(...page);
    if (page.length < take) break;
    pageStart += take;
  } while (limit <= 0 || rawRows.length < limit);

  const extra = key === 'technicians' ? await getDesktopTechnicianCredentials() : undefined;
  let rows = rawRows.map((row: any) => ({
    ...fromCloudRow(key, row, extra),
    cloudUpdatedAt: cloudDate(row.updated_at),
    cloudCursorId: String(row.id || ''),
  }));
  if (key === 'technicians') rows = rows.filter(isAssignableDesktopTechnicianRow);
  return rows;
}

async function synchronizeDesktopCollection(key: string, options: { bootstrapLimit?: number } = {}) {
  if (!shouldUseCloudDb(key)) throw new Error(`Cloud collection is unavailable: ${key}`);
  const db: any = readDb();
  const existing = Array.isArray(db[key]) ? db[key] : [];
  const pendingIds = new Set(
    readCloudSyncQueue()
      .filter((operation) => operation.key === key)
      .map((operation) => String(operation.legacyId)),
  );
  const previous = cloudSyncState.collections[key];
  const cursor = previous?.cursor || null;
  try {
    const result = await synchronizeIncrementalCollection({
      collection: key,
      existing,
      cursor,
      pendingIds,
      terminal: key === 'workOrders' ? terminalWorkOrderState : undefined,
      fetchChanged: (nextCursor) => cloudDbGetChanged(key, nextCursor, nextCursor ? 0 : Number(options.bootstrapLimit || 0)),
      persist: async (rows) => {
        const nextDb = { ...readDb(), [key]: rows };
        writeDb(nextDb);
      },
    });
    const collectionStatus: CloudCollectionSyncStatus = {
      cursor: result.cursor,
      syncedAt: result.syncedAt,
      rowsReceived: result.rowsReceived,
      approximateBytes: result.approximateBytes,
    };
    writeCloudSyncState({
      ...cloudSyncState,
      shopId: cloudSession?.shopId || cloudSyncState.shopId,
      lastSuccessAt: result.syncedAt,
      lastError: '',
      collections: { ...cloudSyncState.collections, [key]: collectionStatus },
    });
    if (result.changedRows.length === 1) scheduleCollectionChanged(key, result.changedRows[0]);
    else if (result.changedRows.length > 1) scheduleCollectionChanged(key, { changedRows: result.changedRows });
    return { ok: true, key, ...collectionStatus, changedRows: result.changedRows, pendingSync: readCloudSyncQueue().length };
  } catch (error: any) {
    const message = error?.message || String(error);
    writeCloudSyncState({ ...cloudSyncState, lastError: message });
    throw error;
  }
}

ipcMain.handle('cloud:syncCollection', async (_event: any, key: string, options?: { bootstrapLimit?: number }) => {
  try {
    return await synchronizeDesktopCollection(String(key || ''), options || {});
  } catch (error: any) {
    return { ok: false, key, error: error?.message || String(error), pendingSync: readCloudSyncQueue().length };
  }
});

ipcMain.handle('cloud:getSyncStatus', async () => ({
  ok: !!cloudSession?.shopId,
  ...cloudSyncState,
  pendingSync: readCloudSyncQueue().length,
}));

function terminalWorkOrderState(record: any): boolean {
  const status = String(record?.status || '').trim().toLowerCase();
  return /^(closed|cancelled|canceled|void|refunded|deleted|archived)$/.test(status)
    || !!record?.checkoutDate || !!record?.pickedUpAt || !!record?.clientPickupDate;
}

function mergeCloudRowsIntoLocalCache(key: string, rows: any[]): any[] {
  try {
    if (!Array.isArray(rows)) return [];
    const db: any = readDb();
    if (key === 'technicians') {
      writeDb({ ...db, technicians: rows.slice() });
      return rows.slice();
    }
    const existing = Array.isArray(db[key]) ? db[key] : [];
    const pending = readCloudSyncQueue().filter((op) => op.key === key);
    const pendingDeletes = new Set(pending.filter((op) => op.op === 'delete').map((op) => String(op.legacyId)));
    const pendingUpserts = new Set(pending.filter((op) => op.op === 'upsert').map((op) => String(op.legacyId)));
    // Repair definitions are a shared catalog. Once a cloud read succeeds, rows
    // absent from that response are stale local orphans (commonly old per-variant
    // copies left behind after consolidating a repair onto a parent part). Keep
    // only genuine offline edits that are still queued for upload.
    const cloudAuthoritative = key === 'repairCategories';
    const byId = new Map<string, any>();
    for (const item of existing) {
      const id = item?.id;
      if (id === null || typeof id === 'undefined') continue;
      if (!cloudAuthoritative || pendingUpserts.has(String(id))) byId.set(String(id), item);
    }
    for (const row of rows) {
      const id = row?.id;
      if (id === null || typeof id === 'undefined') continue;
      const idKey = String(id);
      if (pendingDeletes.has(idKey)) continue;
      const previous = byId.get(idKey);
      if (key === 'workOrders' && terminalWorkOrderState(previous) && !terminalWorkOrderState(row)) continue;
      const previousTime = Date.parse(String(previous?.updatedAt || '')) || 0;
      const rowTime = Date.parse(String(row?.updatedAt || '')) || 0;
      if (!previous || (!pendingUpserts.has(idKey) && rowTime >= previousTime)) byId.set(idKey, row);
      else if (key === 'workOrders') byId.set(idKey, preserveNewerWorkflow(previous, row));
    }
    const nextList = Array.from(byId.values());
    const nextDb: any = { ...db, [key]: nextList };
    if (key === 'workOrders' || key === 'sales') {
      let maxId = Number(nextDb.invoiceSeq || 0);
      for (const w of Array.isArray(nextDb.workOrders) ? nextDb.workOrders : []) maxId = Math.max(maxId, Number(w?.id || 0));
      for (const s of Array.isArray(nextDb.sales) ? nextDb.sales : []) maxId = Math.max(maxId, Number(s?.id || 0));
      if (Number.isFinite(maxId)) nextDb.invoiceSeq = maxId;
    }
    writeDb(nextDb);
    return nextList;
  } catch {
    // Local cloud-read cache is best effort.
    return Array.isArray(rows) ? rows : [];
  }
}

async function getCloudCount(key: string): Promise<number | null> {
  const client = getCloudClient();
  const table = CLOUD_TABLE_BY_KEY[String(key || '')];
  if (!client || !cloudSession || !table) return null;
  const res = await client.from(table).select('id', { count: 'exact', head: true }).eq('shop_id', cloudSession.shopId);
  if (res.error) throw new Error(`Cloud ${key} count failed: ${res.error.message}`);
  return typeof res.count === 'number' ? res.count : null;
}

async function cloudDbUpsert(key: string, item: any) {
  const client = getCloudClient();
  const table = CLOUD_TABLE_BY_KEY[String(key || '')];
  if (!client || !cloudSession || !table) throw new Error('Cloud session is not ready.');
  if (key === 'workOrders') {
    const latest = await client.from(table).select('*').eq('shop_id', cloudSession.shopId).eq('legacy_id', item.id).maybeSingle();
    if (latest.error) throw new Error(`Cloud workflow reconciliation failed: ${latest.error.message}`);
    if (latest.data) item = preserveNewerWorkflow(item, fromCloudRow(key, latest.data));
  }
  const row = toCloudRow(key, item);
  if (!row) throw new Error(`Cloud ${key} write skipped: unsupported row.`);
  const res = await client.from(table).upsert(row, {
    onConflict: cloudConflictForKey(key),
    ignoreDuplicates: false,
  });
  if (res.error) throw new Error(`Cloud ${key} write failed: ${res.error.message}`);
  if (key === 'technicians') await syncDesktopTechnicianCredential(item);
  return { ok: true };
}

async function syncDesktopTechnicianCredential(item: any) {
  if (!cloudSession || typeof item?.passcode === 'undefined') return;
  const client = getCloudClient();
  const legacyId = toCloudTextId(item.id);
  if (!client || !legacyId) return;
  const profile = await client.from('staff_profiles').select('id')
    .eq('shop_id', cloudSession.shopId).eq('legacy_id', legacyId).maybeSingle();
  if (profile.error) throw new Error(`Cloud technician profile lookup failed: ${profile.error.message}`);
  const result = await client.from('technician_private_credentials').upsert({
    shop_id: cloudSession.shopId,
    staff_profile_id: profile.data?.id || null,
    legacy_technician_id: legacyId,
    legacy_passcode: String(item.passcode || '').slice(0, 4),
  }, { onConflict: 'shop_id,legacy_technician_id' });
  if (result.error) throw new Error(`Cloud technician passcode write failed: ${result.error.message}`);
}

async function cloudDbDelete(key: string, legacyId: any) {
  const client = getCloudClient();
  const table = CLOUD_TABLE_BY_KEY[String(key || '')];
  if (!client || !cloudSession || !table) throw new Error('Cloud session is not ready.');
  const id = key === 'repairCategories' || key === 'calendarNotes' || key === 'feedbackEntries' || key === 'technicians' ? toCloudTextId(legacyId) : toCloudIntId(legacyId);
  if (id === null) throw new Error(`Cloud ${key} delete skipped: missing legacy id.`);
  let q = client.from(table).delete().eq('shop_id', cloudSession.shopId);
  if (key === 'preferences') q = q.eq('key', String(legacyId));
  else q = q.eq('legacy_id', id);
  const res = key === 'repairCategories' ? await q.select('legacy_id') : await q;
  if (res.error) throw new Error(`Cloud ${key} delete failed: ${res.error.message}`);
  if (key === 'repairCategories' && (!Array.isArray(res.data) || res.data.length === 0)) {
    throw new Error(`Cloud ${key} delete failed: no matching saved record was removed.`);
  }
  return { ok: true };
}

function legacyIdForCloudItem(key: string, item: any): number | string | null {
  if (!item || typeof item !== 'object') return null;
  if (key === 'preferences') return toCloudString(item.key || item.name || item.id).trim() || null;
  if (key === 'repairCategories' || key === 'calendarNotes' || key === 'feedbackEntries' || key === 'technicians') return toCloudTextId(item.id);
  return toCloudIntId(item.id);
}

function queueCloudSyncOperation(op: CloudSyncOperation) {
  try {
    const queue = readCloudSyncQueue();
    const opKey = `${op.key}:${String(op.legacyId ?? '')}`;
    const filtered = queue.filter((q) => `${q.key}:${String(q.legacyId ?? '')}` !== opKey);
    filtered.push({ ...op, attempts: op.attempts || 0 });
    writeCloudSyncQueue(filtered);
  } catch {
    // ignore
  }
}

let cloudSyncTimer: NodeJS.Timeout | null = null;
let cloudSyncRunning = false;

async function drainCloudSyncQueue() {
  if (!cloudSession || !getCloudClient()) return { ok: false, pending: readCloudSyncQueue().length };
  if (cloudSyncRunning) return { ok: true, pending: readCloudSyncQueue().length };
  cloudSyncRunning = true;
  try {
    const queue = readCloudSyncQueue();
    if (queue.length === 0) return { ok: true, pending: 0 };
    const remaining: CloudSyncOperation[] = [];
    for (const op of queue) {
      try {
        if (op.op === 'delete') await cloudDbDelete(op.key, op.legacyId);
        else await cloudDbUpsert(op.key, op.item);
      } catch (e: any) {
        remaining.push({
          ...op,
          attempts: (op.attempts || 0) + 1,
          lastError: e?.message || String(e),
        });
      }
    }
    writeCloudSyncQueue(remaining);
    return { ok: remaining.length === 0, pending: remaining.length };
  } finally {
    cloudSyncRunning = false;
  }
}

function scheduleCloudSyncQueueDrain(delayMs = 1500) {
  try {
    if (cloudSyncTimer) return;
    cloudSyncTimer = setTimeout(() => {
      cloudSyncTimer = null;
      void drainCloudSyncQueue().catch(() => {});
    }, delayMs);
  } catch {
    // ignore
  }
}

function queueCloudWriteForBackgroundSync(op: 'upsert' | 'delete', key: string, itemOrId: any) {
  if (!CLOUD_TABLE_BY_KEY[String(key || '')]) return;
  const legacyId = op === 'delete' ? itemOrId : legacyIdForCloudItem(key, itemOrId);
  if (legacyId === null || typeof legacyId === 'undefined') return;
  queueCloudSyncOperation({
    id: cloudSyncOperationId(), op, key,
    item: op === 'upsert' ? itemOrId : undefined,
    legacyId, createdAt: new Date().toISOString(), attempts: 0,
  });
  scheduleCloudSyncQueueDrain(100);
}

ipcMain.handle('db-reset-all', async () => {
  const removed: string[] = [];
  const errors: string[] = [];

  // Ensure any pending writes finish before we remove files.
  try {
    await drainDbWrites();
  } catch {
    // ignore
  }
  writeQueue = Promise.resolve();
  dbCache = null;

  function tryUnlink(p: string) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    } catch (e: any) {
      errors.push(`${p}: ${String(e?.message || e)}`);
    }
  }

  function tryRmDir(p: string) {
    try {
      if (fs.existsSync(p)) {
        // Node 14+ supports rmSync
        if (typeof (fs as any).rmSync === 'function') {
          (fs as any).rmSync(p, { recursive: true, force: true });
        } else {
          (fs as any).rmdirSync(p, { recursive: true });
        }
        removed.push(p);
      }
    } catch (e: any) {
      errors.push(`${p}: ${String(e?.message || e)}`);
    }
  }

  const dataRoot = resolveDataRoot();
  const backupsDir = path.join(dataRoot, 'backups');
  const backupConfigPath = path.join(dataRoot, 'backup-config.json');
  const updateConfigPath = path.join(dataRoot, 'update-config.json');
  const emailConfig = path.join(dataRoot, 'email-config.json');

  // Primary database
  tryUnlink(dbFilePath());
  tryUnlink(dbFilePath() + '.tmp');

  // Local configs/backups
  tryUnlink(backupConfigPath);
  tryUnlink(updateConfigPath);
  tryUnlink(emailConfig);
  tryRmDir(backupsDir);

  // Notify renderers to refresh in case any window is open.
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      try { w.webContents.send('customers:changed'); } catch {}
      try { w.webContents.send('workorders:changed'); } catch {}
      try { w.webContents.send('sales:changed'); } catch {}
      try { w.webContents.send('quotes:changed'); } catch {}
      try { w.webContents.send('technicians:changed'); } catch {}
      try { w.webContents.send('deviceCategories:changed'); } catch {}
      try { w.webContents.send('productCategories:changed'); } catch {}
      try { w.webContents.send('products:changed'); } catch {}
      try { w.webContents.send('partSources:changed'); } catch {}
      try { w.webContents.send('calendarEvents:changed'); } catch {}
      try { w.webContents.send('calendarNotes:changed'); } catch {}
      try { w.webContents.send('timeEntries:changed'); } catch {}
    }
  } catch {
    // ignore
  }

  return { ok: errors.length === 0, removed, errors, dataRoot };
});

ipcMain.handle('db-get', async (_e: any, key: string, opts?: { limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }) => {
  const db = readDb();
  const raw = db[key] || [];
  const list = Array.isArray(raw) ? raw : [];
  if (!opts) return list;

  const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 0;
  const sortBy = (opts.sortBy || '').toString().trim();
  const sortDir = (opts.sortDir || 'desc') === 'asc' ? 'asc' : 'desc';

  let out = list.slice();

  // If limiting without an explicit sortBy, apply a sensible default for time-ordered collections.
  const effectiveSortBy = sortBy || ((key === 'workOrders' || key === 'sales') ? 'activityAt' : 'id');
  if (effectiveSortBy) {
    out.sort((a: any, b: any) => {
      const av = effectiveSortBy === 'activityAt'
        ? (key === 'workOrders' ? getWorkOrderActivityAt(a) : getSaleActivityAt(a))
        : a?.[effectiveSortBy];
      const bv = effectiveSortBy === 'activityAt'
        ? (key === 'workOrders' ? getWorkOrderActivityAt(b) : getSaleActivityAt(b))
        : b?.[effectiveSortBy];

      const ai = Number(a?.id ?? 0);
      const bi = Number(b?.id ?? 0);

      // Numeric compare when both look numeric.
      const an = Number(av);
      const bn = Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) {
        const primary = sortDir === 'asc' ? an - bn : bn - an;
        if (primary !== 0) return primary;
        // Tie-breaker
        if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return sortDir === 'asc' ? ai - bi : bi - ai;
        return 0;
      }

      // Date-ish/string compare fallback.
      const as = (av ?? '').toString();
      const bs = (bv ?? '').toString();
      const cmp = bs.localeCompare(as);
      const primary = sortDir === 'asc' ? -cmp : cmp;
      if (primary !== 0) return primary;
      if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return sortDir === 'asc' ? ai - bi : bi - ai;
      return 0;
    });
  }

  if (limit > 0) out = out.slice(0, limit);
  return out;
});

ipcMain.handle('db-add', async (_e: any, key: string, item: any) => {
  const prevDb: any = readDb();
  const prevRaw = prevDb[key];
  const prevList: any[] = Array.isArray(prevRaw) ? prevRaw : [];

  const nowIso = new Date().toISOString();
  const baseItem = (item && typeof item === 'object') ? { ...item } : {};
  const nextItem: any = { ...baseItem };
  if (!nextItem.createdAt) nextItem.createdAt = nowIso;
  if (!nextItem.updatedAt) nextItem.updatedAt = nowIso;
  if (key === 'workOrders' && !nextItem.activityAt) nextItem.activityAt = getWorkOrderActivityAt(nextItem) || nowIso;
  if (key === 'workOrders' && !terminalWorkOrderState(nextItem) && !nextItem.workflowStage && !nextItem.repairStatus && !nextItem.statusUpdate) {
    nextItem.workflowStage = 'Checked in';
    nextItem.workflowUpdatedAt = nowIso;
  }

  const nextDb: any = { ...prevDb };

  // Assign global invoice id sequence (strictly increasing by entry time) for workOrders and sales
  if (key === 'workOrders' || key === 'sales') {
    let invoiceSeq = (nextDb as any).invoiceSeq;
    // Initialize invoiceSeq if missing by scanning both collections
    if (typeof invoiceSeq !== 'number' || !Number.isFinite(invoiceSeq)) {
      const wo = Array.isArray(prevDb['workOrders']) ? prevDb['workOrders'] : [];
      const sa = Array.isArray(prevDb['sales']) ? prevDb['sales'] : [];
      let max = 0;
      for (const it of wo) max = Math.max(max, (it as any)?.id || 0);
      for (const it of sa) max = Math.max(max, (it as any)?.id || 0);
      invoiceSeq = max;
    }
    // Always override incoming id to prevent duplicates
    invoiceSeq = (invoiceSeq || 0) + 1;
    (nextDb as any).invoiceSeq = invoiceSeq;
    nextItem.id = invoiceSeq;
  } else {
    // For other collections, assign incremental id per-collection if missing
    if (!nextItem.id) {
      if (key === 'calendarEvents') {
        // Calendar events are created on multiple devices. A timestamp plus a
        // random suffix avoids two offline devices reusing the same legacy id.
        nextItem.id = (Date.now() * 1000) + nodeCrypto.randomInt(0, 1000);
      } else {
        let max = 0;
        for (const it of prevList) max = Math.max(max, (it as any)?.id || 0);
        nextItem.id = max + 1;
      }
      dbLog('[DB-ADD] Assigned new ID:', nextItem.id, 'for', key);
    }
  }

  nextDb[key] = [...prevList, nextItem];
  dbLog('[DB-ADD] Added', key, 'id=', nextItem?.id);
  const ok = writeDb(nextDb);
  if (ok) {
    queueCloudWriteForBackgroundSync('upsert', key, nextItem);
    scheduleCollectionChanged(key, nextItem);
    return nextItem;
  }
  return null;
});

ipcMain.handle('db-find', async (_e: any, key: string, q: any) => {
  const db = readDb();
  const list = db[key] || [];
  return list.filter((it: any) => matchesDbQuery(it, q));
});

function matchesDbQuery(it: any, q: any): boolean {
  // Filter semantics:
  // - For id-like fields (id, *Id, *_id): exact match (numeric when possible)
  // - For other string fields: case-insensitive substring match
  const query = q || {};
  for (const k of Object.keys(query)) {
    const rawQ = query[k];
    if (rawQ === null || typeof rawQ === 'undefined') continue;

    const isIdLike = /^id$/i.test(k) || /Id$/i.test(k) || /_id$/i.test(k);

    // Booleans: strict boolean match
    if (typeof rawQ === 'boolean') {
      if (Boolean(it?.[k]) !== rawQ) return false;
      continue;
    }

    // Numbers: strict numeric match
    if (typeof rawQ === 'number') {
      if (!Number.isFinite(rawQ)) continue;
      const itemNum = Number(it?.[k]);
      if (!Number.isFinite(itemNum) || itemNum !== rawQ) return false;
      continue;
    }

    // Strings
    const qStr = rawQ.toString();
    if (!qStr.trim()) continue;

    if (isIdLike) {
      const qNum = Number(qStr);
      const itemNum = Number(it?.[k]);
      if (Number.isFinite(qNum) && Number.isFinite(itemNum)) {
        if (itemNum !== qNum) return false;
        continue;
      }
      // Fallback to exact string match for id-like fields
      if (String(it?.[k] ?? '') !== qStr) return false;
      continue;
    }

    // Default: substring match (case-insensitive)
    const needle = qStr.toLowerCase();
    const hay = String(it?.[k] ?? '').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

type TicketSearchResult = {
  type: 'workorder' | 'sale';
  id: number;
  invoice: string;
  activityAt: string;
  customerName?: string;
  description?: string;
};

ipcMain.handle('tickets:search', async (_e: any, query: any, opts?: { limit?: number }) => {
  try {
    const qRaw = String(query || '').trim();
    const limitRaw = Number(opts?.limit ?? 30);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 30;
    if (!qRaw) return { ok: true, results: [] as TicketSearchResult[] };

    // Normalize query into simple lowercase terms.
    const qLower = qRaw.toLowerCase();
    const cleaned = qLower.replace(/[^a-z0-9]+/g, ' ').trim();
    const terms = cleaned.split(/\s+/).filter(Boolean);
    const digits = cleaned.replace(/\D/g, '');

    // Avoid scanning the whole DB for 1-letter non-numeric queries.
    if (terms.length === 0) return { ok: true, results: [] as TicketSearchResult[] };
    if (cleaned.length < 2 && !digits) return { ok: true, results: [] as TicketSearchResult[] };

    const db: any = readDb();
    const workOrders: any[] = Array.isArray(db.workOrders) ? db.workOrders : [];
    const sales: any[] = Array.isArray(db.sales) ? db.sales : [];
    const customers: any[] = Array.isArray(db.customers) ? db.customers : [];

    const customerNameById = new Map<number, string>();
    for (const c of customers) {
      const idNum = Number((c as any)?.id);
      if (!Number.isFinite(idNum) || idNum <= 0) continue;
      const first = String((c as any)?.firstName || '').trim();
      const last = String((c as any)?.lastName || '').trim();
      const full = [first, last].filter(Boolean).join(' ').trim();
      const fallback = String((c as any)?.name || '').trim() || String((c as any)?.email || '').trim();
      const name = full || fallback;
      if (name) customerNameById.set(idNum, name);
    }

    const norm = (v: any): string => {
      if (v === null || typeof v === 'undefined') return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      try { return JSON.stringify(v); } catch { return String(v); }
    };

    const invoiceForId = (id: number): string => `GB${String(id).padStart(7, '0')}`;

    const buildHay = (rec: any, type: 'workorder' | 'sale') => {
      const idNum = Number(rec?.id ?? 0);
      const invoice = invoiceForId(idNum);
      const activityAt = String(type === 'workorder' ? (getWorkOrderActivityAt(rec) || '') : (getSaleActivityAt(rec) || ''));

      const cid = Number(rec?.customerId ?? 0);
      const nameFromCustomer = (Number.isFinite(cid) && cid > 0) ? (customerNameById.get(cid) || '') : '';
      const nameFromRecord = String(rec?.customerName || rec?.clientName || '').trim()
        || [rec?.firstName, rec?.lastName].filter(Boolean).map((x: any) => String(x || '').trim()).filter(Boolean).join(' ').trim();
      const customerName = nameFromCustomer || nameFromRecord;

      const parts: string[] = [];
      if (Number.isFinite(idNum) && idNum > 0) {
        parts.push(String(idNum));
        parts.push(invoice);
        parts.push(`gb${idNum}`);
        parts.push(`gb${String(idNum).padStart(7, '0')}`);
        parts.push(`#${idNum}`);
      }
      if (customerName) parts.push(customerName);

      // Device/description-ish fields
      const descCandidates = [
        rec?.productCategory,
        rec?.productDescription,
        rec?.deviceType,
        rec?.device,
        rec?.summary,
        rec?.description,
        rec?.issue,
        rec?.problem,
        rec?.diagnosis,
        rec?.notes,
        rec?.techNotes,
        rec?.category,
      ];
      for (const v of descCandidates) {
        const s = String(v || '').trim();
        if (s) parts.push(s);
      }

      // Items/lines (repairs, sales items, etc.)
      const items = Array.isArray(rec?.items) ? rec.items : [];
      for (const it of items) {
        const s = [it?.description, it?.name, it?.title, it?.repair, it?.category, it?.sku].map(norm).join(' ').trim();
        if (s) parts.push(s);
      }

      const repairs = Array.isArray(rec?.repairs) ? rec.repairs : [];
      for (const r of repairs) {
        const s = [r?.name, r?.description, r?.category].map(norm).join(' ').trim();
        if (s) parts.push(s);
      }

      const contact = [rec?.customerPhone, rec?.phone, rec?.phoneAlt, rec?.customerEmail, rec?.email].map(norm).join(' ').trim();
      if (contact) parts.push(contact);

      const hay = parts.join(' ').toLowerCase();

      const description = (() => {
        const first = String(rec?.productDescription || rec?.summary || rec?.description || rec?.productCategory || '').trim();
        if (first) return first;
        if (items.length > 0) {
          const d = String(items[0]?.description || items[0]?.name || '').trim();
          if (d) return d;
        }
        return '';
      })();

      return { hay, customerName, invoice, activityAt, description };
    };

    const matches = (hay: string): boolean => terms.every((t) => hay.includes(t));

    const out: TicketSearchResult[] = [];

    for (const w of workOrders) {
      const idNum = Number((w as any)?.id ?? 0);
      if (!Number.isFinite(idNum) || idNum <= 0) continue;
      const built = buildHay(w, 'workorder');
      if (!matches(built.hay)) continue;
      out.push({
        type: 'workorder',
        id: idNum,
        invoice: built.invoice,
        activityAt: built.activityAt,
        customerName: built.customerName || undefined,
        description: built.description || undefined,
      });
    }

    for (const s of sales) {
      const idNum = Number((s as any)?.id ?? 0);
      if (!Number.isFinite(idNum) || idNum <= 0) continue;
      const built = buildHay(s, 'sale');
      if (!matches(built.hay)) continue;
      out.push({
        type: 'sale',
        id: idNum,
        invoice: built.invoice,
        activityAt: built.activityAt,
        customerName: built.customerName || undefined,
        description: built.description || undefined,
      });
    }

    const toTs = (iso: string): number => {
      const t = new Date(iso || 0).getTime();
      return Number.isNaN(t) ? 0 : t;
    };

    out.sort((a, b) => (toTs(b.activityAt) - toTs(a.activityAt)) || (b.id - a.id));
    return { ok: true, results: out.slice(0, limit) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), results: [] as TicketSearchResult[] };
  }
});

ipcMain.handle('db-count', async (_e: any, key: string, q: any) => {
  const db = readDb();
  const list = db[key] || [];
  if (!Array.isArray(list) || list.length === 0) return 0;
  let count = 0;
  for (const it of list) {
    if (matchesDbQuery(it, q)) count++;
  }
  return count;
});

ipcMain.handle('db-update', async (_e: any, key: string, a: any, b?: any) => {
  // Support both forms: (key, item) and (key, id, item)
  const incomingItem = (typeof b !== 'undefined') ? b : a;
  const prevDb: any = readDb();
  const raw = prevDb[key];
  const list: any[] = Array.isArray(raw) ? raw : [];
  const targetId = (typeof b !== 'undefined') ? a : (incomingItem?.id);
  
  const idx = list.findIndex((it: any) => {
    // First try exact string/value comparison
    if (it.id === targetId) return true;
    // Then try numeric comparison for numeric IDs
    if (typeof it.id === 'number' && typeof targetId === 'number') {
      return it.id === targetId;
    }
    // Try numeric comparison if both can be converted to numbers
    const itemIdNum = Number(it.id);
    const targetIdNum = Number(targetId);
    if (!isNaN(itemIdNum) && !isNaN(targetIdNum)) {
      return itemIdNum === targetIdNum;
    }
    return false;
  });
  if (idx === -1) return null;
  const updatedAt = new Date().toISOString();
  const previousItem = list[idx];
  const safeIncoming = (incomingItem && typeof incomingItem === 'object') ? incomingItem : {};
  const updatedItem = { ...previousItem, ...safeIncoming, id: targetId, updatedAt };
  if (key === 'workOrders') {
    updatedItem.activityAt = computeWorkOrderActivityAt(previousItem, updatedItem, updatedAt);
  }
  const nextList = list.slice();
  nextList[idx] = updatedItem;
  const nextDb: any = { ...prevDb, [key]: nextList };
  const ok = writeDb(nextDb);
  dbLog('[DB-UPDATE] Updated', key, 'id=', targetId, 'ok=', ok);
  if (ok) {
    queueCloudWriteForBackgroundSync('upsert', key, updatedItem);
    scheduleCollectionChanged(key, updatedItem);
    try { maybeAutoTextOnStatusChange(key, previousItem, updatedItem, nextDb); } catch {}
    return updatedItem;
  }
  return null;
});


ipcMain.handle('db-delete', async (_e: any, key: string, id: any) => {
  const prevDb: any = readDb();
  const raw = prevDb[key];
  const list: any[] = Array.isArray(raw) ? raw : [];
  // Try exact match first (handles string IDs)
  let idx = list.findIndex((it: any) => it.id === id);
  if (idx === -1) {
    // Fallback to numeric comparison when both sides are numeric-like
    const target = Number(id);
    if (!Number.isNaN(target)) {
      idx = list.findIndex((it: any) => {
        const n = Number(it.id);
        return !Number.isNaN(n) && n === target;
      });
    }
  }
  // Repair catalog rows are cloud-authoritative and may have been loaded from
  // Supabase without being present in the desktop JSON cache. Delete them from
  // Supabase first, then clean up any cached copy. This also surfaces RLS/ID
  // errors instead of silently queueing a delete that appears to succeed.
  if (key === 'repairCategories' && shouldUseCloudDb(key)) {
    try {
      await cloudDbDelete(key, id);
    } catch (error: any) {
      const missingCloudRow = /no matching saved record was removed/i.test(String(error?.message || ''));
      if (!(missingCloudRow && idx !== -1)) throw error;
    }
    if (idx !== -1) {
      const nextDb: any = { ...prevDb, [key]: list.filter((_, i) => i !== idx) };
      if (!writeDb(nextDb)) return false;
    }
    scheduleCollectionChanged(key);
    return true;
  }
  if (idx === -1) return false;
  const nextList = list.filter((_, i) => i !== idx);
  const nextDb: any = { ...prevDb, [key]: nextList };
  const ok = writeDb(nextDb);
  dbLog('[DB-DELETE] Deleted', key, 'id=', id, 'ok=', ok);
  if (ok) {
    queueCloudWriteForBackgroundSync('delete', key, id);
    scheduleCollectionChanged(key);
  }
  return ok;
});

// Open Products window
ipcMain.handle('open-products', async (event: any) => {
  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const child = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    resizable: true,
    parent: parentFromSender || BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Products'),
  });
  showWindowFast(child, () => { centerWindow(child); }, { focus: false });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?products=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?products=true`;
  child.loadURL(url);
  return { ok: true };
});

ipcMain.handle('open-inventory', async (event: any) => {
  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const child = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 650,
    resizable: true,
    parent: parentFromSender || BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Inventory'),
  });
  showWindowFast(child, () => { centerWindow(child); }, { focus: false });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?inventory=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?inventory=true`;
  child.loadURL(url);
  return { ok: true };
});

function openAdminCollectionWindow(event: any, query: string, title: string, size: { width: number; height: number; minWidth: number; minHeight: number }) {
  const parentFromSender = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })();
  const child = new BrowserWindow({
    ...size, resizable: true, parent: parentFromSender || BrowserWindow.getAllWindows()[0] || undefined, modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}), backgroundColor: '#18181b', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, '..', 'electron', 'preload.js') },
    show: false, title: windowTitle(title),
  });
  showWindowFast(child, () => { centerWindow(child); }, { focus: false });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const queryString = query.includes('=') ? query : `${query}=true`;
  const url = isDev ? `${DEV_SERVER_URL}/?${queryString}` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?${queryString}`;
  void child.loadURL(url);
  return { ok: true };
}

ipcMain.handle('open-vendors', async (event: any) => openAdminCollectionWindow(event, 'vendors', 'Distributors / Vendors', { width: 1040, height: 760, minWidth: 820, minHeight: 620 }));
ipcMain.handle('open-technicians', async (event: any) => openAdminCollectionWindow(event, 'technicians', 'Technicians', { width: 1100, height: 800, minWidth: 880, minHeight: 650 }));
ipcMain.handle('open-catalog-settings', async (event: any, tab?: 'inventory' | 'repairs') => openAdminCollectionWindow(event, `catalogSettings=true&settingsTab=${tab === 'repairs' ? 'repairs' : 'inventory'}`, 'Catalog Settings', { width: 1060, height: 780, minWidth: 820, minHeight: 620 }));

// --- Dev Menu handlers ---
ipcMain.handle('open-dev-menu', async () => {
  const child = new BrowserWindow({
    width: 900,
    height: 700,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Dev Menu'),
  });
  showWindowFast(child, () => { centerWindow(child); }, { focus: false });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?devMenu=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?devMenu=true`;
  child.loadURL(url);
  return { ok: true };
});

ipcMain.handle('dev:openUserDataFolder', async () => {
  const folder = resolveDataRoot();
  try {
    await shell.openPath(folder);
    return { ok: true, folder };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), folder };
  }
});

ipcMain.handle('dev:backupDb', async () => {
  try {
    const dataRoot = resolveDataRoot();
    const backupsDir = path.join(dataRoot, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const ts = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const backupPath = path.join(backupsDir, `gbpos-db-backup-${stamp}.json`);
    const p = dbFilePath();
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, backupPath);
      return { ok: true, backupPath };
    } else {
      // create empty db backup to mark point-in-time
      fs.writeFileSync(backupPath, JSON.stringify(readDb(), null, 2), 'utf-8');
      return { ok: true, backupPath, note: 'source db did not exist, wrote snapshot of current in-memory view' };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Export full database to a user-selected file
ipcMain.handle('backup:export', async () => {
  try {
    const ts = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    // MMDDYY HHMMSS (12-hour)
    const mm = pad(ts.getMonth() + 1);
    const dd = pad(ts.getDate());
    const yy = String(ts.getFullYear()).slice(-2);
    const h24 = ts.getHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const hh = pad(h12);
    const mi = pad(ts.getMinutes());
    const ss = pad(ts.getSeconds());
    const stamp = `${mm}${dd}${yy} ${hh}${mi}${ss}`;
    const defaultPath = path.join(app.getPath('documents') || app.getPath('downloads') || app.getPath('userData'), `gbpos-export-${stamp}.json`);
    const result = await dialog.showSaveDialog({
      title: 'Export Backup',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const db = readDb();
    fs.writeFileSync(result.filePath, JSON.stringify(db, null, 2), 'utf-8');
    return { ok: true, filePath: result.filePath };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Import full database from a user-selected file (replaces current DB after auto-backup)
ipcMain.handle('backup:import', async () => {
  try {
    const open = await dialog.showOpenDialog({
      title: 'Import Backup',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (open.canceled || !open.filePaths.length) return { ok: false, canceled: true };
    const filePath = open.filePaths[0];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { ok: false, error: 'Invalid backup file format' };

    // Support both plain-DB exports and BackupData { collections: {...} } shape
    const collectionsShape = (data as any)?.collections;
    const dbPayload: any = (collectionsShape && typeof collectionsShape === 'object') ? { ...collectionsShape } : { ...data };

    // Strip any BackupData envelope keys that are not DB collections
    for (const k of ['version', 'timestamp', 'source', 'dataComplete', 'scanTimestamp', 'metadata']) {
      if (typeof dbPayload[k] === 'string' || (k === 'metadata' && dbPayload[k] && typeof dbPayload[k] === 'object' && !Array.isArray(dbPayload[k]))) {
        delete dbPayload[k];
      }
    }

    // Ensure core collections are at least empty arrays
    if (!Array.isArray(dbPayload.customers)) dbPayload.customers = [];
    if (!Array.isArray(dbPayload.workOrders)) dbPayload.workOrders = [];

    // Recompute invoiceSeq from imported records so the first new WO/sale gets the
    // correct next ID, preventing duplicate IDs or starting over from 1.
    const importedWo: any[] = Array.isArray(dbPayload.workOrders) ? dbPayload.workOrders : [];
    const importedSa: any[] = Array.isArray(dbPayload.sales) ? dbPayload.sales : [];
    let maxId = 0;
    for (const it of importedWo) maxId = Math.max(maxId, Number(it?.id || 0));
    for (const it of importedSa) maxId = Math.max(maxId, Number(it?.id || 0));
    if (!dbPayload.invoiceSeq || Number(dbPayload.invoiceSeq) < maxId) {
      dbPayload.invoiceSeq = maxId;
    }

    // Auto-backup current DB before overwriting
    try {
      const dataRoot = resolveDataRoot();
      const backupsDir = path.join(dataRoot, 'backups');
      if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
      const ts = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
      const backupPath = path.join(backupsDir, `gbpos-pre-import-backup-${stamp}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(readDb(), null, 2), 'utf-8');
    } catch (_e) { /* best effort */ }

    // Replace the in-memory cache and persist via the normal write path so
    // dbCache stays consistent. drainDbWrites() flushes immediately.
    writeDb(dbPayload);
    await drainDbWrites();

    // Notify all windows that all collections have changed
    emitAllDataChanged();

    const collectionCounts: Record<string, number> = {};
    for (const k of Object.keys(dbPayload)) {
      if (Array.isArray(dbPayload[k])) collectionCounts[k] = dbPayload[k].length;
    }

    return { ok: true, filePath, collectionCounts };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('backup:runBatchOut', async () => {
  return runBatchOutBackup('batchout');
});

ipcMain.handle('backup:getBatchOutInfo', async () => {
  const cfg = readBackupConfig();
  return { ok: true, lastBackupPath: cfg.lastBackupPath, lastBackupDate: cfg.lastBackupDate, lastBatchOutDate: cfg.lastBatchOutDate };
});

ipcMain.handle('dev:environmentInfo', async () => {
  try {
    return {
      ok: true,
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion ? app.getVersion() : undefined,
      userData: app.getPath('userData'),
      dataRoot: resolveDataRoot(),
      cwd: process.cwd(),
      isDev,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('dev:openAllDevTools', async () => {
  try {
    BrowserWindow.getAllWindows().forEach((w: any) => {
      try { w.webContents.openDevTools({ mode: 'detach' }); } catch (_e) {}
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Open Data Tools window
ipcMain.handle('open-data-tools', async () => {
  const child = new BrowserWindow({
    width: 1000,
    height: 800,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Data Tools'),
  });
  showWindowFast(child, () => { centerWindow(child); }, { focus: false });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?dataTools=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?dataTools=true`;
  child.loadURL(url);
  return { ok: true };
});

// Open Clear Database window
ipcMain.handle('open-clear-database', async (event: any) => {
  const parentWin = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  const child = new BrowserWindow({
    width: 900,
    height: 750,
    resizable: true,
    parent: parentWin as any,
    modal: true,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Clear Database'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?clearDb=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?clearDb=true`;
  child.loadURL(url);
  return { ok: true };
});

// Open Charts window (Reporting charts)
ipcMain.handle('open-charts', async () => {
  const child = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Charts'),
  });
  showWindowFast(child, () => { centerWindow(child); }, { focus: false });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?charts=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?charts=true`;
  child.loadURL(url);
  return { ok: true };
});

// Open JSON file and return parsed content (dry-run import)
ipcMain.handle('backup:pickAndRead', async () => {
  try {
    const open = await dialog.showOpenDialog({
      title: 'Select Backup (Dry-Run)',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (open.canceled || !open.filePaths.length) return { ok: false, canceled: true };
    const filePath = open.filePaths[0];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { ok: true, filePath, data };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Export provided payload to a user-selected file (anonymized export)
ipcMain.handle('backup:exportPayload', async (_e: any, payload: any) => {
  try {
    const ts = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    // MMDDYY HHMMSS (12-hour)
    const mm = pad(ts.getMonth() + 1);
    const dd = pad(ts.getDate());
    const yy = String(ts.getFullYear()).slice(-2);
    const h24 = ts.getHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const hh = pad(h12);
    const mi = pad(ts.getMinutes());
    const ss = pad(ts.getSeconds());
    const stamp = `${mm}${dd}${yy} ${hh}${mi}${ss}`;
    const defaultPath = path.join(app.getPath('documents') || app.getPath('downloads') || app.getPath('userData'), `gbpos-anonymized-${stamp}.json`);
    const result = await dialog.showSaveDialog({
      title: 'Export Anonymized Backup',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(payload || {}, null, 2), 'utf-8');
    return { ok: true, filePath: result.filePath };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Export provided payload with a custom filename label
ipcMain.handle('backup:exportPayloadNamed', async (_e: any, payload: any, label?: string) => {
  try {
    const ts = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const base = label ? label.replace(/[^a-z0-9\-\_\+]+/gi, '-') : 'gbpos-export';
    const defaultPath = path.join(app.getPath('documents') || app.getPath('downloads') || app.getPath('userData'), `${base}-${stamp}.json`);
    const result = await dialog.showSaveDialog({
      title: 'Export Backup',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(payload || {}, null, 2), 'utf-8');
    // Persist last backup path for UI convenience
    try {
      writeBackupConfig({ lastBackupPath: result.filePath, lastBackupDate: new Date().toISOString() });
    } catch {}
    return { ok: true, filePath: result.filePath };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Export provided HTML to a user-selected .html file
ipcMain.handle('export-html', async (_e: any, html: string, filenameBase?: string) => {
  try {
    const ts = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const mm = pad(ts.getMonth() + 1), dd = pad(ts.getDate()), yy = String(ts.getFullYear()).slice(-2);
    const h24 = ts.getHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const hh = pad(h12), mi = pad(ts.getMinutes()), ss = pad(ts.getSeconds());
    const stamp = `${mm}${dd}${yy} ${hh}${mi}${ss}`;
    const base = (filenameBase || 'gadgetboy-quote')
      .toString()
      .replace(/[^a-z0-9\-\_\+]+/gi, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    const defaultPath = path.join(app.getPath('documents') || app.getPath('downloads') || app.getPath('userData'), `${base}-${stamp}.html`);
    const result = await dialog.showSaveDialog({
      title: 'Save Quote (Interactive HTML)',
      defaultPath,
      filters: [{ name: 'HTML', extensions: ['html'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const fs = require('fs');
    fs.writeFileSync(result.filePath, html || '', 'utf-8');
    return { ok: true, filePath: result.filePath };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Export provided HTML as a PDF using an offscreen BrowserWindow and printToPDF
ipcMain.handle('export-pdf', async (_e: any, html: string, filenameBase?: string) => {
  try {
    const ts = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const mm = pad(ts.getMonth() + 1), dd = pad(ts.getDate()), yy = String(ts.getFullYear()).slice(-2);
    const h24 = ts.getHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const hh = pad(h12), mi = pad(ts.getMinutes());
    const stamp = `${mm}${dd}${yy} ${hh}${mi}`;
    const base = (filenameBase || 'gadgetboy-quote')
      .toString()
      .replace(/[^a-z0-9\-\_\+]+/gi, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    const defaultPath = path.join(app.getPath('documents') || app.getPath('downloads') || app.getPath('userData'), `${base}-${stamp}.pdf`);
    const result = await dialog.showSaveDialog({
      title: 'Save Quote (PDF)',
      defaultPath,
      filters: [{ name: 'PDF', extensions: ['pdf'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      },
      ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
      backgroundColor: '#ffffff',
    });

    // Avoid giant data: URLs (can exceed Chromium/Electron limits when HTML contains base64 images)
    // by writing the HTML to a temp file and loading via file://.
    const tempDir = path.join(resolveDataRoot(), 'quote-previews');
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch {}
    const safeBase = String(filenameBase || 'gadgetboy-quote')
      .replace(/[^a-z0-9\-\_\+]+/gi, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'gadgetboy-quote';
    const tempPath = path.join(tempDir, `${safeBase}-${Date.now()}-pdf.html`);
    fs.writeFileSync(tempPath, String(html || ''), 'utf-8');
    await win.loadFile(tempPath);
    // Give layout a moment to settle
    await new Promise((r) => setTimeout(r, 150));

    // Best-effort: wait for images, then shrink-to-fit pages before printing to PDF.
    try {
      await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          try {
            const imgs = Array.from(document.images || []);
            let pending = imgs.filter((img) => !img.complete).length;
            if (!pending) return resolve(true);
            const done = () => { pending--; if (pending <= 0) resolve(true); };
            imgs.forEach((img) => {
              if (img.complete) return;
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', done, { once: true });
            });
            setTimeout(() => resolve(true), 2000);
          } catch (e) { resolve(true); }
        });
      `);
    } catch {}
    try {
      await win.webContents.executeJavaScript(`
        try { window.__gbFitQuotePages && window.__gbFitQuotePages(); } catch (e) {}
        true;
      `);
      await new Promise((r) => setTimeout(r, 80));
    } catch {}

    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
      margins: { marginType: 'none' },
      landscape: false,
    } as any);
    fs.writeFileSync(result.filePath, pdfBuffer);
    try { fs.unlinkSync(tempPath); } catch {}
    try { win.destroy(); } catch {}
    return { ok: true, filePath: result.filePath };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Open a child window to display provided HTML for interactive editing (with preload enabled)
ipcMain.handle('open-interactive-html', async (_e: any, html: string, title?: string) => {
  try {
    // Open a resizable child window sized for comfortable editing
    const child = new BrowserWindow({
      width: 1100,
      height: 800,
      useContentSize: true,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: true,
      parent: BrowserWindow.getAllWindows()[0] || undefined,
      modal: false,
      ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      },
      show: false,
      title: title || 'Interactive Quote',
    });
    if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });

    // Load from a temp file instead of a data: URL to avoid URL-length limits for large HTML.
    const tempDir = path.join(resolveDataRoot(), 'quote-previews');
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch {}
    const safeTitle = String(title || 'Interactive Quote')
      .replace(/[^a-z0-9\-\_\+]+/gi, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'interactive-quote';
    const tempPath = path.join(tempDir, `${safeTitle}-${Date.now()}.html`);
    fs.writeFileSync(tempPath, String(html || ''), 'utf-8');

    // Pre-set a reasonable content size
    try { child.setContentSize(1100, 800); } catch {}
    // Register load listener BEFORE loading to avoid missing the event
    child.webContents.once('did-finish-load', () => {
      try { centerWindow(child); child.show(); child.focus(); } catch {}
    });
    await child.loadFile(tempPath);
    // Fallback: if for some reason the event fired before registration, ensure shown
    try { if (!child.isVisible()) { centerWindow(child); child.show(); child.focus(); } } catch {}
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});
// Release Form print window
ipcMain.handle('open-release-form', async (_event: any, payload: any) => {
  const child = new BrowserWindow({
    width: 850,
    height: 1100,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Release Form'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const encoded = encodeURIComponent(JSON.stringify(payload || {}));
  const url = isDev ? `${DEV_SERVER_URL}/?releaseForm=${encoded}` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?releaseForm=${encoded}`;
  child.loadURL(url);
  return { ok: true };
});

// Customer Receipt print window
ipcMain.handle('open-customer-receipt', async (event: any, payload: any) => {
  const parentWin = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;

  // Backwards compatible payload:
  // - old callers pass the receipt data directly
  // - new callers can pass { data, autoPrint, silent, autoCloseMs, show }
  const data = payload && typeof payload === 'object' && 'data' in payload ? (payload as any).data : payload;
  const autoPrint = !!(payload && typeof payload === 'object' && (payload as any).autoPrint);
  const silent = !!(payload && typeof payload === 'object' && (payload as any).silent);
  const autoCloseMs = Number(payload && typeof payload === 'object' ? (payload as any).autoCloseMs : 0) || 0;
  const showWindow = payload && typeof payload === 'object' && 'show' in payload ? !!(payload as any).show : !silent;

  // If we are silently printing, do not parent to the invoking window.
  // Closing a parent window on Windows can also close its children, which can cancel printing.
  const actualParent = (autoPrint && silent)
    ? (mainWindow || BrowserWindow.getAllWindows()[0] || undefined)
    : parentWin;

  const child = new BrowserWindow({
    width: 850,
    height: 1100,
    resizable: true,
    parent: actualParent as any,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Customer Receipt'),
  });
  if (showWindow) {
    showWindowFast(child, () => {
      centerWindow(child);
    });
  }
  child.on('closed', () => { try { (parentWin as any)?.show?.(); (parentWin as any)?.focus?.(); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const encoded = encodeURIComponent(JSON.stringify(data || {}));
  const flags = `${autoPrint ? '&autoPrint=1' : ''}${silent ? '&silent=1' : ''}${autoCloseMs ? `&autoCloseMs=${encodeURIComponent(String(autoCloseMs))}` : ''}`;
  const url = isDev
    ? `${DEV_SERVER_URL}/?customerReceipt=${encoded}${flags}`
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?customerReceipt=${encoded}${flags}`;
  child.loadURL(url);

  // Silent auto-print to the OS default printer.
  if (autoPrint && silent) {
    const startSilentPrint = scheduleSilentPrint(child, {
      delayMs: 40,
      onDone: () => {
        if (autoCloseMs > 0) {
          setTimeout(() => { try { if (!child.isDestroyed()) child.close(); } catch {} }, autoCloseMs);
        }
      },
    });

    const handleReceiptReady = (readyEvent: any) => {
      if (readyEvent?.sender !== child.webContents) return;
      cleanupReceiptReadyListener();
      startSilentPrint();
    };

    const handleReceiptQrFailed = (failedEvent: any, message?: string) => {
      if (failedEvent?.sender !== child.webContents) return;
      cleanupReceiptReadyListener();
      try {
        if (!child.isDestroyed()) {
          child.show();
          child.focus();
        }
      } catch {}
      try { child.webContents.send('customer-receipt:print-error', String(message || 'The QR code could not be created.')); } catch {}
    };

    const cleanupReceiptReadyListener = () => {
      try { ipcMain.removeListener('customer-receipt:ready', handleReceiptReady); } catch {}
      try { ipcMain.removeListener('customer-receipt:qr-failed', handleReceiptQrFailed); } catch {}
    };

    ipcMain.on('customer-receipt:ready', handleReceiptReady);
    ipcMain.on('customer-receipt:qr-failed', handleReceiptQrFailed);
    child.once('closed', cleanupReceiptReadyListener);
  }
  return { ok: true };
});

// Consult Sheet print window (Sales consultations)
ipcMain.handle('open-consult-sheet', async (event: any, payload: any) => {
  const parentWin = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;

  // Payload shape mirrors open-customer-receipt for consistency
  const data = payload && typeof payload === 'object' && 'data' in payload ? (payload as any).data : payload;
  const autoPrint = !!(payload && typeof payload === 'object' && (payload as any).autoPrint);
  const silent = !!(payload && typeof payload === 'object' && (payload as any).silent);
  const autoCloseMs = Number(payload && typeof payload === 'object' ? (payload as any).autoCloseMs : 0) || 0;
  const showWindow = payload && typeof payload === 'object' && 'show' in payload ? !!(payload as any).show : !silent;

  const actualParent = (autoPrint && silent)
    ? (mainWindow || BrowserWindow.getAllWindows()[0] || undefined)
    : parentWin;

  const child = new BrowserWindow({
    width: 850,
    height: 1100,
    resizable: true,
    parent: actualParent as any,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Consult Sheet'),
  });
  if (showWindow) {
    showWindowFast(child, () => { centerWindow(child); });
  }
  child.on('closed', () => { try { (parentWin as any)?.show?.(); (parentWin as any)?.focus?.(); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });

  const encoded = encodeURIComponent(JSON.stringify(data || {}));
  const flags = `${autoPrint ? '&autoPrint=1' : ''}${silent ? '&silent=1' : ''}${autoCloseMs ? `&autoCloseMs=${encodeURIComponent(String(autoCloseMs))}` : ''}`;
  const url = isDev
    ? `${DEV_SERVER_URL}/?consultSheet=${encoded}${flags}`
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?consultSheet=${encoded}${flags}`;
  child.loadURL(url);

  if (autoPrint && silent) {
    const startSilentPrint = scheduleSilentPrint(child, {
      delayMs: 40,
      onDone: () => {
        if (autoCloseMs > 0) {
          setTimeout(() => { try { if (!child.isDestroyed()) child.close(); } catch {} }, autoCloseMs);
        }
      },
    });

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const armFallback = () => {
      fallbackTimer = setTimeout(startSilentPrint, SILENT_PRINT_RENDERER_READY_TIMEOUT_MS);
    };

    const handleReady = (readyEvent: any) => {
      if (readyEvent?.sender !== child.webContents) return;
      cleanupReadyListener();
      startSilentPrint();
    };

    const cleanupReadyListener = () => {
      try { clearTimeout(fallbackTimer); } catch {}
      try { ipcMain.removeListener('consult-sheet:ready', handleReady); } catch {}
    };

    child.webContents.once('did-finish-load', armFallback);
    const absoluteBackstop = setTimeout(() => {
      if (fallbackTimer === undefined) armFallback();
    }, app.isPackaged ? 5000 : 7000);
    child.once('closed', () => { try { clearTimeout(absoluteBackstop); } catch {} });

    ipcMain.on('consult-sheet:ready', handleReady);
    child.once('closed', cleanupReadyListener);
  }

  return { ok: true };
});

// Product Form print window (Sales)
ipcMain.handle('open-product-form', async (event: any, payload: any) => {
  const parentWin = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  const child = new BrowserWindow({
    width: 850,
    height: 1100,
    resizable: true,
    parent: parentWin as any,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Product Form'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  child.on('closed', () => { try { (parentWin as any)?.show?.(); (parentWin as any)?.focus?.(); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const encoded = encodeURIComponent(JSON.stringify(payload || {}));
  const url = isDev ? `${DEV_SERVER_URL}/?productForm=${encoded}` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?productForm=${encoded}`;
  child.loadURL(url);
  return { ok: true };
});

// Reporting window
ipcMain.handle('open-reporting', async () => {
  const child = new BrowserWindow({
    width: 1100,
    height: 800,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Reporting'),
  });
  child.once('ready-to-show', () => { centerWindow(child); child.show(); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?reporting=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?reporting=true`;
  child.loadURL(url);
  return { ok: true };
});

// Report Email window (Reporting -> Send Email)
ipcMain.handle('open-report-email', async (event: any, payload: any) => {
  const parentWin = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  const child = new BrowserWindow({
    width: 900,
    height: 760,
    resizable: true,
    parent: parentWin as any,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Send Report Email'),
  });
  child.once('ready-to-show', () => { centerWindow(child); child.show(); try { child.focus(); } catch {} });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const encoded = encodeURIComponent(JSON.stringify(payload || {}));
  const url = isDev ? `${DEV_SERVER_URL}/?reportEmail=${encoded}` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?reportEmail=${encoded}`;
  child.loadURL(url);
  return { ok: true };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (BrowserWindow.getAllWindows().length) {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.focus();
    }
  });
// ─────────────────────────────────────────────────────────────────────────────
// QR Code Status Server
// Serves a mobile-friendly status update page at http://[LAN-IP]:7777/status/{repair|sale}/{id}
// Technician scans QR on receipt → taps status → client gets email notification.
// ─────────────────────────────────────────────────────────────────────────────
const httpMod = require('http');

const QR_PORT = 7777;
let qrHttpServer: any = null;
stopQrStatusServerForUpdate = async () => {
  if (!qrHttpServer) return;
  const server = qrHttpServer;
  qrHttpServer = null;
  try { server.closeAllConnections?.(); } catch {}
  await Promise.race([
    new Promise<void>((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 750)),
  ]);
};

function getLanIp(): string {
  try {
    const ifaces = os.networkInterfaces();
    const candidates: Array<{ priority: number; address: string }> = [];
    for (const name of Object.keys(ifaces)) {
      const lname = name.toLowerCase();
      // Skip virtual/hotspot adapters: "Local Area Connection* N", vEthernet, loopback, Wi-Fi Direct
      const isVirtual = /local area connection\*|vethernet|wi-fi direct|virtualbox|vmware|hyper-v|tap-/i.test(lname);
      for (const iface of (ifaces[name] || [])) {
        const addr = (iface as any).address as string;
        if ((iface as any).internal || (iface as any).family !== 'IPv4') continue;
        if (isVirtual) continue;
        // Skip Windows hotspot default range (192.168.137.x)
        if (addr.startsWith('192.168.137.')) continue;
        // Priority: Ethernet first, then Wi-Fi, then anything else
        const priority = /^ethernet/i.test(lname) ? 0 : /^wi-fi|^wlan/i.test(lname) ? 1 : 2;
        candidates.push({ priority, address: addr });
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    if (candidates.length > 0) return candidates[0].address;
  } catch {}
  return '127.0.0.1';
}

// Returns the stable hostname used in QR code URLs.
// Using the machine hostname means QR codes remain valid even after DHCP
// assigns a new IP — most modern routers resolve the hostname on the LAN.
// The IP is kept as a fallback reference for display in the UI.
function getQrHost(): string {
  try {
    const hostname = os.hostname();
    if (hostname && hostname.trim() && hostname !== 'localhost') {
      return hostname.trim();
    }
  } catch {}
  return getLanIp(); // fallback to IP if hostname unavailable
}

function qrStatusUrl(type: 'repair' | 'sale', id: number | string): string {
  return `http://${getQrHost()}:${QR_PORT}/status/${type}/${id}`;
}

function qrConsultUrl(id: number | string): string {
  return `http://${getQrHost()}:${QR_PORT}/status/consult/${id}`;
}

function getQrServerInfo(): { hostname: string; ip: string; port: number; hostUrl: string; ipUrl: string } {
  const hostname = getQrHost();
  const ip = getLanIp();
  const port = QR_PORT;
  return {
    hostname,
    ip,
    port,
    hostUrl: `http://${hostname}:${port}`,
    ipUrl:   `http://${ip}:${port}`,
  };
}

type QrStatusType = 'repair' | 'sale' | 'consult';

function getPublicAppUrl(): string {
  const configured = String(process.env.GBPOS_PUBLIC_APP_URL || process.env.VITE_PUBLIC_APP_URL || '').trim();
  return (configured || 'https://mattstechwisdom.github.io/GB-POS').replace(/\/+$/, '');
}

function normalizeQrStatusType(value: any): QrStatusType {
  const raw = String(value || '').trim().toLowerCase();
  if (/^(sale|sales|invoice|inv)$/.test(raw)) return 'sale';
  if (/^(consult|consultation|appointment)$/.test(raw)) return 'consult';
  return 'repair';
}

function cloudRecordKeyForQrType(type: QrStatusType): string {
  if (type === 'sale') return 'sales';
  if (type === 'consult') return 'calendarEvents';
  return 'workOrders';
}

function makeQrToken(): string {
  return nodeCrypto.randomBytes(24).toString('base64url');
}

function cloudQrUrl(type: QrStatusType, token: string): string {
  return type === 'consult'
    ? `${getPublicAppUrl()}/consultation.html?token=${encodeURIComponent(token)}`
    : `${getPublicAppUrl()}/?clientUpdateToken=${encodeURIComponent(token)}`;
}

async function ensureCloudQrStatusUrl(type: QrStatusType, id: number): Promise<string | null> {
  const client = getCloudClient();
  if (!client || !cloudSession?.shopId || !id) return null;

  const recordKey = cloudRecordKeyForQrType(type);
  // Reprints must not depend on uploading the entire ticket again.
  const existing = await client
    .from('qr_status_tokens')
    .select('token')
    .eq('shop_id', cloudSession.shopId)
    .eq('record_type', type)
    .eq('legacy_record_id', id)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(`Cloud QR token lookup failed: ${existing.error.message}`);
  if (existing.data?.token) return cloudQrUrl(type, existing.data.token);

  const recordTable = CLOUD_TABLE_BY_KEY[recordKey];
  let recordCloudId: string | null = null;
  let record = await client.from(recordTable).select('id').eq('shop_id', cloudSession.shopId).eq('legacy_id', id).maybeSingle();
  if (record.error) throw new Error(`Cloud QR record lookup failed: ${record.error.message}`);
  if (!record.data?.id) {
    // Only a genuinely unsynchronized new ticket needs a write before printing.
    const localRecords = (readDb() as any)?.[recordKey];
    const localRecord = Array.isArray(localRecords) ? localRecords.find((row: any) => Number(row?.id || 0) === id) : null;
    if (!localRecord) throw new Error('The saved record could not be found for this QR code.');
    await cloudDbUpsert(recordKey, localRecord);
    record = await client.from(recordTable).select('id').eq('shop_id', cloudSession.shopId).eq('legacy_id', id).maybeSingle();
    if (record.error || !record.data?.id) throw new Error(`Cloud QR record lookup failed: ${record.error?.message || 'Record is not synchronized yet.'}`);
  }
  recordCloudId = record.data.id;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await client
      .from('qr_status_tokens')
      .insert({ shop_id: cloudSession.shopId, token: makeQrToken(), record_type: type, legacy_record_id: id, record_id: recordCloudId, metadata: { createdBy: 'gb-pos' } })
      .select('token')
      .single();
    if (!inserted.error && inserted.data?.token) return cloudQrUrl(type, inserted.data.token);
    if (!/duplicate|unique/i.test(String(inserted.error?.message || ''))) {
      throw new Error(`Cloud QR token create failed: ${inserted.error?.message || 'Unknown error'}`);
    }
  }
  throw new Error('Cloud QR token create failed after duplicate retries.');
}

async function resolveCloudQrStatusToken(token: string) {
  const client = getCloudClient();
  if (!client || !cloudSession?.shopId) throw new Error('Cloud session is not ready.');
  const cleaned = String(token || '').trim();
  if (!cleaned) throw new Error('Missing QR token.');

  const tokenRes = await client.from('qr_status_tokens').select('*').eq('token', cleaned).eq('shop_id', cloudSession.shopId).is('revoked_at', null).maybeSingle();
  if (tokenRes.error) throw new Error(`Cloud QR token read failed: ${tokenRes.error.message}`);
  if (!tokenRes.data) throw new Error('QR token was not found for this shop.');
  if (tokenRes.data.expires_at && new Date(tokenRes.data.expires_at).getTime() < Date.now()) throw new Error('This QR token is expired.');

  void client.from('qr_status_tokens').update({ last_opened_at: new Date().toISOString() }).eq('id', tokenRes.data.id).then(() => undefined);
  const type = normalizeQrStatusType(tokenRes.data.record_type);
  const recordRes = await client.from(CLOUD_TABLE_BY_KEY[cloudRecordKeyForQrType(type)]).select('*').eq('shop_id', cloudSession.shopId).eq('legacy_id', Number(tokenRes.data.legacy_record_id)).maybeSingle();
  if (recordRes.error) throw new Error(`Cloud QR record read failed: ${recordRes.error.message}`);
  if (!recordRes.data) throw new Error('The QR record no longer exists.');

  const record = fromCloudRow(cloudRecordKeyForQrType(type), recordRes.data);
  let customer: any = null;
  const customerId = Number(record?.customerId || 0) || 0;
  if (customerId > 0) {
    const customerRes = await client.from('customers').select('*').eq('shop_id', cloudSession.shopId).eq('legacy_id', customerId).maybeSingle();
    if (!customerRes.error && customerRes.data) customer = fromCloudRow('customers', customerRes.data);
  }
  return { token: tokenRes.data, type, record, customer };
}

function escHtml(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildConsultPageHtml(event: any): string {
  const clientName = escHtml(String(event?.customerName || 'Client').trim());
  const clientEmail = String(event?.customerEmail || '').trim();
  const eventTitle = escHtml(String(event?.title || 'Consultation').trim());
  const apptDate = String(event?.date || '').trim();
  const apptTime = String(event?.time || '').trim();
  const apptEndTime = String(event?.endTime || '').trim();
  const locationType = String(event?.consultationType || '').trim();
  const address = String(event?.consultationAddress || event?.location || '').trim();
  const techName = escHtml(String(event?.technician || '').trim());

  let formattedDate = apptDate;
  try { formattedDate = new Date(apptDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch {}

  const fmt12 = (t: string) => {
    try {
      if (!t) return '';
      const [hh, mm] = t.split(':').map(Number);
      const ampm = hh >= 12 ? 'PM' : 'AM';
      return `${hh % 12 || 12}:${String(mm || 0).padStart(2, '0')} ${ampm}`;
    } catch { return t; }
  };
  const timeDisplay = apptTime ? (apptEndTime ? `${fmt12(apptTime)} – ${fmt12(apptEndTime)}` : fmt12(apptTime)) : '';
  const locationIsHome = /athome|at.home/i.test(locationType) || (address && address.toLowerCase() !== 'in-store' && address.toLowerCase() !== 'in store');
  const locationDisplay = escHtml(locationIsHome && address ? address : 'In-Store — 2822 Devine St, Columbia SC');
  const hasEmail = !!clientEmail;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Consultation — GadgetBoy</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#18181b;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;min-height:100vh;padding:16px}
  .container{max-width:420px;margin:0 auto}
  .header{background:#27272a;border-radius:14px;padding:18px;margin-bottom:14px;display:flex;align-items:center;gap:12px;border-bottom:3px solid #eab308}
  .logo{width:48px;height:48px;border-radius:8px;object-fit:contain;background:#18181b}
  .brand-name{font-size:15px;font-weight:900;color:#f4f4f5;letter-spacing:-.3px}
  .brand-sub{font-size:11px;color:#a1a1aa;margin-top:2px}
  .info-card{background:#27272a;border-radius:12px;padding:16px;margin-bottom:14px;border:1px solid #3f3f46}
  .info-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#a1a1aa;margin-bottom:6px}
  .info-row{display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid #3f3f46;font-size:14px}
  .info-row:last-child{border-bottom:none}
  .info-row-key{color:#a1a1aa;font-size:12px;font-weight:600;flex-shrink:0;margin-right:12px}
  .info-row-val{color:#f4f4f5;font-weight:600;text-align:right}
  .btn{display:block;width:100%;padding:14px;border-radius:10px;font-size:15px;font-weight:700;border:none;cursor:pointer;text-align:center;margin-bottom:10px;transition:opacity .15s}
  .btn:active{opacity:.8}
  .btn-yellow{background:#eab308;color:#1c1917}
  .btn-zinc{background:#3f3f46;color:#f4f4f5;border:1px solid #52525b}
  .note-card{background:#27272a;border-radius:10px;padding:14px;border:1px solid #3f3f46;font-size:13px;color:#a1a1aa;line-height:1.6;margin-bottom:14px;text-align:center}
  .status-msg{border-radius:10px;padding:12px 16px;margin-bottom:12px;font-size:14px;font-weight:600;text-align:center}
  .status-ok{background:#14532d;color:#86efac;border:1px solid #16a34a}
  .status-err{background:#7f1d1d;color:#fca5a5;border:1px solid #ef4444}
  .no-email{background:#451a03;border:1px solid #92400e;color:#fcd34d;border-radius:10px;padding:12px;font-size:13px;margin-bottom:12px;text-align:center}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <img class="logo" src="/logo" alt="GB">
    <div>
      <div class="brand-name">GADGETBOY</div>
      <div class="brand-sub">Repair &amp; Retail · 2822 Devine St</div>
    </div>
  </div>

  <div class="info-card">
    <div class="info-label">📅 Consultation Appointment</div>
    <div class="info-row"><span class="info-row-key">Client</span><span class="info-row-val">${clientName}</span></div>
    <div class="info-row"><span class="info-row-key">Service</span><span class="info-row-val">${eventTitle}</span></div>
    ${formattedDate ? `<div class="info-row"><span class="info-row-key">Date</span><span class="info-row-val">${escHtml(formattedDate)}</span></div>` : ''}
    ${timeDisplay ? `<div class="info-row"><span class="info-row-key">Time</span><span class="info-row-val">${escHtml(timeDisplay)}</span></div>` : ''}
    <div class="info-row"><span class="info-row-key">Location</span><span class="info-row-val" style="font-size:13px">${locationDisplay}</span></div>
    ${techName ? `<div class="info-row"><span class="info-row-key">Technician</span><span class="info-row-val">${techName}</span></div>` : ''}
  </div>

  <div id="status-msg"></div>

  ${!hasEmail ? `<div class="no-email">⚠️ No email on file for this client — reminder cannot be sent.</div>` : ''}

  <button class="btn btn-yellow" id="btn-reminder" ${!hasEmail ? 'disabled style="opacity:.4;cursor:not-allowed"' : ''}>
    📅 Send Consultation Reminder
  </button>
  <button class="btn btn-zinc" id="btn-call">
    📞 Call the Shop — (803) 708-0101
  </button>

  <div class="note-card">
    To add details prior to your consultation or to reschedule, please reply to your confirmation email or call us at <strong style="color:#f4f4f5">(803) 708-0101</strong>. We look forward to seeing you!
  </div>
</div>
<script>
  const statusEl = document.getElementById('status-msg');
  function showStatus(ok, msg) {
    statusEl.innerHTML = '<div class="status-msg ' + (ok ? 'status-ok' : 'status-err') + '">' + msg + '</div>';
  }
  document.getElementById('btn-reminder')?.addEventListener('click', async function() {
    this.disabled = true;
    this.textContent = 'Sending…';
    try {
      const res = await fetch(location.pathname, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ action: 'send_reminder' }) });
      const data = await res.json();
      if (data.ok) {
        showStatus(true, '✅ Reminder sent! Check your email.');
        this.textContent = '✅ Reminder Sent';
      } else {
        showStatus(false, '❌ ' + (data.error || 'Failed to send.'));
        this.disabled = false;
        this.textContent = '📅 Send Consultation Reminder';
      }
    } catch(e) {
      showStatus(false, '❌ Network error — try again.');
      this.disabled = false;
      this.textContent = '📅 Send Consultation Reminder';
    }
  });
  document.getElementById('btn-call')?.addEventListener('click', function() {
    window.location.href = 'tel:+18037080101';
  });
</script>
</body>
</html>`;
}

function buildStatusPageHtml(type: 'repair' | 'sale', record: any): string {
  const isRepair = type === 'repair';
  const clientName = escHtml(String(record?.customerName || record?.client || 'Client').trim() || 'Client');
  const clientEmail = String(record?.customerEmail || record?.email || '').trim();
  const clientPhone = String(record?.customerPhone || record?.phone || '').trim();
  const clientPhoneAlt = String(record?.customerPhoneAlt || record?.phoneAlt || '').trim();
  const rawDevice = isRepair
    ? String(record?.productDescription || record?.productCategory || record?.description || record?.device || record?.deviceModel || 'Device').trim()
    : String(record?.productDescription || record?.category || 'Order').trim();
  const device = escHtml(rawDevice.length > 80 ? rawDevice.slice(0, 80) + '…' : rawDevice);
  const orderId = isRepair ? `WO-${record?.id ?? '?'}` : `INV-${record?.id ?? '?'}`;

  const repairStatuses = [
    { key: 'pickup_reminder',  label: 'Pickup Reminder',           icon: '🔔', color: '#06b6d4' },
    { key: 'manual_update',    label: 'Send Update',               icon: '✏️', color: '#8b5cf6' },
    { key: 'diagnosis',        label: 'Diagnosis In Process',      icon: '🔍', color: '#3b82f6' },
    { key: 'waiting_device',   label: 'Waiting on Device',         icon: '📲', color: '#1d4ed8' },
    { key: 'part_ordered',     label: 'Part Ordered',              icon: '📦', color: '#f59e0b' },
    { key: 'waiting_part',     label: 'Waiting on Part Delivery',  icon: '🚚', color: '#f97316' },
    { key: 'part_delivered',   label: 'Part Delivered',            icon: '🎉', color: '#16a34a' },
    { key: 'repair_complete',  label: 'Repair Complete',           icon: '✅', color: '#22c55e' },
    { key: 'not_possible',     label: 'Repair Not Possible',       icon: '❌', color: '#ef4444' },
  ];
  const saleStatuses = [
    { key: 'pickup_reminder',  label: 'Pickup Reminder',   icon: '🔔', color: '#06b6d4' },
    { key: 'manual_update',    label: 'Send Update',        icon: '✏️', color: '#8b5cf6' },
    { key: 'product_ordered',  label: 'Product Ordered',   icon: '📦', color: '#f59e0b' },
    { key: 'product_in_shop',  label: 'Product In Shop',   icon: '🏪', color: '#22c55e' },
  ];

  // Keys that expand a detail panel; others send immediately
  const detailPanelMap: Record<string, 'date' | 'notes'> = isRepair
    ? { part_ordered: 'date', waiting_part: 'date', repair_complete: 'notes', not_possible: 'notes', manual_update: 'notes' }
    : { product_ordered: 'date', manual_update: 'notes' };

  // Top-action keys rendered ABOVE the client info card
  const topKeys = ['pickup_reminder', 'manual_update'];
  const allStatuses = isRepair ? repairStatuses : saleStatuses;
  const renderBtn = (s: { key: string; label: string; icon: string; color: string }) => {
    const panelType = detailPanelMap[s.key];
    const btnOnClick = panelType ? `toggleDetail('${s.key}')` : `sendStatus('${s.key}','${s.label}')`;
    const arrowSpan = panelType ? `<span class="btn-arrow" id="arrow_${s.key}">&rsaquo;</span>` : '';
    let panelHtml = '';
    if (panelType === 'date') {
      const fieldLabel = s.key === 'waiting_part' ? 'Estimated Arrival Date' : 'Estimated Delivery Date';
      panelHtml = `<div class="detail-panel" id="detail_${s.key}"><label class="detail-label">${fieldLabel}</label><input type="date" class="detail-input" id="field_${s.key}"><button class="send-detail-btn" onclick="sendStatusWithDetail('${s.key}','${s.label}')">Send Update</button></div>`;
    } else if (panelType === 'notes') {
      const notesPlaceholder = s.key === 'manual_update' ? 'Type your update message to the customer…' : 'Add details about the repair…';
      const notesLabel = s.key === 'manual_update' ? 'Message for Customer' : 'Notes for Customer <span class="detail-optional">(optional)</span>';
      panelHtml = `<div class="detail-panel" id="detail_${s.key}"><label class="detail-label">${notesLabel}</label><textarea class="detail-textarea" id="field_${s.key}" placeholder="${notesPlaceholder}"></textarea><button class="send-detail-btn" onclick="sendStatusWithDetail('${s.key}','${s.label}')">Send Update</button></div>`;
    }
    return `    <button class="status-btn" onclick="${btnOnClick}" style="border-left:4px solid ${s.color}">
      <span class="btn-icon">${s.icon}</span>
      <span class="btn-label">${escHtml(s.label)}</span>
      ${arrowSpan}
    </button>${panelHtml}`;
  };
  const topButtonsHtml  = allStatuses.filter(s =>  topKeys.includes(s.key)).map(renderBtn).join('\n');
  const mainButtonsHtml = allStatuses.filter(s => !topKeys.includes(s.key)).map(renderBtn).join('\n');

  const emailRow = clientEmail
    ? `<div class="info-row"><span class="info-label">Email</span><span class="info-value">${escHtml(clientEmail)}</span></div>`
    : '';
  const phoneRow = clientPhone
    ? `<div class="info-row"><span class="info-label">Phone</span><span class="info-value">${escHtml(clientPhone)}</span></div>`
    : '';
  const phoneAltRow = clientPhoneAlt
    ? `<div class="info-row"><span class="info-label">Alt Phone</span><span class="info-value">${escHtml(clientPhoneAlt)}</span></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Status Update – GadgetBoy</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#18181b;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;min-height:100vh}
.header{background:#09090b;border-bottom:3px solid #39FF14;padding:14px 20px;display:flex;align-items:center;gap:14px}
.header-logo{display:flex;align-items:center;gap:12px}
.header-logo img{height:44px;width:auto;display:block}
.header-text-title{font-size:18px;font-weight:900;color:#f4f4f5;letter-spacing:-0.3px;line-height:1.1}
.header-text-sub{font-size:11px;color:#a1a1aa;margin-top:2px}
.container{max-width:480px;margin:0 auto;padding:20px 16px 48px}
.info-card{background:#27272a;border:1px solid #3f3f46;border-radius:12px;padding:16px;margin-bottom:20px}
.info-row{display:flex;gap:8px;align-items:baseline;padding:6px 0;border-bottom:1px solid #3f3f46}
.info-row:last-child{border-bottom:none}
.info-label{font-size:11px;color:#71717a;min-width:72px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;flex-shrink:0}
.info-value{font-size:14px;color:#f4f4f5;font-weight:500;word-break:break-word}
.section-title{font-size:12px;font-weight:700;color:#a1a1aa;text-transform:uppercase;letter-spacing:.7px;margin-bottom:12px}
.notify-row{display:flex;align-items:center;justify-content:space-between;background:#27272a;border:1px solid #3f3f46;border-radius:10px;padding:11px 14px;margin-bottom:14px}
.notify-label{font-size:12px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.toggle-wrap{display:flex;background:#18181b;border-radius:8px;padding:3px;gap:2px}
.toggle-opt{border:none;border-radius:6px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;color:#a1a1aa;background:transparent;transition:background .15s,color .15s;-webkit-tap-highlight-color:transparent}
.toggle-opt.active{background:#39FF14;color:#18181b}
.status-btn{display:flex;align-items:center;gap:14px;width:100%;background:#27272a;border:1px solid #3f3f46;border-radius:10px;padding:14px 16px;margin-bottom:10px;cursor:pointer;text-align:left;color:#f4f4f5;transition:background .15s,transform .1s;-webkit-tap-highlight-color:transparent}
.status-btn:hover{background:#3f3f46;transform:translateY(-1px)}
.status-btn:active{transform:translateY(0);background:#52525b}
.btn-icon{font-size:22px;flex-shrink:0}
.btn-label{font-size:15px;font-weight:600;line-height:1.3}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10;align-items:center;justify-content:center;flex-direction:column;gap:16px}
.overlay.active{display:flex}
.spinner{width:44px;height:44px;border:4px solid #3f3f46;border-top-color:#39FF14;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.overlay-text{color:#f4f4f5;font-size:16px;font-weight:600}
.result-card{display:none;background:#27272a;border:1px solid #3f3f46;border-radius:14px;padding:28px 24px;text-align:center;margin-top:8px}
.result-card.show{display:block}
.result-icon{font-size:52px;margin-bottom:14px}
.result-title{font-size:20px;font-weight:800;margin-bottom:8px}
.result-sub{font-size:13px;color:#a1a1aa;line-height:1.6}
.btns-wrap.hidden,.hidden{display:none}
.header-action{margin-left:auto;flex-shrink:0}
.storage-fee-header-btn{display:flex;align-items:center;gap:7px;background:#7f1d1d;border:1.5px solid #ef4444;border-radius:8px;padding:8px 14px;color:#fef2f2;cursor:pointer;font-size:13px;font-weight:700;-webkit-tap-highlight-color:transparent;transition:background .15s;white-space:nowrap}
.storage-fee-header-btn:hover{background:#991b1b}
.storage-fee-header-btn:active{background:#b91c1c}
.btn-arrow{margin-left:auto;font-size:20px;color:#71717a;font-weight:600;transition:transform .2s;display:inline-block;line-height:1}
.detail-panel{display:none;background:#1c1c20;border:1px solid #52525b;border-top:none;border-radius:0 0 10px 10px;padding:14px 16px 16px;margin-top:-10px;margin-bottom:10px}
.detail-panel.open{display:block}
.detail-label{font-size:11px;font-weight:700;color:#a1a1aa;text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;display:block}
.detail-optional{font-weight:400;text-transform:none;letter-spacing:0;font-size:11px}
.detail-input,.detail-textarea{width:100%;background:#27272a;border:1.5px solid #52525b;border-radius:8px;padding:10px 12px;color:#f4f4f5;font-size:14px;display:block;margin-bottom:12px;font-family:inherit}
.detail-input:focus,.detail-textarea:focus{outline:none;border-color:#39FF14}
.detail-textarea{resize:vertical;min-height:80px;line-height:1.5}
.send-detail-btn{width:100%;background:#39FF14;color:#18181b;border:none;border-radius:8px;padding:12px;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:-.2px;transition:opacity .15s}
.send-detail-btn:active{opacity:.85}
</style>
</head>
<body>
<div class="header">
  <div class="header-logo">
    <img src="/logo" alt="GadgetBoy" onerror="this.style.display='none'">
    <div>
      <div class="header-text-title">GADGETBOY</div>
      <div class="header-text-sub">Repair &amp; Retail &nbsp;·&nbsp; Status Update Portal</div>
    </div>
  </div>
</div>
<div class="container">
  <div class="notify-row" id="notifyRow">
    <span class="notify-label">Notify via</span>
    <div class="toggle-wrap">
      <button class="toggle-opt active" id="optEmail" onclick="setNotify('email')">✉ Email</button>
      <button class="toggle-opt" id="optSms" onclick="setNotify('sms')">📱 SMS</button>
    </div>
  </div>
  <div id="topActionsWrap">
    <div class="section-title" style="margin-bottom:12px">Quick Actions</div>
    ${topButtonsHtml}
  </div>
  <div class="info-card">
    <div class="info-row"><span class="info-label">Order</span><span class="info-value">${escHtml(orderId)}</span></div>
    <div class="info-row"><span class="info-label">Client</span><span class="info-value">${clientName}</span></div>
    ${phoneRow}
    ${phoneAltRow}
    ${emailRow}
    <div class="info-row"><span class="info-label">${isRepair ? 'Device' : 'Item(s)'}</span><span class="info-value">${device}</span></div>
  </div>
  <div class="btns-wrap" id="btnsWrap">
    <div class="section-title">Send Status Update to Client</div>
    ${mainButtonsHtml}
  </div>
  <div class="result-card" id="resultCard">
    <div class="result-icon" id="resultIcon">✅</div>
    <div class="result-title" id="resultTitle">Update Sent!</div>
    <div class="result-sub" id="resultSub">The client has been notified.</div>
  </div>
</div>
<div class="overlay" id="overlay">
  <div class="spinner"></div>
  <div class="overlay-text">Sending notification…</div>
</div>
<script>
var notifyVia='email';
function setNotify(val){
  notifyVia=val;
  document.getElementById('optEmail').classList.toggle('active',val==='email');
  document.getElementById('optSms').classList.toggle('active',val==='sms');
}
function toggleDetail(key){
  var panels=document.querySelectorAll('.detail-panel');
  var arrows=document.querySelectorAll('.btn-arrow');
  var panel=document.getElementById('detail_'+key);
  var isOpen=panel&&panel.classList.contains('open');
  panels.forEach(function(p){p.classList.remove('open');});
  arrows.forEach(function(a){a.style.transform='';});
  if(!isOpen&&panel){
    panel.classList.add('open');
    var arrow=document.getElementById('arrow_'+key);
    if(arrow)arrow.style.transform='rotate(90deg)';
  }
}
function sendStatusWithDetail(key,label){
  var extra={};
  var field=document.getElementById('field_'+key);
  if(field&&field.tagName==='INPUT'&&field.value)extra.estimatedDate=field.value;
  if(field&&field.tagName==='TEXTAREA'&&field.value)extra.notes=field.value;
  sendStatus(key,label,extra);
}
function sendStatus(key,label,extra){
  extra=extra||{};
  document.getElementById('overlay').classList.add('active');
  fetch(window.location.pathname,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(Object.assign({status:key,label:label,notifyVia:notifyVia},extra))
  })
  .then(function(r){return r.json();})
  .then(function(data){
    document.getElementById('overlay').classList.remove('active');
    document.getElementById('notifyRow').classList.add('hidden');
    document.getElementById('topActionsWrap').classList.add('hidden');
    document.getElementById('btnsWrap').classList.add('hidden');
    var ok=data.ok!==false;
    document.getElementById('resultIcon').textContent=ok?'✅':'⚠️';
    document.getElementById('resultTitle').textContent=ok?'Update Sent!':'Status Logged';
    document.getElementById('resultSub').textContent=data.message||(ok?'The client has been notified.':'Status was saved but notification could not be sent.');
    document.getElementById('resultCard').classList.add('show');
  })
  .catch(function(){
    document.getElementById('overlay').classList.remove('active');
    document.getElementById('resultIcon').textContent='❌';
    document.getElementById('resultTitle').textContent='Connection Error';
    document.getElementById('resultSub').textContent='Could not reach the POS. Make sure the app is running on the same network.';
    document.getElementById('resultCard').classList.add('show');
    document.getElementById('notifyRow').classList.add('hidden');
    document.getElementById('topActionsWrap').classList.add('hidden');
    document.getElementById('btnsWrap').classList.add('hidden');
  });
}
</script>
</body>
</html>`;
}

async function handleQrRequest(req: any, res: any) {
  const rawUrl = String(req.url || '');
  const url = rawUrl.split('?')[0];

  if (url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  // Allow browser/preview to discover the machine's LAN IP so QR codes point to
  // the right address when scanned from a phone on the same network.
  if (url === '/ip') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ ip: getLanIp() }));
    return;
  }

  // Serve the shop logo so the status page can display it when scanned from a phone.
  if (url === '/logo') {
    const logoPath = isDev
      ? path.join(app.getAppPath(), 'public', 'logo.png')
      : path.join(app.getAppPath(), 'dist', 'logo.png');
    try {
      const data = fs.readFileSync(logoPath);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('logo not found');
    }
    return;
  }

  // ── Consultation status page ───────────────────────────────────────────
  const consultMatch = url.match(/^\/status\/consult\/(\d+)$/);
  if (consultMatch) {
    const eventId = parseInt(consultMatch[1], 10);
    const db = readDb();
    const events: any[] = Array.isArray(db['calendarEvents']) ? db['calendarEvents'] : [];
    const event = events.find((e: any) => Number(e?.id || 0) === eventId) || null;

    if (!event) {
      const notFoundHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title><style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{background:#27272a;border:1px solid #3f3f46;border-radius:14px;padding:32px;max-width:360px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">🔍</div><h2>Consultation Not Found</h2><p style="color:#a1a1aa;font-size:14px">Event #${eventId} could not be located.</p></div></body></html>`;
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(notFoundHtml);
      return;
    }

    // Enrich with customer email/phone if not on event directly
    let customerEmail = String(event.customerEmail || '').trim();
    let customerPhone = String(event.customerPhone || '').trim();
    const customerId = Number(event.customerId || 0);
    if ((!customerEmail || !customerPhone) && customerId > 0) {
      const customers: any[] = Array.isArray(db['customers']) ? db['customers'] : [];
      const cust = customers.find((c: any) => Number(c?.id || 0) === customerId);
      if (cust) {
        if (!customerEmail) customerEmail = String(cust.email || '').trim();
        if (!customerPhone) customerPhone = String(cust.phone || '').trim();
      }
    }
    const enrichedEvent = { ...event, customerEmail, customerPhone };

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buildConsultPageHtml(enrichedEvent));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: any) => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const action = String(payload?.action || '').trim();

          if (action === 'send_reminder') {
            if (!enrichedEvent.customerEmail) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'No email address on file for this client.' }));
              return;
            }

            const clientName = String(enrichedEvent.customerName || 'Client').trim();
            const eventTitle = String(enrichedEvent.title || 'Consultation').trim();
            const apptDate = String(enrichedEvent.date || '').trim();
            const apptTime = String(enrichedEvent.time || '').trim();
            const apptEndTime = String(enrichedEvent.endTime || '').trim();
            const locationType = String(enrichedEvent.consultationType || enrichedEvent.location || '').trim();
            const address = String(enrichedEvent.consultationAddress || enrichedEvent.location || '').trim();
            const techName = String(enrichedEvent.technician || '').trim();

            let formattedDate = apptDate;
            try { formattedDate = new Date(apptDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch {}

            let formattedTime = apptTime;
            try {
              if (apptTime) {
                const [hh, mm] = apptTime.split(':').map(Number);
                const ampm = hh >= 12 ? 'PM' : 'AM';
                const h12 = hh % 12 || 12;
                formattedTime = `${h12}:${String(mm || 0).padStart(2, '0')} ${ampm}`;
              }
            } catch {}
            let formattedEndTime = '';
            try {
              if (apptEndTime) {
                const [hh2, mm2] = apptEndTime.split(':').map(Number);
                const ampm2 = hh2 >= 12 ? 'PM' : 'AM';
                const h122 = hh2 % 12 || 12;
                formattedEndTime = `${h122}:${String(mm2 || 0).padStart(2, '0')} ${ampm2}`;
              }
            } catch {}

            const locationIsHome = /athome|at.home|at home/i.test(locationType) || (address && address.toLowerCase() !== 'in-store' && address.toLowerCase() !== 'in store');
            const locationDisplay = locationIsHome && address ? address : 'In-Store — 2822 Devine St, Columbia SC';

            let logoImgHtml2 = '';
            try {
              const logoPath2 = isDev ? path.join(app.getAppPath(), 'public', 'logo.png') : path.join(app.getAppPath(), 'dist', 'logo.png');
              const logoData2 = fs.readFileSync(logoPath2);
              logoImgHtml2 = `<img src="data:image/png;base64,${logoData2.toString('base64')}" alt="GadgetBoy" style="height:40px;width:auto;border-radius:6px;">`;
            } catch {}

            const subject = `Consultation Reminder — ${formattedDate}${formattedTime ? ` at ${formattedTime}` : ''} | GadgetBoy`;
            const timeRange = formattedTime ? (formattedEndTime ? `${formattedTime} – ${formattedEndTime}` : formattedTime) : 'TBD';

            const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:#18181b;padding:20px 24px;border-bottom:3px solid #eab308;display:flex;align-items:center;gap:14px;">
    ${logoImgHtml2}
    <div>
      <div style="font-size:15px;font-weight:900;color:#f4f4f5;letter-spacing:-.3px;line-height:1.2;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#a1a1aa;margin-top:3px;line-height:1.7;">2822 Devine Street, Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
  <div style="padding:24px;">
    <h2 style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 8px;">📅 Consultation Reminder</h2>
    <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${escHtml(clientName)}</strong>, this is a friendly reminder about your upcoming consultation with GadgetBoy.</p>
    <div style="background:#fefce8;border:1.5px solid #eab308;border-radius:10px;padding:18px 20px;margin-bottom:20px;">
      <div style="font-size:11px;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Appointment Details</div>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="font-size:12px;color:#78350f;font-weight:600;padding:4px 0;width:80px;">Service</td><td style="font-size:14px;color:#1c1917;font-weight:700;">${escHtml(eventTitle)}</td></tr>
        <tr><td style="font-size:12px;color:#78350f;font-weight:600;padding:4px 0;">Date</td><td style="font-size:14px;color:#1c1917;font-weight:700;">${escHtml(formattedDate)}</td></tr>
        <tr><td style="font-size:12px;color:#78350f;font-weight:600;padding:4px 0;">Time</td><td style="font-size:14px;color:#1c1917;font-weight:700;">${escHtml(timeRange)}</td></tr>
        <tr><td style="font-size:12px;color:#78350f;font-weight:600;padding:4px 0;">Location</td><td style="font-size:14px;color:#1c1917;">${escHtml(locationDisplay)}</td></tr>
        ${techName ? `<tr><td style="font-size:12px;color:#78350f;font-weight:600;padding:4px 0;">Technician</td><td style="font-size:14px;color:#1c1917;">${escHtml(techName)}</td></tr>` : ''}
      </table>
    </div>
    <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 20px;">
      If you have any additional details you'd like to share prior to the consultation, or if you need to reschedule, simply <strong>reply to this email</strong> or give us a call at <strong>(803) 708-0101</strong>. We're happy to help!
    </p>
    <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 20px;">We look forward to seeing you! 😊</p>
    <div style="border-top:1px solid #e5e7eb;padding-top:18px;margin-top:4px;">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:3px;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#9ca3af;line-height:1.8;">2822 Devine Street &nbsp;&middot;&nbsp; Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
</div>
</body></html>`;

            const text = `Consultation Reminder\n\nHi ${clientName},\n\nThis is a reminder about your upcoming consultation with GadgetBoy.\n\nService: ${eventTitle}\nDate: ${formattedDate}\nTime: ${timeRange}\nLocation: ${locationDisplay}${techName ? `\nTechnician: ${techName}` : ''}\n\nIf you have any additional details or need to reschedule, reply to this email or call (803) 708-0101.\n\nWe look forward to seeing you!\n\n— GadgetBoy Repair & Retail`;

            try {
              const result = await sendConfiguredEmail({ to: enrichedEvent.customerEmail, subject, html, text });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result?.ok ? { ok: true } : { ok: false, error: result?.error || 'Failed to send email.' }));
            } catch (emailErr: any) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: emailErr?.message || 'Email error' }));
            }
            return;
          }

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unknown action' }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e?.message || 'Server error' }));
        }
      });
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const match = url.match(/^\/status\/(repair|sale)\/(\d+)$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const type = match[1] as 'repair' | 'sale';
  const id = parseInt(match[2], 10);
  const collection = type === 'repair' ? 'workOrders' : 'sales';

  const db = readDb();
  const records: any[] = Array.isArray(db[collection]) ? db[collection] : [];
  const record = records.find((r: any) => Number(r?.id || 0) === id) || null;

  if (!record) {
    const notFoundHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title><style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{background:#27272a;border:1px solid #3f3f46;border-radius:14px;padding:32px;max-width:360px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">🔍</div><h2 style="margin-bottom:8px">Record Not Found</h2><p style="color:#a1a1aa;font-size:14px">Order #${id} could not be located. It may have been removed.</p></div></body></html>`;
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(notFoundHtml);
    return;
  }

  // If the record has no inline customerName, look it up from the customers collection
  // (WorkOrderFull stores customerId only; Sales may store customerName directly)
  let enrichedRecord = record;
  if (!String(record?.customerName || record?.client || '').trim()) {
    const customerId0 = Number(record?.customerId || 0);
    if (customerId0 > 0) {
      const customers0: any[] = Array.isArray(db['customers']) ? db['customers'] : [];
      const cust0 = customers0.find((c: any) => Number(c?.id || 0) === customerId0);
      if (cust0) {
        const fullName = [cust0.firstName, cust0.lastName].filter(Boolean).join(' ').trim();
        if (fullName) enrichedRecord = { ...record, customerName: fullName, customerEmail: record.customerEmail || cust0.email || '', customerPhone: record.customerPhone || cust0.phone || '', customerPhoneAlt: record.customerPhoneAlt || cust0.phoneAlt || '' };
      }
    }
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buildStatusPageHtml(type, enrichedRecord));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const statusKey = String(payload?.status || '').trim();
        const statusLabel = String(payload?.label || '').trim();
        const notifyVia = String(payload?.notifyVia || 'email').trim().toLowerCase();
        const isStorageFee = statusKey === 'storage_fee';
        const isPickupReminder = statusKey === 'pickup_reminder';
        const isManualUpdate = statusKey === 'manual_update';
        const isWaitingDevice = statusKey === 'waiting_device';
        const isPartDelivered = statusKey === 'part_delivered';
        const estimatedDate = String(payload?.estimatedDate || '').trim();
        const techNotes = String(payload?.notes || '').trim();
        if (!statusKey || !statusLabel) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing status/label' }));
          return;
        }

        const clientName = String(enrichedRecord?.customerName || enrichedRecord?.client || 'Client').trim() || 'Client';
        const rawDevice = type === 'repair'
          ? String(enrichedRecord?.productDescription || enrichedRecord?.productCategory || enrichedRecord?.description || enrichedRecord?.device || enrichedRecord?.deviceModel || 'your device').trim()
          : String(enrichedRecord?.productDescription || enrichedRecord?.category || 'your order').trim();
        const deviceDisplay = rawDevice.length > 100 ? rawDevice.slice(0, 100) + '…' : rawDevice;
        const orderId = type === 'repair' ? `WO-${id}` : `INV-${id}`;

        // Persist status update to record
        const repairStatusMap: Record<string, string> = {
          diagnosis:       'Diagnosis In Process',
          waiting_device:  'Waiting for Device Drop-off',
          part_ordered:    'Part Ordered',
          waiting_part:    'Waiting on Part Delivery',
          part_delivered:  'Part Delivered – Repairs Starting',
          repair_complete: 'Repair Complete',
          not_possible:    'Repair Not Possible',
          storage_fee:     'Storage Fee Notice',
        };
        const saleStatusMap: Record<string, string> = {
          product_ordered: 'Product Ordered',
          product_in_shop: 'Product In Shop',
          storage_fee:     'Storage Fee Notice',
        };
        try {
          const updates: any = {
            statusUpdate:    statusLabel,
            statusUpdatedAt: new Date().toISOString(),
          };
          if (estimatedDate) updates.estimatedDate = estimatedDate;
          if (techNotes) updates.techNotes = techNotes;
          if (isManualUpdate) {
            // Don't overwrite the order status; just record the note
            delete updates.statusUpdate;
            updates.lastUpdateNote = techNotes;
            updates.lastUpdateAt = new Date().toISOString();
          } else if (type === 'repair' && repairStatusMap[statusKey]) {
            updates.repairStatus = repairStatusMap[statusKey];
          } else if (type === 'sale' && saleStatusMap[statusKey]) {
            updates.status = saleStatusMap[statusKey];
          }
          const freshDb2 = readDb();
          const col: any[] = Array.isArray(freshDb2[collection]) ? freshDb2[collection] : [];
          const idx = col.findIndex((r: any) => Number(r?.id || 0) === id);
          if (idx >= 0) {
            col[idx] = { ...col[idx], ...updates };
            freshDb2[collection] = col;
            writeDb(freshDb2);
            scheduleCollectionChanged(collection);
          }
        } catch { /* non-fatal */ }

        // Send notification — email or SMS depending on tech's selection
        let notifyResult: any = { ok: false, error: 'No contact info on file for this client.' };

        if (notifyVia === 'sms') {
          // SMS: use email-to-SMS gateway based on stored carrier, or fall back to a
          // plain-text email-to-SMS address if the customer's phone is on file.
          const clientPhone = String(enrichedRecord?.customerPhone || enrichedRecord?.phone || '').replace(/\D/g, '');
          if (!clientPhone || clientPhone.length < 10) {
            notifyResult = { ok: false, error: 'No phone number on file for this client.' };
          } else {
            // Try sending a short SMS via email-to-SMS gateways for the major US carriers.
            // The message is sent to all common gateways; carriers silently discard non-matching ones.
            const smsText = isStorageFee
            ? `GadgetBoy: ${orderId} STORAGE FEE NOTICE — Your ${type === 'repair' ? 'device' : 'order'} is ready for pickup. Items uncollected after 7 days are subject to a $25/day storage fee. Call (803) 708-0101.`
            : isPickupReminder
            ? `GadgetBoy: ${orderId} - Pickup Reminder! Your ${type === 'repair' ? 'device' : 'order'} is ready for pickup. Stop by at 2822 Devine St or call (803) 708-0101.`
            : isManualUpdate
            ? `GadgetBoy: ${orderId} - ${techNotes || 'Update from your technician'}. Questions? Call (803) 708-0101.`
            : isWaitingDevice
            ? `GadgetBoy: ${orderId} - We're ready to begin repairs but still need you to drop off your device. Stop by 2822 Devine St or call (803) 708-0101.`
            : isPartDelivered
            ? `GadgetBoy: ${orderId} - Great news! Your part has arrived and we're starting repairs now. Questions? Call (803) 708-0101.`
            : `GadgetBoy: ${orderId} - ${statusLabel}. Questions? Call (803) 708-0101.`;
            const gateways = [
              `${clientPhone}@vtext.com`,       // Verizon
              `${clientPhone}@tmomail.net`,      // T-Mobile
              `${clientPhone}@txt.att.net`,      // AT&T
              `${clientPhone}@messaging.sprintpcs.com`, // Sprint/T-Mobile
            ];
            // Send to first gateway as primary; others as BCC handled by email provider
            notifyResult = await sendConfiguredEmail({
              to: gateways[0],
              bcc: gateways.slice(1).join(','),
              subject: '',
              text: smsText,
              html: `<p>${escHtml(smsText)}</p>`,
            });
            if (notifyResult.ok) notifyResult.message = `SMS sent to ${clientPhone.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}.`;
          }
        } else {
          // Email (default)
          let customerEmail = String(enrichedRecord?.customerEmail || enrichedRecord?.email || '').trim();
          const customerId2 = Number(enrichedRecord?.customerId || 0);
          if (!customerEmail && customerId2 > 0) {
            const freshDb3 = readDb();
            const customers3: any[] = Array.isArray(freshDb3['customers']) ? freshDb3['customers'] : [];
            const cust3 = customers3.find((c: any) => Number(c?.id || 0) === customerId2);
            if (cust3) customerEmail = String(cust3?.email || '').trim();
          }
          if (!customerEmail) {
            notifyResult = { ok: false, error: 'No email on file for this client.' };
          } else {
            // Embed logo via CID inline attachment — works in Gmail, Outlook, Apple Mail
            let logoImgHtml = '<div style="font-size:20px;font-weight:900;color:#39FF14;letter-spacing:-.5px;">GADGETBOY</div>';
            let logoAttachment: any = null;
            try {
              const logoPath = isDev
                ? path.join(app.getAppPath(), 'public', 'logo.png')
                : path.join(app.getAppPath(), 'dist', 'logo.png');
              if (fs.existsSync(logoPath)) {
                logoAttachment = { filename: 'logo.png', path: logoPath, cid: 'logo@gadgetboy' };
                logoImgHtml = `<img src="cid:logo@gadgetboy" alt="GadgetBoy" style="height:44px;width:auto;display:block;">`;
              }
            } catch { /* use text fallback */ }

            const friendlyTitle = isStorageFee
              ? `⚠️ Action Required — Please Arrange Pickup`
              : isPickupReminder
              ? `Your ${type === 'repair' ? 'device' : 'order'} is ready for pickup!`
              : isManualUpdate
              ? `A message from your GadgetBoy technician`
              : isWaitingDevice
              ? `We're ready — please drop off your device`
              : isPartDelivered
              ? `Great news! Your part has arrived`
              : `Here's an update on your ${type === 'repair' ? 'repair' : 'order'}`;
            const emailSubject = isStorageFee
              ? `⚠️ Storage Fee Notice — Please Arrange Pickup`
              : isPickupReminder
              ? `Reminder: Your ${type === 'repair' ? 'device' : 'order'} is ready for pickup – GadgetBoy`
              : isManualUpdate
              ? `Update from GadgetBoy — ${orderId}`
              : isWaitingDevice
              ? `Action Needed: Please Drop Off Your Device — ${orderId}`
              : isPartDelivered
              ? `Your Part Has Arrived — Repairs Starting Soon (${orderId})`
              : `Here's an update on your ${type === 'repair' ? 'repair' : 'order'}`;

            // Build extra info blocks for delivery date / tech notes
            let extraInfoHtml = '';
            let extraInfoText = '';
            if (estimatedDate) {
              const dateLabel = statusKey === 'waiting_part' ? 'Estimated Arrival Date' : 'Estimated Delivery Date';
              let formattedDate = estimatedDate;
              try { formattedDate = new Date(estimatedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); } catch {}
              extraInfoHtml += `<div style="background:#fef9c3;border:1.5px solid #facc15;border-radius:10px;padding:14px 18px;margin-bottom:20px;"><div style="font-size:11px;color:#854d0e;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">${escHtml(dateLabel)}</div><div style="font-size:17px;font-weight:700;color:#713f12;">${escHtml(formattedDate)}</div></div>`;
              extraInfoText += `\n${dateLabel}: ${formattedDate}`;
            }
            if (techNotes) {
              extraInfoHtml += `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;margin-bottom:20px;"><div style="font-size:11px;color:#475569;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Technician Notes</div><div style="font-size:14px;color:#1e293b;line-height:1.6;">${escHtml(techNotes)}</div></div>`;
              extraInfoText += `\n\nTechnician Notes: ${techNotes}`;
            }

            const manualUpdateEmailHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:#18181b;padding:20px 24px;border-bottom:3px solid #8b5cf6;display:flex;align-items:center;gap:14px;">
    ${logoImgHtml}
    <div>
      <div style="font-size:15px;font-weight:900;color:#f4f4f5;letter-spacing:-.3px;line-height:1.2;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#a1a1aa;margin-top:3px;line-height:1.7;">2822 Devine Street, Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
  <div style="padding:24px;">
    <h2 style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 16px;">${escHtml(friendlyTitle)}</h2>
    <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${escHtml(clientName)}</strong>, your technician has sent you a message regarding your <strong>${escHtml(deviceDisplay)}</strong> (${escHtml(orderId)}).</p>
    <div style="background:#f5f3ff;border:1.5px solid #8b5cf6;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:12px;color:#6d28d9;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Message from your technician</div>
      <div style="font-size:15px;color:#1e1b4b;line-height:1.7;white-space:pre-wrap;">${escHtml(techNotes || '(No message provided)')}</div>
    </div>
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 20px;">
      Questions? Call us at <strong>(803) 708-0101</strong> or reply to this email.
    </p>
    <div style="border-top:1px solid #e5e7eb;padding-top:18px;margin-top:4px;">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:3px;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#9ca3af;line-height:1.8;">2822 Devine Street &nbsp;&middot;&nbsp; Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
</div>
</body></html>`;
            const waitingDeviceEmailHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:#18181b;padding:20px 24px;border-bottom:3px solid #2563eb;display:flex;align-items:center;gap:14px;">
    ${logoImgHtml}
    <div>
      <div style="font-size:15px;font-weight:900;color:#f4f4f5;letter-spacing:-.3px;line-height:1.2;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#a1a1aa;margin-top:3px;line-height:1.7;">2822 Devine Street, Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
  <div style="padding:24px;">
    <h2 style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 16px;">${escHtml(friendlyTitle)}</h2>
    <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${escHtml(clientName)}</strong>, we're all set to begin work on your <strong>${escHtml(deviceDisplay)}</strong> (${escHtml(orderId)}) — we just need you to drop it off!</p>
    <div style="background:#eff6ff;border:1.5px solid #2563eb;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:12px;color:#1d4ed8;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Action Required</div>
      <div style="font-size:15px;font-weight:700;color:#1e3a8a;">Please drop off your device at our shop</div>
      <div style="font-size:13px;color:#1e40af;margin-top:4px;">2822 Devine Street, Columbia, SC 29205</div>
    </div>
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 20px;">
      Our hours are Mon–Sat 10am–7pm. Have questions? Call us at <strong>(803) 708-0101</strong> or reply to this email.
    </p>
    <div style="border-top:1px solid #e5e7eb;padding-top:18px;margin-top:4px;">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:3px;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#9ca3af;line-height:1.8;">2822 Devine Street &nbsp;&middot;&nbsp; Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
</div>
</body></html>`;
            const partDeliveredEmailHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:#18181b;padding:20px 24px;border-bottom:3px solid #16a34a;display:flex;align-items:center;gap:14px;">
    ${logoImgHtml}
    <div>
      <div style="font-size:15px;font-weight:900;color:#f4f4f5;letter-spacing:-.3px;line-height:1.2;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#a1a1aa;margin-top:3px;line-height:1.7;">2822 Devine Street, Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
  <div style="padding:24px;">
    <h2 style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 16px;">${escHtml(friendlyTitle)}</h2>
    <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${escHtml(clientName)}</strong>, great news! The part for your <strong>${escHtml(deviceDisplay)}</strong> (${escHtml(orderId)}) has been delivered to our shop.</p>
    <div style="background:#f0fdf4;border:1.5px solid #16a34a;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:12px;color:#15803d;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Status Update</div>
      <div style="font-size:20px;font-weight:800;color:#166534;">🎉 Part Delivered — Repairs Starting</div>
    </div>
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 20px;">
      We're starting work on your device right away. We'll send another update as soon as the repair is complete. Questions? Call us at <strong>(803) 708-0101</strong>.
    </p>
    <div style="border-top:1px solid #e5e7eb;padding-top:18px;margin-top:4px;">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:3px;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#9ca3af;line-height:1.8;">2822 Devine Street &nbsp;&middot;&nbsp; Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
</div>
</body></html>`;
            const emailHtml = isManualUpdate ? manualUpdateEmailHtml : isWaitingDevice ? waitingDeviceEmailHtml : isPartDelivered ? partDeliveredEmailHtml : isStorageFee ? `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:#18181b;padding:20px 24px;border-bottom:3px solid #ef4444;display:flex;align-items:center;gap:14px;">
    ${logoImgHtml}
    <div>
      <div style="font-size:15px;font-weight:900;color:#fef2f2;letter-spacing:-.3px;line-height:1.2;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#a1a1aa;margin-top:3px;line-height:1.7;">2822 Devine Street, Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
  <div style="padding:24px;">
    <h2 style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 16px;">${escHtml(friendlyTitle)}</h2>
    <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${escHtml(clientName)}</strong>, your <strong>${escHtml(deviceDisplay)}</strong> is ready for pickup.</p>
    <div style="background:#fef2f2;border:1.5px solid #ef4444;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:12px;color:#b91c1c;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Storage Fee Policy</div>
      <div style="font-size:15px;font-weight:700;color:#7f1d1d;margin-bottom:8px;">$25 / day after 7-day grace period</div>
      <div style="font-size:13px;color:#374151;line-height:1.6;">Per our signed policy, items not collected within <strong>7 days</strong> of completion or arrival are subject to a <strong>$25/day storage fee</strong>. Devices left unclaimed for <strong>45 days</strong> become the property of GADGETBOY LLC.</div>
    </div>
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 20px;">
      Please arrange pickup as soon as possible. Call us at <strong>(803) 708-0101</strong> or reply to this email.
    </p>
    <div style="border-top:1px solid #e5e7eb;padding-top:18px;margin-top:4px;">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:3px;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#9ca3af;line-height:1.8;">2822 Devine Street &nbsp;&middot;&nbsp; Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
</div>
</body></html>` : isPickupReminder ? `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:#18181b;padding:20px 24px;border-bottom:3px solid #06b6d4;display:flex;align-items:center;gap:14px;">
    ${logoImgHtml}
    <div>
      <div style="font-size:15px;font-weight:900;color:#f4f4f5;letter-spacing:-.3px;line-height:1.2;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#a1a1aa;margin-top:3px;line-height:1.7;">2822 Devine Street, Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
  <div style="padding:24px;">
    <h2 style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 16px;">${escHtml(friendlyTitle)}</h2>
    <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${escHtml(clientName)}</strong>, just a friendly reminder that your <strong>${escHtml(deviceDisplay)}</strong> is ready and waiting for you!</p>
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 20px;">If you have any questions or need to reach us, give us a call or simply reply to this email. We look forward to seeing you!</p>
    <div style="border-top:1px solid #e5e7eb;padding-top:18px;margin-top:4px;">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:3px;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#9ca3af;line-height:1.8;">2822 Devine Street &nbsp;&middot;&nbsp; Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
</div>
</body></html>` : `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:#18181b;padding:20px 24px;border-bottom:3px solid #39FF14;display:flex;align-items:center;gap:14px;">
    ${logoImgHtml}
    <div>
      <div style="font-size:15px;font-weight:900;color:#f4f4f5;letter-spacing:-.3px;line-height:1.2;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#a1a1aa;margin-top:3px;line-height:1.7;">2822 Devine Street, Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
  <div style="padding:24px;">
    <h2 style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 16px;">${escHtml(friendlyTitle)}</h2>
    <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${escHtml(clientName)}</strong>, here's the latest on <strong>${escHtml(deviceDisplay)}</strong>:</p>
    <div style="background:#f0fdf4;border:1.5px solid #22c55e;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:12px;color:#15803d;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Current Status</div>
      <div style="font-size:20px;font-weight:800;color:#166534;">${escHtml(statusLabel)}</div>
    </div>
    ${extraInfoHtml}
    <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0 0 20px;">
      Questions? Call us at <strong>(803) 708-0101</strong> or reply to this email.
    </p>
    <div style="border-top:1px solid #e5e7eb;padding-top:18px;margin-top:4px;">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:3px;">GADGETBOY Repair &amp; Retail</div>
      <div style="font-size:11px;color:#9ca3af;line-height:1.8;">2822 Devine Street &nbsp;&middot;&nbsp; Columbia, SC 29205<br>(803) 708-0101 &nbsp;&middot;&nbsp; gadgetboysc@gmail.com</div>
    </div>
  </div>
</div>
</body></html>`;
            notifyResult = await sendConfiguredEmail({
              to: customerEmail,
              subject: emailSubject,
              text: isStorageFee
                ? `Hi ${clientName},\n\nYour ${type === 'repair' ? 'device' : 'order'} (${deviceDisplay}) is ready for pickup.\n\nIMPORTANT: Per our signed policy, items not collected within 7 days of completion are subject to a $25/day storage fee. Devices unclaimed after 45 days become property of GADGETBOY LLC.\n\nPlease arrange pickup as soon as possible.\nCall (803) 708-0101 or reply to this email.\n\nGadgetBoy Repair & Retail\n2822 Devine Street, Columbia, SC 29205`
                : isPickupReminder
                ? `Hi ${clientName},\n\nJust a friendly reminder that your ${type === 'repair' ? 'device' : 'order'} (${deviceDisplay}) is ready for pickup!\n\nGadgetBoy Repair & Retail\n2822 Devine Street, Columbia, SC 29205\n(803) 708-0101 · gadgetboysc@gmail.com`
                : isManualUpdate
                ? `Hi ${clientName},\n\nA message from your GadgetBoy technician regarding your ${type === 'repair' ? 'repair' : 'order'} (${orderId}):\n\n${techNotes || '(No message provided)'}\n\nQuestions? Call (803) 708-0101 or reply to this email.\n\nGadgetBoy Repair & Retail\n2822 Devine Street, Columbia, SC 29205`
                : isWaitingDevice
                ? `Hi ${clientName},\n\nWe're ready to begin work on your ${deviceDisplay} (${orderId}) — we just need you to drop it off!\n\nPlease stop by 2822 Devine Street, Columbia, SC 29205.\nOur hours are Mon–Sat 10am–7pm.\n\nQuestions? Call (803) 708-0101 or reply to this email.\n\nGadgetBoy Repair & Retail\n2822 Devine Street, Columbia, SC 29205`
                : isPartDelivered
                ? `Hi ${clientName},\n\nGreat news! The part for your ${deviceDisplay} (${orderId}) has arrived and we're starting repairs right away. We'll send another update as soon as the repair is complete.\n\nQuestions? Call (803) 708-0101 or reply to this email.\n\nGadgetBoy Repair & Retail\n2822 Devine Street, Columbia, SC 29205`
                : `Hi ${clientName},\n\nHere's an update on your ${type === 'repair' ? 'repair' : 'order'}: ${statusLabel}\n\n${type === 'repair' ? 'Device' : 'Item'}: ${deviceDisplay}${extraInfoText}\n\nQuestions? Call (803) 708-0101 or reply to this email.\n\nGadgetBoy Repair & Retail\n2822 Devine Street, Columbia, SC 29205`,
              html: emailHtml,
              attachments: logoAttachment ? [logoAttachment] : [],
            });
            if (notifyResult.ok) notifyResult.message = `Email sent to ${customerEmail}.`;
          }
        }

        const message = notifyResult.message || notifyResult.error || 'Status saved.';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: notifyResult.ok, message }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
      }
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
}

function startQrStatusServer() {
  if (qrHttpServer) return;
  try {
    qrHttpServer = httpMod.createServer(handleQrRequest);
    qrHttpServer.on('error', (e: any) => {
      if (e.code === 'EADDRINUSE') {
        console.warn(`[QR Server] Port ${QR_PORT} already in use — status server unavailable.`);
      } else {
        console.error('[QR Server] Error:', e);
      }
      // Clear the reference so startQrStatusServer() can retry on next call
      qrHttpServer = null;
    });
    qrHttpServer.on('close', () => {
      // Server closed unexpectedly — clear reference and schedule a restart
      if (qrHttpServer) {
        qrHttpServer = null;
        setTimeout(() => { startQrStatusServer(); }, 3000);
      }
    });
    qrHttpServer.listen(QR_PORT, '0.0.0.0', () => {
      console.log(`[QR Server] Running on port ${QR_PORT} — accessible at http://${getLanIp()}:${QR_PORT}`);
    });
  } catch (e) {
    console.error('[QR Server] Failed to start:', e);
  }
}

// IPC: generate QR code data URL for a given URL string
ipcMain.handle('qr:getDataUrl', async (_event: any, url: string) => {
  try {
    const QRCode = require('qrcode');
    const dataUrl: string = await QRCode.toDataURL(String(url || ''), {
      width: 200,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    return { ok: true, dataUrl };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// IPC: return the LAN-accessible status URL for a work order or sale
ipcMain.handle('notifications:get-native-permission', async () => ({
  permission: Notification?.isSupported?.() ? 'granted' : 'unsupported',
  platform: process.platform,
}));

ipcMain.handle('notifications:request-native-permission', async () => {
  if (!Notification?.isSupported?.()) return { permission: 'unsupported', platform: process.platform, error: 'System notifications are not supported on this computer.' };
  const notice = new Notification({ title: 'GadgetBoy POS', body: 'Notifications are enabled on this computer.', silent: false });
  notice.show();
  return { permission: 'granted', platform: process.platform };
});

ipcMain.handle('notifications:send-native', async (_event: any, payload: any) => {
  if (!Notification?.isSupported?.()) return { ok: false, error: 'System notifications are not supported on this computer.' };
  const notice = new Notification({ title: String(payload?.title || 'GadgetBoy POS'), body: String(payload?.body || ''), silent: false });
  notice.on('click', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('notifications:native-clicked', payload?.record || {});
      } else if (!_event.sender.isDestroyed()) {
        _event.sender.send('notifications:native-clicked', payload?.record || {});
      }
    } catch {}
  });
  notice.show();
  return { ok: true };
});

ipcMain.handle('notifications:open-system-settings', async () => {
  try {
    if (process.platform === 'win32') await shell.openExternal('ms-settings:notifications');
    else if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications');
    else return { ok: false, error: 'Open notification settings from your operating system settings.' };
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('qr:getStatusUrl', async (_event: any, type: string, id: any) => {
  try {
    const t = normalizeQrStatusType(type);
    const safeId = Number(id) || 0;
    if (!safeId) return { ok: false, error: 'Save the record before creating its QR code.' };
    const url = await ensureCloudQrStatusUrl(t, safeId);
    if (!url) return { ok: false, error: 'Sign in and sync the record before creating its QR code.' };
    return { ok: true, url };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('qr:resolveStatusToken', async (_event: any, token: string) => {
  try {
    return { ok: true, ...(await resolveCloudQrStatusToken(token)) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('qr:getServerInfo', async () => {
  try {
    return { ok: true, ...getQrServerInfo() };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// ─────────────────────────────────────────────────────────────────────────────

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.gadgetboy.pos');
    session.defaultSession.setPermissionCheckHandler((_webContents: any, permission: string, requestingOrigin: string) => {
      return permission === 'notifications'
        || (permission === 'media' && isTrustedRendererPermissionRequest(requestingOrigin));
    });
    session.defaultSession.setPermissionRequestHandler((webContents: any, permission: string, callback: (allowed: boolean) => void, details: any) => {
      const requestedMedia = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
      const allowsMicrophone = permission === 'media' && requestedMedia.includes('audio');
      callback(permission === 'notifications' || (allowsMicrophone && isTrustedRendererPermissionRequest(webContents?.getURL?.())));
    });
    // Set a global application menu so Ctrl/Cmd+C/V and other edit shortcuts work everywhere
    setupApplicationMenu();
    ensureBatchOutScheduler();

    // Pre-initialize storage before the window opens.
    // Fast path: existing configured installs resolve instantly (read + write check).
    // First-run path: shows the data-folder chooser dialog BEFORE the window opens.
    try {
      // Optional: transient override (does NOT persist to data-location.json)
      const envRootRaw = (process.env.GBPOS_DATA_ROOT || '').toString().trim();
      if (envRootRaw) {
        const envRoot = path.resolve(envRootRaw);
        const writeCheck = canWriteToFolder(envRoot);
        if (writeCheck.ok) setDataRootTransient(envRoot);
        else setDataRootTransient(app.getPath('userData'));
      } else {
        const existing = readDataLocationConfig();
        if (existing?.dataRoot) {
          const writeCheck = canWriteToFolder(existing.dataRoot);
          if (writeCheck.ok) {
            setDataRoot(existing.dataRoot);
          } else {
            // Configured folder no longer writable — fall back to userData silently.
            setDataRoot(app.getPath('userData'));
          }
        } else {
          // First run: no config yet — auto-select per-user AppData (no dialog).
          // Users can change via Admin > Data Tools if needed.
          setDataRoot(app.getPath('userData'));
        }
      }
    } catch {
      // If anything goes wrong, resolveDataRoot() will handle the fallback.
    }

    // Optional: seed local test data (never overwrites unless reset flag is set).
    try {
      if ((process.env.GBPOS_SEED_TEST_DATA || '').toString().trim() === '1') {
        const res = seedTestDataIfNeeded(resolveDataRoot());
        if (res?.ok && res.seeded) {
          try { console.log('[GBPOS] Seeded test DB:', res.dbPath, res.counts); } catch {}
        }
      }
    } catch (e: any) {
      try { console.warn('[GBPOS] Test seed failed:', e?.message || String(e)); } catch {}
    }

    // Optional: quick startup sync to pull newer server data (offline-first; bounded timeout).
    try {
      const cfg = readServerSyncConfig();
      if (cfg?.enabled) {
        await Promise.race([
          syncDbWithServer('auto'),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 1200)),
        ]);
      }
    } catch {
      // ignore
    }
    createWindow();
    checkForAppUpdatesSoon();
    startQrStatusServer();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// IPC stub for future
ipcMain.handle('open-work-order', async (_event: any, id: any) => {
  // Placeholder for future logic
  return { ok: true, id };
});

ipcMain.handle('open-new-workorder', async (_event: any, payload: any) => {
  const { screen } = electron;
  const primary = screen.getPrimaryDisplay();
  const bounds = primary && primary.bounds ? primary.bounds : ({ x: 0, y: 0, width: 1920, height: 1080 } as any);
  const child = new BrowserWindow({
    x: (bounds as any).x ?? 0,
    y: (bounds as any).y ?? 0,
    width: (bounds as any).width,
    height: (bounds as any).height,
    minWidth: Math.min(1200, (bounds as any).width ?? bounds.width),
    minHeight: Math.min(800, (bounds as any).height ?? bounds.height),
    useContentSize: true,
    resizable: true,
    maximizable: true,
    frame: true,
    parent: undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('New Work Order'),
  });
  showWindowFast(child, () => {
    try { child.setBounds({ x: (bounds as any).x ?? 0, y: (bounds as any).y ?? 0, width: (bounds as any).width, height: (bounds as any).height }); } catch {}
    try { child.maximize(); } catch {}
  });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  // Load renderer with query params carrying payload
  const url = isDev ? `${DEV_SERVER_URL}/?newWorkOrder=${encodeURIComponent(JSON.stringify(payload))}` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?newWorkOrder=${encodeURIComponent(JSON.stringify(payload))}`;
  child.loadURL(url);
  return { ok: true };
});

ipcMain.handle('open-game-menu', async () => {
  const child = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 620,
    minHeight: 560,
    resizable: true,
    frame: true,
    parent: undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Game Menu'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  const url = isDev ? `${DEV_SERVER_URL}/?gameMenu=1` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?gameMenu=1`;
  child.loadURL(url);
  return { ok: true };
});

ipcMain.handle('open-device-categories', async (_event: any) => {
  const child = new BrowserWindow({
    width: 900,
    height: 600,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Device Categories'),
  });
  showWindowFast(child, () => { centerWindow(child); }, { focus: false });
  if (isDev) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?deviceCategories=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?deviceCategories=true`;
  child.loadURL(url);
  return { ok: true };
});

ipcMain.handle('open-eod', async (_event: any) => {
  const child = new BrowserWindow({
    width: 1220,
    height: 820,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    center: true,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('End of Day'),
  });
  showWindowFast(child, () => {
    centerWindow(child);
    if (typeof child.center === 'function') child.center();
  });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev ? `${DEV_SERVER_URL}/?eod=true` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?eod=true`;
  child.loadURL(url);
  return { ok: true };
});

ipcMain.handle('open-repair-categories', async (_event: any, payload?: any) => {
  const parent = BrowserWindow.getAllWindows()[0] || undefined;

  // Size the window to the current display's work area so it never opens cut off.
  const { screen } = electron;
  const display = (() => {
    try {
      if (parent && !parent.isDestroyed() && screen?.getDisplayMatching) {
        return screen.getDisplayMatching(parent.getBounds());
      }
    } catch {}
    try {
      return screen?.getPrimaryDisplay?.();
    } catch {}
    return null;
  })();

  const workAreaSize = (display as any)?.workAreaSize || (display as any)?.workArea || (display as any)?.bounds || { width: 1400, height: 900 };
  const waW = Number((workAreaSize as any).width ?? 1400);
  const waH = Number((workAreaSize as any).height ?? 900);

  const width = Math.min(1400, waW, Math.max(960, Math.floor(waW * 0.95)));
  const height = Math.min(900, waH, Math.max(680, Math.floor(waH * 0.95)));

  const child = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(960, width),
    minHeight: Math.min(680, height),
    resizable: true,
    parent,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Devices / Repairs'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  if (isDev) child.webContents.openDevTools({ mode: 'detach' });
  const linkContext = payload ? `&linkContext=${encodeURIComponent(JSON.stringify(payload))}` : '';
  const url = isDev ? `${DEV_SERVER_URL}/?repairCategories=true${linkContext}` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?repairCategories=true${linkContext}`;
  child.loadURL(url);
  return { ok: true };
});

ipcMain.handle('open-repair-tutorial', async (event: any, payload: any) => {
  const rawUrl = String(payload?.normalizedUrl || '');
  if (!/^https:\/\//i.test(rawUrl)) return { ok: false, error: 'A valid HTTPS tutorial URL is required.' };
  const parent = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0] || undefined;
  const child = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 560,
    minHeight: 420,
    parent,
    modal: false,
    resizable: true,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#09090b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Repair Tutorial'),
  });
  showWindowFast(child, () => centerWindow(child));
  const query = `repairTutorial=${encodeURIComponent(rawUrl)}`;
  const url = isDev ? `${DEV_SERVER_URL}/?${query}` : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?${query}`;
  await child.loadURL(url);
  return { ok: true };
});

// IPC handler for opening the WorkOrderRepairPicker window
ipcMain.handle('open-workorder-repair-picker', async (_event: any) => {
  const child = new BrowserWindow({
    width: 1200,
    height: 960,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Add Repair to Work Order'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  if (isDev) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev
    ? `${DEV_SERVER_URL}/?workOrderRepairPicker=true`
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?workOrderRepairPicker=true`;
  child.loadURL(url);
  return { ok: true };
});

// IPC handler for promise-based sale product picker (returns selected product-like payload)
ipcMain.handle('pick-sale-product', async (event: any) => {
  return new Promise((resolve) => {
    const parentFromSender = (() => {
      try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
    })();
    const windowSize = displayAwareWindowSize(
      parentFromSender,
      { width: 1280, height: 840 },
      { width: 900, height: 620 },
    );
    const child = new BrowserWindow({
      ...windowSize,
      resizable: true,
      parent: parentFromSender || BrowserWindow.getAllWindows()[0] || undefined,
      modal: true,
      ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
      backgroundColor: '#18181b',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      },
      show: false,
      title: 'Pick Product for Sale',
    });
    showWindowFast(child, () => { centerWindow(child); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
    const url = isDev
      ? `${DEV_SERVER_URL}/?products=true&picker=sale`
      : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?products=true&picker=sale`;
    child.loadURL(url);

    const handler = (_ev: any, payload: any) => {
      resolve(payload);
      child.close();
      ipcMain.off('sale-product-selected', handler);
    };
    ipcMain.on('sale-product-selected', handler);

    child.on('closed', () => {
      ipcMain.off('sale-product-selected', handler);
      resolve(null);
    });
  });
});

// IPC handler for opening customer overview window
ipcMain.handle('open-customer-overview', async (_event: any, customerId: number) => {
  const child = new BrowserWindow({
    width: 1100,
    height: 760,
    resizable: true,
    parent: BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Customer Overview'),
  });
  showWindowFast(child);
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev
    ? `${DEV_SERVER_URL}/?customerOverview=${customerId}`
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?customerOverview=${customerId}`;
  child.loadURL(url);
  return { ok: true };
});

// IPC handler for opening a simple New Sale window
ipcMain.handle('open-new-sale', async (event: any, payload: any) => {
  const { screen } = electron;
  const primary = screen.getPrimaryDisplay();
  const bounds = primary && primary.bounds ? primary.bounds : ({ x: 0, y: 0, width: 1920, height: 1080 } as any);

  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const parentWin = parentFromSender || mainWindow || BrowserWindow.getAllWindows()[0] || undefined;

  const child = new BrowserWindow({
    x: (bounds as any).x ?? 0,
    y: (bounds as any).y ?? 0,
    width: (bounds as any).width,
    height: (bounds as any).height,
    minWidth: Math.min(1200, (bounds as any).width ?? bounds.width),
    minHeight: Math.min(800, (bounds as any).height ?? bounds.height),
    useContentSize: true,
    resizable: true,
    maximizable: true,
    frame: true,
    parent: parentWin as any,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('New Sale'),
  });
  showWindowFast(child, () => {
    try { child.setBounds({ x: (bounds as any).x ?? 0, y: (bounds as any).y ?? 0, width: (bounds as any).width, height: (bounds as any).height }); } catch {}
    try { child.maximize(); } catch {}
  });
  child.on('closed', () => {
    try {
      if (parentWin && !parentWin.isDestroyed()) {
        parentWin.show();
        parentWin.focus();
      }
    } catch {}
  });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const encoded = encodeURIComponent(JSON.stringify(payload || {}));
  const url = isDev
    ? `${DEV_SERVER_URL}/?newSale=${encoded}`
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?newSale=${encoded}`;
  child.loadURL(url);
  return { ok: true };
});

// IPC handler for opening a Quick Checkout window (no customer required)
ipcMain.handle('open-quick-sale', async (event: any) => {
  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const parentWindow = parentFromSender || mainWindow || BrowserWindow.getAllWindows()[0] || undefined;
  const windowSize = displayAwareWindowSize(
    parentWindow,
    { width: 1180, height: 840 },
    { width: 880, height: 620 },
  );
  const child = new BrowserWindow({
    ...windowSize,
    resizable: true,
    parent: parentWindow,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Quick Checkout'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const url = isDev
    ? `${DEV_SERVER_URL}/?quickSale=1&t=${Date.now()}`
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?quickSale=1`;
  child.loadURL(url).catch((e: any) => console.error('[QuickSale] loadURL failed', e));
  return { ok: true };
});

// IPC handler for opening a Consultation Booking window
ipcMain.handle('open-consultation', async (event: any, payload?: any) => {
  const parentFromSender = (() => {
    try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; }
  })();
  const child = new BrowserWindow({
    width: 1100,
    height: 900,
    minWidth: 1000,
    minHeight: 820,
    resizable: true,
    parent: parentFromSender || mainWindow || BrowserWindow.getAllWindows()[0] || undefined,
    modal: false,
    ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
    },
    show: false,
    title: windowTitle('Book Consultation'),
  });
  showWindowFast(child, () => { centerWindow(child); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
  const encoded = payload == null ? '1' : encodeURIComponent(JSON.stringify(payload));
  const url = isDev
    ? `${DEV_SERVER_URL}/?consultation=${encoded}&t=${Date.now()}`
    : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?consultation=${encoded}`;
  child.loadURL(url).catch((e: any) => console.error('[Consultation] loadURL failed', e));
  return { ok: true };
});

// Checkout window handler. Completion is acknowledged and scoped to the
// checkout renderer so a missed one-way event can never leave the button inert.
const checkoutSessions = createCheckoutSessionRegistry();
ipcMain.handle('workorder:checkout:complete', (event: any, result: any) => {
  const ok = checkoutSessions.complete(Number(event?.sender?.id), result);
  return ok ? { ok: true } : { ok: false, error: 'This checkout session is no longer active. Reopen checkout and try again.' };
});
ipcMain.handle('workorder:openCheckout', async (event: any, payload: { amountDue: number }) => {
  return new Promise(resolve => {
    const parentWin = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
    const child = new BrowserWindow({
      width: 560,
      height: 720,
      minWidth: 380,
      minHeight: 560,
      resizable: true,
      parent: parentWin as any,
      modal: true,
      ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
      backgroundColor: '#18181b',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      },
      show: false,
      title: 'Checkout',
      alwaysOnTop: false,
    });
    const checkoutWebContentsId = Number(child.webContents.id);
  showWindowFast(child, () => { centerWindow(child); });
  if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });
    const encoded = encodeURIComponent(JSON.stringify(payload));
    const url = isDev
      ? `${DEV_SERVER_URL}/?checkout=${encoded}`
      : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?checkout=${encoded}`;
    let settled = false;
    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      resolve(result);
      cleanup();
    };
    checkoutSessions.register(checkoutWebContentsId, finish);
    child.loadURL(url).catch((error: any) => {
      console.error('[Checkout] loadURL failed', error);
      checkoutSessions.cancel(checkoutWebContentsId);
    });

    const saveHandler = (_e: any, result: any) => {
      if (_e?.sender !== child.webContents) return;
      finish(result);
    };
    const cancelHandler = (_e: any) => {
      if (_e?.sender !== child.webContents) return;
      finish(null);
    };
    function cleanup() {
      ipcMain.off('workorder:checkout:save', saveHandler);
      ipcMain.off('workorder:checkout:cancel', cancelHandler);
      if (!child.isDestroyed()) child.close();
      try { (parentWin as any)?.show?.(); (parentWin as any)?.focus?.(); } catch {}
    }
    ipcMain.on('workorder:checkout:save', saveHandler);
    ipcMain.on('workorder:checkout:cancel', cancelHandler);
    child.on('closed', () => checkoutSessions.cancel(checkoutWebContentsId));
  });
});

// Custom PC Build item editor window handler
ipcMain.handle('customBuild:openItem', async (event: any, payload: any) => {
  return new Promise((resolve) => {
    const parentWin = (() => {
      try {
        return BrowserWindow.fromWebContents(event?.sender);
      } catch {
        return null;
      }
    })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;

    const child = new BrowserWindow({
      width: 620,
      height: 360,
      minWidth: 560,
      minHeight: 340,
      resizable: true,
      parent: parentWin as any,
      modal: true,
      ...(WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
      backgroundColor: '#18181b',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      },
      show: false,
      title: 'Line Item',
      alwaysOnTop: false,
    });

    showWindowFast(child, () => {
      try { centerWindow(child); } catch {}
    });
    if (isDev && OPEN_CHILD_DEVTOOLS) child.webContents.openDevTools({ mode: 'detach' });

    const encoded = encodeURIComponent(JSON.stringify(payload || {}));
    const url = isDev
      ? `${DEV_SERVER_URL}/?customBuildItem=${encoded}`
      : `file://${path.join(app.getAppPath(), 'dist', 'index.html')}?customBuildItem=${encoded}`;
    child.loadURL(url).catch((e: any) => console.error('[CustomBuildItem] loadURL failed', e));

    const saveHandler = (_e: any, result: any) => {
      resolve(result);
      cleanup();
    };
    const cancelHandler = () => {
      resolve(null);
      cleanup();
    };

    function cleanup() {
      ipcMain.off('customBuild:item:save', saveHandler);
      ipcMain.off('customBuild:item:cancel', cancelHandler);
      try {
        if (!child.isDestroyed()) child.close();
      } catch {}
      try {
        (parentWin as any)?.show?.();
        (parentWin as any)?.focus?.();
      } catch {}
    }

    ipcMain.on('customBuild:item:save', saveHandler);
    ipcMain.on('customBuild:item:cancel', cancelHandler);

    child.on('closed', () => {
      resolve(null);
      cleanup();
    });
  });
});

// ============================================
// BACKUP & RESTORE IPC HANDLERS
// ============================================

// Open Backup window

const BACKUP_CONFIG_PATH = () => path.join(resolveDataRoot(), 'backup-config.json');

type BackupConfig = { lastBackupPath?: string; lastBackupDate?: string; lastBatchOutDate?: string; lastAutoEmailDate?: string };

function readBackupConfig(): BackupConfig {
  try {
    const p = BACKUP_CONFIG_PATH();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {
    console.warn('[BACKUP] Failed to read backup config', e);
  }
  return {};
}

function writeBackupConfig(patch: BackupConfig) {
  try {
    const current = readBackupConfig();
    const next = { ...current, ...patch };
    fs.writeFileSync(BACKUP_CONFIG_PATH(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.warn('[BACKUP] Failed to write backup config', e);
  }
}

function formatStamp(ts: Date) {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
}

let batchOutTimer: NodeJS.Timeout | null = null;
let batchOutRunning = false;
let lastBatchOutDate: string | null = null;

const BACKUP_COLLECTION_KEYS = [
  'technicians',
  'timeEntries',
  'customers',
  'workOrders',
  'sales',
    'calendarNotes',
  'calendarEvents',
  'deviceCategories',
  'productCategories',
  'products',
  'partSources',
  'repairCategories',
  'repairItems',
  'intakeSources',
  'suppliers',
  'vendors',
  'invoices',
  'payments',
  'quotes',
  'settings',
  'preferences',
  'userProfiles',
  'systemLogs',
];

async function readCollectionForBackup(key: string, db: any): Promise<any[]> {
  if (shouldUseCloudDb(key)) {
    try {
      const rows = await cloudDbGet(key);
      if (Array.isArray(rows)) return rows;
    } catch (e: any) {
      try { console.warn('[BACKUP] Cloud collection fallback:', key, e?.message || e); } catch {}
    }
  }
  const localRows = db?.[key];
  return Array.isArray(localRows) ? localRows : [];
}

function isLegacyScheduleBackupEvent(e: any) {
  try {
    const t = (e?.type || e?.kind || e?.category || '').toString().toLowerCase();
    const source = String(e?.source || '').toLowerCase();
    if (t === 'schedule' && source !== 'shift-override' && source !== 'shift-request') return true;
    if (e?.legacy === true) return true;
    if (e?.derived === true) return true;
    if (typeof e?.technicianId !== 'undefined' || typeof e?.techId !== 'undefined') return true;
    if (Array.isArray(e?.tags) && e.tags.map((x: any) => String(x).toLowerCase()).includes('schedule')) return true;
  } catch {
    // ignore
  }
  return false;
}

async function buildComprehensiveBackupPayload() {
  const db = readDb();
  const collections: Record<string, any[]> = {};
  let totalRecords = 0;
  for (const key of BACKUP_COLLECTION_KEYS) {
    let rows = await readCollectionForBackup(key, db);
    if (key === 'calendarEvents') {
      rows = rows.filter((event: any) => !isLegacyScheduleBackupEvent(event));
    }
    collections[key] = rows;
    totalRecords += rows.length;
  }
  return {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    source: shouldUseCloudDb('customers') ? 'Supabase Cloud' : 'Local Database',
    dataComplete: true,
    scanTimestamp: new Date().toLocaleString(),
    collections,
    metadata: {
      totalRecords,
      collectionCount: Object.keys(collections).length,
      backupType: 'comprehensive',
      note: 'Contains all data currently accessible by the application',
    },
  };
}

async function writeComprehensiveBackupToRoot(targetRoot: string, label: string): Promise<string> {
  const payload = await buildComprehensiveBackupPayload();
  const backupsDir = path.join(targetRoot, 'backups');
  ensureDir(backupsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = String(label || 'local-backup').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'local-backup';
  const backupPath = path.join(backupsDir, `gbpos-${safeLabel}-${stamp}.json`);
  await writeJsonAtomic(backupPath, payload);
  return backupPath;
}

async function runBatchOutBackup(label: string = 'batchout') {
  if (batchOutRunning) return { ok: false, error: 'Batch out already running' };
  batchOutRunning = true;
  try {
    const localBackupPath = await writeComprehensiveBackupToRoot(resolveDataRoot(), label);
    const backupPath = localBackupPath;
    const iso = new Date().toISOString();
    writeBackupConfig({ lastBackupPath: backupPath, lastBackupDate: iso, lastBatchOutDate: iso });
    lastBatchOutDate = iso.slice(0, 10);
    console.log('[LOCAL-BACKUP] Backup written to', backupPath);
    return { ok: true, backupPath, localBackupPath };
  } catch (e: any) {
    console.error('[LOCAL-BACKUP] Failed to write backup', e);
    return { ok: false, error: e?.message || String(e) };
  } finally {
    batchOutRunning = false;
  }
}

function parseHhMm(str?: string): { h: number; m: number } {
  const safe = (str || '').trim();
  const parts = safe.split(':');
  const h = Math.min(23, Math.max(0, Number(parts[0] || 0)));
  const m = Math.min(59, Math.max(0, Number(parts[1] || 0)));
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
}

function scheduleAllowsToday(schedule: string | undefined, date: Date) {
  const mode = String(schedule || 'daily').trim().toLowerCase();
  if (mode === 'manual') return false;
  if (mode === 'weekly') return date.getDay() === 0;
  // Monthly emails run at the very start of the 1st (covering the previous month).
  if (mode === 'monthly') return date.getDate() === 1;
  return true;
}

function scheduledReportRange(schedule: string | undefined, targetDate: Date) {
  const mode = String(schedule || 'daily').trim().toLowerCase();
  const endOfPrevDay = (d: Date) => {
    const end = new Date(d);
    end.setHours(0, 0, 0, 0);
    end.setMilliseconds(-1);
    return end;
  };

  if (mode === 'weekly') {
    const end = endOfPrevDay(targetDate);
    const start = new Date(end);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return { mode: 'weekly' as const, start, end };
  }

  if (mode === 'monthly') {
    const end = endOfPrevDay(targetDate);
    const start = new Date(end);
    start.setHours(0, 0, 0, 0);
    start.setDate(1);
    return { mode: 'monthly' as const, start, end };
  }

  const start = new Date(targetDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(targetDate);
  end.setHours(23, 59, 59, 999);
  return { mode: 'daily' as const, start, end };
}

function reportParseDateValue(value: any): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const normalized = value > 1e12 ? value : value * 1000;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function reportReadNumber(record: any, key: string): number | undefined {
  const raw = record?.[key];
  if (raw === null || raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function reportRound2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function reportResolveTotals(record: any) {
  const total = reportReadNumber(record, 'total')
    ?? reportReadNumber(record, 'grandTotal')
    ?? reportReadNumber(record, 'invoiceTotal')
    ?? reportReadNumber(record, 'amountDue')
    ?? reportReadNumber(record, 'totalDue')
    ?? reportReadNumber(record, 'balanceDue')
    ?? Number(record?.totals?.total || 0)
    ?? 0;
  const paid = reportReadNumber(record, 'amountPaid')
    ?? reportReadNumber(record, 'paid')
    ?? reportReadNumber(record, 'totalPaid')
    ?? Number(record?.totals?.paid || 0)
    ?? 0;
  const remaining = reportReadNumber(record, 'remaining')
    ?? reportReadNumber(record, 'balance')
    ?? reportReadNumber(record, 'amountDue')
    ?? Number(record?.totals?.remaining || 0)
    ?? Math.max(0, total - paid);
  return {
    total: reportRound2(Number(total || 0)),
    paid: reportRound2(Number(paid || 0)),
    remaining: reportRound2(Number(remaining || 0)),
  };
}

function reportPaymentEventDate(payment: any): Date | null {
  return reportParseDateValue(payment?.at ?? payment?.date ?? payment?.createdAt ?? payment?.timestamp ?? null);
}

function reportPaymentAppliedAmount(payment: any) {
  const applied = Number(payment?.applied);
  if (Number.isFinite(applied) && applied > 0) return applied;
  const amount = Number(payment?.amount ?? payment?.tender ?? payment?.paid ?? 0);
  const change = Number(payment?.change ?? payment?.changeDue ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (Number.isFinite(change) && change > 0) return Math.max(0, amount - change);
  return amount;
}

function reportPaymentFallbackDate(record: any): Date | null {
  const keys = [
    'checkoutDate',
    'clientPickupDate',
    'repairCompletionDate',
    'completedAt',
    'completedDate',
    'closedAt',
    'closedDate',
    'invoiceDate',
    'invoice_date',
    'saleDate',
    'sale_date',
    'transactionDate',
    'transaction_date',
    'checkInAt',
    'createdAt',
    'createdDate',
  ];
  for (const key of keys) {
    const date = reportParseDateValue(record?.[key]);
    if (date) return date;
  }
  return null;
}

function reportCollectPayments(record: any) {
  const existing = Array.isArray(record?.payments)
    ? [...record.payments]
    : Array.isArray(record?.paymentHistory)
      ? [...record.paymentHistory]
      : Array.isArray(record?.paymentLogs)
        ? [...record.paymentLogs]
        : [];
  const totals = reportResolveTotals(record);
  const recorded = reportRound2(existing.reduce((sum: number, payment: any) => sum + reportPaymentAppliedAmount(payment), 0));
  const missing = reportRound2((Number(totals.paid || 0) || 0) - recorded);
  if (missing <= 0.009) return existing;
  const anchor = reportPaymentFallbackDate(record);
  if (!anchor) return existing;
  return [{
    amount: missing,
    applied: missing,
    paymentType: String(record?.paymentType || 'Legacy'),
    at: anchor.toISOString(),
    inferred: true,
  }, ...existing];
}

function reportDateWithin(date: Date | null, startMs: number, endMs: number) {
  if (!date) return false;
  const time = date.getTime();
  return time >= startMs && time <= endMs;
}

function reportGetTimelineDate(record: any): Date | null {
  const paymentDates = reportCollectPayments(record)
    .map((payment: any) => reportPaymentEventDate(payment))
    .filter(Boolean) as Date[];
  if (paymentDates.length) {
    paymentDates.sort((a, b) => b.getTime() - a.getTime());
    return paymentDates[0];
  }
  const keys = ['checkoutDate', 'repairCompletionDate', 'clientPickupDate', 'checkInAt', 'createdAt'];
  for (const key of keys) {
    const date = reportParseDateValue(record?.[key]);
    if (date) return date;
  }
  return reportPaymentFallbackDate(record);
}

function reportGetSaleDate(record: any): Date | null {
  const keys = ['checkoutDate', 'invoiceDate', 'saleDate', 'transactionDate', 'checkInAt', 'createdAt'];
  for (const key of keys) {
    const date = reportParseDateValue(record?.[key]);
    if (date) return date;
  }
  return reportPaymentFallbackDate(record) || reportGetTimelineDate(record);
}

function reportCollectedAmountInRange(record: any, startMs: number, endMs: number, fallbackDate?: Date | null) {
  const payments = reportCollectPayments(record);
  if (payments.length) {
    return reportRound2(payments.reduce((sum: number, payment: any) => {
      const date = reportPaymentEventDate(payment);
      if (!reportDateWithin(date, startMs, endMs)) return sum;
      return sum + reportPaymentAppliedAmount(payment);
    }, 0));
  }
  const date = reportPaymentFallbackDate(record);
  if (!reportDateWithin(date, startMs, endMs)) return 0;
  const totals = reportResolveTotals(record);
  return reportRound2(Math.max(0, Number(totals.paid || 0) || Number(totals.total || 0) || 0));
}

function buildScheduledEodEmailPayload(targetDate: Date) {
  const db = readDb();
  const settings = (db as any)?.eodSettings && Array.isArray((db as any).eodSettings) ? (db as any).eodSettings[0] : null;
  if (!settings) return null;

  const scheduleMode = String(settings?.schedule || 'daily').trim().toLowerCase();

  const includePayments = settings?.includePayments !== false;
  const includeCounts = settings?.includeCounts !== false;
  const includeBatchInfo = settings?.includeBatchInfo !== false;
  const includeWorkOrders = settings?.includeWorkOrders !== false;
  const includeSales = settings?.includeSales !== false;
  const includeOutstanding = settings?.includeOutstanding !== false;
  // Back-compat: older configs didn't have this flag and always included tech lines.
  const includeTechnicianSummary = settings?.emailIncludeTechnicianSummary !== false;

  const recipients = String(settings?.recipients || '').split(/[;,]/).map((value: string) => value.trim()).filter(Boolean);
  if (!recipients.length) return null;

  const { start, end, mode } = scheduledReportRange(scheduleMode, targetDate);
  const startMs = start.getTime();
  const endMs = end.getTime();

  const technicians = Array.isArray((db as any)?.technicians) ? (db as any).technicians : [];
  const aliasMap = new Map<string, string>();
  const labelMap = new Map<string, string>();
  const normalizeTech = (value: any) => String(value == null ? '' : value).trim().toLowerCase();
  for (const technician of technicians) {
    if (!technician || technician.active === false) continue;
    const canonicalDisplay = String(technician.nickname?.trim() || technician.firstName || technician.id || '').trim();
    const canonicalKey = normalizeTech(canonicalDisplay);
    if (!canonicalKey) continue;
    const fullName = [technician.firstName, technician.lastName].filter(Boolean).join(' ').trim();
    labelMap.set(canonicalKey, fullName || technician.nickname || canonicalDisplay);
    [canonicalDisplay, technician.id, technician.nickname, technician.firstName, fullName].filter(Boolean).forEach((alias: any) => {
      const aliasKey = normalizeTech(alias);
      if (aliasKey) aliasMap.set(aliasKey, canonicalKey);
    });
  }
  const canonicalizeTech = (value: any) => {
    const key = normalizeTech(value);
    if (!key) return '';
    return aliasMap.get(key) || key;
  };

  const technicianMap = new Map<string, { workOrders: number; sales: number; checkedOut: number; partialPaid: number; billed: number; collected: number; remaining: number }>();
  const paymentSummary = { cash: 0, card: 0, other: 0, change: 0 };
  const totals = { workOrders: 0, sales: 0, checkedOut: 0, partialPaid: 0, billed: 0, collected: 0, remaining: 0 };

  const ingestRecord = (kind: 'work' | 'sale', record: any) => {
    const date = kind === 'sale' ? reportGetSaleDate(record) : reportGetTimelineDate(record);
    if (!reportDateWithin(date, startMs, endMs)) return;
    const totalsForRecord = reportResolveTotals(record);
    const collected = reportCollectedAmountInRange(record, startMs, endMs, date);
    const status = String(record?.status || '').trim().toLowerCase();
    const checkedOut = !!record?.checkoutDate || status === 'closed';
    const partialPaid = Number(totalsForRecord.paid || 0) > 0.01 && Number(totalsForRecord.remaining || 0) > 0.01;
    const tech = canonicalizeTech(record?.assignedTo);

    if (kind === 'work') totals.workOrders += 1;
    else totals.sales += 1;
    if (checkedOut) totals.checkedOut += 1;
    if (partialPaid) totals.partialPaid += 1;
    totals.billed += Number(totalsForRecord.total || 0) || 0;
    totals.collected += collected;
    totals.remaining += Number(totalsForRecord.remaining || 0) || 0;

    const payments = reportCollectPayments(record);
    if (payments.length) {
      for (const payment of payments) {
        const paymentDate = reportPaymentEventDate(payment);
        if (!reportDateWithin(paymentDate, startMs, endMs)) continue;
        const amount = Number(payment?.amount ?? payment?.tender ?? payment?.paid ?? 0);
        const change = Number(payment?.change ?? payment?.changeDue ?? 0);
        const type = String(payment?.paymentType || payment?.method || '').toLowerCase();
        if (type.includes('cash')) {
          paymentSummary.cash += Number.isFinite(amount) ? amount : 0;
          paymentSummary.change += Number.isFinite(change) && change > 0 ? change : 0;
        } else if (type.includes('card') || type.includes('credit') || type.includes('debit')) {
          paymentSummary.card += Number.isFinite(amount) ? amount : 0;
        } else if (Number.isFinite(amount)) {
          paymentSummary.other += amount;
        }
      }
    } else if (collected > 0) {
      paymentSummary.other += collected;
    }

    if (!tech) return;
    const prev = technicianMap.get(tech) || { workOrders: 0, sales: 0, checkedOut: 0, partialPaid: 0, billed: 0, collected: 0, remaining: 0 };
    if (kind === 'work') prev.workOrders += 1;
    else prev.sales += 1;
    if (checkedOut) prev.checkedOut += 1;
    if (partialPaid) prev.partialPaid += 1;
    prev.billed += Number(totalsForRecord.total || 0) || 0;
    prev.collected += collected;
    prev.remaining += Number(totalsForRecord.remaining || 0) || 0;
    technicianMap.set(tech, prev);
  };

  (Array.isArray((db as any)?.workOrders) ? (db as any).workOrders : []).forEach((record: any) => ingestRecord('work', record));
  (Array.isArray((db as any)?.sales) ? (db as any).sales : []).forEach((record: any) => ingestRecord('sale', record));

  const techLines = Array.from(technicianMap.entries())
    .map(([tech, value]) => ({
      tech,
      label: labelMap.get(tech) || tech,
      ...value,
      billed: reportRound2(value.billed),
      collected: reportRound2(value.collected),
      remaining: reportRound2(value.remaining),
    }))
    .sort((a, b) => b.collected - a.collected);

  const dateLabel = mode === 'daily'
    ? start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : mode === 'weekly'
      ? `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} - ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
      : start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const sentLabel = targetDate.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const formatCurrency = (amount: number) => amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const escapeHtml = (value: any) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Scheduled emails no longer support an intro/note block.
  const intro = '';

  const billed = formatCurrency(reportRound2(totals.billed));
  const collected = formatCurrency(reportRound2(totals.collected));
  const remaining = formatCurrency(reportRound2(totals.remaining));

  const cash = formatCurrency(reportRound2(paymentSummary.cash));
  const card = formatCurrency(reportRound2(paymentSummary.card));
  const other = formatCurrency(reportRound2(paymentSummary.other));
  const change = formatCurrency(reportRound2(paymentSummary.change));

  const title = mode === 'daily' ? 'Daily batch report'
    : mode === 'weekly' ? 'Weekly batch report'
      : 'Monthly batch report';

  const bodyTextLines: string[] = [];
  bodyTextLines.push(`${title} for ${dateLabel}`);
  if (includeBatchInfo) bodyTextLines.push(`Batch Out: ${sentLabel}`);
  if (intro) bodyTextLines.push('', intro);
  bodyTextLines.push('');
  if (includeWorkOrders) bodyTextLines.push(`Work orders: ${totals.workOrders}`);
  if (includeSales) bodyTextLines.push(`Sales: ${totals.sales}`);
  if (includeCounts) {
    bodyTextLines.push(`Checked out: ${totals.checkedOut}`);
    bodyTextLines.push(`Partial paid: ${totals.partialPaid}`);
  }
  bodyTextLines.push(`Billed: ${billed}`);
  bodyTextLines.push(`Collected: ${collected}`);
  if (includeOutstanding) bodyTextLines.push(`Remaining: ${remaining}`);
  if (includePayments) {
    bodyTextLines.push(`Cash: ${cash}`);
    bodyTextLines.push(`Card: ${card}`);
    bodyTextLines.push(`Other: ${other}`);
    bodyTextLines.push(`Change: ${change}`);
  }
  if (includeTechnicianSummary && techLines.length) {
    bodyTextLines.push('', 'Technician breakdown:');
    for (const line of techLines) {
      bodyTextLines.push(`${line.label}: WO ${line.workOrders} | Sales ${line.sales} | Checked out ${line.checkedOut} | Partial ${line.partialPaid} | Collected ${formatCurrency(line.collected)} | Remaining ${formatCurrency(line.remaining)}`);
    }
  }
  const bodyText = bodyTextLines.filter((v) => v !== undefined && v !== null).join('\n');

  const html = `
<div style="font-family:Arial,sans-serif;background:#0b0b0c;color:#f4f4f5;padding:14px;">
  <div style="max-width:720px;margin:0 auto;border:1px solid #27272a;border-radius:12px;overflow:hidden;">
    <div style="padding:14px 16px;background:#111113;border-bottom:1px solid #27272a;">
      <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#a1a1aa;">${escapeHtml(title)}</div>
      <div style="margin-top:6px;font-size:18px;font-weight:700;color:#39FF14;">${escapeHtml(dateLabel)}</div>
      ${includeBatchInfo ? `<div style="margin-top:2px;font-size:12px;color:#a1a1aa;">Batch Out: ${escapeHtml(sentLabel)}</div>` : ''}
    </div>
    ${intro ? `<div style="padding:12px 16px;border-bottom:1px solid #27272a;white-space:pre-wrap;color:#e4e4e7;">${escapeHtml(intro)}</div>` : ''}
    <div style="padding:14px 16px;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tbody>
          ${includeWorkOrders ? `<tr><td style="padding:8px 0;color:#a1a1aa;">Work orders</td><td style="padding:8px 0;text-align:right;">${totals.workOrders}</td></tr>` : ''}
          ${includeSales ? `<tr><td style="padding:8px 0;color:#a1a1aa;">Sales</td><td style="padding:8px 0;text-align:right;">${totals.sales}</td></tr>` : ''}
          ${includeCounts ? `<tr><td style="padding:8px 0;color:#a1a1aa;">Checked out</td><td style="padding:8px 0;text-align:right;">${totals.checkedOut}</td></tr>` : ''}
          ${includeCounts ? `<tr><td style="padding:8px 0;color:#a1a1aa;">Partial paid</td><td style="padding:8px 0;text-align:right;">${totals.partialPaid}</td></tr>` : ''}
          <tr><td style="padding:8px 0;border-top:1px solid #27272a;color:#a1a1aa;">Billed</td><td style="padding:8px 0;border-top:1px solid #27272a;text-align:right;font-weight:700;">${escapeHtml(billed)}</td></tr>
          <tr><td style="padding:8px 0;color:#a1a1aa;">Collected</td><td style="padding:8px 0;text-align:right;font-weight:700;">${escapeHtml(collected)}</td></tr>
          ${includeOutstanding ? `<tr><td style="padding:8px 0;color:#a1a1aa;">Remaining</td><td style="padding:8px 0;text-align:right;font-weight:700;">${escapeHtml(remaining)}</td></tr>` : ''}
        </tbody>
      </table>

      ${includePayments ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid #27272a;">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a1a1aa;margin-bottom:8px;">Payments</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tbody>
            <tr><td style="padding:6px 0;color:#a1a1aa;">Cash</td><td style="padding:6px 0;text-align:right;">${escapeHtml(cash)}</td></tr>
            <tr><td style="padding:6px 0;color:#a1a1aa;">Card</td><td style="padding:6px 0;text-align:right;">${escapeHtml(card)}</td></tr>
            <tr><td style="padding:6px 0;color:#a1a1aa;">Other</td><td style="padding:6px 0;text-align:right;">${escapeHtml(other)}</td></tr>
            <tr><td style="padding:6px 0;color:#a1a1aa;">Change</td><td style="padding:6px 0;text-align:right;">${escapeHtml(change)}</td></tr>
          </tbody>
        </table>
      </div>
      ` : ''}

      ${(includeTechnicianSummary && techLines.length) ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid #27272a;">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a1a1aa;margin-bottom:8px;">Technician breakdown</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:6px 0;color:#a1a1aa;font-weight:600;">Tech</th>
              <th style="text-align:right;padding:6px 0;color:#a1a1aa;font-weight:600;">WO</th>
              <th style="text-align:right;padding:6px 0;color:#a1a1aa;font-weight:600;">Sales</th>
              <th style="text-align:right;padding:6px 0;color:#a1a1aa;font-weight:600;">Collected</th>
              <th style="text-align:right;padding:6px 0;color:#a1a1aa;font-weight:600;">Remaining</th>
            </tr>
          </thead>
          <tbody>
            ${techLines.map((line) => `
              <tr>
                <td style="padding:6px 0;border-top:1px solid #1f1f22;">${escapeHtml(line.label)}</td>
                <td style="padding:6px 0;border-top:1px solid #1f1f22;text-align:right;">${line.workOrders}</td>
                <td style="padding:6px 0;border-top:1px solid #1f1f22;text-align:right;">${line.sales}</td>
                <td style="padding:6px 0;border-top:1px solid #1f1f22;text-align:right;">${escapeHtml(formatCurrency(line.collected))}</td>
                <td style="padding:6px 0;border-top:1px solid #1f1f22;text-align:right;">${escapeHtml(formatCurrency(line.remaining))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ` : ''}
    </div>
  </div>
</div>`.trim();

  return {
    recipients,
    subject: (() => {
      const configured = String(settings?.subject || '').trim();
      if (!configured) return title;
      if (/^daily\s+batch\s+report$/i.test(configured) && mode !== 'daily') return title;
      return configured;
    })(),
    bodyText,
    html,
  };
}

async function trySendScheduledEodEmail(targetDate: Date) {
  const payload = buildScheduledEodEmailPayload(targetDate);
  if (!payload) return { ok: false, skipped: true, error: 'No recipients or settings configured.' };
  for (const recipient of payload.recipients) {
    const sent = await sendConfiguredEmail({
      to: recipient,
      subject: payload.subject,
      text: payload.bodyText,
      html: payload.html,
    });
    if (!sent?.ok) return sent;
  }

  const db = readDb();
  if (Array.isArray((db as any).eodSettings) && (db as any).eodSettings[0]) {
    try {
      const prevDb: any = db;
      const prevSettings = (prevDb as any).eodSettings;
      const first = Array.isArray(prevSettings) ? prevSettings[0] : null;
      if (first) {
        const nextFirst = { ...(first as any), lastSentAt: new Date().toISOString() };
        const nextSettings = [nextFirst, ...(Array.isArray(prevSettings) ? prevSettings.slice(1) : [])];
        const nextDb: any = { ...prevDb, eodSettings: nextSettings };
        writeDb(nextDb);
      }
    } catch {
      // ignore
    }
  }
  return { ok: true };
}

async function checkBatchOutSchedule() {
  try {
    const cfg = readBackupConfig();
    if (cfg.lastBatchOutDate && !lastBatchOutDate) lastBatchOutDate = configDateKey(cfg.lastBatchOutDate) || null;
    const db = readDb();
    const settings = (db as any)?.eodSettings && Array.isArray((db as any).eodSettings) ? (db as any).eodSettings[0] : null;
    const autoEmailDate = configDateKey((cfg as any)?.lastAutoEmailDate);
    const lastSentAtKey = configDateKey(settings?.lastSentAt);
    const autoBackup = settings?.autoBackup !== false; // default enabled
    const scheduleMode = String(settings?.schedule || 'daily');
    const batchOutTime = settings?.batchOutTime || settings?.sendTime || '21:00';
    const sendTime = settings?.sendTime || batchOutTime || '21:00';
    const now = new Date();
    if (!scheduleAllowsToday(scheduleMode, now)) return;

    const todayKey = localDateKey(now);

    const { h, m } = parseHhMm(batchOutTime);
    const batchTarget = new Date();
    batchTarget.setHours(h, m, 0, 0);
    if (autoBackup && lastBatchOutDate !== todayKey && now >= batchTarget) {
      const res = await runBatchOutBackup('batchout');
      if (res.ok) {
        lastBatchOutDate = todayKey;
      }
    }

    const scheduleModeLower = String(scheduleMode || '').trim().toLowerCase();
    const effectiveSendTime = (scheduleModeLower === 'weekly' || scheduleModeLower === 'monthly') ? '00:00' : sendTime;
    const { h: sendHour, m: sendMinute } = parseHhMm(effectiveSendTime);
    const emailTarget = new Date();
    emailTarget.setHours(sendHour, sendMinute, 0, 0);
    // Safety valve: if we sent very recently, don't spam even if keys mismatch.
    const lastSentAtIso = settings?.lastSentAt ? String(settings.lastSentAt) : '';
    const lastSentAt = lastSentAtIso ? new Date(lastSentAtIso) : null;
    const sentRecently = !!(lastSentAt && Number.isFinite(lastSentAt.getTime()) && (now.getTime() - lastSentAt.getTime()) < 55 * 60 * 1000);

    const sentToday = autoEmailDate === todayKey || lastSentAtKey === todayKey;

    if (!sentRecently && !sentToday && now >= emailTarget) {
      const sent = await trySendScheduledEodEmail(now);
      if (sent?.ok) {
        // Store an ISO timestamp for display, but compare using local date keys.
        writeBackupConfig({ lastAutoEmailDate: new Date().toISOString() });
        appendStartupLog(`scheduled EOD email sent for ${todayKey}`);
      } else if (!(sent as any)?.skipped) {
        appendStartupLog(`scheduled EOD email failed: ${String((sent as any)?.error || 'unknown error')}`);
      }
    }
  } catch (e) {
    console.warn('[BATCH-OUT] Scheduler error', e);
  }
}

function ensureBatchOutScheduler() {
  if (batchOutTimer) clearInterval(batchOutTimer);
  batchOutTimer = setInterval(() => { checkBatchOutSchedule(); }, 60 * 1000);
  // Run once shortly after startup
  setTimeout(() => { checkBatchOutSchedule(); }, 5 * 1000);
}

// Create encrypted backup
ipcMain.handle('create-encrypted-backup', async (_event: any, backupData: any, password: string) => {
  try {
    console.log('[BACKUP] Creating encrypted backup...');
    
    // Show save dialog
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0], {
      title: 'Save Encrypted Backup',
      defaultPath: `GadgetBoyPOS-Backup-${new Date().toISOString().slice(0, 10)}.gbpos`,
      filters: [
        { name: 'GadgetBoy POS Backup', extensions: ['gbpos'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Save canceled by user' };
    }

    // Import backup utilities (dynamically to avoid import issues)
    const crypto = require('crypto');
    const zlib = require('zlib');

    // Encrypt the backup data
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

    // Compress and encrypt
    const jsonData = JSON.stringify(backupData);
    const compressed = zlib.gzipSync(Buffer.from(jsonData, 'utf8'));
    
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('GadgetBoyPOS-Backup-v1'));
    
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();

    const encryptedBackup = {
      version: '1.0.0',
      algorithm: 'aes-256-gcm',
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted.toString('hex'),
      timestamp: new Date().toISOString()
    };

    // Write to file
    fs.writeFileSync(result.filePath, JSON.stringify(encryptedBackup, null, 2));

    // Store last backup path
    writeBackupConfig({ lastBackupPath: result.filePath, lastBackupDate: new Date().toISOString() });

    console.log('[BACKUP] Backup created successfully:', result.filePath);
    return { success: true, filePath: result.filePath };
  } catch (error: any) {
    console.error('[BACKUP] Failed to create backup:', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
});

// Restore from encrypted backup
ipcMain.handle('restore-encrypted-backup', async (_event: any, password: string) => {
  try {
    console.log('[RESTORE] Starting restore process...');

    // Show open dialog
    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0], {
      title: 'Select Backup File to Restore',
      filters: [
        { name: 'GadgetBoy POS Backup', extensions: ['gbpos'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths.length) {
      return { success: false, error: 'Restore canceled by user' };
    }

    const filePath = result.filePaths[0];
    console.log('[RESTORE] Reading backup file:', filePath);

    // Read and parse backup file
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const encryptedBackup = JSON.parse(fileContent);

    // Import crypto utilities
    const crypto = require('crypto');
    const zlib = require('zlib');

    // Decrypt the backup
    const salt = Buffer.from(encryptedBackup.salt, 'hex');
    const iv = Buffer.from(encryptedBackup.iv, 'hex');
    const tag = Buffer.from(encryptedBackup.tag, 'hex');
    const encryptedData = Buffer.from(encryptedBackup.data, 'hex');
    
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

    const decipher = crypto.createDecipheriv(encryptedBackup.algorithm, key, iv);
    decipher.setAAD(Buffer.from('GadgetBoyPOS-Backup-v1'));
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    const decompressed = zlib.gunzipSync(decrypted);
    const backupData = JSON.parse(decompressed.toString('utf8'));

    // Restore all collections (immutable update)
    const collectionsSource = (backupData && typeof backupData === 'object' && backupData.collections && typeof backupData.collections === 'object')
      ? backupData.collections
      : backupData;

    const nextDb: any = {};
    let totalRecords = 0;

    for (const [collectionName, items] of Object.entries(collectionsSource as Record<string, any>)) {
      if (Array.isArray(items)) {
        nextDb[collectionName] = items;
        totalRecords += items.length;
        console.log(`[RESTORE] Restored ${items.length} records to ${collectionName}`);
      }
    }

    // Ensure core collections exist
    if (!Array.isArray(nextDb.customers)) nextDb.customers = [];
    if (!Array.isArray(nextDb.workOrders)) nextDb.workOrders = [];

    // Recompute invoiceSeq so the first new WO/sale gets the correct next ID
    const rWo: any[] = Array.isArray(nextDb.workOrders) ? nextDb.workOrders : [];
    const rSa: any[] = Array.isArray(nextDb.sales) ? nextDb.sales : [];
    let rMaxId = 0;
    for (const it of rWo) rMaxId = Math.max(rMaxId, Number(it?.id || 0));
    for (const it of rSa) rMaxId = Math.max(rMaxId, Number(it?.id || 0));
    if (!nextDb.invoiceSeq || Number(nextDb.invoiceSeq) < rMaxId) {
      nextDb.invoiceSeq = rMaxId;
    }

    // Write restored data back to database and flush immediately so dbCache is consistent
    writeDb(nextDb);
    await drainDbWrites();

    // Notify all windows that all collections have changed
    emitAllDataChanged();

    console.log('[RESTORE] Restore completed successfully, total records:', totalRecords);
    return { ok: true, success: true, recordsCount: totalRecords };
  } catch (error: any) {
    console.error('[RESTORE] Failed to restore backup:', error);
    const errMsg = (error as any)?.message || String(error);
    if (errMsg.includes('bad decrypt') || errMsg.includes('authentication')) {
      return { ok: false, success: false, error: 'Invalid password or corrupted backup file' };
    }
    return { ok: false, success: false, error: errMsg || 'Unknown error' };
  }
});

// Get last backup path
ipcMain.handle('get-last-backup-path', async () => {
  try {
    const cfg = readBackupConfig();
    return cfg.lastBackupPath || '';
  } catch (error) {
    console.warn('[BACKUP] Failed to get last backup path:', error);
    return '';
  }
});

// ============================================
// STORAGE LOCATION + DIAGNOSTICS IPC
// ============================================

ipcMain.handle('storage:getInfo', async () => {
  try {
    const cfg = readDataLocationConfig();
    return {
      ok: true,
      configured: Boolean(cfg?.dataRoot),
      dataRoot: cfg?.dataRoot || null,
      recommended: defaultProgramDataRoot(),
      userData: app.getPath('userData'),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('storage:ensure', async (event: any) => {
  const parentWin = (() => { try { return BrowserWindow.fromWebContents(event?.sender); } catch { return null; } })() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;
  try {
    const existing = readDataLocationConfig();
    if (existing?.dataRoot) {
      const writeCheck = canWriteToFolder(existing.dataRoot);
      if (writeCheck.ok) {
        setDataRoot(existing.dataRoot);
        return { ok: true, configured: true, dataRoot: existing.dataRoot, isFirstRun: false };
      }
    }

    const recommended = defaultProgramDataRoot();
    const perUser = app.getPath('userData');

    // Fail-safe: if the pointer file is missing but an existing data folder is present,
    // offer to reuse it (common after reinstall or if userData was wiped).
    const candidateExistingRoot = (() => {
      if (looksLikeGbposDataRoot(recommended)) return recommended;
      if (looksLikeGbposDataRoot(perUser)) return perUser;
      return null;
    })();

    if (candidateExistingRoot) {
      const reuse = await dialog.showMessageBox(parentWin as any, {
        type: 'question',
        buttons: ['Use Existing Data Folder', 'Choose Folder…', 'Use Per-User (AppData)'],
        defaultId: 0,
        cancelId: 2,
        title: 'GadgetBoy POS Data Found',
        message: 'An existing GadgetBoy POS data folder was found.',
        detail: `${candidateExistingRoot}\n\nDo you want to keep using this folder? This preserves your customers/work orders/backups across updates and reinstalls.`,
        noLink: true,
      });

      if (reuse.response === 0) {
        const writeCheck = canWriteToFolder(candidateExistingRoot);
        if (writeCheck.ok) {
          setDataRoot(candidateExistingRoot);
          return { ok: true, configured: true, dataRoot: candidateExistingRoot, isFirstRun: false, reusedExisting: true };
        }
      }
      // Otherwise fall through to normal chooser.
    }

    const choice = await dialog.showMessageBox(parentWin as any, {
      type: 'question',
      buttons: ['Use Recommended (ProgramData)', 'Choose Folder...', 'Use Per-User (AppData)'],
      defaultId: 0,
      cancelId: 2,
      title: 'GadgetBoy POS Setup',
      message: 'Choose where GadgetBoy POS should store its data',
      detail: `Recommended: ${recommended}\n\nThis includes the database (customers/work orders), email settings, backups, and quote preview temp files.`,
      noLink: true,
    });

    let selectedRoot: string = perUser;
    if (choice.response === 0) {
      selectedRoot = recommended;
    } else if (choice.response === 1) {
      const open = await dialog.showOpenDialog(parentWin as any, {
        title: 'Select a folder to store GadgetBoy POS data',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!open.canceled && open.filePaths && open.filePaths[0]) {
        const base = open.filePaths[0];
        selectedRoot = path.basename(base).toLowerCase() === APP_DATA_DIRNAME.toLowerCase()
          ? base
          : path.join(base, APP_DATA_DIRNAME);
      }
    }

    const writeCheck = canWriteToFolder(selectedRoot);
    if (!writeCheck.ok) {
      await dialog.showMessageBox(parentWin as any, {
        type: 'warning',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Cannot Write to Folder',
        message: 'GadgetBoy POS could not write to the selected folder.',
        detail: `${selectedRoot}\n\nFalling back to per-user storage.\n\nError: ${writeCheck.error || 'Unknown error'}`,
        noLink: true,
      });
      selectedRoot = perUser;
    }

    setDataRoot(selectedRoot);

    // Best-effort migration from previous per-user location
    let migration: any = null;
    try {
      const oldUserData = app.getPath('userData');
      if (oldUserData && selectedRoot && path.resolve(oldUserData) !== path.resolve(selectedRoot)) {
        migration = migrateUserDataToDataRoot(oldUserData, selectedRoot);
      }
    } catch {
      // ignore
    }

    return { ok: true, configured: true, dataRoot: selectedRoot, isFirstRun: true, migration };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), dataRoot: resolveDataRoot() };
  }
});

ipcMain.handle('diagnostics:run', async () => {
  const results: any[] = [];
  const dataRoot = resolveDataRoot();
  try {
    results.push({ name: 'dataRoot', ok: true, value: dataRoot });

    const writeCheck = canWriteToFolder(dataRoot);
    results.push({ name: 'writeAccess', ok: writeCheck.ok, error: writeCheck.error || null });

    // DB parse check
    try {
      const db = readDb();
      results.push({ name: 'dbRead', ok: true, keys: Object.keys(db || {}) });
    } catch (e: any) {
      results.push({ name: 'dbRead', ok: false, error: e?.message || String(e) });
    }

    // Temp preview dir check
    try {
      const tempDir = path.join(dataRoot, 'quote-previews');
      const chk = canWriteToFolder(tempDir);
      results.push({ name: 'quotePreviewsWritable', ok: chk.ok, error: chk.error || null });
    } catch (e: any) {
      results.push({ name: 'quotePreviewsWritable', ok: false, error: e?.message || String(e) });
    }
  } catch (e: any) {
    results.push({ name: 'diagnostics', ok: false, error: e?.message || String(e) });
  }

  const ok = results.every((r) => r && r.ok !== false);
  try { appendStartupLog(`diagnostics ok=${ok} dataRoot=${dataRoot}`); } catch {}
  return { ok, dataRoot, results };
});
