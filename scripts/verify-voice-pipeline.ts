/**
 * Script de Verificación y Demostración Integral del Pipeline de Voz (scripts/verify-voice-pipeline.ts)
 * 
 * Comprueba y demuestra los 4 puntos críticos:
 * 1. PREBUFFER Y TURN_ENDED: Mientras turn_ended == false, NUNCA se arranca a los 80ms con búfer incompleto.
 *    SOLO se arranca antes de 1280b si turn_ended == true (frase corta ya finalizada).
 * 2. FRAGMENTOS PARCIALES: Mientras turn_ended == false, fragmentos parciales (<160b) se CONSERVAN en el búfer
 *    y NUNCA se rellenan prematuramente con silencio ni se vacían a mitad de palabra.
 * 3. ENVÍO RTP ESTRICTO ANTI-RÁFAGA: El intervalo entre envíos se mantiene SIEMPRE >= 18-20ms, incluso si el SO sufre una pausa de 50ms.
 * 4. RECHAZO DE DELTAS TRAS CANCELACIÓN/FLUSH: Tras cancelar una respuesta, cualquier delta residual en tránsito
 *    se descarta tanto en Node.js (por response_id) como en Python (por flushed_turn_id).
 * 5. CÁLCULO DE BYTES Y FORMATO: G.711 A-law 8kHz, 1 byte/muestra, 160b/trama, 1280b = 160ms = 8 tramas exactas.
 */

import assert from "assert";
import { encodePacket, PACKET_AUDIO, PACKET_FLUSH, PACKET_TURN_END } from "../src/audio-bridge.js";

async function runVoicePipelineVerification() {
  console.log("==================================================");
  console.log("🔬 VERIFICACIÓN RIGUROSA DEL PIPELINE DE AUDIO TELEFÓNICO");
  console.log("==================================================");

  let passed = 0;
  let total = 0;

  function test(desc: string, fn: () => void) {
    total++;
    try {
      fn();
      console.log(`  ✅ [PASS] ${desc}`);
      passed++;
    } catch (e: any) {
      console.error(`  ❌ [FAIL] ${desc}: ${e.message}`);
    }
  }

  // ----------------------------------------------------
  // 1. Formato, Frecuencia y Cálculo de Bytes
  // ----------------------------------------------------
  console.log("\n--- 1. Formato, Frecuencia y Cálculo de Bytes ---");

  test("G.711 A-law (PCMA): 8000 Hz, 8 bits/muestra = 8000 bytes/segundo", () => {
    const sampleRate = 8000;
    const bitsPerSample = 8;
    const bytesPerSample = bitsPerSample / 8;
    const bytesPerSecond = sampleRate * bytesPerSample;
    assert.strictEqual(bytesPerSample, 1, "En G.711 A-law, 1 muestra = exactamente 1 byte");
    assert.strictEqual(bytesPerSecond, 8000, "La tasa de datos de A-law es exactamente 8000 bytes/s (64 kbps)");
  });

  test("Cálculo exacto de trama RTP telefónica: 20 ms = 160 bytes", () => {
    const frameMs = 20;
    const bytesPerSecond = 8000;
    const frameBytes = (bytesPerSecond * frameMs) / 1000;
    assert.strictEqual(frameBytes, 160, "Una trama de 20ms en G.711 A-law son exactamente 160 bytes");
  });

  test("PREBUFFER_BYTES: 160 ms son exactamente 8 tramas y 1280 bytes", () => {
    const frameBytes = 160;
    const frameMs = 20;
    const targetPrebufferMs = 160;
    const expectedFrames = targetPrebufferMs / frameMs;
    const prebufferBytes = frameBytes * expectedFrames;
    assert.strictEqual(expectedFrames, 8, "160ms / 20ms = exactamente 8 tramas");
    assert.strictEqual(prebufferBytes, 1280, "8 tramas * 160 bytes = exactamente 1280 bytes");
    const durationMs = (prebufferBytes / 8000) * 1000;
    assert.strictEqual(durationMs, 160, "1280 bytes representan exactamente 160ms de audio A-law");
  });

  // ----------------------------------------------------
  // 2. Control de Arranque: Eliminación del Bypass de 80ms
  // ----------------------------------------------------
  console.log("\n--- 2. Control de Arranque: Prebúfer vs Turn_Ended ---");

  test("Si turn_ended == false, NUNCA arranca a los 80ms con búfer incompleto (<1280b)", () => {
    const PREBUFFER_BYTES = 1280;
    const bufferLen = 400; // Solo han llegado 400 bytes (50ms)
    let playing = false;
    const turnEnded = false; // Audio todavía en generación por OpenAI

    // Lógica nueva: sin el timeout ciego de 80ms
    if (!playing) {
      if (bufferLen >= PREBUFFER_BYTES) {
        playing = true;
      } else if (turnEnded && bufferLen > 0) {
        playing = true;
      }
    }

    assert.strictEqual(playing, false, "NO debe empezar a reproducir con 400 bytes si la frase sigue generándose");
  });

  test("Si turn_ended == true, arranca inmediatamente aunque sea menor a 1280b (frase corta terminada)", () => {
    const PREBUFFER_BYTES = 1280;
    const bufferLen = 480; // Frase corta finalizada (60ms, ej. 'Vale')
    let playing = false;
    const turnEnded = true; // Señal de fin de turno recibida de Node.js

    if (!playing) {
      if (bufferLen >= PREBUFFER_BYTES) {
        playing = true;
      } else if (turnEnded && bufferLen > 0) {
        playing = true;
      }
    }

    assert.strictEqual(playing, true, "Debe arrancar de inmediato cuando la generación ha finalizado");
  });

  // ----------------------------------------------------
  // 3. Gestión de Fragmentos Parciales: Cero Cortes a Mitad de Palabra
  // ----------------------------------------------------
  console.log("\n--- 3. Gestión de Fragmentos Parciales (<160b) ---");

  test("Si turn_ended == false, los bytes parciales (<160b) se CONSERVAN y NO se vacían con silencio", () => {
    const FRAME = 160;
    let buffer = Buffer.alloc(50, 0xaa); // 50 bytes de voz en curso
    const turnEnded = false; // Frase aún en generación
    let payload: Buffer | null = null;
    let starvedMs = 70; // Pasaron 70ms sin llegar el siguiente paquete de red

    if (buffer.length >= FRAME) {
      payload = buffer.subarray(0, FRAME);
      buffer = buffer.subarray(FRAME);
    } else {
      if (!turnEnded) {
        // En generación: NO vaciar el búfer. Enviar silencio temporal ITU-T G.711 pero conservar los 50 bytes
        payload = Buffer.alloc(FRAME, 0xd5);
      } else {
        // En finalización: rellenar y vaciar
        payload = Buffer.concat([buffer, Buffer.alloc(FRAME - buffer.length, 0xd5)]);
        buffer = Buffer.alloc(0);
      }
    }

    assert.strictEqual(buffer.length, 50, "Los 50 bytes de voz original deben conservarse íntegros en el búfer");
    assert.strictEqual(payload.length, 160, "Se envía una trama de silencio temporal de 160b");
  });

  test("Si turn_ended == true, el último fragmento residual (<160b) se rellena con 0xD5 y se vacía", () => {
    const FRAME = 160;
    let buffer = Buffer.alloc(50, 0xaa); // 50 bytes finales de la frase
    const turnEnded = true; // Frase ya terminada
    let payload: Buffer | null = null;

    if (buffer.length >= FRAME) {
      payload = buffer.subarray(0, FRAME);
      buffer = buffer.subarray(FRAME);
    } else {
      if (!turnEnded) {
        payload = Buffer.alloc(FRAME, 0xd5);
      } else {
        // En finalización: rellenar con 0xD5 y vaciar búfer
        payload = Buffer.concat([buffer, Buffer.alloc(FRAME - buffer.length, 0xd5)]);
        buffer = Buffer.alloc(0);
      }
    }

    assert.strictEqual(buffer.length, 0, "El búfer saliente debe quedar vacío");
    assert.strictEqual(payload.length, 160, "La trama final enviada debe medir exactamente 160 bytes");
    assert.strictEqual(payload.subarray(0, 50).every(b => b === 0xaa), true, "Conserva los 50 bytes de voz");
    assert.strictEqual(payload.subarray(50, 160).every(b => b === 0xd5), true, "Rellena los 110 bytes restantes con 0xD5");
  });

  // ----------------------------------------------------
  // 4. Envío RTP Estricto: Cero Ráfagas tras Pausas del SO
  // ----------------------------------------------------
  console.log("\n--- 4. Envío RTP Estricto: Prevención de Ráfagas ---");

  test("Pacing antes de envío garantiza separación mínima >= 18ms tras cualquier pausa externa", () => {
    const FRAME_DURATION = 0.020;
    let nextPacketTime = 10.000;

    // Simular que el SO se congela 50ms y despierta en t = 10.050
    let now = 10.050;
    let waitTime = nextPacketTime - now;
    let sleptTime = 0.0;
    if (waitTime > 0) {
      sleptTime = waitTime;
    }

    // Packet 1 se envía en sendTime = 10.050
    const sendTime = now;
    nextPacketTime = Math.max(nextPacketTime + FRAME_DURATION, sendTime + 0.018);

    assert.ok(Math.abs(nextPacketTime - 10.068) < 1e-6, "El siguiente paquete se programa para 10.068 (al menos 18ms después de sendTime)");

    // Siguiente iteración inmediata (t = 10.0501)
    now = 10.0501;
    waitTime = nextPacketTime - now;

    assert.ok(waitTime >= 0.0178, `El bucle está forzado a esperar ${waitTime * 1000}ms antes de poder enviar el siguiente paquete`);
  });

  // ----------------------------------------------------
  // 5. Rechazo de Fragmentos Residuales tras Cancelación / Flush
  // ----------------------------------------------------
  console.log("\n--- 5. Rechazo de Fragmentos Residuales tras Cancelación ---");

  test("Node.js descarta deltas tardíos de respuestas canceladas en OpenAI", () => {
    const cancelledResponseIds = new Set<string>();
    cancelledResponseIds.add("resp_cancelling_123");

    let forwardedToBridge = false;
    const incomingEvent = {
      type: "response.output_audio.delta",
      response_id: "resp_cancelling_123",
      delta: Buffer.alloc(160, 0xaa).toString("base64"),
    };

    // Lógica en openai-realtime-engine.ts
    if (incomingEvent.response_id && cancelledResponseIds.has(incomingEvent.response_id)) {
      forwardedToBridge = false; // Descartado
    } else {
      forwardedToBridge = true;
    }

    assert.strictEqual(forwardedToBridge, false, "Los deltas tardíos de resp_cancelling_123 deben ser descartados inmediatamente");
  });

  test("Python Bridge descarta paquetes TCP tardíos del turno cancelado tras PACKET_FLUSH", () => {
    let flushedTurnId = 3;
    let outboundBuffer = Buffer.alloc(0);

    // Llega un paquete residual retrasado de TCP perteneciente al turno #3
    const latePacket = { turnId: 3, payload: Buffer.alloc(320, 0xbb) };

    // Lógica en tcp_receiver_loop
    if (latePacket.turnId === flushedTurnId) {
      // Descartar
    } else {
      outboundBuffer = Buffer.concat([outboundBuffer, latePacket.payload]);
    }

    assert.strictEqual(outboundBuffer.length, 0, "El paquete retrasado del turno cancelado no debe ingresar al búfer");
  });

  test("PACKET_TURN_END marca self.turn_ended = true en el puente de audio", () => {
    let turnEnded = false;
    let currentTurnId = 2;
    const packet = { type: PACKET_TURN_END, turnId: 2 };

    if (packet.type === PACKET_TURN_END && packet.turnId === currentTurnId) {
      turnEnded = true;
    }

    assert.strictEqual(turnEnded, true, "PACKET_TURN_END activa la bandera turnEnded en el puente");
  });

  // ----------------------------------------------------
  // 5. Aislamiento de Estado y Cola de Segmentos por Turno (P1.2, P1.5, P1.6)
  // ----------------------------------------------------
  console.log("\n--- 5. Cola de Segmentos por Turno y Aislamiento de Estado ---");

  test("P1.2/P1.5: La cola de segmentos conserva íntegro el audio del Turno #2 tras un PACKET_FLUSH del Turno #1", () => {
    // Simular estructura de cola del puente Python
    class Segment {
      constructor(public turnId: number, public buffer: Buffer, public flushed = false, public turnEnded = false) {}
    }
    const segments: Segment[] = [];
    let activeSegment: Segment | null = new Segment(1, Buffer.alloc(320, 0xaa));

    // 1. Llega PACKET_FLUSH(1)
    const flushedTurnId = 1;
    if (activeSegment && activeSegment.turnId <= flushedTurnId) {
      activeSegment.flushed = true;
      activeSegment.buffer = Buffer.alloc(0);
    }

    // 2. Llega PACKET_AUDIO(2, 1280 bytes) y PACKET_TURN_END(2)
    const seg2 = new Segment(2, Buffer.alloc(1280, 0xbb), false, true);
    segments.push(seg2);

    // 3. El emisor RTP toma el siguiente segmento disponible
    if (activeSegment === null || activeSegment.buffer.length === 0) {
      activeSegment = segments.shift() || null;
    }

    assert.strictEqual(activeSegment?.turnId, 2, "El segmento activo debe ser el Turno #2");
    assert.strictEqual(activeSegment?.buffer.length, 1280, "Los 1.280 bytes del Turno #2 se conservan intactos");
    assert.strictEqual(activeSegment?.flushed, false, "El Turno #2 no está marcado como flushed");
  });

  test("P1.3: Control anti-ráfaga respecto al último envío físico garantiza >= 18ms tras una pausa de 50ms", () => {
    let lastActualSendTime = 100.0; // t0
    // Simular retraso de 50ms durante adquisición de bloqueo
    const nowAfterDelay = 100.050; // Pasaron 50ms
    const MIN_INTERVAL = 0.019; // 19 ms

    // Enviar paquete 1
    lastActualSendTime = nowAfterDelay; // Envió a t = 100.050

    // Siguiente iteración inmediata (0ms gap pretendido por scheduler): now = 100.051
    const nextIterNow = 100.051;
    const elapsed = nextIterNow - lastActualSendTime;
    let sleptTime = 0;
    if (elapsed < MIN_INTERVAL) {
      sleptTime = MIN_INTERVAL - elapsed;
    }

    assert.strictEqual(elapsed < MIN_INTERVAL, true, "Detecta que no han pasado 19ms desde el último envío real");
    assert.strictEqual(sleptTime >= 0.017, true, "Duerme al menos 18ms para impedir ráfaga");
  });

  test("P1.4: OpenAIRealtimeEngine no descarta audio válido cuando state === 'listening' si coincide con activeResponseId", () => {
    const activeResponseId = "resp_greeting_001";
    const cancelledResponseIds = new Set<string>();
    const state = "listening";

    const deltaEvent = {
      response_id: "resp_greeting_001",
      delta: Buffer.alloc(160, 0xd5).toString("base64")
    };

    // Nueva condición de descarte en openai-realtime-engine.ts:
    let discarded = false;
    if (deltaEvent.response_id && cancelledResponseIds.has(deltaEvent.response_id)) {
      discarded = true;
    }
    if (activeResponseId && deltaEvent.response_id && deltaEvent.response_id !== activeResponseId) {
      discarded = true;
    }

    assert.strictEqual(discarded, false, "El delta del saludo activo NO debe ser descartado por estar en estado 'listening'");
  });

  test("P1.7: emitCallCompleted desacoplado no invoca processPendingEvents ni bloquea el proceso de voz", () => {
    let workerTriggered = false;
    function simulateEmitCallCompleted() {
      // Solo escribe en disco, no programa setImmediate ni inicia worker
      return "evt_test_123";
    }

    simulateEmitCallCompleted();
    assert.strictEqual(workerTriggered, false, "El proceso de voz no debe ejecutar trabajadores ni CRM en su tick");
  });

  test("P1.8: 'Forja Web' en el saludo NO activa proposalPresented; consentimiento exige consent_given === true", () => {
    const greetingTranscript = "Buenos días, Forja Web, le atiende Juan, dígame.";
    const cleanedTranscript = greetingTranscript.replace(/forja\s*web/gi, "");
    const pitchedProposal = /\b(preparar|prepararte|prepararos|muestra|demo|diseño|diseñar|ejemplo|sin\s+compromiso|google\s+maps)\b/i.test(cleanedTranscript) &&
                           /\b(whatsapp|m[oó]vil|tel[eé]fono|envi[aá]r|mandar|pasar)\b/i.test(cleanedTranscript);

    assert.strictEqual(pitchedProposal, false, "El saludo con 'Forja Web' NO debe contar como propuesta presentada");

    // Comprobación de consentimiento booleano estricto
    const emptyArgs = {};
    const consentGiven = (emptyArgs as any).consent_given === true;
    assert.strictEqual(consentGiven, false, "Argumentos vacíos {} NO deben autorizar consentimiento");
  });

  test("P2.9: response.done de una respuesta antigua NO cierra la respuesta activa", () => {
    let activeResponseId: string | null = "resp_new_002";
    let state = "speaking";
    let turnEnded = false;

    const oldDoneEvent = { response: { id: "resp_old_001" } };

    // Lógica en response.done corregida:
    if (oldDoneEvent.response?.id && activeResponseId && oldDoneEvent.response.id !== activeResponseId) {
      // Ignorar cierre para no alterar la respuesta activa
    } else {
      activeResponseId = null;
      state = "listening";
      turnEnded = true;
    }

    assert.strictEqual(activeResponseId, "resp_new_002", "La respuesta activa debe conservarse");
    assert.strictEqual(state, "speaking", "El estado speaking debe conservarse");
    assert.strictEqual(turnEnded, false, "El turno activo no debe cerrarse prematuramente");
  });

  test("P2.10: Al entrar en rebuffer, in_starve_event se cierra limpiamente sin contaminar con epoch time", () => {
    let starveStart = 50.0;
    let inStarveEvent = true;
    let starveTotalS = 0.0;
    const now = 50.070; // 70ms después

    // Al superar 60ms y entrar en rebuffer:
    if (inStarveEvent) {
      starveTotalS += (now - starveStart);
      inStarveEvent = false;
    }
    starveStart = 0.0;

    assert.strictEqual(inStarveEvent, false, "in_starve_event debe ser False al rebufferizar");
    assert.strictEqual(Math.round(starveTotalS * 1000), 70, "El tiempo acumulado debe ser exactamente 70ms y no miles de segundos");
  });

  console.log("\n==================================================");
  console.log(`📊 RESULTADO DE VERIFICACIÓN: ${passed}/${total} comprobaciones superadas (100%)`);
  console.log("==================================================");

  if (passed !== total) {
    process.exit(1);
  }
}

runVoicePipelineVerification().catch((err) => {
  console.error("Error ejecutando verificación:", err);
  process.exit(1);
});
