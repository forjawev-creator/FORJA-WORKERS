import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeSupervisor, type BridgeObservation } from '../src/bridge-supervisor.js';
const dead: BridgeObservation = { processRunning: false, reachable: false, registered: false, callActive: null };
const idle: BridgeObservation = { processRunning: true, reachable: true, registered: true, callActive: false };
test('dial invalidates stale idle and recovery waits for a fresh confirmed idle', async()=>{
  const s=new BridgeSupervisor(); let starts=0;
  const start=()=>{starts++;return {success:true}};
  s.observe(idle); s.beginCommand(); s.observe(idle);
  await s.recover(dead,true,0,start);
  s.endCommand(); await s.recover(dead,true,10000,start);
  assert.equal(starts,0);
  s.observe(idle); await s.recover(dead,true,20000,start);
  assert.equal(starts,1);
});
test('unknown or active line never triggers recovery', async () => {
  const s = new BridgeSupervisor(); let starts=0;
  const start=()=>{starts++;return {success:true}};
  await s.recover(dead,true,0,start);
  s.observe({...idle,callActive:true});
  await s.recover(dead,true,100000,start);
  assert.equal(starts,0); assert.equal(s.observe(dead).uncertain,true);
});
test('recovery is bounded and respects backoff and policy', async()=>{
  const s=new BridgeSupervisor(); let starts=0;
  const start=()=>{starts++;return {success:true}};
  s.observe(idle);
  await s.recover(dead,false,0,start); assert.equal(starts,0);
  await s.recover(dead,true,0,start); assert.equal(starts,1);
  await s.recover(dead,true,1,start); assert.equal(starts,1);
  await s.recover(dead,true,10000,start);
  await s.recover(dead,true,30000,start);
  await s.recover(dead,true,100000,start);
  assert.equal(starts,3); assert.equal(s.observe(dead).recoveryExhausted,true);
});
test('manual stop prevents automatic restart; unavailable SIP does not kill running bridge', async()=>{
  const s=new BridgeSupervisor(); let starts=0;
  const start=()=>{starts++;return {success:true}};
  s.observe(idle);
  await s.recover({...idle,registered:false},true,0,start);
  s.stop(); await s.recover(dead,true,10000,start);
  assert.equal(starts,0);
});

test('overlapping telephone commands remain uncertain until every command ends and fresh idle arrives', async()=>{
  const s=new BridgeSupervisor(); let starts=0;
  const start=()=>{starts++;return {success:true}};
  s.observe(idle);
  const initial=s.revision;
  s.beginCommand();s.beginCommand();
  assert.equal(s.revision,initial+2);
  s.endCommand();s.observe(idle);
  await s.recover(dead,true,100000,start);
  assert.equal(starts,0);
  s.endCommand();
  assert.equal(s.revision,initial+4);
  await s.recover(dead,true,200000,start);
  assert.equal(starts,0);
  s.observe(idle);
  await s.recover(dead,true,300000,start);
  assert.equal(starts,1);
});

test('newly confirmed active call after a command continues blocking recovery', async()=>{
  const s=new BridgeSupervisor();let starts=0;
  s.observe(idle);s.beginCommand();s.endCommand();
  s.observe({...idle,callActive:true});
  await s.recover(dead,true,100000,()=>{starts++;return {success:true}});
  assert.equal(starts,0);
  assert.equal(s.observe(dead).uncertain,true);
});
