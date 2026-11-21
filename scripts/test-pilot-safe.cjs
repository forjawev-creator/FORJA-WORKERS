const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRuntime } = require('./workers-test-runtime.cjs');
function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-pilot-safe-'));
  const runtime = createRuntime(cwd);
  const { ProbeController, ProbeLedger, defaultProbePolicy } = runtime.load('src/pilot/probe-controller.ts');
  let now = Date.parse('2026-11-21T10:00:00Z');
  const state = { enabled: true, error: false, stopError: false, starts: 0, stops: 0, config: 'v1' };
  const ledger = new ProbeLedger(path.join(cwd, 'data', 'probes.json'), defaultProbePolicy);
  const deps = { enabled: () => state.enabled, canProbe: async () => true, loadConfig: () => { if (state.error) throw Error('config-original-error'); return state.config; }, fingerprint: c => c, now: () => now,
    engine: (cfg, audio) => ({ start: async () => { state.starts++; }, greet: async () => audio(640), stop: async () => { state.stops++; if (state.stopError) throw Error('stop-original-error'); } }) };
  return { cwd, runtime, state, ledger, deps, ProbeController, ProbeLedger, controller: new ProbeController(ledger, deps), advance: ms => { now += ms; } };
}
test('H3: valid voice expires and configuration changes invalidate immediately', async () => {
  const x = setup(); try { await x.controller.run(); assert.equal(x.controller.status().ready, true); x.state.config = 'v2'; assert.equal(x.controller.status().ready, false); x.state.config = 'v1'; x.advance(300001); assert.equal(x.controller.status().ready, false); } finally { x.runtime.dispose(); }
});
test('H6: configuration failure releases busy without spending or hiding original error', async () => {
  const x = setup(); try { x.state.error = true; await assert.rejects(x.controller.run(), /config-original-error/); assert.equal(x.controller.busy, false); assert.equal(x.ledger.read().length, 0); x.state.error = false; await x.controller.run(); assert.equal(x.controller.status().ready, true); } finally { x.runtime.dispose(); }
});
test('H6: cleanup failure releases busy and preserves uncertain budget reservation', async () => {
  const x = setup(); try { x.state.stopError = true; await assert.rejects(x.controller.run(), /stop-original-error/); assert.equal(x.controller.busy, false); assert.equal(x.controller.status().ready, false); assert.equal(x.ledger.read()[0].state, 'reserved'); x.advance(60001); await assert.rejects(x.controller.run(), /incierto/); assert.equal(x.state.starts, 1); } finally { x.runtime.dispose(); }
});
test('H5: separate probe daily quota survives restart; fourth probe never starts provider', async () => {
  const x = setup(); try { for (let i = 0; i < 3; i++) { await x.controller.run(); x.advance(60001); } const restart = new x.ProbeController(new x.ProbeLedger(x.ledger.file), x.deps); await assert.rejects(restart.run(), /agotado/); assert.equal(x.state.starts, 3); assert.equal(x.ledger.read().length, 3); } finally { x.runtime.dispose(); }
});
test('H5: runtime policy, cooldown and overlapping requests fail before provider use', async () => {
  const x = setup(); try { x.state.enabled = false; await assert.rejects(x.controller.run(), /bloqueadas/); assert.equal(x.state.starts, 0); x.state.enabled = true; const first = x.controller.run(); await assert.rejects(x.controller.run(), /en curso/); await first; await assert.rejects(x.controller.run(), /Espera/); assert.equal(x.state.starts, 1); } finally { x.runtime.dispose(); }
});
test('H5: reservation from a crashed process blocks new probes even on next day', async () => {
  const x = setup(); try { x.ledger.reserve(Date.parse('2026-11-20T10:00:00Z')); await assert.rejects(x.controller.run(), /incierto/); assert.equal(x.state.starts, 0); } finally { x.runtime.dispose(); }
});
test('H5: corrupt budget fails closed without overwriting state or using provider', async () => {
  const x = setup(); try { fs.mkdirSync(path.dirname(x.ledger.file), { recursive: true }); fs.writeFileSync(x.ledger.file, '{broken'); await assert.rejects(x.controller.run()); assert.equal(fs.readFileSync(x.ledger.file, 'utf8'), '{broken'); assert.equal(x.controller.busy, false); assert.equal(x.state.starts, 0); } finally { x.runtime.dispose(); }
});
test('Gemini: per-turn usage sums distinct turns, same turn replay is idempotent, modalities use configured rates', () => {
  const x = setup(); try {
    const { GeminiUsageMeter } = x.runtime.load('src/pilot/gemini-usage.ts');
    const rates={version:'synthetic-test',model:'test-model',inputMicroUsdPerMillionTokens:{TEXT:1000000,AUDIO:2000000},outputMicroUsdPerMillionTokens:{TEXT:2000000,AUDIO:4000000}};
    const msg={promptTokenCount:10,responseTokenCount:5,totalTokenCount:15,promptTokensDetails:[{modality:'TEXT',tokenCount:10}],responseTokensDetails:[{modality:'AUDIO',tokenCount:5}]};
    const meter=new GeminiUsageMeter(rates);
    assert.equal(meter.accept(msg,0,true).estimatedMicroUsd,30);
    assert.equal(meter.accept(msg,0,true).estimatedMicroUsd,30);
    assert.equal(meter.accept(msg,1,true).estimatedMicroUsd,60);
    assert.equal(meter.accept(msg,2,false).estimatedMicroUsd,null);
    const final=meter.accept(msg,2,true);assert.equal(final.estimatedMicroUsd,90);assert.equal(final.totalTokens,45);assert.equal(final.actualMicroUsd,null);
  } finally { x.runtime.dispose(); }
});
test('Gemini: missing modality details, rates, ambiguous reports and extra billable categories do not invent costs', () => {
  const x=setup();try{
    const { GeminiUsageMeter }=x.runtime.load('src/pilot/gemini-usage.ts');
    const msg={promptTokenCount:10,responseTokenCount:5,totalTokenCount:15};
    assert.equal(new GeminiUsageMeter().accept(msg,0,true).estimatedMicroUsd,null);
    const rates={version:'synthetic',model:'test',inputMicroUsdPerMillionTokens:{TEXT:1,AUDIO:1},outputMicroUsdPerMillionTokens:{TEXT:1,AUDIO:1}};
    const meter=new GeminiUsageMeter(rates);assert.equal(meter.accept(msg,0,true).estimatedMicroUsd,null);
    assert.equal(meter.accept({...msg,thoughtsTokenCount:5},1,true).estimatedMicroUsd,null);
    assert.equal(meter.accept({totalTokenCount:'bad'}),null);
    const observation=meter.accept({...msg,secret:'must-not-persist'},2,false).observations.at(-1);
    assert.equal(Object.hasOwn(observation.metadata,'secret'),false);
    for(let i=3;i<80;i++)meter.accept(msg,i,false);assert.equal(meter.snapshots.length,64);
  }finally{x.runtime.dispose();}
});

test('Probe failure and excess estimate after first audio never mark readiness', async () => {
  for (const phase of ['greet-error','stop-error','stop-cost']) {
    const x=setup();try {
      x.deps.engine=(_cfg,audio,fail,usage)=>({start:async()=>{},greet:async()=>{audio(640);if(phase==='greet-error')fail(Error('terminal-failure'));},stop:async()=>{if(phase==='stop-error')fail(Error('terminal-failure'));if(phase==='stop-cost')usage({inputTokens:1,outputTokens:1,totalTokens:2,estimatedMicroUsd:100000,tariffVersion:'test'});}});
      await assert.rejects(x.controller.run());assert.equal(x.controller.status().ready,false);assert.equal(x.ledger.read()[0].state,'failed');assert.equal(x.controller.busy,false);
    }finally{x.runtime.dispose();}
  }
});
test('Shutdown keeps watchdog and diagnostics alive on unconfirmed hangup, retries safely',async()=>{
  const x=setup();try{
    const {PilotShutdown}=x.runtime.load('src/pilot/shutdown.ts');let closed=0,begun=0,marked=0,success=false,idle=false;
    const stop=new PilotShutdown({enabled:()=>true,begin:()=>begun++,markUncertain:()=>marked++,hangup:async()=>({success}),idle:async()=>idle,close:()=>closed++});
    assert.equal(await stop.run(),false);assert.equal(stop.stopping,true);assert.equal(closed,0);success=true;assert.equal(await stop.run(),false);idle=true;assert.equal(await stop.run(),true);assert.equal(closed,1);assert.equal(marked,3);
    const safe=new PilotShutdown({enabled:()=>false,begin:()=>{},markUncertain:()=>{throw Error('must not mark')},hangup:async()=>{throw Error('must not call')},idle:async()=>false,close:()=>closed++});assert.equal(await safe.run(),true);
  }finally{x.runtime.dispose();}
});
