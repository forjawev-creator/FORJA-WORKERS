const {test,afterEach} = require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createRuntime}=require('./workers-test-runtime.cjs');
const runtimes=[];
function runtime(cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forja-workers-test-')),overrides){const r=createRuntime(cwd,overrides);r.cwd=cwd;runtimes.push(r);return r}
afterEach(()=>{for(const r of runtimes.splice(0))r.dispose()});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await wait(5)}throw Error('Tiempo de espera agotado')}
function seed(r,extra={}){
 fs.mkdirSync(path.join(r.cwd,"data"),{recursive:true});fs.writeFileSync(path.join(r.cwd,"data/runtime-policy.json"),JSON.stringify({realCallsEnabled:true,realWhatsAppEnabled:true}));
 const storage=r.load('src/crm/crm-storage.ts').crmStorage;
 storage.transaction(db=>{
   db.leads=[{id:'lead-1',proyecto_id:db.proyectos[0].id,campania_id:db.campanias[0].id,place_id:'place-test',empresa_nombre:'Negocio de ensayo',telefono:'+34600000000',telefono_original:'+34600000000',telefono_confirmado:'+34600000000',categoria_maps:'Oficio',oficio_mapeado:'oficio',ciudad:'Madrid',estado:'cola_llamada',veces_llamado:0,veces_whatsapp:0,token_seguimiento:'token-1',url_propuesta:'https://example.test/muestra/negocio-1',consentimiento_whatsapp:true,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...extra}];
   db.propuestas=[{id:'proposal-1',lead_id:'lead-1',proyecto_id:db.proyectos[0].id,token_seguimiento:'token-1',url_publica:'https://example.test/muestra/negocio-1'}];
   db.settings.whatsapp_worker_config={enabled:true,provider:'baileys',maxDailyMessages:50};
 });return storage;
}
function callsWorker(r){return new (r.load('src/crm/call-worker.ts').CallWorker)({mode:'netelip',overrideHorario:true,pollIntervalMs:5,callCooldownMs:100000,dialTimeoutMs:100000})}

function blockCommunications(r){fs.writeFileSync(path.join(r.cwd,'data/runtime-policy.json'),JSON.stringify({realCallsEnabled:false,realWhatsAppEnabled:false}))}
test('Política ausente, corrupta o con valores no booleanos bloquea comunicaciones',()=>{
 const r=runtime(),policy=r.load('src/runtime-policy.ts').runtimePolicy;
 assert.equal(policy().controlOnly,true);
 fs.mkdirSync(path.join(r.cwd,'data'),{recursive:true});
 for(const value of ['{','{}','{"realCallsEnabled":"true","realWhatsAppEnabled":1}']){
  fs.writeFileSync(path.join(r.cwd,'data/runtime-policy.json'),value);assert.equal(policy().controlOnly,true);
 }
});
test('Modo seguro permite iniciar y detener llamadas sin reservar ni marcar',async()=>{
 const r=runtime(),db=seed(r);blockCommunications(r);const before=JSON.stringify(db.getDb()),w=callsWorker(r);
 assert.equal(w.start().success,true);await until(()=>w.getStatus().lastLog.includes('bloqueadas'));
 assert.equal(w.getStatus().running,true);assert.equal(w.getStatus().safety.controlOnly,true);
 assert.equal(r.calls.dial,0);assert.equal(JSON.stringify(db.getDb()),before);assert.equal((await w.stop()).success,true);
 assert.equal(w.getStatus().running,false);
});
test('Modo seguro bloquea marcado manual, centralita y transferencias antes de acceder a la red',async()=>{
 const r=runtime(undefined,{'src/bridge-manager.ts':null,'@module:dgram':{}});seed(r);blockCommunications(r);
 const b=r.load('src/bridge-manager.ts');assert.equal(b.startBridge().success,false);
 assert.equal((await b.dialNetelip('+34600000000','Ensayo')).success,false);
 assert.equal((await b.transferNetelip('+34600000000')).success,false);
 assert.equal(await b.sendNetelipCommand('DIAL +34600000000'),false);
});
test('Modo seguro bloquea conexión y envío WhatsApp incluso con un socket existente',async()=>{
 const forbidden=()=>{throw Error('Proveedor real no permitido')};
 const r=runtime(undefined,{'src/whatsapp/baileys-service.ts':null,'src/whatsapp/whatsapp-ai-responder.ts':{},
 '@module:qrcode':{},'@module:pino':forbidden,'@module:@whiskeysockets/baileys':{default:forbidden,useMultiFileAuthState:forbidden,fetchLatestBaileysVersion:forbidden}});
 seed(r);blockCommunications(r);const service=r.load('src/whatsapp/baileys-service.ts').baileysWhatsAppService;
 assert.equal((await service.startConnection()).status,'disconnected');
 service.sock={sendMessage:forbidden};assert.equal(service.getSocket(),null);
 assert.equal((await service.sendMessage('+34600000000','Ensayo')).success,false);
});
test('Modo seguro conserva pendiente WhatsApp sin enviar ni consumir cuota',async()=>{
 const r=runtime(),db=seed(r);blockCommunications(r);enqueue(r);await consumer(r).processNextBatch();
 assert.equal(r.calls.messages.length,0);assert.equal(db.getDailyWhatsAppCount(),0);
 assert.ok(fs.existsSync(path.join(r.cwd,'data/outbox/whatsapp/pending/evt-1.json')));
});
test('La parada cuelga antes de liberar y permite reiniciar',async()=>{
 const r=runtime(),db=seed(r),w=callsWorker(r);w.start();await until(()=>w.activeCallFinisher);
 let heldAtHangup=false;r.transport.hangup=async()=>{heldAtHangup=db.getDb().leads[0].estado==='en_llamada';return {success:true}};
 const result=await w.stop();assert.equal(result.success,true);assert.equal(r.calls.hangup,1);assert.equal(heldAtHangup,true);assert.equal(w.getStatus().activeCall,null);assert.equal(db.getDb().lineas.some(l=>l.en_uso),false);assert.equal(w.start().success,true);await w.stop();
});
test('Parar mientras marca espera el marcado, cuelga una vez y no lanza otra llamada',async()=>{
 const r=runtime();seed(r);const w=callsWorker(r);let finish;r.transport.dial=()=>new Promise(resolve=>{finish=resolve});w.start();await until(()=>finish);
 const stop=w.stop();assert.equal(w.start().success,false);finish({success:true});assert.equal((await stop).success,true);assert.equal(r.calls.hangup,1);assert.equal(r.calls.dial,1);assert.equal(w.getStatus().activeCall,null);
});
test('Colgado fallido mantiene reserva y bloquea reinicio hasta colgar con éxito',async()=>{
 const r=runtime(),db=seed(r),w=callsWorker(r);w.start();await until(()=>w.activeCallFinisher);
 r.transport.hangup=async()=>({success:false});assert.equal((await w.stop()).success,false);assert.equal(db.getDb().leads[0].estado,'en_llamada');assert.equal(w.start().success,false);
 r.transport.hangup=async()=>({success:true});assert.equal((await w.stop()).success,true);assert.equal(w.getStatus().activeCall,null);
});
test('Llamada simulada de transporte completa autorización y libera la línea; ignora otra sesión',async()=>{
 const r=runtime(),db=seed(r),w=callsWorker(r);w.start();await until(()=>w.activeCallFinisher);const id=w.getStatus().activeCall.callId,events=r.load('src/events.ts').appEvents;
 events.broadcast({type:'call_end',sessionId:'otra',outcome:'RECHAZADO'});assert.ok(w.getStatus().activeCall);
 events.broadcast({type:'state',sessionId:id,state:'speaking'});assert.equal(w.getStatus().activeCall.state,'conectado');
 events.broadcast({type:'call_end',sessionId:id,outcome:'AUTORIZADO',sessionSummary:{whatsappAuthorized:true,evidenceQuote:'Sí, envíamelo',confirmedPhone:'+34600000000'}});
 await until(()=>!w.getStatus().activeCall);assert.equal(db.getDb().leads[0].estado,'cola_whatsapp');assert.equal(db.getDb().lineas.some(l=>l.en_uso),false);await w.stop();
});
test('Fallo al marcar queda registrado y libera la reserva',async()=>{
 const r=runtime(),db=seed(r),w=callsWorker(r);r.transport.dial=async()=>({success:false,message:'Fallo simulado'});w.start();await until(()=>db.getDb().interacciones.length);assert.equal(db.getDb().leads[0].estado,'cola_llamada');assert.equal(db.getDb().lineas.some(l=>l.en_uso),false);await w.stop();
});
test('Dos instancias conservan cambios independientes en el mismo CRM',()=>{
 const a=runtime();seed(a);const b=runtime(a.cwd),x=a.load('src/crm/crm-storage.ts').crmStorage,y=b.load('src/crm/crm-storage.ts').crmStorage;
 const xa=x.getDb(),yb=y.getDb();xa.leads[0].notas='Cambio A';yb.settings.horario_comercial_inicio='08:00';x.save();y.save();assert.equal(x.getDb().settings.horario_comercial_inicio,'08:00');assert.equal(y.getDb().leads[0].notas,'Cambio A');
});
test('Cambios concurrentes del mismo campo producen conflicto visible',()=>{
 const a=runtime();seed(a);const b=runtime(a.cwd),x=a.load('src/crm/crm-storage.ts').crmStorage,y=b.load('src/crm/crm-storage.ts').crmStorage;
 x.getDb().leads[0].notas='A';y.getDb().leads[0].notas='B';x.save();assert.throws(()=>y.save(),/Conflicto/);assert.equal(x.getDb().leads[0].notas,'A');
});
test('Bloqueo ocupado no escribe ni borra el bloqueo ajeno',()=>{
 const r=runtime(),db=seed(r),file=path.join(r.cwd,'data/crm/crm.json'),before=fs.readFileSync(file,'utf8');fs.writeFileSync(file+'.lock',String(process.pid)+'\n'+Date.now());db.getDb().leads[0].notas='No debe guardarse';assert.throws(()=>db.save(),/bloqueo/);assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(fs.existsSync(file+'.lock'));fs.unlinkSync(file+'.lock');
});
test('Cuatro procesos incrementan el contador sin perder actualizaciones',async()=>{
 const r=runtime(),db=seed(r);const child=path.join(__dirname,'workers-test-counter.cjs');
 await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[child,r.cwd],{env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe']});let err='';p.stderr.on('data',d=>{err+=d});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(err)))})));
 assert.equal(db.getDailyWhatsAppCount(),80);
});
function enqueue(r,id='evt-1',key='authorization-1'){
 const folder=path.join(r.cwd,'data/outbox/whatsapp/pending');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,id+'.json'),JSON.stringify({eventId:id,callId:'call-test',type:'whatsapp_authorized',idempotencyKey:key,payload:{phone:'+34600000000',confirmedPhone:'+34600000000'}}));
}
function consumer(r,options={}){
 const {dispatchWhatsAppProposal}=r.load('src/whatsapp/whatsapp-outbox-dispatcher.ts');const {OutboxConsumer}=r.load('src/outbox/outbox-consumer.ts');
 return new OutboxConsumer({queueName:'whatsapp',canProcess:()=>r.load('src/crm/crm-storage.ts').crmStorage.getDb().settings.whatsapp_worker_config.enabled,handler:e=>dispatchWhatsAppProposal({callId:e.callId,...e.payload}),...options});
}
test('Cola completa envía solo la muestra del negocio y no repite tras reinicio',async()=>{
 const r=runtime(),db=seed(r),c=consumer(r);enqueue(r);assert.equal(await c.processNextBatch(),1);assert.equal(r.calls.messages.length,1);assert.ok(r.calls.messages[0].message.includes('https://example.test/muestra/negocio-1'));assert.ok(!r.calls.messages[0].message.includes('forjaweb.es/muestra'));assert.equal(db.getDailyWhatsAppCount(),1);assert.equal(db.getDb().leads[0].veces_whatsapp,1);
 const restarted=runtime(r.cwd),second=consumer(restarted);enqueue(restarted,'evt-2');await second.processNextBatch();assert.equal(restarted.calls.messages.length,0);
});
test('Desconexión temporal conserva trabajos y aplica espera creciente incluso tras reinicio',async()=>{
 const r=runtime();seed(r);let now=1000;r.transport.connected=false;const c=consumer(r,{now:()=>now});enqueue(r);
 for(let i=0;i<5;i++){await c.processNextBatch();now+=4_000_000}
 const base=path.join(r.cwd,'data/outbox/whatsapp');assert.ok(fs.existsSync(path.join(base,'pending/evt-1.json')));assert.equal(fs.readdirSync(path.join(base,'failed')).length,0);const meta=JSON.parse(fs.readFileSync(path.join(base,'processing/evt-1.json.meta')));assert.equal(meta.retries,0);assert.equal(meta.deferrals,5);
 r.transport.connected=true;await c.processNextBatch();assert.equal(r.calls.messages.length,1);
});
test('La pausa del panel externo detiene el consumidor; reanudar procesa el pendiente',async()=>{
 const panel=runtime();seed(panel);const remote=runtime(panel.cwd);const w=new(panel.load('src/crm/whatsapp-worker.ts').WhatsAppWorker)();w.useExternalService();const c=consumer(remote);enqueue(remote);await w.stop();await c.processNextBatch();assert.equal(remote.calls.messages.length,0);w.start();await c.processNextBatch();assert.equal(remote.calls.messages.length,1);await w.stop();
});
test('Parada durante un envío permite terminar solo el ya iniciado',async()=>{
 const r=runtime(),db=seed(r);let finish;r.transport.send=()=>new Promise(resolve=>{finish=resolve});const c=consumer(r);enqueue(r);enqueue(r,'evt-2','different-key');const task=c.processNextBatch();await until(()=>finish);db.transaction(d=>{d.settings.whatsapp_worker_config.enabled=false});finish({success:true});await task;assert.equal(r.calls.messages.length,1);assert.ok(fs.existsSync(path.join(r.cwd,'data/outbox/whatsapp/pending/evt-2.json')));
});
test('Entrega incierta no se repite ni al reiniciar con otro evento',async()=>{
 const r=runtime();seed(r);r.transport.send=async()=>({success:false,error:'timed out'});enqueue(r);await consumer(r).processNextBatch();assert.equal(r.calls.messages.length,1);assert.ok(fs.existsSync(path.join(r.cwd,'data/outbox/whatsapp/uncertain/evt-1.json')));
 const b=runtime(r.cwd);enqueue(b,'evt-2','new-key');await consumer(b).processNextBatch();assert.equal(b.calls.messages.length,0);
});
test('Sin muestra, sin autorización, teléfono ajeno y cuota cero no se envía',async()=>{
 for(const scenario of ['muestra','consentimiento','telefono','cuota']){
 const r=runtime(),db=seed(r);db.transaction(d=>{if(scenario==='muestra')d.propuestas=[];if(scenario==='consentimiento')d.leads[0].consentimiento_whatsapp=false;if(scenario==='telefono')d.leads[0].telefono_confirmado='+34600000001';if(scenario==='cuota')d.settings.whatsapp_worker_config.maxDailyMessages=0});enqueue(r);await consumer(r).processNextBatch();assert.equal(r.calls.messages.length,0,scenario);assert.ok(fs.existsSync(path.join(r.cwd,'data/outbox/whatsapp/pending/evt-1.json')));}
});
test('El envío espera la muestra pendiente y usa la nueva cuando llega',async()=>{
 const r=runtime(),db=seed(r);let now=0;const sample=structuredClone(db.getDb().propuestas[0]);db.transaction(d=>{d.propuestas=[]});const c=consumer(r,{now:()=>now});enqueue(r);await c.processNextBatch();assert.equal(r.calls.messages.length,0);db.transaction(d=>d.propuestas.push(sample));now=100000;await c.processNextBatch();assert.equal(r.calls.messages.length,1);
});
test('No se envían muestras de otro negocio ni enlaces locales',async()=>{
 const r=runtime(),db=seed(r),prepare=r.load('src/whatsapp/proposal-message.ts').proposalMessage;db.transaction(d=>{d.propuestas[0].lead_id='otro'});assert.throws(()=>prepare(db.getDb(),db.getDb().leads[0]),/preparada/);db.transaction(d=>{d.propuestas[0].lead_id='lead-1';d.propuestas[0].url_publica='https://127.0.0.1/muestra'});assert.throws(()=>prepare(db.getDb(),db.getDb().leads[0]),/pública/);
});
test('API rechaza credenciales ausentes, incorrectas y origen cruzado; acepta la clave',async()=>{
 const r=runtime();seed(r);const route=r.load('src/crm/crm-routes.ts').handleCrmRoutes;
 for(const [headers,expected]of [[{},401],[{authorization:'Bearer invalid'},401],[{authorization:'Bearer '+'test-token-'.repeat(8),origin:'https://evil.test',host:'localhost'},401],[{authorization:'Bearer '+'test-token-'.repeat(8),host:'localhost'},200]]){
 let status,body;await route({method:'GET',headers},{writeHead:c=>status=c,end:b=>body=b},'/api/crm/worker/calls/status',new URL('http://localhost/api/crm/worker/calls/status'));assert.equal(status,expected);if(expected===401)assert.ok(body.includes('CONTROL_AUTH_REQUIRED'));}
});
test('Login crea cookie HttpOnly; cookie manipulada o vencida no autoriza',async()=>{
 const r=runtime(),auth=r.load('src/control-auth.ts');let headers,status;const req={method:'POST',headers:{origin:'http://localhost:3000',host:'localhost:3000'},socket:{},async *[Symbol.asyncIterator](){yield JSON.stringify({token:'test-token-'.repeat(8)})}};
 await auth.handleControlLogin(req,{writeHead:(s,h)=>{status=s;headers=h},end(){}});assert.equal(status,200);assert.match(headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);const cookie=headers['Set-Cookie'].split(';')[0];assert.equal(auth.isControlAuthorized({headers:{cookie}}),true);assert.equal(auth.isControlAuthorized({headers:{cookie:cookie+'x'}}),false);assert.equal(auth.isControlAuthorized({headers:{cookie:'forja_control=1.bad'}}),false);
});

test('El próximo reintento persiste tras reiniciar el consumidor',async()=>{
 const r=runtime();seed(r);let now=0;r.transport.connected=false;enqueue(r);await consumer(r,{now:()=>now}).processNextBatch();
 const b=runtime(r.cwd),c=consumer(b,{now:()=>now});await c.processNextBatch();assert.equal(b.calls.messages.length,0);now=30001;await c.processNextBatch();assert.equal(b.calls.messages.length,1);
});
test('Errores permanentes agotan intentos con espera progresiva y diagnóstico',async()=>{
 const r=runtime();seed(r);let now=0,attempts=0;enqueue(r);const c=consumer(r,{now:()=>now,retryBaseMs:100,handler:async()=>{attempts++;throw Error('Error definitivo simulado')}});
 await c.processNextBatch();await c.processNextBatch();assert.equal(attempts,1);now=101;await c.processNextBatch();now=302;await c.processNextBatch();assert.equal(attempts,3);assert.ok(fs.existsSync(path.join(r.cwd,'data/outbox/whatsapp/failed/evt-1.json.meta')));
});
test('Trabajo interrumpido durante envío se aísla sin repetición',async()=>{
 const r=runtime();seed(r);const c=consumer(r);enqueue(r);const base=path.join(r.cwd,'data/outbox/whatsapp');fs.renameSync(path.join(base,'pending/evt-1.json'),path.join(base,'processing/evt-1.json'));c.start();await wait(10);c.stop();assert.equal(r.calls.messages.length,0);assert.ok(fs.existsSync(path.join(base,'uncertain/evt-1.json')));
});
test('Un segundo consumidor no recupera trabajos de un proceso vivo',async()=>{
 const r=runtime();seed(r);const first=consumer(r),second=consumer(r);first.start();assert.throws(()=>second.start(),/EEXIST/);first.stop();second.start();second.stop();
});
test('Dos remitentes comparten la última plaza de cuota sin excederla',async()=>{
 const a=runtime(),db=seed(a);db.transaction(d=>{d.settings.whatsapp_worker_config.maxDailyMessages=1;d.leads.push({...d.leads[0],id:'lead-2',telefono:'+34600000001',telefono_confirmado:'+34600000001',token_seguimiento:'token-2'});d.propuestas.push({...d.propuestas[0],id:'proposal-2',lead_id:'lead-2',token_seguimiento:'token-2'})});const b=runtime(a.cwd);let finish;a.transport.send=()=>new Promise(r=>{finish=r});
 const one=a.load('src/whatsapp/whatsapp-outbox-dispatcher.ts').dispatchWhatsAppProposal({callId:'call-1',phone:'+34600000000'});await until(()=>finish);
 await assert.rejects(b.load('src/whatsapp/whatsapp-outbox-dispatcher.ts').dispatchWhatsAppProposal({callId:'call-2',phone:'+34600000001'}),/Cuota/);assert.equal(b.calls.messages.length,0);finish({success:true});await one;assert.equal(db.getDailyWhatsAppCount(),1);
});
test('Cambios del CRM durante el envío se conservan al registrar la entrega',async()=>{
 const a=runtime();seed(a);const b=runtime(a.cwd),db=b.load('src/crm/crm-storage.ts').crmStorage;let finish;a.transport.send=()=>new Promise(r=>{finish=r});const task=a.load('src/whatsapp/whatsapp-outbox-dispatcher.ts').dispatchWhatsAppProposal({callId:'call-1',phone:'+34600000000'});await until(()=>finish);db.transaction(d=>{d.leads[0].notas='Actualizado durante envío';d.leads[0].estado='no_contactar'});finish({success:true});await task;assert.equal(db.getDb().leads[0].notas,'Actualizado durante envío');assert.equal(db.getDb().leads[0].estado,'no_contactar');
});
test('Conectar y cerrar WhatsApp desde el panel llegan al proceso externo una sola vez',async()=>{
 const a=runtime(),b=runtime(a.cwd),panel=a.load('src/whatsapp/service-control.ts'),remote=b.load('src/whatsapp/service-control.ts');let connects=0,logouts=0;const service={startConnection:async()=>{connects++;return {status:'connected'}},logout:async()=>{logouts++},sendMessage:async()=>{throw Error('No enviar')}};
 const connect=panel.requestWhatsAppControl({action:'connect'});await remote.processWhatsAppControls(service);assert.equal((await connect).status,'connected');const logout=panel.requestWhatsAppControl({action:'logout'});await remote.processWhatsAppControls(service);assert.equal((await logout).success,true);await remote.processWhatsAppControls(service);assert.equal(connects,1);assert.equal(logouts,1);
});
test('Un bloqueo transitorio de Windows no pierde la actualización ni elimina el original',()=>{
 const r=runtime(),db=seed(r),original=fs.renameSync;let attempts=0;
 fs.renameSync=(from,to)=>{if(to===path.join(r.cwd,'data/crm/crm.json')&&attempts++<2)throw Object.assign(Error('Bloqueo transitorio'),{code:'EPERM'});return original(from,to)};
 try{db.incrementDailyWhatsAppCount();assert.equal(db.getDailyWhatsAppCount(),1);assert.equal(attempts,3)}finally{fs.renameSync=original}
});
test('Servidor completo protege HTTP y WebSocket y sirve el acceso del panel',async()=>{
 let handler,wsHandler,boundHost;
 const fakeServer={on(){},listen(port,host){boundHost=host}};
 class FakeWSS{on(event,fn){if(event==='connection')wsHandler=fn}}
 const r=runtime(undefined,{'src/web-server.ts':null,'@module:http':{createServer:fn=>{handler=fn;return fakeServer}},'@module:net':{},'@module:ws':{WebSocketServer:FakeWSS,WebSocket:{OPEN:1}}});
 fs.mkdirSync(path.join(r.cwd,'public'));fs.copyFileSync(path.join(__dirname,'../public/control-auth.js'),path.join(r.cwd,'public/control-auth.js'));
 r.load('src/web-server.ts').startWebServer();assert.equal(boundHost,'127.0.0.1');
 const request=(url,headers={})=>new Promise(resolve=>{let status;handler({url,method:'GET',headers:{host:'localhost',...headers}},{writeHead:s=>status=s,end:body=>resolve({status,body})})});
 assert.equal((await request('/api/config')).status,401);assert.equal((await request('/api/control/session',{authorization:'Bearer '+'test-token-'.repeat(8)})).status,200);
 const script=await request('/control-auth.js');assert.equal(script.status,200);assert.match(script.body,/api\/control\/login/);
 let closed;wsHandler({close:code=>closed=code},{headers:{host:'localhost'}});assert.equal(closed,1008);
});
