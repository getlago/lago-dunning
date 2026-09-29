import { LagoConnector } from './cash/connectors/lago.js';
import { MercuryConnector } from './cash/connectors/mercury.js';
import { QontoConnector } from './cash/connectors/qonto.js';
import { BrexConnector } from './cash/connectors/brex.js';
import { RampConnector } from './cash/connectors/ramp.js';
import { StripeConnector } from './cash/connectors/stripe.js';
import { SalesforceConnector } from './cash/connectors/salesforce.js';
import { BusinessCentralConnector, NetSuiteConnector, QuickBooksConnector, SapConnector, XeroConnector } from './cash/connectors/erp.js';
import { ReconciliationService } from './cash/service.js';
import { ReconciliationAgent } from './cash/agent/orchestrator.js';
import { EmailSettings } from './email.js';
import { planDunning, executeDunning,paymentMethodDraft } from './dunning.js';
import { event,contactSummary,deliveryMode,recordCollectionRun } from './customer-memory.js';
import { seedDemo } from './demo.js';
import { QontoOAuth } from './qonto-oauth.js';
import { AgentSettings } from './agent-settings.js';
import { dunningSettings } from './dunning-settings.js';
import { AlertSettings } from './alerts.js';

export class Application {
  constructor(store,config) {
    this.store=store;this.config=config;this.busy=false;
    this.agentSettings=new AgentSettings(store,config);
    const storedMode=store.meta('workspaceMode');
    if(storedMode&&storedMode!==config.mode) throw new Error('This database belongs to a different workspace mode. Use separate demo and connected databases.');
    store.meta('workspaceMode',config.mode);
    store.db.prepare("UPDATE runs SET kind='dunning' WHERE kind='combined'").run();
    store.db.prepare("UPDATE schedules SET kind='dunning' WHERE kind='combined'").run();
    this.email=new EmailSettings(store,config);
    this.alerts=new AlertSettings(store,this.email);
    // Old send/retry schedules need an explicit choice of the new draft workflow.
    store.db.prepare("UPDATE schedules SET enabled=0,next_run_at=NULL WHERE mode='live'").run();
    this.qonto=new QontoOAuth(store,config);
    // Pick one configured authentication method; failed OAuth must never fall back
    // to another credential or another bank environment during a request.
    const useApiKey=config.qontoConnectionMode==='api_key';
    if((store.meta('qontoConnectionMode')??'oauth')!==config.qontoConnectionMode){
      store.db.prepare("DELETE FROM sync_state WHERE provider='qonto'").run();
      if(config.mode==='connected')store.health('qonto','failed','Qonto connection changed. Check payments to refresh the source.');
    }
    store.meta('qontoConnectionMode',config.qontoConnectionMode);
    const qonto=useApiKey?new QontoConnector(config.qonto):
      new QontoConnector({...config.qonto,token:'',baseUrl:this.qonto.apiBase,oauth:this.qonto},(...args)=>this.qonto.connectorRequest(...args));
    qonto.agentConfigured=useApiKey?Boolean(config.qonto.token):true;
    this.service=new ReconciliationService({store,dryRun:!config.allowLive,lago:new LagoConnector(config.lago),
      mercury:new MercuryConnector(config.mercury),qonto,brex:new BrexConnector(config.brex),ramp:new RampConnector(config.ramp),
      stripe:new StripeConnector(config.stripe),salesforce:new SalesforceConnector(config.salesforce),stripeCustomerMap:config.stripe.customerMap,
      erps:{xero:new XeroConnector(config.erps.xero),quickbooks:new QuickBooksConnector(config.erps.quickbooks),business_central:new BusinessCentralConnector(config.erps.businessCentral),netsuite:new NetSuiteConnector(config.erps.netsuite),sap:new SapConnector(config.erps.sap)}});
    this.agent=new ReconciliationAgent({store,service:this.service,config:config.agent});
    store.meta('stripeCustomerMap',config.stripe.customerMap);
    if(config.mode==='demo') seedDemo(store,this.service);
  }
  async exclusive(operation) {
    if(this.busy) throw Object.assign(new Error('An agent run or payment action is already in progress.'),{status:409});
    this.busy=true;
    try{return await operation();}finally{this.busy=false;}
  }
  async refresh() {
    const result=await this.agent.run({trigger:'workspace',sync:this.config.mode!=='demo'});
    if(this.config.mode!=='demo') {
      for(const [source,status] of Object.entries(result.summary?.sourceCoverage??{})) this.store.health(source,status,status==='succeeded'?null:'Source unavailable or not configured');
    }
    return result;
  }
  async run(kind='dunning',mode='preview',trigger='manual',scheduleId=null,previewId=null) {
    if(kind==='combined')kind='dunning'; // Compatibility with earlier clients.
    if(mode==='live') throw Object.assign(new Error('Live collection has been removed. Choose saved drafts; email sending is disabled.'),{status:403});
    if(!['dunning','reconciliation'].includes(kind)||!['preview','drafts'].includes(mode)) throw Object.assign(new Error('Invalid run type or mode'),{status:400});
    if(mode==='drafts'&&kind==='reconciliation') throw Object.assign(new Error('Choose a collection workflow to save reminder drafts.'),{status:403});
    if(mode==='drafts'&&trigger!=='schedule'&&!previewId) throw Object.assign(new Error('Review a recent preview before executing.'),{status:400});
    return this.exclusive(async()=>{
      let approved;
      if(mode==='drafts'&&previewId) {
        const previous=this.store.run(previewId);
        if(!previous||previous.mode!=='preview'||previous.status!=='completed'||!previous.result?.collection||Date.now()-Date.parse(previous.completed_at)>15*60000)
          throw Object.assign(new Error('This preview is missing or expired. Create a fresh preview.'),{status:409});
        if(this.store.meta(`executedPreview:${previewId}`)) throw Object.assign(new Error('This preview has already been executed.'),{status:409});
        approved=previous.result.collection;
      }
      const id=this.store.startRun(kind,mode,trigger,scheduleId);
      if(approved) this.store.meta(`executedPreview:${previewId}`,id);
      try {
        const reconciliation=await this.refresh();
        let collection=kind==='reconciliation'?null:planDunning(this.store,this.config);
        if(collection) for(const row of collection.rows) this.store.score(row.customerId,row.score);
        if(mode==='drafts'&&collection) {
          collection=await executeDunning({store:this.store,config:this.config,runId:id,preview:approved??collection,
            refresh:()=>this.refresh(),getPortalLink:externalId=>this.service.lago.customerPortalLink(externalId),
            createDraft:(to,subject,body,portal,actionContext)=>this.store.saveDraft(id,to,subject,body,portal,actionContext)});
        }
        if(collection)recordCollectionRun(this.store,id,collection);
        let alerts=null;
        if(collection)try{alerts=await this.alerts.notify(id,collection);}catch{alerts={status:'failed',count:0,detail:'Alerts could not be processed. Check alert settings.'};}
        return this.store.finishRun(id,{collection,alerts,reconciliation:{cases:reconciliation.cases.length,summary:reconciliation.summary,runId:reconciliation.id,payments:this.reconciliationPayments()},
          sourceHealth:this.store.sourceHealth(),effects:mode==='preview'?'No customer reminders, retries or payment writes. Configured internal alerts may be sent.':'Drafts saved in this workspace. No customer emails sent, charges retried or payments recorded by collection. Configured internal alerts may be sent.'});
      } catch(error) {return this.store.finishRun(id,null,error.message);}
    });
  }
  reconciliationPayments() {
    const invoices=new Map(this.store.listInvoices().map(i=>[i.id,i.number]));
    return this.store.listTransfers().map(t=>({id:t.id,senderName:t.senderName,amountCents:t.amountCents,currency:t.currency,reference:t.reference,reviewStatus:t.reviewStatus,
      proposals:(t.proposals??[]).slice(0,1).map(p=>({score:p.score,autoEligible:p.autoEligible,explanation:p.explanation,
        allocations:p.allocations.map(a=>({invoiceId:a.invoiceId,invoiceNumber:invoices.get(a.invoiceId)??a.invoiceId,amountCents:a.amountCents}))}))}));
  }
  snapshot() {
    const runs=this.store.runs();
    const checked=new Set(this.store.db.prepare("SELECT result_json FROM runs WHERE kind='reconciliation' AND status='completed'").all().flatMap(r=>JSON.parse(r.result_json??'null')?.reconciliation?.payments?.map(t=>t.id)??[]));
    // Bank evidence remains available to dunning internally. The payment review UI
    // only presents suggestions after the user has run reconciliation for a receipt.
    const transfers=this.store.listTransfers().map(t=>{
      const reconciliationChecked=checked.has(t.id)||t.reviewStatus!=='unreviewed';
      return {...t,reconciliationChecked,proposals:reconciliationChecked?t.proposals:[]};
    });
    return {mode:this.config.mode,allowLive:this.config.allowLive,modelReady:this.config.modelReady,modelName:this.agentSettings.current().model,
      agentSettings:this.agentSettings.status(),dunningSettings:dunningSettings(this.store,this.config),alerts:this.alerts.status(),
      connections:{lagoConfigured:Boolean(this.config.lago.apiKey),stripeConfigured:Boolean(this.config.stripe.apiKey),
        qontoConfigured:this.config.qontoConnectionMode==='api_key'?Boolean(this.config.qonto.token):this.qonto.hasTokens()},
      qonto:this.qontoStatus(),
      customers:this.customerSummaries(),escalations:this.store.db.prepare("SELECT * FROM collection_escalations WHERE status='open'").all(),
      email:this.email.status(),drafts:this.store.drafts().map(d=>{const action=this.store.actionForDraft(d.id),context=JSON.parse(action?.context_json??'null');return {...d,customerId:action?.customer_id,deliveryMode:action?.delivery_mode,tone:context?.tone,toneReason:context?.toneReason,recipient:d.recipient};}),timezone:this.config.timezone,busy:this.busy,requiredSources:this.config.requiredSources,
      sourceHealth:this.store.sourceHealth(),collection:planDunning(this.store,this.config),transfers,
      openInvoices:this.store.getOpenInvoices().map(({id,number,customerName,currency,remainingAmountCents})=>({id,number,customerName,currency,remainingAmountCents})),
      receipts:this.store.listReceipts(),cases:this.store.listAgentCases('open'),incidents:this.store.listIncidents('open'),
      runs,schedules:this.store.schedules(),threads:this.store.threads()};
  }
  async sendDraft(id){
    return this.exclusive(async()=>{
      const draft=this.store.draft(id);
      if(!draft)throw Object.assign(new Error('Draft not found.'),{status:404});
      if(!['draft','failed'].includes(draft.status))throw Object.assign(new Error('This draft was already submitted or its outcome needs review.'),{status:409});
      if(this.email.status().state!=='connected')throw Object.assign(new Error('Set up and check SMTP in Workspace settings → Email before sending.'),{status:409});
      if(draft.portal_url&&!(Date.parse(draft.portal_expires_at)>Date.now()))throw Object.assign(new Error('The billing portal link has expired. Refresh the link and review the draft before sending.'),{status:409});
      await this.preflightDraft(draft);
      if(!this.store.claimDraft(id,draft.recipient))throw Object.assign(new Error('This draft was already submitted or its outcome needs review.'),{status:409});
      try{
        const result=await this.email.send(draft);
        return this.store.finishDraft(id,'accepted','SMTP accepted the message. Inbox delivery has not been verified.',result.messageId);
      }catch(error){
        this.store.finishDraft(id,error.attempted===false?'failed':'unknown',error.attempted===false?error.message:'SMTP outcome is uncertain. Check the receiving inbox before retrying.');
        throw error;
      }
    });
  }
  async preflightDraft(draft){
    const action=this.store.actionForDraft(draft.id);
    const block=reason=>{
      this.store.db.prepare('UPDATE email_drafts SET send_detail=? WHERE id=?').run(reason,draft.id);
      if(action)event(this.store,action.customer_id,'send_blocked',{reason},{actionId:action.id,draftId:draft.id,runId:action.run_id});
      throw Object.assign(new Error(reason),{status:409});
    };
    if(!action?.context_json)return block('This older draft has no verifiable invoice context. Discard it and run dunning again.');
    const expected=JSON.parse(action.context_json);
    try{await this.refresh();}catch{return block('Could not refresh payment evidence. Nothing was sent. Try again after reconnecting the payment sources.');}
    const current=planDunning(this.store,this.config,new Date(),{ignoreActionId:action.id}).rows.find(r=>r.customerId===action.customer_id&&r.currency===expected.currency);
    if(!current)return block('These invoices are no longer eligible for dunning. Discard this draft and check the updated balance.');
    if(current.status!=='ready')return block(current.reason);
    const sameIds=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
    if(current.action!==expected.action||current.amountCents!==expected.amountCents||!sameIds(current.invoiceIds,expected.invoiceIds)||current.recipient!==draft.recipient)
      return block('The balance, invoices, recipient or required action changed. Discard this draft and prepare a fresh one.');
    const intended=current.action==='card_fix'?paymentMethodDraft(current,draft.portal_url):current.draft;
    if(current.action==='card_fix'&&(!draft.portal_url||draft.portal_customer_external_id!==current.customerExternalId||!(Date.parse(draft.portal_expires_at)>Date.now())))return block('Refresh this customer’s billing portal link before sending.');
    if(draft.subject!==intended.subject||draft.body!==intended.body)return block('The draft no longer matches the current reminder. Discard it and prepare a fresh draft.');
    this.store.db.prepare('UPDATE collection_actions SET delivery_mode=? WHERE id=?').run(deliveryMode(this.config),action.id);
    event(this.store,action.customer_id,'send_approved',{invoiceIds:current.invoiceIds,amountCents:current.amountCents,currency:current.currency,contacts:current.contacts},{actionId:action.id,draftId:draft.id,mode:deliveryMode(this.config),runId:action.run_id});
  }
  async discardDraft(id){return this.exclusive(()=>{
    const draft=this.store.draft(id);
    if(!draft||!['draft','failed'].includes(draft.status))throw Object.assign(new Error('Only an unsent draft can be discarded.'),{status:409});
    return this.store.finishDraft(id,'cancelled','Discarded by workspace operator. A future run can prepare a fresh draft.');
  });}
  async refreshDunningDraft(id){return this.exclusive(async()=>{
    const saved=this.store.draft(id),action=this.store.actionForDraft(id);
    if(!saved||!['draft','failed'].includes(saved.status)||!action?.context_json)throw Object.assign(new Error('Only an unsent draft with customer context can be refreshed.'),{status:409});
    const previous=JSON.parse(action.context_json);
    await this.refresh();
    const row=planDunning(this.store,this.config,new Date(),{ignoreActionId:action.id}).rows.find(r=>r.customerId===action.customer_id&&r.currency===previous.currency);
    if(!row||row.status!=='ready')throw Object.assign(new Error(row?.reason??'No eligible overdue balance remains. Discard this draft.'),{status:409});
    const portal=row.action==='card_fix'?await this.service.lago.customerPortalLink(row.customerExternalId):null;
    const draft=portal?paymentMethodDraft(row,portal.url):row.draft;
    return this.store.transaction(()=>{
      this.store.db.prepare("UPDATE email_drafts SET subject=?,body=?,recipient=?,status='draft',send_detail=NULL,portal_customer_external_id=?,portal_url=?,portal_expires_at=? WHERE id=?").run(draft.subject,draft.body,row.recipient,portal?row.customerExternalId:null,portal?.url??null,portal?.expiresAt??null,id);
      this.store.db.prepare("UPDATE collection_actions SET context_json=?,invoice_ids=?,kind=?,status='drafted',delivery_mode=? WHERE id=?").run(JSON.stringify(row),JSON.stringify(row.invoiceIds),row.action,deliveryMode(this.config),action.id);
      event(this.store,row.customerId,'draft_refreshed',{reason:'Updated from current invoices and payment behaviour; awaiting a new send approval.',tone:row.tone,invoiceIds:row.invoiceIds},{actionId:action.id,draftId:id});
      return this.store.draft(id);
    });
  });}
  async resolveDraftDelivery(id,{outcome,note}){return this.exclusive(()=>{
    const draft=this.store.draft(id),action=this.store.actionForDraft(id);
    if(!draft||draft.status!=='unknown'||!action)throw Object.assign(new Error('Only an uncertain delivery with customer history can be resolved.'),{status:409});
    if(!['submitted','not_sent'].includes(outcome)||typeof note!=='string'||!note.trim()||note.length>1000)throw Object.assign(new Error('Choose the verified outcome and record how you checked it.'),{status:400});
    event(this.store,action.customer_id,'delivery_reviewed',{outcome,note:note.trim()},{draftId:id,actionId:action.id,mode:action.delivery_mode});
    return this.store.finishDraft(id,outcome==='submitted'?'accepted':'failed',`Operator verified ${outcome==='submitted'?'submission':'no submission'}: ${note.trim()}`);
  });}
  customerSummaries(){
    const plan=planDunning(this.store,this.config),customers=new Map();
    for(const invoice of this.store.listInvoices())if(!customers.has(invoice.customerId))customers.set(invoice.customerId,{customerId:invoice.customerId,customerName:invoice.customerName});
    return [...customers.values()].map(customer=>{
      const rows=plan.rows.filter(r=>r.customerId===customer.customerId),memory=this.store.memory(customer.customerId);
      return {...customer,paused:Boolean(memory.paused),score:memory.score??rows[0]?.score??null,contacts:contactSummary(this.store,customer.customerId,this.config,rows.flatMap(r=>r.invoiceIds)),
        rows:rows.map(r=>({currency:r.currency,amountCents:r.amountCents,status:r.status,reason:r.reason,invoiceContacts:r.contacts.invoiceContacts})),status:memory.paused?'paused':!rows.length?'resolved':rows.some(r=>r.status==='review')?'review':rows.some(r=>r.status==='ready')?'ready':'held'};
    });
  }
  customerHistory(id){
    const customer=this.customerSummaries().find(c=>c.customerId===id);
    if(!customer)throw Object.assign(new Error('Customer not found.'),{status:404});
    return {...customer,memory:this.store.memory(id),events:this.store.db.prepare('SELECT * FROM collection_events WHERE customer_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(id).map(e=>({...e,detail:JSON.parse(e.detail_json),detail_json:undefined})),
      escalations:this.store.db.prepare("SELECT * FROM collection_escalations WHERE customer_id=? AND status='open'").all(id)};
  }
  async reviewCustomer(id,{note,resetCadence=false}){return this.exclusive(()=>{
    this.customerHistory(id);
    if(typeof note!=='string'||!note.trim()||note.length>1000)throw Object.assign(new Error('Add a short note explaining your review.'),{status:400});
    const now=new Date().toISOString();
    this.store.db.prepare("UPDATE collection_escalations SET reviewed_at=?,review_note=? WHERE customer_id=? AND status='open'").run(now,note.trim(),id);
    if(resetCadence)this.store.db.prepare('INSERT INTO collection_memory(customer_id,cadence_reset_at) VALUES(?,?) ON CONFLICT(customer_id) DO UPDATE SET cadence_reset_at=excluded.cadence_reset_at').run(id,now);
    event(this.store,id,resetCadence?'cadence_reset':'human_review',{note:note.trim(),reason:resetCadence?'New follow-up cycle approved; weekly limits and cooldown still apply.':'Review noted; payment and contact rules still apply.'});
    return this.customerHistory(id);
  });}
  async refreshDraftPortal(id){
    return this.exclusive(async()=>{
      const draft=this.store.draft(id);
      if(!draft)throw Object.assign(new Error('Draft not found.'),{status:404});
      if(!['draft','failed'].includes(draft.status)||!draft.portal_customer_external_id||!draft.portal_url||!draft.body.includes(draft.portal_url))
        throw Object.assign(new Error('Only an unsent draft with a billing portal link can be refreshed.'),{status:409});
      const portal=await this.service.lago.customerPortalLink(draft.portal_customer_external_id);
      return this.store.updateDraftPortal(id,draft.body.replaceAll(draft.portal_url,portal.url),portal);
    });
  }
  qontoStatus() {
    if(this.config.qontoConnectionMode!=='api_key')return {...this.qonto.status(),method:'oauth',environment:this.config.qontoOAuth.environment};
    const health=this.store.sourceHealth().find(source=>source.source==='qonto');
    return {method:'api_key',state:this.config.qonto.token?'configured':'setup',
      environment:new URL(this.config.qonto.baseUrl).hostname.includes('staging.qonto.co')?'sandbox':'production',
      lastSuccessAt:this.config.mode==='connected'?health?.last_success_at??null:null};
  }
  async review(payload) {
    return this.exclusive(async()=>{
      const {action,transferId,proposalId,allocations,rememberIdentity=false,execute=false,note}=payload;
      if(execute&&!this.config.allowLive) throw Object.assign(new Error('Live payment recording is disabled.'),{status:403});
      let result;
      if(action==='approve') result=await this.service.approve({transferId,proposalId,allocations,actor:'workspace-operator',rememberIdentity,execute:execute||this.config.mode==='demo',note});
      else if(action==='reject') result=this.service.reject({transferId,proposalId,actor:'workspace-operator',note});
      else if(action==='hold') result=this.service.hold({transferId,actor:'workspace-operator',note});
      else throw Object.assign(new Error('Choose approve, reject or hold'),{status:400});
      await this.agent.run({trigger:'review',sync:false});
      return result;
    });
  }
}
