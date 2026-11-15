import { runtimePolicy } from "./runtime-policy.js";
import { whatsAppWorker } from "./crm/whatsapp-worker.js";
import "dotenv/config";
import { startWebServer, recordCompletedCall } from "./web-server.js";
import { OutboxConsumer } from "./outbox/outbox-consumer.js";
import { connectIpcClient } from "./events-ipc.js";
import { crmStorage } from "./crm/crm-storage.js";
import { normalizeSpanishPhone } from "./utils/phone-utils.js";

process.on("uncaughtException", (err) => {
  console.error("[CrmWebProcess Fatal Uncaught Exception]:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[CrmWebProcess Fatal Unhandled Rejection]:", reason);
});

process.on("SIGINT", () => {
  console.log("[CrmWebProcess] Señal SIGINT recibida, cerrando limpiamente");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[CrmWebProcess] Señal SIGTERM recibida, cerrando limpiamente");
  process.exit(0);
});

console.log("==================================================");
console.log("🌐 [SERVICIO 2: CRM, PANEL WEB Y CONFIGURACIÓN]");
console.log("   - Dashboard y REST API: http://127.0.0.1:3000");
console.log("   - Sincronizador de Leads y CRM Nexus");
console.log("   - Consumidor de Buzón Outbox (Cola: crm)");
console.log("   - Telemetría en vivo vía IPC (Puerto 8089)");
console.log("==================================================");

whatsAppWorker.useExternalService();

// 1. Conectar al bus de telemetría de voz en tiempo real
connectIpcClient(8089);

// 2. Iniciar consumidor de la cola Outbox dedicada al CRM
const crmConsumer = new OutboxConsumer({
  queueName: "crm",
  canProcess: () => !runtimePolicy().controlOnly,
  pollIntervalMs: 2000,
  handler: async (event) => {
    try {
      if (event.type === "call_completed") {
        recordCompletedCall(event.payload);
      } else if (event.type === "phone_confirmed") {
        const db = crmStorage.getDb();
        const targetPhone = event.payload.phone;
        const norm = normalizeSpanishPhone(targetPhone) || targetPhone;
        const lead = db.leads.find((l) => l.telefono === norm || l.telefono_original === targetPhone || l.place_id === event.callId);
        if (lead) {
          lead.telefono_confirmado = targetPhone;
          lead.updated_at = new Date().toISOString();
          crmStorage.save();
        }
      } else if (event.type === "whatsapp_authorized") {
        const db = crmStorage.getDb();
        const targetPhone = event.payload.confirmedPhone || event.payload.phone;
        const norm = normalizeSpanishPhone(targetPhone) || targetPhone;
        const lead = db.leads.find((l) => l.telefono === norm || l.telefono_original === targetPhone || l.place_id === event.callId);
        if (lead) {
          lead.consentimiento_whatsapp = true;
          lead.estado = "enviando_whatsapp";
          lead.calificacion = "caliente";
          lead.telefono_confirmado = targetPhone;
          lead.evidencia_consentimiento = event.payload.evidenceQuote || "Autorizado en llamada";
          lead.updated_at = new Date().toISOString();
          crmStorage.save();
        }
      } else if (event.type === "contact_opted_out") {
        const db = crmStorage.getDb();
        const targetPhone = event.payload.phone;
        const norm = normalizeSpanishPhone(targetPhone) || targetPhone;
        const lead = db.leads.find((l) => l.telefono === norm || l.telefono_original === targetPhone || l.place_id === event.callId);
        if (lead) {
          lead.estado = "descartado";
          lead.notas = `${lead.notas || ""}\n[Opt-out] Rechazó recibir comunicaciones comerciales (${event.payload.reason || "llamada"}).`.trim();
          lead.updated_at = new Date().toISOString();
          crmStorage.save();
        }
      }
      return true;
    } catch (err: any) {
      console.error(`[CrmConsumer] Error procesando evento ${event.type}:`, err.message);
      return false;
    }
  },
});

crmConsumer.start();

// 3. Iniciar servidor web en puerto 3000
startWebServer();
