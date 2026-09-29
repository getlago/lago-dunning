import { randomUUID } from 'node:crypto';
const DAY=86400000;
const parse=value=>{try{return JSON.parse(value??'null');}catch{return null;}};
export const deliveryMode=()=>'customer';

export function initializeMemory(store) {
  const db=store.db;
  for(const [table,fields] of Object.entries({collection_actions:{draft_id:'TEXT',context_json:'TEXT',delivery_mode:"TEXT NOT NULL DEFAULT 'legacy'",contact_at:'TEXT'},collection_memory:{cadence_reset_at:'TEXT'}})){
    const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
    for(const [name,type] of Object.entries(fields))if(!existing.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS collection_draft_action ON collection_actions(draft_id) WHERE draft_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS collection_events(id TEXT PRIMARY KEY,event_key TEXT UNIQUE,customer_id TEXT NOT NULL,run_id TEXT,action_id TEXT,draft_id TEXT,event_type TEXT NOT NULL,delivery_mode TEXT,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS collection_event_customer ON collection_events(customer_id,created_at);
    CREATE TRIGGER IF NOT EXISTS collection_event_no_update BEFORE UPDATE ON collection_events BEGIN SELECT RAISE(ABORT,'Customer history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS collection_event_no_delete BEFORE DELETE ON collection_events BEGIN SELECT RAISE(ABORT,'Customer history is immutable'); END;
    CREATE TABLE IF NOT EXISTS collection_escalations(customer_id TEXT NOT NULL,currency TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,reviewed_at TEXT,review_note TEXT,PRIMARY KEY(customer_id,currency));`);
  // Link existing drafts using the durable action/run references, never the email
  // address (different customers can share the same billing address).
  for(const action of db.prepare('SELECT * FROM collection_actions').all()){
    const draftId=action.draft_id??parse(action.detail)?.draftId;
    const run=store.run(action.run_id);
    const context=parse(action.context_json)??run?.result?.collection?.outcomes?.find(o=>o.draftId===draftId)??run?.result?.collection?.rows?.find(r=>r.customerId===action.customer_id&&JSON.stringify(r.invoiceIds)===action.invoice_ids);
    db.prepare('UPDATE collection_actions SET draft_id=?,context_json=? WHERE id=?').run(draftId??null,context?JSON.stringify(context):null,action.id);
    const draft=draftId?store.draft(draftId):null;
    if(draft?.status==='draft'&&action.status==='executing')db.prepare("UPDATE collection_actions SET status='drafted' WHERE id=?").run(action.id);
    if(draft&&['drafted','sending'].includes(action.status)&&['accepted','unknown','sending','captured','cancelled'].includes(draft.status)){
      const status=draft.status==='accepted'?'legacy_sent':draft.status==='captured'?'test_sent':draft.status==='cancelled'?'cancelled':'unknown';
      db.prepare('UPDATE collection_actions SET status=?,contact_at=? WHERE id=?').run(status,draft.sent_at??null,action.id);
    }
    const current=db.prepare('SELECT * FROM collection_actions WHERE id=?').get(action.id);
    if(!db.prepare('SELECT 1 FROM collection_events WHERE action_id=?').get(action.id))event(store,action.customer_id,'history_imported',{status:current.status,note:'Recovered existing collection action; historical delivery mode may be unknown.'},{key:`import:${action.id}`,runId:action.run_id,actionId:action.id,draftId,mode:current.delivery_mode,at:current.contact_at??action.created_at});
  }
}
export function event(store,customerId,type,detail={},options={}) {
  store.db.prepare('INSERT OR IGNORE INTO collection_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),options.key??null,customerId,options.runId??null,options.actionId??null,options.draftId??null,type,options.mode??null,JSON.stringify(detail),options.at??new Date().toISOString());
}
export function actionForDraft(store,id){return store.db.prepare('SELECT * FROM collection_actions WHERE draft_id=?').get(id);}
export function draftState(store,id,status,detail,at) {
  const action=actionForDraft(store,id);if(!action)return;
  const mapped={sending:'sending',accepted:action.delivery_mode==='test'?'test_sent':'sent',unknown:'unknown',failed:'drafted',captured:'test_sent',cancelled:'cancelled'}[status];
  if(!mapped)return;
  store.db.prepare('UPDATE collection_actions SET status=?,contact_at=?,completed_at=? WHERE id=?').run(mapped,['sent','test_sent'].includes(mapped)?at:null,at,action.id);
  event(store,action.customer_id,{sending:'email_submitting',accepted:'email_submitted',unknown:'delivery_unknown',failed:'email_rejected',captured:'test_captured',cancelled:'draft_discarded'}[status],{detail,deliveryConfirmed:false},{actionId:action.id,draftId:id,runId:action.run_id,mode:action.delivery_mode,at});
}
export function contactSummary(store,customerId,config,invoiceIds=[],now=new Date()) {
  const actions=store.actions(customerId),mode=deliveryMode(config);
  const submitted=actions.filter(a=>['sent','test_sent','legacy_sent','retried','simulated_sent'].includes(a.status));
  const touches=submitted.filter(a=>a.delivery_mode===mode||a.delivery_mode==='legacy'||(mode==='test'&&a.delivery_mode==='simulation')).map(a=>({...a,time:Date.parse(a.contact_at??a.completed_at??a.created_at)})).filter(a=>Number.isFinite(a.time)).sort((a,b)=>b.time-a.time);
  const weekly=touches.filter(a=>now-a.time<7*DAY);
  const reset=Date.parse(store.memory(customerId).cadence_reset_at??'1970-01-01');
  const relevant=touches.filter(a=>a.time>=reset&&parse(a.invoice_ids)?.some(id=>invoiceIds.includes(id)));
  let next=touches.length?touches[0].time+config.policy.dedupHours*3600000:0;
  if(weekly.length>=config.policy.weeklyCap)next=Math.max(next,weekly[config.policy.weeklyCap-1].time+7*DAY);
  const actualLast=touches.find(a=>a.delivery_mode!=='simulation');
  // SMTP submissions are real emails.
  // Local captures and synthetic history must not inflate the sent count.
  const sentEmails=actions.filter(a=>a.delivery_mode!=='simulation'&&a.draft_id&&store.draft(a.draft_id)?.status==='accepted');
  const lastEmailAt=sentEmails.map(a=>store.draft(a.draft_id).sent_at).filter(Boolean).sort().at(-1)??null;
  return {mode,emailsSent:sentEmails.length,lastEmailAt,customerContacts:submitted.filter(a=>a.delivery_mode==='customer'&&a.status==='sent').length,simulatedContacts:submitted.filter(a=>a.delivery_mode==='simulation').length,legacyContacts:submitted.filter(a=>a.delivery_mode==='legacy').length,
    weeklyContacts:weekly.length,invoiceContacts:relevant.length,lastContactAt:actualLast?new Date(actualLast.time).toISOString():null,nextEligibleAt:next>now?new Date(next).toISOString():null,
    weeklyLimit:config.policy.weeklyCap,terminalLimit:config.policy.terminalTouches,pendingDrafts:actions.filter(a=>a.status==='drafted').length,uncertain:actions.some(a=>['unknown','sending','executing'].includes(a.status))};
}
export function recordCollectionRun(store,runId,collection){
  const attention=new Map();
  for(const row of collection.rows){
    const outcome=collection.outcomes?.find(o=>o.customerId===row.customerId&&o.currency===row.currency);
    const problem=['unknown','failed'].includes(outcome?.outcome);
    event(store,row.customerId,'decision',{status:row.status,action:row.action,reason:row.reason,invoiceIds:row.invoiceIds,amountCents:row.amountCents,currency:row.currency,policyVersion:collection.policyVersion,contacts:row.contacts,evidence:row.evidence??null},{key:`decision:${runId}:${row.customerId}:${row.currency}`,runId});
    if(row.status==='review'||row.evidence||/disputed|uncertain outcome/.test(row.reason)||problem)attention.set(`${row.customerId}:${row.currency}`,{...row,reason:problem?outcome.detail:row.reason});
  }
  const now=new Date().toISOString();
  for(const row of attention.values()){
    const old=store.db.prepare('SELECT * FROM collection_escalations WHERE customer_id=? AND currency=?').get(row.customerId,row.currency);
    const changed=!old||old.status==='resolved'||old.reason!==row.reason;
    store.db.prepare(`INSERT INTO collection_escalations VALUES(?,?,?,'open',?,?,NULL,NULL) ON CONFLICT(customer_id,currency) DO UPDATE SET reason=excluded.reason,status='open',updated_at=excluded.updated_at,reviewed_at=CASE WHEN reason!=excluded.reason OR status='resolved' THEN NULL ELSE reviewed_at END`).run(row.customerId,row.currency,row.reason,now,now);
    if(changed)event(store,row.customerId,'escalated',{reason:row.reason,currency:row.currency},{runId});
  }
  for(const old of store.db.prepare("SELECT * FROM collection_escalations WHERE status='open'").all())if(!attention.has(`${old.customer_id}:${old.currency}`)){
    store.db.prepare("UPDATE collection_escalations SET status='resolved',updated_at=? WHERE customer_id=? AND currency=?").run(now,old.customer_id,old.currency);
    event(store,old.customer_id,'escalation_resolved',{currency:old.currency},{runId});
  }
}
