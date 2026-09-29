import fs from 'node:fs';
import {emailDocumentHtml} from '../public/email-format.js';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {ROOT} from './config.js';
const fail=message=>Object.assign(new Error(message),{status:400,attempted:false});
export function validateSmtp(input){
  const {host,username='',password='',from='',security='starttls'}=input,port=Number(input.port);
  if(typeof host!=='string'||!host||host.length>253||!/^[a-zA-Z0-9.-]+$/.test(host)||!Number.isInteger(port)||port<1||port>65535)throw fail('Enter a valid SMTP hostname and port.');
  if(!['starttls','tls','none'].includes(security))throw fail('Choose STARTTLS, TLS or local testing.');
  if(security==='none'&&!['localhost','127.0.0.1'].includes(host))throw fail('Unencrypted SMTP is only allowed for local testing.');
  if([username,password,from].some(x=>typeof x!=='string'||x.length>2048||/[\r\n\0]/.test(x)))throw fail('SMTP settings contain invalid characters.');
  if(from&&!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(from))throw fail('Enter a valid sender email address.');
  if(Boolean(username)!==Boolean(password))throw fail('Provide both the SMTP username and password, or leave both empty for local testing.');
  if(security==='none'&&username)throw fail('SMTP credentials require TLS.');
  return {host,port,username,password,from,security};
}
export function checkSmtp(config,settings){
  settings=validateSmtp(settings);
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(['PATH','LANG','SSL_CERT_FILE','SSL_CERT_DIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const child=spawn(config.python,[path.join(ROOT,'src/ai/smtp_check.py')],{env,stdio:['pipe','pipe','pipe']});
    let output='',done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(fail('SMTP connection timed out. Check the host and port.'));},20000);
    child.on('error',()=>finish(fail('The email connection checker is unavailable.')));
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>10000){child.kill();finish(fail('Invalid SMTP check response.'));}});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('close',()=>{try{const result=JSON.parse(output);if(!result.verified)throw fail(result.message||'SMTP verification failed.');finish(null,result);}catch(error){finish(error.status?error:fail('The SMTP connection could not be checked.'));}});
    child.stdin.end(JSON.stringify(validateSmtp(settings)));
  });
}
export class EmailSettings{
  constructor(store,config,{check=checkSmtp,deliver=sendSmtp}={}){this.store=store;this.config=config;this.check=check;this.deliver=deliver;store.db.exec('CREATE TABLE IF NOT EXISTS smtp_settings(id INTEGER PRIMARY KEY CHECK(id=1),ciphertext TEXT NOT NULL)');}
  key(create=false){const dir=this.config.providerSettingsPath,file=path.join(dir,'smtp.key');if(create){fs.mkdirSync(dir,{recursive:true,mode:0o700});if(!fs.existsSync(file))fs.writeFileSync(file,randomBytes(32),{mode:0o600,flag:'wx'});}return fs.readFileSync(file);}
  read(){const row=this.store.db.prepare('SELECT ciphertext FROM smtp_settings WHERE id=1').get();if(!row)return {};
    try{const value=JSON.parse(row.ciphertext),d=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(value.iv,'hex'));d.setAAD(Buffer.from('lago-smtp-v1'));d.setAuthTag(Buffer.from(value.tag,'hex'));return JSON.parse(Buffer.concat([d.update(Buffer.from(value.data,'base64')),d.final()]).toString());}
    catch{throw fail('Restore the SMTP server encryption key to access saved settings.');}}
  write(settings){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key(true),iv);c.setAAD(Buffer.from('lago-smtp-v1'));const data=Buffer.concat([c.update(JSON.stringify(settings)),c.final()]).toString('base64');this.store.db.prepare('INSERT OR REPLACE INTO smtp_settings VALUES(1,?)').run(JSON.stringify({iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data}));}
  async send(draft){
    const settings=validateSmtp(this.current());
    if(settings.security==='none')throw fail('Choose a delivery SMTP provider with TLS before sending.');
    if(!settings.from)throw Object.assign(fail('Configure a sender address before sending a draft.'),{attempted:false});
    const result=await this.deliver(this.config,settings,draft);
    if(!result.accepted||!result.messageId)throw Object.assign(fail(result.message||'SMTP acceptance could not be confirmed.'),{attempted:result.attempted!==false});
    return result;
  }
  async sendAlert(message){
    if(typeof message.recipient!=='string'||!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(message.recipient))throw fail('Enter one valid alert email address.');
    const settings=validateSmtp(this.current());
    if(settings.security==='none'||!settings.from)throw fail('Configure a delivery SMTP provider and sender for alerts.');
    const result=await this.deliver(this.config,settings,message);
    if(!result.accepted||!result.messageId)throw Object.assign(fail('The email provider did not confirm the alert.'),{attempted:result.attempted!==false});
    return result;
  }
  current(){return this.config.smtp?.host?this.config.smtp:this.read();}
  fingerprint(){return createHash('sha256').update(JSON.stringify(this.current())).digest('hex');}
  status({administrator=false}={}){try{const s=this.current(),saved=this.store.meta('smtpCheck'),check=saved?.fingerprint===this.fingerprint()?saved:null;return {state:!s.host?'setup':check?.ok?'connected':check?'error':'configured',provider:s.host==='smtp.resend.com'?'Resend':'SMTP',sender:s.from??'',draftStorage:'workspace',checkedAt:check?.checkedAt??null,message:check?.message??null,
    ...(administrator?{host:s.host??'',port:s.port??587,security:s.security??'starttls',username:s.username??'',from:s.from??'',hasPassword:Boolean(s.password),managed:Boolean(this.config.smtp?.host)}:{})};}catch(error){return {state:'error',message:error.message};}}
  async save(input){if(this.config.smtp?.host)throw fail('SMTP is configured on the server.');const old=this.read();const password=input.password===''&&input.keepPassword===true&&input.host===old.host&&input.username===old.username?old.password:input.password;
    const settings=validateSmtp({...input,password});if(settings.security==='none')throw fail('Choose STARTTLS or TLS for email delivery.');await this.check(this.config,settings);this.write(settings);this.recordCheck();return this.status({administrator:true});}
  recordCheck(error=null){this.store.meta('smtpCheck',{fingerprint:this.fingerprint(),ok:!error,checkedAt:new Date().toISOString(),message:error?.message??null});}
  async verify(){try{await this.check(this.config,validateSmtp(this.current()));this.recordCheck();}catch(error){this.recordCheck(error);throw error;}return this.status();}
}

export function sendSmtp(config,settings,draft){
  settings=validateSmtp(settings);
  if(typeof draft.recipient!=='string'||!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(draft.recipient))throw Object.assign(fail('The draft needs one valid recipient address.'),{attempted:false});
  if(typeof draft.subject!=='string'||/[\r\n]/.test(draft.subject)||draft.subject.length>998||typeof draft.body!=='string'||draft.body.length>100000)throw Object.assign(fail('Draft content is invalid.'),{attempted:false});
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(['PATH','LANG','SSL_CERT_FILE','SSL_CERT_DIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const child=spawn(config.python,[path.join(ROOT,'src/ai/smtp_send.py')],{env,stdio:['pipe','pipe','pipe']});
    let output='',done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Object.assign(fail('Sending timed out. Check the inbox before retrying.'),{attempted:true}));},45000);
    child.on('error',()=>finish(Object.assign(fail('The email transport is unavailable.'),{attempted:false})));
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>10000){child.kill();finish(Object.assign(fail('SMTP response could not be verified.'),{attempted:true}));}});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('close',()=>{try{finish(null,JSON.parse(output));}catch{finish(Object.assign(fail('SMTP response could not be verified.'),{attempted:true}));}});
    child.stdin.end(JSON.stringify({settings,draft:{recipient:draft.recipient,subject:draft.subject,body:draft.body,html:emailDocumentHtml(draft.body)}}));
  });
}
