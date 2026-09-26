const assert=require('node:assert/strict');require('ts-node').register({transpileOnly:true,compilerOptions:{module:'CommonJS',moduleResolution:'Node'}});const {buildCommandCenterModel}=require('../src/lib/commandCenter.ts');const today='2026-09-25T14:00:00.000Z';const payment={id:'pay-1',applied:25,at:today,paymentType:'Cash'};const model=buildCommandCenterModel({now:new Date(today),workOrders:[{id:1,customerName:'A',totals:{total:25},amountPaid:25,payments:[payment],paymentHistory:[payment],paymentLogs:[payment]}]});assert.equal(model.collectedToday,25);assert.equal(model.paymentsToday,1);const legacy=buildCommandCenterModel({now:new Date(today),workOrders:[{id:2,customerName:'B',amountPaid:50,checkoutDate:today,totals:{total:50}}]});assert.equal(legacy.collectedToday,0);
const cloverMatched = buildCommandCenterModel({
  now: new Date(today),
  workOrders: [{ id: 3, customerName: 'Diagnostic', payments: [{ id: 'clover-wo', amount: 35, paidAt: today, paymentType: 'Card' }] }],
  sales: [
    { id: 4, customerName: 'Retail', payments: [{ id: 'clover-sale', amount: 64.79, paidAt: today, paymentType: 'Card' }] },
    { id: 5, customerName: 'Quick Sale', payments: [{ id: 'clover-quick', amount: 3.5, paidAt: today, paymentType: 'Cash' }] },
  ],
});
assert.equal(cloverMatched.collectedToday, 103.29, 'daily intake equals the sum of recorded checkout payments across work orders, sales, and quick sales');
assert.equal(cloverMatched.paymentsToday, 3);

console.log('Collected Today ledger behavior passed.');
