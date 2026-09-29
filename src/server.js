import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from './config.js';
import { Store } from './store.js';
import { Application } from './application.js';
import { Scheduler, nextRun, saveSchedule } from './scheduler.js';
import { pythonCall } from './ai.js';
import { lockDatabase } from './lock.js';
import { QONTO_COOKIE } from './qonto-oauth.js';
import { contextForModel, runForModel, MODEL_CONTEXT_VERSION } from './model-context.js';
import { saveDunningSettings } from './dunning-settings.js';
import { sourceHold } from './dunning.js';
import { QontoSettings, QontoSandbox } from './qonto-settings.js';

const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createServer(config=loadConfig(),{callModel=pythonCall}={}) {
  if(config.accessMode==='local'&&config.host!=='127.0.0.1')throw new Error('Local access requires the loopback address 127.0.0.1.');
  const qontoSettings=new QontoSettings(config);
  const unlock=lockDatabase(config.databasePath);
  let store,app,sandbox;
  const getSandbox=()=>sandbox??=new QontoSandbox(config);
  try {store=new Store(config.databasePath);app=new Application(store,config);}catch(error){store?.close();unlock();throw error;}
  app.agentSettings.call=callModel;
  store.recover();
  const csrf=randomBytes(32).toString('hex'),internal=new Map(),chatBusy=new Set();
  const scheduler=new Scheduler(store,(...args)=>app.run(...args));
  let origin;
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      const host=req.headers.host;
      const publicOrigins=config.publicOrigins??[],allowedHosts=new Set([`localhost:${server.address()?.port}`,`127.0.0.1:${server.address()?.port}`,...publicOrigins.map(o=>new URL(o).host)]);
      if(!allowedHosts.has(host)||(!config.trustProxy&&(req.headers.forwarded||req.headers['x-forwarded-for']))) return json(res,403,{error:'Use the local app address.'});
      if(req.headers.origin&&req.headers.origin!==`http://${host}`&&!publicOrigins.includes(req.headers.origin)) return json(res,403,{error:'Cross-origin requests are not allowed.'});
      if(req.method==='GET'&&url.pathname==='/oauth/qonto/callback') {
        res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
        res.setHeader('set-cookie',`${QONTO_COOKIE}=; HttpOnly; SameSite=Lax; Path=/oauth/qonto/callback; Max-Age=0`);
        const isSandbox=Boolean(sandbox?.oauth.pending.has(url.searchParams.get('state')));
        const connection=isSandbox?sandbox.oauth:app.qonto;
        let outcome='error';
        try {
          if(`http://${host}`!==new URL(connection.settings.redirectUri).origin) throw new Error('Callback origin mismatch');
          const cookie=req.headers.cookie?.split(';').map(c=>c.trim()).find(c=>c.startsWith(`${QONTO_COOKIE}=`))?.slice(QONTO_COOKIE.length+1);
          if(!isSandbox&&config.qontoConnectionMode!=='oauth')throw new Error('Qonto uses server credentials.');
          await app.exclusive(()=>connection.complete(url.searchParams,cookie));outcome='connected';
        } catch { /* Codes, provider errors and credentials must never reach the URL or page. */ }
        res.writeHead(303,{location:`/?qonto=${isSandbox?'sandbox-':''}${outcome}#runs`});res.end();return;
      }
      if(url.pathname.startsWith('/internal/')) {
        const context=internal.get(req.headers['x-internal-token']);
        if(!context||req.method!=='POST') return json(res,403,{error:'Internal authorization required'});
        const data=await body(req);
        if(url.pathname==='/internal/context') {
          // Answer from current data: refresh when a required source was never synced or is stale.
          // A run already in progress refreshes on its own, so a busy workspace is not an error here.
          if(config.mode!=='demo'&&sourceHold(store,config)){
            context.event({type:'status',text:'Refreshing invoices and payments from Lago…'});
            try{await app.exclusive(()=>app.refresh());}catch{}
          }
          return json(res,200,contextForModel(app.snapshot()));
        }
        if(url.pathname==='/internal/run') {
          if(!['dunning','combined','reconciliation'].includes(data.kind)) return json(res,400,{error:'Invalid internal workflow'});
          context.event({type:'status',text:data.kind==='reconciliation'?'Running reconciliation: matching incoming payments…':'Running dunning: reviewing overdue invoices and customer memory…'});
          const run=await app.run(data.kind,'preview','chat');context.runIds.push(run.id);
          return json(res,200,{workspaceMode:config.mode,...runForModel(run)});
        }
        return json(res,404,{error:'Not found'});
      }
      if(url.pathname.startsWith('/api/')) {
        const isAdmin=config.accessMode==='local'||config.adminKeys.some(key=>equal(key,req.headers['x-admin-key']));
        const keys=config.adminKeys;
        if(config.accessMode!=='local'&&keys.length&&!keys.some(key=>equal(key,req.headers['x-admin-key']))) return json(res,401,{error:'Enter your workspace access key to continue.'});
        if(url.pathname.startsWith('/api/admin/')&&!isAdmin) return json(res,403,{error:'Administrator access is required.'});
        if(req.method!=='GET'&&!equal(req.headers['x-csrf-token'],csrf)) return json(res,403,{error:'Refresh the app to renew your session.'});
        const canConfigureAgent=isAdmin||(config.mode==='demo'&&keys.length===0);
        if(req.method==='GET'&&url.pathname==='/api/session') return json(res,200,{csrf,isAdmin,canConfigureAgent,accessMode:config.accessMode});
        if(url.pathname.startsWith('/api/agent/')&&!canConfigureAgent)return json(res,403,{error:'Only a workspace administrator can configure the agent.'});
        if(req.method==='GET'&&url.pathname==='/api/agent/models')return json(res,200,await app.agentSettings.catalog());
        if(req.method==='POST'&&url.pathname==='/api/agent/settings')return json(res,200,await app.agentSettings.save(await body(req)));
        if(req.method==='POST'&&url.pathname==='/api/agent/dunning-settings'){
          const data=await body(req);
          return json(res,200,await app.exclusive(()=>saveDunningSettings(store,config,data)));
        }
        if(req.method==='POST'&&url.pathname==='/api/agent/alerts'){
          const data=await body(req);return json(res,200,await app.exclusive(()=>app.alerts.save(data)));
        }
        if(req.method==='GET'&&url.pathname==='/api/admin/qonto') return json(res,200,{profiles:qontoSettings.status(),
          production:app.qonto.status({administrator:true}),sandbox:getSandbox().status(),productionEnabled:config.mode==='connected'});
        if(req.method==='POST'&&url.pathname==='/api/admin/qonto/settings') {
          const data=await body(req);
          return json(res,200,await app.exclusive(()=>{
            const connection=data.environment==='sandbox'?getSandbox().oauth:app.qonto;
            if(connection.hasTokens()) throw new Error('Disconnect this environment before changing its application credentials.');
            const result=qontoSettings.save(data.environment,data);
            if(data.environment==='sandbox') getSandbox().config.qonto.stagingToken=config.qontoSandboxOAuth.stagingToken;
            if(data.environment==='production'&&!config.requiredSources.includes('qonto'))config.requiredSources.push('qonto');
            connection.pending.clear();
            return result;
          }));
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/qonto/test/start') {
          const flow=getSandbox().oauth.begin(`http://${host}`);res.setHeader('set-cookie',flow.cookie);return json(res,200,{url:flow.url});
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/qonto/test/accounts') {
          const data=await body(req);return json(res,200,await app.exclusive(()=>getSandbox().oauth.selectAccounts(data.accountIds)));
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/qonto/test/sync') return json(res,200,await app.exclusive(()=>getSandbox().sync()));
        if(req.method==='POST'&&url.pathname==='/api/admin/qonto/test/disconnect') return json(res,200,await app.exclusive(()=>getSandbox().oauth.disconnect()));
        if(req.method==='GET'&&url.pathname==='/api/workspace') return json(res,200,app.snapshot());
        const customerHistoryMatch=url.pathname.match(/^\/api\/customers\/([^/]+)\/history$/);
        if(req.method==='GET'&&customerHistoryMatch)return json(res,200,app.customerHistory(decodeURIComponent(customerHistoryMatch[1])));
        const customerReviewMatch=url.pathname.match(/^\/api\/customers\/([^/]+)\/review$/);
        if(req.method==='POST'&&customerReviewMatch){
          if(!isAdmin)return json(res,403,{error:'Only an administrator can review customer follow-ups.'});
          return json(res,200,await app.reviewCustomer(decodeURIComponent(customerReviewMatch[1]),await body(req)));
        }
        const discardDraftMatch=url.pathname.match(/^\/api\/drafts\/([a-f0-9-]+)\/discard$/);
        const refreshDunningDraftMatch=url.pathname.match(/^\/api\/drafts\/([a-f0-9-]+)\/refresh$/);
        if(req.method==='POST'&&refreshDunningDraftMatch){
          if(!isAdmin)return json(res,403,{error:'Only an administrator can refresh drafts.'});
          return json(res,200,await app.refreshDunningDraft(refreshDunningDraftMatch[1]));
        }
        if(req.method==='POST'&&discardDraftMatch){
          if(!isAdmin)return json(res,403,{error:'Only an administrator can discard drafts.'});
          return json(res,200,await app.discardDraft(discardDraftMatch[1]));
        }
        const resolveDraftMatch=url.pathname.match(/^\/api\/drafts\/([a-f0-9-]+)\/resolve$/);
        if(req.method==='POST'&&resolveDraftMatch){
          if(!isAdmin)return json(res,403,{error:'Only an administrator can resolve delivery uncertainty.'});
          return json(res,200,await app.resolveDraftDelivery(resolveDraftMatch[1],await body(req)));
        }
        const refreshPortalMatch=url.pathname.match(/^\/api\/drafts\/([a-f0-9-]+)\/refresh-link$/);
        if(req.method==='POST'&&refreshPortalMatch){
          if(!isAdmin)return json(res,403,{error:'Only a workspace administrator can refresh billing portal links.'});
          return json(res,200,await app.refreshDraftPortal(refreshPortalMatch[1]));
        }
        const sendDraftMatch=url.pathname.match(/^\/api\/drafts\/([a-f0-9-]+)\/send$/);
        if(req.method==='POST'&&sendDraftMatch){
          if(!isAdmin)return json(res,403,{error:'Only a workspace administrator can send drafts.'});
          return json(res,200,await app.sendDraft(sendDraftMatch[1]));
        }
        if(req.method==='GET'&&url.pathname==='/api/admin/email') return json(res,200,app.email.status({administrator:true}));
        if(req.method==='POST'&&url.pathname==='/api/admin/email/settings') {
          const data=await body(req);return json(res,200,await app.exclusive(()=>app.email.save(data)));
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/email/check') return json(res,200,await app.exclusive(()=>app.email.verify()));
        if(req.method==='GET'&&url.pathname==='/api/connections/qonto') return json(res,200,app.qontoStatus());
        if(config.qontoConnectionMode!=='oauth'&&['/api/connections/qonto/start','/api/connections/qonto/accounts','/api/connections/qonto/disconnect'].includes(url.pathname))return json(res,409,{error:'Qonto uses credentials configured on the server.'});
        if(req.method==='POST'&&url.pathname==='/api/connections/qonto/start') {
          const flow=app.qonto.begin(`http://${host}`);res.setHeader('set-cookie',flow.cookie);
          return json(res,200,{url:flow.url});
        }
        if(req.method==='POST'&&url.pathname==='/api/connections/qonto/accounts') {
          const data=await body(req);return json(res,200,await app.exclusive(()=>app.qonto.selectAccounts(data.accountIds)));
        }
        if(req.method==='POST'&&url.pathname==='/api/connections/qonto/disconnect') return json(res,200,await app.exclusive(()=>app.qonto.disconnect()));
        if(req.method==='POST'&&url.pathname==='/api/connections/qonto/sync') {
          if(config.mode!=='connected') return json(res,409,{error:'Qonto sync requires the connected workspace.'});
          return json(res,200,await app.exclusive(async()=>{
            try {
              const result=await app.agent.syncBankIncrementally('qonto');
              store.health('qonto','succeeded');return {imported:result.imported??result.synced??null};
            } catch(error) {store.health('qonto','failed','Qonto payment sync failed. Check the connection.');throw error;}
          }));
        }
        if(req.method==='POST'&&url.pathname==='/api/runs') {
          const data=await body(req);
          if(data.threadId&&!store.thread(data.threadId)) return json(res,404,{error:'Conversation not found'});
          const run=await app.run(data.kind,data.mode,'manual',null,data.previewId);
          if(data.threadId) store.message(data.threadId,'assistant',run.status==='failed'?'The run could not complete. Review its details.':run.mode==='preview'?'The run is ready to review. No reminders, retries or payment writes were made.':'The run completed. Review individual execution outcomes.',{runIds:[run.id]});
          return json(res,run.status==='failed'?502:200,run);
        }
        if(req.method==='POST'&&url.pathname==='/api/reviews') return json(res,200,await app.review(await body(req)));
        if(req.method==='POST'&&url.pathname==='/api/decisions/execute') {
          if(!config.allowLive) return json(res,403,{error:'Live payment recording is disabled.'});
          const data=await body(req);
          return json(res,200,await app.exclusive(()=>app.service.executeDecision(Number(data.decisionId),'workspace-operator')));
        }
        if(req.method==='POST'&&url.pathname==='/api/decisions/void') {
          const data=await body(req);
          return json(res,200,await app.exclusive(()=>app.service.voidApproval({decisionId:Number(data.decisionId),actor:'workspace-operator',reason:data.reason||'Operator correction'})));
        }
        if(req.method==='POST'&&url.pathname==='/api/customers/pause') {
          const data=await body(req);
          if(typeof data.paused!=='boolean'||!store.listInvoices().some(i=>i.customerId===data.customerId)) return json(res,400,{error:'Choose an existing customer and pause state.'});
          await app.exclusive(()=>store.pause(data.customerId,data.paused,data.reason||'Paused by workspace operator'));
          return json(res,200,{ok:true});
        }
        if(req.method==='POST'&&url.pathname==='/api/schedules/preview') {
          const data=await body(req);let after=new Date();const upcoming=[];
          for(let n=0;n<3;n++){after=new Date(nextRun(data.cron,data.timezone,after));upcoming.push(after.toISOString());}
          return json(res,200,{upcoming});
        }
        if(req.method==='POST'&&url.pathname==='/api/schedules') return json(res,201,saveSchedule(store,await body(req),config));
        const scheduleMatch=url.pathname.match(/^\/api\/schedules\/([a-f0-9-]+)$/);
        if(scheduleMatch&&['PATCH','DELETE'].includes(req.method)) {
          const existing=store.schedules().find(x=>x.id===scheduleMatch[1]);
          if(!existing) return json(res,404,{error:'Schedule not found'});
          if(req.method==='DELETE'){store.db.prepare('DELETE FROM schedules WHERE id=?').run(existing.id);return json(res,200,{ok:true});}
          return json(res,200,saveSchedule(store,{...existing,...await body(req)},config,existing.id));
        }
        if(req.method==='POST'&&url.pathname==='/api/threads') return json(res,201,store.newThread());
        const messagesMatch=url.pathname.match(/^\/api\/threads\/([a-f0-9-]+)\/messages$/);
        if(req.method==='GET'&&messagesMatch) return json(res,200,{messages:store.messages(messagesMatch[1])});
        if(req.method==='POST'&&url.pathname==='/api/chat') {
          const data=await body(req),thread=store.thread(data.threadId);
          if(!thread||typeof data.message!=='string'||!data.message.trim()||data.message.length>8000) return json(res,400,{error:'Send a message under 8,000 characters in an existing conversation.'});
          if(chatBusy.has(thread.id)) return json(res,409,{error:'A reply is already being prepared in this conversation.'});
          chatBusy.add(thread.id);
          store.message(thread.id,'user',data.message);
          res.writeHead(200,{'content-type':'application/x-ndjson','cache-control':'no-store','x-content-type-options':'nosniff'});
          const event=value=>{if(!res.destroyed)res.write(JSON.stringify(value)+'\n');};
          const token=randomBytes(32).toString('hex'),context={runIds:[],event};internal.set(token,context);
          event({type:'status',text:'Reading your workspace…'});
          try {
            if(!config.modelReady) throw new Error('Connect an AI provider to chat. You can still run collection previews and reconcile payments using the buttons in this workspace.');
            const selected=app.agentSettings.runtime();
            const identity=JSON.stringify([selected.modelProvider,selected.modelName,selected.agentRevision,MODEL_CONTEXT_VERSION]);
            const previous=store.meta(`threadAgent:${thread.id}`);
            // Provider-specific tool history is not portable between model configurations.
            const history=previous===identity?thread.model_history:'[]';
            const result=await callModel(selected,{message:data.message,history},{INTERNAL_API_URL:origin,INTERNAL_API_TOKEN:token});
            store.db.prepare('UPDATE threads SET model_history=? WHERE id=?').run(result.history,thread.id);
            store.meta(`threadAgent:${thread.id}`,identity);
            event({type:'message',message:store.message(thread.id,'assistant',result.text,{runIds:context.runIds,model:selected.modelName,provider:selected.modelProvider,agentRevision:selected.agentRevision})});
          } catch(error) {
            event({type:'message',message:store.message(thread.id,'assistant',error.message,{error:true,runIds:context.runIds})});
          } finally {internal.delete(token);chatBusy.delete(thread.id);res.end();}
          return;
        }
        if(req.method==='POST'&&url.pathname==='/api/statements') {
          const data=await body(req);
          return json(res,201,await app.exclusive(()=>app.service.importStatementFile(data,'workspace-operator')));
        }
        return json(res,404,{error:'Not found'});
      }
      if(req.method==='GET') {
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
        if(!['index.html','app.js','markdown.js','email-format.js','styles.css','lago-logo.png'].includes(file)) return json(res,404,{error:'Not found'});
        res.writeHead(200,{'content-type':file.endsWith('.png')?'image/png':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8',
          'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
          'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});
        return fs.createReadStream(path.join(ROOT,'public',file)).pipe(res);
      }
      return json(res,404,{error:'Not found'});
    } catch(error) {json(res,error.status??400,{error:error.message,...(error.code?.startsWith('model_')?{code:error.code}:{})});}
  });
  server.requestTimeout=240000;
  return {server,store,app,scheduler,getSandbox,
    async start(){try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.removeListener('error',reject);resolve();});});}catch(error){store.close();unlock();throw error;}origin=`http://127.0.0.1:${server.address().port}`;scheduler.start();return origin;},
    async close(){scheduler.stop();await new Promise(resolve=>server.close(resolve));sandbox?.close();store.close();unlock();}};
}
function json(res,status,value){if(res.headersSent||res.destroyed)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){let output='';for await(const chunk of req){output+=chunk;if(Buffer.byteLength(output)>1_000_000)throw Object.assign(new Error('Request is too large'),{status:413});}try{return output?JSON.parse(output):{};}catch{throw new Error('Send valid JSON');}}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const runtime=createServer();
  console.log(`Lago Dunning: ${await runtime.start()} (${runtime.app.config.mode})`);
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,async()=>{await runtime.close();process.exit(0);});
}
