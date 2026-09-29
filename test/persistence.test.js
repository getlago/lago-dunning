import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {saveSchedule} from '../src/scheduler.js';

test('completed runs, conversations, customer holds and schedules survive a closed database',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receivables-restart-')),file=path.join(dir,'workspace.db');
  let store=new Store(file);
  try {
    const thread=store.newThread();store.message(thread.id,'user','Check invoices');
    const run=store.startRun('combined','preview','test');store.finishRun(run,{collection:{ready:3}});
    store.pause('customer',true,'Payment under review');
    saveSchedule(store,{name:'Daily preview',kind:'combined',cron:'0 9 * * *',timezone:'Europe/Paris'},{allowLive:false});
    store.close();store=new Store(file);store.recover();
    assert.equal(store.messages(thread.id)[0].text,'Check invoices');
    assert.equal(store.run(run).status,'completed');assert.equal(store.run(run).result.collection.ready,3);
    assert.equal(store.memory('customer').paused,1);assert.equal(store.schedules()[0].name,'Daily preview');
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
