import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.js';
import {QontoSettings, QontoSandbox} from '../src/qonto-settings.js';

function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qonto-settings-'));
  const config={...loadConfig({APP_MODE:'demo',ADMIN_KEYS:'owner'}),providerSettingsPath:path.join(dir,'.secrets'),databasePath:path.join(dir,'workspace.db')};
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {config,dir};
}
test('administrator saves credentials once; encryption key is generated and secrets stay off API responses',t=>{
  const {config,dir}=setup(t), settings=new QontoSettings(config);
  const result=settings.save('production',{clientId:'app-id',clientSecret:'PRIVATE-CLIENT-SECRET'});
  assert(result.production.configured);assert(!JSON.stringify(result).includes('PRIVATE-'));
  assert.equal(config.qontoOAuth.encryptionKey.length,64);
  const disk=fs.readFileSync(path.join(dir,'.secrets/qonto.enc'),'utf8');assert(!disk.includes('PRIVATE-'));
  assert.equal(fs.statSync(path.join(dir,'.secrets/qonto.key')).mode&0o777,0o600);
  const fresh={...loadConfig({APP_MODE:'demo',ADMIN_KEYS:'owner'}),providerSettingsPath:config.providerSettingsPath};
  new QontoSettings(fresh);assert.equal(fresh.qontoOAuth.clientSecret,'PRIVATE-CLIENT-SECRET');
  assert.equal(fresh.qontoOAuth.encryptionKey,config.qontoOAuth.encryptionKey);
  settings.save('production',{clientId:'app-id',clientSecret:''});assert.equal(config.qontoOAuth.clientSecret,'PRIVATE-CLIENT-SECRET');
});
test('sandbox and production settings remain distinct and test payments never touch workspace data',async t=>{
  const {config}=setup(t), settings=new QontoSettings(config);
  settings.save('production',{clientId:'production-client',clientSecret:'prod-secret'});
  settings.save('sandbox',{clientId:'sandbox-client',clientSecret:'test-secret',stagingToken:'test-staging'});
  assert.equal(config.qontoOAuth.clientId,'production-client');
  const sandbox=new QontoSandbox(config);t.after(()=>sandbox.close());
  assert.equal(sandbox.oauth.apiBase,'https://thirdparty-sandbox.staging.qonto.co/v2');
  assert.equal(sandbox.config.allowLive,false);assert.equal(sandbox.config.qontoOAuth.clientId,'sandbox-client');
  const flow=sandbox.oauth.begin('http://localhost:4320');
  assert.equal(new URL(flow.url).origin,'https://oauth-sandbox.staging.qonto.co');
  sandbox.connector.listIncoming=async()=>[{amountCents:999999}];
  assert.equal((await sandbox.sync()).count,1);
  assert.equal(sandbox.store.listTransfers().length,0);
  assert.equal(fs.existsSync(config.databasePath),false);
  assert.equal(config.requiredSources.includes('qonto'),false);
  sandbox.connector.listIncoming=async()=>{throw new Error('Unavailable');};
  await assert.rejects(sandbox.sync());assert.equal(sandbox.status().test,null);
});
test('tampered administrator credential file fails closed',t=>{
  const {config,dir}=setup(t),settings=new QontoSettings(config);
  settings.save('production',{clientId:'app',clientSecret:'secret'});
  fs.writeFileSync(path.join(dir,'.secrets/qonto.key'),Buffer.alloc(32));
  assert.throws(()=>new QontoSettings(config),/could not be opened/);
});
