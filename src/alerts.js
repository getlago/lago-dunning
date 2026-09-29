import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
const fail=(message,status=400)=>Object.assign(new Error(message),{status,attempted:false});
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);
export function validateSlackWebhook(value){
 let url;try{url=new URL(value);}catch{throw fail('Enter a Slack incoming webhook URL.');}
 if(typeof value!=='string'||value.length>2048||/[\s]/.test(value)||url.protocol!=='https:'||!['hooks.slack.com','hooks.slack-gov.com'].includes(url.hostname)||url.port||url.username||url.password||url.search||url.hash||!/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname))throw fail('Use an HTTPS Slack incoming webhook URL.');
 return url.href;
}
export class AlertSettings {
 constructor(store,email,{fetcher=fetch}={}){
  this.store=store;this.email=email;this.fetcher=fetcher;
  store.db.exec(`CREATE TABLE IF NOT EXISTS alert_settings(id INTEGER PRIMARY KEY CHECK(id=1),ciphertext TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS alert_deliveries(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL,detail TEXT,updated_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 1,next_at TEXT);
   UPDATE alert_deliveries SET status='unknown',detail='Alert submission was interrupted; automatic retry is paused.' WHERE status='sending';`);
 }
 read(){
  const row=this.store.db.prepare('SELECT ciphertext FROM alert_settings WHERE id=1').get();
  if(!row)return {enabled:false,channel:'email',recipient:'',webhook:'',revision:0};
  try{const v=JSON.parse(row.ciphertext),d=createDecipheriv('aes-256-gcm',this.email.key(),Buffer.from(v.iv,'hex'));d.setAAD(Buffer.from('lago-alerts-v1'));d.setAuthTag(Buffer.from(v.tag,'hex'));return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data,'base64')),d.final()]).toString());}
  catch{throw fail('Alert settings could not be opened. Restore the workspace encryption key.',409);}
 }
 status(){
  let v;try{v=this.read();}catch(error){return {enabled:false,channel:'email',recipient:'',hasWebhook:false,revision:0,error:error.message};}
  const last=this.store.db.prepare('SELECT channel,status,detail,updated_at FROM alert_deliveries ORDER BY updated_at DESC LIMIT 1').get()??null;
  const unresolved=this.store.db.prepare("SELECT count(*) AS n FROM alert_deliveries WHERE status IN ('failed','unknown')").get().n;
  return {enabled:v.enabled,channel:v.channel,recipient:v.recipient,hasWebhook:Boolean(v.webhook),revision:v.revision,lastDelivery:last,unresolved};
 }
 save(input){
  const previous=this.read();
  if(input?.revision!==previous.revision)throw fail('Alert settings changed. Reopen settings before saving.',409);
  if(typeof input.enabled!=='boolean'||!['email','slack'].includes(input.channel))throw fail('Choose email or Slack for alerts.');
  const recipient=typeof input.recipient==='string'?input.recipient.trim():previous.recipient;
  const webhook=input.webhook?validateSlackWebhook(input.webhook):previous.webhook;
  if(recipient&&!validEmail(recipient))throw fail('Enter one valid alert email address.');
  if(input.enabled&&input.channel==='email'){
   if(!validEmail(recipient))throw fail('Enter an email address for alerts.');
   const smtp=this.email.status();if(smtp.state!=='connected'||!smtp.sender)throw fail('Connect and verify your SMTP provider before enabling email alerts.',409);
  }
  if(input.enabled&&input.channel==='slack'&&!webhook)throw fail('Enter a Slack incoming webhook URL.');
  const value={enabled:input.enabled,channel:input.channel,recipient,webhook,revision:previous.revision+1};
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.email.key(true),iv);c.setAAD(Buffer.from('lago-alerts-v1'));
  const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]).toString('base64');
  this.store.db.prepare('INSERT OR REPLACE INTO alert_settings VALUES(1,?)').run(JSON.stringify({iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data}));
  if(previous.channel!==value.channel||previous.recipient!==value.recipient||previous.webhook!==value.webhook)this.store.db.prepare("UPDATE alert_deliveries SET attempts=0,next_at=NULL WHERE status='failed'").run();
  return this.status();
 }
 async notify(runId,collection){
  const settings=this.read();if(!settings.enabled)return {status:'disabled',count:0};
  const pending=this.store.db.prepare(`SELECT e.* FROM collection_events e JOIN collection_escalations c ON c.customer_id=e.customer_id AND c.currency=json_extract(e.detail_json,'$.currency')
   WHERE e.event_type='escalated' AND c.status='open' AND c.reviewed_at IS NULL
   AND e.rowid=(SELECT max(e2.rowid) FROM collection_events e2 WHERE e2.customer_id=e.customer_id AND e2.event_type='escalated' AND json_extract(e2.detail_json,'$.currency')=c.currency)
   ORDER BY e.created_at`).all().filter(e=>{
    const d=this.store.db.prepare('SELECT * FROM alert_deliveries WHERE event_id=?').get(e.id);
    return !d||(d.status==='failed'&&d.attempts<3&&(!d.next_at||d.next_at<=new Date().toISOString()));
   }).filter(e=>collection.rows.some(r=>r.customerId===e.customer_id&&r.currency===JSON.parse(e.detail_json).currency)).slice(0,10);
  if(!pending.length)return {status:'unchanged',count:0};
  const sections=pending.map(e=>{
   const detail=JSON.parse(e.detail_json),row=collection.rows.find(r=>r.customerId===e.customer_id&&r.currency===detail.currency);
   const amount=new Intl.NumberFormat('en',{style:'currency',currency:row.currency}).format(row.amountCents/10**new Intl.NumberFormat('en',{style:'currency',currency:row.currency}).resolvedOptions().maximumFractionDigits);
   return `${String(row.customerName).slice(0,200)} · ${amount}\n${String(detail.reason).slice(0,1000)}\nInvoices: ${row.invoices.map(i=>i.number).join(', ').slice(0,500)}`;
  });
  this.store.transaction(()=>{for(const e of pending)this.store.db.prepare(`INSERT INTO alert_deliveries(event_id,run_id,channel,status,updated_at) VALUES(?,?,?,'sending',?) ON CONFLICT(event_id) DO UPDATE SET run_id=excluded.run_id,channel=excluded.channel,status='sending',updated_at=excluded.updated_at,attempts=attempts+1`).run(e.id,runId,settings.channel,new Date().toISOString());});
  let status='sent',detail='Alert accepted by the provider.';
  try{
   if(settings.channel==='email')await this.email.sendAlert({recipient:settings.recipient,subject:`Lago: ${pending.length} dunning case${pending.length===1?'':'s'} need attention`,body:sections.join('\n\n')+'\n\nOpen Agent runs → Needs attention in Lago to review these cases.'});
   else{
    let response;try{response=await this.fetcher(validateSlackWebhook(settings.webhook),{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json'},body:JSON.stringify({text:'Lago: dunning cases need attention',blocks:[{type:'header',text:{type:'plain_text',text:'Dunning needs attention'}},...sections.map(text=>({type:'section',text:{type:'plain_text',text}})),{type:'section',text:{type:'plain_text',text:'Open Agent runs → Needs attention in Lago to review these cases.'}}]})});}
    catch{throw Object.assign(new Error('Slack did not confirm the alert. Automatic retry is paused.'),{attempted:true});}
    if(response.status!==200)throw Object.assign(new Error(`Slack rejected the alert (HTTP ${response.status}). Check the webhook in alert settings.`),{attempted:response.status>=500});
    if((await response.text()).trim()!=='ok')throw Object.assign(new Error('Slack did not confirm the alert. Automatic retry is paused.'),{attempted:true});
   }
  }catch(error){status=error.attempted===false?'failed':'unknown';detail=status==='failed'?'Alert was not accepted. Check the selected provider and destination in alert settings.':'Alert submission could not be confirmed. Automatic retry is paused to avoid duplicate alerts.';}
  for(const e of pending)this.store.db.prepare('UPDATE alert_deliveries SET status=?,detail=?,updated_at=?,next_at=? WHERE event_id=?').run(status,detail,new Date().toISOString(),status==='failed'?new Date(Date.now()+5*60000).toISOString():null,e.id);
  return {status,count:pending.length,channel:settings.channel,detail};
 }
}
