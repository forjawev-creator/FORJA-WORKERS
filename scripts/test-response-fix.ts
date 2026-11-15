import dotenv from "dotenv";
dotenv.config();

import { CallStateMachine } from "../src/pipeline.js";
import { getDefaultConfig } from "../src/storage.js";

async function runVerification() {
  console.log("=== INICIANDO PRUEBA DE CORRECCIÓN DE RESPUESTAS DEL BOT ===");

  const config = getDefaultConfig();
  config.disableReasoning = true;
  const stateMachine = new CallStateMachine(config as any, "test_session");

  // TEST 1: Reconocimiento de "Sí, señor."
  console.log("\n[TEST 1] Probando entrada: 'Sí, señor.'");
  const turn1 = stateMachine.processUserTurn("Sí, señor.");
  const ctx1 = stateMachine.getContext();
  console.log(`Etapa resultante: ${ctx1.currentStage} (Esperado: 2) | Negocio confirmado: ${ctx1.businessConfirmed}`);
  if (ctx1.currentStage !== 2 || !ctx1.businessConfirmed) {
    throw new Error("FALLO TEST 1: 'Sí, señor.' no avanzó a Etapa 2");
  }
  console.log("✅ TEST 1 SUPERADO: 'Sí, señor.' avanza a Etapa 2 correctamente");

  // TEST 2: Reconocimiento de "Dime, soy yo, dime, dime."
  const sm2 = new CallStateMachine(config as any, "test_session_2");
  console.log("\n[TEST 2] Probando entrada: 'Dime, soy yo, dime, dime.'");
  const turn2 = sm2.processUserTurn("Dime, soy yo, dime, dime.");
  const ctx2 = sm2.getContext();
  console.log(`Etapa resultante: ${ctx2.currentStage} (Esperado: 2) | Negocio confirmado: ${ctx2.businessConfirmed}`);
  if (ctx2.currentStage !== 2 || !ctx2.businessConfirmed) {
    throw new Error("FALLO TEST 2: 'Dime, soy yo, dime, dime.' no avanzó a Etapa 2");
  }
  console.log("✅ TEST 2 SUPERADO: 'Dime, soy yo, dime, dime.' avanza a Etapa 2 correctamente");

  // TEST 3: Generación real con Together AI para la frase dicha por el usuario ("Y luego le contesto, escribe el texto.")
  console.log("\n[TEST 3] Llamada real a Together AI con reasoning: { enabled: false }");
  const apiKey = config.togetherApiKey || process.env.TOGETHER_API_KEY;
  const tStart = Date.now();
  const resp = await fetch("https://api.together.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llmModel || "Qwen/Qwen3.5-9B",
      messages: [
        { role: "system", content: config.systemPrompt + "\n\n" + turn1.dynamicPrompt },
        { role: "assistant", content: "Hola, buenas. ¿Hablo con el responsable del negocio?" },
        { role: "user", content: "Y luego le contesto, escribe el texto." },
      ],
      max_tokens: config.maxTokens || 90,
      reasoning: { enabled: false },
      stream: false,
    }),
  });

  const json: any = await resp.json();
  const duration = Date.now() - tStart;
  const content = json.choices?.[0]?.message?.content || "";
  console.log(`Respuesta del LLM (${duration} ms): "${content}"`);
  console.log(`Reasoning tokens emitidos: ${json.usage?.reasoning_tokens || 0}`);

  if (!content || content.trim().length === 0) {
    throw new Error("FALLO TEST 3: El contenido del LLM sigue saliendo vacío");
  }
  console.log("✅ TEST 3 SUPERADO: El LLM responde texto real e inmediato sin quedarse en blanco");

  console.log("\n🎉 TODAS LAS PRUEBAS DE RESPUESTA DEL BOT SUPERADAS CON ÉXITO");
}

runVerification().catch((err) => {
  console.error("❌ ERROR EN VERIFICACIÓN:", err);
  process.exit(1);
});
