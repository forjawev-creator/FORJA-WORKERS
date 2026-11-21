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
const TRANSCRIPT_POLICY_FILE = path.resolve(process.cwd(), "data", "transcript-policy.json");
function authorizedTranscriptRetention(): number | null {
  try {
    const policy: unknown = JSON.parse(fs.readFileSync(TRANSCRIPT_POLICY_FILE, "utf8"));
    if (!policy || typeof policy !== "object") return null;
    const p = policy as Record<string, unknown>;
    if (p.enabled !== true || !Number.isInteger(p.retentionDays) || Number(p.retentionDays) < 1 || Number(p.retentionDays) > 30 ||
        typeof p.authorizedBy !== "string" || p.authorizedBy.trim().length < 1 || p.authorizedBy.length > 160 ||
        typeof p.authorizedAt !== "string" || !Number.isFinite(Date.parse(p.authorizedAt)) || Date.parse(p.authorizedAt) > Date.now()) return null;
    return Number(p.retentionDays);
  } catch { return null; }
}


export class OutboxProducer {
  constructor() {
    this.ensureDirs();
    const retentionTimer = setInterval(() => { this.pruneExpiredTranscripts(); }, 60 * 60 * 1000);
    retentionTimer.unref();
  }

  /** Only new, explicitly policy-tagged transcripts are eligible; legacy files are untouched. */
  public pruneExpiredTranscripts(): number {
    // Revoking future collection must not extend an already recorded expiry.
    let removed = 0;
    try {
      for (const name of fs.readdirSync(TRANSCRIPTS_DIR).slice(0, 1000)) {
        if (!/^[a-zA-Z0-9_-]{1,160}\.json$/.test(name)) continue;
        const file = path.join(TRANSCRIPTS_DIR, name);
        try {
          const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
          if (!data || typeof data !== "object") continue;
          const item = data as Record<string, unknown>;
          if (item.policyVersion !== 1 || item.callId !== name.slice(0, -5) || typeof item.expiresAt !== "string") continue;
          const expiry = Date.parse(item.expiresAt);
          if (Number.isFinite(expiry) && expiry <= Date.now()) { fs.unlinkSync(file); removed++; }
        } catch { console.error("[OutboxProducer] No se pudo aplicar la retención a una transcripción."); }
      }
    } catch { console.error("[OutboxProducer] No se pudo comprobar la retención de transcripciones."); }
    return removed;
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

      fs.writeFileSync(tempFile, JSON.stringify(event, null, 2), { encoding: "utf8", mode: 0o600, flush: true });
      fs.renameSync(tempFile, targetFile);
      console.log(`[OutboxProducer] 📬 [${queueName.toUpperCase()}] Evento encolado: ${event.type} (${event.eventId})`);
    } catch (err: any) {
      console.error(`[OutboxProducer] Error escribiendo evento ${event.eventId} a cola ${queueName}:`, err.message);
      throw err;
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
    payload: Omit<CompletedCallOutboxPayload, "transcriptPath"> & { transcript?: Array<{ role: string; text: string; timestamp?: string }>; transcriptAuthorized?: boolean }
  ): string {
    const eventId = `evt_${Date.now()}_cc_${crypto.randomBytes(3).toString("hex")}`;
    const callId = payload.sessionId;
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(callId)) throw new Error("Identificador de llamada inválido");

    // Guardar transcripción completa por separado para retención y ligereza de eventos
    let transcriptPath: string | undefined = undefined;
    const retentionDays = authorizedTranscriptRetention();
    if (retentionDays !== null && payload.transcriptAuthorized === true && payload.transcript && payload.transcript.length > 0) {
      try {
        if (!fs.existsSync(TRANSCRIPTS_DIR)) {
          fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
        }
        transcriptPath = path.join(TRANSCRIPTS_DIR, `${callId}.json`);
        fs.writeFileSync(
          transcriptPath + ".tmp",
          JSON.stringify({ policyVersion: 1, callId, timestamp: new Date().toISOString(), expiresAt: new Date(Date.now() + retentionDays * 86400000).toISOString(), transcript: payload.transcript }, null, 2),
          { encoding: "utf8", mode: 0o600, flush: true }
        );
        fs.renameSync(transcriptPath + ".tmp", transcriptPath);
      } catch (err: any) {
        throw new Error("No se pudo guardar la transcripción: " + err.message);
      }
    }

    const { transcript, transcriptAuthorized, ...cleanPayload } = payload;
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
