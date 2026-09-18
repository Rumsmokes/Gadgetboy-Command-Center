const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { app, BrowserWindow } = require('electron');

async function waitFor(win, expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Dashboard condition did not become true: ${expression}`);
}
app.whenReady().then(async () => {
  // Only external data boundaries are replaced. Render the actual Command Center
  // and its actual model, subscriptions, menus, and daughter-window handlers.
  const bundle = await esbuild.build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import CommandCenter from '../src/components/CommandCenter';const root=createRoot(document.getElementById('root'));const props={keyword:'',onOpenInvoices:()=>{},onOpenModal:(type,payload)=>window.opened={type,payload}};root.render(React.createElement(CommandCenter,props));window.showAttention=()=>root.render(React.createElement(CommandCenter,{...props,attentionRequest:1}));`, resolveDir: __dirname, loader: 'tsx' },
    bundle: true, platform: 'browser', format: 'iife', write: false,
    tsconfig: path.resolve(__dirname, '..', 'tsconfig.json'), loader: { '.css': 'empty' },
    plugins: [{ name: 'isolated-cloud-boundary', setup(build) {
      build.onResolve({ filter: /(?:^@\/lib\/supabase$|^\.\/supabase$)/ }, () => ({ path: 'cloud', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `const query={select(){return this},is(){return this},order(){return this},limit(){return Promise.resolve({data:[],error:null})}};export const supabase={from:()=>query,channel:()=>({on(){return this},subscribe(){return this}}),removeChannel:async()=>{}};`, loader: 'js' }));
    } }],
  });
  const win = new BrowserWindow({ show: false, width: 1200, height: 950, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('about:blank');
    await win.webContents.executeJavaScript(`document.body.innerHTML='<div id="root"></div>';window.rows=[];window.dbReads=0;window.syncCalls=0;window.calendar=[{id:91,category:'task',title:'Clean repair bench',workOrderId:0,saleId:0,date:new Date().toLocaleDateString('en-CA')}];window.api={getCustomers:async()=>{window.dbReads++;return []},getWorkOrders:async()=>{window.dbReads++;return window.rows},dbGet:async key=>{window.dbReads++;return key==='calendarEvents'?window.calendar:key==='settings'?[{ticketCleanupSettings:{enabled:false}}]:[]},cloudSyncCollection:async()=>{window.syncCalls++;return {ok:true,changedRows:[]}},cloudGetSyncStatus:async()=>({ok:true,lastSuccessAt:new Date().toISOString(),pendingSync:0}),onWorkOrdersChanged:cb=>{window.changed=cb;return ()=>{}},openNewWorkOrder:async()=>window.opened={type:'wrong-workorder'}};true;`);
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
    await waitFor(win, `!!window.changed && !document.querySelector('.command-center-loading')`);
    const record = id => ({ id, status: 'open', checkInAt: new Date().toISOString(), activityAt: new Date().toISOString(), productDescription: `Device ${id}`, customerName: `Client ${id}`, items: [], checkoutDate: null, workflowStage: 'Checked in' });
    async function update(row) {
      await win.webContents.executeJavaScript(`{const row=${JSON.stringify(row)};window.rows=[row,...window.rows.filter(old=>old.id!==row.id)];window.changed(row);}true;`);
    }
    const readsBeforeLiveUpdate = await win.webContents.executeJavaScript('window.dbReads');
    await update(record(1));
    await waitFor(win, `document.querySelector('.command-center-metrics button strong').textContent==='1' && document.querySelector('.queue').textContent.includes('Device 1')`);
    assert.equal(await win.webContents.executeJavaScript('window.dbReads'), readsBeforeLiveUpdate, 'A work-order row event must patch the live model without rereading unrelated collections.');
    const syncCallsBeforeRefresh = await win.webContents.executeJavaScript('window.syncCalls');
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent==='Refresh').click();true;`);
    await waitFor(win, `window.syncCalls>=${syncCallsBeforeRefresh + 8}`);
    await win.webContents.executeJavaScript(`document.querySelector('.command-center-metrics button').click();true;`);
    await waitFor(win, `document.querySelector('.command-center-panel').textContent.includes('Device 1')`);
    for (let id = 2; id <= 10; id++) await update(record(id));
    const expedited = { ...record(10), items: [{ repair: 'Expedited Service Fee' }] };
    await update(expedited);
    await waitFor(win, `document.querySelectorAll('.queue .command-center-row').length===8 && document.querySelector('.queue .command-center-row').textContent.includes('Device 10')`);
    await update({ ...expedited, workflowStage: 'Testing', workflowUpdatedAt: new Date().toISOString() });
    await waitFor(win, `!document.querySelector('.queue').textContent.includes('Device 10') && [...document.querySelectorAll('.command-center-stages button')].some(b=>b.querySelector('span').textContent==='Testing'&&b.querySelector('strong').textContent==='1')`);
    await update({ ...record(2), workflowStage: 'Parts', workflowUpdatedAt: new Date().toISOString(), items: [{ repair: 'HDMI port', requiresOrder: true, orderStatus: 'ordered' }] });
    await waitFor(win, `!document.querySelector('.queue').textContent.includes('Device 2') && document.querySelector('.command-center-metrics .parts strong').textContent==='1'`);
    await update({ ...record(2), workflowStage: 'Parts', workflowUpdatedAt: new Date().toISOString(), items: [{ repair: 'HDMI port', requiresOrder: true, orderStatus: 'delivered' }] });
    await waitFor(win, `document.querySelector('.queue .command-center-row').textContent.includes('Device 2')`);
    await update({ ...record(1), workflowStage: 'Pickup', workflowUpdatedAt: new Date().toISOString(), repairStatus: 'Not Repairable - Awaiting Pickup' });
    await waitFor(win, `!document.querySelector('.queue').textContent.includes('Device 1') && document.querySelector('.command-center-metrics .ready strong').textContent==='1'`);
    await update({ ...record(1), status: 'closed', workflowStage: 'Completed' });
    await waitFor(win, `![...document.querySelectorAll('.command-center-panel-record strong')].some(label=>label.textContent==='Device 1') && document.querySelector('.command-center-metrics .ready strong').textContent==='0'`);
    // An affected legacy auto-close is offered for review, never automatically
    // reopened. Verify staff's confirmed restore updates the active list live.
    const accidental = { ...record(11), status: 'closed', checkInAt: new Date(Date.now()-600000).toISOString(), checkoutDate: new Date().toISOString(), diagnosticSelection: { label: 'Diagnostic - $25', amount: 25 }, payments: [] };
    accidental.payments = [{ at: accidental.checkoutDate, applied: 25 }];
    await win.webContents.executeJavaScript(`window.api.dbUpdate=async(key,id,row)=>{window.rows=window.rows.map(old=>old.id===id?row:old);return row};window.confirm=()=>true;true;`);
    await update(accidental);
    await win.webContents.executeJavaScript(`window.showAttention();true;`);
    await waitFor(win, `document.querySelector('.command-center-panel h2').textContent==='Needs Attention' && [...document.querySelectorAll('.command-center-panel-record strong')].some(label=>label.textContent==='Device 11')`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.command-center-metrics button strong').textContent`), '9');
    await win.webContents.executeJavaScript(`{const row=[...document.querySelectorAll('.command-center-panel tr')].find(r=>r.querySelector('.command-center-panel-record strong')?.textContent==='Device 11');row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));}true;`);
    await waitFor(win, `[...document.querySelectorAll('button')].some(b=>b.textContent==='Restore Diagnostic Drop-Off to Active')`);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Restore Diagnostic Drop-Off to Active').click();true;`);
    await waitFor(win, `document.querySelector('.command-center-metrics button strong').textContent==='10' && window.rows.find(r=>r.id===11).checkoutDate===null`);
    await win.webContents.executeJavaScript(`document.querySelector('.command-center-agenda-strip button').click();true;`);
    await waitFor(win, `document.querySelector('.command-center-panel').textContent.includes('Clean repair bench')`);
    await win.webContents.executeJavaScript(`document.querySelector('.command-center-today-preview button').click();true;`);
    assert.deepEqual(await win.webContents.executeJavaScript('window.opened'), { type: 'calendar', payload: { calendarEventId: 91 } });
    console.log('Real Command Center runtime passed new check-in, live panel refresh, 8-row priority queue, testing, parts delivery, not-repairable pickup, close, and Tasks click routing.');
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
