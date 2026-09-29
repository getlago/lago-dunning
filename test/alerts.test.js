import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Application} from '../src/application.js';
import {loadConfig} from '../src/config.js';
import {AlertSettings,validateSlackWebhook} from '../src/alerts.js';
const webhook='https://hooks.slack.com/services/TTEST/BTEST/secret';
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alerts-')),store=new Store(path.join(dir,'db'));
 const config={...loadConfig({APP_MODE:'connected'}),requiredSources:[],providerSettingsPath:path.join(dir,'.secrets')};
 const app=new Application(store,config);app.refresh=async()=>({cases:[],summary:{}});
 const sent=[];app.email.sendAlert=async message=>{sent.push(message);return {accepted:true,messageId:'alert'};};
 app.email.status=()=>({state:'connected',sender:'billing@example.com'});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const invoice={id:'i',number:'INV-1',customerId:'c',customerName:'Acme <!channel>',currency:'EUR',totalAmountCents:1500000,remainingAmountCents:1500000,paymentStatus:'pending',issuedAt:'2026-01-01',raw:{status:'finalized',payment_due_date:'2026-01-15',customer:{external_id:'c',email:'customer@example.com'}}};
 store.upsertInvoice(invoice);
 return {store,app,config,sent,invoice};
}
test('Slack URL validation restricts requests to incoming Slack webhooks',()=>{
 assert.equal(validateSlackWebhook(webhook),webhook);
 for(const value of ['http://hooks.slack.com/services/T/B/x','https://evil.test/services/T/B/x','https://hooks.slack.com.evil.test/services/T/B/x','https://hooks.slack.com:999/services/T/B/x','https://user:secret@hooks.slack.com/services/T/B/x','https://hooks.slack.com/services/T/B/x?secret=yes','https://hooks.slack.com/services/T/B/x#x'])assert.throws(()=>validateSlackWebhook(value));
});
test('alerts start disabled, saving sends nothing, and duplicate events remain suppressed across restarts',async t=>{
 const {store,app,sent,invoice}=setup(t);
 await app.run('dunning');assert.equal(sent.length,0);
 app.alerts.save({enabled:true,channel:'email',recipient:'owner@example.com',revision:0});assert.equal(sent.length,0);
 let run=await app.run('dunning');assert.equal(run.result.alerts.status,'sent');assert.equal(sent[0].recipient,'owner@example.com');assert(sent[0].body.includes('€15,000.00'));assert(sent[0].body.includes('INV-1'));
 assert.equal(store.actions('c').length,0);assert.equal(store.drafts().length,0);assert.equal(app.customerHistory('c').contacts.emailsSent,0);
 app.alerts=new AlertSettings(store,app.email);await app.run('dunning');assert.equal(sent.length,1);
 store.upsertInvoice({...invoice,remainingAmountCents:0,paymentStatus:'succeeded'});await app.run('dunning');
 store.upsertInvoice(invoice);await app.run('dunning');assert.equal(sent.length,2);
 await app.run('reconciliation');assert.equal(sent.length,2);
});
test('Slack secret is encrypted and omitted from statuses and snapshots; payload is plain text',async t=>{
 const {store,app}=setup(t);let request;
 app.alerts.fetcher=async(url,options)=>{request={url,options};return new Response('ok');};
 const status=app.alerts.save({enabled:true,channel:'slack',webhook,revision:0});
 assert(status.hasWebhook);assert(!JSON.stringify(status).includes(webhook));assert(!JSON.stringify(app.snapshot()).includes(webhook));
 assert(!store.db.prepare('SELECT ciphertext FROM alert_settings').get().ciphertext.includes(webhook));
 app.alerts.save({enabled:true,channel:'slack',webhook:'',revision:1});
 const run=await app.run('dunning');assert.equal(run.result.alerts.status,'sent');assert.equal(request.url,webhook);assert.equal(request.options.redirect,'error');
 const payload=JSON.parse(request.options.body);assert(payload.blocks.every(b=>b.text.type==='plain_text'));assert(!payload.text.includes('<!channel>'));
});
test('definite rejection backs off; unconfirmed submissions do not retry or fail the dunning run',async t=>{
 const {store,app}=setup(t);let calls=0;
 app.alerts.save({enabled:true,channel:'slack',webhook,revision:0});
 app.alerts.fetcher=async()=>{calls++;return new Response('revoked',{status:403});};
 let run=await app.run('dunning');assert.equal(run.status,'completed');assert.equal(run.result.alerts.status,'failed');
 await app.run('dunning');assert.equal(calls,1);
 store.db.prepare('UPDATE alert_deliveries SET next_at=NULL').run();
 app.alerts.fetcher=async()=>{calls++;throw Error('contains '+webhook);};
 run=await app.run('dunning');assert.equal(run.result.alerts.status,'unknown');assert(!JSON.stringify(run).includes(webhook));
 await app.run('dunning');assert.equal(calls,2);
});
test('interrupted submissions are not replayed and invalid saves leave configuration intact',async t=>{
 const {store,app}=setup(t);
 assert.throws(()=>app.alerts.save({enabled:true,channel:'email',recipient:'a@example.com,b@example.com',revision:0}));
 app.alerts.save({enabled:true,channel:'slack',webhook,revision:0});
 assert.throws(()=>app.alerts.save({enabled:false,channel:'slack',revision:0}),/changed/);
 app.alerts.fetcher=async()=>new Response('ok');await app.run('dunning');
 store.db.prepare("UPDATE alert_deliveries SET status='sending'").run();
 app.alerts=new AlertSettings(store,app.email,{fetcher:async()=>assert.fail('Must not replay')});
 await app.run('dunning');assert.equal(app.alerts.status().lastDelivery.status,'unknown');
});
