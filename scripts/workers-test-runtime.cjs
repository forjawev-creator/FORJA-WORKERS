const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const sourceRoot = path.resolve(__dirname, '..');
const deps = createRequire(path.join(process.env.WORKERS_TEST_DEPS || sourceRoot, 'package.json'));
const ts = deps('typescript');

exports.createRuntime = function(cwd, overrides = {}) {
  const cache = new Map(), timers = new Set();
  const calls = {dial:0,hangup:0,messages:[]};
  const transport = {
    connected:true, dial:async()=>({success:true,message:'Simulado'}), hangup:async()=>({success:true,message:'Simulado'}),
    send:async()=>({success:true,messageId:'fake-message'}),
  };
  const fakeBaileys = {
    getStatus:()=>({status:transport.connected?'connected':'connecting',updatedAt:new Date().toISOString()}),
    startConnection:async()=>({status:'connected'}),
    sendMessage:async(phone,message)=>{calls.messages.push({phone,message});return transport.send(phone,message)},
  };
  const stub = {
    'src/bridge-manager.ts':{
      dialNetelip:async(...args)=>{calls.dial++;return transport.dial(...args)},
      hangupNetelip:async()=>{calls.hangup++;return transport.hangup()},
    },
    'src/whatsapp/baileys-service.ts':{baileysWhatsAppService:fakeBaileys},
    'src/pipeline.ts':{isExplicitWhatsAppAuthorization:()=>true},
    'src/web-server.ts':{getPublicBaseUrl:()=> 'https://example.test',getLocalIpAddress:()=> '127.0.0.1'},
    'src/crm/hook-generator.ts':{},
    ...overrides,
  };
  for (const [key,value] of Object.entries(stub)) if(value === null) delete stub[key];
  const safePath = value => {
    if(typeof value !== 'string' && !Buffer.isBuffer(value)) return;
    const resolved=path.resolve(String(value));
    if(resolved!==cwd && !resolved.startsWith(cwd+path.sep)) throw Error('Acceso fuera del directorio de pruebas: '+resolved);
  };
  const writing=['writeFileSync','appendFileSync','mkdirSync','unlinkSync','renameSync','copyFileSync','rmSync','rmdirSync','openSync'];
  const safeFs = new Proxy(fs,{get(target,key){
    if(writing.includes(key))return (...args)=>{safePath(args[0]);if(['renameSync','copyFileSync'].includes(key))safePath(args[1]);return target[key](...args)};
    if(['readFileSync','readdirSync','existsSync','statSync'].includes(key))return (...args)=>{safePath(args[0]);return target[key](...args)};
    return target[key];
  }});
  function load(relative) {
    relative=relative.replaceAll('\\','/');
    if(Object.hasOwn(stub,relative)) return stub[relative];
    if(cache.has(relative))return cache.get(relative).exports;
    const filename=path.join(sourceRoot,relative);
    const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const mod={exports:{}}; cache.set(relative,mod);
    const requireSafe=name=>{
      if(Object.hasOwn(stub,'@module:'+name))return stub['@module:'+name];
      if(name.startsWith('.')){
        const p=path.relative(sourceRoot,path.resolve(path.dirname(filename),name)).replaceAll('\\','/').replace(/\.js$/,'.ts');
        return load(p);
      }
      if(name==='fs'||name==='node:fs')return safeFs;
      if(name==='child_process'||name==='node:child_process')return {execSync(){throw Error('Procesos externos prohibidos')},spawn(){throw Error('Procesos externos prohibidos')}};
      if(['path','crypto','events','os','util','url','node:path','node:crypto','node:events'].includes(name))return require(name);
      if(name==='http')return {}; // Type-only dependency in the route handlers; no sockets.
      if(name==='dotenv/config')return {};
      throw Error('Dependencia o red no autorizada: '+name);
    };
    const context={module:mod,exports:mod.exports,require:requireSafe,console:{log(){},warn(){},error(){}},Buffer,URL,Date,JSON,Promise,Map,Set,structuredClone,Atomics,SharedArrayBuffer,Int32Array,
      process:{cwd:()=>cwd,pid:process.pid,platform:process.platform,env:{WORKER_CONTROL_TOKEN:'test-token-'.repeat(8)},kill:(pid,signal)=>{if(signal!==0)throw Error('Señal prohibida');return process.kill(pid,0)}},
      setTimeout:(f,ms)=>{const t=setTimeout(f,ms);timers.add(t);return t},clearTimeout:t=>{timers.delete(t);clearTimeout(t)},
      setInterval:(f,ms)=>{const t=setInterval(f,ms);timers.add(t);return t},clearInterval:t=>{timers.delete(t);clearInterval(t)},
      setImmediate,clearImmediate,fetch(){throw Error('Red real prohibida en las pruebas')},
    };
    vm.runInNewContext(code,context,{filename});
    return mod.exports;
  }
  return {load,calls,transport,dispose(){for(const t of timers){clearTimeout(t);clearInterval(t)}timers.clear()}};
};
