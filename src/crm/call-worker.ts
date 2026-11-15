import { runtimePolicy, communicationsBlockedMessage } from "../runtime-policy.js";
import { crmService } from "./crm-service.js";
import { crmStorage } from "./crm-storage.js";
import { dialNetelip, hangupNetelip } from "../bridge-manager.js";
import { appEvents } from "../events.js";
import { CallQueueItem, CallOutcomePayload } from "./types.js";
import { CallProgressState } from "../types.js";

export interface CallWorkerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  callCooldownMs: number;
  overrideHorario: boolean;
  mode: "netelip" | "simulation";
  campaignId?: string;
  dialTimeoutMs?: number;
}

export interface CallWorkerStatus {
  safety: ReturnType<typeof runtimePolicy>;
  running: boolean;
  activeCall: {
    callId: string;
    leadId: string;
    empresa: string;
    telefono: string;
    linea: string;
    lineaId: string;
    startedAt: string;
    state: CallProgressState;
  } | null;
  totalCallsTriggered: number;
  lastCallAt: string | null;
  config: CallWorkerConfig;
  lastLog: string;
}

export class CallWorker {
  private running = false;
  private stopPromise: Promise<{ success: boolean; message: string }> | null = null;
  private pendingDial: Promise<{ success: boolean; message: string }> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isStopping = false;
  private activeCall: CallWorkerStatus["activeCall"] = null;
  private totalCallsTriggered = 0;
  private lastCallAt: string | null = null;
  private lastLog = "Worker de llamadas inicializado en reposo";
  private activeEventHandler: ((event: any) => void) | null = null;
  private activeSafetyTimer: NodeJS.Timeout | null = null;
  private activeDialTimeoutTimer: NodeJS.Timeout | null = null;
  private activeCallWaitResolver: (() => void) | null = null;
  private activeCallFinisher: ((reason: string, outcomeDetail?: string, summary?: any) => void) | null = null;
  private inFlightProcessing: Promise<void> | null = null;

  private config: CallWorkerConfig = {
    enabled: false,
    pollIntervalMs: 5000,
    callCooldownMs: 10000,
    overrideHorario: false, // Por defecto en producción respeta rigurosamente el horario comercial
    mode: "simulation",
    dialTimeoutMs: 35000,
  };

  constructor(customConfig?: Partial<CallWorkerConfig>) {
    if (customConfig) {
      this.config = { ...this.config, ...customConfig };
    }
  }

  public start(): { success: boolean; message: string } {
    if (this.isStopping) {
      return { success: false, message: "El worker se está deteniendo. Espere a que finalice la liberación física." };
    }
    if (this.running) {
      return { success: true, message: "Worker de llamadas ya está en ejecución" };
    }

    // Al iniciar, reconciliar reservas huérfanas de ejecuciones previas anómalas
    if (runtimePolicy().realCallsEnabled) crmService.reconcileOrphanReservations();

    this.running = true;
    this.config.enabled = true;
    this.lastLog = `[${new Date().toLocaleTimeString()}] Worker de llamadas iniciado (Modo: ${this.config.mode})`;
    console.log(`[CallWorker] ${this.lastLog}`);

    this.scheduleNextTick(Math.min(1000, this.config.pollIntervalMs));
    return { success: true, message: "Worker de llamadas iniciado correctamente" };
  }

  public stop(): Promise<{ success: boolean; message: string }> {
    if (this.stopPromise) return this.stopPromise;
    this.running = false;
    this.config.enabled = false;
    this.isStopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.activeSafetyTimer) clearTimeout(this.activeSafetyTimer);
    if (this.activeDialTimeoutTimer) clearTimeout(this.activeDialTimeoutTimer);
    this.stopPromise = this.stopActiveCall().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private async stopActiveCall(): Promise<{ success: boolean; message: string }> {
    try {
      // A delayed dial acknowledgement must settle before the physical hangup.
      if (this.pendingDial) await this.pendingDial.catch(() => undefined);
      const active = this.activeCall;
      if (active && this.config.mode === "netelip") {
        const result = await hangupNetelip();
        if (!result.success) throw new Error(result.message || "No se confirmó el colgado");
      }
      if (this.activeCallFinisher) this.activeCallFinisher("parada_worker", "TERMINADO");
      else if (active) {
        crmService.releaseLeadReservation(active.leadId, active.lineaId, "parada_worker");
        this.activeCall = null;
      }
      if (this.activeSafetyTimer) clearTimeout(this.activeSafetyTimer);
      if (this.activeDialTimeoutTimer) clearTimeout(this.activeDialTimeoutTimer);
      this.activeSafetyTimer = this.activeDialTimeoutTimer = null;
      if (this.activeEventHandler) appEvents.off("ui-event", this.activeEventHandler);
      this.activeEventHandler = null;
      const resolve = this.activeCallWaitResolver;
      this.activeCallWaitResolver = null;
      resolve?.();
      if (this.inFlightProcessing) await this.inFlightProcessing;
      this.isProcessing = false;
      this.isStopping = false;
      this.lastLog = "Worker detenido; llamada liberada.";
      return { success: true, message: this.lastLog };
    } catch {
      this.lastLog = "Parada pendiente: no se confirmó el colgado. Reintenta detener antes de iniciar nuevas llamadas.";
      return { success: false, message: this.lastLog };
    }
  }

  public setConfig(update: Partial<CallWorkerConfig>): CallWorkerConfig {
    if ((this.running || this.isStopping || this.activeCall) && update.mode && update.mode !== this.config.mode) throw new Error("Detén la llamada antes de cambiar de modo");
    this.config = { ...this.config, ...update };
    this.lastLog = `[${new Date().toLocaleTimeString()}] Configuración de worker actualizada`;
    return this.config;
  }

  public getStatus(): CallWorkerStatus {
    return {
      safety: runtimePolicy(),
      running: this.running,
      activeCall: this.activeCall,
      totalCallsTriggered: this.totalCallsTriggered,
      lastCallAt: this.lastCallAt,
      config: { ...this.config },
      lastLog: this.lastLog,
    };
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running || this.isStopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.inFlightProcessing = this.tick()
        .catch((err) => {
          console.error("[CallWorker] Error en ciclo tick:", err);
          this.scheduleNextTick(this.config.pollIntervalMs);
        })
        .finally(() => {
          this.inFlightProcessing = null;
        });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.isProcessing) return;
    if (!runtimePolicy().realCallsEnabled) {
      this.lastLog = communicationsBlockedMessage;
      this.scheduleNextTick(this.config.pollIntervalMs);
      return;
    }

    this.isProcessing = true;
    try {
      // 1. Consultar siguiente lead en cola aplicando campaña si fue configurada
      const next = crmService.getNextCallLead({
        overrideHorario: this.config.overrideHorario,
        campaniaId: this.config.campaignId,
        isSimulation: this.config.mode === "simulation",
      });

      if (next.error) {
        this.lastLog = `[${new Date().toLocaleTimeString()}] En espera: ${next.error}`;
        this.isProcessing = false;
        this.scheduleNextTick(this.config.pollIntervalMs);
        return;
      }

      const item: CallQueueItem = next.item!;

      // Doble verificación de exclusión / lista Robinson inmediatamente antes de marcar
      if (crmService.isPhoneInRobinson(item.lead.telefono)) {
        console.warn(`[CallWorker] Contacto ${item.lead.telefono} detectado en lista de exclusión justo antes de marcar. Cancelando llamada.`);
        crmService.releaseLeadReservation(item.lead.id, item.linea.id, "rechazo");
        this.isProcessing = false;
        this.scheduleNextTick(this.config.pollIntervalMs);
        return;
      }

      this.totalCallsTriggered++;
      this.lastCallAt = new Date().toISOString();

      this.activeCall = {
        callId: item.callId,
        leadId: item.lead.id,
        empresa: item.lead.empresa_nombre,
        telefono: item.lead.telefono,
        linea: item.linea.nombre,
        lineaId: item.linea.id,
        startedAt: this.lastCallAt,
        state: "reservado",
      };

      this.lastLog = `[${new Date().toLocaleTimeString()}] Marcando a ${item.lead.empresa_nombre} (${item.lead.telefono}) vía ${item.linea.nombre} [CallId: ${item.callId}]`;
      console.log(`[CallWorker] >>> ${this.lastLog} <<<`);

      // Notificar al monitor web y motor que una llamada outbound ha comenzado con su callId unívoco
      appEvents.broadcast({
        type: "lead_call_start",
        lead: item.lead,
        linea: item.linea,
        callId: item.callId,
        sessionId: item.callId,
      });

      if (this.config.mode === "netelip") {
        this.activeCall.state = "marcando";
        this.pendingDial = dialNetelip(item.lead.telefono, item.lead.empresa_nombre, item.callId);
        const dialResult = await this.pendingDial.finally(() => { this.pendingDial = null; });
        if (this.isStopping || !this.running) return;
        if (!dialResult.success) {
          this.lastLog = `[${new Date().toLocaleTimeString()}] Fallo de marcado a ${item.lead.telefono}: ${dialResult.message}`;
          console.warn(`[CallWorker] ${this.lastLog}`);
          crmService.recordCallOutcome({
            callId: item.callId,
            sessionId: item.callId,
            lead_id: item.lead.id,
            linea_id: item.linea.id,
            resultado: "fallo_marcado",
            whatsappAuthorized: false,
            resumen: `Error al iniciar marcado en Netelip: ${dialResult.message}`,
          });
          this.activeCall = null;
          return;
        }

        // Marcado lanzado con éxito: mantener la línea ocupada y esperar confirmación física de fin de llamada
        const callStartTime = Date.now();
        const maxDurationMs = 180_000; // 3 minutos de duración máxima de seguridad
        const dialTimeoutMs = this.config.dialTimeoutMs || 35_000; // Timeout de descolgado

        await new Promise<void>((resolve) => {
          let resolved = false;
          let safetyTimer: NodeJS.Timeout | null = null;
          let dialTimeoutTimer: NodeJS.Timeout | null = null;

          this.activeCallWaitResolver = resolve;

          const finishCall = (reason: string, outcomeDetail?: string, summary?: any) => {
            if (resolved) return;
            resolved = true;
            this.activeCallWaitResolver = null;
            this.activeCallFinisher = null;
            if (safetyTimer) {
              clearTimeout(safetyTimer);
              safetyTimer = null;
            }
            if (dialTimeoutTimer) {
              clearTimeout(dialTimeoutTimer);
              dialTimeoutTimer = null;
            }
            this.activeSafetyTimer = null;
            this.activeDialTimeoutTimer = null;
            if (this.activeEventHandler) {
              appEvents.off("ui-event", this.activeEventHandler);
              this.activeEventHandler = null;
            }

            if (this.activeCall) {
              this.activeCall.state = "terminando";
            }

            const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
            this.lastLog = `[${new Date().toLocaleTimeString()}] Llamada Netelip finalizada (${reason}, ${durationSeconds}s)`;
            console.log(`[CallWorker] ${this.lastLog}`);

            if (reason === "parada_worker") {
              crmService.releaseLeadReservation(item.lead.id, item.linea.id, "parada_worker");
              if (this.activeCall) {
                this.activeCall.state = "finalizado";
              }
              this.activeCall = null;
              resolve();
              return;
            }

            // Determinar resultado comercial y persistir coherente en CRM
            let resultado: CallOutcomePayload["resultado"] = "colgado";
            if (reason === "timeout_sin_respuesta") {
              resultado = "no_contesta";
            } else if (reason === "error_proveedor") {
              resultado = "desconexion";
            } else if (outcomeDetail === "AUTORIZADO" || outcomeDetail === "autorizo_whatsapp") {
              resultado = "autorizo_whatsapp";
            } else if (outcomeDetail === "RECHAZADO" || outcomeDetail === "rechazo") {
              resultado = "rechazo";
            } else if (outcomeDetail === "PERSONA_EQUIVOCADA" || outcomeDetail === "numero_invalido") {
              resultado = "numero_invalido";
            } else if (outcomeDetail === "LLAMAR_DESPUES" || outcomeDetail === "volver_a_llamar") {
              resultado = "volver_a_llamar";
            }

            const isAuth = resultado === "autorizo_whatsapp" || Boolean(summary?.whatsappAuthorized);
            const quote = summary?.evidenceQuote || (summary as any)?.evidence_quote || (isAuth ? (item.lead.evidencia_consentimiento || "Sí, envíamelo por WhatsApp") : undefined);
            const phone = summary?.confirmedPhone || (summary as any)?.telefono_confirmado || item.lead.telefono;
            const transcriptsText = summary?.transcripts ? summary.transcripts.map((t: any) => `${t.role}: ${t.text}`).join("\n") : (summary?.userTranscripts ? summary.userTranscripts.join("\n") : undefined);

            try {
              crmService.recordCallOutcome({
                callId: item.callId,
                sessionId: item.callId,
                lead_id: item.lead.id,
                linea_id: item.linea.id,
                resultado,
                duracion_segundos: durationSeconds,
                whatsappAuthorized: isAuth,
                evidence_quote: isAuth ? quote : undefined,
                telefono_confirmado: isAuth ? phone : undefined,
                transcripcion: transcriptsText,
                resumen: `Llamada finalizada por: ${reason}${outcomeDetail ? ` (Detalle: ${outcomeDetail})` : ""}`,
              });
            } catch (err: any) {
              console.error("[CallWorker] Error registrando desenlace en CRM:", err.message);
              crmService.releaseLeadReservation(item.lead.id, item.linea.id, resultado);
            }

            if (this.activeCall) {
              this.activeCall.state = "finalizado";
            }
            this.activeCall = null;
            resolve();
          };

          this.activeCallFinisher = finishCall;

          const callEventHandler = (event: any) => {
            // Filtrar estrictamente eventos por sesión: ignorar cualquier evento de sesión ajena
            if (event.sessionId !== item.callId) {
              return;
            }

            if (event.type === "call_start" || (event.type === "state" && event.state === "speaking")) {
              if (this.activeCall && this.activeCall.callId === item.callId) {
                this.activeCall.state = "conectado";
              }
              if (dialTimeoutTimer) {
                clearTimeout(dialTimeoutTimer);
                dialTimeoutTimer = null;
                this.activeDialTimeoutTimer = null;
              }
            } else if (event.type === "call_end") {
              const summary = event.sessionSummary || {
                whatsappAuthorized: event.whatsappAuthorized,
                evidenceQuote: event.evidenceQuote || event.evidence_quote,
                confirmedPhone: event.confirmedPhone || event.confirmed_phone,
                transcripts: event.transcripts,
                userTranscripts: event.userTranscripts,
              };
              finishCall("colgado", event.outcome, summary);
            } else if (event.type === "provider_error") {
              finishCall("error_proveedor", event.error);
            }
          };

          this.activeEventHandler = callEventHandler;
          appEvents.on("ui-event", callEventHandler);

          dialTimeoutTimer = setTimeout(() => {
            if (this.activeCall && this.activeCall.state === "marcando") {
              console.warn(`[CallWorker] Timeout de descolgado (${dialTimeoutMs / 1000}s) sin respuesta en Netelip.`);
              hangupNetelip().catch(() => {});
              finishCall("timeout_sin_respuesta");
            }
          }, dialTimeoutMs);
          this.activeDialTimeoutTimer = dialTimeoutTimer;

          safetyTimer = setTimeout(() => {
            console.warn(`[CallWorker] Tiempo máximo de llamada alcanzado (${maxDurationMs / 1000}s). Forzando colgado en Netelip.`);
            hangupNetelip().catch(() => {});
            finishCall("timeout_duracion_maxima");
          }, maxDurationMs);
          this.activeSafetyTimer = safetyTimer;
        });
      } else {
        // En modo simulación / test autónomo:
        this.activeCall.state = "conectado";
        await new Promise<void>((resolve) => {
          this.activeCallWaitResolver = resolve;
          const simTimer = setTimeout(() => {
            this.activeCallWaitResolver = null;
            resolve();
          }, 2000);
          this.activeSafetyTimer = simTimer;
        });

        if (!this.running || this.isStopping) {
          if (this.activeCall) crmService.releaseLeadReservation(item.lead.id, item.linea.id, "parada_worker");
          this.activeCall = null;
          return;
        }

        const outcome: CallOutcomePayload = {
          callId: item.callId,
          sessionId: item.callId,
          lead_id: item.lead.id,
          linea_id: item.linea.id,
          resultado: "autorizo_whatsapp",
          whatsappAuthorized: true,
          evidence_quote: "Sí, envíamela sin problema",
          telefono_confirmado: item.lead.telefono,
          es_simulacion: true,
          duracion_segundos: 45,
          resumen: `Llamada simulada completada con éxito. Cliente ${item.lead.empresa_nombre} confirmó interés y autorizó muestra por WhatsApp.`,
        };

        crmService.recordCallOutcome(outcome);
        this.activeCall.state = "finalizado";
        this.lastLog = `[${new Date().toLocaleTimeString()}] Llamada simulada completada: ${item.lead.empresa_nombre} -> Autorizó WhatsApp (Simulación)`;
        console.log(`[CallWorker] ${this.lastLog}`);
      }

      this.activeCall = null;
    } catch (err: any) {
      this.lastLog = `[${new Date().toLocaleTimeString()}] Error procesando llamada: ${err.message}`;
      console.error("[CallWorker] Error:", err);
      if (this.isStopping) return; // The stop operation owns the physical release.
      if (this.activeCall) {
        crmService.releaseLeadReservation(this.activeCall.leadId, this.activeCall.lineaId);
      }
      this.activeCall = null;
    } finally {
      this.isProcessing = false;
      this.scheduleNextTick(this.config.callCooldownMs);
    }
  }
}

export const callWorker = new CallWorker();
