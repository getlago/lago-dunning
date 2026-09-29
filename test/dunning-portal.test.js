import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Application } from '../src/application.js';
import { loadConfig } from '../src/config.js';
import { LagoConnector } from '../src/cash/connectors/lago.js';

function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dunning-portal-'));
  const store=new Store(path.join(dir,'workspace.db'));
  const config={...loadConfig({APP_MODE:'connected'}),requiredSources:[],providerSettingsPath:path.join(dir,'.secrets')};
  const app=new Application(store,config);
  app.refresh=async()=>({cases:[],summary:{}});
  app.email.send=async()=>assert.fail('No email should be sent');
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const add=(id,provider='stripe')=>store.upsertInvoice({id:`inv-${id}`,number:`INV-${id}`,customerId:id,customerName:id,currency:'EUR',totalAmountCents:10000,remainingAmountCents:10000,paymentStatus:'pending',issuedAt:'2026-01-01',raw:{status:'finalized',payment_due_date:'2026-01-15',customer:{external_id:`external-${id}`,email:`${id}@example.com`,billing_configuration:provider?{payment_provider:provider}:{}},payments:[{payment_status:'failed',created_at:'2026-02-01'}]}});
  return {app,store,add};
}
const connectSmtp=app=>{app.config.smtp={host:'smtp.example.com',port:587,security:'starttls',username:'billing',password:'secret',from:'billing@example.com'};app.email.recordCheck();};
const fresh=url=>({url,expiresAt:new Date(Date.now()+3600000).toISOString()});

test('Lago portal lookup encodes the customer ID, authenticates, and returns a bounded expiry',async()=>{
  const start=Date.now();let request;
  const lago=new LagoConnector({baseUrl:'https://api.lago.test/api/v1',apiKey:'test-key'},async(url,options)=>{request={url,options};return {customer:{portal_url:'https://billing.example/customer-portal/token'}};});
  const result=await lago.customerPortalLink('company/a?b');
  assert.equal(request.url,'https://api.lago.test/api/v1/customers/company%2Fa%3Fb/portal_url');
  assert.equal(request.options.headers.authorization,'Bearer test-key');
  assert.equal(result.url,'https://billing.example/customer-portal/token');
  assert(Date.parse(result.expiresAt)>=start+715*60000);
  assert(Date.parse(result.expiresAt)<=Date.now()+715*60000);
});

test('missing, unsafe, and unavailable portal links fail without inventing a URL',async()=>{
  for(const portal_url of [undefined,'javascript:alert(1)','https://user:password@billing.example/','http://public.example/','https://billing.example/a\nb']){
    const lago=new LagoConnector({baseUrl:'https://api.example',apiKey:'key'},async()=>({customer:{portal_url}}));
    await assert.rejects(lago.customerPortalLink('customer'));
  }
  const lago=new LagoConnector({baseUrl:'http://api.lago.dev/api/v1',apiKey:'key'},async()=>({customer:{portal_url:'http://app.lago.dev/customer-portal/token'}}));
  assert.equal((await lago.customerPortalLink('customer')).url,'http://app.lago.dev/customer-portal/token');
  await assert.rejects(lago.customerPortalLink(null),/external ID/);
});

test('saved payment-method drafts include only their own customer link; ordinary reminders do not fetch one',async t=>{
  const {app,store,add}=setup(t);add('first');add('second');add('manual',null);
  const calls=[];app.service.lago.customerPortalLink=async id=>{calls.push(id);return fresh(`https://billing.example/${id}`);};
  const preview=await app.run('dunning');assert.equal(calls.length,0);
  const result=await app.run('dunning','drafts','manual',null,preview.id);
  assert.equal(result.status,'completed');assert.equal(store.drafts().length,3);
  assert.deepEqual(calls.sort(),['external-first','external-second']);
  for(const id of ['first','second']){
    const draft=store.drafts().find(d=>d.portal_customer_external_id===`external-${id}`);
    assert(draft.body.includes(`https://billing.example/external-${id}`));
    assert.equal(draft.recipient,`${id}@example.com`);assert.equal(draft.status,'draft');
    assert(!draft.body.includes(`external-${id==='first'?'second':'first'}`));
    assert(draft.portal_expires_at);
  }
  assert.equal(store.drafts().filter(d=>!d.portal_url).length,1);
  assert(result.result.collection.outcomes.filter(o=>o.action==='card_fix').every(o=>o.draft.body.includes('https://billing.example/')));
});

test('portal failure creates no incomplete card-fix draft and permits another run',async t=>{
  const {app,store,add}=setup(t);add('first');
  app.service.lago.customerPortalLink=async()=>{throw Error('HTTP 403 sensitive details');};
  let preview=await app.run('dunning');
  const run=await app.run('dunning','drafts','manual',null,preview.id);
  assert.equal(run.result.collection.outcomes[0].outcome,'failed');
  assert.match(run.result.collection.outcomes[0].detail,/billing portal link/);
  assert(!run.result.collection.outcomes[0].detail.includes('sensitive'));
  assert.equal(store.drafts().length,0);assert.equal(store.actions('first')[0].status,'failed');
  app.service.lago.customerPortalLink=async()=>fresh('https://billing.example/new');
  preview=await app.run('dunning');
  await app.run('dunning','drafts','manual',null,preview.id);assert.equal(store.drafts().length,1);
});

test('expired links block email submission and can be refreshed without sending or changing the customer',async t=>{
  const {app,store}=setup(t);connectSmtp(app);const id=store.startRun('dunning','drafts','test');
  const old='https://billing.example/expired';
  const draft=store.saveDraft(id,'customer@example.com','Update payment method',`Hello\nUpdate here: ${old}`,{customerExternalId:'correct-customer',url:old,expiresAt:'2020-01-01'});
  await assert.rejects(app.sendDraft(draft.id),/link has expired/);
  assert.equal(store.draft(draft.id).status,'draft');
  app.service.lago.customerPortalLink=async customer=>{assert.equal(customer,'correct-customer');return fresh('https://billing.example/fresh');};
  const updated=await app.refreshDraftPortal(draft.id);
  assert.equal(updated.body,'Hello\nUpdate here: https://billing.example/fresh');
  assert.equal(updated.status,'draft');assert.equal(updated.recipient,'customer@example.com');
  app.service.lago.customerPortalLink=async()=>{throw Error('Unavailable');};
  await assert.rejects(app.refreshDraftPortal(draft.id));assert.equal(store.draft(draft.id).body,updated.body);
  store.finishDraft(draft.id,'accepted','sent');
  await assert.rejects(app.refreshDraftPortal(draft.id),/Only an unsent/);
});
