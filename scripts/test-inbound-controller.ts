import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TelephoneBackend} from '../src/inbound/backend-client.js';
import {InboundJournal} from '../src/inbound/journal.js';
import {InboundController,type SecretaryHooks} from '../src/inbound/controller.js';

const id='a'.repeat(64), tenant='11111111-1111-4111-8111-111111111111';
function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forja-inbound-fixture-'));
 t.after(()=>{assert.ok(path.basename(dir).startsWith('forja-inbound-fixture-'));fs.rmSync(dir,{recursive:true,force:true});});
 const calls:Array<{route:string,body:any,token:string}>=[];
 let hooks:SecretaryHooks,readyResolve:(()=>void)|undefined;
 const state={enabled:true,loss:false,expired:false,hold:false,stopFail:false,audioFail:false,greetings:0,stops:0,hangups:0,toolLoss:false};
 const transport:typeof fetch=async(url,init)=>{
  const route=new URL(String(url)).pathname,body=JSON.parse(String(init?.body));calls.push({route,body,token:(init!.headers as any).Authorization});
  let result:any;
  if(route.endsWith('/resolver'))result={instalacionId:tenant,origenBackend:'https://backend.invalid',destino:body.destino,revision:1};
  else if(route.endsWith('/sesiones')){if(state.loss)throw Error('lost');result={llamadaId:'22222222-2222-4222-8222-222222222222',instalacionId:tenant,maxSegundos:120,expiraEn:new Date(Date.now()+(state.expired?-1000:120000)).toISOString(),nombreEmpresa:'Empresa sintética',secretaria:'Ana',herramientas:['registrar_solicitud'],configuracion:{}};}
  else {if(state.toolLoss&&body.herramienta==='registrar_solicitud')throw Error('lost');result={confirmado:true,solicitudId:'fixture'};}
  return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
 };
 const backend=new TelephoneBackend({centralOrigin:'https://central.invalid',allowedOrigins:['https://backend.invalid'],source:'fixture',sourceSecret:'s'.repeat(43),fetch:transport});
 const journal=new InboundJournal(path.join(dir,'journal.json'));
 const options={backend,journal,enabled:()=>state.enabled,engine:()=>({prepare:async(_:unknown,h:SecretaryHooks)=>{hooks=h;if(state.hold)await new Promise<void>(r=>readyResolve=r);},greet:async()=>{state.greetings++;},audio(){if(state.audioFail)throw Error('synthetic codec failure');},stop:async()=>{state.stops++;if(state.stopFail)throw Error('still open');}}),output:{audio(){},turnEnd(){},flush(){}},hangup:()=>{state.hangups++;}};
 const controller=new InboundController(options);t.after(async()=>{state.stopFail=false;await controller.terminal(id,'interrumpida').catch(()=>{});});
 return {controller,backend,journal,calls,state,options,hooks:()=>hooks!,ready:()=>readyResolve?.()};
}
test('admission persists capability before POST; tools use capability not source and replay exact receipt',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');assert.equal(f.state.greetings,0);await f.controller.connected(id);
 const data={nombre:'Persona ficticia',telefono:'+34999999002',servicio:'Consulta',descripcion:'Petición sintética de información'};
 const first=await f.hooks().tool('tool1','registrar_solicitud',data);const again=await f.hooks().tool('tool1','registrar_solicitud',data);assert.deepEqual(first,again);
 assert.equal(f.calls.filter(x=>x.body.herramienta==='registrar_solicitud').length,1);
 const admission=f.calls.find(x=>x.route.endsWith('/sesiones'))!;const op=f.calls.find(x=>x.body.herramienta==='registrar_solicitud')!;
 assert.equal(op.token,'Bearer '+admission.body.capacidad);assert.notEqual(op.token,admission.token);
 await assert.rejects(f.hooks().tool('tool1','registrar_solicitud',{...data,nombre:'Cambiado'}),/conflict/);
 await assert.rejects(f.hooks().tool('tool2','finalizar_llamada',{}),/denied/);
 await f.controller.terminal(id);assert.equal(f.controller.status().busy,false);assert.equal(f.journal.get(id)!.capability,'');
});
test('simultaneous tenants cannot occupy the global single slot',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');
 await assert.rejects(f.controller.prepare('b'.repeat(64),'+34999999002'),/capacity/);
});
test('restart retains unknown dialogs and refuses new calls',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');const restarted=new InboundController(f.options);
 assert.equal(restarted.status().states[0].state,'uncertain');await assert.rejects(restarted.prepare('b'.repeat(64),'+34999999002'),/capacity/);
 await assert.rejects(restarted.reconcile(id),/evidence/);
});
test('lost admission can reconcile after expiry using original capability',async t=>{
 const f=fixture(t);f.state.loss=true;await assert.rejects(f.controller.prepare(id,'+34999999001'));
 assert.equal(f.controller.status().busy,true);await f.controller.terminal(id,'interrumpida');
 f.state.loss=false;f.state.expired=true;await f.controller.reconcile(id);assert.equal(f.controller.status().busy,false);
 const attempts=f.calls.filter(x=>x.route.endsWith('/sesiones'));assert.deepEqual(attempts[0].body,attempts[1].body);
});
test('cancel while engine preparation is pending never becomes ready',async t=>{
 const f=fixture(t);f.state.hold=true;const preparing=f.controller.prepare(id,'+34999999001');
 while(!f.journal.get(id)?.session)await new Promise(r=>setTimeout(r,1));
 const ended=f.controller.terminal(id,'interrumpida');f.ready();await assert.rejects(preparing);await ended;
 assert.equal(f.state.greetings,0);assert.equal(f.controller.status().busy,false);
});
test('engine closure failure retains slot and is visible until confirmed retry',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');f.state.stopFail=true;
 await assert.rejects(f.controller.terminal(id),/engine_close/);assert.equal(f.journal.get(id)!.diagnostic,'engine_close_unconfirmed');assert.equal(f.controller.status().busy,true);
 f.state.stopFail=false;await f.controller.terminal(id);assert.equal(f.controller.status().busy,false);
});
test('ambiguous tool is replayed before terminal and does not release capacity',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');await f.controller.connected(id);f.state.toolLoss=true;
 await assert.rejects(f.hooks().tool('one','registrar_solicitud',{}));await assert.rejects(f.controller.terminal(id));assert.equal(f.controller.status().busy,true);
 f.state.toolLoss=false;await f.controller.reconcile(id);assert.equal(f.controller.status().busy,false);
 const bodies=f.calls.filter(x=>x.body.herramienta==='registrar_solicitud').map(x=>x.body);assert.ok(bodies.every(b=>JSON.stringify(b)===JSON.stringify(bodies[0])));
});
test('disabled service never resolves a destination',async t=>{
 const f=fixture(t);f.state.enabled=false;await assert.rejects(f.controller.prepare(id,'+34999999001'));assert.equal(f.calls.length,0);
});
test('HTTP origins must be explicitly trusted and production does not accept cleartext',()=>{
 assert.throws(()=>new TelephoneBackend({centralOrigin:'http://127.0.0.1:3197',allowedOrigins:[],source:'fixture',sourceSecret:'s'.repeat(43)}));
 assert.throws(()=>new TelephoneBackend({centralOrigin:'https://user:secret@example.invalid',allowedOrigins:[],source:'fixture',sourceSecret:'s'.repeat(43)}));
});

test('codec exceptions do not escape the audio handler and preserve uncertainty',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');await f.controller.connected(id);f.state.audioFail=true;
 assert.doesNotThrow(()=>f.controller.audio(Buffer.alloc(160)));await new Promise(r=>setTimeout(r,10));
 assert.equal(f.controller.status().busy,true);assert.equal(f.journal.get(id)!.state,'uncertain');assert.ok(f.state.hangups>0);
});
test('background persistence failure latches a visible fault instead of rejecting unhandled',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');const change=f.journal.change.bind(f.journal);
 f.journal.change=()=>{throw Error('synthetic disk failure');};
 f.hooks().fail('provider_error');await new Promise(r=>setTimeout(r,10));
 assert.equal(f.controller.status().diagnostic,'storage_or_lifecycle_failure');assert.equal(f.controller.status().busy,true);
 await assert.rejects(f.controller.prepare('b'.repeat(64),'+34999999002'));
 f.journal.change=change;
});
test('observed IA costs remain provisional and local ceiling requests hangup',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');await f.controller.connected(id);
 f.hooks().usage!({inputTokens:10,outputTokens:20,totalTokens:30,estimatedMicroUsd:100001,tariffVersion:'synthetic',observations:[{sequence:1,turn:1,complete:true,metadata:{totalTokenCount:30}}],accountingComplete:true,actualMicroUsd:null});
 await new Promise(r=>setTimeout(r,10));const usage=f.journal.get(id)!.usage!;
 assert.equal(usage.costeEstimadoMicroUsd,100001);assert.equal(usage.completo,true);assert.equal('otrosUnidades' in usage,false);assert.ok(f.state.hangups>0);
});

test('confirmed SIP duration is frozen before backend retries and reports observed excess',async t=>{
 const f=fixture(t);await f.controller.prepare(id,'+34999999001');await f.controller.connected(id);
 f.journal.change(id,r=>{r.connectedAt=Date.now()-125000;});f.state.toolLoss=true;
 await assert.rejects(f.hooks().tool('duration','registrar_solicitud',{}));await assert.rejects(f.controller.terminal(id));
 const endedAt=f.journal.get(id)!.endedAt!;assert.equal(f.journal.get(id)!.diagnostic,'duration_exceeded');
 t.mock.method(Date,'now',()=>endedAt+30000);f.state.toolLoss=false;await f.controller.reconcile(id);
 const end=f.calls.find(c=>c.body.evento===id+':terminal')!.body.datos;
 assert.ok(end.segundos>=125&&end.segundos<=126);assert.equal(f.journal.get(id)!.endedAt,endedAt);
});

test('terminal evidence arriving before delayed preflight leaves a durable rejection tombstone',async t=>{
 const f=fixture(t);await f.controller.terminal(id,'interrumpida');
 await assert.rejects(f.controller.prepare(id,'+34999999001'));assert.equal(f.calls.length,0);assert.equal(f.controller.status().busy,false);
});
