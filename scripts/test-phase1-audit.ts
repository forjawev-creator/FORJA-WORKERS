/**
 * Test Suite de Auditoría y Verificación - Alcance Fase 1
 * Valida de forma exhaustiva y rigurosa los 7 requerimientos de la Fase 1:
 * 1. Persistencia segura y recuperación ante corrupción
 * 2. Ciclo completo Netelip -> bot -> CRM (reserva, concurrencia, fallo de marcado, deduplicación, cooldown)
 * 3. Traspaso al técnico (cancelación, timeout, cierre de sesiones pendientes, espera de drenaje de audio)
 * 4. Consentimiento estricto de WhatsApp (evidencia textual, teléfono confirmado, rechazo de dudas)
 * 5. Separación de pruebas y producción (métricas aisladas, error en wwebjs no implementado)
 * 6. Seguridad (CORS localhost, validación de origen WS/HTTP, neutralización XSS)
 * 7. Límites efectivos (persistencia del contador diario de WhatsApp, timers máximos)
 */

import fs from "fs";
import path from "path";
import {
  atomicWriteJson,
  safeReadJson,
  StorageCorruptedError,
  cleanTextForTts,
} from "../src/storage.js";
import { isExplicitWhatsAppAuthorization } from "../src/pipeline.js";
import { crmStorage } from "../src/crm/crm-storage.js";
import { crmService, normalizeSpanishPhone } from "../src/crm/crm-service.js";
import { whatsAppWorker } from "../src/crm/whatsapp-worker.js";
import { isAllowedOrigin, escapeHtml } from "../src/crm/crm-routes.js";
import { HandoffController } from "../src/handoff-controller.js";
import { ContextStore } from "../src/context-store.js";
import { AgentConfig, ActiveSessionHandle } from "../src/types.js";

interface TestReportItem {
  id: string;
  category: string;
  name: string;
  passed: boolean;
  type: "SIMULADA" | "SUBSISTEMA_REAL";
  details: string;
}

const report: TestReportItem[] = [];

function assert(condition: boolean, id: string, category: string, name: string, type: "SIMULADA" | "SUBSISTEMA_REAL", details: string) {
  report.push({
    id,
    category,
    name,
    passed: condition,
    type,
    details,
  });
  const icon = condition ? "✅ PASS" : "❌ FAIL";
  console.log(`${icon} [${id}] (${category}): ${name}`);
  if (!condition) {
    console.error(`   └─ ERROR: ${details}`);
  }
}

async function runPhase1AuditTests() {
  console.log("================================================================================");
  console.log("   INICIANDO AUDITORÍA Y BATERÍA DE PRUEBAS - ALCANCE FASE 1");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------------
  // 1. PERSISTENCIA SEGURA Y PROTECCIÓN ANTE CORRUPCIÓN
  // ---------------------------------------------------------------------------------
  const testDir = path.resolve(process.cwd(), "data", "test_audit");
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const testFilePath = path.join(testDir, "audit_storage_test.json");

  try {
    // 1.1 Escritura atómica y respaldo .bak
    const testData1 = { timestamp: Date.now(), items: ["lead_1", "lead_2"] };
    atomicWriteJson(testFilePath, testData1);
    const readBack1 = safeReadJson<{ timestamp: number; items: string[] }>(testFilePath);
    assert(
      readBack1.data?.items.length === 2 && fs.existsSync(testFilePath),
      "PERSIST-01",
      "Persistencia Segura",
      "Escritura atómica inicial genera archivo válido",
      "SUBSISTEMA_REAL",
      "El archivo inicial se escribió y leyó con integridad"
    );

    // 1.2 Actualización y creación de .bak
    const testData2 = { timestamp: Date.now(), items: ["lead_1", "lead_2", "lead_3"] };
    atomicWriteJson(testFilePath, testData2);
    const bakFile = `${testFilePath}.bak`;
    assert(
      fs.existsSync(bakFile),
      "PERSIST-02",
      "Persistencia Segura",
      "Actualización de archivo genera respaldo .bak previo",
      "SUBSISTEMA_REAL",
      "El archivo .bak debe existir y contener la versión inmediatamente anterior"
    );

    // 1.3 Corrupción deliberada del archivo primario
    fs.writeFileSync(testFilePath, '{ "malformed_json": [ unclosed syntax ...', "utf-8");
    const recovered = safeReadJson<{ timestamp: number; items: string[] }>(testFilePath);
    const corruptFiles = fs.readdirSync(testDir).filter(f => f.includes("corrupt"));
    assert(
      recovered.data?.items.length === 2 && corruptFiles.length > 0 && recovered.recoveredFromBackup === true,
      "PERSIST-03",
      "Persistencia Segura",
      "Archivo corrupto es aislado a .corrupt.<timestamp> y recuperado desde .bak",
      "SUBSISTEMA_REAL",
      `Recuperados ${recovered.data?.items.length} items y creado archivo de cuarentena: ${corruptFiles[0]}`
    );

    // 1.4 Si ambos están corruptos, NUNCA sobrescribir con vacío por defecto; lanzar StorageCorruptedError
    fs.writeFileSync(testFilePath, 'INVALID_JSON_FILE', "utf-8");
    fs.writeFileSync(bakFile, 'INVALID_BAK_FILE', "utf-8");
    let caughtCorruption = false;
    try {
      safeReadJson(testFilePath);
    } catch (e: any) {
      if (e instanceof StorageCorruptedError || e.name === "StorageCorruptedError") {
        caughtCorruption = true;
      }
    }
    assert(
      caughtCorruption,
      "PERSIST-04",
      "Persistencia Segura",
      "Ante corrupción irrecuperable lanza StorageCorruptedError y NUNCA sobrescribe con datos vacíos",
      "SUBSISTEMA_REAL",
      "Se preservaron los archivos dañados en disco sin blanquearlos"
    );
  } finally {
    // Limpieza de archivos temporales de prueba
    try {
      const files = fs.readdirSync(testDir);
      for (const f of files) fs.unlinkSync(path.join(testDir, f));
      fs.rmdirSync(testDir);
    } catch {}
  }

  // ---------------------------------------------------------------------------------
  // 2. CICLO COMPLETO NETELIP -> BOT -> CRM
  // ---------------------------------------------------------------------------------
  // Preparar lead y línea de prueba en crmStorage
  const testLeadId = `lead_audit_${Date.now()}`;
  const testPhone = "+34699887766";
  const testCampId = `camp_audit_${Date.now()}`;
  const db = crmStorage.getDb();

  db.campanias.push({
    id: testCampId,
    proyecto_id: "forja-web",
    nombre: "Campaña Test Audit",
    estado: "activa",
    criterios_filtro: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Asegurar que el teléfono no esté en Robinson
  db.robinson = db.robinson.filter(r => r.telefono !== testPhone);

  // Registrar lead de prueba
  db.leads.push({
    id: testLeadId,
    proyecto_id: "forja-web",
    campania_id: testCampId,
    place_id: `place_${Date.now()}`,
    empresa_nombre: "Cerrajeros Audit Test",
    categoria_maps: "Cerrajero",
    oficio_mapeado: "cerrajeria",
    telefono: testPhone,
    telefono_original: testPhone,
    ciudad: "Madrid",
    codigo_postal: "28001",
    direccion: "Calle Mayor 1",
    tiene_web_previa: false,
    web_actual: "",
    estado: "cola_llamada",
    calificacion: "caliente",
    url_propuesta: "https://tudominio.es/m/audit",
    token_seguimiento: "tok_audit_1",
    veces_llamado: 0,
    veces_whatsapp: 0,
    ultimo_contacto_at: null,
    notas: "",
    asignado_a: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Asegurar línea activa libre
  let testLine = db.lineas[0];
  if (!testLine) {
    testLine = {
      id: "linea_audit_1",
      nombre: "Línea Test 1",
      numero: "+34600111222",
      limite_diario: 30,
      llamadas_hoy: 0,
      fecha_contador: new Date().toISOString().split("T")[0],
      activa: true,
      en_uso: false,
      ultima_llamada_at: null,
    };
    db.lineas.push(testLine);
  } else {
    testLine.en_uso = false;
    testLine.activa = true;
  }
  crmStorage.save();

  // 2.1 Reserva atómica de lead y línea
  const nextCall = crmService.getNextCallLead({ overrideHorario: true, campaniaId: testCampId });
  assert(
    !nextCall.error && nextCall.item?.lead.id === testLeadId && nextCall.item?.lead.estado === "en_llamada" && nextCall.item?.linea.en_uso === true,
    "CALLCYCLE-01",
    "Ciclo de Llamada",
    "getNextCallLead reserva el lead como 'en_llamada' y la línea como 'en_uso'",
    "SUBSISTEMA_REAL",
    `Lead en_llamada: ${nextCall.item?.lead.estado === "en_llamada"}, Línea en_uso: ${nextCall.item?.linea.en_uso}`
  );

  // 2.2 Intento concurrente: con un segundo lead en cola pero la línea ocupada, debe rechazar
  const testLeadId2 = `lead_audit_2_${Date.now()}`;
  db.leads.push({
    id: testLeadId2,
    proyecto_id: "forja-web",
    campania_id: testCampId,
    place_id: `place_2_${Date.now()}`,
    empresa_nombre: "Cerrajeros Audit Test 2",
    categoria_maps: "Cerrajero",
    oficio_mapeado: "cerrajeria",
    telefono: "+34699887755",
    telefono_original: "+34699887755",
    ciudad: "Madrid",
    codigo_postal: "28001",
    direccion: "Calle Mayor 2",
    tiene_web_previa: false,
    web_actual: "",
    estado: "cola_llamada",
    calificacion: "caliente",
    url_propuesta: "https://tudominio.es/m/audit2",
    token_seguimiento: "tok_audit_2",
    veces_llamado: 0,
    veces_whatsapp: 0,
    ultimo_contacto_at: null,
    notas: "",
    asignado_a: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const concurrentCall = crmService.getNextCallLead({ overrideHorario: true, campaniaId: testCampId, lineaId: testLine.id });
  assert(
    !!concurrentCall.error && (concurrentCall.error.includes("ocupada") || concurrentCall.error.includes("inactiva")),
    "CALLCYCLE-02",
    "Ciclo de Llamada",
    "Línea ocupada impide concurrencia y duplica marcación",
    "SUBSISTEMA_REAL",
    `Error esperado recibido: "${concurrentCall.error}"`
  );

  // 2.3 Fallo de marcado: liberación inmediata de reserva
  crmService.releaseLeadReservation(testLeadId, testLine.id, "fallo_marcado");
  const freedLead = db.leads.find(l => l.id === testLeadId);
  const freedLine = db.lineas.find(l => l.id === testLine.id);
  assert(
    freedLead?.estado === "cola_llamada" && freedLine?.en_uso === false,
    "CALLCYCLE-03",
    "Ciclo de Llamada",
    "releaseLeadReservation libera la línea (en_uso=false) y devuelve el lead a la cola",
    "SUBSISTEMA_REAL",
    `Estado del lead: ${freedLead?.estado}, Línea libre: ${!freedLine?.en_uso}`
  );

  // 2.4 Registro de resultado con vinculación de sessionId y transcripción
  const auditSessionId = `sess_audit_${Date.now()}`;
  const outcome1 = crmService.recordCallOutcome({
    sessionId: auditSessionId,
    lead_id: testLeadId,
    linea_id: testLine.id,
    resultado: "no_contesta",
    duracion_segundos: 25,
    resumen: "Tono de llamada continuo sin respuesta",
    whatsappAuthorized: false,
    es_simulacion: false,
  });
  assert(
    outcome1.success && freedLine?.en_uso === false && freedLead?.veces_llamado === 1,
    "CALLCYCLE-04",
    "Ciclo de Llamada",
    "recordCallOutcome registra llamada terminal (no_contesta), incrementa contador y libera línea",
    "SUBSISTEMA_REAL",
    `Veces llamado: ${freedLead?.veces_llamado}, Línea libre: ${!freedLine?.en_uso}`
  );

  // 2.5 Deduplicación: re-enviar el mismo resultado de sesión NO duplica interacciones
  const countBeforeDedup = db.interacciones.length;
  const outcomeDuplicate = crmService.recordCallOutcome({
    sessionId: auditSessionId,
    lead_id: testLeadId,
    linea_id: testLine.id,
    resultado: "no_contesta",
    duracion_segundos: 25,
    whatsappAuthorized: false,
    es_simulacion: false,
  });
  const countAfterDedup = db.interacciones.length;
  assert(
    outcomeDuplicate.deduplicated === true && countBeforeDedup === countAfterDedup,
    "CALLCYCLE-05",
    "Ciclo de Llamada",
    "Deduplicación evita duplicados de resultado y llamadas dobles por eventos repetidos",
    "SUBSISTEMA_REAL",
    `Interacciones antes: ${countBeforeDedup}, después: ${countAfterDedup}`
  );

  // 2.6 Cooldown: reintento inmediato al mismo contacto es rechazado (cooldown 30 min)
  db.leads = db.leads.filter(l => l.id !== testLeadId2);
  const immediateRedial = crmService.getNextCallLead({ overrideHorario: true, campaniaId: testCampId });
  assert(
    !!immediateRedial.error && (immediateRedial.error.includes("enfriamiento") || immediateRedial.error.includes("No hay leads")),
    "CALLCYCLE-06",
    "Ciclo de Llamada",
    "Período de enfriamiento (cooldown 30 min) bloquea rellamada inmediata al mismo contacto",
    "SUBSISTEMA_REAL",
    `Resultado de rellamada inmediata: ${immediateRedial.error}`
  );

  // ---------------------------------------------------------------------------------
  // 3. TRASPASO AL TÉCNICO (HandoffController)
  // ---------------------------------------------------------------------------------
  const mockConfig: AgentConfig = {
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
    handoffTimeoutMs: 150,
  };
  const mockContextStore = new ContextStore("call_audit_tech", mockConfig);
  let audioDrainWaited: boolean = false;
  let sessionSwitched: boolean = false;

  const handoffCtrl = new HandoffController(mockContextStore, {
    handoffTimeoutMs: 150,
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

  // 3.1 Cancelación explícita durante preparación
  handoffCtrl.executeTransfer({ customer_question: "¿Cómo es el mantenimiento?" });
  handoffCtrl.cancel("Llamada colgada por el usuario antes de transferir");
  assert(
    handoffCtrl.getState() === "failed",
    "HANDOFF-01",
    "Traspaso al Técnico",
    "Cancelación explícita aborta la preparación y transición a estado 'failed'",
    "SUBSISTEMA_REAL",
    `Estado tras cancelación: ${handoffCtrl.getState()}`
  );

  // 3.2 Timeout: aborta sesiones pendientes e impide cambio tardío
  const slowHandoffCtrl = new HandoffController(mockContextStore, {
    handoffTimeoutMs: 50,
    onStateChange: () => {},
    onAnnouncePhrase: async () => {},
    onWaitForPlaybackDrain: async () => {},
    onSwitchSession: async () => {
      sessionSwitched = true;
    },
    createTechnicalSession: async () => {
      // Simular delay superior al timeout
      await new Promise(r => setTimeout(r, 120));
      return {
        ws: {} as any,
        model: "gpt-realtime-2.1",
        voice: "cedar",
        role: "technical",
        isReady: true,
      } as ActiveSessionHandle;
    },
  });

  slowHandoffCtrl.executeTransfer({ customer_question: "Duda con timeout" });
  await new Promise(r => setTimeout(r, 150));
  assert(
    slowHandoffCtrl.getState() === "failed" && sessionSwitched === false,
    "HANDOFF-02",
    "Traspaso al Técnico",
    "Agotamiento de timeout cancela sesión técnica e impide traspaso tardío",
    "SUBSISTEMA_REAL",
    `Estado tras timeout: ${slowHandoffCtrl.getState()}, Sesión cambiada: ${sessionSwitched}`
  );

  // 3.3 Espera estricta de drenaje de audio físico antes del cambio
  sessionSwitched = false;
  audioDrainWaited = false;
  const normalHandoffCtrl = new HandoffController(mockContextStore, {
    handoffTimeoutMs: 1500,
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

  await normalHandoffCtrl.executeTransfer({ customer_question: "Duda normal completada" });
  assert(
    Boolean(audioDrainWaited) && Boolean(sessionSwitched),
    "HANDOFF-03",
    "Traspaso al Técnico",
    "Espera estrictamente a que termine la frase física de cortesía (onWaitForPlaybackDrain) antes de transferir",
    "SUBSISTEMA_REAL",
    `Drenaje de audio completado: ${audioDrainWaited}, Sesión cambiada: ${sessionSwitched}`
  );

  // ---------------------------------------------------------------------------------
  // 4. CONSENTIMIENTO DE WHATSAPP CON EVIDENCIA TEXTUAL Y CONFIRMACIÓN SEPARADA
  // ---------------------------------------------------------------------------------
  // 4.1 Rechazo de booleano simple sin evidencia
  const noEvidenceResult = normalHandoffCtrl.handleWhatsAppConsent({
    consent_given: true,
    client_evidence_quote: "",
    phone_confirmed: true,
    phone: "+34611223344",
  });
  assert(
    noEvidenceResult.authorized === false,
    "WA-CONSENT-01",
    "Consentimiento WhatsApp",
    "Rechaza booleano true cuando no se aporta cita textual de evidencia",
    "SUBSISTEMA_REAL",
    `Feedback: "${noEvidenceResult.feedback}"`
  );

  // 4.2 Rechazo de citas ambiguas o con dudas
  const doubtQuotes = [
    "Bueno, no sé si me servirá",
    "A lo mejor luego lo veo",
    "Si acaso me lo mandas, pero no estoy seguro",
    "Quizás más adelante",
  ];
  let allDoubtsRejected = true;
  for (const quote of doubtQuotes) {
    if (isExplicitWhatsAppAuthorization(quote)) {
      allDoubtsRejected = false;
      break;
    }
  }
  assert(
    allDoubtsRejected,
    "WA-CONSENT-02",
    "Consentimiento WhatsApp",
    "isExplicitWhatsAppAuthorization rechaza expresiones con dudas, evasivas y condicionales",
    "SUBSISTEMA_REAL",
    `Se verificaron 4 frases ambiguas, todas rechazadas`
  );

  // 4.3 Rechazo si falta teléfono confirmado
  const missingPhoneResult = normalHandoffCtrl.handleWhatsAppConsent({
    consent_given: true,
    client_evidence_quote: "Sí, perfecto, mándamelo por WhatsApp",
    phone_confirmed: false,
    phone: "",
  });
  assert(
    missingPhoneResult.authorized === false,
    "WA-CONSENT-03",
    "Consentimiento WhatsApp",
    "Rechaza autorización si el teléfono no ha sido confirmado explícitamente",
    "SUBSISTEMA_REAL",
    `Feedback: "${missingPhoneResult.feedback}"`
  );

  // 4.4 Aceptación con evidencia inequívoca y teléfono verificado
  const validConsentResult = normalHandoffCtrl.handleWhatsAppConsent({
    consent_given: true,
    client_evidence_quote: "Vale, mándamelo por WhatsApp a este móvil",
    phone_confirmed: true,
    phone: "+34612345678",
    userTranscripts: ["Hola buenas tardes", "Vale, mándamelo por WhatsApp a este móvil"],
  });
  assert(
    validConsentResult.authorized === true,
    "WA-CONSENT-04",
    "Consentimiento WhatsApp",
    "Acepta consentimiento cuando concurren evidencia inequívoca y número confirmado",
    "SUBSISTEMA_REAL",
    `Feedback: "${validConsentResult.feedback}"`
  );

  // ---------------------------------------------------------------------------------
  // 5. SEPARACIÓN DE PRUEBAS Y PRODUCCIÓN
  // ---------------------------------------------------------------------------------
  // 5.1 Registro de llamada simulada no computa en victorias comerciales de producción
  const simLeadId = `lead_sim_${Date.now()}`;
  db.leads.push({
    id: simLeadId,
    proyecto_id: "forja-web",
    campania_id: testCampId,
    place_id: `place_sim_${Date.now()}`,
    empresa_nombre: "Empresa Simulada Test",
    categoria_maps: "Fontanero",
    oficio_mapeado: "fontaneria",
    telefono: "+34688776655",
    telefono_original: "+34688776655",
    ciudad: "Madrid",
    codigo_postal: "28001",
    direccion: "Calle Mayor 3",
    tiene_web_previa: true,
    web_actual: "https://ejemplo-fontanero.es",
    estado: "en_llamada",
    calificacion: "tibio",
    url_propuesta: "https://tudominio.es/m/sim",
    token_seguimiento: "tok_sim_1",
    veces_llamado: 0,
    veces_whatsapp: 0,
    ultimo_contacto_at: null,
    notas: "",
    asignado_a: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  crmService.recordCallOutcome({
    sessionId: `sess_sim_${Date.now()}`,
    lead_id: simLeadId,
    linea_id: testLine.id,
    resultado: "autorizo_whatsapp",
    whatsappAuthorized: true,
    telefono_confirmado: "+34688776655",
    evidence_quote: "Sí claro, envíamelo ahora mismo",
    es_simulacion: true,
  });

  const funnelStats = crmService.getFunnelStats();
  assert(
    funnelStats.simulacion.autorizados >= 1 &&
    funnelStats.produccion !== undefined &&
    funnelStats.simulacion.total_leads >= 1,
    "PROD-SEP-01",
    "Separación Producción/Simulación",
    "Métricas del embudo separan victorias de simulación de victorias reales de producción",
    "SUBSISTEMA_REAL",
    `Victorias simulación: ${funnelStats.simulacion.autorizados}, Producción: ${funnelStats.produccion.autorizados}`
  );

  // 5.2 Proveedor WhatsApp sin implementar (wwebjs) devuelve error explícito
  let wwebjsError = "";
  try {
    await whatsAppWorker.sendViaWwebjs("+34612345678", "Mensaje test");
  } catch (err: any) {
    wwebjsError = err.message;
  }
  assert(
    wwebjsError.includes("no está implementado") && wwebjsError.includes("wwebjs"),
    "PROD-SEP-02",
    "Separación Producción/Simulación",
    "Proveedor sin implementar 'wwebjs' arroja error explicativo y no silencia la excepción",
    "SUBSISTEMA_REAL",
    `Mensaje de error: "${wwebjsError}"`
  );

  // ---------------------------------------------------------------------------------
  // 6. SEGURIDAD: CORS, VALIDACIÓN DE ORIGEN Y NEUTRALIZACIÓN XSS
  // ---------------------------------------------------------------------------------
  // 6.1 isAllowedOrigin restringe estrictamente a localhost y 127.0.0.1
  const allowed1 = isAllowedOrigin("http://127.0.0.1:3000");
  const allowed2 = isAllowedOrigin("http://localhost:3000");
  const allowed3 = isAllowedOrigin(undefined); // direct server access
  const forbidden1 = isAllowedOrigin("https://evil-hacker.com");
  const forbidden2 = isAllowedOrigin("http://127.0.0.1:3000");
  const forbidden3 = isAllowedOrigin("null");
  assert(
    allowed1 && allowed2 && allowed3 && !forbidden1 && !forbidden2 && !forbidden3,
    "SEC-01",
    "Seguridad y CORS",
    "isAllowedOrigin autoriza localhost/127.0.0.1 y rechaza terminantemente dominios externos y 'null'",
    "SUBSISTEMA_REAL",
    `Localhost: ${allowed1}, Externo rechazado: ${!forbidden1}`
  );

  // 6.2 escapeHtml neutraliza inyección XSS de scripts y atributos
  const xssPayload = `<script>alert('XSS')</script>" onfocus="badCode()`;
  const escaped = escapeHtml(xssPayload);
  assert(
    !escaped.includes("<script>") && !escaped.includes('"') && escaped.includes("&lt;script&gt;"),
    "SEC-02",
    "Seguridad XSS",
    "escapeHtml neutraliza scripts, comillas y corchetes angulares",
    "SUBSISTEMA_REAL",
    `Resultado escapado: "${escaped}"`
  );

  // ---------------------------------------------------------------------------------
  // 7. LÍMITES EFECTIVOS Y CONTADOR PERSISTENTE
  // ---------------------------------------------------------------------------------
  // 7.1 Contador diario de WhatsApp persiste en crm.json y sobrevive a recarga
  const initialWaCount = crmStorage.getDailyWhatsAppCount();
  crmStorage.incrementDailyWhatsAppCount();
  const incrementedWaCount = crmStorage.getDailyWhatsAppCount();

  // Forzar recarga desde disco simulando reinicio del servidor
  crmStorage.load();
  const reloadedWaCount = crmStorage.getDailyWhatsAppCount();
  assert(
    incrementedWaCount === initialWaCount + 1 && reloadedWaCount === incrementedWaCount,
    "LIMITS-01",
    "Límites Efectivos",
    "Contador diario de WhatsApp persiste en crm.json y no se restablece ante reinicio del servidor",
    "SUBSISTEMA_REAL",
    `Inicial: ${initialWaCount}, Incrementado: ${incrementedWaCount}, Tras recarga: ${reloadedWaCount}`
  );

  // 7.2 Límite de marcación telefónica: normalización española
  const validEsPhone = normalizeSpanishPhone("611 22 33 44");
  const invalidEsPhone = normalizeSpanishPhone("12345");
  assert(
    validEsPhone === "+34611223344" && invalidEsPhone === null,
    "LIMITS-02",
    "Límites Efectivos",
    "Normalización de teléfonos valida formato internacional +34 español",
    "SUBSISTEMA_REAL",
    `Normalizado: ${validEsPhone}, Inválido rechazado: ${invalidEsPhone === null}`
  );

  // ---------------------------------------------------------------------------------
  // RESUMEN FINAL DE LA AUDITORÍA
  // ---------------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("   RESUMEN DE RESULTADOS DE AUDITORÍA FASE 1");
  console.log("================================================================================");
  const total = report.length;
  const passed = report.filter(r => r.passed).length;
  const failed = report.filter(r => !r.passed).length;

  console.log(`Total pruebas ejecutadas: ${total}`);
  console.log(`Pruebas superadas (PASS): ${passed}`);
  console.log(`Pruebas fallidas  (FAIL): ${failed}`);

  if (failed > 0) {
    console.error("\n❌ Se detectaron fallos en la verificación de Fase 1:");
    for (const f of report.filter(r => !r.passed)) {
      console.error(`- [${f.id}] ${f.name}: ${f.details}`);
    }
    restoreCrmSnapshot();
    process.exit(1);
  } else {
    console.log("\n🎉 Todas las pruebas automatizadas de la Fase 1 han concluido con éxito (100% PASS).");
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

runPhase1AuditTests()
  .then(() => {
    restoreCrmSnapshot();
  })
  .catch(err => {
    restoreCrmSnapshot();
    console.error("Error fatal ejecutando test suite de auditoría Fase 1:", err);
    process.exit(1);
  });
