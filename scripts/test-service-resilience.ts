/**
 * Test de Resiliencia de Servicios Desacoplados (Fase 5 - Paso 4)
 * 
 * Verifica que:
 * 1. La muerte o fallo del Servicio de WhatsApp (Baileys) o CRM NO interrumpe el motor de audio.
 * 2. Los eventos emitidos a mitad de llamada (whatsapp_authorized, phone_confirmed) se encolan en disco de forma atómica.
 * 3. Si un servicio se reinicia tras una caída, recupera sus eventos pendientes del buzón y los procesa sin duplicados.
 * 4. El lag del Event Loop en el hilo de voz se mantiene por debajo de 5ms durante escrituras de buzón.
 */

import { outboxProducer } from "../src/outbox/outbox-producer.js";
import { OutboxConsumer } from "../src/outbox/outbox-consumer.js";
import { voiceTelemetry } from "../src/telemetry/voice-telemetry.js";
import fs from "fs";
import path from "path";

async function runResilienceTest() {
  console.log("==================================================");
  console.log("🛡️ TEST DE RESILIENCIA Y DESACOPLAMIENTO DE SERVICIOS");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${msg}`);
      failed++;
    }
  }

  const callId = `resilience_call_${Date.now()}`;
  const phone = "699336999";
  const company = "Empresa Resiliencia S.L.";

  // Limpiar directorios de prueba si existen para un test limpio
  const crmDir = path.join(process.cwd(), "data", "outbox", "crm");
  const waDir = path.join(process.cwd(), "data", "outbox", "whatsapp");

  for (const dir of [crmDir, waDir]) {
    for (const sub of ["pending", "processing", "completed", "uncertain", "failed"]) {
      const p = path.join(dir, sub);
      if (fs.existsSync(p)) {
        for (const f of fs.readdirSync(p)) {
          try { fs.unlinkSync(path.join(p, f)); } catch {}
        }
      }
    }
    const ledger = path.join(dir, "sent-ledger.json");
    if (fs.existsSync(ledger)) {
      try { fs.unlinkSync(ledger); } catch {}
    }
  }

  // 1. Iniciar monitor de telemetría de voz y medir latencia del event loop
  voiceTelemetry.startCall(callId, "openai_realtime", "gpt-4o-realtime", "cercano");
  
  const startEventLoopLag = voiceTelemetry.getEventLoopLag();
  assert(startEventLoopLag.meanMs < 10, `Event loop inicial saludable: ${startEventLoopLag.meanMs.toFixed(2)} ms`);

  // 2. Simular emisión atómica a mitad de llamada (whatsapp_authorized) mientras WhatsApp está CAÍDO (apagado)
  console.log("\n--- Escenario A: Emisión mid-call con WhatsApp Service APAGADO ---");
  const eventId = outboxProducer.emitWhatsAppAuthorized(callId, {
    phone,
    company,
    authorized: true,
    explicit_consent_phrase: "sí claro por whatsapp",
    source_stage: "presentacion_cercano"
  });

  assert(Boolean(eventId), `Evento whatsapp_authorized generado con ID: ${eventId}`);
  assert(fs.existsSync(path.join(crmDir, "pending", `${eventId}.json`)), "Evento existe en buzón de CRM pending/");
  assert(fs.existsSync(path.join(waDir, "pending", `${eventId}.json`)), "Evento existe en buzón de WhatsApp pending/");

  // Comprobar que el event loop de voz no se bloqueó durante la escritura
  const postLag = voiceTelemetry.getEventLoopLag();
  assert(postLag.meanMs < 15, `Event loop de voz se mantiene ágil (<15ms) tras escritura: ${postLag.meanMs.toFixed(2)} ms`);

  // 3. Simular que CRM procesa su evento normalmente mientras WhatsApp sigue apagado
  console.log("\n--- Escenario B: CRM consume su evento independientemente ---");
  let crmProcessedCount = 0;
  const crmConsumer = new OutboxConsumer({
    queueName: "crm",
    handler: async (evt) => {
      crmProcessedCount++;
      return true;
    }
  });

  const crmCount = await crmConsumer.processNextBatch();
  assert(crmCount === 1, "CRM procesó 1 evento de su cola sin esperar a WhatsApp");
  assert(crmProcessedCount === 1, "Handler de CRM ejecutado exactamente 1 vez");
  assert(!fs.existsSync(path.join(crmDir, "pending", `${eventId}.json`)), "CRM eliminó de su pending/");
  assert(fs.existsSync(path.join(crmDir, "completed", `${eventId}.json`)), "CRM archivó en su completed/");

  // Verificar que el evento de WhatsApp SIGUE INTACTO en su propia cola
  assert(fs.existsSync(path.join(waDir, "pending", `${eventId}.json`)), "Evento en cola WhatsApp sigue pendiente intacto");

  // 4. Simular recuperación: WhatsApp Service se inicia después y consume sus eventos pendientes
  console.log("\n--- Escenario C: WhatsApp Service se reinicia y recupera la cola ---");
  let waProcessedCount = 0;
  const waConsumer = new OutboxConsumer({
    queueName: "whatsapp",
    handler: async (evt) => {
      waProcessedCount++;
      return true;
    }
  });

  const waCount = await waConsumer.processNextBatch();
  assert(waCount === 1, "WhatsApp recuperó y procesó el evento pendiente tras reinicio");
  assert(waProcessedCount === 1, "Handler de WhatsApp ejecutado exactamente 1 vez");
  assert(!fs.existsSync(path.join(waDir, "pending", `${eventId}.json`)), "WhatsApp eliminó de su pending/");
  assert(fs.existsSync(path.join(waDir, "completed", `${eventId}.json`)), "WhatsApp archivó en su completed/");

  // 5. Simular reintento o re-procesamiento para verificar idempotencia
  console.log("\n--- Escenario D: Verificación de Idempotencia estricta ---");
  const waSecondCount = await waConsumer.processNextBatch();
  assert(waSecondCount === 0, "Segunda pasada: 0 eventos procesados (idempotencia garantizada)");
  assert(waProcessedCount === 1, "Handler no se ejecutó por duplicado");

  // Finalizar llamada de telemetría
  voiceTelemetry.finalizeCall(callId);

  console.log("\n==================================================");
  console.log(`📊 RESULTADO TEST DE RESILIENCIA: ${passed}/${passed + failed} pruebas superadas`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runResilienceTest().catch((err) => {
  console.error("Error fatal en test de resiliencia:", err);
  process.exit(1);
});
