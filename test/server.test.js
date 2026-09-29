import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { randomBytes } from 'node:crypto';
async function setup(t,overrides={},dependencies={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receivables-api-'));const runtime=createServer({...loadConfig({APP_MODE:'demo'}),port:0,databasePath:path.join(dir,'test.db'),providerSettingsPath:path.join(dir,'.secrets'),modelReady:false,...overrides,port:0,databasePath:path.join(dir,'test.db'),providerSettingsPath:path.join(dir,'.secrets'),accessMode:overrides.accessMode??(overrides.adminKeys?.length?'key':'local')},dependencies);const origin=await runtime.start();runtime.scheduler.stop();t.after(async()=>{await runtime.close();fs.rmSync(dir,{recursive:true,force:true});});const call=(url,body,headers={})=>fetch(origin+url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {...runtime,origin,call};}
const connectSmtp=app=>{app.email.write({host:'smtp.example.com',port:587,security:'starttls',username:'billing',password:'secret',from:'billing@example.com'});app.email.recordCheck();};
test('workspace boots with correct demo collection holds and no secrets',async t=>{const {call}=await setup(t);const response=await call('/api/workspace');const data=await response.json();assert.equal(response.status,200);assert.equal(data.collection.rows.length,7);assert.equal(data.allowLive,false);assert(!JSON.stringify(data).includes('apiKey'));assert(!JSON.stringify(data).includes('AWS_BEARER'));});
test('mutations require CSRF token and cross-origin requests are blocked',async t=>{const {call}=await setup(t);assert.equal((await call('/api/runs',{kind:'combined'})).status,403);assert.equal((await call('/api/session',undefined,{origin:'https://evil.example'})).status,403);assert.equal((await call('/api/session',undefined,{'x-forwarded-for':'192.0.2.1'})).status,403);});
test('internal model callbacks cannot be called by the browser',async t=>{const {call}=await setup(t);assert.equal((await call('/internal/run',{kind:'combined'})).status,403);});
test('live actions cannot be enabled by a request payload',async t=>{const {call}=await setup(t);const {csrf}=await (await call('/api/session')).json();const r=await call('/api/runs',{kind:'combined',mode:'live',allowLive:true},{'x-csrf-token':csrf});assert.equal(r.status,403);});
test('API run stores a complete inspectable preview',async t=>{const {call}=await setup(t);const {csrf}=await (await call('/api/session')).json();const response=await call('/api/runs',{kind:'combined',mode:'preview'},{'x-csrf-token':csrf});assert.equal(response.status,200);const run=await response.json();assert.equal(run.result.collection.ready,3);assert.equal(run.result.collection.held,3);const data=await (await call('/api/workspace')).json();assert.equal(data.runs[0].id,run.id);});
test('chat stores honest provider-unavailable response rather than fabricated LLM output',async t=>{const {call,store}=await setup(t);const {csrf}=await (await call('/api/session')).json();const headers={'x-csrf-token':csrf};const thread=await (await call('/api/threads',{},headers)).json();const response=await call('/api/chat',{threadId:thread.id,message:'Who owes us?'},headers);const text=await response.text();assert.match(text,/Connect an AI provider/);assert.equal(store.messages(thread.id).length,2);assert.equal(store.messages(thread.id)[1].metadata.error,true);});
test('configured workspace access key protects all API reads',async t=>{const {call}=await setup(t,{adminKeys:['test-key']});assert.equal((await call('/api/session')).status,401);assert.equal((await call('/api/session',undefined,{'x-admin-key':'test-key'})).status,200);});
test('local connected workspace opens all settings without a key and retains request protections',async t=>{
  const {call,app}=await setup(t,{...loadConfig({APP_MODE:'connected',APP_ACCESS_MODE:'local',ADMIN_KEYS:'old-key'}),port:0});
  const session=await(await call('/api/session')).json();
  assert.equal(session.accessMode,'local');assert.equal(session.isAdmin,true);assert.equal(session.canConfigureAgent,true);
  assert.equal((await call('/api/workspace')).status,200);
  assert.equal((await call('/api/admin/qonto')).status,200);
  assert.equal((await call('/api/session',undefined,{'x-admin-key':'stale-browser-key'})).status,200);
  assert.equal((await call('/api/admin/qonto/settings',{})).status,403);
  assert.equal((await call('/api/session',undefined,{origin:'https://other.example'})).status,403);
  assert.equal((await call('/api/session',undefined,{'x-forwarded-for':'192.0.2.1'})).status,403);
  assert(!app.qonto.missing().some(reason=>reason.includes('workspace access key')));
});
test('a configured public origin behind a trusted proxy is accepted; everything else stays blocked',async t=>{
  const proxied={host:'demo.example',origin:'https://demo.example','x-forwarded-for':'203.0.113.9','x-forwarded-proto':'https'};
  const exposed=await setup(t,{publicOrigins:['https://demo.example'],trustProxy:true});
  assert.equal((await exposed.call('/api/session',undefined,proxied)).status,200);
  assert.equal((await exposed.call('/api/session',undefined,{...proxied,host:'other.example',origin:'https://other.example'})).status,403);
  assert.equal((await exposed.call('/api/session',undefined,{...proxied,origin:'https://evil.example'})).status,403);
  const noProxy=await setup(t,{publicOrigins:['https://demo.example'],trustProxy:false});
  assert.equal((await noProxy.call('/api/session',undefined,proxied)).status,403);
  const closed=await setup(t);
  assert.equal((await closed.call('/api/session',undefined,proxied)).status,403);
  assert.throws(()=>loadConfig({APP_MODE:'demo',PUBLIC_ORIGIN:'http://demo.example'}),/plain https origins/);
  assert.throws(()=>loadConfig({APP_MODE:'demo',PUBLIC_ORIGIN:'https://demo.example/app'}),/plain https origins/);
});
test('a policy value that is not a whole number stops the app instead of switching its limit off',()=>{
  for(const [name,value] of [['MATERIALITY_CENTS','1_000_000'],['MAX_TOUCHES_PER_WEEK','two'],['MAX_SOURCE_AGE_MINUTES','15m'],['TERMINAL_TOUCHES','2.5'],['DEDUP_WINDOW_HOURS','-1'],['RETRY_AUTO_CAP_CENTS','1e5']])
    assert.throws(()=>loadConfig({APP_MODE:'demo',[name]:value}),new RegExp(`${name} must be a whole number, got ${value.replace('.','\\.')}`));
  const config=loadConfig({APP_MODE:'demo',MATERIALITY_CENTS:'1000000',MAX_TOUCHES_PER_WEEK:'2',DEDUP_WINDOW_HOURS:'48',TERMINAL_TOUCHES:'3',MAX_SOURCE_AGE_MINUTES:'15',RETRY_AUTO_CAP_CENTS:'200000'});
  assert.deepEqual([config.policy.materiality,config.policy.weeklyCap,config.policy.dedupHours,config.policy.terminalTouches,config.maxSourceAgeMs,config.policy.retryCap],[1000000,2,48,3,900000,200000]);
  const defaults=loadConfig({APP_MODE:'demo',MATERIALITY_CENTS:''});
  assert.equal(defaults.policy.materiality,1000000);assert.equal(defaults.policy.weeklyCap,2);
});
test('local access cannot start on a network interface',()=>{
  const config=loadConfig({APP_ACCESS_MODE:'local',APP_MODE:'connected'});
  assert.equal(config.host,'127.0.0.1');
  for(const host of ['0.0.0.0','::','192.168.1.1'])assert.throws(()=>createServer({...config,host}),/loopback/);
  assert.throws(()=>loadConfig({APP_ACCESS_MODE:'invalid'}),/APP_ACCESS_MODE/);
});
test('existing Qonto API key is the active connector and its sandbox status excludes credentials',async t=>{
  const config=loadConfig({APP_MODE:'connected',APP_ACCESS_MODE:'local',QONTO_ACCESS_TOKEN:'PRIVATE-QONTO-KEY',QONTO_STAGING_TOKEN:'PRIVATE-STAGING',QONTO_API_URL:'https://thirdparty-sandbox.staging.qonto.co/v2'});
  const {call,app,store}=await setup(t,{...config,port:0});
  assert.equal(app.service.qonto.config.oauth,undefined);
  const seen=[];app.service.qonto.request=async(url,options)=>{
    seen.push(String(url));assert.equal(options.headers.authorization,'Bearer PRIVATE-QONTO-KEY');assert.equal(options.headers['x-qonto-staging-token'],'PRIVATE-STAGING');
    assert.equal(new URL(url).origin,'https://thirdparty-sandbox.staging.qonto.co');
    if(String(url).includes('/bank_accounts'))return {bank_accounts:[{id:'bank-api',status:'active'}]};
    assert.equal(new URL(url).searchParams.get('bank_account_id'),'bank-api');
    return {transactions:[{id:'api-wire',side:'credit',status:'completed',currency:'EUR',amount_cents:123,settled_at:new Date().toISOString()}]};
  };
  const {csrf}=await(await call('/api/session')).json();const headers={'x-csrf-token':csrf};
  assert.equal((await call('/api/connections/qonto/sync',{},headers)).status,200);
  assert.equal(seen.length,2);assert.equal(store.listTransfers()[0].providerTransactionId,'api-wire');
  const snapshot=await(await call('/api/workspace')).json();
  assert.equal(snapshot.connections.qontoConfigured,true);assert.equal(snapshot.qonto.method,'api_key');assert.equal(snapshot.qonto.environment,'sandbox');
  assert.equal(snapshot.qonto.state,'configured');assert(!JSON.stringify(snapshot).includes('PRIVATE-'));
  for(const route of ['start','accounts','disconnect'])assert.equal((await call('/api/connections/qonto/'+route,{},headers)).status,409);
});
test('explicit OAuth mode never falls back to an old environment API key',async t=>{
  const config=loadConfig({APP_ACCESS_MODE:'local',QONTO_CONNECTION_MODE:'oauth',QONTO_ACCESS_TOKEN:'OLD-KEY'});
  const {app}=await setup(t,config);
  assert.equal(app.service.qonto.config.token,'');assert.equal(app.service.qonto.config.oauth,app.qonto);
  assert.equal(app.snapshot().connections.qontoConfigured,false);
});
test('local demo agent settings require CSRF and save a validated model without changing Lago credentials',async t=>{
  const {call,app}=await setup(t,{modelReady:true});
  const lago={...app.config.lago};app.agentSettings.call=async()=>({verified:true});
  const session=await(await call('/api/session')).json();assert.equal(session.canConfigureAgent,true);
  const data={model:'amazon.test:0',instructions:'Be concise.',revision:0};
  assert.equal((await call('/api/agent/settings',data)).status,403);
  const response=await call('/api/agent/settings',data,{'x-csrf-token':session.csrf});assert.equal(response.status,200);
  const workspace=await(await call('/api/workspace')).json();assert.equal(workspace.modelName,'amazon.test:0');
  assert.deepEqual(app.config.lago,lago);assert.equal(workspace.agentSettings.revision,1);
});
test('member keys are not supported: a WORKSPACE_KEYS key cannot open the workspace',async t=>{
  const {call}=await setup(t,{...loadConfig({APP_MODE:'demo',ADMIN_KEYS:'owner',WORKSPACE_KEYS:'member'}),modelReady:false});
  assert.equal((await call('/api/session',undefined,{'x-admin-key':'member'})).status,401);
  assert.equal((await call('/api/workspace',undefined,{'x-admin-key':'member'})).status,401);
  const session=await(await call('/api/session',undefined,{'x-admin-key':'owner'})).json();
  assert.equal(session.isAdmin,true);assert.equal(session.canConfigureAgent,true);
});
test('retention-policy rejection stays actionable and cannot change the saved model',async t=>{
  const {call,app}=await setup(t,{modelReady:true});
  const before=app.agentSettings.current();
  app.agentSettings.call=async()=>{throw Object.assign(new Error('This model is blocked by your AWS data-retention policy.'),{code:'model_retention_policy',status:422});};
  const {csrf}=await(await call('/api/session')).json();
  const response=await call('/api/agent/settings',{model:'us.anthropic.claude-fable-5',instructions:'',revision:0},{'x-csrf-token':csrf});
  assert.equal(response.status,422);const result=await response.json();assert.equal(result.code,'model_retention_policy');
  assert.match(result.error,/data-retention/);assert.deepEqual(app.agentSettings.current(),before);
  assert.equal(app.agentSettings.status().lastModelCheck.model,'us.anthropic.claude-fable-5');
  app.agentSettings.call=async()=>({verified:true});
  await app.agentSettings.save({model:'us.anthropic.claude-fable-5',instructions:'',revision:0});
  assert.equal(app.agentSettings.status().lastModelCheck,null);
});
test('chat uses saved model settings, clears incompatible provider history and records actual model metadata',async t=>{
  const calls=[];
  const {call,store}=await setup(t,{modelReady:true},{callModel:async(config,data)=>{
    if(data.operation==='check_model')return {verified:true};
    calls.push({model:config.modelName,instructions:config.agentInstructions,history:data.history});
    return {text:'Test reply',history:'[{"testHistory":true}]'};
  }});
  const {csrf}=await(await call('/api/session')).json();const headers={'x-csrf-token':csrf};
  const thread=await(await call('/api/threads',{},headers)).json();
  const chat=async()=>{const response=await call('/api/chat',{threadId:thread.id,message:'Hello'},headers);await response.text();};
  await chat();await chat();assert.equal(calls[1].history,'[{"testHistory":true}]');
  assert.equal((await call('/api/agent/settings',{model:'amazon.selected:0',instructions:'Be brief.',revision:0},headers)).status,200);
  await chat();assert.equal(calls[2].model,'amazon.selected:0');assert.equal(calls[2].instructions,'Be brief.');assert.equal(calls[2].history,'[]');
  const messages=store.messages(thread.id);assert.equal(messages.length,6);assert.equal(messages.at(-1).metadata.model,'amazon.selected:0');assert.equal(messages.at(-1).metadata.agentRevision,1);
});
test('chat refreshes Lago before answering when data was never synced or is stale, and never blocks on a busy workspace',async t=>{
  const contexts=[];
  const {call,app,store}=await setup(t,{mode:'connected',requiredSources:['lago'],modelReady:true},{callModel:async(config,data,env)=>{
    if(data.operation==='check_model')return {verified:true};
    const response=await fetch(env.INTERNAL_API_URL+'/internal/context',{method:'POST',headers:{'x-internal-token':env.INTERNAL_API_TOKEN,'content-type':'application/json'},body:'{}'});
    contexts.push(await response.json());return {text:'Test reply',history:'[]'};
  }});
  let refreshes=0;app.refresh=async()=>{refreshes++;store.health('lago','succeeded');return {};};
  const {csrf}=await(await call('/api/session')).json();const headers={'x-csrf-token':csrf};
  const thread=await(await call('/api/threads',{},headers)).json();
  const chat=async()=>{const response=await call('/api/chat',{threadId:thread.id,message:'Who owes us money?'},headers);return response.text();};
  assert.match(await chat(),/Refreshing invoices and payments from Lago/);assert.equal(refreshes,1);
  assert(contexts[0].sourceHealth.some(s=>s.source==='lago'&&s.status==='succeeded'));
  assert.doesNotMatch(await chat(),/Refreshing invoices/);assert.equal(refreshes,1);
  store.db.prepare("UPDATE source_health SET last_success_at=? WHERE source='lago'").run(new Date(Date.now()-60*60000).toISOString());
  app.busy=true;await chat();assert.equal(refreshes,1);assert.equal(contexts.length,3);app.busy=false;
  await chat();assert.equal(refreshes,2);
});
test('demo chat never refreshes from Lago',async t=>{
  const {call,app}=await setup(t,{modelReady:true},{callModel:async(config,data,env)=>{
    if(data.operation==='check_model')return {verified:true};
    await fetch(env.INTERNAL_API_URL+'/internal/context',{method:'POST',headers:{'x-internal-token':env.INTERNAL_API_TOKEN,'content-type':'application/json'},body:'{}'});
    return {text:'Test reply',history:'[]'};
  }});
  let refreshes=0;app.refresh=async()=>{refreshes++;return {};};
  const {csrf}=await(await call('/api/session')).json();const headers={'x-csrf-token':csrf};
  const thread=await(await call('/api/threads',{},headers)).json();
  await(await call('/api/chat',{threadId:thread.id,message:'Who owes us money?'},headers)).text();assert.equal(refreshes,0);
});
test('UI assets include a restrictive content policy and no external runtime scripts',async t=>{const {call}=await setup(t);const response=await call('/');assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await response.text(),/app.js/);assert.equal((await call('/.env')).status,404);});
test('a second process cannot open the same database and recover an active run',async t=>{const runtime=await setup(t);assert.throws(()=>createServer({...runtime.app.config,port:0}),/already owns this database/);});
test('manual preview cards persist in conversation history',async t=>{const {call,store}=await setup(t);const {csrf}=await (await call('/api/session')).json();const headers={'x-csrf-token':csrf};const thread=await (await call('/api/threads',{},headers)).json();const run=await (await call('/api/runs',{kind:'combined',mode:'preview',threadId:thread.id},headers)).json();assert.deepEqual(store.messages(thread.id)[0].metadata.runIds,[run.id]);});
test('manual payment allocation accepts an operator-chosen invoice and conserves amount',async t=>{const {call,store}=await setup(t);const {csrf}=await (await call('/api/session')).json();const transfer=store.listTransfers().find(t=>t.providerTransactionId==='wire_unknown');const response=await call('/api/reviews',{action:'approve',transferId:transfer.id,allocations:[{invoiceId:'linear',amountCents:100000}]},{'x-csrf-token':csrf});assert.equal(response.status,200);assert.equal(store.getReceipt(transfer.id).unappliedAmountCents,175000);});

test('Qonto OAuth HTTP flow requires authentication and CSRF, binds callback cookie, imports selected accounts and disconnects',async t=>{
  const config=loadConfig({APP_MODE:'connected',ADMIN_KEYS:'workspace-secret',QONTO_CLIENT_ID:'client',QONTO_CLIENT_SECRET:'client-secret',QONTO_ORGANIZATION_ID:'org-lago',QONTO_TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('hex')});
  const {call,app,origin,store}=await setup(t,{...config,port:0});
  // The test listener uses a random available port and registers that exact callback.
  app.config.port=Number(new URL(origin).port);app.config.qontoOAuth.redirectUri=`${origin}/oauth/qonto/callback`;
  let exchanges=0;
  app.qonto.fetcher=async(url,options)=>{
    if(url.endsWith('/token')){exchanges++;return Response.json({access_token:'private-access',refresh_token:'private-refresh',token_type:'Bearer',expires_in:3600});}
    if(url.endsWith('/organization'))return Response.json({organization:{id:'org-lago',legal_name:'Lago'}});
    if(url.includes('/bank_accounts'))return Response.json({bank_accounts:[{id:'bank-1',name:'Operations',currency:'EUR'}]});
    if(url.includes('/transactions'))return Response.json({transactions:[{id:'wire-1',side:'credit',status:'completed',amount_cents:12345,currency:'EUR',settled_at:new Date().toISOString()}]});
    if(url.endsWith('/consents')){assert.equal(options.method,'DELETE');return new Response(null,{status:204});}
    assert.fail('Unexpected provider call');
  };
  assert.equal((await call('/api/connections/qonto')).status,401);
  assert.equal((await call('/api/connections/qonto/start',{})).status,401);
  const auth={'x-admin-key':'workspace-secret'};
  assert.equal((await call('/api/connections/qonto/start',{},auth)).status,403);
  const {csrf}=await (await call('/api/session',undefined,auth)).json();auth['x-csrf-token']=csrf;
  const start=await call('/api/connections/qonto/start',{},auth);
  assert.equal(start.status,200);const cookie=start.headers.get('set-cookie').split(';')[0];
  const authorization=await start.json();assert(!JSON.stringify(authorization).includes('secret'));
  const state=new URL(authorization.url).searchParams.get('state');
  const callback=`${origin}/oauth/qonto/callback?state=${state}&code=private-code`;
  const forged=await fetch(callback,{redirect:'manual'});assert.equal(forged.status,303);assert.match(forged.headers.get('location'),/qonto=error/);assert.equal(exchanges,0);
  const approved=await fetch(callback,{redirect:'manual',headers:{cookie}});
  assert.equal(approved.status,303);assert.equal(approved.headers.get('location'),'/?qonto=connected#runs');
  assert.equal(approved.headers.get('referrer-policy'),'no-referrer');assert.equal(exchanges,1);
  assert.equal((await call('/api/workspace')).status,401); // OAuth consent is not workspace authentication.
  assert.equal((await call('/api/connections/qonto/accounts',{accountIds:['bank-1']},auth)).status,200);
  assert.equal((await call('/api/connections/qonto/sync',{},auth)).status,200);
  assert.equal(store.listTransfers()[0].amountCents,12345);
  const workspace=await (await call('/api/workspace',undefined,auth)).json();
  assert.equal(workspace.qonto.state,'connected');assert(!JSON.stringify(workspace).includes('private-access'));
  assert(!JSON.stringify(workspace).includes('private-refresh'));assert.equal(workspace.allowLive,false);
  const disconnected=await (await call('/api/connections/qonto/disconnect',{},auth)).json();assert.equal(disconnected.revoked,true);
  const again=await call('/api/connections/qonto/sync',{},auth);assert.notEqual(again.status,200);
  assert.equal(store.sourceHealth().find(s=>s.source==='qonto').status,'failed');
});

test('same host over a foreign protocol is not a valid API origin',async t=>{
  const {call,origin}=await setup(t);assert.equal((await call('/api/session',undefined,{origin:origin.replace('http:','https:')})).status,403);
});

test('administrator can save isolated sandbox configuration and start Qonto login without an organisation ID',async t=>{
  const runtime=await setup(t,{adminKeys:['owner-key']});
  const {call,app,origin,store}=runtime;
  app.config.port=Number(new URL(origin).port);app.config.qontoSandboxOAuth.redirectUri=origin+'/oauth/qonto/callback';
  const owner={'x-admin-key':'owner-key'};const session=await(await call('/api/session',undefined,owner)).json();
  assert.equal(session.isAdmin,true);owner['x-csrf-token']=session.csrf;
  const response=await call('/api/admin/qonto/settings',{environment:'sandbox',clientId:'sandbox-client',clientSecret:'PRIVATE-SECRET',stagingToken:'PRIVATE-STAGING'},owner);
  assert.equal(response.status,200);assert(!JSON.stringify(await response.json()).includes('PRIVATE-'));
  const start=await call('/api/admin/qonto/test/start',{},owner);assert.equal(start.status,200,JSON.stringify(runtime.getSandbox().oauth.missing()));
  const authorization=new URL((await start.json()).url);assert.equal(authorization.origin,'https://oauth-sandbox.staging.qonto.co');assert.equal(authorization.searchParams.has('organization_id'),false);
  runtime.getSandbox().oauth.fetcher=async url=>{
    if(url.endsWith('/token'))return Response.json({access_token:'a',refresh_token:'r',expires_in:3600,token_type:'Bearer'});
    if(url.endsWith('/organization'))return Response.json({organization:{id:'test-org',legal_name:'Test Company'}});
    if(url.includes('/bank_accounts'))return Response.json({bank_accounts:[{id:'test-account',name:'Test',currency:'EUR'}]});
    if(url.includes('/transactions'))return Response.json({transactions:[{id:'test-transfer',side:'credit',status:'completed',currency:'EUR',amount_cents:100,settled_at:new Date().toISOString()}]});
    assert.fail('unexpected request');
  };
  const callback=await fetch(origin+'/oauth/qonto/callback?state='+authorization.searchParams.get('state')+'&code=code',{redirect:'manual',headers:{cookie:start.headers.get('set-cookie').split(';')[0]}});
  assert.equal(callback.headers.get('location'),'/?qonto=sandbox-connected#runs');
  assert.equal((await call('/api/admin/qonto/test/accounts',{accountIds:['test-account']},owner)).status,200);
  const before=JSON.stringify({transfers:store.listTransfers(),health:store.sourceHealth()});
  const sync=await call('/api/admin/qonto/test/sync',{},owner);assert.equal(sync.status,200);assert.equal((await sync.json()).count,1);
  assert.equal(JSON.stringify({transfers:store.listTransfers(),health:store.sourceHealth()}),before);
  const changed=await call('/api/admin/qonto/settings',{environment:'sandbox',clientId:'different',clientSecret:'x',stagingToken:'y'},owner);assert.equal(changed.status,400);
});

test('SMTP settings require admin and CSRF, Gmail routes are absent and no send endpoint exists',async t=>{
  const {app,call}=await setup(t,{adminKeys:['owner']});app.email.check=async()=>({verified:true});
  const {csrf}=await(await call('/api/session',undefined,{'x-admin-key':'owner'})).json(),owner={'x-admin-key':'owner','x-csrf-token':csrf};
  const settings={host:'smtp.example.com',port:587,security:'starttls',username:'billing',password:'PRIVATE-smtp-secret',from:'billing@example.com'};
  assert.equal((await call('/api/admin/email/settings',settings,{'x-admin-key':'owner'})).status,403);
  assert.equal((await call('/api/admin/email/settings',settings,owner)).status,200);const snapshot=await(await call('/api/workspace',undefined,owner)).json();assert.equal(snapshot.email.state,'connected');assert(!JSON.stringify(snapshot).includes('PRIVATE-smtp-secret'));assert.equal(snapshot.gmail,undefined);
  for(const route of ['/api/connections/gmail/start','/api/email/send','/api/admin/email/send'])assert.equal((await call(route,{},owner)).status,404);
  const preview=await(await call('/api/runs',{kind:'combined',mode:'preview'},owner)).json();const draftRun=await(await call('/api/runs',{kind:'combined',mode:'drafts',previewId:preview.id},owner)).json();assert.equal(draftRun.status,'completed');assert(draftRun.result.collection.outcomes.every(o=>o.outcome==='drafted'));assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM email_drafts').get().count,3);
});

test('manual draft sends go only to the draft recipient and enforce SMTP check, admin, CSRF and duplicate protection',async t=>{
  const {app,store,call}=await setup(t,{adminKeys:['owner']});
  // Transport and access-control coverage; invoice preflight is covered in customer-memory.test.js.
  app.preflightDraft=async()=>{};
  const run=store.startRun('combined','drafts','test'),draft=store.saveDraft(run,'customer@example.com','Reminder','Test content');
  let calls=0;app.email.deliver=async(config,settings,data)=>{calls++;assert.equal(data.recipient,'customer@example.com');return {accepted:true,messageId:'<message@example.com>'};};
  const {csrf}=await(await call('/api/session',undefined,{'x-admin-key':'owner'})).json(),owner={'x-admin-key':'owner','x-csrf-token':csrf};
  const route=`/api/drafts/${draft.id}/send`;
  const unchecked=await call(route,{},owner);assert.equal(unchecked.status,409);assert.match((await unchecked.json()).error,/Set up and check SMTP/);assert.equal(store.draft(draft.id).status,'draft');assert.equal(calls,0);
  connectSmtp(app);
  assert.equal((await call(route,{}, {'x-admin-key':'owner'})).status,403);
  assert.equal(calls,0);
  const response=await call(route,{to:'other@example.com',cc:'other@example.com',bcc:'other@example.com'},owner),sent=await response.json();assert.equal(response.status,200);assert.equal(sent.recipient,'customer@example.com');assert.equal(sent.status,'accepted');
  assert.equal((await call(route,{},owner)).status,409);assert.equal(calls,1);assert.equal(store.draft(draft.id).recipient,'customer@example.com');
});
test('billing link refresh requires admin and CSRF, preserves reviewed text, and never sends',async t=>{
  const {app,store,call}=await setup(t,{adminKeys:['owner']});
  const run=store.startRun('dunning','drafts','test');
  const draft=store.saveDraft(run,'test@example.com','Update card','Update here: https://billing.example/old',{customerExternalId:'customer-one',url:'https://billing.example/old',expiresAt:'2020-01-01'});
  app.email.send=()=>assert.fail('Refreshing must not send');let lookups=0;
  app.service.lago.customerPortalLink=async externalId=>{lookups++;assert.equal(externalId,'customer-one');return {url:'https://billing.example/new',expiresAt:new Date(Date.now()+3600000).toISOString()};};
  const {csrf}=await(await call('/api/session',undefined,{'x-admin-key':'owner'})).json();
  const route=`/api/drafts/${draft.id}/refresh-link`;
  assert.equal((await call(route,{}, {'x-admin-key':'owner'})).status,403);
  assert.equal(lookups,0);
  const response=await call(route,{customerExternalId:'wrong-customer'},{'x-admin-key':'owner','x-csrf-token':csrf});
  assert.equal(response.status,200);const updated=await response.json();
  assert.equal(updated.body,'Update here: https://billing.example/new');assert.equal(updated.status,'draft');assert.equal(lookups,1);
});
test('uncertain draft submission cannot repeat, interrupted sends recover as unknown, explicit rejection can retry',async t=>{
  const {app,store}=await setup(t);app.preflightDraft=async()=>{};const run=store.startRun('dunning','drafts','test');connectSmtp(app);
  app.email.deliver=async()=>{throw Object.assign(Error('connection dropped'),{attempted:true});};
  const a=store.saveDraft(run,'original@example.com','Reminder','Body');await assert.rejects(app.sendDraft(a.id));assert.equal(store.draft(a.id).status,'unknown');await assert.rejects(app.sendDraft(a.id),/already submitted/);
  const b=store.saveDraft(run,'original@example.com','Reminder','Body');store.claimDraft(b.id,'original@example.com');store.recover();assert.equal(store.draft(b.id).status,'unknown');
  const c=store.saveDraft(run,'original@example.com','Reminder','Body');app.email.deliver=async()=>({accepted:false,attempted:false,message:'Rejected'});await assert.rejects(app.sendDraft(c.id),/Rejected/);assert.equal(store.draft(c.id).status,'failed');
  app.email.deliver=async()=>({accepted:true,messageId:'<confirmed@example.com>'});assert.equal((await app.sendDraft(c.id)).status,'accepted');
});
test('collection drafts address each customer billing email while automated runs never submit email, even with SMTP connected',async t=>{
  const {app}=await setup(t);connectSmtp(app);app.email.deliver=()=>assert.fail('schedules cannot send email');
  const emails=new Map(app.store.listInvoices().map(i=>[i.customerId,i.raw?.customer?.email||null])),rows=app.snapshot().collection.rows;
  assert(rows.every(r=>r.recipient===emails.get(r.customerId)));
  const result=await app.run('combined','drafts','schedule');assert.equal(result.status,'completed');assert.equal(app.store.drafts().length,3);
  assert(app.store.drafts().every(d=>d.recipient===emails.get(app.store.actionForDraft(d.id).customer_id)&&d.status==='draft'));assert.equal(new Set(app.store.drafts().map(d=>d.recipient)).size,3);
});

test('pause and resume expose current customer state without sending a draft',async t=>{
  const {call,app}=await setup(t);const {csrf}=await (await call('/api/session')).json();
  const initial=await (await call('/api/workspace')).json(),customerId=initial.collection.rows[0].customerId;
  let sends=0;app.email.send=async()=>{sends++;};
  for(const paused of [true,false]){
    assert.equal((await call('/api/customers/pause',{customerId,paused},{'x-csrf-token':csrf})).status,200);
    const snapshot=await (await call('/api/workspace')).json();
    assert.equal(snapshot.collection.rows.find(r=>r.customerId===customerId).paused,paused);
    assert.deepEqual(snapshot.drafts,initial.drafts);
  }
  assert.equal(sends,0);
});

test('customer history is readable, while review and draft changes require admin and CSRF',async t=>{
 const {app,store,call}=await setup(t,{adminKeys:['owner']});
 const run=await app.run('dunning','drafts','schedule'),draft=store.drafts()[0],customerId=store.actionForDraft(draft.id).customer_id;
 const {csrf}=await(await call('/api/session',undefined,{'x-admin-key':'owner'})).json();
 const owner={'x-admin-key':'owner','x-csrf-token':csrf};
 assert.equal((await call(`/api/customers/${customerId}/history`,undefined,owner)).status,200);
 for(const route of [`/api/customers/${customerId}/review`,`/api/drafts/${draft.id}/discard`,`/api/drafts/${draft.id}/refresh`,`/api/drafts/${draft.id}/resolve`]){
  assert.equal((await call(route,{note:'Reviewed'},{'x-admin-key':'owner'})).status,403);
 }
 assert.equal((await call(`/api/customers/${customerId}/review`,{note:'Account owner checked'},owner)).status,200);
 assert.equal((await call(`/api/drafts/${draft.id}/refresh`,{},owner)).status,200);
 assert.equal((await call(`/api/drafts/${draft.id}/discard`,{},owner)).status,200);
 assert.equal(store.draft(draft.id).status,'cancelled');assert.equal(run.status,'completed');
});

test('dunning settings save independently of AI availability and require admin and CSRF',async t=>{
 const {call}=await setup(t,{adminKeys:['admin']});
 const headers={'x-admin-key':'admin'},session=await(await call('/api/session',undefined,headers)).json();
 const data={amount:'1234.56',currency:'EUR',revision:0};
 assert.equal((await call('/api/agent/dunning-settings',data,headers)).status,403);
 const saved=await call('/api/agent/dunning-settings',data,{...headers,'x-csrf-token':session.csrf});assert.equal(saved.status,200);assert.equal((await saved.json()).amountMinor,123456);
 assert.equal((await(await call('/api/workspace',undefined,headers)).json()).dunningSettings.amount,'1234.56');
 assert.equal((await call('/api/agent/dunning-settings',data,{...headers,'x-csrf-token':session.csrf})).status,409);
});

test('alert configuration requires admin and CSRF, hides the webhook and sends nothing on save',async t=>{
 const {call,app}=await setup(t,{adminKeys:['admin']});
 app.alerts.fetcher=async()=>assert.fail('Saving must not post to Slack');
 const headers={'x-admin-key':'admin'},session=await(await call('/api/session',undefined,headers)).json();
 const data={enabled:true,channel:'slack',webhook:'https://hooks.slack.com/services/TEAM/BOT/secret',revision:0};
 assert.equal((await call('/api/agent/alerts',data,headers)).status,403);
 const response=await call('/api/agent/alerts',data,{...headers,'x-csrf-token':session.csrf});assert.equal(response.status,200);assert(!(await response.text()).includes(data.webhook));
});
