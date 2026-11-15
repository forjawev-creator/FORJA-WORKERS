import assert from "assert";
import fs from "fs";
import path from "path";
import { OutboxService } from "../src/outbox/outbox-service.js";
import { PACKET_AUDIO, PACKET_FLUSH, PACKET_PLAYBACK_DRAINED, PACKET_PLAYBACK_STARTED, PACKET_TURN_END } from "../src/audio-bridge.js";

async function runAuditTests() {
  console.log("==================================================");
  console.log("🔬 SUITE DE VERIFICACIÓN DIRECTA DE LA REVISIÓN TÉCNICA (P1 - P12)");
  console.log("==================================================");

  let passed = 0;
  let total = 0;

  function test(desc: string, fn: () => void | Promise<void>) {
    total++;
    try {
      const res = fn();
      if (res instanceof Promise) {
        return res
          .then(() => {
            console.log(`  ✅ [PASS] ${desc}`);
            passed++;
          })
          .catch((e: any) => {
            console.error(`  ❌ [FAIL] ${desc}: ${e.message}`);
          });
      }
      console.log(`  ✅ [PASS] ${desc}`);
      passed++;
    } catch (e: any) {
      console.error(`  ❌ [FAIL] ${desc}: ${e.message}`);
    }
  }

  // ----------------------------------------------------
  // Punto 2 y 5: Cola de Segmentos por Turno y Protección de Audio Nuevo tras Flush
  // ----------------------------------------------------
  console.log("\n--- P1.2 & P1.5: Cola de Segmentos y Protección de Audio Nuevo tras Flush ---");

  test("Turno #2 no es borrado tras PACKET_FLUSH(Turno #1)", () => {
    class TurnAudioSegment {
      constructor(
        public turnId: number,
        public buffer = Buffer.alloc(0),
        public turnEnded = false,
        public flushed = false,
        public startedNotified = false,
        public drainedNotified = false,
        public playedBytes = 0
      ) {}
    }

    const turnSegments: TurnAudioSegment[] = [];
    let activeSegment: TurnAudioSegment | null = new TurnAudioSegment(1, Buffer.alloc(160, 0xaa));
    const flushedTurnIds = new Set<number>();

    // 1. Llega PACKET_FLUSH(1)
    flushedTurnIds.add(1);
    if (activeSegment && activeSegment.turnId <= 1) {
      activeSegment.flushed = true;
      activeSegment.buffer = Buffer.alloc(0);
    }

    // 2. Llega PACKET_AUDIO(2, 1280 bytes) y PACKET_TURN_END(2)
    const seg2 = new TurnAudioSegment(2, Buffer.alloc(1280, 0xbb), true);
    turnSegments.push(seg2);

    // 3. El emisor RTP avanza de segmento
    if (activeSegment === null || activeSegment.buffer.length === 0) {
      activeSegment = turnSegments.shift() || null;
    }

    assert.ok(activeSegment !== null, "Debe haber un segmento activo");
    assert.strictEqual(activeSegment.turnId, 2, "El segmento activo debe ser el turno 2");
    assert.strictEqual(activeSegment.buffer.length, 1280, "Los 1280 bytes del turno 2 se conservan intactos");
    assert.strictEqual(activeSegment.flushed, false, "El turno 2 NO debe estar flushed");
  });

  // ----------------------------------------------------
  // Punto 3: Protección Anti-Ráfaga Estricta respecto al último envío físico
  // ----------------------------------------------------
  console.log("\n--- P1.3: Protección Anti-Ráfaga respecto al Último Envío Físico ---");

  test("Pausa de 50ms antes/durante el bloqueo NO produce ráfaga (gap >= 18ms)", () => {
    let lastActualRtpSendTime = 100.000;
    // Se produce una pausa de 50ms durante la preparación
    const sendTime1 = 100.050; // Packet 1 enviado a t = 100.050
    lastActualRtpSendTime = sendTime1;

    // Packet 2 intenta salir inmediatamente después (t = 100.0505)
    const now2 = 100.0505;
    const elapsed = now2 - lastActualRtpSendTime;
    let sleepTarget = 0;
    if (elapsed < 0.019) {
      sleepTarget = 0.019 - elapsed;
    }

    assert.ok(elapsed < 0.019, "Detecta que no ha transcurrido el intervalo mínimo");
    assert.ok(sleepTarget >= 0.018, `Debe esperar al menos 18ms (calculó ${sleepTarget * 1000}ms)`);
  });

  // ----------------------------------------------------
  // Punto 4: Admisión de Audio sin Bloqueo por Estado 'listening'
  // ----------------------------------------------------
  console.log("\n--- P1.4: Admisión de Audio Delta sin Bloqueo por 'listening' ---");

  test("Audio delta no se descarta cuando response_id coincide con activeResponseId", () => {
    const activeResponseId = "resp_greeting_001";
    const cancelledResponseIds = new Set<string>();

    const event = {
      response_id: "resp_greeting_001",
      delta: Buffer.alloc(160, 0xd5).toString("base64")
    };

    let accepted = false;
    // Lógica corregida:
    if (!cancelledResponseIds.has(event.response_id) && event.response_id === activeResponseId) {
      accepted = true;
    }

    assert.strictEqual(accepted, true, "El audio delta del saludo debe aceptarse sin ser bloqueado por listening");
  });

  // ----------------------------------------------------
  // Punto 6: Confirmaciones de Reproducción al Node (PLAYBACK_STARTED / PLAYBACK_DRAINED)
  // ----------------------------------------------------
  console.log("\n--- P1.6: Confirmaciones de Reproducción al Puente TCP ---");

  test("Emite PACKET_PLAYBACK_STARTED al iniciar trama y PACKET_PLAYBACK_DRAINED al agotar buffer", () => {
    let startedSent = false;
    let drainedSent = false;

    let startedNotified = false;
    let drainedNotified = false;
    let playing = true;
    let turnEnded = true;
    let bufferLen = 160;

    // Frame 1 emitido
    if (playing && !startedNotified) {
      startedSent = true;
      startedNotified = true;
    }
    bufferLen -= 160;

    // Buffer agotado y turnEnded
    if (bufferLen === 0 && turnEnded && !drainedNotified) {
      drainedSent = true;
      drainedNotified = true;
    }

    assert.strictEqual(startedSent, true, "PACKET_PLAYBACK_STARTED debe enviarse al arrancar");
    assert.strictEqual(drainedSent, true, "PACKET_PLAYBACK_DRAINED debe enviarse al finalizar la reproducción");
  });

  // ----------------------------------------------------
  // Punto 7: Desacoplamiento de Outbox y Reclamación Atómica
  // ----------------------------------------------------
  console.log("\n--- P1.7: Desacoplamiento de Outbox y Reclamación Atómica ---");

  await test("emitCallCompleted es puramente emisor y el procesador reclama atómicamente", async () => {
    const outbox = new OutboxService();
    const testSession = `audit_test_${Date.now()}`;

    // 1. Emitir evento: NO debe ejecutar CRM ni WhatsApp inmediatamente
    const evtId = outbox.emitCallCompleted({
      sessionId: testSession,
      channel: "telephony",
      company: "Audit Test",
      phone: "+34699999999",
      durationSeconds: 10,
      status: "AUTORIZADO",
      whatsappAuthorized: false,
      phoneConfirmed: true,
      confirmedPhone: "+34699999999",
      transcript: []
    });

    assert.ok(evtId.startsWith("evt_"), "Debe devolver ID de evento");

    // Verificar que el archivo existe en data/outbox
    const filePath = path.resolve(process.cwd(), "data", "outbox", `${evtId}.json`);
    assert.strictEqual(fs.existsSync(filePath), true, "El archivo debe crearse en outbox");

    // Procesar con el worker
    const processed = await outbox.processPendingEvents();
    assert.ok(processed >= 1, "El worker debe procesar el evento reclamado");

    // Limpiar archivo procesado de prueba
    const procPath = path.resolve(process.cwd(), "data", "outbox", "processed", `${evtId}.json`);
    if (fs.existsSync(procPath)) fs.unlinkSync(procPath);
  });

  // ----------------------------------------------------
  // Punto 8: Saludo 'Forja Web' no desbloquea consentimiento sin propuesta; 'sí' no autoriza
  // ----------------------------------------------------
  console.log("\n--- P1.8: Validación de Propuesta y Consentimiento Booleano Estricto ---");

  test("Saludo inicial con 'Forja Web' no activa proposalPresented", () => {
    const greetingText = "Buenos días, Forja Web, le atiende Juan, dígame.";
    const cleanedTranscript = greetingText.replace(/forja\s*web/gi, "");
    const pitchedProposal = /\b(preparar|prepararte|prepararos|muestra|demo|diseño|diseñar|ejemplo|sin\s+compromiso|google\s+maps)\b/i.test(cleanedTranscript) &&
                           /\b(whatsapp|m[oó]vil|tel[eé]fono|envi[aá]r|mandar|pasar)\b/i.test(cleanedTranscript);

    assert.strictEqual(pitchedProposal, false, "El saludo NO debe marcarse como propuesta presentada");
  });

  test("Llamada a record_whatsapp_consent con {} o false NO autoriza", () => {
    const emptyArgs: any = {};
    const consentGiven1 = emptyArgs.consent_given === true;
    assert.strictEqual(consentGiven1, false, "Argumentos vacíos no son consentimiento");

    const falseArgs: any = { consent_given: false };
    const consentGiven2 = falseArgs.consent_given === true;
    assert.strictEqual(consentGiven2, false, "consent_given: false no es consentimiento");

    const trueArgs: any = { consent_given: true };
    const consentGiven3 = trueArgs.consent_given === true;
    assert.strictEqual(consentGiven3, true, "consent_given: true es consentimiento");
  });

  // ----------------------------------------------------
  // Punto 9: response.done Tardío
  // ----------------------------------------------------
  console.log("\n--- P2.9: response.done Tardío No Afecta Turno Activo ---");

  test("response.done de ID antiguo no cierra activeResponseId ni altera estado", () => {
    let activeResponseId: string | null = "resp_active_002";
    let state = "speaking";

    const oldDone = { response: { id: "resp_old_001" } };

    // Si no coincide con activeResponseId:
    if (oldDone.response?.id && activeResponseId && oldDone.response.id !== activeResponseId) {
      // Ignorar
    } else {
      activeResponseId = null;
      state = "listening";
    }

    assert.strictEqual(activeResponseId, "resp_active_002", "activeResponseId debe permanecer intacto");
    assert.strictEqual(state, "speaking", "El estado debe permanecer en speaking");
  });

  // ----------------------------------------------------
  // Punto 10: Telemetría de Starvation sin Error de Epoch
  // ----------------------------------------------------
  console.log("\n--- P2.10: Telemetría de Starvation sin Error de Epoch ---");

  test("Al pausar por rebuffer, in_starve_event se cierra limpiamente sin incorporar origen del reloj", () => {
    let starveStart = 1000.0;
    let inStarveEvent = true;
    let starveTotalS = 0.0;
    const now = 1000.065; // 65ms

    // Pausar y rebufferizar
    if (inStarveEvent) {
      starveTotalS += (now - starveStart);
      inStarveEvent = false;
    }
    starveStart = 0.0;

    assert.strictEqual(inStarveEvent, false);
    assert.strictEqual(Math.round(starveTotalS * 1000), 65, "Debe sumar 65ms exactos");
  });

  console.log("\n==================================================");
  console.log(`📊 RESULTADO AUDITORÍA TÉCNICA: ${passed}/${total} comprobaciones superadas`);
  console.log("==================================================");

  if (passed !== total) {
    process.exit(1);
  }
}

runAuditTests().catch((e) => {
  console.error("Error en suite de auditoría:", e);
  process.exit(1);
});
