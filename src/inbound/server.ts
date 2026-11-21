import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { InboundController, type InboundOptions } from './controller.js';
import { PacketFramer,encodePacket,encodeAudioPackets,PACKET_AUDIO,PACKET_CALL_START,PACKET_CALL_END,PACKET_FLUSH,PACKET_TURN_END,PACKET_PLAYBACK_STARTED,PACKET_PLAYBACK_DRAINED } from '../audio-bridge.js';
const AUTH_PACKET=8;
export interface InboundServerOptions extends Omit<InboundOptions,'output'|'hangup'> {controlToken:string;controlPort?:number;audioPort?:number;}
/** Dedicated inbound listener. Does not share the commercial voice server or its outbox. */
export function createInboundServer(options:InboundServerOptions) {
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(options.controlToken))throw new Error('invalid_inbound_control_token');
  let audio:net.Socket|undefined; let closing=false;
  const send=(type:number,turn=0,body?:Buffer)=>{if(audio&&!audio.destroyed)audio.write(encodePacket(type,turn,body));};
  const controller=new InboundController({...options,
    enabled:()=>!closing&&Boolean(audio)&&options.enabled(),
    output:{audio:(raw,turn)=>{for(const p of encodeAudioPackets(turn,raw))audio?.write(p);},turnEnd:turn=>send(PACKET_TURN_END,turn),flush:turn=>send(PACKET_FLUSH,turn)},
    hangup:(id,reason)=>send(PACKET_CALL_END,0,Buffer.from(JSON.stringify({sessionId:id,reason}))),
  });
  const equal=(value:string)=>{const a=Buffer.from(value),b=Buffer.from(options.controlToken);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
  const tcp=net.createServer(socket=>{
    const framer=new PacketFramer();let authenticated=false;let chain=Promise.resolve();
    const deadline=setTimeout(()=>{if(!authenticated)socket.destroy();},2000);deadline.unref();socket.setNoDelay(true);
    socket.on('data',chunk=>{
      try {
      if(chunk.length>131072){socket.destroy();return;}
      for(const packet of framer.push(chunk)){
        if(!authenticated){if(packet.type!==AUTH_PACKET||!equal(packet.payload.toString('utf8'))||audio||!options.enabled()){socket.destroy();return;}authenticated=true;audio=socket;clearTimeout(deadline);continue;}
        if(packet.type===PACKET_AUDIO){controller.audio(packet.payload);continue;}
        if(packet.type===PACKET_PLAYBACK_STARTED||packet.type===PACKET_PLAYBACK_DRAINED){controller.played(packet.turnId,packet.type===PACKET_PLAYBACK_DRAINED);continue;}
        if(packet.type!==PACKET_CALL_START&&packet.type!==PACKET_CALL_END)continue;
        let meta:any;try{meta=JSON.parse(packet.payload.toString('utf8'));}catch{socket.destroy();return;}
        if(!meta||!/^[a-f0-9]{64}$/.test(meta.sessionId)){socket.destroy();return;}
        chain=chain.then(async()=>{if(packet.type===PACKET_CALL_START)await controller.connected(meta.sessionId);else await controller.terminal(meta.sessionId,meta.reason==='hangup'?'finalizada':'interrumpida');}).catch(()=>{controller.background(controller.uncertain(meta.sessionId));});
      }
      }catch{controller.markFault();socket.destroy();}
    });
    socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(deadline);if(audio===socket){audio=undefined;try{for(const r of controller.status().states)if(r.state!=='terminal')controller.background(controller.uncertain(r.id));}catch{controller.markFault();}}});
  });
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    if(!equal((req.headers.authorization??'').replace(/^Bearer /,''))){res.writeHead(401);res.end('{"error":"unauthorized"}');return;}
    try{
      if(req.method==='GET'&&req.url==='/status'){res.end(JSON.stringify(controller.status()));return;}
      if(req.method!=='POST'||!['/prepare','/terminal','/reconcile'].includes(req.url??'')||req.headers['content-type']!=='application/json')throw new Error('invalid_request');
      let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>4096)throw new Error('body_too_large');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!body||!/^[a-f0-9]{64}$/.test(body.dialogKey))throw new Error('invalid_dialog');
      if(req.url==='/prepare')res.end(JSON.stringify(await controller.prepare(body.dialogKey,body.destino)));
      else if(req.url==='/terminal'){if(!['finalizada','interrumpida'].includes(body.estado))throw new Error('invalid_terminal');await controller.terminal(body.dialogKey,body.estado);if(controller.status().states.some(r=>r.id===body.dialogKey&&r.state!=='terminal'))throw new Error('terminal_unconfirmed');res.end('{"confirmed":true}');}
      else {await controller.reconcile(body.dialogKey);res.end('{"confirmed":true}');}
    }catch{res.writeHead(409);res.end('{"error":"operation_unconfirmed"}');}
  });
  server.requestTimeout=15000;server.headersTimeout=5000;
  return {controller,server,tcp,listen:async()=>{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.controlPort??8087,'127.0.0.1',resolve);});
    await new Promise<void>((resolve,reject)=>{tcp.once('error',reject);tcp.listen(options.audioPort??8080,'127.0.0.1',resolve);});
  },close:async()=>{closing=true;try{for(const r of controller.status().states)if(r.state!=='terminal')await controller.uncertain(r.id);}catch{controller.markFault();}finally{audio?.destroy();}await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>tcp.close(()=>r()))]);}};
}
