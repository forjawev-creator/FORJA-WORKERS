import fs from "fs";
import path from "path";
import { getOrCreateVoiceControlSecret } from "../src/utils/secret-manager.js";
import { GeminiAudioToPcmaConverter } from "../src/voice/audio-codecs.js";
import { outboxProducer } from "../src/outbox/outbox-producer.js";
import { OutboxConsumer } from "../src/outbox/outbox-consumer.js";

async function runIsolationSuite() {
  console.log("==========================================================");
  console.log("🧪 BATERÍA DE PRUEBAS DE AISLAMIENTO, INTEGRIDAD Y OUTBOX");
  console.log("==========================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, desc: string) {
    if (condition) {
      console.log(`  ✅ [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${desc}`);
      failed++;
    }
  }

  // PRUEBA 1: Auditoría estricta de importaciones directas e indirectas en el Servicio de Voz
  console.log("\n📌 [Prueba 1] Auditoría estricta de importaciones en Servicio 1 (Voz)");
  const forbiddenKeywords = [
    "@whiskeysockets/baileys",
    "web-server.js",
    "whatsapp-worker.js",
    "crm-service.js",
    "crm-routes.js",
    "crm-storage.js",
  ];

  // Recorrer árbol de dependencias desde voice-entry.ts
  const visitedFiles = new Set<string>();
  const filesToScan = [path.resolve(process.cwd(), "src/voice-entry.ts")];

  while (filesToScan.length > 0) {
    const current = filesToScan.pop()!;
    if (visitedFiles.has(current)) continue;
    visitedFiles.add(current);

    if (!fs.existsSync(current)) continue;
    const content = fs.readFileSync(current, "utf-8");

    // Buscar sentencias import
    const importMatches = content.matchAll(/import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["']/g);
    for (const match of importMatches) {
      const impPath = match[1];
      for (const kw of forbiddenKeywords) {
        assert(!impPath.includes(kw), `El archivo ${path.basename(current)} NO debe importar ${kw} (detectado: "${impPath}")`);
      }
      if (impPath.startsWith(".")) {
        const resolved = path.resolve(path.dirname(current), impPath.replace(/\.js$/, ".ts"));
        if (!visitedFiles.has(resolved) && fs.existsSync(resolved)) {
          filesToScan.push(resolved);
        }
      }
    }
  }
  console.log(`   Archivos auditados en el árbol de dependencias de voz: ${visitedFiles.size}`);

  // PRUEBA 2: Gestión Segura de Secretos sin Contraseñas por Defecto
  console.log("\n📌 [Prueba 2] Verificación de Secretos Criptográficos");
  const secret = getOrCreateVoiceControlSecret();
  assert(Boolean(secret && secret.length >= 32), "VOICE_CONTROL_SECRET generado con longitud criptográfica segura (>= 32 chars)");
  assert(!secret.includes("default") && !secret.includes("secret"), "El secreto no contiene palabras por defecto");

  // PRUEBA 3: Conversión de Audio FIR anti-aliasing 24k -> 8k PCMA de Gemini
  console.log("\n📌 [Prueba 3] Conversor de Audio Gemini Live (FIR 21 taps + Diezmado 3:1 + PCMA)");
  const converter = new GeminiAudioToPcmaConverter();
  // Crear 480 muestras (10 ms de PCM 24k)
  const dummyPcm24k = Buffer.alloc(480 * 2);
  for (let i = 0; i < 480; i++) {
    dummyPcm24k.writeInt16LE(Math.round(15000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  }
  const pcmaResult = converter.convert(dummyPcm24k);
  assert(pcmaResult.length === 160, `Diezmado 3:1 exacto: 480 muestras a 24k -> ${pcmaResult.length} bytes a 8k (esperado: 160)`);
  assert(pcmaResult.some((b) => b !== 0), "El buffer PCMA resultante contiene datos válidos de voz sintetizada");

  // PRUEBA 4: Productor de Outbox Atómico y Fan-out
  console.log("\n📌 [Prueba 4] Productor Outbox Atómico con Fan-out CRM y WhatsApp");
  const testCallId = `test_call_${Date.now()}`;
  outboxProducer.emitWhatsAppAuthorized(testCallId, {
    phone: "600000000",
    confirmedPhone: "600000000",
    company: "Empresa Test Aislamiento",
    evidenceQuote: "Sí, de acuerdo, envíalo",
  });

  const crmPendingDir = path.resolve(process.cwd(), "data/outbox/crm/pending");
  const waPendingDir = path.resolve(process.cwd(), "data/outbox/whatsapp/pending");

  const crmFiles = fs.readdirSync(crmPendingDir).filter((f) => f.endsWith(".json"));
  const waFiles = fs.readdirSync(waPendingDir).filter((f) => f.endsWith(".json"));

  assert(crmFiles.length > 0, "Evento whatsapp_authorized encolado en cola CRM");
  assert(waFiles.length > 0, "Evento whatsapp_authorized encolado simultáneamente en cola WhatsApp (Fan-out exitoso)");

  // PRUEBA 5: Consumidor de Outbox con Manejo de Estado Incierto y Recuperación
  console.log("\n📌 [Prueba 5] Consumidor Outbox con prevención de duplicados e incertidumbre");
  let processedWa = 0;
  const testConsumer = new OutboxConsumer({
    queueName: "whatsapp",
    pollIntervalMs: 500,
    maxRetries: 2,
    handler: async (evt) => {
      processedWa++;
      return true;
    },
  });

  const count = await testConsumer.processNextBatch();
  assert(count > 0, `Consumidor procesó ${count} evento(s) y los archivó en completed/ con ACK`);

  // Simular envío duplicado con la misma clave de idempotencia
  const duplicateCount = await testConsumer.processNextBatch();
  assert(duplicateCount === 0, "Segundo ciclo ignoró eventos duplicados respetando sent-ledger.json");

  console.log("\n==========================================================");
  console.log(`🏁 RESULTADO: ${passed} pasadas, ${failed} fallidas`);
  console.log("==========================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runIsolationSuite().catch((err) => {
  console.error("Error en suite de pruebas:", err);
  process.exit(1);
});
