import React, { Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { publicAsset } from './lib/publicAsset';
import { focusNextFocusable } from './lib/focusNextFocusable';

const App = lazy(() => import('./App'));
const CalendarWindow = lazy(() => import('./components/CalendarWindow'));
const loadCustomerOverviewWindow = () => import('./components/CustomerOverviewWindow');
const CustomerOverviewWindow = lazy(loadCustomerOverviewWindow);
const loadNewWorkOrderWindow = () => import('./workorders/NewWorkOrderWindow');
const NewWorkOrderWindow = lazy(loadNewWorkOrderWindow);
const loadDeviceCategoriesWindow = () => import('./components/DeviceCategoriesWindow');
const DeviceCategoriesWindow = lazy(loadDeviceCategoriesWindow);
const loadRepairCategoriesWindow = () => import('./repairs/RepairCategoriesWindow');
const RepairCategoriesWindow = lazy(loadRepairCategoriesWindow);
const WorkOrderRepairPickerWindow = lazy(() => import('./workorders/WorkOrderRepairPickerWindow'));
const CheckoutWindow = lazy(() => import('./workorders/CheckoutWindow'));
const DevMenuWindow = lazy(() => import('./components/DevMenuWindow'));
const DataToolsWindow = lazy(() => import('./components/DataToolsWindow'));
const loadReportingWindow = () => import('./components/ReportingWindow');
const ReportingWindow = lazy(loadReportingWindow);
const loadReleaseFormWindow = () => import('./workorders/ReleaseFormWindow');
const ReleaseFormWindow = lazy(loadReleaseFormWindow);
const loadCustomerReceiptWindow = () => import('./workorders/CustomerReceiptWindow');
const CustomerReceiptWindow = lazy(loadCustomerReceiptWindow);
const loadSaleWindow = () => import('./sales/SaleWindow');
const SaleWindow = lazy(loadSaleWindow);
const loadProductFormWindow = () => import('./sales/ProductFormWindow');
const ProductFormWindow = lazy(loadProductFormWindow);
const loadConsultSheetWindow = () => import('./sales/ConsultSheetWindow');
const ConsultSheetWindow = lazy(loadConsultSheetWindow);
const loadProductsWindow = () => import('./components/ProductsWindow');
const ProductsWindow = lazy(loadProductsWindow);
const loadInventoryWindow = () => import('./components/InventoryWindow');
const InventoryWindow = lazy(loadInventoryWindow);
const VendorsWindow = lazy(() => import('./components/VendorsWindow'));
const TechniciansWindow = lazy(() => import('./components/TechniciansWindow'));
const CatalogSettingsWindow = lazy(() => import('./components/CatalogSettingsWindow'));
const ChartsWindow = lazy(() => import('./components/ChartsWindow'));
const BackupWindow = lazy(() => import('./components/BackupWindow'));
const ClearDatabaseWindow = lazy(() => import('./components/ClearDatabaseWindow'));
const loadClockInWindow = () => import('./components/ClockInWindow');
const ClockInWindow = lazy(loadClockInWindow);
const loadQuoteGeneratorWindow = () => import('./components/QuoteGeneratorWindow');
const QuoteGeneratorWindow = lazy(loadQuoteGeneratorWindow);
const loadQuickSaleWindow = () => import('./components/QuickSaleWindow');
const QuickSaleWindow = lazy(loadQuickSaleWindow);
const ConsultationBookingWindow = lazy(() => import('./components/ConsultationBookingWindow'));
const EODWindow = lazy(() => import('./components/EODWindow'));
const NotificationsWindow = lazy(() => import('./components/NotificationsWindow'));
const NotificationSettingsWindow = lazy(() => import('./components/NotificationSettingsWindow'));
const ReportEmailWindow = lazy(() => import('./components/ReportEmailWindow'));
const CustomBuildItemWindow = lazy(() => import('./workorders/CustomBuildItemWindow'));
const DataPathGate = lazy(() => import('./components/DataPathGate'));
const GameMenuWindow = lazy(() => import('./components/GameMenuWindow'));
const RepairTutorialWindow = lazy(() => import('./repairs/RepairTutorialWindow'));

declare global {
	interface Window {
		__lastRepairSelected?: any;
	}
}

function applyVersionToDocumentTitle() {
	try {
		const api: any = (window as any).api;
		if (!api?.getAppInfo) return;
		Promise.resolve(api.getAppInfo())
			.then((info: any) => {
				const version = String(info?.version || '').trim();
				if (!version) return;
				const base = api?.__GB_POS_TEST_ENVIRONMENT__ === true
					? `GadgetBoy POS — Test Environment v${version}`
					: `GadgetBoy POS v${version}`;
				const current = String(document.title || '').trim();
				// If the app title is already set, don't duplicate it.
				if (!current || /gadgetboy\s*pos/i.test(current)) {
					document.title = base;
					return;
				}
				if (current.includes(base)) return;
				document.title = `${current} — ${base}`;
			})
			.catch(() => {});
	} catch {
		// ignore
	}
}

if (typeof window !== 'undefined') {
	window.addEventListener('error', (ev: any) => {
		try {
			document.body.innerHTML = '';
			const pre = document.createElement('pre');
			pre.style.color = 'salmon';
			pre.style.whiteSpace = 'pre-wrap';
			// Ensure we stringify errors safely for display
			const errMsg = ev?.message || ev?.error?.message || ev;
			pre.textContent = `Uncaught error: ${String(errMsg)}` + (ev?.error?.stack ? '\n' + String(ev.error.stack) : '');
			document.body.appendChild(pre);
		} catch (e) {
			// ignore
		}
	});
}

if (typeof window !== 'undefined') {
	applyVersionToDocumentTitle();
}

function installGlobalDropdownKeyboardNav() {
	try {
		const w: any = window as any;
		if (w.__gbpos_dropdownKeyboardNavInstalled) return;
		w.__gbpos_dropdownKeyboardNavInstalled = true;

		document.addEventListener('keydown', (ev: KeyboardEvent) => {
			try {
				// Only handle Enter on dropdown-like controls.
				if (ev.key !== 'Enter') return;
				if (ev.defaultPrevented) return;

				const target = ev.target as HTMLElement | null;
				if (!target) return;

				const tag = (target as any).tagName;
				if (tag === 'SELECT') {
					ev.preventDefault();
					ev.stopPropagation();
					focusNextFocusable(target);
					return;
				}

				if (tag === 'INPUT') {
					const input = target as HTMLInputElement;
					// Native datalist inputs behave like dropdowns; treat Enter as “accept + move next”.
					if (input.list && input.getAttribute('list')) {
						ev.preventDefault();
						ev.stopPropagation();
						focusNextFocusable(input);
						return;
					}
				}
			} catch {
				// ignore
			}
		}, true);
	} catch {
		// ignore
	}
}

if (typeof window !== 'undefined') {
	installGlobalDropdownKeyboardNav();
}

function getNewWorkOrderPayload() {
	try {
		const params = new URLSearchParams(window.location.search);
		const raw = params.get('newWorkOrder');
		if (!raw) return null;
		return JSON.parse(decodeURIComponent(raw));
	} catch (e) { 
		return null; 
	}
}

function LoadingScreen() {
	return (
		<div className="min-h-screen bg-zinc-900 flex flex-col items-center justify-center gap-5">
			<img
				src={publicAsset('logo.png')}
				alt="GadgetBoy POS"
				className="w-28 h-28 object-contain animate-pulse"
			/>
			<div className="flex items-center gap-1">
				<span className="text-sm text-zinc-400 tracking-wide">Loading</span>
				<span className="flex gap-0.5 ml-0.5">
					{[0, 1, 2].map(i => (
						<span
							key={i}
							className="block w-1 h-1 rounded-full bg-[#39FF14]"
							style={{ animation: `bounce 1s ease-in-out ${i * 0.18}s infinite` }}
						/>
					))}
				</span>
			</div>
			<style>{`@keyframes bounce { 0%,80%,100%{transform:translateY(0);opacity:.4} 40%{transform:translateY(-5px);opacity:1} }`}</style>
		</div>
	);
}

function removeInitialHtmlLoader() {
	try {
		const el = document.getElementById('gbpos-initial-loader');
		if (el) el.remove();
	} catch {
		// ignore
	}
}

const STANDALONE_WINDOW_QUERY_KEYS = [
	'newWorkOrder',
	'newSale',
	'deviceCategories',
	'customerOverview',
	'repairCategories',
	'workOrderRepairPicker',
	'devMenu',
	'dataTools',
	'calendar',
	'products',
	'inventory',
	'charts',
	'reporting',
	'reportEmail',
	'quote',
	'quickSale',
	'eod',
	'releaseForm',
	'customerReceipt',
	'consultSheet',
	'productForm',
	'backup',
	'clearDb',
	'clockIn',
	'notifications',
	'notificationSettings',
	'customBuildItem',
	'consultation',
];

function isStandaloneWindowRoute() {
	try {
		const params = new URLSearchParams(window.location.search);
		return STANDALONE_WINDOW_QUERY_KEYS.some((key) => params.has(key));
	} catch {
		return false;
	}
}

async function closeCurrentDaughterWindow() {
	try {
		const api: any = (window as any).api;
		if (api?.closeSelfWindow) {
			const res = await api.closeSelfWindow({ focusMain: true });
			if (res?.ok) return;
		}
	} catch {
		// fall back below
	}
	try {
		window.close();
	} catch {
		// ignore
	}
}

function StandaloneWindowCloseButton() {
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			void closeCurrentDaughterWindow();
		};
		window.addEventListener('keydown', handler, { capture: true });
		return () => window.removeEventListener('keydown', handler, { capture: true });
	}, []);

	return (
		<button
			type="button"
			className="gb-standalone-window-close"
			title="Close window (Esc)"
			aria-label="Close window"
			onClick={() => void closeCurrentDaughterWindow()}
		>
			<span aria-hidden="true">x</span>
		</button>
	);
}

function renderWithSuspense(root: ReturnType<typeof createRoot>, node: React.ReactNode) {
	removeInitialHtmlLoader();
	const content = isStandaloneWindowRoute()
		? (
			<>
				<StandaloneWindowCloseButton />
				{node}
			</>
		)
		: node;
	root.render(
		<Suspense fallback={<LoadingScreen />}>
			{content}
		</Suspense>
	);
}

let commonWindowPreloadsScheduled = false;

function scheduleCommonWindowPreloads() {
	if (commonWindowPreloadsScheduled || typeof window === 'undefined') return;
	commonWindowPreloadsScheduled = true;

	const runWhenIdle = (cb: () => void, timeout: number) => {
		const idle = (window as any).requestIdleCallback;
		if (typeof idle === 'function') {
			idle(() => cb(), { timeout });
			return;
		}
		window.setTimeout(cb, Math.min(timeout, 1200));
	};

	const queueImports = (loaders: Array<() => Promise<unknown>>, gapMs: number) => {
		loaders.forEach((loader, index) => {
			window.setTimeout(() => {
				loader().catch(() => {});
			}, index * gapMs);
		});
	};

	runWhenIdle(() => {
		queueImports([
			loadNewWorkOrderWindow,
			loadSaleWindow,
			loadQuickSaleWindow,
			loadCustomerOverviewWindow,
		], 180);
	}, 1500);

	window.setTimeout(() => {
		runWhenIdle(() => {
			queueImports([
				loadProductsWindow,
				loadInventoryWindow,
				loadReportingWindow,
				loadCustomerReceiptWindow,
				loadReleaseFormWindow,
				loadProductFormWindow,
				loadConsultSheetWindow,
				loadDeviceCategoriesWindow,
				loadRepairCategoriesWindow,
				loadClockInWindow,
				loadQuoteGeneratorWindow,
			], 180);
		}, 2500);
	}, 1800);
}

if (typeof window !== 'undefined') {
	if (typeof (window as any).api?.onRepairSelected === 'function') {
		(window as any).api.onRepairSelected((repair: any) => {
			window.__lastRepairSelected = repair;
		});
	}
}

try {
	const payload = getNewWorkOrderPayload();
	const params = new URLSearchParams(window.location.search);
	const showNewSale = params.get('newSale');
	const showDeviceCategories = params.get('deviceCategories');
	const showCustomerOverview = params.get('customerOverview');
	const showRepairCategories = params.get('repairCategories');
	const showWorkOrderRepairPicker = params.get('workOrderRepairPicker');
	const showCheckout = params.get('checkout');
	const showDevMenu = params.get('devMenu');
	const showDataTools = params.get('dataTools');
	const showCalendar = params.get('calendar');
	const showProducts = params.get('products');
	const showInventory = params.get('inventory');
	const showVendors = params.get('vendors');
	const showTechnicians = params.get('technicians');
	const showCatalogSettings = params.get('catalogSettings');
	const showCharts = params.get('charts');
	const showReporting = params.get('reporting');
	const showReportEmail = params.get('reportEmail');
	const showQuote = params.get('quote');
	const showQuickSale = params.get('quickSale');
	const showEod = params.get('eod');
	const showReleaseForm = params.get('releaseForm');
	const showCustomerReceipt = params.get('customerReceipt');
	const showConsultSheet = params.get('consultSheet');
	const showProductForm = params.get('productForm');
	const showBackup = params.get('backup');
	const showClearDb = params.get('clearDb');
	const showClockIn = params.get('clockIn');
	const showNotifications = params.get('notifications');
	const showNotificationSettings = params.get('notificationSettings');
	const showCustomBuildItem = params.get('customBuildItem');
	const showGameMenu = params.get('gameMenu');
	const showRepairTutorial = params.get('repairTutorial');
	
	const rootEl = document.getElementById('root');
	if (!rootEl) throw new Error('Missing #root element');
	const root = createRoot(rootEl);
	
	if (showRepairTutorial) {
		renderWithSuspense(root, <RepairTutorialWindow onClose={() => window.close()} />);
	} else if (showGameMenu) {
		renderWithSuspense(root, <GameMenuWindow />);
	} else if (showDeviceCategories) {
		renderWithSuspense(root, <DeviceCategoriesWindow />);
	} else if (showEod) {
		renderWithSuspense(root, <EODWindow />);
	} else if (showWorkOrderRepairPicker) {
		renderWithSuspense(root, <WorkOrderRepairPickerWindow />);
	} else if (showRepairCategories) {
		const modeParam = params.get('mode');
		const mode = modeParam === 'admin' || modeParam === 'workorder' ? modeParam : 'admin';
		renderWithSuspense(root, <RepairCategoriesWindow mode={mode} />);
	} else if (showCheckout) {
		renderWithSuspense(root, <CheckoutWindow />);
	} else if (showCustomerOverview) {
		renderWithSuspense(root, <CustomerOverviewWindow onClose={() => window.close()} />);
	} else if (showDevMenu) {
		renderWithSuspense(root, <DevMenuWindow />);
	} else if (showDataTools) {
		renderWithSuspense(root, <DataToolsWindow />);
	} else if (showReporting) {
		renderWithSuspense(root, <ReportingWindow />);
	} else if (showReportEmail) {
		renderWithSuspense(root, <ReportEmailWindow />);
	} else if (showCharts) {
		renderWithSuspense(root, <ChartsWindow />);
	} else if (showBackup) {
		renderWithSuspense(root, <BackupWindow />);
	} else if (showClearDb) {
		renderWithSuspense(root, <ClearDatabaseWindow />);
	} else if (showClockIn) {
		renderWithSuspense(root, <ClockInWindow />);
		} else if (showNotifications) {
			renderWithSuspense(root, <NotificationsWindow />);
		} else if (showNotificationSettings) {
			renderWithSuspense(root, <NotificationSettingsWindow />);
		} else if (showCustomBuildItem) {
			renderWithSuspense(root, <CustomBuildItemWindow />);
	} else if (showQuote) {
		const hasElectronApi = !!(window as any)?.api;
		if (!hasElectronApi) {
			renderWithSuspense(root,
				<div style={{ padding: 16, fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial', color: '#111' }}>
					<h2 style={{ margin: 0, marginBottom: 8 }}>Quote Generator requires the Electron app</h2>
					<div style={{ color: '#333', lineHeight: 1.45 }}>
						This route uses the Electron preload API (<code>window.api</code>) and won’t run in a normal browser/Simple Browser.
						<br />
						Open it from the running POS app instead.
					</div>
				</div>
			);
		} else {
			renderWithSuspense(root, <QuoteGeneratorWindow />);
		}
	} else if (showReleaseForm) {
		renderWithSuspense(root, <ReleaseFormWindow />);
	} else if (showCustomerReceipt) {
		renderWithSuspense(root, <CustomerReceiptWindow />);
	} else if (showConsultSheet) {
		renderWithSuspense(root, <ConsultSheetWindow />);
	} else if (showCalendar) {
		renderWithSuspense(root, <CalendarWindow />);
	} else if (showProductForm) {
		renderWithSuspense(root, <ProductFormWindow />);
	} else if (showProducts) {
		renderWithSuspense(root, <ProductsWindow />);
	} else if (showInventory) {
		renderWithSuspense(root, <InventoryWindow />);
	} else if (showVendors) {
		renderWithSuspense(root, <VendorsWindow />);
	} else if (showTechnicians) {
		renderWithSuspense(root, <TechniciansWindow onClose={() => window.close()} />);
	} else if (showCatalogSettings) {
		renderWithSuspense(root, <CatalogSettingsWindow />);
	} else if (showNewSale) {
		renderWithSuspense(root, <SaleWindow />);
	} else if (showQuickSale) {
		renderWithSuspense(root, <QuickSaleWindow />);
	} else if (params.get('consultation')) {
		renderWithSuspense(root, <ConsultationBookingWindow />);
	} else if (payload) {
		renderWithSuspense(root, <NewWorkOrderWindow />);
	} else {
		scheduleCommonWindowPreloads();
		renderWithSuspense(root, <App />);
	}

} catch (e: any) {
	console.error('Failed to mount app:', e);
	try {
		// Stringify the error to avoid injecting objects directly into innerHTML
		document.body.innerHTML = `<pre style="color: red;">${String(e)}</pre>`;
	}
	catch (ee) {
		console.error(ee);
	}
}
