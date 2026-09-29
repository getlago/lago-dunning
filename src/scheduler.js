import { randomUUID } from 'node:crypto';

// Five-field Unix cron. Day-of-month and weekday use the usual OR semantics.
export function parseCron(expression) {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Use five fields: minute hour day month weekday');
  const bounds = [[0,59],[0,23],[1,31],[1,12],[0,7]];
  return fields.map((field,i)=>{
    const [min,max]=bounds[i], values=new Set();
    for (const part of field.split(',')) {
      const match=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error(`Invalid cron field: ${field}`);
      const step=match[2] ? Number(match[2]) : 1;
      if (step < 1 || step > max-min+1) throw new Error('Cron step is outside the allowed range');
      const range=match[1]==='*' ? [min,max] : match[1].includes('-') ? match[1].split('-').map(Number) : [Number(match[1]),match[2] ? max : Number(match[1])];
      if (range[0]<min || range[1]>max || range[0]>range[1]) throw new Error(`Cron field is outside ${min}–${max}`);
      for(let n=range[0];n<=range[1];n+=step) values.add(i===4 && n===7 ? 0 : n);
    }
    return { values, wildcard: field.startsWith('*') };
  });
}

export function nextRun(expression, timezone, after = new Date()) {
  const cron=parseCron(expression);
  let format;
  try { format=new Intl.DateTimeFormat('en-US',{timeZone:timezone,minute:'numeric',hour:'numeric',hourCycle:'h23',day:'numeric',month:'numeric',weekday:'short'}); }
  catch { throw new Error('Choose a valid timezone, such as Europe/Paris'); }
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const start=Math.floor(new Date(after).getTime()/60000)*60000+60000;
  // Scan UTC instants, so daylight-saving gaps and repeated hours are handled explicitly.
  for(let time=start;time<start+370*86400000;time+=60000) {
    const p=Object.fromEntries(format.formatToParts(time).map(x=>[x.type,x.value]));
    if(!cron[0].values.has(+p.minute)||!cron[1].values.has(+p.hour)||!cron[3].values.has(+p.month)) continue;
    const dom=cron[2].values.has(+p.day), dow=cron[4].values.has(days.indexOf(p.weekday));
    const dayMatches=cron[2].wildcard||cron[4].wildcard ? dom&&dow : dom||dow;
    if(dayMatches) return new Date(time).toISOString();
  }
  throw new Error('This expression has no run in the next year');
}

export function saveSchedule(store, input, config, id = randomUUID()) {
  const {name,cron,timezone,mode='preview',enabled=true}=input;
  const kind=input.kind==='combined'?'dunning':input.kind;
  if(!name?.trim()||name.length>100) throw new Error('Give the schedule a name under 100 characters');
  if(!['dunning','reconciliation'].includes(kind)) throw new Error('Choose a valid workflow');
  if(mode==='live') throw new Error('Live actions have been removed. Choose preview or saved drafts.');
  if(!['preview','drafts'].includes(mode)) throw new Error('Choose preview or saved drafts');
  if(mode==='drafts' && kind==='reconciliation') throw new Error('Saved drafts require a collection workflow');
  if(typeof enabled!=='boolean') throw new Error('Enabled must be true or false');
  const next=nextRun(cron,timezone);
  store.db.prepare(`INSERT INTO schedules(id,name,kind,cron,timezone,mode,enabled,next_run_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,cron=excluded.cron,timezone=excluded.timezone,
    mode=excluded.mode,enabled=excluded.enabled,next_run_at=excluded.next_run_at`)
    .run(id,name.trim(),kind,cron.trim(),timezone,mode,Number(enabled),enabled?next:null,new Date().toISOString());
  return store.schedules().find(x=>x.id===id);
}

export class Scheduler {
  constructor(store, execute) {this.store=store;this.execute=execute;this.busy=false;}
  async tick(now=new Date()) {
    if(this.busy) return;
    this.busy=true;
    try {
      for(const schedule of this.store.schedules().filter(x=>x.enabled && x.next_run_at<=now.toISOString())) {
        const next=nextRun(schedule.cron,schedule.timezone,now);
        const claim=this.store.db.prepare('UPDATE schedules SET next_run_at=?,last_run_at=? WHERE id=? AND next_run_at=? AND enabled=1')
          .run(next,now.toISOString(),schedule.id,schedule.next_run_at);
        if(!claim.changes) continue;
        try {await this.execute(schedule.kind,schedule.mode,'schedule',schedule.id);}
        catch(error) {
          const id=this.store.startRun(schedule.kind,schedule.mode,'schedule',schedule.id);
          this.store.finishRun(id,null,error.message);
        }
      }
    } finally {this.busy=false;}
  }
  start() {this.timer=setInterval(()=>this.tick().catch(()=>{}),15000);this.timer.unref();}
  stop() {clearInterval(this.timer);}
}
