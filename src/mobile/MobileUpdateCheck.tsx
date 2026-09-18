import React, { useEffect, useRef, useState } from 'react';

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type GitHubRelease = {
  tag_name?: string;
  name?: string;
  html_url?: string;
  assets?: ReleaseAsset[];
};

export type MobileUpdate = {
  version: string;
  releaseName: string;
  apkName: string;
  apkUrl: string;
  releaseUrl: string;
  instructionsName?: string;
  instructionsUrl?: string;
};

const repoLatestUrl = 'https://api.github.com/repos/Rumsmokes/Gadgetboy-Command-Center/releases/latest';
const repoReleasesUrl = 'https://api.github.com/repos/Rumsmokes/Gadgetboy-Command-Center/releases?per_page=10';
const skippedKey = 'gbpos-mobile-skipped-update';

type MobileUpdateCheckProps = {
  checkKey?: string;
  delayMs?: number;
};

export function isNativeAndroidUpdateRuntime(): boolean {
  return typeof window !== 'undefined'
    && typeof window.GBPosAndroid?.downloadAndInstallApk === 'function';
}

function normalizeVersion(raw: string): string {
  return String(raw || '').trim().replace(/^v/i, '');
}

function compareVersions(aRaw: string, bRaw: string): number {
  const parseParts = (value: string) => {
    const main = normalizeVersion(value).split(/[+-]/)[0];
    return main.split('.').map((x) => parseInt(x, 10));
  };
  const a = parseParts(aRaw);
  const b = parseParts(bRaw);
  for (let i = 0; i < 3; i += 1) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function fetchGithubJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const separator = url.includes('?') ? '&' : '?';
      const res = await fetch(`${url}${separator}_=${Date.now()}-${attempt}`, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status !== 403 && res.status !== 429 && res.status < 500) return null;
    } catch {
      // A resumed WebView can briefly report online before networking is ready.
    } finally {
      window.clearTimeout(timeout);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
  }
  return null;
}

function releaseToMobileUpdate(release: GitHubRelease): MobileUpdate | null {
  const version = normalizeVersion(release.tag_name || '');
  if (!version || compareVersions(version, __APP_VERSION__) <= 0) return null;

  const asset = (release.assets || []).find((item) => {
    const name = String(item.name || '');
    return /^Android-APK-universal-.+\.apk$/i.test(name);
  });
  const apkUrl = String(asset?.browser_download_url || '');
  if (!apkUrl) return null;

  const instructionsAsset = (release.assets || []).find((item) => {
    const name = String(item.name || '');
    return /^GadgetBoy-POS-Instructions-.+\.pdf$/i.test(name);
  });

  return {
    version,
    releaseName: release.name || `GadgetBoy POS ${version}`,
    apkName: String(asset?.name || `Android-APK-universal-${version}.apk`),
    apkUrl,
    releaseUrl: release.html_url || apkUrl,
    instructionsName: String(instructionsAsset?.name || ''),
    instructionsUrl: String(instructionsAsset?.browser_download_url || ''),
  };
}

export async function getLatestMobileUpdate(): Promise<MobileUpdate | null> {
  // The releases list is more reliable in Android WebView than /releases/latest
  // and also survives a mistakenly marked prerelease. Keep latest as fallback.
  const releases = await fetchGithubJson<GitHubRelease[]>(repoReleasesUrl);
  const listedUpdate = Array.isArray(releases)
    ? releases
      .map(releaseToMobileUpdate)
      .filter((item): item is MobileUpdate => Boolean(item))
      .sort((a, b) => compareVersions(b.version, a.version))[0] || null
    : null;
  if (listedUpdate) return listedUpdate;

  const latest = await fetchGithubJson<GitHubRelease>(repoLatestUrl);
  const latestUpdate = latest ? releaseToMobileUpdate(latest) : null;
  if (latestUpdate) return latestUpdate;

  if (!Array.isArray(releases)) return null;
  return null;
}

export function openMobileUpdateDownload(update: MobileUpdate, includeInstructions = true, setOpening?: (opening: boolean) => void) {
  const safeUrl = String(update?.apkUrl || '').trim();
  if (!/^https:\/\//i.test(safeUrl)) return;
  setOpening?.(true);
  try {
    const instructionsUrl = String(update?.instructionsUrl || '').trim();
    if (includeInstructions && /^https:\/\//i.test(instructionsUrl)) {
      if (window.GBPosAndroid?.downloadFile) {
        window.GBPosAndroid.downloadFile(instructionsUrl, update.instructionsName || `GadgetBoy-POS-Instructions-${update.version}.pdf`, 'application/pdf');
      } else if (window.GBPosAndroid?.openExternalUrl) {
        window.GBPosAndroid.openExternalUrl(instructionsUrl);
      }
    }
    if (window.GBPosAndroid?.downloadAndInstallApk) {
      window.GBPosAndroid.downloadAndInstallApk(safeUrl, update.apkName);
      return;
    }
    if (window.GBPosAndroid?.openExternalUrl) {
      window.GBPosAndroid.openExternalUrl(safeUrl);
      return;
    }
    const opened = window.open(safeUrl, '_blank', 'noopener,noreferrer');
    if (!opened) window.location.href = safeUrl;
  } finally {
    window.setTimeout(() => setOpening?.(false), 1400);
  }
}

export default function MobileUpdateCheck({ checkKey = 'default', delayMs = 2500 }: MobileUpdateCheckProps) {
  const [update, setUpdate] = useState<MobileUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [includeInstructions, setIncludeInstructions] = useState(true);
  const skippedVersionRef = useRef<string | null>(null);
  const attemptedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    // Browser and installed PWA builds are replaced by the deployed web bundle
    // on reload. Only the native Android shell needs an APK update prompt.
    if (!isNativeAndroidUpdateRuntime()) return;

    let alive = true;
    let timer: number | null = null;

    const runCheck = async () => {
      try {
        setChecking(true);
        const next = await getLatestMobileUpdate();
        if (!alive || !next) return;
        try {
          window.localStorage.removeItem(skippedKey);
        } catch {
          // ignore legacy skip cleanup
        }
        if (skippedVersionRef.current === `${checkKey}:${next.version}`) return;
        if (attemptedVersionRef.current === `${checkKey}:${next.version}`) return;
        setUpdate(next);
      } catch {
        // Update checks should never block POS startup.
      } finally {
        if (alive) setChecking(false);
      }
    };

    const scheduleCheck = (delay = delayMs) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void runCheck();
      }, Math.max(0, delay));
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleCheck(600);
    };
    const onOnline = () => scheduleCheck(600);

    scheduleCheck();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [checkKey, delayMs]);

  if (!update) return null;

  const download = () => {
    attemptedVersionRef.current = `${checkKey}:${update.version}`;
    setUpdate(null);
    openMobileUpdateDownload(update, includeInstructions, setOpening);
  };

  const skip = () => {
    skippedVersionRef.current = `${checkKey}:${update.version}`;
    setUpdate(null);
  };

  return (
    <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-update-title"
        className="w-full max-w-sm rounded-lg border border-[#39FF14]/40 bg-zinc-950 text-zinc-100 shadow-2xl"
      >
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="text-xs uppercase tracking-[0.18em] text-[#39FF14]">Update Available</div>
          <div id="mobile-update-title" className="mt-1 text-lg font-semibold">
            GadgetBoy POS {update.version}
          </div>
        </div>
        <div className="space-y-3 px-4 py-4 text-sm text-zinc-300">
          <p>A newer Android APK is ready for this device.</p>
          <div className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            {update.apkName}
          </div>
          <p className="text-xs text-zinc-500">
            Android will download the APK and open the installer. The first update may ask you to allow GadgetBoy POS to install unknown apps; enable it, return here, and Android will continue the update.
          </p>
          <label className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-200">
            <input
              type="checkbox"
              checked={includeInstructions}
              onChange={(event) => setIncludeInstructions(event.target.checked)}
              className="h-4 w-4 accent-[#39FF14]"
            />
            Download the matching Instructions PDF
          </label>
        </div>
        <div className="flex gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            type="button"
            onClick={download}
            disabled={opening}
            className="flex-1 rounded bg-[#39FF14] px-3 py-2 text-sm font-semibold text-black"
          >
            {opening ? 'Opening installer...' : 'Download and install'}
          </button>
          <button
            type="button"
            onClick={skip}
            className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            Skip for now
          </button>
        </div>
        {checking && <div className="sr-only">Checking for Android update</div>}
      </div>
    </div>
  );
}
