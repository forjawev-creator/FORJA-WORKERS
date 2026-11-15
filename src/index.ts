import "dotenv/config";
import fs from "fs";
import path from "path";
import { startVoiceBridge } from "./voice-server.js";
import { startWebServer } from "./web-server.js";
import { outboxService } from "./outbox/outbox-service.js";
import { whatsAppWorker } from "./crm/whatsapp-worker.js";
import { baileysWhatsAppService } from "./whatsapp/baileys-service.js";

process.on("uncaughtException", (err) => {
  console.error("[Fatal Uncaught Exception]:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Fatal Unhandled Rejection]:", reason);
});

process.on("SIGINT", () => {
  console.log("[Process] SIGINT signal received, exiting cleanly");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[Process] SIGTERM signal received, exiting cleanly");
  process.exit(0);
});

console.log("==================================================");
console.log("🚀 Iniciando Asistente Telefónico (Modo Unificado)");
console.log("   - Voz: TCP 8080");
console.log("   - Web / CRM: HTTP 3000");
console.log("   - Buzón Outbox: data/outbox");
console.log("==================================================");

// 1. Iniciar puente de audio TCP para Netelip
startVoiceBridge({
  port: parseInt(process.env.AUDIO_TCP_PORT || "8080", 10),
  host: process.env.AUDIO_TCP_HOST || "127.0.0.1",
});

// 2. Iniciar servidor web y CRM
startWebServer();

// 3. Iniciar procesador del buzón outbox
outboxService.startWorker();

// 4. Iniciar worker de WhatsApp
whatsAppWorker.start();

// 5. Auto-conectar WhatsApp si existen credenciales guardadas
const credsPath = path.resolve(process.cwd(), "data", "whatsapp_auth", "creds.json");
if (fs.existsSync(credsPath)) {
  console.log("[WhatsApp Baileys] Credenciales encontradas. Auto-conectando sesión existente...");
  baileysWhatsAppService.startConnection().catch(() => {});
}
