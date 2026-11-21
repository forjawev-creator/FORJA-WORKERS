const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRuntime}=require('./workers-test-runtime.cjs');
function setup(){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forja-consent-'));let writes=0,fail=false;
 const overrides={'@module:ws':{},'@module:net':{},'src/context-store.ts':{},'src/playback-tracker.ts':{},'src/events.ts':{},'src/voice/voice-tools.ts':{},'src/voice/audio-codecs.ts':{},'src/telemetry/voice-telemetry.ts':{},'src/prompts-loader.ts':{},'src/audio-bridge.ts':{},'src/outbox/outbox-producer.ts':{outboxProducer:{emitWhatsAppAuthorized(){if(fail)throw Error('storage unavailable');writes++},emitPhoneConfirmed(){}}}};
 const runtime=createRuntime(cwd,overrides);const {GeminiLiveEngine}=runtime.load('src/engines/gemini-live-engine.ts');
 const e=Object.create(GeminiLiveEngine.prototype);const responses=[];e.contextStore={getState:()=>({confirmed_phone:'612345678',business:{name:'Synthetic'}}),setOutcome(){},setWhatsAppAuthorized(){},setStage(){}};e.ws={send:s=>responses.push(JSON.parse(s))};e.startFarewell=()=>{e.farewell=true};e.transcriptTurns=[{role:'assistant',text:'Quieres que te envie la muestra por WhatsApp?'},{role:'user',text:'Si, enviamela'}];e.userTranscripts=[{text:'Si, enviamela'}];
 return {runtime,e,responses,writes:()=>writes,setFail:()=>fail=true,call:()=>e.handleFunctionCall({id:'op-test',name:'record_whatsapp_consent',args:{consent_given:true,client_evidence_quote:'Si, enviamela',phone:'612345678'}})};
}
test('Gemini verifies spoken evidence, rejects invented and conditional permission',async()=>{
 const x=setup();try{const {hasRecordedConsent}=x.runtime.load('src/voice/recorded-consent.ts');assert.equal(hasRecordedConsent('si',[]),false);assert.equal(hasRecordedConsent('Si, enviamela',x.e.transcriptTurns),true);assert.equal(hasRecordedConsent('si pero primero dime el precio',[{role:'assistant',text:'WhatsApp'},{role:'user',text:'si pero primero dime el precio'}]),false);x.e.transcriptTurns=[{role:'user',text:'Buenos dias'}];await x.call();assert.equal(x.responses[0].toolResponse.functionResponses[0].response.output.status,'unverified_consent');assert.equal(x.writes(),0);}finally{x.runtime.dispose()}
});
test('Gemini persists verified consent and reports storage failure honestly',async()=>{
 for(const fail of [false,true]){const x=setup();try{if(fail)x.setFail();await x.call();const out=x.responses[0].toolResponse.functionResponses[0].response.output;assert.equal(out.authorized,!fail);assert.equal(out.status,fail?'persistence_failed':'ok');assert.equal(x.writes(),fail?0:1);assert.equal(!!x.e.farewell,!fail);}finally{x.runtime.dispose()}}
});

test('Gemini rejects older approval when latest spoken turn is no or no gracias',async()=>{
 for(const refusal of ['no','No, gracias.']){const x=setup();try{x.e.transcriptTurns.push({role:'user',text:refusal});x.e.userTranscripts.push({text:refusal});await x.call();assert.equal(x.responses[0].toolResponse.functionResponses[0].response.output.status,'unverified_consent');assert.equal(x.writes(),0);assert.equal(!!x.e.farewell,false);}finally{x.runtime.dispose()}}
});
