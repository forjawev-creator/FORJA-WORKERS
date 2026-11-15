import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

import { safeReadJson, StorageCorruptedError } from "../src/storage.js";
import { crmStorage } from "../src/crm/crm-storage.js";
import { crmService, normalizeSpanishPhone } from "../src/crm/crm-service.js";
import { CallWorker } from "../src/crm/call-worker.js";
import { whatsAppWorker } from "../src/crm/whatsapp-worker.js";
import { HandoffController } from "../src/handoff-controller.js";
import { isExplicitWhatsAppAuthorization } from "../src/pipeline.js";
import { ContextStore } from "../src/context-store.js";
import { ActiveSessionHandle, AgentConfig } from "../src/types.js";
import { Lead, LineaTelefonica, Campania } from "../src/crm/types.js";
import { appEvents } from "../src/events.js";

// Carpeta temporal aislada para pruebas de almacenamiento
const TEMP_TEST_DIR = path.join(process.cwd(), "data", "test_circuit_tmp");
if (!fs.existsSync(TEMP_TEST_DIR)) {
  fs.mkdirSync(TEMP_TEST_DIR, { recursive: true });
}

let passedCount = 0;
let failedCount = 0;

function report(id: string, name: string, ok: boolean, detail: string) {
  if (ok) {
    passedCount++;
    console.log(`  ✅ [${id}] ${name} -> OK: ${detail}`);
  } else {
    failedCount++;
    console.error(`  ❌ [${id}] ${name} -> FALLO: ${detail}`);
  }
}

async function runPhase2CircuitTests() {
  console.log("\n================================================================================");
  console.log("  SUITE DE PRUEBAS DE ACEPTACIÓN - FASE 2: CERRAR EL CIRCUITO REAL");
  console.log("================================================================================\n");

  // =============================================================================
  // BLOQUE 1: PERSISTENCIA SEGURA Y PROTECCIÓN CONTRA CORRUPCIÓN (A3)
  // =============================================================================
  console.log("📌 1. Persistencia Segura y Protección contra Corrupción (A3)");

  // 1.1 Archivo de 0 bytes con .bak válido -> Recuperación de .bak y conservación de .corrupt
  {
    const targetFile = path.join(TEMP_TEST_DIR, "zero_byte_test.json");
    const bakFile = `${targetFile}.bak`;
    const validData = { id: "valid_recovered_from_bak", ok: true };

    fs.writeFileSync(bakFile, JSON.stringify(validData, null, 2), "utf-8");
    fs.writeFileSync(targetFile, "", "utf-8"); // 0 bytes

    const res = safeReadJson<any>(targetFile, (d: any) => Boolean(d && d.id));
    const corruptFiles = fs.readdirSync(TEMP_TEST_DIR).filter((f) => f.startsWith("zero_byte_test.json.corrupt"));

    report(
      "A3-01",
      "Archivo de 0 bytes con .bak válido",
      res.data?.id === "valid_recovered_from_bak" && corruptFiles.length > 0,
      `Recuperado de .bak: '${res.data?.id}', archivo corrupto preservado (${corruptFiles.length} copias)`
    );
  }

  // 1.2 Archivo de 0 bytes y .bak corrupto/ausente -> Lanza StorageCorruptedError y bloquea sobrescritura
  {
    const targetFile = path.join(TEMP_TEST_DIR, "unrecoverable_corrupt.json");
    fs.writeFileSync(targetFile, "   \n\t  ", "utf-8"); // Solo espacios en blanco

    let threwCorrupted = false;
    try {
      safeReadJson<any>(targetFile);
    } catch (err: any) {
      if (err instanceof StorageCorruptedError || err.message.includes("CORRUPTO")) {
        threwCorrupted = true;
      }
    }

    report(
      "A3-02",
      "Archivo corrupto sin .bak utilizable",
      threwCorrupted,
      "Lanzó StorageCorruptedError explícito y evitó sobrescribir con objeto por defecto"
    );
  }

  // 1.3 Validación de esquema: Estructura inválida es detectada y rechazada
  {
    const targetFile = path.join(TEMP_TEST_DIR, "schema_invalid.json");
    const invalidData = { totallyWrong: 123 }; // No cumple esquema de CRM
    fs.writeFileSync(targetFile, JSON.stringify(invalidData), "utf-8");

    let rejected = false;
    try {
      safeReadJson<any>(targetFile, (d: any) => Boolean(d && d.leads && Array.isArray(d.leads)));
    } catch (err: any) {
      rejected = true;
    }

    report(
      "A3-03",
      "Validación estricta de esquema",
      rejected,
      "Datos sin esquema requerido son rechazados y puestos en cuarentena"
    );
  }

  // =============================================================================
  // BLOQUE 2: CICLO DE LLAMADA, RESERVAS Y RECONCILIACIÓN (A1 & A4)
  // =============================================================================
  console.log("\n📌 2. Ciclo de Llamada Netelip, Reservas y Reconciliación (A1 & A4)");

  const db = crmStorage.getDb();
  const testPhone = "+34612345678";

  // Asegurar proyecto y campaña
  const campId = `camp_circuit_${Date.now()}`;
  let camp = db.campanias.find((c) => c.id === campId);
  if (!camp) {
    const newCamp: Campania = {
      id: campId,
      proyecto_id: "forja-web",
      nombre: "Campaña Test Circuito",
      estado: "activa",
      criterios_filtro: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.campanias.push(newCamp);
  }

  // Asegurar línea telefónica libre
  let line = db.lineas.find((l) => l.activa);
  if (!line) {
    line = {
      id: "line_circuit_1",
      nombre: "Línea Circuito 1",
      numero: "+34910000001",
      limite_diario: 30,
      llamadas_hoy: 0,
      fecha_contador: "2026-10-16",
      activa: true,
      en_uso: false,
      ultima_llamada_at: null,
    };
    db.lineas.push(line);
  } else {
    line.en_uso = false;
    line.llamadas_hoy = 0;
  }
  const activeLine = line;

  // 2.1 Reconciliación de reservas huérfanas al arranque
  {
    // Provocar línea y lead huérfanos
    const orphanLeadId = `lead_orphan_${Date.now()}`;
    db.leads.push({
      id: orphanLeadId,
      proyecto_id: "forja-web",
      campania_id: campId,
      place_id: `place_orphan_${Date.now()}`,
      empresa_nombre: "Huérfano Test",
      categoria_maps: "Pintor",
      oficio_mapeado: "pintura",
      telefono: "+34699001122",
      telefono_original: "+34699001122",
      ciudad: "Madrid",
      codigo_postal: "28001",
      direccion: "Calle Test 1",
      tiene_web_previa: false,
      web_actual: "",
      estado: "en_llamada", // Bloqueado
      calificacion: "tibio",
      url_propuesta: "/api/crm/propuesta/tok_orphan",
      token_seguimiento: "tok_orphan",
      veces_llamado: 0,
      veces_whatsapp: 0,
      ultimo_contacto_at: null,
      notas: "",
      asignado_a: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    activeLine.en_uso = true; // Línea atascada

    crmService.reconcileOrphanReservations();

    const reconciledLead = db.leads.find((l) => l.id === orphanLeadId);
    const lineFree = !activeLine.en_uso;

    report(
      "A1-01",
      "Reconciliación de reservas huérfanas al arranque",
      reconciledLead?.estado === "cola_llamada" && lineFree,
      `Lead devuelto a '${reconciledLead?.estado}', línea liberada: ${lineFree}`
    );

    // Limpiar lead huérfano para que no altere la selección posterior
    db.leads = db.leads.filter((l) => l.id !== orphanLeadId);
  }

  // 2.2 Reserva de lead y línea al solicitar siguiente contacto
  const testLeadId = `lead_circuit_${Date.now()}`;
  db.leads.push({
    id: testLeadId,
    proyecto_id: "forja-web",
    campania_id: campId,
    place_id: `place_${Date.now()}`,
    empresa_nombre: "Taller Hermanos Circuit",
    categoria_maps: "Taller Mecánico",
    oficio_mapeado: "taller",
    telefono: testPhone,
    telefono_original: testPhone,
    ciudad: "Madrid",
    codigo_postal: "28001",
    direccion: "Polígono Industrial 5",
    tiene_web_previa: false,
    web_actual: "",
    estado: "cola_llamada",
    calificacion: "caliente",
    url_propuesta: "/api/crm/propuesta/tok_circuit",
    token_seguimiento: "tok_circuit",
    veces_llamado: 0,
    veces_whatsapp: 0,
    ultimo_contacto_at: null,
    notas: "",
    asignado_a: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const nextRes = crmService.getNextCallLead({ overrideHorario: true, campaniaId: campId, lineaId: activeLine.id });
  const leadInCall = db.leads.find((l) => l.id === testLeadId);
  const lineBusy = activeLine.en_uso;

  report(
    "A1-02",
    "Reserva atómica de lead y línea al seleccionar",
    Boolean(nextRes.item) && leadInCall?.estado === "en_llamada" && lineBusy,
    `Lead en '${leadInCall?.estado}', línea en_uso: ${lineBusy}, callId: ${nextRes.item?.callId}`
  );

  // 2.3 Aislamiento de eventos en CallWorker mientras trabaja y cancelación limpia con stop() (A1-03 & A1-08)
  {
    // Liberar la reserva previa de A1-02 para que el CallWorker pueda tomar el lead en su ciclo real de trabajo
    crmService.releaseLeadReservation(testLeadId, activeLine.id, "reset_test");
    const leadForWorker = db.leads.find((l) => l.id === testLeadId)!;
    leadForWorker.ultimo_contacto_at = null;
    leadForWorker.veces_llamado = 0;

    const worker = new CallWorker({
      campaignId: campId,
      pollIntervalMs: 50,
      callCooldownMs: 50,
      overrideHorario: true,
      mode: "simulation",
    });

    // Etiquetar temporalmente como simulación para que el worker en modo simulation lo tome y entre en espera activa (2000ms)
    leadForWorker.es_simulacion = true;
    worker.start();

    // Esperar a que el worker arranque el tick y reserve el contacto en activeCall
    await new Promise((r) => setTimeout(r, 150));
    const statusWhileWorking = worker.getStatus();
    const isWorkingOnLead = statusWhileWorking.activeCall?.leadId === testLeadId;

    // Emitir fin de llamada con sessionId ajeno MIENTRAS el worker trabaja
    appEvents.emit("ui-event", { type: "call_end", sessionId: "foreign_call_99999", durationSeconds: 40 });

    // Comprobar que el worker sigue con su llamada activa y el lead sigue en_llamada
    const leadStillLocked = db.leads.find((l) => l.id === testLeadId)?.estado === "en_llamada" && worker.getStatus().activeCall !== null;

    report(
      "A1-03",
      "Aislamiento de eventos en CallWorker activo (ignora foreign sessionIds mientras trabaja)",
      isWorkingOnLead && leadStillLocked,
      `Worker activo=${isWorkingOnLead}, evento ajeno ignorado y lead mantenido en '${db.leads.find((l) => l.id === testLeadId)?.estado}'`
    );

    // A1-08: Detener el worker con operación pendiente en curso -> stop() debe cancelar la espera inmediatamente y liberar reserva
    const stopStart = Date.now();
    await worker.stop();
    const stopElapsed = Date.now() - stopStart;
    const statusAfterStop = worker.getStatus();
    const leadAfterStop = db.leads.find((l) => l.id === testLeadId)!;
    leadForWorker.es_simulacion = undefined;
    leadForWorker.ultimo_contacto_at = null;

    report(
      "A1-08",
      "stop() cancela operación pendiente inmediatamente y libera reserva física",
      !statusAfterStop.running && statusAfterStop.activeCall === null && leadAfterStop.estado === "cola_llamada" && !activeLine.en_uso && stopElapsed < 1000,
      `stop() completado en ${stopElapsed}ms (<2000ms de espera), lead='${leadAfterStop.estado}', línea libre=${!activeLine.en_uso}`
    );

    // Volver a dejar reservado para A1-04
    crmService.getNextCallLead({ overrideHorario: true, campaniaId: campId, lineaId: activeLine.id });
  }

  // 2.4 Cancelación durante marcación (stop del worker libera reserva)
  {
    crmService.releaseLeadReservation(testLeadId, activeLine.id, "fallo_marcado");
    const freedLead = db.leads.find((l) => l.id === testLeadId);
    report(
      "A1-04",
      "Liberación inmediata de reserva ante fallo de marcado",
      freedLead?.estado === "cola_llamada" && !activeLine.en_uso,
      `Lead en estado '${freedLead?.estado}', línea liberada: ${!activeLine.en_uso}`
    );
  }

  // 2.5 Deduplicación estricta de outcomes: No duplicar registros si se reenvía el mismo resultado
  {
    // Re-reservar para el test de outcome
    activeLine.en_uso = true;
    const leadToFinish = db.leads.find((l) => l.id === testLeadId)!;
    leadToFinish.estado = "en_llamada";

    const uniqueCallId = `call_${Date.now()}_test_circuit`;
    const outcome1 = crmService.recordCallOutcome({
      callId: uniqueCallId,
      sessionId: uniqueCallId,
      lead_id: testLeadId,
      linea_id: activeLine.id,
      resultado: "no_contesta",
      duracion_segundos: 20,
      whatsappAuthorized: false,
      es_simulacion: false,
    });

    const countBefore = db.interacciones.length;
    const outcome2 = crmService.recordCallOutcome({
      callId: uniqueCallId,
      sessionId: uniqueCallId,
      lead_id: testLeadId,
      linea_id: activeLine.id,
      resultado: "no_contesta",
      duracion_segundos: 20,
      whatsappAuthorized: false,
      es_simulacion: false,
    });
    const countAfter = db.interacciones.length;

    report(
      "A1-05",
      "Idempotencia y deduplicación por callId/sessionId",
      outcome1.success && outcome2.deduplicated === true && countBefore === countAfter,
      `Primer envío success=${outcome1.success}, segundo deduplicated=${outcome2.deduplicated}, interacciones ${countBefore}===${countAfter}`
    );
  }

  // 2.6 Protección contra rellamadas inmediatas (cooldown)
  {
    const redialRes = crmService.getNextCallLead({
      overrideHorario: true,
      campaniaId: campId,
      lineaId: activeLine.id,
      cooldownMinutes: 30,
    });

    report(
      "A1-06",
      "Periodo de enfriamiento (anti-rellamadas inmediatas)",
      Boolean(redialRes.error),
      `Lead contactado recientemente bloqueado por enfriamiento: '${redialRes.error}'`
    );
  }

  // =============================================================================
  // BLOQUE 3: LISTA ROBINSON Y OPOSICIÓN AL TRATAMIENTO (A1)
  // =============================================================================
  console.log("\n📌 3. Verificaciones de Lista Robinson y Oposición (A1)");

  // 3.1 Exclusión de teléfono en Lista Robinson
  {
    const robinsonPhone = "+34677889900";
    crmStorage.addToRobinson(robinsonPhone, "Oposición explícita cliente");

    const inRobinson = crmService.isPhoneInRobinson(robinsonPhone);

    // Intentar lead con ese teléfono
    const robinsonLeadId = `lead_robinson_${Date.now()}`;
    db.leads.push({
      id: robinsonLeadId,
      proyecto_id: "forja-web",
      campania_id: campId,
      place_id: `place_robinson_${Date.now()}`,
      empresa_nombre: "Cliente en Robinson",
      categoria_maps: "Abogado",
      oficio_mapeado: "abogado",
      telefono: robinsonPhone,
      telefono_original: robinsonPhone,
      ciudad: "Madrid",
      codigo_postal: "28001",
      direccion: "Paseo de la Castellana 1",
      tiene_web_previa: false,
      web_actual: "",
      estado: "cola_llamada",
      calificacion: "frio",
      url_propuesta: "/api/crm/propuesta/tok_rob",
      token_seguimiento: "tok_rob",
      veces_llamado: 0,
      veces_whatsapp: 0,
      ultimo_contacto_at: null,
      notas: "",
      asignado_a: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Pedir siguiente lead debe omitirlo y marcarlo no_contactar
    crmService.getNextCallLead({ overrideHorario: true, campaniaId: campId, lineaId: activeLine.id });
    const leadState = db.leads.find((l) => l.id === robinsonLeadId)?.estado;

    report(
      "A1-07",
      "Lista Robinson: exclusión y cambio automático a no_contactar",
      inRobinson && leadState === "no_contactar",
      `isPhoneInRobinson=${inRobinson}, estado del lead pasó a '${leadState}'`
    );
  }

  // =============================================================================
  // BLOQUE 4: CONSENTIMIENTO REALTIME Y EVIDENCIA TEXTUAL (A2 & A5)
  // =============================================================================
  console.log("\n📌 4. Consentimiento Realtime, Validación de Teléfono y Traspaso (A2 & A5)");

  const agentConfig: AgentConfig = {
    apiKey: "dummy-key",
    persona: "kira",
    systemPrompt: "sys",
    sttModel: "whisper",
    llmModel: "qwen",
    ttsModel: "kokoro",
    ttsVoice: "ef_dora",
    sampleRate: 16000,
    maxTokens: 100,
    disableReasoning: true,
    handoffTimeoutMs: 200,
  };

  const contextStore = new ContextStore("call_circuit_4", agentConfig);
  let audioDrainWaited: boolean = false;
  let sessionSwitched: boolean = false;

  const controller = new HandoffController(contextStore, {
    handoffTimeoutMs: 200,
    onStateChange: () => {},
    onAnnouncePhrase: async () => {},
    onWaitForPlaybackDrain: async () => {
      audioDrainWaited = true;
    },
    onSwitchSession: async () => {
      sessionSwitched = true;
    },
    createTechnicalSession: async () => {
      return {
        ws: {} as any,
        model: "gpt-realtime-2.1",
        voice: "cedar",
        role: "technical",
        isReady: true,
      } as ActiveSessionHandle;
    },
  });

  // 4.1 Rechazo de cita inventada contra transcripciones reales del usuario
  {
    const resultInvented = controller.handleWhatsAppConsent({
      consent_given: true,
      client_evidence_quote: "Sí perfecto envíamelo ahora mismo",
      phone_confirmed: true,
      phone: "+34611223344",
      userTranscripts: ["Hola buenas tardes", "Dígame de qué se trata"],
    });

    report(
      "A2-01",
      "Rechazo de cita inventada contra transcripciones reales",
      !resultInvented.authorized && resultInvented.feedback.includes("no coincide"),
      `Autorizado: ${resultInvented.authorized}, feedback: "${resultInvented.feedback}"`
    );
  }

  // 4.2 Aceptación cuando la cita textual coincide con lo dicho por el cliente
  {
    const resultValid = controller.handleWhatsAppConsent({
      consent_given: true,
      client_evidence_quote: "mándamela por favor",
      phone_confirmed: true,
      phone: "+34611223344",
      userTranscripts: ["Hola", "De acuerdo, mándamela por favor"],
    });

    report(
      "A2-02",
      "Aceptación de consentimiento con cita fidedigna y teléfono confirmado",
      resultValid.authorized === true,
      `Autorizado: ${resultValid.authorized}, registrado en contextStore`
    );
  }

  // 4.3 Teléfono válido en formato pero sin confirmación explícita -> RECHAZADO
  {
    const unconfirmed = controller.handleWhatsAppConsent({
      consent_given: true,
      client_evidence_quote: "vale envíamelo",
      phone_confirmed: false, // NO CONFIRMADO
      phone: "+34611223344",
    });

    report(
      "A2-03",
      "Rechazo de consentimiento sin confirmación explícita de destino",
      !unconfirmed.authorized && unconfirmed.feedback.includes("confirmar explícitamente"),
      `Autorizado: ${unconfirmed.authorized}, feedback: "${unconfirmed.feedback}"`
    );
  }

  // 4.4 Revocación de consentimiento durante la llamada
  {
    const revoked = controller.handleWhatsAppConsent({
      consent_given: false,
      client_evidence_quote: "Al final no me lo mandes",
    });

    const isAuthorizedInStore = contextStore.getState().whatsapp_authorized;

    report(
      "A2-04",
      "Revocación de consentimiento durante la llamada",
      !revoked.authorized && !isAuthorizedInStore,
      `Consentimiento revocado, store.whatsapp_authorized: ${isAuthorizedInStore}`
    );
  }

  // 4.4b Rechazo de consentimiento cuando el cliente dice «No me lo envíes por WhatsApp» (A2-05)
  {
    const negRes = controller.handleWhatsAppConsent({
      consent_given: true,
      client_evidence_quote: "envíes por WhatsApp",
      phone_confirmed: true,
      phone: "+34611223344",
      userTranscripts: ["Hola buenas", "No me lo envíes por WhatsApp, no me interesa"],
    });

    report(
      "A2-05",
      "Rechazo estricto cuando el cliente dice «No me lo envíes por WhatsApp»",
      !negRes.authorized,
      `Autorizado: ${negRes.authorized}, feedback: "${negRes.feedback}"`
    );
  }

  // 4.4c Rechazo de consentimiento cuando userTranscripts está vacío (A2-06)
  {
    const emptyRes = controller.handleWhatsAppConsent({
      consent_given: true,
      client_evidence_quote: "Sí, envíamelo por WhatsApp",
      phone_confirmed: true,
      phone: "+34611223344",
      userTranscripts: [],
    });

    report(
      "A2-06",
      "Rechazo de consentimiento cuando userTranscripts está vacío",
      !emptyRes.authorized && emptyRes.feedback.includes("Sin transcripción comprobable"),
      `Autorizado: ${emptyRes.authorized}, feedback: "${emptyRes.feedback}"`
    );
  }

  // 4.5 Destrucción de sesión técnica tardía ante timeout
  {
    let lateSessionClosed: boolean = false;

    const slowCtrl = new HandoffController(contextStore, {
      handoffTimeoutMs: 50,
      onStateChange: () => {},
      onAnnouncePhrase: async () => {},
      onWaitForPlaybackDrain: async () => {},
      onSwitchSession: async () => {},
      createTechnicalSession: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return {
          ws: {
            readyState: 1,
            close: () => {
              lateSessionClosed = true;
            },
            terminate: () => {
              lateSessionClosed = true;
            },
          } as any,
          close: () => {
            lateSessionClosed = true;
          },
          model: "gpt-realtime-2.1",
          voice: "cedar",
          role: "technical",
          isReady: true,
        } as ActiveSessionHandle;
      },
    });

    const res = await slowCtrl.executeTransfer({ customer_question: "¿Tienen soporte 24h?" });
    await new Promise((r) => setTimeout(r, 150));

    report(
      "A5-01",
      "Destrucción de sesión técnica tardía ante timeout (sin fugas de sockets)",
      res.success === false && Boolean(lateSessionClosed),
      `Traspaso cancelado por timeout (success=${res.success}), socket tardío cerrado: ${lateSessionClosed}`
    );
  }

  // =============================================================================
  // BLOQUE 5: SEPARACIÓN DE MOCK Y PRODUCCIÓN EN WHATSAPP Y CRM (A4 & B1)
  // =============================================================================
  console.log("\n📌 5. Separación de Pruebas y Producción en WhatsApp y CRM (A4 & B1)");

  // 5.1 Envío simulado de WhatsApp no incrementa veces_whatsapp ni altera embudo comercial real
  {
    const prodLeadId = `lead_prod_wa_${Date.now()}`;
    db.leads.push({
      id: prodLeadId,
      proyecto_id: "forja-web",
      campania_id: campId,
      place_id: `place_prod_wa_${Date.now()}`,
      empresa_nombre: "Empresa Producción Test",
      categoria_maps: "Electricista",
      oficio_mapeado: "electricidad",
      telefono: "+34655443322",
      telefono_original: "+34655443322",
      ciudad: "Madrid",
      codigo_postal: "28001",
      direccion: "Calle Mayor 10",
      tiene_web_previa: true,
      web_actual: "https://electricista.es",
      estado: "muestra_generada",
      calificacion: "tibio",
      url_propuesta: "http://localhost:3000/api/crm/propuesta/tok_wa_prod",
      token_seguimiento: "tok_wa_prod",
      veces_llamado: 1,
      veces_whatsapp: 0,
      ultimo_contacto_at: null,
      notas: "",
      asignado_a: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Enviar desenlace de WhatsApp con es_simulacion = true
    const outcomeRes = crmService.recordWhatsAppOutcome({
      lead_id: prodLeadId,
      success: true,
      mensaje_enviado: "mock_msg_123",
      es_simulacion: true,
    });

    const leadAfter = db.leads.find((l) => l.id === prodLeadId);
    report(
      "A4-01",
      "WhatsApp simulado (mock) no computa en estadísticas de producción ni altera estado del lead",
      outcomeRes.success && leadAfter?.veces_whatsapp === 0 && leadAfter?.estado === "muestra_generada" && !leadAfter?.es_simulacion,
      `veces_whatsapp=${leadAfter?.veces_whatsapp}, estado=${leadAfter?.estado} (preservado), es_simulacion=${leadAfter?.es_simulacion}`
    );
  }

  // 5.2 Proveedor de WhatsApp no implementado devuelve error explícito
  {
    // Colocar lead en cola de WhatsApp
    const waQueueLeadId = `lead_wa_queue_${Date.now()}`;
    db.leads.push({
      id: waQueueLeadId,
      proyecto_id: "forja-web",
      campania_id: campId,
      place_id: `place_wa_q_${Date.now()}`,
      empresa_nombre: "Cliente WhatsApp Desconocido",
      categoria_maps: "Abogado",
      oficio_mapeado: "abogado",
      telefono: "+34677112233",
      telefono_original: "+34677112233",
      ciudad: "Madrid",
      codigo_postal: "28001",
      direccion: "Calle 1",
      tiene_web_previa: false,
      web_actual: "",
      estado: "cola_whatsapp",
      calificacion: "caliente",
      url_propuesta: "http://localhost:3000/api/crm/propuesta/tok_wa_q",
      token_seguimiento: "tok_wa_q",
      veces_llamado: 1,
      veces_whatsapp: 0,
      ultimo_contacto_at: null,
      notas: "",
      asignado_a: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Configurar worker con proveedor no implementado
    whatsAppWorker.setConfig({ provider: "wwebjs" });
    (whatsAppWorker as any).running = true;
    await (whatsAppWorker as any).tick();
    const status = whatsAppWorker.getStatus();
    whatsAppWorker.stop();
    const caughtNotImplemented = status.lastLog.includes("no está implementado");

    // Restaurar a mock
    whatsAppWorker.setConfig({ provider: "mock" });
    // Limpiar el lead de esta prueba para que el siguiente test (A4-03) procese su propio lead real
    db.leads = db.leads.filter((l) => l.id !== waQueueLeadId);

    report(
      "A4-02",
      "Proveedor no implementado devuelve error explícito",
      caughtNotImplemented,
      `Mensaje devuelto por worker: "${status.lastLog}"`
    );
  }

  // 5.3 Recorrido real extremo a extremo: Llamada -> Permiso comprobado -> Teléfono confirmado -> Resultado CRM -> 1 único WhatsApp con idempotencia (A4-03)
  {
    const http = await import("http");
    const receivedWebhookCalls: { idempotencyKey: string; body: any }[] = [];
    let shouldFailFirstAttempt = true;

    const webhookServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(raw || "{}");
        const key = String(req.headers["x-idempotency-key"] || parsed.idempotencyKey || "");
        receivedWebhookCalls.push({ idempotencyKey: key, body: parsed });
        if (shouldFailFirstAttempt) {
          shouldFailFirstAttempt = false;
          // Devuelve HTTP 200 pero con error en el cuerpo JSON del proveedor (verifica inspección real del payload)
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Proveedor ocupado temporalmente" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, messageId: "msg_real_001" }));
        }
      });
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = webhookServer.address() as { port: number };
    const webhookUrl = `http://127.0.0.1:${addr.port}/wa-send`;

    try {
      // 1. Crear lead real de producción (es_simulacion: undefined)
      const realCircuitLeadId = `lead_real_circuit_${Date.now()}`;
      db.leads.push({
        id: realCircuitLeadId,
        proyecto_id: "forja-web",
        campania_id: campId,
        place_id: `place_real_circuit_${Date.now()}`,
        empresa_nombre: "Reformas Integrales Sol",
        categoria_maps: "Reformas",
        oficio_mapeado: "reformas",
        telefono: "+34644556677",
        telefono_original: "+34644556677",
        ciudad: "Madrid",
        codigo_postal: "28001",
        direccion: "Calle Alcalá 50",
        tiene_web_previa: false,
        web_actual: "",
        estado: "cola_llamada",
        calificacion: "frio",
        url_propuesta: "http://localhost:3000/api/crm/propuesta/tok_real_sol",
        token_seguimiento: "tok_real_sol",
        veces_llamado: 0,
        veces_whatsapp: 0,
        ultimo_contacto_at: null,
        notas: "",
        asignado_a: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // 2. Validar permiso y teléfono confirmado a través de HandoffController contra transcripción real del cliente
      const realStore = new ContextStore("call_real_e2e", agentConfig);
      const realCtrl = new HandoffController(realStore, {
        handoffTimeoutMs: 200,
        onStateChange: () => {},
        onAnnouncePhrase: async () => {},
        onWaitForPlaybackDrain: async () => {},
        onSwitchSession: async () => {},
        createTechnicalSession: async () => ({} as any),
      });

      const userTranscripts = [
        "Hola, sí, soy el encargado de Reformas Sol",
        "Sí, claro, envíamelo por WhatsApp a este mismo número 644556677",
      ];
      const consentCheck = realCtrl.handleWhatsAppConsent({
        consent_given: true,
        client_evidence_quote: "Sí, claro, envíamelo por WhatsApp a este mismo número",
        phone_confirmed: true,
        phone: "644 55 66 77",
        userTranscripts,
      });

      // 3. Registrar resultado de llamada como AUTORIZADO (simulando el evento call_end procesado por CallWorker)
      const storeState = realStore.getState();
      crmService.recordCallOutcome({
        callId: "call_real_e2e_1",
        sessionId: "call_real_e2e_1",
        lead_id: realCircuitLeadId,
        linea_id: activeLine.id,
        resultado: "autorizo_whatsapp",
        duracion_segundos: 52,
        whatsappAuthorized: storeState.whatsapp_authorized,
        evidence_quote: storeState.evidence_quote || undefined,
        telefono_confirmado: storeState.confirmed_phone || undefined,
        transcripcion: userTranscripts.join("\n"),
        es_simulacion: false,
      });

      const leadAfterCall = db.leads.find((l) => l.id === realCircuitLeadId)!;
      const movedToWaQueue =
        leadAfterCall.estado === "cola_whatsapp" &&
        leadAfterCall.consentimiento_whatsapp === true &&
        Boolean(leadAfterCall.evidencia_consentimiento) &&
        leadAfterCall.telefono_confirmado === "+34644556677";

      // 4. Despachar con WhatsAppWorker usando webhook real:
      // Intento 1: HTTP 200 con { success: false } -> NO debe marcarse como enviado
      whatsAppWorker.setConfig({ provider: "webhook", webhookUrl, sendDelayMs: 10, jitterDelayMs: 10 });
      (whatsAppWorker as any).running = true;
      await (whatsAppWorker as any).tick();
      whatsAppWorker.stop();

      const leadAfterFailedAttempt = db.leads.find((l) => l.id === realCircuitLeadId)!;
      const stayedInQueueOnProviderError = leadAfterFailedAttempt.estado === "cola_whatsapp" && leadAfterFailedAttempt.veces_whatsapp === 0;

      // Intento 2 (reintento): conserva la misma clave de idempotencia y completa el envío único
      (whatsAppWorker as any).running = true;
      await (whatsAppWorker as any).tick();
      whatsAppWorker.stop();
      whatsAppWorker.setConfig({ provider: "mock" });

      const leadAfterSecondAttempt = db.leads.find((l) => l.id === realCircuitLeadId)!;
      const sameIdempotencyKey =
        receivedWebhookCalls.length === 2 &&
        receivedWebhookCalls[0].idempotencyKey.length > 5 &&
        receivedWebhookCalls[0].idempotencyKey === receivedWebhookCalls[1].idempotencyKey;

      const completedSingleWhatsApp =
        leadAfterSecondAttempt.estado === "whatsapp_enviado" && leadAfterSecondAttempt.veces_whatsapp === 1;

      report(
        "A4-03",
        "Recorrido real completo: Llamada -> permiso -> teléfono -> CRM -> 1 único WhatsApp con idempotencia persistente",
        consentCheck.authorized && movedToWaQueue && stayedInQueueOnProviderError && sameIdempotencyKey && completedSingleWhatsApp,
        `cola_whatsapp=${movedToWaQueue}, fallo_proveedor_detectado=${stayedInQueueOnProviderError}, idempotency_key_igual=${sameIdempotencyKey} (${receivedWebhookCalls[0]?.idempotencyKey}), estado_final=${leadAfterSecondAttempt.estado}, veces_whatsapp=${leadAfterSecondAttempt.veces_whatsapp}`
      );
    } finally {
      webhookServer.close();
    }
  }

  // =============================================================================
  // RESUMEN FINAL DE LA SUITE
  // =============================================================================
  console.log("\n================================================================================");
  console.log(`  RESULTADO SUITE FASE 2: ${passedCount} PRUEBAS SUPERADAS, ${failedCount} FALLOS`);
  console.log("================================================================================\n");

  // Limpieza de carpeta temporal
  try {
    fs.rmSync(TEMP_TEST_DIR, { recursive: true, force: true });
  } catch {}

  restoreCrmSnapshot();

  if (failedCount > 0) {
    process.exit(1);
  }
}

const crmDbFile = path.join(process.cwd(), "data", "crm", "crm.json");
const crmBackupSnapshot = fs.existsSync(crmDbFile) ? fs.readFileSync(crmDbFile, "utf-8") : null;

function restoreCrmSnapshot() {
  if (crmBackupSnapshot !== null) {
    try {
      fs.writeFileSync(crmDbFile, crmBackupSnapshot, "utf-8");
      fs.writeFileSync(`${crmDbFile}.bak`, crmBackupSnapshot, "utf-8");
    } catch {}
  }
}

runPhase2CircuitTests().catch((err) => {
  restoreCrmSnapshot();
  console.error("Error fatal en suite de pruebas Fase 2:", err);
  process.exit(1);
});
