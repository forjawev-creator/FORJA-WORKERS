import { StreamingResampler } from "../src/audio-bridge.js";
import { CallStateMachine } from "../src/pipeline.js";
import { getDefaultStagesConfig } from "../src/storage.js";
import { AgentConfig } from "../src/types.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  } else {
    console.log(`✅ PASSED: ${msg}`);
  }
}

console.log("\n=======================================================");
console.log("  TEST 1: StreamingResampler - Determinismo y Muestras");
console.log("=======================================================");
const SAMPLE_COUNT = 2400; // 0.1s at 24kHz
const inputAudio = new Int16Array(SAMPLE_COUNT);
for (let i = 0; i < SAMPLE_COUNT; i++) {
  inputAudio[i] = Math.round(15000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
}

// 1. Un solo bloque completo
const resamplerSingle = new StreamingResampler(24000, 16000);
const outSingle = resamplerSingle.process(inputAudio);

// 2. Fragmentos de 101 muestras
const resamplerChunked = new StreamingResampler(24000, 16000);
const chunkedOutputs: Int16Array[] = [];
const CHUNK_SIZE = 101;
for (let i = 0; i < inputAudio.length; i += CHUNK_SIZE) {
  const chunk = inputAudio.slice(i, Math.min(inputAudio.length, i + CHUNK_SIZE));
  const outChunk = resamplerChunked.process(chunk);
  if (outChunk.length > 0) chunkedOutputs.push(outChunk);
}
const totalChunkedLen = chunkedOutputs.reduce((acc, c) => acc + c.length, 0);
const outChunkedCombined = new Int16Array(totalChunkedLen);
let offset = 0;
for (const c of chunkedOutputs) {
  outChunkedCombined.set(c, offset);
  offset += c.length;
}

console.log(`Salida bloque completo: ${outSingle.length} muestras`);
console.log(`Salida fragmentos 101:   ${outChunkedCombined.length} muestras`);
assert(outSingle.length === 1600, "Bloque completo genera exactamente 1600 muestras (2400 * 16 / 24)");
assert(outChunkedCombined.length === 1600, "Fragmentos de 101 generan exactamente 1600 muestras (sin pérdida ni desvío)");

let maxDiff = 0;
for (let i = 0; i < 1600; i++) {
  const diff = Math.abs(outSingle[i] - outChunkedCombined[i]);
  if (diff > maxDiff) maxDiff = diff;
}
console.log(`Diferencia máxima entre muestras: ${maxDiff}`);
assert(maxDiff === 0, "Las muestras son bit-a-bit idénticas sin discontinuidades");

console.log("\n=======================================================");
console.log("  TEST 2: Distinción 'Sí' vs 'Hola'");
console.log("=======================================================");
const dummyConfig: AgentConfig = {
  apiKey: "test",
  persona: "kira",
  systemPrompt: "test",
  sttModel: "test",
  llmModel: "test",
  ttsModel: "test",
  ttsVoice: "ef_dora",
  sampleRate: 16000,
  maxTokens: 50,
  disableReasoning: true,
  installPrice: "89",
  monthlyPriceBasic: "6",
  monthlyPriceFull: "12",
  stages: getDefaultStagesConfig(),
};

const sm = new CallStateMachine(dummyConfig, "test_session_1");
assert(sm.getContext().currentStage === 1, "Inicia en Etapa 1");

// "Hola" no avanza
sm.processUserTurn("Hola, buenas tardes");
assert(sm.getContext().currentStage === 1, "'Hola' mantiene en Etapa 1");
assert(!sm.getContext().businessConfirmed, "'Hola' no confirma negocio");

// "Sí" con tilde confirma
sm.processUserTurn("Sí, soy yo");
assert(sm.getContext().currentStage === 2, "'Sí, soy yo' avanza a Etapa 2");
assert(sm.getContext().businessConfirmed, "Negocio confirmado");

console.log("\n=======================================================");
console.log("  TEST 3: Permisos condicionales y dudas (No autorizan WhatsApp)");
console.log("=======================================================");
// Probar duda de precio desde Etapa 2
sm.processUserTurn("¿Cuánto cuesta?");
assert(sm.getContext().currentStage === 3, "Pregunta de precio pasa a Etapa 3 (Aclaraciones)");
assert(!sm.getContext().whatsappAuthorized, "No autoriza WhatsApp");
assert(sm.getContext().doubtsResolved.includes("precio"), "Registra duda de precio resuelta");

// Probar respuesta de precio con importes dinámicos
const priceText = sm.getPriceExplanation();
console.log(`Explicación de precio: "${priceText}"`);
assert(priceText.includes("89 euros"), "Usa installPrice dinámico (89 euros)");
assert(priceText.includes("6 o 12 euros"), "Usa mensualidades dinámicas (6 o 12 euros)");

// Condicional: "Vale, pero antes explícame cómo funciona"
const sm2 = new CallStateMachine(dummyConfig, "test_session_2");
sm2.processUserTurn("Sí, dígame"); // Pasa a etapa 2
assert(sm2.getContext().currentStage === 2, "Avanza a Etapa 2");
sm2.processUserTurn("Sí"); // Pasa a etapa 4 pidiendo WhatsApp
assert(sm2.getContext().currentStage === 4, "Avanza a Etapa 4 (WhatsApp)");
assert(sm2.getContext().pendingQuestion === "WHATSAPP_PERMISSION", "Pregunta pendiente es WHATSAPP_PERMISSION");

// Ahora el usuario responde con condición
sm2.processUserTurn("Vale, pero antes explícame cómo funciona");
assert(sm2.getContext().currentStage === 3, "'Vale, pero antes...' retrocede a Etapa 3 (Aclaraciones)");
assert(!sm2.getContext().whatsappAuthorized, "'Vale, pero antes...' NO concede autorización de WhatsApp");

// Otro condicional: "Vale, si no me cobras"
const sm3 = new CallStateMachine(dummyConfig, "test_session_3");
sm3.processUserTurn("Correcto"); // Etapa 2
sm3.processUserTurn("Me parece bien"); // Etapa 4
sm3.processUserTurn("Vale, si no me cobras");
assert(sm3.getContext().currentStage === 3, "'Vale, si no me cobras' va a Etapa 3");
assert(!sm3.getContext().whatsappAuthorized, "'Vale, si no me cobras' NO concede autorización");

console.log("\n=======================================================");
console.log("  TEST 4: Autorización pura y separación de teléfono");
console.log("=======================================================");
// Desde Etapa 3, aceptar sin dudas
sm3.processUserTurn("Vale, de acuerdo, envíamela");
assert(sm3.getContext().currentStage === 4, "Aceptación tras dudas va a Etapa 4");
assert(sm3.getContext().whatsappAuthorized, "WhatsApp está autorizado");
assert(sm3.getContext().pendingQuestion === "CONFIRM_PHONE", "Pregunta ahora por confirmar número");
assert(!sm3.getContext().phoneConfirmed, "El teléfono AÚN no está confirmado");
assert(sm3.getContext().outcomeStatus !== "AUTORIZADO", "Aún no está marcado como AUTORIZADO (falta teléfono)");

// Confirmar teléfono
sm3.processUserTurn("A este mismo número");
assert(sm3.getContext().currentStage === 5, "Con número confirmado pasa a Etapa 5 (Despedida)");
assert(sm3.getContext().phoneConfirmed, "Teléfono confirmado");
assert(sm3.getContext().outcomeStatus === "AUTORIZADO", "Estado final es AUTORIZADO");
assert(sm3.getContext().shouldHangUp === true, "shouldHangUp es true para cierre limpio");

console.log("\n=======================================================");
console.log("  TEST 5: Salidas con respuesta definida y sin insistir");
console.log("=======================================================");
// Rechazo
const smRefusal = new CallStateMachine(dummyConfig, "test_session_refusal");
smRefusal.processUserTurn("No me interesa, gracias");
assert(smRefusal.getContext().currentStage === 5, "Rechazo pasa directo a Etapa 5");
assert(smRefusal.getContext().outcomeStatus === "RECHAZADO", "Estado es RECHAZADO");
assert(smRefusal.getContext().shouldHangUp === true, "Cuelga inmediatamente");

// Persona equivocada
const smWrong = new CallStateMachine(dummyConfig, "test_session_wrong");
smWrong.processUserTurn("Se equivoca de persona, aquí no es");
assert(smWrong.getContext().currentStage === 5, "Número equivocado pasa a Etapa 5");
assert(smWrong.getContext().outcomeStatus === "PERSONA_EQUIVOCADA", "Estado es PERSONA_EQUIVOCADA");
assert(smWrong.getContext().shouldHangUp === true, "Cuelga inmediatamente");

// Llamar más tarde
const smLater = new CallStateMachine(dummyConfig, "test_session_later");
smLater.processUserTurn("Estoy conduciendo, llámame más tarde");
assert(smLater.getContext().currentStage === 5, "Ocupado pasa a Etapa 5");
assert(smLater.getContext().outcomeStatus === "LLAMAR_DESPUES", "Estado es LLAMAR_DESPUES");
assert(smLater.getContext().shouldHangUp === true, "Cuelga inmediatamente");

console.log("\n🎉 TODOS LOS TESTS HAN PASADO SATISFACTORIAMENTE.\n");
