import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Application } from '../src/application.js';
import { loadConfig } from '../src/config.js';
import { planDunning,executeDunning,paymentBehaviour,sourceHold,invoiceFileLink,paymentMethodDraft } from '../src/dunning.js';
import { normalizeLagoInvoice } from '../src/cash/connectors/lago.js';
import { ReconciliationService } from '../src/cash/service.js';

const date=days=>new Date(Date.now()-days*86400000).toISOString().slice(0,10);
test('invoice document links accept HTTPS and configured local HTTP, without credentials or unsafe schemes',()=>{
 const config={lago:{baseUrl:'http://api.lago.dev/api/v1'}};
 assert.equal(invoiceFileLink('https://files.example/invoice.pdf?signature=abc',config),'https://files.example/invoice.pdf?signature=abc');
 assert.equal(invoiceFileLink('http://api.lago.dev/invoice.pdf',config),'http://api.lago.dev/invoice.pdf');
 for(const value of [null,'javascript:alert(1)','file:///invoice.pdf','https://user:secret@example.com/file','https://example.com/a\nb','http://public.example/file'])assert.equal(invoiceFileLink(value,config),null);
 assert.equal(invoiceFileLink('http://localhost/file',{lago:{baseUrl:'https://api.getlago.com/api/v1'}}),null);
});
test('reminders and payment-method emails link only the grouped unpaid invoices',t=>{
 const {store,config}=setup(t);
 for(const [id,paid,customerId] of [['one',false,'c1'],['two',false,'c1'],['settled',true,'c1'],['other',false,'c2']]){
  const i=invoice(id,20000,{customerId,paymentStatus:paid?'succeeded':'pending',remainingAmountCents:paid?0:20000});i.raw.file_url=`https://files.example/${id}.pdf`;store.upsertInvoice(i);
 }
 const row=planDunning(store,config).rows.find(r=>r.customerId==='c1');
 for(const body of [row.draft.body,paymentMethodDraft(row,'https://billing.example/update').body]){
  assert(body.includes('https://files.example/one.pdf'));assert(body.includes('https://files.example/two.pdf'));
  assert(!body.includes('/settled.pdf'));assert(!body.includes('/other.pdf'));
 }
 assert(paymentMethodDraft(row,'https://billing.example/update').body.includes('https://billing.example/update'));
 const missing=invoice('missing');store.upsertInvoice(missing);
 const updated=planDunning(store,config).rows.find(r=>r.customerId==='c1');
 assert.equal(updated.invoices.find(i=>i.id==='missing').fileUrl,null);
 assert(!updated.draft.body.includes('View invoice: null'));
});
const invoice=(id='i1',amount=20000,extra={})=>({id,number:`INV-${id}`,customerId:'c1',customerName:'Acme',currency:'EUR',totalAmountCents:amount,remainingAmountCents:amount,paymentStatus:'pending',issuedAt:date(45),raw:{status:'finalized',payment_due_date:date(10),customer:{lago_id:'c1',external_id:'external-c1',email:'billing@acme.example'}},...extra});
const receipt=(id='t1',amount=20000,ref='INV-i1')=>({provider:'qonto',accountId:'a1',providerTransactionId:id,status:'posted',direction:'credit',amountCents:amount,currency:'EUR',bookedAt:new Date().toISOString(),senderName:'Acme',reference:ref});
function setup(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receivables-test-'));const store=new Store(path.join(dir,'test.db'));const config=loadConfig({APP_MODE:'demo'});const service=new ReconciliationService({store,lago:{},dryRun:true});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,config,service,dir};}

test('review rejection survives the immediate agent rerun and later reconciliation runs', async t => {
  const { store, config } = setup(t), app = new Application(store, config);
  const transfer = store.listTransfers().find(t => t.proposals.length);
  const proposal = transfer.proposals[0];
  const key = p => JSON.stringify(p.allocations.map(a => a.invoiceId).sort());
  await app.review({ action: 'reject', transferId: transfer.id, proposalId: proposal.id });
  assert(!store.listProposals(transfer.id).some(p => key(p) === key(proposal)));
  await app.run('reconciliation', 'preview');
  assert(!app.snapshot().transfers.find(t => t.id === transfer.id).proposals.some(p => key(p) === key(proposal)));
  assert.equal(store.getTransfer(transfer.id).reviewStatus, 'unreviewed');
  assert.equal(store.drafts().length, 0);
});
test('restoring the API-key connector rechecks old payment history instead of reusing an OAuth cursor',t=>{
  const {store}=setup(t);
  store.meta('qontoConnectionMode','oauth');store.setSyncState('qonto',{lastSyncedAt:'2026-09-01T00:00:00.000Z'});
  store.upsertInvoice(invoice());
  const config=loadConfig({APP_MODE:'connected',APP_ACCESS_MODE:'local',QONTO_ACCESS_TOKEN:'test-key'});
  new Application(store,config);
  assert.equal(store.getSyncState('qonto'),null);assert.equal(store.listInvoices().length,1);
  assert.equal(store.sourceHealth().find(s=>s.source==='qonto').status,'failed');
});

test('bank receipt holds an otherwise eligible reminder before it is recorded in Lago',t=>{const {store,config,service}=setup(t);store.upsertInvoice(invoice());assert.equal(planDunning(store,config).ready,1);service.ingestTransfer(receipt());const row=planDunning(store,config).rows[0];assert.equal(row.status,'held');assert.match(row.reason,/Received money/);assert(row.evidence.receiptId);});
test('amount alone does not hold unrelated customers',t=>{const {store,config,service}=setup(t);store.upsertInvoice(invoice());service.ingestTransfer({...receipt(),senderName:'Unknown unrelated payer',reference:'Services'});assert.equal(planDunning(store,config).ready,1);});
test('approved allocations hold collection until Lago confirms them',async t=>{const {store,config,service}=setup(t);store.upsertInvoice(invoice());const id=service.ingestTransfer(receipt());await service.approve({transferId:id,proposalId:store.listProposals(id)[0].id,actor:'test',execute:true});assert.equal(planDunning(store,config).rows[0].status,'held');assert.match(planDunning(store,config).rows[0].reason,/allocation/);});
test('remaining balance is Lago total_due, not recomputed from credit notes',()=>{const i=normalizeLagoInvoice({lago_id:'i1',number:'INV-i1',total_amount_cents:10000,total_paid_amount_cents:3000,credit_notes_amount_cents:2000,total_due_amount_cents:7000,currency:'EUR'});assert.equal(i.remainingAmountCents,7000);});
test('same customer in different currencies produces separate reminders',t=>{const {store,config}=setup(t);store.upsertInvoice(invoice());store.upsertInvoice(invoice('i2',30000,{currency:'USD'}));const p=planDunning(store,config);assert.equal(p.rows.length,2);assert.deepEqual(p.totals,{EUR:20000,USD:30000});});
test('self-billed invoices are never chased, other overdue invoices still are',t=>{const {store,config}=setup(t);const partner=invoice('i1');partner.raw.self_billed=true;store.upsertInvoice(partner);assert.equal(planDunning(store,config).rows.length,0);store.upsertInvoice(invoice('i2'));const plan=planDunning(store,config);assert.equal(plan.rows.length,1);assert.deepEqual(plan.rows[0].invoiceIds,['i2']);assert.equal(plan.ready,1);});
test('draft and non-overdue invoices cannot be chased',t=>{const {store,config}=setup(t);const i=invoice();i.raw.status='draft';store.upsertInvoice(i);assert.equal(planDunning(store,config).rows.length,0);i.raw.status='finalized';i.raw.payment_due_date=date(-2);store.upsertInvoice(i);assert.equal(planDunning(store,config).rows.length,0);});
test('missing and failed required payment sources hold collection',t=>{const {store,config}=setup(t);store.upsertInvoice(invoice());config.mode='connected';config.requiredSources=['lago','qonto'];assert.match(sourceHold(store,config),/lago, qonto/);store.health('lago','succeeded');store.health('qonto','failed');assert.equal(planDunning(store,config).held,1);store.health('qonto','succeeded');assert.equal(planDunning(store,config).ready,1);});
test('customer pauses persist and apply independently of chat',t=>{const {store,config}=setup(t);store.upsertInvoice(invoice());store.pause('c1',true,'Investigating a wire');assert.equal(planDunning(store,config).rows[0].reason,'Investigating a wire');store.pause('c1',false);assert.equal(planDunning(store,config).ready,1);});
test('a newly paid second invoice cancels a stale multi-invoice reminder',async t=>{const {store,config}=setup(t);store.upsertInvoice(invoice());store.upsertInvoice(invoice('i2'));const preview=planDunning(store,config);const runId=store.startRun('dunning','live','test');let sends=0;const result=await executeDunning({store,config,runId,preview,refresh:async()=>store.upsertInvoice(invoice('i2',20000,{remainingAmountCents:0,paymentStatus:'succeeded'})),createDraft:async()=>sends++,retry:async()=>assert.fail('unexpected retry')});assert.equal(sends,0);assert.equal(result.outcomes[0].outcome,'skipped');});
test('a bank receipt arriving after preview blocks execution',async t=>{const {store,config,service}=setup(t);store.upsertInvoice(invoice());const preview=planDunning(store,config),runId=store.startRun('dunning','live','test');const result=await executeDunning({store,config,runId,preview,refresh:async()=>service.ingestTransfer(receipt()),createDraft:async()=>assert.fail('must not send'),retry:async()=>assert.fail('must not retry')});assert.equal(result.outcomes[0].outcome,'skipped');});
test('ambiguous draft creation is never logged as sent and cannot be automatically replayed',async t=>{const {store,config}=setup(t);store.upsertInvoice(invoice());const result=await executeDunning({store,config,runId:store.startRun('dunning','live','test'),preview:planDunning(store,config),refresh:async()=>{},createDraft:async()=>{throw new Error('connection dropped');},retry:async()=>{}});assert.equal(result.outcomes[0].outcome,'unknown');assert.equal(store.actions('c1')[0].status,'unknown');assert.equal(planDunning(store,config).held,1);});
test('created drafts persistently suppress duplicates without recording sent contact',async t=>{const {store,config}=setup(t);store.upsertInvoice(invoice());await executeDunning({store,config,runId:store.startRun('dunning','live','test'),preview:planDunning(store,config),refresh:async()=>{},createDraft:async()=>({id:'saved-draft-1'})});assert.equal(store.actions('c1')[0].status,'drafted');assert.match(planDunning(store,config).rows[0].reason,/saved draft already exists/);assert.equal(planDunning(store,config,new Date(Date.now()+30*86400000)).held,1);});
test('behaviour uses one settlement per fully paid invoice and prefers payment date',()=>{const data=[1,2,3].map(n=>invoice(`i${n}`,20000,{paymentStatus:'succeeded',raw:{payment_due_date:'2026-08-10',payments:[{payment_status:'succeeded',paid_at:'2026-08-01',created_at:'2026-09-01'},{payment_status:'succeeded',paid_at:'2026-08-09',created_at:'2026-09-01'}]}}));assert.equal(paymentBehaviour(data).score,'good-payer');assert.equal(paymentBehaviour(data).median,-1);});
test('recovered in-flight actions remain uncertain after restart',t=>{const {store}=setup(t);store.upsertInvoice(invoice());const id=store.startRun('dunning','live','test');store.beginAction(id,{customerId:'c1',invoiceIds:['i1'],action:'reminder'});store.recover();assert.equal(store.run(id).status,'interrupted');assert.equal(store.actions('c1')[0].status,'unknown');});
test('shared coordinator excludes simultaneous collection and payment review',async t=>{const {store,config}=setup(t);const app=new Application(store,config);let release;const first=app.exclusive(()=>new Promise(resolve=>{release=resolve;}));await assert.rejects(app.run('combined','preview'),/already in progress/);release();await first;});
test('demo and connected databases cannot be mixed',t=>{const {store,config}=setup(t);new Application(store,config);assert.throws(()=>new Application(store,{...config,mode:'connected'}),/different workspace mode/);});
test('combined run keeps reconciliation and dunning results in one durable record',async t=>{const {store,config}=setup(t);const app=new Application(store,config);const run=await app.run('combined','preview');assert.equal(run.status,'completed');assert.equal(run.result.collection.rows.length,7);assert.equal(run.result.collection.held,3);assert.equal(run.result.collection.ready,3);assert.equal(run.result.collection.review,1);assert.equal(store.runs().length,1);});
test('old failed attempts cannot trigger a retry while a newer attempt is processing',t=>{const {store,config}=setup(t);const i=invoice();i.raw.customer.billing_configuration={payment_provider:'stripe'};i.payments=[{payment_status:'failed',created_at:'2026-08-01'},{payment_status:'pending',created_at:'2026-09-01'}];store.upsertInvoice(i);assert.equal(planDunning(store,config).held,1);assert.match(planDunning(store,config).rows[0].reason,/provider/);});

test('draft preflight failures permit a later retry; changed contents require another preview',async t=>{
  const {store,config}=setup(t);store.upsertInvoice(invoice());const preview=planDunning(store,config);
  await executeDunning({store,config,preview,runId:store.startRun('dunning','drafts','test'),refresh:async()=>{},createDraft:async()=>{throw Object.assign(Error('Draft storage unavailable'),{attempted:false});}});
  assert.equal(store.actions('c1')[0].status,'failed');assert.equal(planDunning(store,config).ready,1);
  preview.rows[0].draft.body='unexpected content';
  const result=await executeDunning({store,config,preview,runId:store.startRun('dunning','drafts','test'),refresh:async()=>{},createDraft:()=>assert.fail('changed content must be reviewed')});assert.equal(result.outcomes[0].outcome,'skipped');
});
test('connected draft execution works with financial writes disabled and old live mode is always rejected',async t=>{
  const {store,config,dir}=setup(t);config.mode='connected';config.providerSettingsPath=path.join(dir,'.secrets');config.allowLive=false;
  store.upsertInvoice(invoice());store.health('lago','succeeded');const app=new Application(store,config);
  app.refresh=async()=>({cases:[],summary:{}});let drafts=0;
  const saveDraft=store.saveDraft.bind(store);store.saveDraft=(...args)=>{drafts++;return saveDraft(...args);};
  const preview=await app.run('combined');const result=await app.run('combined','drafts','manual',null,preview.id);
  assert.equal(result.status,'completed');assert.equal(result.result.collection.outcomes[0].outcome,'drafted');assert.equal(drafts,1);
  await assert.rejects(app.run('combined','drafts','manual',null,preview.id),/already been executed/);
  config.allowLive=true;await assert.rejects(app.run('combined','live','schedule'),/removed/);assert.equal(drafts,1);
});
test('legacy live schedules are paused on startup without changing preview schedules',t=>{
  const {store,config}=setup(t);
  for(const mode of ['live','preview'])store.db.prepare('INSERT INTO schedules(id,name,kind,cron,timezone,mode,enabled,next_run_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(mode,mode,'combined','0 9 * * *','UTC',mode,1,'2026-01-01',new Date().toISOString());
  new Application(store,config);assert.equal(store.schedules().find(s=>s.id==='live').enabled,false);assert.equal(store.schedules().find(s=>s.id==='preview').enabled,true);
});

test('default workspace uses configured accounts and never seeds illustrative invoices',t=>{
  const {store}=setup(t),config=loadConfig({});
  assert.equal(config.mode,'connected');
  const app=new Application(store,config);
  assert.equal(app.snapshot().collection.rows.length,0);
  assert.equal(app.snapshot().transfers.length,0);
  assert.equal(store.meta('demoSeeded'),null);
});

test('reconciliation and dunning have distinct runs and only dunning updates customer memory or drafts',async t=>{
  const {store,config}=setup(t),app=new Application(store,config);
  const recon=await app.run('reconciliation','preview');
  assert.equal(recon.kind,'reconciliation');assert.equal(recon.result.collection,null);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM collection_memory').get().n,0);
  assert.equal(store.drafts().length,0);
  const dunning=await app.run('dunning','preview');
  assert.equal(dunning.kind,'dunning');assert.equal(dunning.result.collection.ready,3);
  assert.equal(dunning.result.collection.held,3);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM collection_memory').get().n,7);
  const saved=await app.run('dunning','drafts','manual',null,dunning.id);
  assert.equal(saved.kind,'dunning');assert.equal(store.drafts().length,3);
  assert(store.actions(saved.result.collection.rows.find(r=>r.status==='ready').customerId).some(a=>a.status==='drafted'));
  assert.equal((await app.run('combined','preview')).kind,'dunning');
});

test('reconciliation runs retain inspectable payment results independently of later syncs',async t=>{
  const {store,config}=setup(t),app=new Application(store,config);
  const run=await app.run('reconciliation','preview');
  const payments=run.result.reconciliation.payments;
  assert.equal(payments.length,4);
  const northstar=payments.find(p=>p.senderName==='NORTHSTAR');
  assert.equal(northstar.amountCents,480000);
  assert.equal(northstar.proposals[0].allocations[0].invoiceNumber,'INV-1042');
  assert.equal(northstar.proposals[0].autoEligible,true);
  assert.equal('raw' in northstar,false);
  app.service.ingestTransfer({provider:'qonto',accountId:'demo-operating',providerTransactionId:'later-payment',status:'posted',direction:'credit',amountCents:1000,currency:'EUR',bookedAt:new Date().toISOString(),senderName:'Later payer',reference:'Unmatched'});
  assert.equal(app.reconciliationPayments().length,5);
  assert.equal(store.run(run.id).result.reconciliation.payments.length,4);
});

test('source loading can import invoices and receipts without generating reconciliation suggestions',async t=>{
 const {store,service}=setup(t);
 service.lago={listInvoices:async()=>[invoice()]};
 service.qonto={listIncoming:async()=>[receipt()]};
 await service.syncInvoices({match:false});await service.syncProvider('qonto',{match:false});
 assert.equal(store.listInvoices().length,1);assert.equal(store.listTransfers().length,1);
 assert.equal(store.listTransfers()[0].proposals.length,0);
 service.rematchAll();assert(store.listTransfers()[0].proposals.length>0);
});
test('payment suggestions appear only for receipts included in a completed reconciliation run',async t=>{
 const {store,config,service}=setup(t);
 config.mode='connected';
 const app=new Application(store,config);
 store.upsertInvoice(invoice());service.ingestTransfer(receipt());
 const id=store.listTransfers()[0].id;
 assert(store.listTransfers().find(t=>t.id===id).proposals.length>0);
 assert.equal(app.snapshot().transfers[0].reconciliationChecked,false);
 assert.equal(app.snapshot().transfers[0].proposals.length,0);
 assert.equal(planDunning(store,{...config,requiredSources:[]}).rows[0].status,'held','dunning must still see bank evidence');
 const payments=app.reconciliationPayments();
 const dunning=store.startRun('dunning','preview','test');store.finishRun(dunning,{reconciliation:{payments}});
 assert.equal(app.snapshot().transfers[0].reconciliationChecked,false);
 const failed=store.startRun('reconciliation','preview','test');store.finishRun(failed,{reconciliation:{payments}},'Source unavailable');
 assert.equal(app.snapshot().transfers[0].reconciliationChecked,false);
 const run=store.startRun('reconciliation','preview','test');store.finishRun(run,{reconciliation:{payments}});
 assert.equal(app.snapshot().transfers[0].reconciliationChecked,true);
 assert(app.snapshot().transfers[0].proposals.length>0);
 service.ingestTransfer(receipt('new-transfer',25000,'INV-i1'));
 assert.equal(app.snapshot().transfers.find(t=>t.id!==id).reconciliationChecked,false);
});
