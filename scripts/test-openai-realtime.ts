import { WebSocketServer, WebSocket } from "ws";
import net from "net";
import {
  loadConfig,
  getDefaultConfig,
  getSanitizedConfig,
  maskApiKey,
  saveConfig,
} from "../src/storage.js";
import { resamplePcm, StreamingResampler, PacketFramer, encodePacket, PACKET_AUDIO, PACKET_FLUSH, PACKET_CALL_START, PACKET_CALL_END } from "../src/audio-bridge.js";
import { CostMeter, OFFICIAL_RATES } from "../src/cost-meter.js";
import { PlaybackTracker } from "../src/playback-tracker.js";
import { ContextStore } from "../src/context-store.js";
import { HandoffController } from "../src/handoff-controller.js";
import { isExplicitWhatsAppAuthorization } from "../src/pipeline.js";
import { OpenAIRealtimeEngine } from "../src/engines/openai-realtime-engine.js";
import { AgentConfig } from "../src/types.js";

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    totalPassed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}${detail ? `: ${detail}` : ""}`);
    totalFailed++;
  }
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("  SUITE DE PRUEBAS AUTOMATIZADAS: MODO OPENAI REALTIME + DOBLE ASISTENTE");
  console.log("================================================================================\n");

  // 1. CONFIGURACIÓN, MIGRACIÓN Y MÁSCARA DE SEGURIDAD
  console.log("📌 1. Configuración, Migración y Seguridad de Claves API");
  {
    const defaults = getDefaultConfig();
    assert(defaults.conversationEngine === "together_pipeline", "Por defecto migra a together_pipeline");
    assert(defaults.realtimeCommercialModel === "gpt-realtime-2.1-mini", "Modelo comercial por defecto es mini");
    assert(defaults.realtimeTechnicalModel === "gpt-realtime-2.1", "Modelo técnico por defecto es 2.1");
    assert(defaults.realtimeCommercialVoice === "marin", "Voz comercial por defecto es marin");
    assert(defaults.realtimeTechnicalVoice === "cedar", "Voz técnica por defecto es cedar");

    // Máscara
    assert(maskApiKey("sk-proj-1234567890abcdef") === "sk-...cdef", "maskApiKey enmascara clave larga con prefijo sk-... y últimos 4 caracteres");
    assert(maskApiKey("1234") === "********", "maskApiKey enmascara claves cortas con asteriscos");
    assert(maskApiKey("") === "", "maskApiKey maneja strings vacíos");

    // Sanitización
    const sanitized = getSanitizedConfig({
      ...defaults,
      openaiApiKey: "sk-proj-supersecretkey123456",
      togetherApiKey: "together-secret-key-99999",
    });
    assert(sanitized.openaiApiKey === undefined, "getSanitizedConfig NO expone openaiApiKey en claro");
    assert(sanitized.togetherApiKey === undefined, "getSanitizedConfig NO expone togetherApiKey en claro");
    assert(sanitized.openaiApiKeyConfigured === true, "getSanitizedConfig indica openaiApiKeyConfigured = true");
    assert(sanitized.openaiApiKeyMasked.includes("..."), "getSanitizedConfig incluye clave enmascarada");
  }

  // 2. REMUESTREO 16K <-> 24K Y TRAMADO TCP
  console.log("\n📌 2. Remuestreo Bidireccional (16k <-> 24k) y Framer TCP");
  {
    // Remuestreo estático completo
    const input16k = new Int16Array(160);
    for (let i = 0; i < input16k.length; i++) input16k[i] = Math.sin(i * 0.1) * 10000;

    const staticResampled24k = resamplePcm(input16k, 16000, 24000);
    assert(staticResampled24k.length === 240, "resamplePcm 16k -> 24k remuestrea 160 muestras a 240 muestras exactas (ratio 1.5)");

    const staticRoundtrip16k = resamplePcm(staticResampled24k, 24000, 16000);
    assert(staticRoundtrip16k.length === 160, "resamplePcm 24k -> 16k recupera 160 muestras exactas (ratio 0.6667)");

    // Remuestreo continuo de flujo (StreamingResampler preserva residuo fraccionario entre paquetes)
    const uplinkStream = new StreamingResampler(16000, 24000);
    let totalStreamSamples = 0;
    for (let i = 0; i < 10; i++) {
      totalStreamSamples += uplinkStream.process(input16k).length;
    }
    assert(totalStreamSamples >= 2398 && totalStreamSamples <= 2400, "StreamingResampler acumula y procesa flujos continuos preservando el residuo fraccionario");

    // Fragmentación TCP
    const framer = new PacketFramer();
    const packet = encodePacket(PACKET_AUDIO, 42, Buffer.from(new Uint8Array(200)));
    // Dividir en 3 fragmentos desiguales
    const p1 = packet.subarray(0, 2);
    const p2 = packet.subarray(2, 50);
    const p3 = packet.subarray(50);

    const out1 = framer.push(p1);
    const out2 = framer.push(p2);
    const out3 = framer.push(p3);

    assert(out1.length === 0 && out2.length === 0 && out3.length === 1, "PacketFramer reconstruye paquete completo a partir de fragmentos TCP arbitrarios");
    assert(out3[0].turnId === 42 && out3[0].payload.length === 200, "PacketFramer preserva turnId y longitud de payload exacta");
  }

  // 3. MEDIDOR DE COSTES (COST METER) Y TARIFAS 15/10/2026
  console.log("\n📌 3. Tarificación Exacta y Deducción de Caché (15/10/2026)");
  {
    const meter = new CostMeter("test-call-1", 0.10, 0.20, 0.30);

    // Mini: 1000 audio in (200 cached), 500 audio out
    // Tarifas mini: Audio in: 10$/M, Cache: 0.30$/M, Audio out: 20$/M
    // Uncached audio in = 800 * 0.000010 = 0.0080
    // Cached audio in = 200 * 0.00000030 = 0.00006
    // Audio out = 500 * 0.000020 = 0.0100
    // Total esperado = 0.01806
    const usageResp1 = {
      total_tokens: 1500,
      input_tokens: 1000,
      output_tokens: 500,
      input_token_details: {
        cached_tokens: 200,
        audio_tokens: 1000,
        cached_tokens_details: { audio_tokens: 200 },
      },
      output_token_details: {
        audio_tokens: 500,
      },
    };

    const s1 = meter.recordResponseUsage("resp_1", "gpt-realtime-2.1-mini", "commercial", usageResp1);
    assert(Math.abs(s1.commercialCostUsd - 0.01806) < 0.00001, `Coste mini calculado con precisión y deducción de caché ($${s1.commercialCostUsd})`);
    assert(s1.commercialTokens.audioInput === 800, "Tokens no cacheados contabilizados sin duplicidad (800)");
    assert(s1.commercialTokens.audioInputCached === 200, "Tokens cacheados contabilizados con su tarifa de caché (200)");

    // Idempotencia: enviar el mismo resp_1 no debe duplicar coste
    const s1_dup = meter.recordResponseUsage("resp_1", "gpt-realtime-2.1-mini", "commercial", usageResp1);
    assert(s1_dup.totalCostUsd === s1.totalCostUsd, "Procesamiento de responseId es idempotente (no duplica consumo)");

    // Alerta y Límites
    assert(!s1.alertTriggered, "Alerta no disparada por debajo de 0.10$");

    // Simular consumo técnico alto en 2.1
    const usageResp2 = {
      input_tokens: 5000,
      output_tokens: 3000,
      input_token_details: { audio_tokens: 5000, cached_tokens: 0 },
      output_token_details: { audio_tokens: 3000 },
    };
    // 2.1: 5000 * 32$/M = 0.160, 3000 * 64$/M = 0.192. Total = 0.352$
    const s2 = meter.recordResponseUsage("resp_2", "gpt-realtime-2.1", "technical", usageResp2);
    assert(s2.alertTriggered === true, "Alerta de coste disparada al superar 0.10$");
    assert(s2.hardLimitExceeded === true, "Límite duro (0.30$) detectado correctamente para forzar fin de llamada limpio");
  }

  // 4. PLAYBACK TRACKER Y TRUNCAMIENTO EXACTO (BARGE-IN)
  console.log("\n📌 4. Playback Tracker y conversation.item.truncate Muestra-Exacto");
  {
    const tracker = new PlaybackTracker(16000);
    tracker.registerAudioItem("item_audio_123", 0, 24000);

    // Encolar 12,000 muestras a 24kHz = 500 ms de audio en buffer
    tracker.recordSamplesSent("item_audio_123", 12000);

    // Si aún no ha comenzado la reproducción física en el hardware, debe truncar a 0 ms
    const truncQueued = tracker.truncateActiveItem();
    assert(truncQueued !== null, "Genera datos de truncado para item activo");
    assert(truncQueued?.audioEndMs === 0, `Audio en cola sin reproducir trunca a 0 ms (${truncQueued?.audioEndMs} ms)`);

    // Resetear para probar reproducción física efectiva de 12,000 muestras (500 ms)
    tracker.reset();
    tracker.registerAudioItem("item_audio_played", 0, 24000);
    tracker.recordSamplesSent("item_audio_played", 12000);
    tracker.recordSamplesPlayed("item_audio_played", 12000);

    const truncPlayed = tracker.truncateActiveItem();
    assert(truncPlayed !== null, "Genera datos de truncado tras reproducción");
    assert(truncPlayed?.itemId === "item_audio_played", "Truncado referencia item_id correcto");
    assert(truncPlayed?.audioEndMs === 500, `audio_end_ms calculado con exactitud matemática (${truncPlayed?.audioEndMs} ms esperado 500 ms)`);

    // Idempotencia: segundo truncate no debe duplicarse
    const trunc2 = tracker.truncateActiveItem();
    assert(trunc2 === null, "Truncado de item ya truncado es idempotente (retorna null)");
  }

  // 5. ORQUESTADOR DE TRASPASO (HANDOFF CONTROLLER) Y MUTEX
  console.log("\n📌 5. Orquestador de Traspaso Comercial -> Técnico y Mutex");
  {
    const config: AgentConfig = {
      apiKey: "test",
      persona: "kira",
      systemPrompt: "test",
      sttModel: "test",
      llmModel: "test",
      ttsModel: "test",
      ttsVoice: "ef_dora",
      sampleRate: 16000,
      maxTokens: 90,
      disableReasoning: true,
      installPrice: "99",
      monthlyPriceBasic: "5",
      monthlyPriceFull: "10",
      handoffTimeoutMs: 1000,
    };
    const store = new ContextStore("call-handoff-test", config);

    let stateChanges: string[] = [];
    let technicalSessionCreated: boolean = false;

    const controller = new HandoffController(store, {
      handoffTimeoutMs: 2000,
      onStateChange: (state, detail) => {
        stateChanges.push(state);
      },
      onAnnouncePhrase: async (phrase) => {
        assert(phrase.includes("asistente técnico"), "Locución de cortesía menciona pase al asistente técnico");
      },
      onSwitchSession: async () => {},
      createTechnicalSession: async () => {
        technicalSessionCreated = true;
        return { fakeSession: true };
      },
    });

    // 1er traspaso válido
    const res1 = await controller.executeTransfer({
      customer_question: "¿Puedo sincronizar las citas con Google Calendar?",
      facts_to_preserve: ["Cliente tiene taller de fontanería"],
    });

    assert(res1.success === true, "Primer traspaso técnico se completa con éxito");
    assert(Boolean(technicalSessionCreated), "Sesión técnica creada bajo demanda");
    assert(store.getState().exact_question === "¿Puedo sincronizar las citas con Google Calendar?", "ContextStore preserva la duda exacta del cliente");
    assert(store.getState().role === "technical", "ContextStore conmutó rol a técnico");

    // 2do traspaso en la misma llamada (debe ser rechazado por límite / mutex)
    const res2 = await controller.executeTransfer({
      customer_question: "¿Tienen soporte los domingos?",
    });
    assert(res2.success === false, "Segundo traspaso rechazado por mutex (máximo 1 traspaso por llamada)");
  }

  // 6. VALIDADOR ESTRICTO DE AUTORIZACIÓN DE WHATSAPP
  console.log("\n📌 6. Filtro Anti-Falsos Positivos de Autorización de WhatsApp");
  {
    // Casos que SÍ son autorización
    assert(isExplicitWhatsAppAuthorization("Sí, envíamela") === true, "«Sí, envíamela» es autorización");
    assert(isExplicitWhatsAppAuthorization("Vale, perfecto, mándala") === true, "«Vale, perfecto, mándala» es autorización");
    assert(isExplicitWhatsAppAuthorization("De acuerdo, muchas gracias") === true, "«De acuerdo, muchas gracias» es autorización");
    assert(isExplicitWhatsAppAuthorization("Por supuesto") === true, "«Por supuesto» es autorización");

    // Casos que NO son autorización (Dudas, preguntas sobre precio, condicionales o saludos)
    assert(isExplicitWhatsAppAuthorization("Vale, pero antes explícame cómo funciona") === false, "«Vale, pero antes explícame...» NO es autorización");
    assert(isExplicitWhatsAppAuthorization("Vale, ¿cuánto cuesta?") === false, "«Vale, ¿cuánto cuesta?» NO es autorización");
    assert(isExplicitWhatsAppAuthorization("Vale, si no me cobras") === false, "«Vale, si no me cobras» NO es autorización (condicional)");
    assert(isExplicitWhatsAppAuthorization("Hola buenas") === false, "«Hola buenas» NO es autorización");
    assert(isExplicitWhatsAppAuthorization("Quién llama") === false, "«Quién llama» NO es autorización");
    assert(isExplicitWhatsAppAuthorization("No me interesa") === false, "«No me interesa» NO es autorización");
  }

  // 7. PRUEBA INTEGRADA CON MOCK DE SERVIDOR OPENAI REALTIME
  console.log("\n📌 7. Integración Completa con Mock de Servidor OpenAI Realtime");
  {
    const MOCK_PORT = 19876;
    const wss = new WebSocketServer({ port: MOCK_PORT });

    let sessionUpdateReceived: boolean = false;
    let audioAppendedCount = 0;
    let truncateReceived: boolean = false;

    wss.on("connection", (clientWs) => {
      // 1. Enviar session.created
      clientWs.send(JSON.stringify({ type: "session.created" }));

      clientWs.on("message", (msg) => {
        const evt = JSON.parse(msg.toString());
        if (evt.type === "session.update") {
          sessionUpdateReceived = true;
          // Responder session.updated
          clientWs.send(JSON.stringify({ type: "session.updated" }));
        } else if (evt.type === "input_audio_buffer.append") {
          audioAppendedCount++;
        } else if (evt.type === "conversation.item.truncate") {
          truncateReceived = true;
        }
      });
    });

    const agentConfig: AgentConfig = {
      apiKey: "dummy-key",
      persona: "kira",
      systemPrompt: "prompt",
      sttModel: "whisper",
      llmModel: "qwen",
      ttsModel: "kokoro",
      ttsVoice: "ef_dora",
      sampleRate: 16000,
      maxTokens: 90,
      disableReasoning: true,
      conversationEngine: "openai_realtime",
      openaiApiKey: "sk-mock-key-12345",
      realtimeCommercialModel: "gpt-realtime-2.1-mini",
      realtimeCommercialVoice: "marin",
    };

    let audioFramesEmitted = 0;
    let flushEmitted: boolean = false;

    // Crear socket TCP simulado para el bridge
    const mockSocket = new net.Socket();

    const engine = new OpenAIRealtimeEngine(agentConfig, {
      onAudio: () => { audioFramesEmitted++; },
      onState: () => {},
      onRoleChanged: () => {},
      onHandoffState: () => {},
      onTranscript: () => {},
      onTurnStart: () => {},
      onTurnEnd: () => {},
      onFlush: () => { flushEmitted = true; },
      onUsageUpdate: () => {},
      onError: (e) => console.error("Engine mock error:", e.message),
      onHangupRequested: () => {},
    });

    // Sobrescribir URL para apuntar a nuestro mock local
    (engine as any).createSession = function(model: string, voice: string, role: string) {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${MOCK_PORT}`);
        const handle = { ws, model, voice, role, isReady: false };
        ws.on("open", () => {});
        ws.on("message", (data) => {
          const evt = JSON.parse(data.toString());
          (engine as any).handleServerEvent(handle, evt, () => {
            resolve(handle);
          });
        });
      });
    };

    await engine.start("mock-call-123", mockSocket);

    assert(Boolean(sessionUpdateReceived), "OpenAIRealtimeEngine negocia configuración de sesión mediante session.update");

    // Probar envío de audio del cliente (16k -> 24k -> append)
    const micPcm = new Int16Array(320); // 20 ms a 16kHz
    engine.pushInputAudio(micPcm, Buffer.alloc(640));
    // Esperar microtask
    await new Promise((r) => setTimeout(r, 50));
    assert(audioAppendedCount > 0, "Audio del micrófono se remuestrea a 24k y se envía a input_audio_buffer.append");

    // Simular barge-in del servidor enviando input_audio_buffer.speech_started
    const activeWs = (engine as any).activeSession.ws;
    activeWs.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));

    assert(Boolean(flushEmitted), "Barge-in (speech_started) corta reproducción local y emite FLUSH inmediatamente");

    await engine.stop("test_finished");
    wss.close();
  }

  console.log("\n================================================================================");
  console.log(`  RESULTADO: ${totalPassed} PRUEBAS SUPERADAS, ${totalFailed} FALLOS`);
  console.log("================================================================================\n");

  if (totalFailed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("Error fatal en suite de pruebas:", err);
  process.exit(1);
});
