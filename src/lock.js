import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Exactly one app process owns a database. In-process coordination alone is not
// sufficient if a second server is started on another port against the same file.
export function lockDatabase(filename) {
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const lockfile=filename+'.lock',token=randomUUID();
  for(let attempt=0;attempt<2;attempt++) {
    try {
      fs.writeFileSync(lockfile,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});
      return ()=>{try{if(JSON.parse(fs.readFileSync(lockfile,'utf8')).token===token)fs.unlinkSync(lockfile);}catch{}};
    } catch(error) {
      if(error.code!=='EEXIST') throw error;
      let previous;
      try{previous=JSON.parse(fs.readFileSync(lockfile,'utf8'));}catch{throw new Error('Database lock cannot be read. Check whether another app process is running.');}
      if(!Number.isInteger(previous.pid)||previous.pid<1)throw new Error('Invalid database lock. Check whether another app process is running.');
      try{process.kill(previous.pid,0);}catch(check){if(check.code==='ESRCH'){fs.unlinkSync(lockfile);continue;}}
      throw new Error('Another app process already owns this database. Stop it before starting a second instance.');
    }
  }
  throw new Error('Could not acquire the database lock.');
}
