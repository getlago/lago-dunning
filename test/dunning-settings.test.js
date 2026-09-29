import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Application} from '../src/application.js';
import {loadConfig} from '../src/config.js';
import {planDunning} from '../src/dunning.js';
import {dunningSettings,saveDunningSettings} from '../src/dunning-settings.js';
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dunning-settings-')),file=path.join(dir,'db'),store=new Store(file);
 const config={...loadConfig({APP_MODE:'connected'}),requiredSources:[],providerSettingsPath:path.join(dir,'.secrets')};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,config,file};
}
function add(store,id,amount,currency='EUR'){
 store.upsertInvoice({id,number:id,customerId:id,customerName:id,currency,totalAmountCents:amount,remainingAmountCents:amount,paymentStatus:'pending',issuedAt:'2026-01-01',raw:{status:'finalized',payment_due_date:'2026-01-15',customer:{external_id:id,email:`${id}@example.com`}}});
}
function connectSmtp(app){app.config.smtp={host:'smtp.example.com',port:587,security:'starttls',username:'billing',password:'secret',from:'billing@example.com'};app.email.recordCheck();}
test('threshold persists across restart and respects zero and three decimal currencies',t=>{
 const {store,config,file}=setup(t);
 assert.equal(dunningSettings(store,config).amount,'10000.00');
 assert.equal(saveDunningSettings(store,config,{amount:'123.456',currency:'KWD',revision:0}).amountMinor,123456);
 const reopened=new Store(file);try{assert.equal(dunningSettings(reopened,config).currency,'KWD');assert.equal(dunningSettings(reopened,config).revision,1);}finally{reopened.close();}
 assert.equal(saveDunningSettings(store,config,{amount:'10000',currency:'JPY',revision:1}).amountMinor,10000);
 for(const input of [{amount:'0',currency:'EUR'},{amount:'-1',currency:'EUR'},{amount:'1.001',currency:'EUR'},{amount:'1.5',currency:'JPY'},{amount:'1e3',currency:'EUR'},{amount:'9'.repeat(20),currency:'EUR'},{amount:'50',currency:'INVALID'}])assert.throws(()=>saveDunningSettings(store,config,{...input,revision:2}));
 assert.throws(()=>saveDunningSettings(store,config,{amount:'100',currency:'EUR',revision:1}),/changed/);
 assert.equal(dunningSettings(store,config).revision,2);
});
test('threshold applies at equality, per currency, and to grouped overdue balances',t=>{
 const {store,config}=setup(t);
 saveDunningSettings(store,config,{amount:'100',currency:'EUR',revision:0});
 add(store,'below',9999);add(store,'equal',10000);add(store,'above',10001);add(store,'foreign',1,'USD');
 const rows=planDunning(store,config).rows;
 assert.equal(rows.find(r=>r.customerId==='below').status,'ready');
 for(const id of ['equal','above','foreign'])assert.equal(rows.find(r=>r.customerId===id).status,'review');
 assert.match(rows.find(r=>r.customerId==='foreign').reason,/no currency conversion/);
 const i=store.listInvoices().find(i=>i.customerId==='below');store.upsertInvoice({...i,id:'second',number:'second',remainingAmountCents:1,totalAmountCents:1});
 assert.equal(planDunning(store,config).rows.find(r=>r.customerId==='below').status,'review');
});
test('lowering threshold blocks an already saved draft before SMTP; schedules use the saved threshold',async t=>{
 const {store,config}=setup(t),app=new Application(store,config);add(store,'customer',50000);
 app.refresh=async()=>({cases:[],summary:{}});app.email.send=async()=>assert.fail('Must not send');connectSmtp(app);
 const run=await app.run('dunning','drafts','schedule');assert.equal(run.status,'completed');const draft=store.drafts()[0];assert(draft);
 saveDunningSettings(store,config,{amount:'100',currency:'EUR',revision:0});
 await assert.rejects(app.sendDraft(draft.id),/automatic collection threshold/);
 assert.equal(store.draft(draft.id).status,'draft');
 await app.discardDraft(draft.id);
 const scheduled=await app.run('dunning','drafts','schedule');assert.equal(scheduled.result.collection.review,1);assert.equal(scheduled.result.collection.outcomes.length,0);
});
