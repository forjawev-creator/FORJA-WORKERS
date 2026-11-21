import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AdmittedSession } from './backend-client.js';
export interface Operation { body: any; response?: unknown; settled?: boolean; rejected?:boolean }
export interface InboundRecord {
  id:string; destination:string; capability:string; admission:unknown; createdAt:number;
  state:'preparing'|'ready'|'active'|'uncertain'|'terminal'; origin?:string; installation?:string;
  session?:AdmittedSession; ended?:'finalizada'|'interrumpida'; connectedAt?:number; endedAt?:number;
  operations:Record<string,Operation>; diagnostic?:string; usage?:{completo:boolean;iaEntradaTokens:number;iaSalidaTokens:number;versionTarifa?:string;costeEstimadoMicroUsd?:number};
}
/** Private durable intent log. No transcripts; business fields only until reconciliation. */
export class InboundJournal {
  constructor(readonly file:string) {}
  read():InboundRecord[] {
    if(!fs.existsSync(this.file)) return [];
    const v=JSON.parse(fs.readFileSync(this.file,'utf8'));
    if(!Array.isArray(v)||v.some(r=>!r || !/^[a-f0-9]{64}$/.test(r.id)||!['preparing','ready','active','uncertain','terminal'].includes(r.state)||!r.operations)) throw new Error('invalid_inbound_journal');
    return v;
  }
  update(action:(records:InboundRecord[])=>void):void {
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const lock=fs.openSync(this.file+'.lock','wx',0o600), temp=this.file+'.'+crypto.randomUUID()+'.tmp';
    try { const records=this.read(); action(records); const fd=fs.openSync(temp,'wx',0o600);
      try { fs.writeFileSync(fd,JSON.stringify(records)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp,this.file);
      if(process.platform!=='win32') { const dir=fs.openSync(path.dirname(this.file),'r'); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);} }
    } finally {if(fs.existsSync(temp))fs.unlinkSync(temp);fs.closeSync(lock);fs.unlinkSync(this.file+'.lock');}
  }
  change(id:string, action:(record:InboundRecord)=>void) {this.update(records=>{const r=records.find(x=>x.id===id);if(!r)throw new Error('missing_inbound_record');action(r);});}
  get(id:string) {return this.read().find(r=>r.id===id);}
}
