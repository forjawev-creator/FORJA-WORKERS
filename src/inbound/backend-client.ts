export interface AdmittedSession {
  llamadaId: string; instalacionId: string; maxSegundos: number; expiraEn: string;
  secretaria: string; nombreEmpresa: string; herramientas: string[]; configuracion: Record<string, string>;
}
export interface Destination { instalacionId: string; origenBackend: string; destino: string; revision: number }
export const externalTools = ['registrar_solicitud','registrar_mensaje','consultar_disponibilidad','reservar_cita'] as const;
export class BackendFailure extends Error {
  constructor(readonly code: string, readonly uncertain: boolean) { super(code); }
}
export interface BackendOptions {
  centralOrigin: string; allowedOrigins: string[]; source: string; sourceSecret: string;
  timeoutMs?: number; fetch?: typeof fetch;
  /** Only injectable test transports may use loopback HTTP; never enabled by an environment variable. */
  testTransport?: boolean;
}
export class TelephoneBackend {
  constructor(private readonly options: BackendOptions) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.source) || !/^[A-Za-z0-9_-]{32,256}$/.test(options.sourceSecret)) throw new Error('invalid_source');
    this.origin(options.centralOrigin);
    for (const origin of options.allowedOrigins) this.origin(origin);
  }
  private origin(value: string): string {
    const u = new URL(value);
    const test = this.options.testTransport === true && this.options.fetch !== undefined && u.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(u.hostname);
    if ((!test && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || u.pathname !== '/' || u.origin !== value) throw new Error('invalid_backend_origin');
    return u.origin;
  }
  async post(origin: string, route: string, token: string, body: unknown, signal?: AbortSignal): Promise<any> {
    this.origin(origin);
    if (origin !== this.options.centralOrigin && !this.options.allowedOrigins.includes(origin)) throw new BackendFailure('unapproved_backend_origin', false);
    const data = JSON.stringify(body);
    if (Buffer.byteLength(data) > 16384) throw new BackendFailure('body_too_large', false);
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 4000);
    try {
      const res = await (this.options.fetch ?? fetch)(origin + route, {
        method:'POST', redirect:'error', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
        body:data, signal: signal ? AbortSignal.any([signal,deadline]) : deadline,
      });
      if (!res.ok) throw new BackendFailure('backend_http_' + res.status, res.status >= 500 || res.status === 408);
      if (!res.headers.get('content-type')?.startsWith('application/json') || !res.body) throw new BackendFailure('invalid_backend_response', true);
      const reader=res.body.getReader(); const chunks:Uint8Array[]=[]; let bytes=0;
      try { for (;;) { const chunk=await reader.read(); if (chunk.done) break; bytes+=chunk.value.length;
        if(bytes>65536) throw new BackendFailure('backend_response_too_large',true); chunks.push(chunk.value); }
      } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch(e) { if(e instanceof BackendFailure) throw e; throw new BackendFailure('backend_unconfirmed',true); }
  }
  async resolve(destination:string, signal?:AbortSignal):Promise<Destination> {
    if(!/^\+[1-9]\d{7,14}$/.test(destination)) throw new BackendFailure('invalid_destination',false);
    const v=await this.post(this.options.centralOrigin,'/api/interna/v1/telefonia/resolver',this.options.sourceSecret,{fuente:this.options.source,destino:destination},signal);
    if(!v || v.destino!==destination || !uuid(v.instalacionId) || !this.options.allowedOrigins.includes(v.origenBackend) || !Number.isInteger(v.revision)) throw new BackendFailure('invalid_destination_response',true);
    this.origin(v.origenBackend); return v;
  }
  admissionBody(destination:string,event:string,capability:string) { return {fuente:this.options.source,destino:destination,evento:event,capacidad:capability}; }
  async admit(origin:string, body:unknown, signal?:AbortSignal, reconciliation=false):Promise<AdmittedSession> {
    const v=await this.post(origin,'/api/telefonia/sesiones',this.options.sourceSecret,body,signal);
    if(!v || !uuid(v.llamadaId) || !uuid(v.instalacionId) || !Number.isInteger(v.maxSegundos) || v.maxSegundos<1 || v.maxSegundos>120 || !Number.isFinite(Date.parse(v.expiraEn)) || (!reconciliation && Date.parse(v.expiraEn)<=Date.now()) || typeof v.secretaria!=='string' || typeof v.nombreEmpresa!=='string' || !v.nombreEmpresa.trim() || !Array.isArray(v.herramientas) || v.herramientas.some((t:unknown)=>typeof t!=='string'||!externalTools.includes(t as any)) || !v.configuracion || typeof v.configuracion!=='object' || Array.isArray(v.configuracion) || Object.values(v.configuracion).some(x=>typeof x!=='string')) throw new BackendFailure('invalid_admission_response',true);
    return v;
  }
  async operate(origin:string, capability:string, body:unknown, signal?:AbortSignal) { const value=await this.post(origin,'/api/telefonia/operaciones',capability,body,signal);if(!value||value.confirmado!==true)throw new BackendFailure('operation_unconfirmed',true);return value; }
}
function uuid(value:unknown):boolean { return typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value); }
