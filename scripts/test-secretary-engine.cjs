const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRuntime } = require('./workers-test-runtime.cjs');

function fixture(realAudio = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-secretary-'));
  const policy = { realCallsEnabled: false };
  const sockets = [];
  class Socket extends EventEmitter {
    static OPEN = 1; static CLOSED = 3;
    readyState = 1; sent = [];
    constructor() { super(); sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); }
    terminate() { this.close(); }
  }
  const runtime = createRuntime(cwd, {
    '@module:ws': Socket, '@module:net': {},
    'src/runtime-policy.ts': { runtimePolicy: () => policy },
    'src/context-store.ts': { ContextStore: class { getState() { return { business: { name: 'Empresa sintética' } }; } } },
    'src/playback-tracker.ts': { PlaybackTracker: class {} },
    'src/events.ts': {},
    'src/voice/voice-tools.ts': { buildGeminiTools() { throw Error('Commercial tools forbidden'); } },
    'src/voice/audio-codecs.ts': realAudio ? null : { GeminiAudioToPcmaConverter: class { reset() {} } },
    'src/telemetry/voice-telemetry.ts': { voiceTelemetry: { startCall() {}, finalizeCall() {}, recordTtfb() {}, recordInterruption() {} } },
    'src/prompts-loader.ts': { getCatalogPrices() { throw Error('Commercial prompt forbidden'); } },
    'src/audio-bridge.ts': { StreamingResampler: class { reset() {} } },
    'src/outbox/outbox-producer.ts': { outboxProducer: { emitWhatsAppAuthorized() { throw Error('WhatsApp forbidden'); } } },
  });
  const session = {
    llamadaId: '11111111-1111-4111-8111-111111111111', instalacionId: '22222222-2222-4222-8222-222222222222',
    maxSegundos: 120, expiraEn: new Date(Date.now() + 120000).toISOString(), secretaria: 'Maricarmen',
    nombreEmpresa: 'Empresa sintética A', herramientas: ['registrar_solicitud'], configuracion: { servicios: 'Reparaciones' },
  };
  const calls = [], failures = [], responses = [];
  const hooks = { audio() {}, turnEnd() {}, flush() {}, fail: code => failures.push(code), tool: async (...args) => { calls.push(args); return { ok: true, solicitudId: 'solicitud-sintetica' }; } };
  return { cwd, runtime, policy, sockets, session, hooks, calls, failures, responses,
    dispose() { runtime.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); } };
}

test('verified company and virtual greeting, limited external tools and no caller authentication', async () => {
  const f = fixture();
  try {
    const { buildSecretaryProfile } = f.runtime.load('src/inbound/secretary-engine.ts');
    const profile = buildSecretaryProfile(f.session, f.hooks);
    assert.match(profile.greeting, /asistente virtual de Empresa sintética A/);
    assert.equal(JSON.stringify(profile.tools.map(t => t.name)), JSON.stringify(['registrar_solicitud', 'despedirse']));
    assert.match(profile.prompt, /Nunca es el propietario autenticado/);
    await assert.rejects(profile.execute('id', 'record_whatsapp_consent', {}), /no autorizada/);
    await assert.rejects(profile.execute('id', 'reservar_cita', {}), /no autorizada/);
    await assert.rejects(profile.execute('id', 'registrar_solicitud', { texto: 'x'.repeat(17000) }), /inválidos/);
    assert.equal(f.calls.length, 0);
    await profile.execute('id', 'registrar_solicitud', { nombre: 'Cliente sintético' });
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0][0], /^[a-f0-9]{64}$/);
    await profile.execute('x'.repeat(130), 'registrar_solicitud', { nombre: 'Cliente sintético' });
    await profile.execute('x'.repeat(130), 'registrar_solicitud', { nombre: 'Cliente sintético' });
    assert.equal(f.calls[1][0], f.calls[2][0]);
    assert.throws(() => buildSecretaryProfile({ ...f.session, nombreEmpresa: '' }, f.hooks), /no verificada/);
  } finally { f.dispose(); }
});

test('adapter blocks disabled calls and invalid sessions before creating a provider; failed stop remains retryable', async () => {
  const f = fixture();
  try {
    const { GeminiSecretaryEngine } = f.runtime.load('src/inbound/secretary-engine.ts');
    let created = 0, audio = 0, stopFail = true, greeting = 0;
    const fake = { configureSecretary() {}, configureUsage() {}, start: async () => {}, requestInitialGreeting: async () => greeting++,
      pushInputAudio: () => audio++, handlePlaybackDrained() {}, stopAndConfirm: async () => { if (stopFail) throw Error('unconfirmed'); } };
    const engine = new GeminiSecretaryEngine({ geminiCommercialModel: 'synthetic-model' }, undefined, () => { created++; return fake; });
    await assert.rejects(engine.prepare(f.session, f.hooks), /no disponible/);
    assert.equal(created, 0);
    f.policy.realCallsEnabled = true;
    await assert.rejects(engine.prepare({ ...f.session, maxSegundos: 121 }, f.hooks), /inválida/);
    await assert.rejects(engine.prepare({ ...f.session, expiraEn: 'invalid' }, f.hooks), /inválida/);
    assert.equal(created, 0);
    await engine.prepare(f.session, f.hooks);
    await engine.greet(); engine.audio(Buffer.alloc(160));
    assert.equal(greeting, 1); assert.equal(audio, 1);
    await assert.rejects(engine.stop(), /unconfirmed/);
    engine.audio(Buffer.alloc(160)); assert.equal(audio, 1);
    await assert.rejects(engine.prepare(f.session, f.hooks), /no disponible/);
    stopFail = false; await engine.stop();
    await assert.rejects(engine.greet(), /no preparada/);
  } finally { f.dispose(); }
});

test('Gemini profile sends neither commercial tools nor transcription setup; early provider close rejects readiness', async () => {
  const f = fixture();
  try {
    const { GeminiLiveEngine } = f.runtime.load('src/engines/gemini-live-engine.ts');
    const { buildSecretaryProfile } = f.runtime.load('src/inbound/secretary-engine.ts');
    const events = { onError() {}, onHangupRequested() {} };
    const engine = new GeminiLiveEngine({ geminiApiKey: 'synthetic-never-sent', geminiCommercialModel: 'synthetic-model', sampleRate: 16000 }, events);
    engine.configureSecretary(buildSecretaryProfile(f.session, f.hooks));
    const started = engine.start(f.session.llamadaId, {}, { callDirection: 'inbound' });
    const rejected = assert.rejects(started, /cerrado antes/);
    const socket = f.sockets[0]; socket.emit('open');
    const setup = socket.sent[0].setup;
    assert.equal(setup.inputAudioTranscription, undefined); assert.equal(setup.outputAudioTranscription, undefined);
    assert.equal(setup.tools[0].functionDeclarations.some(t => t.name === 'record_whatsapp_consent'), false);
    socket.close(); await rejected;
    await engine.stop('test_cleanup');
  } finally { f.dispose(); }
});

test('provider tools serialize, forbid commercial fallback, preserve uncertainty and ignore returned transcripts', async () => {
  const f = fixture();
  try {
    const { GeminiLiveEngine } = f.runtime.load('src/engines/gemini-live-engine.ts');
    const engine = Object.create(GeminiLiveEngine.prototype);
    engine.isCallActive = true; engine.secretaryQueue = Promise.resolve(); engine.secretaryPending = 0;
    engine.events = { onError: e => f.failures.push(e.message) };
    engine.ws = { readyState: 1, send: raw => f.responses.push(JSON.parse(raw)) };
    engine.secretaryProfile = { tools: [{ name: 'registrar_solicitud' }], execute: async () => { throw Error('private backend detail'); } };
    engine.handleServerMessage({ serverContent: { inputTranscription: { text: 'private caller text' }, outputTranscription: { text: 'private reply' }, modelTurn: { parts: [{ text: 'private text' }] } } });
    assert.equal(engine.transcriptTurns, undefined);
    engine.enqueueSecretaryTool({ id: 'first', name: 'record_whatsapp_consent', args: {} });
    engine.enqueueSecretaryTool({ id: 'second', name: 'registrar_solicitud', args: {} });
    await engine.secretaryQueue;
    assert.equal(f.responses[0].toolResponse.functionResponses[0].response.output.codigo, 'HERRAMIENTA_NO_AUTORIZADA');
    assert.equal(f.responses[1].toolResponse.functionResponses[0].response.output.codigo, 'RESULTADO_NO_CONFIRMADO');
    assert.equal(JSON.stringify(f.responses).includes('private'), false);
    let release; const gate = new Promise(resolve => { release = resolve; }); const order = [];
    engine.secretaryProfile.execute = async id => { order.push(id); if (id === 'one') await gate; return { ok: true }; };
    engine.enqueueSecretaryTool({ id: 'one', name: 'registrar_solicitud', args: {} });
    engine.enqueueSecretaryTool({ id: 'two', name: 'registrar_solicitud', args: {} });
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['one']);
    engine.isCallActive = false; release(); await engine.secretaryQueue;
    assert.deepEqual(order, ['one']); assert.equal(engine.secretaryPending, 0);
  } finally { f.dispose(); }
});

test('existing codecs carry 20 ms audio both ways and interruption clears the emitted turn', async () => {
  const f = fixture(true);
  try {
    const { GeminiLiveEngine } = f.runtime.load('src/engines/gemini-live-engine.ts');
    const { buildSecretaryProfile } = f.runtime.load('src/inbound/secretary-engine.ts');
    const audio = [], flushed = [], ended = [];
    const engine = new GeminiLiveEngine({ geminiApiKey: 'synthetic-never-sent', geminiCommercialModel: 'synthetic-model', sampleRate: 16000, audioCodec: 'pcma' }, {
      onError() {}, onHangupRequested() {}, onTurnStart() {}, onAudioRaw: (buffer, turn) => audio.push({ buffer, turn }),
      onFlush: turn => flushed.push(turn), onTurnEnd: turn => ended.push(turn),
      onTranscript() { throw Error('Transcript must not be emitted'); },
    });
    engine.configureSecretary(buildSecretaryProfile(f.session, f.hooks));
    const preparing = engine.start(f.session.llamadaId, {}, { callDirection: 'inbound' });
    const socket = f.sockets[0]; socket.emit('open'); socket.emit('message', Buffer.from('{"setupComplete":{}}'));
    await preparing;
    engine.pushInputAudio(new Int16Array(0), Buffer.alloc(160, 0xd5));
    const upstream = socket.sent.at(-1).realtimeInput.mediaChunks[0];
    assert.equal(upstream.mimeType, 'audio/pcm;rate=16000');
    assert.equal(Buffer.from(upstream.data, 'base64').length, 640);
    const samples = Buffer.alloc(960);
    for (let i = 0; i < 480; i++) samples.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 400 * i / 24000) * 3000), i * 2);
    socket.emit('message', Buffer.from(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: samples.toString('base64') } }] }, turnComplete: true } })));
    assert.equal(audio.length, 1); assert.equal(audio[0].buffer.length, 160); assert.equal(audio[0].turn, 1);
    assert.equal(audio[0].buffer.some(value => value !== 0xd5), true); assert.deepEqual(ended, [1]);
    socket.emit('message', Buffer.from('{"serverContent":{"interrupted":true}}'));
    assert.deepEqual(flushed, [1]);
    await engine.stopAndConfirm('test_cleanup');
    assert.equal(socket.readyState, 3);
  } finally { f.dispose(); }
});

test('two stop attempts remain unconfirmed until an actual websocket close is observed', async () => {
  const f = fixture();
  try {
    const { GeminiLiveEngine } = f.runtime.load('src/engines/gemini-live-engine.ts');
    const engine = Object.create(GeminiLiveEngine.prototype);
    const socket = new EventEmitter(); socket.readyState = 1; socket.close = () => {}; socket.terminate = () => {};
    engine.ws = socket; engine.downlinkResampler = { reset() {} }; engine.callId = 'synthetic-close';
    await assert.rejects(engine.stopAndConfirm('test'), /sin confirmar/);
    assert.equal(engine.ws, null);
    await assert.rejects(engine.stopAndConfirm('test'), /sin confirmar/);
    socket.emit('close');
    await engine.stopAndConfirm('test');
  } finally { f.dispose(); }
});

test('secretary greeting failures are visible and cannot silently confirm readiness', async () => {
  const f = fixture();
  try {
    const { GeminiLiveEngine } = f.runtime.load('src/engines/gemini-live-engine.ts');
    const engine = Object.create(GeminiLiveEngine.prototype);
    engine.secretaryProfile = { greeting: 'Saludo sintético' }; engine.ws = null;
    await assert.rejects(engine.requestInitialGreeting(), /no disponible/);
    engine.contextStore = { getState: () => ({ business: { name: 'Sintética' } }) };
    engine.ws = { readyState: 1, send() { throw Error('private transport details'); } };
    await assert.rejects(engine.requestInitialGreeting(), /No se pudo enviar el saludo/);
  } finally { f.dispose(); }
});

test('a failed usage persistence callback closes the provider and blocks further processing', async () => {
  const f = fixture();
  try {
    const { GeminiLiveEngine } = f.runtime.load('src/engines/gemini-live-engine.ts');
    const { buildSecretaryProfile } = f.runtime.load('src/inbound/secretary-engine.ts');
    const failures = []; let observations = 0;
    const engine = new GeminiLiveEngine({ geminiApiKey: 'synthetic-never-sent', geminiCommercialModel: 'synthetic-model', sampleRate: 16000 }, {
      onError: error => failures.push(error.message), onHangupRequested() {},
    });
    engine.configureSecretary(buildSecretaryProfile(f.session, f.hooks));
    engine.configureUsage(() => { observations++; throw Error('private disk path or content'); });
    const preparing = engine.start(f.session.llamadaId, {}, { callDirection: 'inbound' });
    const socket = f.sockets[0]; socket.emit('open'); socket.emit('message', Buffer.from('{"setupComplete":{}}')); await preparing;
    const report = Buffer.from('{"usageMetadata":{"totalTokenCount":1,"promptTokenCount":1,"responseTokenCount":0}}');
    socket.emit('message', report); socket.emit('message', report);
    assert.equal(observations, 1); assert.equal(failures.length, 1);
    assert.match(failures[0], /sesión bloqueada/); assert.equal(failures[0].includes('private'), false);
    assert.equal(socket.readyState, 3); assert.equal(engine.isCallActive, false);
    await engine.stopAndConfirm('test_cleanup');
  } finally { f.dispose(); }
});
