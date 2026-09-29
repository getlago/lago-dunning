import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { parseCron,nextRun,saveSchedule,Scheduler } from '../src/scheduler.js';
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receivables-schedule-'));const store=new Store(path.join(dir,'test.db'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return store;}
test('weekday schedule respects Paris timezone and skips weekends',()=>{assert.equal(nextRun('0 9 * * 1-5','Europe/Paris',new Date('2026-09-04T08:00:00Z')),'2026-09-07T07:00:00.000Z');});
test('custom ranges, lists and steps are supported',()=>{assert.equal(nextRun('*/15 8-10 * * 1,3,5','UTC',new Date('2026-09-07T08:16:00Z')),'2026-09-07T08:30:00.000Z');});
test('restricted day of month and weekday use Unix OR semantics',()=>{assert.equal(nextRun('0 9 15 * 1','UTC',new Date('2026-09-13T10:00:00Z')),'2026-09-14T09:00:00.000Z');});
test('daylight saving skips a nonexistent local time',()=>{assert.equal(nextRun('30 2 * * *','Europe/Paris',new Date('2026-03-28T02:00:00Z')),'2026-03-30T00:30:00.000Z');});
test('invalid expressions and timezone fail clearly',()=>{for(const c of ['* * *','61 * * * *','*/0 * * * *','a * * * *','0 24 * * *'])assert.throws(()=>parseCron(c));assert.throws(()=>nextRun('* * * * *','Not/AZone'),/timezone/);});
test('live schedules cannot be enabled through a preview workspace',t=>{const store=setup(t);assert.throws(()=>saveSchedule(store,{name:'daily',kind:'dunning',cron:'0 9 * * *',timezone:'UTC',mode:'live'},{allowLive:false}),/Live actions/);});
test('schedules are persisted and can be paused without deleting history',t=>{const store=setup(t);const saved=saveSchedule(store,{name:'daily',kind:'combined',cron:'0 9 * * *',timezone:'UTC'},{allowLive:false});assert(saved.next_run_at);saveSchedule(store,{...saved,enabled:false},{allowLive:false},saved.id);assert.equal(store.schedules()[0].enabled,false);assert.equal(store.schedules()[0].next_run_at,null);});
test('missed slots are coalesced to one run and claim prevents double execution',async t=>{const store=setup(t);const saved=saveSchedule(store,{name:'hourly',kind:'combined',cron:'0 * * * *',timezone:'UTC'},{allowLive:false});store.db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run('2026-01-01T00:00:00Z',saved.id);let calls=0;const scheduler=new Scheduler(store,async()=>calls++);const now=new Date('2026-09-08T12:05:00Z');await Promise.all([scheduler.tick(now),scheduler.tick(now)]);assert.equal(calls,1);assert.equal(store.schedules()[0].next_run_at,'2026-09-08T13:00:00.000Z');});
test('scheduler records failure instead of silently dropping an unavailable run',async t=>{const store=setup(t);const saved=saveSchedule(store,{name:'hourly',kind:'combined',cron:'0 * * * *',timezone:'UTC'},{allowLive:false});store.db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run('2026-01-01T00:00:00Z',saved.id);await new Scheduler(store,async()=>{throw new Error('Already running');}).tick(new Date('2026-09-08T12:05:00Z'));assert.equal(store.runs()[0].status,'failed');assert.equal(store.runs()[0].schedule_id,saved.id);});

test('reconciliation and dunning schedules retain independent timing and output settings',async t=>{
  const store=setup(t),config={allowLive:false};
  const recon=saveSchedule(store,{name:'Reconciliation',kind:'reconciliation',cron:'0 * * * *',timezone:'UTC',mode:'preview'},config);
  const dunning=saveSchedule(store,{name:'Dunning',kind:'dunning',cron:'0 9 * * 1-5',timezone:'Europe/Paris',mode:'drafts'},config);
  assert.equal(recon.kind,'reconciliation');assert.equal(dunning.kind,'dunning');
  assert.notEqual(recon.cron,dunning.cron);assert.equal(dunning.mode,'drafts');
  saveSchedule(store,{...recon,enabled:false},config,recon.id);
  assert.equal(store.schedules().find(s=>s.id===dunning.id).enabled,true);
  assert.throws(()=>saveSchedule(store,{...recon,mode:'drafts'},config),/collection workflow/);
});
