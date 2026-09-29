import { randomUUID } from 'node:crypto';
import { ReconciliationStore } from './cash/db.js';
import { initializeMemory,event,draftState,actionForDraft } from './customer-memory.js';

export class Store extends ReconciliationStore {
  constructor(filename) {
    super(filename);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL,
        trigger TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
        result_json TEXT, error TEXT, schedule_id TEXT);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        cron TEXT NOT NULL, timezone TEXT NOT NULL, mode TEXT NOT NULL, enabled INTEGER NOT NULL,
        next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
        model_history TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
        role TEXT NOT NULL, text TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_memory (customer_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0,
        pause_reason TEXT, score TEXT, scored_at TEXT);
      CREATE TABLE IF NOT EXISTS collection_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        customer_id TEXT NOT NULL, invoice_ids TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        detail TEXT, created_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE IF NOT EXISTS email_drafts (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),
        recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_health (source TEXT PRIMARY KEY, status TEXT NOT NULL, checked_at TEXT NOT NULL,
        last_success_at TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS collection_cadence ON collection_actions(customer_id, created_at);
      CREATE INDEX IF NOT EXISTS run_history ON runs(started_at);
      CREATE INDEX IF NOT EXISTS chat_history ON messages(thread_id, created_at);
    `);
    const columns=new Set(this.db.prepare('PRAGMA table_info(email_drafts)').all().map(c=>c.name));
    for(const [name,type] of Object.entries({status:"TEXT NOT NULL DEFAULT 'draft'",send_detail:'TEXT',sent_at:'TEXT',message_id:'TEXT',portal_customer_external_id:'TEXT',portal_url:'TEXT',portal_expires_at:'TEXT'})) {
      if(!columns.has(name))this.db.exec(`ALTER TABLE email_drafts ADD COLUMN ${name} ${type}`);
    }
    initializeMemory(this);
  }
  recover() {
    for(const draft of this.drafts().filter(d=>d.status==='sending'))this.finishDraft(draft.id,'unknown','Sending was interrupted. Verify delivery before another attempt.');
    this.db.prepare("UPDATE runs SET status='interrupted', completed_at=?, error='The app stopped during this run. Review outcomes before retrying.' WHERE status='running'").run(new Date().toISOString());
    this.db.prepare("UPDATE collection_actions SET status='unknown', detail='Execution interrupted; delivery or charge status must be checked before retrying.' WHERE status='executing'").run();
  }
  upsertInvoice(invoice) {
    return super.upsertInvoice({...invoice,raw:{...(invoice.raw??invoice),payments:invoice.payments??invoice.raw?.payments??[]}});
  }
  meta(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO workspace_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    return JSON.parse(this.db.prepare('SELECT value FROM workspace_meta WHERE key=?').get(key)?.value ?? 'null');
  }
  startRun(kind, mode, trigger, scheduleId = null) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs (id,kind,mode,trigger,status,started_at,schedule_id) VALUES (?,?,?,?,?,?,?)')
      .run(id, kind, mode, trigger, 'running', new Date().toISOString(), scheduleId);
    return id;
  }
  finishRun(id, result, error = null) {
    this.db.prepare('UPDATE runs SET status=?,completed_at=?,result_json=?,error=? WHERE id=?')
      .run(error ? 'failed' : 'completed', new Date().toISOString(), JSON.stringify(result), error, id);
    return this.run(id);
  }
  run(id) { const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id); return row ? { ...row, result: JSON.parse(row.result_json ?? 'null'), result_json: undefined } : null; }
  runs(limit = 100) { return this.db.prepare('SELECT id FROM runs ORDER BY started_at DESC LIMIT ?').all(limit).map(x => this.run(x.id)); }
  memory(customerId) { return this.db.prepare('SELECT * FROM collection_memory WHERE customer_id=?').get(customerId) ?? { paused: 0 }; }
  pause(customerId, paused, reason = null) {
    this.db.prepare('INSERT INTO collection_memory(customer_id,paused,pause_reason) VALUES(?,?,?) ON CONFLICT(customer_id) DO UPDATE SET paused=excluded.paused,pause_reason=excluded.pause_reason')
      .run(customerId, Number(paused), reason);
    event(this,customerId,paused?'paused':'resumed',{reason:reason??null});
  }
  score(customerId, score) {
    const previous=this.memory(customerId).score;
    this.db.prepare('INSERT INTO collection_memory(customer_id,score,scored_at) VALUES(?,?,?) ON CONFLICT(customer_id) DO UPDATE SET score=excluded.score,scored_at=excluded.scored_at')
      .run(customerId, score, new Date().toISOString());
    if(previous!==score)event(this,customerId,'score_changed',{previous:previous??null,score});
  }
  actions(customerId) { return this.db.prepare('SELECT * FROM collection_actions WHERE customer_id=? ORDER BY created_at DESC').all(customerId); }
  beginAction(runId, row) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO collection_actions(id,run_id,customer_id,invoice_ids,kind,status,created_at,context_json,delivery_mode) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, runId, row.customerId, JSON.stringify(row.invoiceIds), row.action, 'executing', new Date().toISOString(),JSON.stringify(row),row.deliveryMode??'legacy');
    event(this,row.customerId,'draft_preparing',{kind:row.action,invoiceIds:row.invoiceIds},{actionId:id,runId});
    return id;
  }
  saveDraft(runId,recipient,subject,body,portal=null,actionContext=null) {return this.transaction(()=>{
    const id=randomUUID();
    this.db.prepare('INSERT INTO email_drafts(id,run_id,recipient,subject,body,created_at,portal_customer_external_id,portal_url,portal_expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,runId,recipient,subject,body,new Date().toISOString(),portal?.customerExternalId??null,portal?.url??null,portal?.expiresAt??null);
    if(actionContext){
      const linked=this.db.prepare('UPDATE collection_actions SET draft_id=? WHERE id=? AND run_id=? AND draft_id IS NULL').run(id,actionContext.actionId,runId);
      if(linked.changes!==1)throw new Error('The draft must belong to exactly one collection action.');
    }
    return {id};
  });}
  drafts(){return this.db.prepare('SELECT * FROM email_drafts ORDER BY created_at DESC').all();}
  draft(id){return this.db.prepare('SELECT * FROM email_drafts WHERE id=?').get(id);}
  updateDraftPortal(id,body,portal){
    const updated=this.db.prepare("UPDATE email_drafts SET body=?,portal_url=?,portal_expires_at=?,send_detail=NULL WHERE id=? AND status IN ('draft','failed')").run(body,portal.url,portal.expiresAt,id);
    if(updated.changes!==1)throw Object.assign(new Error('Only an unsent draft can receive a new billing portal link.'),{status:409});
    return this.draft(id);
  }
  claimDraft(id,recipient){return this.transaction(()=>{
    const claimed=this.db.prepare("UPDATE email_drafts SET status='sending',recipient=?,send_detail=NULL WHERE id=? AND status IN ('draft','failed')").run(recipient,id).changes===1;
    if(claimed)draftState(this,id,'sending','Approved by workspace operator',new Date().toISOString());return claimed;
  });}
  finishDraft(id,status,detail,messageId=null){return this.transaction(()=>{
    const now=new Date().toISOString();
    this.db.prepare('UPDATE email_drafts SET status=?,send_detail=?,sent_at=?,message_id=? WHERE id=?').run(status,detail,['accepted','captured'].includes(status)?now:null,messageId,id);
    draftState(this,id,status,detail,now);return this.draft(id);
  });}
  actionForDraft(id){return actionForDraft(this,id);}
  finishAction(id, status, detail) {this.transaction(()=>{
    this.db.prepare('UPDATE collection_actions SET status=?,detail=?,completed_at=? WHERE id=?').run(status, detail, new Date().toISOString(), id);
    const action=this.db.prepare('SELECT * FROM collection_actions WHERE id=?').get(id);
    let draftId;try{draftId=JSON.parse(detail)?.draftId;}catch{}
    if(draftId)this.db.prepare('UPDATE collection_actions SET draft_id=? WHERE id=?').run(draftId,id);
    event(this,action.customer_id,status==='drafted'?'draft_saved':`draft_${status}`,{detail:status==='drafted'?'Draft saved for approval':detail},{actionId:id,runId:action.run_id,draftId});
  });}
  health(source, status, detail = null) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO source_health VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET
      status=excluded.status,checked_at=excluded.checked_at,detail=excluded.detail,
      last_success_at=COALESCE(excluded.last_success_at,source_health.last_success_at)`).run(source,status,now,status === 'succeeded' ? now : null,detail);
  }
  sourceHealth() { return this.db.prepare('SELECT * FROM source_health').all(); }
  newThread(title = 'New conversation') {
    const id = randomUUID();
    this.db.prepare('INSERT INTO threads(id,title,created_at) VALUES(?,?,?)').run(id,title,new Date().toISOString());
    return this.thread(id);
  }
  thread(id) { return this.db.prepare('SELECT * FROM threads WHERE id=?').get(id); }
  threads() { return this.db.prepare('SELECT id,title,created_at FROM threads ORDER BY created_at DESC').all(); }
  messages(id) { return this.db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY rowid').all(id).map(x=>({...x,metadata:JSON.parse(x.metadata_json),metadata_json:undefined})); }
  message(threadId, role, text, metadata = {}) {
    const message = {id:randomUUID(),thread_id:threadId,role,text,metadata,created_at:new Date().toISOString()};
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(message.id,threadId,role,text,JSON.stringify(metadata),message.created_at);
    if (role === 'user') this.db.prepare("UPDATE threads SET title=? WHERE id=? AND title='New conversation'").run(text.slice(0,65),threadId);
    return message;
  }
  schedules() { return this.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all().map(x=>({...x,enabled:Boolean(x.enabled)})); }
}
