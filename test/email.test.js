import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {emailDocumentHtml} from '../public/email-format.js';
import {Store} from '../src/store.js';
import {loadConfig} from '../src/config.js';
import {EmailSettings,validateSmtp,checkSmtp} from '../src/email.js';
import {pythonCall} from '../src/ai.js';
function setup(t,check=async()=>({verified:true})){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'smtp-test-')),store=new Store(path.join(dir,'test.db')),config={...loadConfig({}),providerSettingsPath:path.join(dir,'.secrets')};t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,config,email:new EmailSettings(store,config,{check})};}
const settings={host:'smtp.example.com',port:587,security:'starttls',username:'billing',password:'PRIVATE-smtp-secret',from:'billing@example.com'};
test('SMTP settings are encrypted, secrets omitted, and a successful check marks them connected',async t=>{const {email,store,config}=setup(t);assert.equal(email.status().state,'setup');await email.save(settings);assert.equal(email.status().state,'connected');assert(!JSON.stringify(email.status({administrator:true})).includes(settings.password));assert(!store.db.prepare('SELECT ciphertext FROM smtp_settings').get().ciphertext.includes(settings.password));assert.equal(fs.statSync(path.join(config.providerSettingsPath,'smtp.key')).mode&0o777,0o600);const restored=new EmailSettings(store,config);assert.equal(restored.current().password,settings.password);assert.equal(restored.status().state,'connected');});
test('SMTP save verifies before replacing credentials; retained password cannot move to a different server',async t=>{const {email}=setup(t);await email.save(settings);await email.save({...settings,password:'',keepPassword:true});assert.equal(email.current().password,settings.password);await assert.rejects(email.save({...settings,host:'evil.example',password:'',keepPassword:true}),/both/);email.check=async()=>{throw Error('Could not connect');};await assert.rejects(email.save({...settings,password:'new-secret'}),/Could not connect/);assert.equal(email.current().password,settings.password);});
test('SMTP cannot downgrade TLS for remote servers or pass credentials over plaintext',()=>{assert.throws(()=>validateSmtp({...settings,security:'none'}),/local testing/);assert.throws(()=>validateSmtp({...settings,host:'localhost',security:'none'}),/require TLS/);assert.throws(()=>validateSmtp({...settings,host:'smtp.example.com\r\n'}),/hostname/);assert.throws(()=>validateSmtp({...settings,from:'billing@example.com\nBcc:other@example.com'}),/invalid/);});
test('Lago SMTP environment names take precedence and changes invalidate connection status',async t=>{const {email,config}=setup(t);await email.save(settings);config.smtp=loadConfig({LAGO_SMTP_ADDRESS:'smtp.other.example',LAGO_SMTP_USERNAME:'lago-user',LAGO_SMTP_PASSWORD:'lago-secret',LAGO_FROM_EMAIL:'lago@example.com',SMTP_USERNAME:'old-user'}).smtp;assert.equal(email.status().state,'configured');assert.equal(email.current().username,'lago-user');assert.equal(email.current().from,'lago@example.com');assert.equal(email.status({administrator:true}).managed,true);await assert.rejects(email.save(settings),/configured on the server/);});
test('SMTP verification uses only EHLO NOOP QUIT and refuses missing STARTTLS',async t=>{const commands=[];const server=net.createServer(socket=>{socket.write('220 local-test ESMTP\r\n');let buffer='';socket.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\r\n');buffer=lines.pop();for(const line of lines){const command=line.split(' ')[0].toUpperCase();commands.push(command);if(command==='EHLO')socket.write('250 local-test\r\n');else if(command==='NOOP')socket.write('250 OK\r\n');else if(command==='QUIT')socket.end('221 Bye\r\n');else socket.end('500 forbidden\r\n');}});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const config={python:process.env.PYTHON_PATH??'python3'},local={host:'127.0.0.1',port:server.address().port,security:'none',username:'',password:'',from:''};assert.equal((await checkSmtp(config,local)).verified,true);assert.deepEqual(commands,['EHLO','NOOP','QUIT']);await assert.rejects(checkSmtp(config,{...local,security:'starttls'}),/TLS/);assert(!commands.some(c=>['MAIL','RCPT','DATA','AUTH'].includes(c)));await assert.rejects(pythonCall({}, {operation:'send'}),/disabled/);});

test('manual SMTP sending goes only to the draft recipient and confirms only SMTP acceptance',async t=>{
  const {sendSmtp}=await import('../src/email.js');const commands=[],message=[];
  const server=net.createServer(socket=>{socket.write('220 smtp-test ESMTP\r\n');let buffer='',data=false;socket.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\r\n');buffer=lines.pop();for(const line of lines){if(data){if(line==='.') {data=false;socket.write('250 queued\r\n');}else message.push(line);continue;}const command=line.split(' ')[0].toUpperCase();commands.push(line);if(command==='EHLO')socket.write('250 test\r\n');else if(['MAIL','RCPT'].includes(command))socket.write('250 OK\r\n');else if(command==='DATA'){data=true;socket.write('354 End with dot\r\n');}else if(command==='QUIT')socket.end('221 Bye\r\n');else socket.end('500 not supported\r\n');}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={python:process.env.PYTHON_PATH??'python3'},recipient='customer@example.com',settings={host:'127.0.0.1',port:server.address().port,security:'none',username:'',password:'',from:'billing@localhost.test'};
  const body='Hi Chronicle,\n\nView invoice: https://api.lago.dev/invoices/sample.pdf?x=1&y=2\n\nThanks,\nAccounts Receivable';
  const result=await sendSmtp(config,settings,{recipient,subject:'Test reminder',body});
  assert.equal(result.accepted,true);assert(result.messageId);assert.equal(result.recipient,recipient);
  assert.deepEqual(commands.filter(c=>/^rcpt /i.test(c)).map(c=>c.toLowerCase()),['rcpt to:<customer@example.com>']);
  assert(message.includes('To: customer@example.com'));assert(!message.some(l=>/^(Cc|Bcc):/i.test(l)));
  const parsed=JSON.parse(execFileSync(config.python,['-c',`import json,sys
from email import policy
from email.parser import BytesParser
m=BytesParser(policy=policy.default).parsebytes(sys.stdin.buffer.read())
print(json.dumps({'type':m.get_content_type(),'parts':[{'type':p.get_content_type(),'body':p.get_content()} for p in m.iter_parts()]}))`],{input:message.join('\r\n'),encoding:'utf8'}));
  assert.equal(parsed.type,'multipart/alternative');
  assert.deepEqual(parsed.parts.map(p=>p.type),['text/plain','text/html']);
  assert.equal(parsed.parts[0].body.replace(/\r\n/g,'\n').trimEnd(),body);
  assert.equal(parsed.parts[1].body.replace(/\r\n/g,'\n').trimEnd(),emailDocumentHtml(body));

  for(const bad of [undefined,'','customer@example.com,other@example.com','customer@example.com; other@example.com','Customer <customer@example.com>','customer@example.com\r\nBcc: other@example.com'])assert.throws(()=>sendSmtp(config,settings,{recipient:bad,subject:'x',body:'x'}),/one valid recipient/);
  assert.equal(commands.filter(c=>/^rcpt /i.test(c)).length,1);
});

test('app rejects obsolete plaintext delivery profiles before connecting or sending',async t=>{
  const {email,config}=setup(t);const local={host:'127.0.0.1',port:1025,security:'none',from:'test@example.com'};
  let contacted=false;email.check=async()=>{contacted=true;};email.deliver=async()=>{contacted=true;};
  await assert.rejects(email.save(local),/TLS/);assert.equal(contacted,false);
  config.smtp=local;
  await assert.rejects(email.send({recipient:'customer@example.com',subject:'Test',body:'Example'}),/TLS/);assert.equal(contacted,false);
});

test('internal alerts go only to the selected alert address with the unchanged app config',async t=>{
 const {email,config}=setup(t);let captured;
 email.write({host:'smtp.example.com',port:465,security:'tls',from:'billing@example.com',username:'user',password:'pass'});
 email.deliver=async(c,s,d)=>{captured={c,d};return {accepted:true,messageId:'id'};};
 await email.sendAlert({recipient:'owner@example.com',subject:'Dunning needs attention',body:'Review INV-1'});
 assert.equal(captured.d.recipient,'owner@example.com');assert.equal(captured.c,config);
});
