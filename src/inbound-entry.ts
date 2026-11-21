import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {TelephoneBackend} from './inbound/backend-client.js';
import {InboundJournal} from './inbound/journal.js';
import {createInboundServer} from './inbound/server.js';
import {GeminiSecretaryEngine} from './inbound/secretary-engine.js';
import {runtimePolicy} from './runtime-policy.js';
import {loadConfig} from './storage.js';
import {startBridge} from './bridge-manager.js';

export async function startInboundSecretary() {
  if(process.env.CALLS_PILOT==='1')throw new Error('inbound_and_pilot_are_exclusive');
  const enabled=()=>process.env.TELEPHONY_MODE==='inbound_secretaria'&&process.env.INBOUND_ENABLED==='true'&&runtimePolicy().realCallsEnabled;
  const config=loadConfig();
  const rates=JSON.parse(fs.readFileSync(path.resolve('data','gemini-probe-rates.json'),'utf8'));
  const backend=new TelephoneBackend({centralOrigin:process.env.INBOUND_CENTRAL_ORIGIN??'',
    allowedOrigins:(process.env.INBOUND_BACKEND_ORIGINS??'').split(',').filter(Boolean),
    source:process.env.INBOUND_SOURCE??'',sourceSecret:process.env.INBOUND_SOURCE_SECRET??''});
  const app=createInboundServer({backend,journal:new InboundJournal(path.resolve('data','inbound-journal.json')),enabled,
    controlToken:process.env.INBOUND_CONTROL_TOKEN??'',engine:()=>new GeminiSecretaryEngine({
      ...config,apiKey:'',persona:'secretaria',sampleRate:16000,audioCodec:'pcma',conversationEngine:'gemini_live',
      geminiApiKey:process.env.GEMINI_API_KEY||config.geminiApiKey,handoffEnabled:false,callMaxDurationSeconds:120,
    },rates)});
  await app.listen();
  // No automatic restart: an unknown previous dialog retains the global slot.
  if(enabled()&&!app.controller.status().busy){const result=startBridge();if(!result.success)throw new Error('bridge_start_failed');}
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close();});
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  startInboundSecretary().catch(()=>{console.error('Secretaría no iniciada: configuración o dependencias no verificadas');process.exitCode=1;});
}
