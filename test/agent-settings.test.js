import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { AgentSettings } from '../src/agent-settings.js';
import { pythonCall } from '../src/ai.js';

function setup(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-settings-'));
  const store=new Store(path.join(dir,'workspace.db'));
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const config=loadConfig({AWS_BEARER_TOKEN_BEDROCK:'PRIVATE-KEY'});
  return {store,config,dir,settings:new AgentSettings(store,config,options)};
}
test('model changes are validated, persisted and resolved separately from environment defaults',async t=>{
  let calls=0;
  const {settings,store,config}=setup(t,{call:async(selected,data)=>{calls++;assert.equal(selected.modelName,'amazon.test-model:0');assert.deepEqual(data,{operation:'check_model'});return {verified:true};}});
  const saved=await settings.save({model:'amazon.test-model:0',instructions:' Reply in French. ',revision:0});
  assert.equal(saved.revision,1);assert.equal(saved.checking,false);assert.equal(calls,1);
  assert.equal(config.modelName,'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  const restarted=new AgentSettings(store,config);
  assert.equal(restarted.runtime().modelName,'amazon.test-model:0');assert.equal(restarted.runtime().agentInstructions,'Reply in French.');
  assert(!JSON.stringify(restarted.status()).includes('PRIVATE-KEY'));
  assert.equal(new AgentSettings(store,{...config,modelProvider:'anthropic',modelName:'claude-test'}).current().model,'claude-test');
});
test('failed model checks retain the previous settings',async t=>{
  const {settings}=setup(t,{call:async()=>({verified:false})});
  const before=settings.current();
  await assert.rejects(settings.save({model:'invalid-model',instructions:'',revision:0}),/could not use/);
  assert.deepEqual(settings.current(),before);assert.equal(settings.checking,false);
  settings.call=async()=>{throw new Error('Unavailable');};
  await assert.rejects(settings.save({model:'invalid-model',instructions:'',revision:0}),/Unavailable/);
  assert.deepEqual(settings.current(),before);assert.equal(settings.checking,false);
});
test('stale and overlapping changes are rejected and invalid input never invokes a model',async t=>{
  let resolve;
  const {settings}=setup(t,{call:()=>new Promise(r=>resolve=r)});
  for(const data of [{model:'bad model',instructions:'',revision:0},{model:'good-model',instructions:'x'.repeat(2001),revision:0},{model:'good-model',instructions:'',revision:5}])await assert.rejects(settings.save(data));
  const pending=settings.save({model:'good-model',instructions:'',revision:0});
  await assert.rejects(settings.save({model:'other-model',instructions:'',revision:0}),/already in progress/);
  resolve({verified:true});await pending;
  await assert.rejects(settings.save({model:'other-model',instructions:'',revision:0}),/settings changed/);
});
test('Bedrock discovery includes paginated profiles, filters unsuitable base models and sends credentials only to AWS',async t=>{
  const calls=[];
  const {settings}=setup(t,{fetcher:async(url,options)=>{
    calls.push(url);assert.equal(new URL(url).origin,'https://bedrock.us-east-1.amazonaws.com');assert.equal(options.headers.Authorization,'Bearer PRIVATE-KEY');assert.equal(options.redirect,'error');
    if(url.includes('foundation-models'))return Response.json({modelSummaries:[
      {modelId:'vendor.text:0',modelName:'Text model',providerName:'Vendor',inputModalities:['TEXT'],outputModalities:['TEXT'],inferenceTypesSupported:['ON_DEMAND']},
      {modelId:'vendor.legacy',modelName:'Old',inputModalities:['TEXT'],outputModalities:['TEXT'],inferenceTypesSupported:['ON_DEMAND'],modelLifecycle:{status:'LEGACY'}},
      {modelId:'vendor.image',inputModalities:['TEXT'],outputModalities:['IMAGE'],inferenceTypesSupported:['ON_DEMAND']}]});
    if(url.includes('nextToken'))return Response.json({inferenceProfileSummaries:[{inferenceProfileId:'eu.vendor.text:0',inferenceProfileName:'EU text',status:'ACTIVE',models:[{modelArn:'arn:aws:bedrock:eu-west-1::foundation-model/vendor.text:0'}]},
      {inferenceProfileId:'us.vendor.image',inferenceProfileName:'Image profile',status:'ACTIVE',models:[{modelArn:'arn:aws:bedrock:us-east-1::foundation-model/vendor.image'}]},
      {inferenceProfileId:'unknown-image',inferenceProfileName:'Unknown',status:'ACTIVE'}]});
    return Response.json({inferenceProfileSummaries:[{inferenceProfileId:'us.vendor.text:0',inferenceProfileName:'US text',status:'ACTIVE',models:[{modelArn:'arn:aws:bedrock:us-east-1::foundation-model/vendor.text:0'}]}],nextToken:'page-2'});
  }});
  const catalog=await settings.catalog();assert.equal(calls.length,3);
  assert(catalog.models.some(m=>m.id==='vendor.text:0'));assert(catalog.models.some(m=>m.id==='eu.vendor.text:0'));
  assert(!catalog.models.some(m=>['vendor.image','vendor.legacy','us.vendor.image','unknown-image'].includes(m.id)));
  assert(!JSON.stringify(catalog).includes('PRIVATE-KEY'));
});
test('denied discovery never claims the current model is verified and hides provider error bodies',async t=>{
  const {settings}=setup(t,{fetcher:async()=>new Response('PRIVATE-provider-error',{status:403})});
  const catalog=await settings.catalog();assert.equal(catalog.models.length,1);assert.match(catalog.notice,/cannot list/);
  assert(!JSON.stringify(catalog).includes('PRIVATE'));assert.equal(settings.status().checkedAt,null);
});
test('selected model and preferences reach the Python boundary without bank credentials',async t=>{
  const {config,dir}=setup(t);
  const executable=path.join(dir,'fake-python');
  fs.writeFileSync(executable,`#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({model:process.env.BEDROCK_MODEL_ID,provider:process.env.MODEL_PROVIDER,region:process.env.AWS_DEFAULT_REGION,input:JSON.parse(input),bank:process.env.LAGO_API_KEY??null})));`,{mode:0o700});
  const result=await pythonCall({...config,python:executable,modelName:'amazon.selected:0',agentInstructions:'Concise please'},{message:'Hello',history:'[]'});
  assert.equal(result.model,'amazon.selected:0');assert.equal(result.region,'us-east-1');assert.equal(result.input.instructions,'Concise please');assert.equal(result.bank,null);
});
