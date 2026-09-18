const assert=require('node:assert/strict');
require('ts-node').register({transpileOnly:true,compilerOptions:{module:'CommonJS',moduleResolution:'Node'}});
const {buildCommandCenterModel,liveCommandCenterPanelRecords}=require('../src/lib/commandCenter.ts');
const {attentionReasonsForWorkOrder}=require('../src/lib/workOrderLifecycle.ts');
const {deriveOperationalStage,isOperationallyTerminal}=require('../src/lib/repairWorkflow.ts');
const now=new Date('2026-09-10T15:00:00.000Z');
assert.equal(deriveOperationalStage({status:'open',workflowStage:'Checked in',repairStatus:'Testing In Progress'}),'Testing','A QR testing update must override a stale untimestamped stage.');
assert.equal(deriveOperationalStage({status:'open',workflowStage:'Testing',workflowUpdatedAt:'2026-09-10T14:00:00Z',repairStatus:'Ready for Pickup'}),'Testing','A timestamped workflow stage must beat stale descriptive text.');
assert.equal(deriveOperationalStage({status:'open',workflowStage:'Parts'},{partsReady:true}),'Repair','Delivered required parts must return a work order to Repair.');
assert.equal(deriveOperationalStage({status:'open',workflowStage:'Checked in',repairStatus:'Not Repairable - Awaiting Pickup'}),'Pickup');
for(const terminal of [
 {status:'closed'}, {status:'cancelled'}, {status:'void'}, {status:'archived'}, {status:'open',pickedUpAt:'2026-09-10T14:00:00Z'},
]) assert.equal(isOperationallyTerminal(terminal),true,`${terminal.status} tickets must be terminal.`);
assert.equal(isOperationallyTerminal({status:'open',workflowStage:'Testing'}),false,'A reopened active ticket must not stay terminal.');
const latestWorkflow=buildCommandCenterModel({now,workOrders:[{id:999,status:'open',workflowStage:'Testing',workflowUpdatedAt:'2026-09-10T14:00:00Z',repairStatus:'Repair Complete - Ready for Pickup',statusUpdate:'Testing In Progress'}]});
assert.equal(latestWorkflow.workOrders[0].stage,'Testing','A timestamped workflow transition must not be overridden by stale descriptive fields.');
const wo=(id,workflowStage,extra={})=>({id,status:'open',workflowStage,productDescription:`Device ${id}`,activityAt:'2026-09-09T12:00:00Z',items:[],...extra});
const input={now,workOrders:[
 wo(1,'Diagnosing'),wo(2,'Approval'),wo(3,'Parts',{partEta:'2026-09-15',items:[{description:'HDMI port',requiresOrder:true,orderStatus:'ordered'}]}),wo(4,'Parts',{partEta:'2026-09-09',items:[{description:'Fan',requiresOrder:true,orderStatus:'ordered'}]}),
 wo(5,'Repair',{items:[{description:'Expedited Service Fee'}]}),wo(6,'Testing'),wo(7,'Pickup',{pickupReadyAt:'2026-08-25'}),
 wo(8,'Completed',{status:'closed'}),wo(9,'Waiting Device'),wo(10,'Parts',{partEta:'2026-09-15',workflowException:true,items:[{description:'Power supply',requiresOrder:true,orderStatus:'ordered'}]}),
 wo(11,'Checked in',{repairStatus:'Repair Not Possible - Awaiting Pickup'}),
 wo(12,'Parts',{items:[{description:'USB-C port',requiresOrder:true,orderStatus:'delivered'}]}),
],customers:[],technicians:[]};
const model=buildCommandCenterModel(input);
assert.equal(model.stages.Diagnosing.length,1);
assert.equal(model.stages.Approval.length,1);
assert.equal(model.stages.Parts.length,3);
assert.equal(model.stages.Testing.length,1);
assert.ok(!model.repairQueue.some(row=>row.id===6),'Testing tickets belong in the Testing section and must leave today\'s repair queue.');
assert.equal(model.stages.Pickup.length,2);
assert.ok(!model.stages['Checked in'].some(row=>row.id===11),'Repair-not-possible tickets must override a stale Checked In stage.');
assert.ok(!model.repairQueue.some(row=>row.id===11),'Repair-not-possible tickets must leave today\'s actionable repair queue.');
assert.ok(model.readyForPickup.some(row=>row.id===11),'Repair-not-possible tickets must appear in Ready for Pickup.');
assert.ok(!model.activeWorkOrders.some(row=>row.id===11),'Repair-not-possible tickets must leave Active Work Orders while awaiting pickup.');
assert.ok(!model.activeWorkOrders.some(row=>row.id===7),'Repair-complete pickup tickets must leave Active Work Orders.');
assert.ok(!model.repairQueue.some(row=>row.id===3),'Future-ETA parts must stay out of today queue.');
assert.ok(!model.repairQueue.some(row=>row.id===4),'An overdue ETA must not return a work order until its required part is marked delivered.');
assert.ok(!model.repairQueue.some(row=>row.id===10),'A workflow exception must not bypass an undelivered required part.');
assert.ok(model.repairQueue.some(row=>row.id===12),'A work order whose required parts arrived must return to today queue.');
assert.equal(model.repairQueue[0].id,5,'Expedited ticket must sort first.');
assert.ok(!model.activeWorkOrders.some(row=>row.id===8),'Completed ticket must not be active.');
assert.ok(!model.repairQueue.some(row=>row.id===9),'Waiting-on-device ticket must not be actionable.');

const routedUpdates=buildCommandCenterModel({now,customers:[],technicians:[],workOrders:[
 wo(13,'Checked in',{repairStatus:'Diagnosis In Process',statusUpdate:'Diagnosis In Process'}),
 wo(14,'Diagnosing',{repairStatus:'Testing In Progress',statusUpdate:'Testing In Progress'}),
 wo(15,'Diagnosing',{repairStatus:'Ready for Pickup',statusUpdate:'Repair Complete - Ready for Pickup'}),
 wo(16,'Repair',{repairStatus:'Not Repairable - Awaiting Pickup',statusUpdate:'Repair Not Possible'}),
 wo(17,'Pickup',{repairStatus:'Picked Up',status:'closed',statusUpdate:'Picked Up / Ticket Closed',pickedUpAt:'2026-09-10T14:00:00Z'}),
]});
assert.deepEqual(routedUpdates.stages.Diagnosing.map(row=>row.id),[13],'Diagnosis updates must override a stale Checked In stage.');
assert.deepEqual(routedUpdates.stages.Testing.map(row=>row.id),[14],'Testing updates must override a stale Diagnosing stage.');
assert.deepEqual(routedUpdates.readyForPickup.map(row=>row.id),[15,16],'Completed and not-repairable updates must route to Ready for Pickup.');
assert.ok(!routedUpdates.activeWorkOrders.some(row=>[15,16,17].includes(Number(row.id))),'Pickup and closed tickets must leave Active Work Orders.');
assert.ok(!routedUpdates.repairQueue.some(row=>[14,15,16,17].includes(Number(row.id))),'Testing, pickup, not-repairable, and closed tickets must leave Today’s Repair Queue.');

const quickHistory=(id)=>wo(id,'Completed',{
 status:'closed',productCategory:'Game Console',items:[{repair:'HDMI Port Repair'}],
 diagnosisStartedAt:`2026-09-${id-7}T09:00:00Z`,repairCompletionDate:`2026-09-${id-7}T13:00:00Z`,
});
const ranked=buildCommandCenterModel({now,customers:[],technicians:[],workOrders:[
 quickHistory(20),quickHistory(21),
 wo(30,'Repair',{items:[{description:'Expedited Service Fee'}]}),
 wo(36,'Parts',{items:[{description:'Charging Port',requiresOrder:true,orderStatus:'delivered'}]}),
 wo(31,'Checked in',{productCategory:'Game Console',items:[{repair:'HDMI Port Repair'}]}),
 wo(32,'Checked in',{checkInAt:'2026-09-10T12:00:00Z'}),
 wo(33,'Diagnosing',{activityAt:'2026-09-10T11:00:00Z'}),
 wo(34,'Testing',{activityAt:'2026-09-10T10:00:00Z'}),
 wo(35,'Checked in',{checkInAt:'2026-09-05T12:00:00Z'}),
 ...Array.from({length:11},(_,index)=>wo(40+index,'Checked in',{activityAt:`2026-09-${String(index+1).padStart(2,'0')}T12:00:00Z`})),
]});
assert.deepEqual(ranked.repairQueue.slice(0,8).map(row=>row.id),[30,36,33,31,35,40,41,42],'Queue order must be expedited, parts-arrived, diagnosing, historically quick, stagnant, then ordinary work; Testing is tracked separately.');
assert.equal(ranked.repairQueuePreview.length,8,'Command Center queue preview must show at most eight work orders.');
assert.equal(ranked.repairQueue.length,17,'Open Full Queue must retain every eligible non-testing work order.');

const promoted=buildCommandCenterModel({now,customers:[],technicians:[],workOrders:ranked.workOrders.map(row=>row.id===30?{...row.source,status:'closed',workflowStage:'Completed'}:row.source)});
assert.ok(!promoted.repairQueuePreview.some(row=>row.id===30),'Closed work must leave the live repair queue.');
assert.equal(promoted.repairQueuePreview.length,8,'The next eligible repair must be promoted when a queue item leaves.');
assert.equal(promoted.repairQueuePreview[0].id,36,'Queue priority must be recalculated after an item leaves.');

const attentionModel=buildCommandCenterModel({now,customers:[{id:1,firstName:'Ada',lastName:'Lovelace',email:'ada@example.com'}],technicians:[{id:'tech-1',name:'Tech One'}],attentionSettings:{notStartedAttentionDays:2,staleAttentionDays:3,clientResponseAttentionDays:2},workOrders:[
 wo(60,'Checked in',{customerId:1,assignedTo:'tech-1',checkInAt:'2026-09-06T12:00:00Z'}),
],sales:[
 {id:70,status:'open',type:'sale',customerId:1,items:[],createdAt:'2026-09-09T12:00:00Z'},
 {id:71,status:'open',type:'consultation',customerId:1,items:[{description:'Consultation'}],createdAt:'2026-09-09T12:00:00Z'},
 {id:72,status:'open',type:'sale',customerId:1,items:[{description:'Phone Case',requiresOrder:true,orderStatus:'ordered',orderDate:'2026-09-10'}],createdAt:'2026-09-09T12:00:00Z'},
],calendarNotes:[{id:'n1',date:'2026-09-10',subject:'Call supplier',body:'Confirm shipment'}]});
assert.ok(attentionModel.needsAttention.some(row=>row.id===60&&row.attentionReasons.some(reason=>reason.code==='not-started')),'Stalled check-ins must enter Needs Attention with a reason.');
assert.ok(attentionModel.needsAttention.some(row=>row.id===70&&row.attentionReasons.some(reason=>reason.code==='missing-line-items')),'Empty sales must enter Needs Attention.');
assert.ok(attentionModel.needsAttention.some(row=>row.id===71&&row.attentionReasons.some(reason=>reason.code==='consultation-unscheduled')),'Unscheduled consultations must enter Needs Attention.');
assert.deepEqual(attentionModel.productDeliveries.map(row=>row.id),[72],'Ordered sale products must appear in Product Delivery.');
assert.deepEqual(attentionModel.today.notes.map(row=>row.id),['n1'],'Today notes must be projected into the Command Center agenda.');
const stalePanelRecord={...attentionModel.needsAttention.find(row=>row.id===60)};
const cleanModel=buildCommandCenterModel({now,customers:[{id:1,firstName:'Ada',lastName:'Lovelace'}],technicians:[{id:'tech-1',name:'Tech One'}],workOrders:[wo(60,'Repair',{customerId:1,assignedTo:'tech-1',items:[{repair:'HDMI Port Repair'}],lastTechnicianActivityAt:'2026-09-10T14:00:00Z'})]});
assert.equal(liveCommandCenterPanelRecords('Needs Attention',cleanModel,[stalePanelRecord]).length,0,'Resolved alerts must disappear from an already-open Needs Attention panel.');

const collectedModel=buildCommandCenterModel({now,customers:[],technicians:[],workOrders:[
 wo(80,'Checked in',{payments:[{at:'2026-09-10T13:00:00Z',applied:50,amount:50,change:0}]}),
 wo(81,'Completed',{status:'closed',payments:[{createdAt:'2026-09-10T14:00:00Z',applied:70,amount:100,change:30}]}),
],sales:[{id:82,status:'closed',items:[{description:'Cable'}],payments:[{paidAt:'2026-09-10T14:30:00Z',applied:20}],amountPaid:20}]});
assert.equal(collectedModel.collectedToday,140,'Collected Today must total applied payments recorded today across work orders and sales.');
assert.equal(collectedModel.paymentsToday,3,'Collected Today must count every payment recorded today regardless of timestamp field.');

const pickupBalanceModel=buildCommandCenterModel({now,customers:[],technicians:[],workOrders:[
 wo(83,'Pickup',{totals:{total:200,remaining:200},amountPaid:50,payments:[{at:'2026-09-10T13:00:00Z',applied:50,amount:50}]}),
 wo(84,'Pickup',{totals:{total:200,remaining:200},amountPaid:0,payments:[{at:'2026-09-10T13:00:00Z',applied:70,amount:100,change:30}]}),
]});
assert.deepEqual(pickupBalanceModel.readyForPickup.map(row=>row.remaining),[150,130],'Ready for Pickup must derive balances from the total and applied payment ledger instead of stale saved remaining values.');

const reasons=[
 ...attentionReasonsForWorkOrder({status:'open',workflowStage:'Approval',approvalRequestedAt:'2026-09-01',promisedAt:'2026-09-09',emailDeliveryStatus:'failed',unreadClientReplies:2,pendingSync:true},{now}),
 ...attentionReasonsForWorkOrder({status:'open',workflowStage:'Parts',partEta:'2026-09-08'},{now}),
];
for(const code of ['approval-overdue','promise-overdue','part-overdue','email-failed','client-reply-unread','sync-pending'])assert.ok(reasons.some(reason=>reason.code===code),`Missing ${code}`);
console.log('Command Center workflow projection checks passed.');
