import crypto from 'node:crypto';
import type { UsageEstimate } from '../pilot/probe-controller.js';
import { TelephoneBackend, externalTools, BackendFailure, type AdmittedSession } from './backend-client.js';
import { InboundJournal, type InboundRecord } from './journal.js';
export interface SecretaryHooks {
  audio(raw:Buffer,turnId:number):void; turnEnd(turnId:number):void; flush(turnId:number):void;
  usage?(value:UsageEstimate):void; fail(code:string):void; tool(id:string,name:string,args:unknown):Promise<unknown>;
}
export interface SecretaryEngine {
  prepare(session:AdmittedSession,hooks:SecretaryHooks):Promise<void>;
  greet():Promise<void>; audio(raw:Buffer):void; stop():Promise<void>;
  played?(turnId:number,drained:boolean):void;
}
export interface InboundOptions {
  backend:TelephoneBackend; journal:InboundJournal; enabled:()=>boolean;
  engine:()=>SecretaryEngine;
  output:Omit<SecretaryHooks,'tool'|'fail'>;
  hangup:(id:string,reason?:string)=>void; maxMicroUsd?:number;
}
export class InboundController {
  private engine?:SecretaryEngine; private owner?:string;
  private pending=new Map<string,Promise<any>>(); private timer?:NodeJS.Timeout;
  private preparing?:Promise<any>;
  private fault=false;
  markFault(){this.fault=true;if(this.owner){try{this.options.hangup(this.owner);}catch{ /* Failed control remains uncertain. */ }}}
  background(task:Promise<unknown>){void task.catch(()=>this.markFault());}
  constructor(private readonly options:InboundOptions) {
    // Restart never assumes the remote SIP dialog ended. Explicit reconciliation is required.
    options.journal.update(records=>{for(const r of records)if(r.state!=='terminal')r.state='uncertain';});
  }
  status(){return {diagnostic:this.fault?'storage_or_lifecycle_failure':undefined,busy:this.fault||this.options.journal.read().some(r=>r.state!=='terminal'), states:this.options.journal.read().map(r=>({id:r.id,state:r.state,diagnostic:r.diagnostic}))};}
  async prepare(id:string,destination:string):Promise<{sessionId:string;maxSeconds:number}> {
    if(this.fault||!this.options.enabled()||!/^[a-f0-9]{64}$/.test(id)||!/^\+[1-9]\d{7,14}$/.test(destination))throw new Error('inbound_disabled_or_invalid');
    const existing=this.options.journal.get(id);
    if(existing) {
      if(existing.destination!==destination)throw new Error('dialog_conflict');
      if(this.owner===id&&this.preparing)return this.preparing;
      if(this.owner===id&&['ready','active'].includes(existing.state)&&existing.session)return {sessionId:id,maxSeconds:existing.session.maxSegundos};
      throw new Error('dialog_requires_reconciliation');
    }
    const capability=crypto.randomBytes(32).toString('base64url');
    this.options.journal.update(records=>{
      if(records.some(r=>r.state!=='terminal'))throw new Error('global_capacity_exhausted');
      records.push({id,destination,capability,admission:this.options.backend.admissionBody(destination,id+':admit',capability),createdAt:Date.now(),state:'preparing',operations:{}});
    });
    this.owner=id;
    this.preparing=this.doPrepare(id).finally(()=>{this.preparing=undefined;});
    return this.preparing;
  }
  private async doPrepare(id:string) {
    try {
      let r=this.record(id); const target=await this.options.backend.resolve(r.destination);
      this.options.journal.change(id,r=>{r.origin=target.origenBackend;r.installation=target.instalacionId;});
      r=this.record(id); const session=await this.options.backend.admit(r.origin!,r.admission);
      this.options.journal.change(id,r=>{r.session=session;});
      if(session.instalacionId!==target.instalacionId)throw new Error('backend_tenant_mismatch');
      if(this.record(id).ended)throw new Error('dialog_cancelled');
      const engine=this.options.engine();this.engine=engine;
      await engine.prepare(session,{
        audio:(raw,turn)=>{if(this.live(id))this.options.output.audio(raw,turn);},
        turnEnd:turn=>{if(this.live(id))this.options.output.turnEnd(turn);},
        flush:turn=>{if(this.live(id))this.options.output.flush(turn);},
        tool:(event,name,args)=>this.tool(id,event,name,args),fail:code=>{this.background(this.uncertain(id,code==='completed'));},
        usage:value=>{if(value.observations?.length)this.options.journal.change(id,r=>{r.usage={completo:value.accountingComplete===true,iaEntradaTokens:value.inputTokens,iaSalidaTokens:value.outputTokens,...(value.tariffVersion?{versionTarifa:value.tariffVersion}:{}),...(value.estimatedMicroUsd===null?{}:{costeEstimadoMicroUsd:value.estimatedMicroUsd})};});if(value.estimatedMicroUsd!==null&&value.estimatedMicroUsd>=(this.options.maxMicroUsd??100000))this.background(this.uncertain(id));},
      });
      if(!this.options.enabled()||this.record(id).ended||this.record(id).state!=='preparing')throw new Error('admission_cancelled');
      this.options.journal.change(id,r=>{r.state='ready';});
      this.timer=setTimeout(()=>{this.background(this.uncertain(id));},Math.min(session.maxSegundos*1000,Date.parse(session.expiraEn)-Date.now()));
      this.timer.unref();
      return {sessionId:id,maxSeconds:session.maxSegundos};
    } catch(e) {
      const stopped=await this.stopEngine();
      const r=this.record(id);
      if(!stopped){this.options.journal.change(id,r=>{r.state='uncertain';});throw new Error('engine_close_unconfirmed');}
      if(r.ended&&r.session)await this.finalize(id,r.ended).catch(()=>{});
      else if(!r.origin || (e instanceof BackendFailure&&!e.uncertain&&!r.session))this.options.journal.change(id,r=>{r.state='terminal';});
      else this.options.journal.change(id,r=>{r.state='uncertain';});
      throw new Error('admission_unavailable');
    }
  }
  async connected(id:string) {
    const r=this.record(id);if(this.owner!==id||r.state!=='ready'||!this.options.enabled())throw new Error('not_ready');
    this.options.journal.change(id,r=>{r.state='active';r.connectedAt=Date.now();});
    try {await this.engine!.greet();}catch {await this.uncertain(id);}
  }
  audio(raw:Buffer){try{if(this.owner&&this.live(this.owner))this.engine?.audio(raw);}catch{if(this.owner)this.background(this.uncertain(this.owner));else this.markFault();}}
  played(turn:number,drained:boolean){try{this.engine?.played?.(turn,drained);}catch{if(this.owner)this.background(this.uncertain(this.owner));else this.markFault();}}
  private live(id:string){return !this.fault&&this.owner===id&&this.record(id).state==='active'&&this.options.enabled();}
  private record(id:string):InboundRecord {const r=this.options.journal.get(id);if(!r)throw new Error('unknown_dialog');return r;}
  async tool(id:string,event:string,name:string,args:unknown) {
    const r=this.record(id);
    if(!this.live(id)||!r.session||Date.parse(r.session.expiraEn)<=Date.now()||!externalTools.includes(name as any)||!r.session.herramientas.includes(name)||!/^[A-Za-z0-9_-]{1,64}$/.test(event))throw new Error('tool_denied');
    return this.operation(id,id+':'+event,name,args);
  }
  private async operation(id:string,event:string,name:string,args:unknown):Promise<unknown> {
    const r=this.record(id);if(!r.session||!r.origin)throw new Error('session_unresolved');
    const body={llamadaId:r.session.llamadaId,evento:event,herramienta:name,datos:args};
    this.options.journal.change(id,r=>{const prior=r.operations[event];if(prior&&JSON.stringify(prior.body)!==JSON.stringify(body))throw new Error('operation_conflict');if(!prior)r.operations[event]={body};});
    const op=this.record(id).operations[event];if(op.settled){if(op.rejected)throw new Error('operation_rejected');return op.response;}
    const underway=this.pending.get(event);if(underway)return underway;
    const promise=this.options.backend.operate(r.origin,r.capability,op.body).then(response=>{
      this.options.journal.change(id,r=>{r.operations[event].response=response;r.operations[event].settled=true;});return response;
    }).catch(error=>{if(error instanceof BackendFailure&&!error.uncertain)this.options.journal.change(id,r=>{r.operations[event].settled=true;r.operations[event].rejected=true;});throw error;}).finally(()=>{this.pending.delete(event);});this.pending.set(event,promise);return promise;
  }
  async uncertain(id:string,completed=false) {
    const r=this.options.journal.get(id);if(!r||r.state==='terminal'||r.ended)return;
    this.options.journal.change(id,r=>{r.state='uncertain';});this.options.hangup(id,completed?'completed':'interrupted');await this.stopEngine();
    if(r.session){const prior=this.record(id).operations[id+':uncertain'];await this.operation(id,id+':uncertain','finalizar_llamada',prior?.body.datos??{estado:'incierta',segundos:this.seconds(r),uso:r.usage}).catch(()=>{});}
  }
  async terminal(id:string,state:'finalizada'|'interrumpida'='finalizada') {
    const r=this.options.journal.get(id);if(!r){this.options.journal.update(records=>{if(!records.some(r=>r.id===id))records.push({id,destination:'',capability:'',admission:{},createdAt:Date.now(),endedAt:Date.now(),ended:state,state:'terminal',operations:{}});});return;} if(r.state==='terminal')return;
    this.options.journal.change(id,r=>{r.ended??=state;r.endedAt??=Date.now();r.state='uncertain';if(r.connectedAt&&r.endedAt-r.connectedAt>120000)r.diagnostic='duration_exceeded';});if(!await this.stopEngine())throw new Error('engine_close_unconfirmed');
    if(this.preparing&&this.owner===id){await this.preparing.catch(()=>{});}
    if(this.record(id).session)await this.finalize(id,state);
    else if(this.record(id).origin)this.options.journal.change(id,r=>{r.state='uncertain';});
    else this.options.journal.change(id,r=>{r.state='terminal';});
  }
  private async finalize(id:string,state:'finalizada'|'interrumpida') {
    if(this.record(id).state==='terminal')return;
    await Promise.allSettled([...this.pending.values()]);
    for(const op of Object.values(this.record(id).operations)){if(!op.settled&&op.body.herramienta!=='finalizar_llamada')await this.operation(id,op.body.evento,op.body.herramienta,op.body.datos);}
    const r=this.record(id);const event=id+':terminal';
    const prior=r.operations[event];
    const data=prior?.body.datos??{estado:r.ended??state,segundos:this.seconds(r),uso:r.usage};
    try {await this.operation(id,event,'finalizar_llamada',data);
      this.options.journal.change(id,r=>{r.state='terminal'; r.capability='';r.admission={};r.operations={};});
      if(this.owner===id)this.owner=undefined;
    }catch{this.options.journal.change(id,r=>{r.state='uncertain';});throw new Error('finalization_unconfirmed');}
  }
  /** Operator/bridge-confirmed terminal reconciliation; never infer termination from restart. */
  async reconcile(id:string) {
    const r=this.record(id);if(!r.ended)throw new Error('terminal_evidence_required');
    if(!r.session&&r.origin){const session=await this.options.backend.admit(r.origin,r.admission,undefined,true);this.options.journal.change(id,r=>{r.session=session;});}
    if(!await this.stopEngine())throw new Error('engine_close_unconfirmed');
    if(this.record(id).session)await this.finalize(id,r.ended);
  }
  private seconds(r:InboundRecord){return Math.min(86400,Math.max(0,Math.ceil(((r.endedAt??Date.now())-(r.connectedAt??(r.endedAt??Date.now())))/1000)));}
  private async stopEngine():Promise<boolean>{if(this.timer)clearTimeout(this.timer);this.timer=undefined;const engine=this.engine;if(!engine)return true;try{await engine.stop();this.engine=undefined;return true;}catch{if(this.owner)this.options.journal.change(this.owner,r=>{r.state='uncertain';r.diagnostic='engine_close_unconfirmed';});return false;}}
}
