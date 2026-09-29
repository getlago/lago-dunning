import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Application} from '../src/application.js';
import {loadConfig} from '../src/config.js';
import {planDunning} from '../src/dunning.js';
import {contactSummary} from '../src/customer-memory.js';

const DAY=86400000;
test('simulated history never claims email submission or affects customer cadence',t=>{
 const {store,config}=setup(t),now=new Date();
 const row=planDunning(store,config,now).rows[0],runId=store.startRun('dunning','preview','test-data');
 for(const days of [1,3,8]){
  const id=store.beginAction(runId,{...row,deliveryMode:'simulation'});
  store.db.prepare("UPDATE collection_actions SET status='simulated_sent',contact_at=? WHERE id=?").run(new Date(now-days*DAY).toISOString(),id);
 }
 const summary=contactSummary(store,'one',config,row.invoiceIds,now);
 assert.equal(summary.simulatedContacts,3);assert.equal(summary.customerContacts,0);assert.equal(summary.lastContactAt,null);
 assert.equal(summary.emailsSent,0);assert.equal(summary.lastEmailAt,null);
 assert.equal(summary.weeklyContacts,0);assert.equal(summary.invoiceContacts,0);assert.equal(summary.nextEligibleAt,null);
 assert.equal(planDunning(store,config,now).rows[0].status,'ready');
});
const invoice=(id='one',email=`${id}@example.com`)=>({id:`invoice-${id}`,number:`INV-${id}`,customerId:id,customerName:id,currency:'EUR',totalAmountCents:10000,remainingAmountCents:10000,paymentStatus:'pending',issuedAt:'2026-01-01',raw:{status:'finalized',payment_due_date:'2026-01-15',customer:{external_id:id,email}}});
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'customer-memory-')),file=path.join(dir,'workspace.db'),store=new Store(file);
 const config={...loadConfig({APP_MODE:'connected'}),requiredSources:[],providerSettingsPath:path.join(dir,'.secrets')};
 const app=new Application(store,config);app.refresh=async()=>({cases:[],summary:{}});connectSmtp(app);
 const sent=[];app.email.send=async d=>{sent.push(d);return {messageId:'test-message'};};
 store.upsertInvoice(invoice());
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,app,config,sent,file};
}
function connectSmtp(app){app.config.smtp={host:'smtp.example.com',port:587,security:'starttls',username:'billing',password:'secret',from:'billing@example.com'};app.email.recordCheck();}
async function save(app){const run=await app.run('dunning','drafts','schedule');assert.equal(run.status,'completed');return app.store.drafts()[0];}

test('submission atomically updates memory, counts a customer contact, and starts cooldown at send time',async t=>{
 const {store,app,config,sent}=setup(t),draft=await save(app),action=store.actionForDraft(draft.id);
 store.db.prepare('UPDATE collection_actions SET created_at=? WHERE id=?').run(new Date(Date.now()-8*DAY).toISOString(),action.id);
 await app.sendDraft(draft.id);
 assert.equal(sent.length,1);assert.equal(sent[0].recipient,'one@example.com');assert.equal(store.actionForDraft(draft.id).status,'sent');assert.equal(store.actionForDraft(draft.id).delivery_mode,'customer');
 const history=app.customerHistory('one');assert.equal(history.contacts.customerContacts,1);assert.equal(history.contacts.weeklyContacts,1);assert.equal(history.contacts.pendingDrafts,0);
 assert.equal(history.contacts.emailsSent,1);assert.equal(history.contacts.lastEmailAt,store.draft(draft.id).sent_at);
 assert(history.events.some(e=>e.event_type==='email_submitted'&&e.delivery_mode==='customer'));
 assert.match(planDunning(store,config).rows[0].reason,/cooldown/);
 assert.equal(planDunning(store,config,new Date(Date.now()+49*3600000)).rows[0].status,'ready');
 await assert.rejects(app.sendDraft(draft.id),/already submitted/);assert.equal(sent.length,1);
});

test('email sent count excludes saved drafts, local captures, and unconfirmed submissions',async t=>{
 const {app,store}=setup(t),draft=await save(app);
 assert.equal(app.customerHistory('one').contacts.emailsSent,0);
 store.finishDraft(draft.id,'captured','Earlier local capture');
 assert.equal(app.customerHistory('one').contacts.emailsSent,0);
 store.finishDraft(draft.id,'unknown','Unconfirmed submission');
 assert.equal(app.customerHistory('one').contacts.emailsSent,0);
 assert.equal(app.customerHistory('one').contacts.lastEmailAt,null);
});

test('customers sharing a billing address never merge histories',async t=>{
 const {store,app,sent}=setup(t);store.upsertInvoice(invoice('one','billing@example.com'));store.upsertInvoice(invoice('two','billing@example.com'));await save(app);
 const first=store.drafts().find(d=>store.actionForDraft(d.id).customer_id==='one');await app.sendDraft(first.id);assert.deepEqual(sent.map(d=>d.recipient),['billing@example.com']);
 assert.equal(app.customerHistory('one').contacts.customerContacts,1);assert.equal(app.customerHistory('two').contacts.customerContacts,0);
 assert.equal(app.customerHistory('two').contacts.pendingDrafts,1);
});

for(const [name,change,expected] of [
 ['fully paid',({store})=>store.upsertInvoice({...invoice(),remainingAmountCents:0,paymentStatus:'succeeded'}),/no longer eligible/],
 ['partially paid',({store})=>store.upsertInvoice({...invoice(),remainingAmountCents:5000}),/balance, invoices/],
 ['paused',({store})=>store.pause('one',true,'Account owner investigating'),/Account owner investigating/],
 ['disputed',({store})=>{const i=invoice();i.raw.disputed=true;store.upsertInvoice(i);},/disputed/],
 ['new invoice',({store})=>store.upsertInvoice({...invoice(),id:'additional',number:'ADDITIONAL'}),/balance, invoices/],
 ['missing source',({config})=>{config.requiredSources=['lago'];},/incomplete or stale/],
 ['bank receipt',({app})=>app.service.ingestTransfer({provider:'qonto',accountId:'one',providerTransactionId:'wire',status:'posted',direction:'credit',amountCents:10000,currency:'EUR',bookedAt:'2026-02-01',senderName:'one',reference:'INV-one'}),/Received money/]
])test(`send rechecks ${name} after draft approval`,async t=>{
 const context=setup(t),draft=await save(context.app);let refreshed=0;
 context.app.refresh=async()=>{refreshed++;change(context);return {cases:[],summary:{}};};
 await assert.rejects(context.app.sendDraft(draft.id),expected);assert.equal(refreshed,1);assert.equal(context.sent.length,0);
 assert.equal(context.store.draft(draft.id).status,'draft');assert(context.app.customerHistory('one').events.some(e=>e.event_type==='send_blocked'));
});

test('uncertain delivery blocks repeat contact across restart and requires an explicit recorded resolution',async t=>{
 const {app,store,config,file}=setup(t),draft=await save(app);
 app.email.send=async()=>{throw Object.assign(Error('Connection lost'),{attempted:true});};
 await assert.rejects(app.sendDraft(draft.id));assert.equal(store.actionForDraft(draft.id).status,'unknown');
 const reopened=new Store(file);try{reopened.recover();assert.equal(reopened.actionForDraft(draft.id).status,'unknown');assert.match(planDunning(reopened,config).rows[0].reason,/uncertain/);}finally{reopened.close();}
 await assert.rejects(app.sendDraft(draft.id),/already submitted/);
 await app.resolveDraftDelivery(draft.id,{outcome:'not_sent',note:'Verified no submission in the provider log'});
 assert.equal(store.actionForDraft(draft.id).status,'drafted');assert.equal(app.customerHistory('one').contacts.customerContacts,0);
 app.email.send=async()=>({messageId:'confirmed'});await app.sendDraft(draft.id);assert.equal(app.customerHistory('one').contacts.customerContacts,1);
});

test('recovering interrupted submission keeps its draft and customer memory uncertain together',async t=>{
 const {app,store}=setup(t),draft=await save(app);
 store.claimDraft(draft.id,'one@example.com');assert.equal(store.actionForDraft(draft.id).status,'sending');
 store.recover();assert.equal(store.draft(draft.id).status,'unknown');assert.equal(store.actionForDraft(draft.id).status,'unknown');
});

test('discarding an unsent stale draft releases its duplicate hold without counting a contact',async t=>{
 const {app,store,config}=setup(t),draft=await save(app);await app.discardDraft(draft.id);
 assert.equal(store.actionForDraft(draft.id).status,'cancelled');assert.equal(planDunning(store,config).rows[0].status,'ready');
 assert.equal(app.customerHistory('one').contacts.customerContacts,0);assert(app.customerHistory('one').events.some(e=>e.event_type==='draft_discarded'));
});

test('weekly cap and terminal escalation use actual contacts; human reset retains history and cooldown',async t=>{
 const {app,store,config}=setup(t);
 for(const days of [6,3,0]){
  const row=planDunning(store,config).rows[0],run=store.startRun('dunning','drafts','test');
  const id=store.beginAction(run,{...row,action:'reminder',deliveryMode:'customer'});store.finishAction(id,'sent','submitted');
  store.db.prepare('UPDATE collection_actions SET contact_at=? WHERE id=?').run(new Date(Date.now()-days*DAY).toISOString(),id);
 }
 assert.equal(planDunning(store,config).rows[0].status,'review');
 const run=await app.run('dunning');assert.equal(run.result.collection.rows[0].status,'review');assert.equal(app.snapshot().escalations.length,1);
 await app.reviewCustomer('one',{note:'Reviewed with account owner',resetCadence:true});
 assert.match(planDunning(store,config).rows[0].reason,/Weekly contact limit/);
 assert.equal(app.customerHistory('one').contacts.customerContacts,3);assert.equal(app.customerHistory('one').contacts.invoiceContacts,0);
 assert(app.customerHistory('one').events.some(e=>e.event_type==='cadence_reset'));
});

test('earlier test-inbox sends never count as customer contacts; customer sends start the cadence',t=>{
 const {store,config}=setup(t),row=planDunning(store,config).rows[0],run=store.startRun('dunning','drafts','test');
 const old=store.beginAction(run,{...row,deliveryMode:'test'});store.finishAction(old,'test_sent','test');
 let summary=contactSummary(store,'one',config,row.invoiceIds);assert.equal(summary.customerContacts,0);assert.equal(summary.weeklyContacts,0);assert.equal(summary.nextEligibleAt,null);
 const id=store.beginAction(run,{...row,deliveryMode:'customer'});store.finishAction(id,'sent','submitted');
 summary=contactSummary(store,'one',config,row.invoiceIds);assert.equal(summary.customerContacts,1);assert.equal(summary.weeklyContacts,1);assert(summary.nextEligibleAt);
});

test('sending is refused with 409 until SMTP is set up and checked, and the draft stays unsent',async t=>{
 const {app,store,config,sent}=setup(t),draft=await save(app),smtp=config.smtp;
 for(const change of [{host:''},{...smtp,port:2525}]){config.smtp=change;await assert.rejects(app.sendDraft(draft.id),e=>e.status===409&&/Set up and check SMTP/.test(e.message));}
 assert.equal(sent.length,0);assert.equal(store.draft(draft.id).status,'draft');assert.equal(store.actionForDraft(draft.id).status,'drafted');
 config.smtp=smtp;await app.sendDraft(draft.id);assert.equal(sent.length,1);
});

test('legacy accepted drafts migrate out of pending memory with an honest unknown delivery mode',async t=>{
 const {store,app,file}=setup(t),draft=await save(app),action=store.actionForDraft(draft.id);
 store.db.prepare("UPDATE email_drafts SET status='accepted',sent_at=? WHERE id=?").run(new Date().toISOString(),draft.id);
 store.db.prepare("UPDATE collection_actions SET context_json=NULL,draft_id=NULL,delivery_mode='legacy' WHERE id=?").run(action.id);
 const reopened=new Store(file);try{
  assert.equal(reopened.actionForDraft(draft.id).status,'legacy_sent');assert(reopened.actionForDraft(draft.id).context_json);
  assert.equal(reopened.actionForDraft(draft.id).delivery_mode,'legacy');
  assert.throws(()=>reopened.db.exec('DELETE FROM collection_events'),/immutable/);
 }finally{reopened.close();}
});

test('human attention records resolve when the triggering overdue balance is paid',async t=>{
 const {store,app}=setup(t);store.upsertInvoice({...invoice(),totalAmountCents:1500000,remainingAmountCents:1500000});
 await app.run('dunning');assert.equal(app.snapshot().escalations.length,1);
 await app.run('dunning');assert.equal(app.customerHistory('one').events.filter(e=>e.event_type==='escalated').length,1);
 store.upsertInvoice({...invoice(),remainingAmountCents:0,paymentStatus:'succeeded'});await app.run('dunning');
 assert.equal(app.snapshot().escalations.length,0);assert.equal(app.customerHistory('one').status,'resolved');
 assert(app.customerHistory('one').events.some(e=>e.event_type==='escalation_resolved'));
});

for(const [name,lags,score,tone,subject] of [
 ['good payer',[-1,0,0],'good-payer','gentle',/Quick reminder/],
 ['sometimes late',[-1,0,6],'occasionally-late','neutral',/Following up/],
 ['repeat late',[5,10,20],'repeat-late','firm',/Past due notice/],
 ['insufficient history',[15,20],'occasionally-late','neutral',/Following up/]
])test(`${name} receives the original policy's ${tone} tone`,async t=>{
 const {store,app,config}=setup(t);
 for(const [index,lag] of lags.entries()){
  const due=new Date(Date.now()-(60+index*30)*DAY),paid=new Date(+due+lag*DAY),historical=invoice();
  store.upsertInvoice({...historical,id:`history-${index}`,number:`HIST-${index}`,remainingAmountCents:0,paymentStatus:'succeeded',issuedAt:new Date(+due-30*DAY).toISOString().slice(0,10),raw:{...historical.raw,payment_due_date:due.toISOString().slice(0,10)},payments:[{payment_status:'succeeded',paid_at:paid.toISOString(),created_at:paid.toISOString()}]});
 }
 const row=planDunning(store,config).rows[0];assert.equal(row.score,score);assert.equal(row.tone,tone);assert.match(row.draft.subject,subject);
 const draft=await save(app);assert.match(draft.subject,subject);assert.equal(app.snapshot().drafts[0].tone,tone);
 assert(draft.body.includes('INV-one'));assert(draft.body.includes('€100.00'));
});

test('refreshing a stale draft updates its balance and tone without losing customer history or sending',async t=>{
 const {store,app,sent}=setup(t),draft=await save(app);
 store.upsertInvoice({...invoice(),remainingAmountCents:5000});
 await assert.rejects(app.sendDraft(draft.id),/balance, invoices/);
 const updated=await app.refreshDunningDraft(draft.id);assert(updated.body.includes('€50.00'));assert.equal(updated.status,'draft');assert.equal(sent.length,0);
 assert.equal(JSON.parse(store.actionForDraft(draft.id).context_json).amountCents,5000);
 assert(app.customerHistory('one').events.some(e=>e.event_type==='draft_refreshed'));
 await app.sendDraft(draft.id);assert.equal(sent.length,1);
});

test('draft creation and its action link survive interruption as one durable operation',t=>{
 const {store,config,file}=setup(t),row=planDunning(store,config).rows[0],run=store.startRun('dunning','drafts','test');
 const actionId=store.beginAction(run,{...row,deliveryMode:'customer'});
 const draft=store.saveDraft(run,row.recipient,row.draft.subject,row.draft.body,null,{actionId});
 const reopened=new Store(file);try{reopened.recover();assert.equal(reopened.actionForDraft(draft.id).status,'drafted');assert.equal(reopened.draft(draft.id).status,'draft');}finally{reopened.close();}
 const before=store.drafts().length;
 assert.throws(()=>store.saveDraft(run,row.recipient,'Invalid','Invalid',null,{actionId:'missing'}),/exactly one/);assert.equal(store.drafts().length,before);
});

test('a successful source label without a valid refresh timestamp cannot authorize sending',async t=>{
 const {app,store,config,sent}=setup(t),draft=await save(app);config.requiredSources=['lago'];
 store.health('lago','succeeded');store.db.prepare("UPDATE source_health SET last_success_at=NULL WHERE source='lago'").run();
 await assert.rejects(app.sendDraft(draft.id),/incomplete or stale/);assert.equal(sent.length,0);
});
