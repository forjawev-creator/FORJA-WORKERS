import fs from "fs";
import path from "path";
import assert from "assert";
import {
  getCatalogPrices,
  renderInboundPrompt,
  renderCommercialPrompt,
  renderTechnicalPrompt,
} from "../src/prompts-loader.js";
import { isExplicitWhatsAppAuthorization } from "../src/pipeline.js";
import { normalizeSpanishPhone } from "../src/crm/crm-service.js";
import { outboxService } from "../src/outbox/outbox-service.js";
import { crmStorage } from "../src/crm/crm-storage.js";
import { formatPhoneForSpeech, buildSessionTools } from "../src/voice/voice-tools.js";
import { whatsAppWorker } from "../src/crm/whatsapp-worker.js";

async function runTestSuite() {
  console.log("==================================================");
  console.log("🧪 SUITE DE REGRESIÓN Y BLINDAJE (FASE 5)");
  console.log("==================================================\n");

  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    total++;
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
    }
  }

  // --- 1. GUIONES Y PRECIOS FUERA DEL CÓDIGO ---
  console.log("--- 1. Verificación de Guiones y Catálogo (brain/prompts) ---");

  await test("Precios oficiales son 99€ instalación y 10€/mes mantenimiento", () => {
    const prices = getCatalogPrices();
    assert.strictEqual(prices.installPrice, "99", "Precio de instalación debe ser 99");
    assert.strictEqual(prices.monthlyPriceBasic, "10", "Mantenimiento básico debe ser 10");
  });

  await test("Guion entrante no menciona 'en 10 minutos' y promete demo en 'uno o dos días' con Maps", () => {
    const prompt = renderInboundPrompt({
      agentName: "Laura",
      timeGreeting: "Buenos días",
      wishClosing: "que tengas muy buen día",
    });
    assert.ok(prompt.length > 50, "Prompt entrante debe tener contenido");
    assert.ok(!prompt.includes("10 minutos"), "Prohibido mencionar '10 minutos'");
    assert.ok(prompt.includes("uno o dos días") || prompt.includes("par de días"), "Debe ofrecer demo en 1-2 días");
    assert.ok(prompt.includes("Google Maps"), "Debe referenciar datos de Google Maps");
  });

  await test("Guion saliente cercano renderiza precios 99€ y 10€ y propuesta de Maps en 1-2 días", () => {
    const prompt = renderCommercialPrompt({
      variant: "cercano",
      agentName: "Juan",
      bizRef: "de vuestro negocio",
      installPrice: "99",
      monthlyPrice: "10",
    });
    assert.ok(!prompt.includes("10 minutos"), "Prohibido '10 minutos' en saliente cercano");
    assert.ok(prompt.includes("99 euros"), "Debe contener 99 euros");
    assert.ok(prompt.includes("10 euros al mes"), "Debe contener 10 euros al mes");
    assert.ok(prompt.includes("Google Maps"), "Debe mencionar Google Maps");
  });

  // --- 2. ACEPTACIÓN AMPLIA DE CONSENTIMIENTO ---
  console.log("\n--- 2. Verificación de Aceptación Amplia de WhatsApp ---");

  const affirmativePhrases = [
    "vale",
    "bueno",
    "de acuerdo",
    "mándamelo",
    "mándala",
    "ok",
    "okay",
    "por supuesto",
    "adelante",
    "estupendo",
    "genial",
    "sí",
    "si",
    "claro",
    "por mí bien",
    "por mi bien",
    "está bien",
    "venga",
    "dale",
    "cuando quieras",
    "este mismo",
    "al mismo",
    "a este",
    "648 648 441",
    "autorizado",
    "trato hecho",
  ];

  for (const phrase of affirmativePhrases) {
    await test(`Acepta consentimiento con frase afirmativa: "${phrase}"`, () => {
      assert.strictEqual(
        isExplicitWhatsAppAuthorization(phrase),
        true,
        `Frase "${phrase}" debería ser aceptada como consentimiento válido`
      );
    });
  }

  const negativePhrases = [
    "no quiero",
    "no me interesa",
    "para nada",
    "dejadme en paz",
    "no me llames más",
    "rechazo la oferta",
  ];

  for (const phrase of negativePhrases) {
    await test(`Rechaza consentimiento correctamente ante negativa tajante: "${phrase}"`, () => {
      assert.strictEqual(
        isExplicitWhatsAppAuthorization(phrase),
        false,
        `Frase "${phrase}" no debe dar consentimiento`
      );
    });
  }

  // --- 3. RESOLUCIÓN DE TELÉFONOS ---
  console.log("\n--- 3. Verificación de Normalización y Resolución de Teléfonos ---");

  await test("Normaliza número móvil español de 9 dígitos", () => {
    assert.strictEqual(normalizeSpanishPhone("600000000"), "600000000");
    assert.strictEqual(normalizeSpanishPhone("622 28 29 72"), "+34622282972");
    assert.strictEqual(normalizeSpanishPhone("600000000"), "600000000");
  });

  await test("Formato fonético respeta agrupación 3-3-3 y 3-2-2-2", () => {
    const formatted333 = formatPhoneForSpeech("600000000", "648 648 441");
    assert.strictEqual(formatted333, "648, 648, 441");

    const formatted3222 = formatPhoneForSpeech("600000000", "648 64 84 41");
    assert.strictEqual(formatted3222, "648, 64, 84, 41");
  });

  // --- 4. BUZÓN DE EVENTOS OUTBOX ---
  console.log("\n--- 4. Verificación del Buzón Outbox Desacoplado ---");

  await test("Outbox encola y procesa llamada con consentimiento sin bloquear", async () => {
    const testCallId = `test_reg_${Date.now()}`;
    const testPhone = "699" + Math.floor(100000 + Math.random() * 900000);

    const eventId = outboxService.emitCallCompleted({
      sessionId: testCallId,
      channel: "telephony",
      company: "Fontanería Test Regresión",
      phone: testPhone,
      durationSeconds: 35,
      status: "AUTORIZADO",
      whatsappAuthorized: true,
      phoneConfirmed: true,
      confirmedPhone: testPhone,
      evidenceQuote: "vale, mándamela al WhatsApp",
      transcript: [
        { role: "assistant", text: "Hola, te llamo de Forja Web para prepararte una demo." },
        { role: "user", text: "Vale, mándamela porfa." },
      ],
      scriptVariant: "cercano",
    });

    assert.ok(eventId.startsWith("evt_"), "El ID de evento debe comenzar con evt_");

    // Procesar evento encolado
    const processed = await outboxService.processPendingEvents();
    assert.ok(processed >= 1, "Debe procesar al menos 1 evento");

    // Esperar a que el callback asíncrono no bloqueante (setImmediate) sincronice el lead
    await new Promise((r) => setTimeout(r, 200));

    // Comprobar que el lead quedó registrado en el CRM en 'cola_whatsapp'
    const db = crmStorage.getDb();
    const lead = db.leads.find((l) => l.telefono.includes(testPhone));
    assert.ok(lead, `El lead con teléfono ${testPhone} debe existir en la base de datos CRM`);
    assert.strictEqual(lead?.estado, "cola_whatsapp", "El lead debe quedar en estado cola_whatsapp");
    assert.strictEqual(lead?.consentimiento_whatsapp, true, "Consentimiento debe ser true");
  });

  // --- 5. HERRAMIENTAS Y MOTOR MODULAR ---
  console.log("\n--- 5. Verificación de Herramientas Modulares de Voz ---");

  await test("buildSessionTools genera herramientas oficiales y respeta gating de WhatsApp", () => {
    const toolsGated = buildSessionTools({ role: "commercial", includeWhatsappTool: false, handoffEnabled: true });
    assert.ok(!toolsGated.some((t) => t.name === "record_whatsapp_consent"), "Al inicio de comercial WhatsApp debe estar bloqueado");

    const toolsUnlocked = buildSessionTools({ role: "commercial", includeWhatsappTool: true, handoffEnabled: true });
    assert.ok(toolsUnlocked.some((t) => t.name === "record_whatsapp_consent"), "Tras propuesta WhatsApp debe estar desbloqueado");
    assert.ok(toolsUnlocked.some((t) => t.name === "transfer_to_technical"), "Debe incluir traspaso a técnico");
    assert.ok(toolsUnlocked.some((t) => t.name === "transfer_to_human"), "Debe incluir traspaso a humano");
  });

  console.log("\n==================================================");
  console.log(`📊 RESULTADO FINAL: ${passed}/${total} pruebas superadas (${Math.round((passed / total) * 100)}%)`);
  console.log("==================================================");

  outboxService.stopWorker();
  whatsAppWorker.stop();

  if (passed !== total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite().catch((err) => {
  console.error("Error fatal ejecutando suite de tests:", err);
  process.exit(1);
});
