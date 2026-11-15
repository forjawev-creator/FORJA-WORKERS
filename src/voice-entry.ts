import "dotenv/config";
import { startVoiceBridge } from "./voice-server.js";
import { startIpcServer } from "./events-ipc.js";

process.on("uncaughtException", (err) => {
  console.error("[VoiceProcess Fatal Uncaught Exception]:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[VoiceProcess Fatal Unhandled Rejection]:", reason);
});

process.on("SIGINT", () => {
  console.log("[VoiceProcess] Señal SIGINT recibida, cerrando limpiamente");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[VoiceProcess] Señal SIGTERM recibida, cerrando limpiamente");
  process.exit(0);
});

console.log("==================================================");
console.log("🧩 [PIEZA: MOTOR DE VOZ Y LLAMADAS AISLADO]");
console.log("   - Audio Bridge TCP (Puerto 8080)");
console.log("   - Motor OpenAI Realtime / Together");
console.log("   - Buzón Outbox atómico no bloqueante");
console.log("   - Telemetría IPC (Puerto 8089)");
console.log("==================================================");

// Iniciar servidor IPC de telemetría para dashboards
startIpcServer(8089);

// Iniciar puente de audio TCP para Netelip
startVoiceBridge({
  port: parseInt(process.env.AUDIO_TCP_PORT || "8080", 10),
  host: process.env.AUDIO_TCP_HOST || "127.0.0.1",
});
