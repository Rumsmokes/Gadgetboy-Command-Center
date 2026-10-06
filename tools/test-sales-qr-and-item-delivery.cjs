const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const main=read('app/electron/electron-main.ts'),mobile=read('src/mobile/mobile-api.ts'),receipt=read('src/workorders/CustomerReceiptWindow.tsx'),workOrder=read('src/workorders/NewWorkOrderWindow.tsx'),panel=read('src/workorders/ClientUpdatePanel.tsx'),edge=read('supabase/functions/client-updates/index.ts'),qrStatus=read('supabase/functions/qr-status/index.ts');
for(const source of [main,mobile]){assert.match(source,/\.eq\('record_type', type\)[\s\S]{0,220}\.order\('created_at',[\s\S]{0,100}\.limit\(1\)/,'QR lookup must deterministically use one active token.');}
assert.doesNotMatch(receipt,/qrRecordType|qrGetStatusUrl\?\.\(/, 'Customer receipts must never expose an internal ticket-status QR.');
assert.doesNotMatch(receipt,/Google Review QR|SCAN ME/, 'Customer receipts must not print a customer-facing QR either.');
assert.match(workOrder,/receiptType:\s*'repair'/, 'Work-order checkout must identify its receipt type for the repair QR.');
assert.doesNotMatch(receipt,/setQrError\(|shouldRenderStatusQr|qrReady/,'Customer receipts must print without QR rendering state.');
for(const phrase of ['Mark Items Delivered','selectedItemIndexes','itemIndexes'])assert.match(panel,new RegExp(phrase));
for(const phrase of ['items_delivered','Select at least one delivered item','orderStatus:\s*'+'\x27received\x27','Some Items Delivered'])assert.match(edge,new RegExp(phrase));
for(const phrase of ['publicClientView','auth.getUser()','Sign in before opening this staff QR workflow'])assert.match(qrStatus,new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
console.log('Sales QR and per-item delivery checks passed.');
