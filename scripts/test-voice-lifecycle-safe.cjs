const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRuntime}=require('./workers-test-runtime.cjs');
const runtimes=[];
afterEach(()=>runtimes.splice(0).forEach(r=>r.dispose()));
const drain=()=>new Promise(r=>setTimeout(r,15));
function setup({enabled=true,saveFail=false,stopFail=false,configFail=false}={}){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forja-voice-lifecycle-'));let accept;
 const records=[],engines=[],events=[];
 const state={saveFail,stopFail,configFail};
 class Engine{
  constructor(c,e){this.events=e;engines.push(this)}
  async start(){} async requestInitialGreeting(){} async stop(){if(state.stopFail)throw Error('stop simulated')}
  getCallSessionSummary(){return {outcomeStatus:'TERMINADO',whatsappAuthorized:false,phoneConfirmed:false,transcripts:[]}}
 }
 const r=createRuntime(cwd,{
  '@module:net':{createServer:cb=>{accept=cb;return {listen(){},close(){}}}},
  'src/runtime-policy.ts':{runtimePolicy:()=>({realCallsEnabled:enabled})},
  'src/storage.ts':{loadConfig:()=>{if(state.configFail)throw Error('config simulated');return {conversationEngine:'gemini_live'}}},
  'src/engines/gemini-live-engine.ts':{GeminiLiveEngine:Engine},
  'src/engines/openai-realtime-engine.ts':{OpenAIRealtimeEngine:Engine},
  'src/engines/together-engine.ts':{TogetherEngine:Engine},
  'src/outbox/outbox-producer.ts':{outboxProducer:{emitCallCompleted:p=>{if(state.saveFail)throw Error('disk simulated');records.push(p)}}}
 });runtimes.push(r);
 const bus=r.load('src/events.ts').appEvents;bus.on('ui-event',e=>events.push(e));
 r.load('src/voice-server.ts').startVoiceBridge();
 const socket=new EventEmitter();socket.destroyed=false;socket.setNoDelay=()=>{};socket.write=()=>{};socket.destroy=()=>{socket.destroyed=true;socket.emit('close')};accept(socket);
 const audio=r.load('src/audio-bridge.ts');
 const packet=(type,data)=>socket.emit('data',audio.encodePacket(type,0,Buffer.from(JSON.stringify(data))));
 return {state,records,engines,events,bus,socket,packet};
}
test('safe policy rejects audio connection before opening an engine',async()=>{const h=setup({enabled:false});assert.equal(h.socket.destroyed,true);assert.equal(h.engines.length,0)});
test('terminal duplicates and socket closure persist and emit only once',async()=>{
 const h=setup();h.packet(4,{sessionId:'call_1',phone:'34900000000'});await drain();h.engines[0].events.onHangupRequested('done','TERMINADO');h.packet(5,{sessionId:'call_1',reason:'hangup'});h.packet(5,{sessionId:'call_1',reason:'hangup'});await drain();h.socket.destroy();await drain();assert.equal(h.records.length,1);assert.equal(h.events.filter(e=>e.type==='call_end').length,1);
});
test('foreign terminal does not end current call; duplicate start does not change identity',async()=>{
 const h=setup();h.packet(4,{sessionId:'call_1'});h.packet(4,{sessionId:'other'});h.packet(5,{sessionId:'other'});await drain();assert.equal(h.records.length,0);assert.equal(h.engines.length,1);h.packet(5,{sessionId:'call_1'});await drain();assert.equal(h.records[0].sessionId,'call_1');
});
test('unanswered outbound terminal retains call identity and contact',async()=>{
 const h=setup();h.bus.broadcast({type:'lead_call_start',callId:'out_1',lead:{telefono:'34900000000',empresa_nombre:'Synthetic'}});h.packet(5,{sessionId:'out_1',reason:'no_answer'});await drain();assert.equal(h.engines.length,0);assert.equal(h.records.length,1);assert.equal(h.records[0].sessionId,'out_1');assert.equal(h.records[0].company,'Synthetic');
});
test('persistence failure is visible and never emits successful completion; retry writes once',async()=>{
 const h=setup({saveFail:true});h.packet(4,{sessionId:'call_1'});h.packet(5,{sessionId:'call_1'});await drain();assert.equal(h.events.filter(e=>e.type==='call_end').length,0);assert.ok(h.events.some(e=>e.type==='provider_error'&&e.error.includes('guardar')));h.packet(4,{sessionId:'call_2'});await drain();assert.equal(h.engines.length,1);h.state.saveFail=false;h.packet(5,{sessionId:'call_1'});await drain();assert.equal(h.records.length,1);
});
test('engine stop failures are observed on terminal and socket close',async()=>{
 const h=setup({stopFail:true});h.packet(4,{sessionId:'call_1'});h.packet(5,{sessionId:'call_1'});await drain();h.socket.destroy();await drain();assert.equal(h.records.length,1);assert.ok(h.events.some(e=>e.type==='provider_error'&&e.error.includes('cerrar')));
});
test('configuration failure does not escape the data listener and records failure',async()=>{
 const h=setup({configFail:true});h.packet(4,{sessionId:'call_1'});await drain();assert.equal(h.engines.length,0);assert.equal(h.records.length,1);assert.ok(h.events.some(e=>e.type==='provider_error'));
});
test('unsafe session identifier cannot reach engine or outbox',async()=>{
 const h=setup();h.packet(4,{sessionId:'../../outside'});await drain();assert.equal(h.engines.length,0);assert.equal(h.records.length,0);assert.ok(h.events.some(e=>e.type==='provider_error'));
});

test('outbox stores structured result without transcript by default or invalid policy',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forja-voice-retention-')),r=createRuntime(cwd);runtimes.push(r);
 const producer=r.load('src/outbox/outbox-producer.ts').outboxProducer;
 const payload={sessionId:'retention_1',durationSeconds:1,status:'TERMINADO',transcript:[{role:'user',text:'Synthetic private text'}]};
 producer.emitCallCompleted(payload);
 assert.equal(fs.existsSync(path.join(cwd,'data/transcripts/retention_1.json')),false);
 fs.writeFileSync(path.join(cwd,'data/transcript-policy.json'),JSON.stringify({enabled:true,retentionDays:7}));
 producer.emitCallCompleted({...payload,sessionId:'retention_2'});
 assert.equal(fs.existsSync(path.join(cwd,'data/transcripts/retention_2.json')),false);
 for(const file of fs.readdirSync(path.join(cwd,'data/outbox/crm/pending')))assert.ok(!fs.readFileSync(path.join(cwd,'data/outbox/crm/pending',file),'utf8').includes('Synthetic private text'));
});
test('explicit authorized retention stores transcript atomically with an expiry',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forja-voice-retention-')),r=createRuntime(cwd);runtimes.push(r);
 const producer=r.load('src/outbox/outbox-producer.ts').outboxProducer;
 fs.writeFileSync(path.join(cwd,'data/transcript-policy.json'),JSON.stringify({enabled:true,retentionDays:7,authorizedAt:'2026-01-01T00:00:00Z',authorizedBy:'test-owner'}));
 producer.emitCallCompleted({sessionId:'retention_allowed',durationSeconds:1,status:'TERMINADO',transcriptAuthorized:true,transcript:[{role:'user',text:'Synthetic private text'}]});
 const file=path.join(cwd,'data/transcripts/retention_allowed.json'),data=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(data.policyVersion,1);assert.equal(data.transcript.length,1);assert.ok(Date.parse(data.expiresAt)>Date.now());assert.equal(fs.existsSync(file+'.tmp'),false);
 assert.throws(()=>producer.emitCallCompleted({sessionId:'../../unsafe',durationSeconds:1,status:'TERMINADO'}),/Identificador/);
});

test('retention removes only expired policy-tagged transcripts, preserving legacy files',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forja-voice-retention-')),r=createRuntime(cwd);runtimes.push(r);
 const producer=r.load('src/outbox/outbox-producer.ts').outboxProducer;
 fs.writeFileSync(path.join(cwd,'data/transcript-policy.json'),JSON.stringify({enabled:true,retentionDays:7,authorizedAt:'2026-01-01T00:00:00Z',authorizedBy:'test-owner'}));
 const directory=path.join(cwd,'data/transcripts');
 fs.writeFileSync(path.join(directory,'old_new.json'),JSON.stringify({policyVersion:1,callId:'old_new',expiresAt:'2020-01-01T00:00:00Z'}));
 fs.writeFileSync(path.join(directory,'legacy.json'),JSON.stringify({callId:'legacy',timestamp:'2020-01-01T00:00:00Z'}));
 fs.unlinkSync(path.join(cwd,'data/transcript-policy.json'));
 assert.equal(producer.pruneExpiredTranscripts(),1);assert.equal(fs.existsSync(path.join(directory,'legacy.json')),true);
});
