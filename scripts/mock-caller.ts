import net from "net";
import fs from "fs";
import path from "path";
import {
  encodePacket,
  PacketFramer,
  PACKET_AUDIO,
  PACKET_FLUSH,
  PACKET_PLAYBACK_DRAINED,
  PACKET_CALL_START,
  PACKET_CALL_END,
  PACKET_TURN_END,
  PACKET_PLAYBACK_STARTED,
} from "../src/audio-bridge.js";

/**
 * Simulador de Pruebas Riguroso (Mock Caller)
 * - Exige audio del saludo Y audio de la respuesta posterior (Turno 2).
 * - Exige corte real por interrupción (Barge-in FLUSH) DURANTE la respuesta y ANTES de colgar.
 * - Modela fonemas de voz real en español ("Hola, sí, ¿de qué se trata?").
 * - Termina con código 1 si alguna condición falla.
 */

const TCP_PORT = parseInt(process.env.AUDIO_TCP_PORT || "8080", 10);
const TCP_HOST = process.env.AUDIO_TCP_HOST || "127.0.0.1";
const SAMPLE_RATE = parseInt(process.env.AUDIO_SAMPLE_RATE || "16000", 10);

console.log(`[Mock Caller] Conectando a ${TCP_HOST}:${TCP_PORT}...`);

const framer = new PacketFramer();
let greetingAudioBytes = 0;
let greetingTurnId = 0;

let turn2AudioBytes = 0;
let turn2TurnId = 0;
let bargeInFlushReceivedDuringTurn2 = false;

// Generador de voz con formantes acústicos reales para fonemas del español
function generatePhonemeChunk(
  f0: number,
  f1: number,
  f2: number,
  durationMs: number,
  amplitude: number = 0.75
): Buffer {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples * 2);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const glottal = Math.sin(2 * Math.PI * f0 * t) + 0.3 * Math.sin(4 * Math.PI * f0 * t);
    const form1 = 0.5 * Math.sin(2 * Math.PI * f1 * t);
    const form2 = 0.3 * Math.sin(2 * Math.PI * f2 * t);
    const voiceSignal = (0.5 * glottal + form1 + form2) * amplitude;
    const sample = Math.max(-32768, Math.min(32767, Math.round(sampleTo16bit(voiceSignal))));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

function sampleTo16bit(val: number): number {
  return val * 32767;
}

function generateSilence(durationMs: number): Buffer {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  return Buffer.alloc(numSamples * 2);
}

const client = net.createConnection({ port: TCP_PORT, host: TCP_HOST }, async () => {
  console.log(`[Mock Caller] Conexión TCP establecida.`);

  let greetingTurnEnded = false;
  let onGreetingTurnEnd: (() => void) | null = null;
  let onTurn2AudioReceived: (() => void) | null = null;
  let onBargeInFlushReceived: (() => void) | null = null;

  client.on("data", (chunk: Buffer) => {
    const packets = framer.push(chunk);
    for (const pkt of packets) {
      if (pkt.type === PACKET_AUDIO) {
        if (greetingAudioBytes === 0) {
          greetingTurnId = pkt.turnId;
        }

        if (pkt.turnId === greetingTurnId) {
          greetingAudioBytes += pkt.payload.length;
          process.stdout.write(`\r[Mock Caller] Audio del Saludo (Turno #${pkt.turnId}): ${greetingAudioBytes} bytes`);
        } else {
          // Audio de la respuesta posterior (Turno 2)
          turn2TurnId = pkt.turnId;
          turn2AudioBytes += pkt.payload.length;
          process.stdout.write(`\r[Mock Caller] Audio de Respuesta (Turno #${pkt.turnId}): ${turn2AudioBytes} bytes`);
          if (onTurn2AudioReceived) {
            onTurn2AudioReceived();
            onTurn2AudioReceived = null;
          }
        }
      } else if (pkt.type === PACKET_TURN_END) {
        console.log(`\n[Mock Caller] << Servidor finalizó generación para Turno #${pkt.turnId} >>`);
        if (pkt.turnId === greetingTurnId) {
          greetingTurnEnded = true;
          if (onGreetingTurnEnd) {
            onGreetingTurnEnd();
            onGreetingTurnEnd = null;
          }
        }
      } else if (pkt.type === PACKET_FLUSH) {
        // Solo registrar si ocurre durante la respuesta y antes del colgado
        if (turn2AudioBytes > 0) {
          bargeInFlushReceivedDuringTurn2 = true;
          console.log(`\n[Mock Caller] << ¡CONFIRMADO! PACKET_FLUSH recibido en plena reproducción del Turno #${pkt.turnId} (Barge-in genuino) >>`);
          if (onBargeInFlushReceived) {
            onBargeInFlushReceived();
            onBargeInFlushReceived = null;
          }
        }
      }
    }
  });

  // 1. Iniciar llamada
  console.log("[Mock Caller] 1. Enviando PACKET_CALL_START (Descolgado)...");
  client.write(encodePacket(PACKET_CALL_START));

  // 2. Esperar saludo inicial y su fin de generación
  console.log("[Mock Caller] 2. Esperando audio y fin de generación del saludo inicial...");
  await new Promise<void>((resolve) => {
    if (greetingTurnEnded) return resolve();
    onGreetingTurnEnd = resolve;
    setTimeout(resolve, 8000);
  });

  // Confirmar que el saludo terminó de sonar en el dispositivo
  console.log("[Mock Caller] Confirmando reproducción del saludo en el dispositivo (PLAYBACK_STARTED & DRAINED)...");
  client.write(encodePacket(PACKET_PLAYBACK_STARTED, greetingTurnId));
  await new Promise((r) => setTimeout(r, 200));
  client.write(encodePacket(PACKET_PLAYBACK_DRAINED, greetingTurnId));
  await new Promise((r) => setTimeout(r, 400));

  // 3. Transmitir grabación de voz real del cliente: "Hola, sí, ¿de qué se trata?"
  console.log("\n[Mock Caller] 3. Transmitiendo grabación de voz real del cliente ('fixtures/customer-voice.pcm')...");
  const voiceFile = path.resolve(process.cwd(), "fixtures/customer-voice.pcm");
  const voiceBuffer = fs.readFileSync(voiceFile);

  const chunkSize = 1024; // 32ms a 16kHz
  for (let offset = 0; offset < voiceBuffer.length; offset += chunkSize) {
    const chunk = voiceBuffer.subarray(offset, Math.min(offset + chunkSize, voiceBuffer.length));
    client.write(encodePacket(PACKET_AUDIO, 0, chunk));
    await new Promise((r) => setTimeout(r, 32));
  }

  // 4. Silencio de fin de turno (600ms) para que VAD confirme fin de habla
  console.log("\n[Mock Caller] 4. Enviando silencio de fin de turno (600ms)...");
  for (let i = 0; i < 6; i++) {
    client.write(encodePacket(PACKET_AUDIO, 0, generateSilence(100)));
    await new Promise((r) => setTimeout(r, 100));
  }

  // 5. Esperar que el agente procese y empiece a responder (Turno 2)
  console.log("\n[Mock Caller] 5. Esperando que el agente responda a la pregunta (Turno 2)...");
  await new Promise<void>((resolve) => {
    if (turn2AudioBytes > 0) return resolve();
    onTurn2AudioReceived = resolve;
    setTimeout(resolve, 10000);
  });

  // 6. Simular interrupción (Barge-in) con voz real mientras el agente está reproduciendo la respuesta
  console.log("\n[Mock Caller] 6. Disparando voz real para interrumpir al agente (Barge-in)...");
  for (let offset = 0; offset < Math.min(1024 * 6, voiceBuffer.length); offset += 1024) {
    const chunk = voiceBuffer.subarray(offset, offset + 1024);
    client.write(encodePacket(PACKET_AUDIO, 0, chunk));
    await new Promise((r) => setTimeout(r, 32));
  }

  await new Promise<void>((resolve) => {
    if (bargeInFlushReceivedDuringTurn2) return resolve();
    onBargeInFlushReceived = resolve;
    setTimeout(resolve, 3000);
  });

  // 7. Finalizar llamada (Colgado)
  console.log("[Mock Caller] 7. Enviando PACKET_CALL_END (Colgado)...");
  client.write(encodePacket(PACKET_CALL_END));
  await new Promise((r) => setTimeout(r, 500));

  console.log("\n================ RESULTADOS DE LA PRUEBA ================");
  console.log(`Audio del Saludo recibido:       ${greetingAudioBytes} bytes`);
  console.log(`Audio de la Respuesta recibido:   ${turn2AudioBytes} bytes`);
  console.log(`Barge-in FLUSH durante respuesta: ${bargeInFlushReceivedDuringTurn2 ? "SÍ (CORRECTO)" : "NO"}`);
  console.log("=========================================================");

  // EXIGENCIA RIGUROSA:
  if (greetingAudioBytes === 0) {
    console.error("❌ ERROR: No se recibió audio del saludo inicial.");
    client.end();
    process.exit(1);
  }

  if (turn2AudioBytes === 0) {
    console.error("❌ ERROR: No se recibió audio de la respuesta posterior al saludo (Turno 2).");
    console.error("   Verifica que TOGETHER_API_KEY esté configurada en .env.");
    client.end();
    process.exit(1);
  }

  if (!bargeInFlushReceivedDuringTurn2) {
    console.error("❌ ERROR: No se recibió PACKET_FLUSH motivado por interrupción durante la respuesta.");
    client.end();
    process.exit(1);
  }

  console.log("✅ TODAS LAS PRUEBAS RIGUROSAS PASARON EXITOSAMENTE.");
  client.end();
  process.exit(0);
});

client.on("error", (err: any) => {
  if (err.code === "ECONNRESET") return;
  console.error(`[Mock Caller Error]: ${err.message}`);
  process.exit(1);
});

client.on("close", () => {
  console.log("[Mock Caller] Conexión cerrada.");
});
