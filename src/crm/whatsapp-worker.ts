import { runtimePolicy, communicationsBlockedMessage } from "../runtime-policy.js";
import fs from "node:fs";
import path from "node:path";
import { dispatchWhatsAppProposal } from "../whatsapp/whatsapp-outbox-dispatcher.js";
import { crmService } from "./crm-service.js";
import { crmStorage, getMadridDateString } from "./crm-storage.js";
import { WhatsAppQueueItem, WhatsAppOutcomePayload } from "./types.js";
import { baileysWhatsAppService } from "../whatsapp/baileys-service.js";
import { isOptedOut } from "../whatsapp/opt-out.js";

export interface WhatsAppWorkerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  sendDelayMs: number;        // Intervalo base de seguridad anti-bloqueo
  jitterDelayMs: number;      // Variabilidad aleatoria humana en ms (ej: 5000)
  maxDailyMessages: number;   // Límite diario de seguridad (ej: 50)
  provider: "baileys" | "mock" | "webhook" | "wwebjs";
  webhookUrl?: string;
}

export interface WhatsAppWorkerStatus {
  safety: ReturnType<typeof runtimePolicy>;
  running: boolean;
  messagesSentToday: number;
  totalMessagesSent: number;
  lastSentAt: string | null;
  config: WhatsAppWorkerConfig;
  lastLog: string;
}

export class WhatsAppWorker {
  private external = false;
  private pending: Promise<void> | null = null;
  public isExternalService(): boolean { return this.external; }
  public useExternalService(): void { this.external = true; }
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private messagesSentToday = 0;
  private totalMessagesSent = 0;
  private lastDate = getMadridDateString();
  private lastSentAt: string | null = null;
  private lastLog = "Worker de WhatsApp inicializado en reposo";

  private config: WhatsAppWorkerConfig = {
    enabled: true,
    pollIntervalMs: 5000,
    sendDelayMs: 2000,        // Para agilidad en pruebas, ajustable en panel
    jitterDelayMs: 1000,
    maxDailyMessages: 50,
    provider: "baileys",
    webhookUrl: "http://localhost:3002/api/whatsapp/send",
  };

  constructor(customConfig?: Partial<WhatsAppWorkerConfig>) {
    try {
      const saved = (crmStorage.getDb().settings as any)?.whatsapp_worker_config;
      if (saved && typeof saved === "object") {
        this.config = { ...this.config, ...saved };
      }
    } catch {}
    if (customConfig) {
      this.config = { ...this.config, ...customConfig };
    }
  }

  public start(): { success: boolean; message: string } {
    if (this.running) {
      return { success: true, message: "Worker de WhatsApp ya está en ejecución" };
    }

    this.setConfig({ enabled: true });
    this.running = true;
    this.lastLog = `[${new Date().toLocaleTimeString()}] Worker de WhatsApp iniciado (Proveedor: ${this.config.provider})`;
    console.log(`[WhatsAppWorker] ${this.lastLog}`);

    if (!this.external) this.scheduleNextTick(1000);
    return { success: true, message: this.external ? "Envíos habilitados en el servicio externo" : "Worker de WhatsApp iniciado correctamente" };
  }

  public async stop(): Promise<{ success: boolean; message: string }> {
    this.setConfig({ enabled: false });
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending) await this.pending;
    this.lastLog = this.external
      ? "Pausa solicitada al servicio externo. Un envío ya iniciado puede terminar; no se iniciarán nuevos."
      : "Worker de WhatsApp detenido";
    return { success: true, message: this.lastLog };
  }

  public setConfig(update: Partial<WhatsAppWorkerConfig>): WhatsAppWorkerConfig {
    for (const field of ["pollIntervalMs", "sendDelayMs", "jitterDelayMs", "maxDailyMessages"] as const) {
      if (update[field] !== undefined && (!Number.isFinite(update[field]) || update[field]! < 0)) throw new Error(`Configuración no válida: ${field}`);
    }
    if (update.maxDailyMessages !== undefined && !Number.isInteger(update.maxDailyMessages)) throw new Error("Cuota diaria no válida");
    if (update.enabled !== undefined && typeof update.enabled !== "boolean") throw new Error("Estado no válido");
    if (update.provider && !["baileys", "mock", "webhook", "wwebjs"].includes(update.provider)) throw new Error("Proveedor no válido");
    const saved = crmStorage.transaction(db => {
      const settings = db.settings as any;
      return settings.whatsapp_worker_config = { ...this.config, ...settings.whatsapp_worker_config, ...update };
    });
    this.config = { ...saved };
    this.lastLog = "Configuración de WhatsApp actualizada";
    return { ...this.config };
  }

  public getStatus(): WhatsAppWorkerStatus {
    this.checkDailyReset();
    this.config = { ...this.config, ...(crmStorage.getDb().settings as any).whatsapp_worker_config };
    if (this.external) {
      const file = path.resolve(process.cwd(), "data", "whatsapp-status.json");
      let remote: any;
      try { remote = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const fresh = remote && Date.now() - Date.parse(remote.updatedAt) < 10_000;
      return { safety: runtimePolicy(), running: !!(fresh && remote.worker?.running), messagesSentToday: crmStorage.getDailyWhatsAppCount(), totalMessagesSent: 0,
        lastSentAt: null, config: { ...this.config }, lastLog: fresh ? (remote.worker?.lastError || (remote.worker?.busy ? "Finalizando envío en curso" : this.config.enabled ? "Servicio externo preparado" : "Servicio externo pausado")) : "El servicio externo no ha confirmado su estado" };
    }
    return {
      safety: runtimePolicy(),
      running: this.running,
      messagesSentToday: this.messagesSentToday,
      totalMessagesSent: this.totalMessagesSent,
      lastSentAt: this.lastSentAt,
      config: { ...this.config },
      lastLog: this.lastLog,
    };
  }

  private checkDailyReset(): void {
    const today = getMadridDateString();
    if (this.lastDate !== today) {
      this.messagesSentToday = 0;
      this.lastDate = today;
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running || this.external) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.pending = this.tick().catch((err) => {
        console.error("[WhatsAppWorker] Error en ciclo tick:", err);
        this.scheduleNextTick(this.config.pollIntervalMs);
      }).finally(() => { this.pending = null; });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.isProcessing || this.external) return;
    this.config = { ...this.config, ...(crmStorage.getDb().settings as any).whatsapp_worker_config };
    if (!this.config.enabled) { this.running = false; return; }

    if (!runtimePolicy().realWhatsAppEnabled) {
      this.lastLog = communicationsBlockedMessage;
      this.scheduleNextTick(this.config.pollIntervalMs);
      return;
    }
    this.checkDailyReset();

    // 1. Control de cuota diaria anti-ban de WhatsApp (persistida en almacenamiento)
    const messagesToday = crmStorage.getDailyWhatsAppCount();
    if (messagesToday >= this.config.maxDailyMessages) {
      this.lastLog = `[${new Date().toLocaleTimeString()}] Cuota diaria de WhatsApp alcanzada (${messagesToday}/${this.config.maxDailyMessages}). En pausa hasta mañana.`;
      this.scheduleNextTick(this.config.pollIntervalMs * 10);
      return;
    }

    this.isProcessing = true;
    try {
      // 2. Consultar siguiente lead en cola respetando el aislamiento entre simulación y producción
      const isMock = this.config.provider === "mock";
      const next = crmService.getNextWhatsAppLead({ isSimulation: isMock });
      if (next.error) {
        this.lastLog = `[${new Date().toLocaleTimeString()}] Cola vacía: ${next.error}`;
        this.isProcessing = false;
        this.scheduleNextTick(this.config.pollIntervalMs);
        return;
      }

      const item: WhatsAppQueueItem = next.item!;
      const phone = item.lead.telefono;
      const message = item.mensaje;

      // Comprobar lista de exclusión compartida (Opt-out)
      if (isOptedOut(phone) || (item.lead.telefono_confirmado && isOptedOut(item.lead.telefono_confirmado))) {
        this.lastLog = `[${new Date().toLocaleTimeString()}] ⛔ Lead ${item.lead.empresa_nombre} (${phone}) está en lista de exclusión. Marcando descartado.`;
        item.lead.estado = "descartado";
        item.lead.notas = `${item.lead.notas || ""}\n[Opt-out] Descartado por exclusión de número.`.trim();
        crmStorage.save();
        this.isProcessing = false;
        this.scheduleNextTick(1000);
        return;
      }

      // Comprobar deduplicación si el lead ya recibió mensaje previamente
      if ((item.lead.veces_whatsapp || 0) > 0 || item.lead.estado === "whatsapp_enviado") {
        this.lastLog = `[${new Date().toLocaleTimeString()}] ⏭️ Lead ${item.lead.empresa_nombre} (${phone}) ya recibió mensaje previamente. Evitando duplicado.`;
        item.lead.estado = "whatsapp_enviado";
        crmStorage.save();
        this.isProcessing = false;
        this.scheduleNextTick(1000);
        return;
      }

      this.lastLog = `[${new Date().toLocaleTimeString()}] Enviando WhatsApp a ${item.lead.empresa_nombre} (${phone})...`;
      console.log(`[WhatsAppWorker] >>> ${this.lastLog} <<<`);

      let sendSuccess = false;
      let errorReason: string | undefined = undefined;

      // 3. Envío según proveedor con manejo estricto de errores
      // Clave de idempotencia persistente en disco (conservada en reintentos y reinicios)
      const idempotencyKey = item.idempotency_key || item.lead.whatsapp_idempotency_key || `wa_${item.lead.id}`;
      if (this.config.provider === "webhook") {
        if (!this.config.webhookUrl) {
          sendSuccess = false;
          errorReason = "URL de webhook no configurada para el proveedor de WhatsApp.";
        } else {
          try {
            const controller = new AbortController();
            const timeoutTimer = setTimeout(() => controller.abort(), 10000);
            const resp = await fetch(this.config.webhookUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                phone,
                message,
                leadId: item.lead.id,
                idempotencyKey,
              }),
              signal: controller.signal,
            });
            clearTimeout(timeoutTimer);
            if (!resp.ok) {
              sendSuccess = false;
              errorReason = `Webhook error HTTP ${resp.status}: ${await resp.text()}`;
            } else {
              // Comprobar cuerpo de respuesta del proveedor (evitar dar por bueno un fallo encapsulado en HTTP 200)
              const contentType = resp.headers.get("content-type") || "";
              if (contentType.includes("application/json")) {
                try {
                  const data = (await resp.json()) as any;
                  if (data && (data.success === false || data.status === "failed" || data.status === "error" || data.error)) {
                    sendSuccess = false;
                    errorReason = data.error || data.message || `Proveedor reportó fallo: status=${data.status}`;
                  } else {
                    sendSuccess = true;
                  }
                } catch {
                  sendSuccess = true;
                }
              } else {
                sendSuccess = true;
              }
            }
          } catch (e: any) {
            sendSuccess = false;
            errorReason = `Fallo de conexión o timeout con pasarela WhatsApp: ${e.message}`;
          }
        }
      } else if (this.config.provider === "baileys") {
        const result = await dispatchWhatsAppProposal({ callId: idempotencyKey, leadId: item.lead.id, confirmedPhone: item.lead.telefono_confirmado, phone });
        this.messagesSentToday = crmStorage.getDailyWhatsAppCount();
        this.lastLog = result === "uncertain" ? "Entrega incierta; revisión manual necesaria, sin reenvío automático" : "Propuesta procesada";
        return;
      } else if (this.config.provider === "wwebjs") {
        sendSuccess = false;
        errorReason = "Proveedor 'wwebjs' no está implementado en este entorno local. Use 'baileys' (código QR directo), 'mock' o 'webhook'.";
      } else if (isMock) {
        // Modo mock/simulado para pruebas
        sendSuccess = true;
      } else {
        sendSuccess = false;
        errorReason = `Proveedor desconocido: ${this.config.provider}`;
      }

      // 4. Registrar resultado
      const outcome: WhatsAppOutcomePayload = {
        lead_id: item.lead.id,
        success: sendSuccess,
        error: errorReason,
        mensaje_enviado: message,
        es_simulacion: isMock,
      };

      crmService.recordWhatsAppOutcome(outcome);

      if (sendSuccess) {
        if (!isMock) {
          this.messagesSentToday = crmStorage.incrementDailyWhatsAppCount();
        } else {
          this.messagesSentToday++;
        }
        this.totalMessagesSent++;
        this.lastSentAt = new Date().toISOString();
        this.lastLog = `[${new Date().toLocaleTimeString()}] WhatsApp enviado exitosamente a ${item.lead.empresa_nombre} (${phone}) [${isMock ? "Simulación" : "Producción"}]`;
      } else {
        this.lastLog = `[${new Date().toLocaleTimeString()}] Fallo de envío a ${phone}: ${errorReason}`;
      }

      console.log(`[WhatsAppWorker] ${this.lastLog}`);
    } catch (err: any) {
      this.lastLog = `[${new Date().toLocaleTimeString()}] Error en worker WhatsApp: ${err.message}`;
      console.error("[WhatsAppWorker] Error:", err);
    } finally {
      this.isProcessing = false;
      // Añadir jitter humano aleatorio entre envíos
      const jitter = Math.floor(Math.random() * (this.config.jitterDelayMs || 1000));
      const nextDelay = this.config.sendDelayMs + jitter;
      this.scheduleNextTick(nextDelay);
    }
  }

  public async sendViaWwebjs(phone: string, message: string): Promise<void> {
    throw new Error("Proveedor 'wwebjs' no está implementado en este entorno local. Use 'mock' para pruebas o configure 'webhook' hacia una pasarela activa.");
  }
}

export const whatsAppWorker = new WhatsAppWorker();
