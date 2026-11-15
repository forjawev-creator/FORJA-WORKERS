import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  OutboxEvent,
  OutboxEventType,
  PhoneConfirmedPayload,
  WhatsAppAuthorizedPayload,
  ContactOptedOutPayload,
  HumanTransferPayload,
  CompletedCallOutboxPayload,
} from "./outbox-types.js";

const BASE_OUTBOX_DIR = path.resolve(process.cwd(), "data", "outbox");
const TRANSCRIPTS_DIR = path.resolve(process.cwd(), "data", "transcripts");

export class OutboxProducer {
  constructor() {
    this.ensureDirs();
  }

  private ensureDirs(): void {
    const targets = [
      path.join(BASE_OUTBOX_DIR, "crm", "pending"),
      path.join(BASE_OUTBOX_DIR, "crm", "processing"),
      path.join(BASE_OUTBOX_DIR, "crm", "completed"),
      path.join(BASE_OUTBOX_DIR, "crm", "failed"),
      path.join(BASE_OUTBOX_DIR, "whatsapp", "pending"),
      path.join(BASE_OUTBOX_DIR, "whatsapp", "processing"),
      path.join(BASE_OUTBOX_DIR, "whatsapp", "completed"),
      path.join(BASE_OUTBOX_DIR, "whatsapp", "uncertain"),
      path.join(BASE_OUTBOX_DIR, "whatsapp", "failed"),
      TRANSCRIPTS_DIR,
    ];
    for (const dir of targets) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private writeAtomicToQueue(queueName: "crm" | "whatsapp", event: OutboxEvent): void {
    try {
      const queuePendingDir = path.join(BASE_OUTBOX_DIR, queueName, "pending");
      if (!fs.existsSync(queuePendingDir)) {
        fs.mkdirSync(queuePendingDir, { recursive: true });
      }

      const tempFile = path.join(queuePendingDir, `${event.eventId}.tmp`);
      const targetFile = path.join(queuePendingDir, `${event.eventId}.json`);

      fs.writeFileSync(tempFile, JSON.stringify(event, null, 2), "utf-8");
      fs.renameSync(tempFile, targetFile);
      console.log(`[OutboxProducer] 📬 [${queueName.toUpperCase()}] Evento encolado: ${event.type} (${event.eventId})`);
    } catch (err: any) {
      console.error(`[OutboxProducer] Error escribiendo evento ${event.eventId} a cola ${queueName}:`, err.message);
    }
  }

  public emitPhoneConfirmed(callId: string, payload: PhoneConfirmedPayload): string {
    const eventId = `evt_${Date.now()}_pc_${crypto.randomBytes(3).toString("hex")}`;
    const event: OutboxEvent<PhoneConfirmedPayload> = {
      eventId,
      callId,
      type: "phone_confirmed",
      createdAt: new Date().toISOString(),
      idempotencyKey: `${callId}:phone_confirmed:${payload.phone}`,
      payload,
    };
    this.writeAtomicToQueue("crm", event);
    return eventId;
  }

  public emitWhatsAppAuthorized(callId: string, payload: WhatsAppAuthorizedPayload): string {
    const eventId = `evt_${Date.now()}_wa_${crypto.randomBytes(3).toString("hex")}`;
    const event: OutboxEvent<WhatsAppAuthorizedPayload> = {
      eventId,
      callId,
      type: "whatsapp_authorized",
      createdAt: new Date().toISOString(),
      idempotencyKey: `${callId}:whatsapp_authorized:${payload.confirmedPhone || payload.phone}`,
      payload,
    };
    // Fan-out: Ambos servicios (CRM y WhatsApp) reciben su copia independiente
    this.writeAtomicToQueue("crm", event);
    this.writeAtomicToQueue("whatsapp", event);
    return eventId;
  }

  public emitContactOptedOut(callId: string, payload: ContactOptedOutPayload): string {
    const eventId = `evt_${Date.now()}_optout_${crypto.randomBytes(3).toString("hex")}`;
    const event: OutboxEvent<ContactOptedOutPayload> = {
      eventId,
      callId,
      type: "contact_opted_out",
      createdAt: new Date().toISOString(),
      idempotencyKey: `${callId}:contact_opted_out:${payload.phone}`,
      payload,
    };
    this.writeAtomicToQueue("crm", event);
    this.writeAtomicToQueue("whatsapp", event);
    return eventId;
  }

  public emitHumanTransferRequested(callId: string, payload: HumanTransferPayload): string {
    const eventId = `evt_${Date.now()}_ht_${crypto.randomBytes(3).toString("hex")}`;
    const event: OutboxEvent<HumanTransferPayload> = {
      eventId,
      callId,
      type: "human_transfer_requested",
      createdAt: new Date().toISOString(),
      idempotencyKey: `${callId}:human_transfer:${payload.phone || "unknown"}`,
      payload,
    };
    this.writeAtomicToQueue("whatsapp", event);
    return eventId;
  }

  public emitCallCompleted(
    payload: Omit<CompletedCallOutboxPayload, "transcriptPath"> & { transcript?: Array<{ role: string; text: string; timestamp?: string }> }
  ): string {
    const eventId = `evt_${Date.now()}_cc_${crypto.randomBytes(3).toString("hex")}`;
    const callId = payload.sessionId;

    // Guardar transcripción completa por separado para retención y ligereza de eventos
    let transcriptPath: string | undefined = undefined;
    if (payload.transcript && payload.transcript.length > 0) {
      try {
        if (!fs.existsSync(TRANSCRIPTS_DIR)) {
          fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
        }
        transcriptPath = path.join(TRANSCRIPTS_DIR, `${callId}.json`);
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify({ callId, timestamp: new Date().toISOString(), transcript: payload.transcript }, null, 2),
          "utf-8"
        );
      } catch (err: any) {
        console.warn(`[OutboxProducer] Advertencia guardando transcripción de ${callId}:`, err.message);
      }
    }

    const { transcript, ...cleanPayload } = payload;
    const completedPayload: CompletedCallOutboxPayload = {
      ...cleanPayload,
      transcriptPath,
    };

    const event: OutboxEvent<CompletedCallOutboxPayload> = {
      eventId,
      callId,
      type: "call_completed",
      createdAt: new Date().toISOString(),
      idempotencyKey: `${callId}:call_completed`,
      payload: completedPayload,
    };

    this.writeAtomicToQueue("crm", event);
    return eventId;
  }
}

export const outboxProducer = new OutboxProducer();
