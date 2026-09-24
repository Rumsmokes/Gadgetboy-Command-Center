const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const PORT = 5197;
const ROOT = path.resolve(__dirname, '..');
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ALL_WINDOWS = [
  'newWorkOrder', 'newSale', 'calendar', 'journal', 'dailyLook', 'clockIn',
  'quoteGenerator', 'eod', 'products', 'inventory', 'vendors',
  'workOrderRepairPicker', 'addClient', 'customerOverview', 'customerSearch',
  'diagnosticTools', 'quickSale', 'consultation', 'checkout', 'devMenu',
  'dataTools', 'reporting', 'reportEmail', 'charts', 'notifications',
  'notificationSettings', 'releaseForm', 'customerReceipt', 'consultSheet',
  'productForm', 'backup', 'clearDb', 'repairCategories', 'deviceCategories',
  'customBuildItem', 'technicians', 'feedback', 'gameMenu',
  'clientUpdate',
];
const WINDOWS = process.env.MOBILE_WINDOW_LAYOUT_TYPE
  ? [process.env.MOBILE_WINDOW_LAYOUT_TYPE]
  : ALL_WINDOWS;
const BASE_ORIENTATIONS = [
  { name: 'portrait', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
  ...(process.env.CAPTURE_RELEASE_PREVIEWS ? [{ name: 'desktop', width: 1440, height: 1000 }] : []),
];
const ORIENTATIONS = process.env.MOBILE_WINDOW_LAYOUT_ORIENTATION ? BASE_ORIENTATIONS.filter(entry => entry.name === process.env.MOBILE_WINDOW_LAYOUT_ORIENTATION) : BASE_ORIENTATIONS;

function waitForServer(timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const request = http.get(`${BASE_URL}/mobile.html`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve();
        else retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error('Timed out waiting for the mobile preview server.'));
      else setTimeout(poll, 200);
    };
    poll();
  });
}

function startVite() {
  const node = process.env.npm_node_execpath || 'node';
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  return spawn(node, [vite, '--config', 'vite.config.ts', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function inspectWindow(win, type, orientation) {
  const runtimeErrors = [];
  const consoleHandler = (_event, level, message) => {
    if (level >= 3 && !/Browserslist|favicon/i.test(message)) runtimeErrors.push(message);
  };
  win.webContents.on('console-message', consoleHandler);
  await win.setContentSize(orientation.width, orientation.height);
  const checkoutPayload = type === 'checkout'
    ? `&checkout=${encodeURIComponent(JSON.stringify({ amountDue: 164.15, partsDue: 109.15, laborDue: 55, title: 'Work Order Checkout' }))}`
    : '';
  const inventoryPayload = type === 'inventory' ? '&inventoryPreview=1' : '';
  await win.loadURL(`${BASE_URL}/mobile.html?mobileWindowPreview=${encodeURIComponent(type)}${checkoutPayload}${inventoryPayload}`);
  await new Promise((resolve) => setTimeout(resolve, 425));
  const layout = await win.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.mobile-modal-shell');
    const content = document.querySelector('.mobile-modal-content');
    const close = shell?.querySelector('.mobile-modal-bar button[aria-label="Close window"]')
      || content?.querySelector('button[aria-label="Close"]');
    const shellRect = shell?.getBoundingClientRect();
    const closeRect = close?.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    const overflowCandidates = contentRect ? Array.from(content.querySelectorAll('*')).map((element) => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, className: String(element.className || '').slice(0, 100), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter((entry) => entry.right > contentRect.right + 3 || entry.left < contentRect.left - 3).slice(0, 8) : [];
    return {
      shell: Boolean(shell),
      content: Boolean(content),
      unknown: document.body.textContent.includes('Unknown window:'),
      uncaught: document.body.textContent.includes('Uncaught error:'),
      bodyOverflow: document.documentElement.scrollWidth > window.innerWidth + 3,
      contentOverflow: Boolean(content && content.scrollWidth > content.clientWidth + 3),
      shellFits: Boolean(shellRect && shellRect.left >= -2 && shellRect.right <= window.innerWidth + 2 && shellRect.top >= -2 && shellRect.bottom <= window.innerHeight + 2),
      closeVisible: Boolean(closeRect && closeRect.width >= 32 && closeRect.height >= 32 && closeRect.right <= window.innerWidth + 2),
      interactive: content?.querySelectorAll('button, input, select, textarea, a[href]').length || 0,
      overflowCandidates,
    };
  })()`);

  assert.equal(layout.shell, true, `${type} (${orientation.name}) did not render its mobile window shell. Renderer errors: ${runtimeErrors.join(' | ')}`);
  assert.equal(layout.content, true, `${type} (${orientation.name}) did not render mobile content.`);
  assert.equal(layout.unknown, false, `${type} (${orientation.name}) mapped to an unknown window.`);
  assert.equal(layout.uncaught, false, `${type} (${orientation.name}) rendered an uncaught-error screen.`);
  assert.equal(layout.bodyOverflow, false, `${type} (${orientation.name}) overflowed the app viewport horizontally.`);
  assert.equal(layout.contentOverflow, false, `${type} (${orientation.name}) contains clipped horizontal content: ${JSON.stringify(layout.overflowCandidates)}`);
  assert.equal(layout.shellFits, true, `${type} (${orientation.name}) escaped the mobile viewport.`);
  assert.equal(layout.closeVisible, true, `${type} (${orientation.name}) hid its close control.`);
  assert.equal(runtimeErrors.length, 0, `${type} (${orientation.name}) logged errors: ${runtimeErrors.join(' | ')}`);
  if (process.env.CAPTURE_RELEASE_PREVIEWS) {
    const previewDir = path.resolve(ROOT, process.env.CAPTURE_RELEASE_PREVIEWS); fs.mkdirSync(previewDir, { recursive: true });
    const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(previewDir, `${type}-${orientation.name}.png`), image.toPNG());
    if (type === 'inventory') {
      await win.webContents.executeJavaScript(`(() => { const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === 'Print Label'); button?.click(); return Boolean(button); })()`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const labelImage = await win.webContents.capturePage(); fs.writeFileSync(path.join(previewDir, `inventory-label-${orientation.name}.png`), labelImage.toPNG());
    }
  }

  if (type === 'quickSale') {
    const quickCheckout = await win.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('.mobile-modal-content');
      const root = document.querySelector('.gb-quick-checkout');
      const footer = document.querySelector('.gb-quick-checkout-totals');
      const customItem = Array.from(document.querySelectorAll('.gb-quick-checkout button'))
        .find((button) => button.textContent.includes('Custom item'));
      const editor = document.querySelector('.gb-quick-checkout .gb-sale-item-editor');
      const checkout = Array.from(footer?.querySelectorAll('button') || []).find((button) => button.textContent.includes('Checkout'));
      const contentRect = content?.getBoundingClientRect();
      const rootRect = root?.getBoundingClientRect();
      const footerRect = footer?.getBoundingClientRect();
      const checkoutRect = checkout?.getBoundingClientRect();
      return {
        contentOverflowY: content ? getComputedStyle(content).overflowY : '',
        rootFits: Boolean(contentRect && rootRect && rootRect.top >= contentRect.top - 2 && rootRect.bottom <= contentRect.bottom + 2),
        footerFits: Boolean(contentRect && footerRect && footerRect.top >= contentRect.top - 2 && footerRect.bottom <= contentRect.bottom + 2),
        checkoutVisible: Boolean(checkoutRect && checkoutRect.width >= 80 && checkoutRect.height >= 32 && checkoutRect.bottom <= window.innerHeight + 2),
        documentLocked: document.documentElement.scrollHeight <= window.innerHeight + 2 && document.body.scrollHeight <= window.innerHeight + 2,
        customItemPresent: Boolean(customItem),
        customEditorPresent: Boolean(editor),
      };
    })()`);
    assert.equal(quickCheckout.contentOverflowY, 'hidden', `Quick Checkout outer window remained scrollable in ${orientation.name}.`);
    assert.equal(quickCheckout.rootFits, true, `Quick Checkout escaped its mobile content area in ${orientation.name}.`);
    assert.equal(quickCheckout.footerFits, true, `Quick Checkout totals/footer was clipped in ${orientation.name}.`);
    assert.equal(quickCheckout.checkoutVisible, true, `Quick Checkout button was not visible in ${orientation.name}: ${JSON.stringify(quickCheckout)}`);
    assert.equal(quickCheckout.documentLocked, true, `Quick Checkout document remained scrollable in ${orientation.name}.`);
    assert.equal(quickCheckout.customItemPresent, false, `Quick Checkout exposed the custom-item form in ${orientation.name}.`);
    assert.equal(quickCheckout.customEditorPresent, false, `Quick Checkout opened a custom-item editor in ${orientation.name}.`);
  }
  if (type === 'checkout') {
    const checkout = await win.webContents.executeJavaScript(`(() => {
      const windowRoot = document.querySelector('.gb-checkout-window');
      const text = windowRoot?.textContent || '';
      const choices = Array.from(windowRoot?.querySelectorAll('input[type="checkbox"]') || []);
      return {
        text: text.replace(/\s+/g, ' ').trim().slice(0, 600),
        correctDue: text.includes('$164.15'),
        correctParts: text.includes('Parts:') && text.includes('$109.15'),
        correctLabor: text.includes('Labor:') && text.includes('$55.00'),
        splitChoices: choices.length >= 3,
      };
    })()`);
    assert.equal(checkout.correctDue, true, `Checkout total was not passed into the ${orientation.name} window: ${checkout.text}`);
    assert.equal(checkout.correctParts, true, `Checkout parts balance was missing in ${orientation.name}.`);
    assert.equal(checkout.correctLabor, true, `Checkout labor balance was missing in ${orientation.name}.`);
    assert.equal(checkout.splitChoices, true, `Checkout parts/labor choices were missing in ${orientation.name}.`);

    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.mobile-modal-bar button[aria-label="Close window"]')?.click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const bridgeStarted = await win.webContents.executeJavaScript(`(() => {
      window.__mobileCheckoutResult = undefined;
      window.api.openCheckout({ amountDue: 100, partsDue: 60, laborDue: 40, title: 'Bridge Test' })
        .then((result) => { window.__mobileCheckoutResult = result; });
      return typeof window.api.openCheckout === 'function';
    })()`);
    assert.equal(bridgeStarted, true, `Mobile checkout bridge was unavailable in ${orientation.name}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cardSelected = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.gb-checkout-window');
      const card = Array.from(root?.querySelectorAll('button') || []).find((button) => button.textContent.trim() === 'Card');
      card?.click();
      return Boolean(card);
    })()`);
    assert.equal(cardSelected, true, `Could not select Card in the bridged checkout in ${orientation.name}.`);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const completed = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.gb-checkout-window');
      const save = Array.from(root?.querySelectorAll('button') || []).find((button) => ['Save', 'Complete Checkout'].includes(button.textContent.trim()));
      save?.click();
      return Boolean(save && !save.disabled);
    })()`);
    assert.equal(completed, true, `Could not complete the bridged checkout in ${orientation.name}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await win.webContents.executeJavaScript(`window.__mobileCheckoutResult || null`);
    assert.equal(Number(result?.amountPaid || 0), 100, `Bridged checkout returned the wrong total in ${orientation.name}.`);
    assert.equal(Number(result?.appliedParts || 0), 60, `Bridged checkout returned the wrong parts amount in ${orientation.name}.`);
    assert.equal(Number(result?.appliedLabor || 0), 40, `Bridged checkout returned the wrong labor amount in ${orientation.name}.`);
  }

  if (type === 'clientUpdate') {
    const history = await win.webContents.executeJavaScript(`(async () => {
      const historyButton = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === 'History');
      historyButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const dialog = document.querySelector('.gb-client-update-history');
      const rect = dialog?.getBoundingClientRect();
      const close = dialog?.querySelector('button[aria-label="Close update history"]');
      return {
        buttonPresent: Boolean(historyButton),
        visible: Boolean(dialog && rect && rect.width > 280 && rect.height > 180),
        fits: Boolean(rect && rect.left >= -2 && rect.right <= window.innerWidth + 2 && rect.top >= -2 && rect.bottom <= window.innerHeight + 2),
        summaryCount: dialog?.querySelectorAll('.gb-client-update-history-summary > div').length || 0,
        closeVisible: Boolean(close && close.getBoundingClientRect().width >= 32),
        horizontalOverflow: Boolean(dialog && dialog.scrollWidth > dialog.clientWidth + 3),
      };
    })()`);
    assert.equal(history.buttonPresent, true, `Update History button was missing in ${orientation.name}.`);
    assert.equal(history.visible, true, `Update History did not open in ${orientation.name}.`);
    assert.equal(history.fits, true, `Update History escaped the viewport in ${orientation.name}.`);
    assert.equal(history.summaryCount, 4, `Update History summary was incomplete in ${orientation.name}.`);
    assert.equal(history.closeVisible, true, `Update History close control was unusable in ${orientation.name}.`);
    assert.equal(history.horizontalOverflow, false, `Update History clipped horizontally in ${orientation.name}.`);
  }

  if (type === 'calendar') {
    const opened = await win.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === 'Settings');
      button?.click();
      return Boolean(button);
    })()`);
    assert.equal(opened, true, `Calendar Settings button was missing in ${orientation.name}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settings = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.gb-calendar-settings-dialog');
      const body = dialog?.querySelector('.gb-calendar-settings-body');
      const close = dialog?.querySelector('button[aria-label="Close calendar settings"]');
      const footer = dialog?.querySelector('.gb-calendar-settings-footer');
      const rect = dialog?.getBoundingClientRect();
      const footerRect = footer?.getBoundingClientRect();
      const dialogStyle = dialog ? getComputedStyle(dialog) : null;
      const footerStyle = footer ? getComputedStyle(footer) : null;
      const childRects = dialog ? Array.from(dialog.children).map((child) => { const childRect = child.getBoundingClientRect(); return { className: child.className, left: childRect.left, right: childRect.right, top: childRect.top, bottom: childRect.bottom }; }) : [];
      return {
        visible: Boolean(dialog && rect && rect.width > 300 && rect.height > 180),
        fits: Boolean(rect && rect.left >= -2 && rect.right <= window.innerWidth + 2 && rect.top >= -2 && rect.bottom <= window.innerHeight + 2),
        scrollable: Boolean(body && body.scrollHeight > 0 && getComputedStyle(body).overflowY === 'auto'),
        noHorizontalClip: Boolean(body && body.scrollWidth <= body.clientWidth + 3),
        closeVisible: Boolean(close && close.getBoundingClientRect().width >= 32),
        footerVisible: Boolean(footerRect && rect && footerRect.left >= rect.left - 2 && footerRect.right <= rect.right + 2 && footerRect.bottom <= rect.bottom + 2),
        colorControls: dialog?.querySelectorAll('input[type="color"]').length || 0,
        colorDetails: dialog?.querySelectorAll('.gb-calendar-color-info small').length || 0,
        colorResetControls: dialog?.querySelectorAll('.gb-calendar-color-reset').length || 0,
        ambiguousDefaultButtons: Array.from(dialog?.querySelectorAll('.gb-calendar-color-row button') || []).filter((entry) => entry.textContent.trim() === 'Default').length,
        businessControls: dialog?.querySelectorAll('.gb-business-calendar-options input[type="checkbox"]').length || 0,
        dialogRect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
        footerRect: footerRect ? { left: footerRect.left, right: footerRect.right, top: footerRect.top, bottom: footerRect.bottom } : null,
        dialogStyle: dialogStyle ? { display: dialogStyle.display, flexDirection: dialogStyle.flexDirection } : null,
        footerStyle: footerStyle ? { position: footerStyle.position, width: footerStyle.width, marginLeft: footerStyle.marginLeft, transform: footerStyle.transform } : null,
        childRects,
      };
    })()`);
    assert.equal(settings.visible, true, `Calendar Settings did not become visible in ${orientation.name}.`);
    assert.equal(settings.fits, true, `Calendar Settings escaped the viewport in ${orientation.name}.`);
    assert.equal(settings.scrollable, true, `Calendar Settings content was not scrollable in ${orientation.name}.`);
    assert.equal(settings.noHorizontalClip, true, `Calendar Settings content clipped horizontally in ${orientation.name}.`);
    assert.equal(settings.closeVisible, true, `Calendar Settings close control was not usable in ${orientation.name}.`);
    assert.equal(settings.footerVisible, true, `Calendar Settings actions were not visible in ${orientation.name}: ${JSON.stringify(settings)}`);
    assert.ok(settings.colorControls >= 6, `Calendar Settings color controls did not load in ${orientation.name}.`);
    assert.equal(settings.colorDetails, settings.colorControls, `Calendar Settings color details did not match its controls in ${orientation.name}.`);
    assert.equal(settings.colorResetControls, settings.colorControls, `Calendar Settings Reset actions did not match its controls in ${orientation.name}.`);
    assert.equal(settings.ambiguousDefaultButtons, 0, `Calendar Settings still showed ambiguous Default color buttons in ${orientation.name}.`);
    assert.ok(settings.businessControls >= 3, `Calendar Settings business options did not load in ${orientation.name}.`);
    const saved = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.gb-calendar-settings-dialog');
      const save = Array.from(dialog?.querySelectorAll('button') || []).find((entry) => entry.textContent.trim().toLowerCase().startsWith('save'));
      save?.click();
      return Boolean(save);
    })()`);
    assert.equal(saved, true, `Calendar Settings Save action was missing in ${orientation.name}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stillOpen = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.gb-calendar-settings-dialog'))`);
    assert.equal(stillOpen, false, `Calendar Settings did not close after Save in ${orientation.name}.`);
    const budget = await win.webContents.executeJavaScript(`(async () => {
      const button = document.querySelector('.gb-calendar-week-actions button:first-child')
        || document.querySelector('.gb-calendar-budget-button');
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 75));
      const dialog = document.querySelector('[role="dialog"][aria-label="Daily purchasing budget"]');
      const rect = dialog?.getBoundingClientRect();
      const input = dialog?.querySelector('input[type="number"]');
      const cancel = Array.from(dialog?.querySelectorAll('button') || []).find((entry) => entry.textContent.trim() === 'Cancel');
      cancel?.click();
      return {
        buttonPresent: Boolean(button),
        visible: Boolean(dialog && rect && rect.width > 260 && rect.height > 180),
        fits: Boolean(rect && rect.left >= -2 && rect.right <= window.innerWidth + 2 && rect.top >= -2 && rect.bottom <= window.innerHeight + 2),
        inputUsable: Boolean(input && input.getBoundingClientRect().height >= 40),
        cancelPresent: Boolean(cancel),
      };
    })()`);
    assert.equal(budget.buttonPresent, true, `Calendar Budget button was missing beside Add in ${orientation.name}.`);
    assert.equal(budget.visible, true, `Calendar Budget editor did not open in ${orientation.name}.`);
    assert.equal(budget.fits, true, `Calendar Budget editor escaped the viewport in ${orientation.name}.`);
    assert.equal(budget.inputUsable, true, `Calendar Budget input was not touch-usable in ${orientation.name}.`);
    assert.equal(budget.cancelPresent, true, `Calendar Budget editor was missing Cancel in ${orientation.name}.`);
    const shiftRequest = await win.webContents.executeJavaScript(`(async () => {
      const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === 'Request Time Off');
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 75));
      const dialog = document.querySelector('.gb-calendar-shift-request-dialog');
      const rect = dialog?.getBoundingClientRect();
      const custom = Array.from(dialog?.querySelectorAll('button') || []).find((entry) => entry.textContent.trim() === 'Different Hours');
      custom?.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const times = dialog?.querySelectorAll('.gb-calendar-shift-request-times input[type="time"]') || [];
      const submit = Array.from(dialog?.querySelectorAll('button') || []).find((entry) => entry.textContent.trim() === 'Submit Shift Request');
      const close = dialog?.querySelector('button[aria-label="Close shift request"]');
      const body = dialog?.querySelector('.gb-calendar-shift-request-body');
      close?.click();
      return {
        buttonPresent: Boolean(button),
        visible: Boolean(dialog && rect && rect.width > 280 && rect.height > 260),
        fits: Boolean(rect && rect.left >= -2 && rect.right <= window.innerWidth + 2 && rect.top >= -2 && rect.bottom <= window.innerHeight + 2),
        noHorizontalClip: Boolean(body && body.scrollWidth <= body.clientWidth + 3),
        customTimes: times.length === 2,
        submitVisible: Boolean(submit && submit.getBoundingClientRect().height >= 36),
        closePresent: Boolean(close),
      };
    })()`);
    assert.equal(shiftRequest.buttonPresent, true, `Calendar Request Time Off button was missing in ${orientation.name}.`);
    assert.equal(shiftRequest.visible, true, `Calendar shift request dialog did not open in ${orientation.name}.`);
    assert.equal(shiftRequest.fits, true, `Calendar shift request dialog escaped the viewport in ${orientation.name}.`);
    assert.equal(shiftRequest.noHorizontalClip, true, `Calendar shift request dialog clipped horizontally in ${orientation.name}.`);
    assert.equal(shiftRequest.customTimes, true, `Calendar shift request custom hours were unavailable in ${orientation.name}.`);
    assert.equal(shiftRequest.submitVisible, true, `Calendar shift request submit action was not visible in ${orientation.name}.`);
    assert.equal(shiftRequest.closePresent, true, `Calendar shift request close control was missing in ${orientation.name}.`);
  }

  if (type === 'quoteGenerator') {
    const quoteClient = await win.webContents.executeJavaScript(`(async () => {
      const started = Date.now();
      while (!document.querySelector('.gb-quote-client-actions') && Date.now() - started < 2500) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const actions = document.querySelector('.gb-quote-client-actions');
      const add = Array.from(actions?.querySelectorAll('button') || []).find((entry) => entry.textContent.trim() === 'Add Client');
      add?.click();
      await new Promise((resolve) => setTimeout(resolve, 75));
      const creator = document.querySelector('.gb-quote-client-create');
      const panel = document.querySelector('.gb-quote-client-panel');
      const creatorRect = creator?.getBoundingClientRect();
      const actionsRect = actions?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      return {
        addPresent: Boolean(add),
        creatorVisible: Boolean(creatorRect && creatorRect.height > 40),
        directlyBelow: Boolean(creatorRect && actionsRect && creatorRect.top >= actionsRect.bottom - 2),
        fitsWidth: Boolean(creatorRect && panelRect && creatorRect.left >= panelRect.left - 2 && creatorRect.right <= panelRect.right + 2),
      };
    })()`);
    assert.equal(quoteClient.addPresent, true, `Quote Add Client button was missing in ${orientation.name}.`);
    assert.equal(quoteClient.creatorVisible, true, `Quote Add Client fields did not open in ${orientation.name}.`);
    assert.equal(quoteClient.directlyBelow, true, `Quote Add Client fields were not beneath the client buttons in ${orientation.name}.`);
    assert.equal(quoteClient.fitsWidth, true, `Quote Add Client fields overflowed their panel in ${orientation.name}.`);

    const promptCopy = await win.webContents.executeJavaScript(`(async () => {
      const addItem = Array.from(document.querySelectorAll('button'))
        .find((entry) => entry.textContent.trim() === '+ Add Item');
      addItem?.click();
      await new Promise((resolve) => setTimeout(resolve, 75));
      const copy = Array.from(document.querySelectorAll('button'))
        .find((entry) => entry.textContent.trim() === 'Copy AI Prompt');
      copy?.click();
      await new Promise((resolve) => setTimeout(resolve, 125));
      return {
        addItemPresent: Boolean(addItem),
        copyPresent: Boolean(copy),
        copied: document.body.textContent.includes('AI prompt copied to clipboard'),
      };
    })()`);
    assert.equal(promptCopy.addItemPresent, true, `Quote Add Item button was missing in ${orientation.name}.`);
    assert.equal(promptCopy.copyPresent, true, `Quote Copy AI Prompt button was missing in ${orientation.name}.`);
    assert.equal(promptCopy.copied, true, `Quote AI prompt did not copy in ${orientation.name}.`);
  }

  if (type === 'consultation') {
    const partnerEditor = await win.webContents.executeJavaScript(`(async () => {
      const partnerRadio = Array.from(document.querySelectorAll('input[type="radio"]')).find((entry) => entry.parentElement?.textContent.includes('Partners'));
      partnerRadio?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const add = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent.trim() === 'Add Partner');
      add?.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const editor = document.querySelector('.gb-partner-editor');
      const rect = editor?.getBoundingClientRect();
      return {
        radioPresent: Boolean(partnerRadio),
        addPresent: Boolean(add),
        editorVisible: Boolean(rect && rect.width > 280 && rect.height > 260),
        fits: Boolean(rect && rect.left >= -2 && rect.right <= window.innerWidth + 2 && rect.top >= -2 && rect.bottom <= window.innerHeight + 2),
        fields: editor?.querySelectorAll('input').length || 0,
        closePresent: Boolean(editor?.querySelector('button[aria-label="Close partner editor"]')),
      };
    })()`);
    assert.equal(partnerEditor.radioPresent, true, `Consultation Partners option was missing in ${orientation.name}.`);
    assert.equal(partnerEditor.addPresent, true, `Consultation Add Partner action was missing in ${orientation.name}.`);
    assert.equal(partnerEditor.editorVisible, true, `Partner editor did not open in ${orientation.name}.`);
    assert.equal(partnerEditor.fits, true, `Partner editor escaped the viewport in ${orientation.name}.`);
    assert.ok(partnerEditor.fields >= 6, `Partner editor fields were incomplete in ${orientation.name}.`);
    assert.equal(partnerEditor.closePresent, true, `Partner editor close control was missing in ${orientation.name}.`);
  }

  win.webContents.removeListener('console-message', consoleHandler);
}

async function run() {
  const vite = startVite();
  let viteOutput = '';
  vite.stdout.on('data', (chunk) => { viteOutput += String(chunk); });
  vite.stderr.on('data', (chunk) => { viteOutput += String(chunk); });
  try {
    await waitForServer();
    const win = new BrowserWindow({
      show: Boolean(process.env.CAPTURE_RELEASE_PREVIEWS),
      width: 390,
      height: 844,
      useContentSize: true,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    for (const orientation of ORIENTATIONS) {
      for (const type of WINDOWS) await inspectWindow(win, type, orientation);
    }
    win.destroy();
    console.log(`Mobile window layout checks passed for ${WINDOWS.length} windows in portrait and landscape.`);
  } catch (error) {
    if (viteOutput.trim()) console.error(viteOutput.trim());
    throw error;
  } finally {
    vite.kill();
  }
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
