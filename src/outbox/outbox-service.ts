import { runtimePolicy } from "../runtime-policy.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CompletedCallPayload, recordCompletedCall } from "../web-server.js";
import { OutboxConsumer, OutboxProcessResult } from "./outbox-consumer.js";
import { OutboxEvent } from "./outbox-types.js";
import { crmStorage } from "../crm/crm-storage.js";
import { normalizeSpanishPhone } from "../utils/phone-utils.js";
import { addToOptOut } from "../whatsapp/opt-out.js";
import { dispatchWhatsAppProposal, dispatchHumanTransferAlert } from "../whatsapp/whatsapp-outbox-dispatcher.js";
import { outboxProducer } from "./outbox-producer.js";

const BASE_OUTBOX_DIR = path.resolve(process.cwd(), "data", "outbox");

export interface OutboxCallEvent extends CompletedCallPayload {
  eventId: string;
  createdAt: string;
}

export class OutboxService {
  private crmConsumer: OutboxConsumer;
  private whatsappConsumer: OutboxConsumer;
  private running = false;

  constructor() {
    this.crmConsumer = new OutboxConsumer({
      queueName: "crm",
      pollIntervalMs: 2000,
      handler: async (event: OutboxEvent): Promise<OutboxProcessResult> => {
        try {
          if (event.type === "call_completed") {
            recordCompletedCall(event.payload);
          } else if (event.type === "phone_confirmed") {
            const db = crmStorage.getDb();
            const targetPhone = event.payload.phone;
            const norm = normalizeSpanishPhone(targetPhone) || targetPhone;
            const lead = db.leads.find(
              (l) => l.telefono === norm || l.telefono_original === targetPhone || l.place_id === event.callId
            );
            if (lead) {
              lead.telefono_confirmado = targetPhone;
              lead.updated_at = new Date().toISOString();
              crmStorage.save();
            }
          } else if (event.type === "whatsapp_authorized") {
            const db = crmStorage.getDb();
            const targetPhone = event.payload.confirmedPhone || event.payload.phone;
            const norm = normalizeSpanishPhone(targetPhone) || targetPhone;
            const lead = db.leads.find(
              (l) => l.telefono === norm || l.telefono_original === targetPhone || l.place_id === event.callId
            );
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
            const lead = db.leads.find(
              (l) => l.telefono === norm || l.telefono_original === targetPhone || l.place_id === event.callId
            );
            if (lead) {
              lead.estado = "descartado";
              lead.notas = `${lead.notas || ""}\n[Opt-out] Rechazó recibir comunicaciones comerciales (${event.payload.reason || "llamada"}).`.trim();
              lead.updated_at = new Date().toISOString();
              crmStorage.save();
            }
          }
          return true;
        } catch (err: any) {
          console.error(`[OutboxService:CRM] Error procesando evento ${event.eventId}:`, err.message);
          return false;
        }
      },
    });

    this.whatsappConsumer = new OutboxConsumer({
      queueName: "whatsapp",
      canProcess: () => runtimePolicy().realWhatsAppEnabled && (crmStorage.getDb().settings as any).whatsapp_worker_config?.enabled === true,
      pollIntervalMs: 2500,
      maxRetries: 3,
      handler: async (event: OutboxEvent): Promise<OutboxProcessResult> => {
        if (event.type === "contact_opted_out") {
          const phone = event.payload.phone;
          if (phone) {
            addToOptOut(phone);
          }
          return true;
        }

        if (event.type === "human_transfer_requested") {
          return await dispatchHumanTransferAlert(event.payload);
        }

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
  }

  /**
   * Migra eventos huérfanos del formato legado (data/outbox/*.json) a las nuevas colas separadas
   */
  private migrateLegacyFiles(): void {
    try {
      if (!fs.existsSync(BASE_OUTBOX_DIR)) return;
      const crmPendingDir = path.join(BASE_OUTBOX_DIR, "crm", "pending");
      if (!fs.existsSync(crmPendingDir)) {
        fs.mkdirSync(crmPendingDir, { recursive: true });
      }

      const files = fs
        .readdirSync(BASE_OUTBOX_DIR)
        .filter((f) => f.endsWith(".json") && f.startsWith("evt_"));

      for (const file of files) {
        const srcPath = path.join(BASE_OUTBOX_DIR, file);
        const destPath = path.join(crmPendingDir, file);
        try {
          fs.renameSync(srcPath, destPath);
          console.log(`[OutboxService] 📦 Evento legado ${file} migrado a crm/pending/`);
        } catch {}
      }
    } catch (err: any) {
      console.warn("[OutboxService] Aviso comprobando archivos legados:", err.message);
    }
  }

  public emitCallCompleted(payload: CompletedCallPayload): string {
    return outboxProducer.emitCallCompleted({
      ...payload,
      sessionId: payload.sessionId || `call_${Date.now()}`,
    });
  }

  public async processPendingEvents(): Promise<number> {
    this.migrateLegacyFiles();
    const crmCount = await this.crmConsumer.processNextBatch();
    const waCount = await this.whatsappConsumer.processNextBatch();
    return crmCount + waCount;
  }

  public startWorker(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[OutboxService] 🚀 Iniciando consumidores unificados de buzón (Colas: crm y whatsapp)`);
    this.migrateLegacyFiles();
    this.crmConsumer.start();
    this.whatsappConsumer.start();
  }

  public stopWorker(): void {
    this.running = false;
    this.crmConsumer.stop();
    this.whatsappConsumer.stop();
    console.log("[OutboxService] 🛑 Consumidores unificados de buzón detenidos");
  }
}

export const outboxService = new OutboxService();
