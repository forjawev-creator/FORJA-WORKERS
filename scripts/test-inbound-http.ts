import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {TelephoneBackend} from '../src/inbound/backend-client.js';
import {InboundJournal} from '../src/inbound/journal.js';
import {createInboundServer} from '../src/inbound/server.js';
import type {SecretaryHooks} from '../src/inbound/controller.js';

test('synthetic SIP traverses authenticated loopback preflight, backend HTTP, engine tools and confirmed terminal',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forja-inbound-http-'));
 const tenant='11111111-1111-4111-8111-111111111111';const calls:any[]=[];let origin='',capability='',hooks:SecretaryHooks;let audioBytes=0;
 const backendServer=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);
  res.setHeader('Content-Type','application/json');
  if(req.url!.endsWith('/resolver'))res.end(JSON.stringify({instalacionId:tenant,origenBackend:origin,destino:body.destino,revision:1}));
  else if(req.url!.endsWith('/sesiones')){capability=body.capacidad;res.end(JSON.stringify({llamadaId:'22222222-2222-4222-8222-222222222222',instalacionId:tenant,nombreEmpresa:'Empresa sintética',maxSegundos:120,expiraEn:new Date(Date.now()+120000).toISOString(),secretaria:'Ana',herramientas:['registrar_solicitud'],configuracion:{}}));}
  else {assert.equal(req.headers.authorization,'Bearer '+capability);res.end(JSON.stringify({confirmado:true,solicitudId:'synthetic-result'}));}
 });
 await new Promise<void>(r=>backendServer.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+(backendServer.address() as any).port;
 const token='t'.repeat(43);
 const backend=new TelephoneBackend({centralOrigin:origin,allowedOrigins:[origin],source:'fixture',sourceSecret:'s'.repeat(43),fetch:fetch,testTransport:true});
 const app=createInboundServer({backend,journal:new InboundJournal(path.join(dir,'journal.json')),enabled:()=>true,controlToken:token,controlPort:0,audioPort:0,
  engine:()=>({prepare:async(_,h)=>{hooks=h;},greet:async()=>{await hooks.tool('request1','registrar_solicitud',{nombre:'Persona sintética',telefono:'+34999999002',servicio:'Consulta',descripcion:'Solicitud de información sintética'});hooks.fail('completed');},audio:raw=>{audioBytes+=raw.length;},stop:async()=>{}})});
 try{
  await app.listen();const controlPort=(app.server.address() as any).port,audioPort=(app.tcp.address() as any).port;
  const unauth=await fetch('http://127.0.0.1:'+controlPort+'/status');assert.equal(unauth.status,401);
  const result=await new Promise<any>((resolve,reject)=>{
   const child=spawn(process.env.PYTHON_BIN??'python',[path.join(import.meta.dirname,'inbound-sip-fixture.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
   const timer=setTimeout(()=>{child.kill();reject(new Error('synthetic trajectory deadline'));},25000);
   child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);if(code===0){try{resolve(JSON.parse(out));}catch{reject(new Error('invalid fixture result'));}}else reject(new Error('fixture failed: '+err));});
   child.stdin.end(JSON.stringify({token,controlPort,audioPort,destination:'+34999999001',installation:tenant}));
  });
  assert.equal(result.provisionalBeforeAnswer,true);assert.equal(result.started,1);assert.equal(result.ended,1);assert.equal(result.terminalConfirmed,true);
  assert.equal(app.controller.status().busy,false);assert.equal(calls.filter(c=>c.herramienta==='registrar_solicitud').length,1);assert.ok(calls.some(c=>c.herramienta==='finalizar_llamada'&&c.datos.estado==='finalizada'));
  assert.ok(audioBytes===0||audioBytes===160); // input may arrive after the instantaneous fake tool finishes
 }finally{await app.close();await new Promise<void>(r=>backendServer.close(()=>r()));assert.ok(path.basename(dir).startsWith('forja-inbound-http-'));fs.rmSync(dir,{recursive:true,force:true});}
});
