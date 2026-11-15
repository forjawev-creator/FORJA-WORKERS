import "dotenv/config";
import fs from "fs";
import path from "path";
import { startWebServer } from "./web-server.js";
import { outboxService } from "./outbox/outbox-service.js";
import { whatsAppWorker } from "./crm/whatsapp-worker.js";
import { baileysWhatsAppService } from "./whatsapp/baileys-service.js";
import { connectIpcClient } from "./events-ipc.js";

process.on("uncaughtException", (err) => {
  console.error("[BusinessProcess Fatal Uncaught Exception]:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[BusinessProcess Fatal Unhandled Rejection]:", reason);
});

process.on("SIGINT", () => {
  console.log("[BusinessProcess] Señal SIGINT recibida, cerrando limpiamente");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[BusinessProcess] Señal SIGTERM recibida, cerrando limpiamente");
  process.exit(0);
});

console.log("==================================================");
console.log("🧩 [PIEZA: NEGOCIO, CRM Y WHATSAPP]");
console.log("   - Panel Web y REST API (Puerto 3000)");
console.log("   - Sincronizador de Leads y CRM Nexus");
console.log("   - Procesador del Buzón Outbox");
console.log("   - Worker y Línea de WhatsApp Baileys");
console.log("==================================================");

// Conectar con la telemetría en tiempo real del motor de voz
connectIpcClient(8089);

// Iniciar servidor web y dashboard
startWebServer();

// Iniciar procesador del buzón outbox
outboxService.startWorker();

// Iniciar worker de WhatsApp
whatsAppWorker.start();

// Auto-conectar sesión de WhatsApp Baileys si existen credenciales previas
const credsPath = path.resolve(process.cwd(), "data", "whatsapp_auth", "creds.json");
if (fs.existsSync(credsPath)) {
  console.log("[WhatsApp Baileys] Credenciales encontradas. Auto-conectando sesión existente...");
  baileysWhatsAppService.startConnection().catch((err) => {
    console.warn("[WhatsApp Baileys] No se pudo auto-conectar sesión:", err.message);
  });
}
