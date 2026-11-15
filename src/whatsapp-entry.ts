import { runtimePolicy } from "./runtime-policy.js";
import { processWhatsAppControls } from "./whatsapp/service-control.js";
import { crmStorage } from "./crm/crm-storage.js";
import { atomicWriteJson } from "./storage.js";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { baileysWhatsAppService } from "./whatsapp/baileys-service.js";
import { OutboxConsumer, OutboxProcessResult } from "./outbox/outbox-consumer.js";
import { OutboxEvent } from "./outbox/outbox-types.js";
import { addToOptOut } from "./whatsapp/opt-out.js";
import { dispatchWhatsAppProposal, dispatchHumanTransferAlert } from "./whatsapp/whatsapp-outbox-dispatcher.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATUS_FILE = path.join(DATA_DIR, "whatsapp-status.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 1. Auto-conectar sesión de Baileys si existen credenciales o iniciar servicio
const credsPath = path.join(DATA_DIR, "whatsapp_auth", "creds.json");
if (fs.existsSync(credsPath)) {
  console.log("[WhatsApp Baileys] Credenciales encontradas. Auto-conectando sesión existente...");
}
baileysWhatsAppService.startConnection().catch((err) => {
  console.warn("[WhatsApp Baileys] Estado inicial:", err.message);
});

// 2. Publicar estado atómico en disco para que el panel web (Servicio 2) pueda leer QR/estado
setInterval(() => {
  try {
    const status = baileysWhatsAppService.getStatus();
    atomicWriteJson(STATUS_FILE, { ...status, worker: { running: enabled(), safety: runtimePolicy(), busy: whatsappConsumer.busy, lastError: whatsappConsumer.lastError }, pid: process.pid });
  } catch { console.error("No se pudo publicar el estado del servicio WhatsApp"); }
}, 2000);

// 3. Consumidor del Buzón de Salida dedicado exclusivamente a WhatsApp
const enabled = () => (crmStorage.getDb().settings as any).whatsapp_worker_config?.enabled === true;
const whatsappConsumer = new OutboxConsumer({
  queueName: "whatsapp",
  pollIntervalMs: 2500,
  maxRetries: 3,
  canProcess: () => enabled() && runtimePolicy().realWhatsAppEnabled,
  handler: async (event: OutboxEvent): Promise<OutboxProcessResult> => {
    // 3.1. Evento de exclusión comercial (Opt-out)
    if (event.type === "contact_opted_out") {
      const phone = event.payload.phone;
      if (phone) {
        addToOptOut(phone);
      }
      return true;
    }

    // 3.2. Alerta urgente de transferencia a humano (Miguel)
    if (event.type === "human_transfer_requested") {
      return await dispatchHumanTransferAlert(event.payload);
    }

    // 3.3. Envío de muestra autorizada por WhatsApp (Deduplicado con control de cuota)
    if (event.type === "whatsapp_authorized") {
      return await dispatchWhatsAppProposal({
        callId: event.callId,
        confirmedPhone: event.payload.confirmedPhone,
        phone: event.payload.phone,
        company: event.payload.company,
        evidenceQuote: event.payload.evidenceQuote,
      });
    }

    return true;
  },
});

whatsappConsumer.start();

let controlBusy = false;
setInterval(() => {
  if (controlBusy) return;
  controlBusy = true;
  void processWhatsAppControls(baileysWhatsAppService).catch(() => console.error("No se pudo procesar el control de WhatsApp")).finally(() => { controlBusy = false; });
}, 250);
