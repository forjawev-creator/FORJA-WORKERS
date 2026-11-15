import { ContextStore } from "./context-store.js";
import { HandoffState, AssistantRole, CallOutcomeStatus } from "./types.js";
import { normalizeSpanishPhone, normalizeSpokenSpanishDigits } from "./utils/phone-utils.js";
import { loadConfig } from "./storage.js";
import { outboxProducer } from "./outbox/outbox-producer.js";
import { sendNetelipCommand } from "./bridge-manager.js";

export interface HandoffOptions {
  handoffTimeoutMs?: number;
  onStateChange: (state: HandoffState, detail?: string) => void;
  onAnnouncePhrase: (phrase: string) => Promise<void>;
  onWaitForPlaybackDrain?: () => Promise<void>;
  onSwitchSession: (technicalSession: any) => Promise<void>;
  createTechnicalSession: () => Promise<any>;
}

export class HandoffController {
  private state: HandoffState = "idle";
  private transferCount: number = 0;
  private maxTransfers: number = 1;
  private handoffTimeoutMs: number;
  private activeAbortController: AbortController | null = null;
  private pendingTechnicalSession: any = null;

  constructor(
    private readonly contextStore: ContextStore,
    private readonly options: HandoffOptions
  ) {
    this.handoffTimeoutMs = options.handoffTimeoutMs || 8000;
  }

  public getState(): HandoffState {
    return this.state;
  }

  public getTransferCount(): number {
    return this.transferCount;
  }

  private setState(newState: HandoffState, detail?: string): void {
    this.state = newState;
    this.options.onStateChange(newState, detail);
  }

  /**
   * Cancela de forma inmediata y definitiva cualquier traspaso en curso
   */
  public cancel(reason: string = "canceled"): void {
    if (this.state === "preparing" || this.state === "announcing" || this.state === "draining" || this.state === "switching") {
      console.warn(`[HandoffController] Cancelando traspaso en curso por: ${reason}`);
      if (this.activeAbortController) {
        this.activeAbortController.abort();
        this.activeAbortController = null;
      }
      if (this.pendingTechnicalSession) {
        try {
          if (typeof this.pendingTechnicalSession.close === "function") {
            this.pendingTechnicalSession.close();
          } else if (this.pendingTechnicalSession.ws) {
            this.pendingTechnicalSession.ws.close();
          }
        } catch {}
        this.pendingTechnicalSession = null;
      }
      this.setState("failed", `Cancelado: ${reason}`);
      this.contextStore.setRole("commercial");
    }
  }

  /**
   * Valida e inicia el traspaso comercial -> técnico
   */
  public async executeTransfer(args: {
    reason?: string;
    customer_question?: string;
    facts_to_preserve?: string[];
  }): Promise<{ success: boolean; message: string }> {
    // 1. Validar condiciones
    if (this.transferCount >= this.maxTransfers) {
      return { success: false, message: "Límite máximo de traspasos alcanzado para esta llamada." };
    }

    if (this.state !== "idle") {
      return { success: false, message: `Traspaso ya en curso (${this.state}).` };
    }

    const question = args.customer_question?.trim();
    if (!question || question.length < 3) {
      return { success: false, message: "Se requiere la duda concreta del cliente para el traspaso." };
    }

    // Tomar handoff lock
    this.transferCount++;
    this.setState("preparing", `Iniciando sesión técnica para responder: "${question}"`);

    // Actualizar ContextStore con los datos del traspaso
    this.contextStore.setExactQuestion(question);
    if (args.facts_to_preserve && Array.isArray(args.facts_to_preserve)) {
      for (const fact of args.facts_to_preserve) {
        this.contextStore.addConfirmedFact(fact);
      }
    }

    const abortCtrl = new AbortController();
    this.activeAbortController = abortCtrl;
    let timeoutTimer: NodeJS.Timeout | null = null;

    try {
      // 2. Temporizador de seguridad con cancelación activa
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          abortCtrl.abort();
          reject(new Error(`Timeout de traspaso técnico (${this.handoffTimeoutMs} ms excedido)`));
        }, this.handoffTimeoutMs);
      });

      // 3. Crear sesión técnica en segundo plano
      const preparePromise = (async () => {
        // Crear conexión técnica rastreando su promesa para destruir cualquier sesión que termine tras la cancelación
        const sessionPromise = this.options.createTechnicalSession();
        sessionPromise
          .then((sess) => {
            if (abortCtrl.signal.aborted || this.state === "failed" || this.state === "idle") {
              console.warn("[HandoffController] Sesión técnica creada tarde tras cancelación/timeout. Destruyendo inmediatamente.");
              if (sess && typeof (sess as any).close === "function") {
                try { (sess as any).close(); } catch {}
              }
              if (sess && (sess as any).ws) {
                try {
                  if (typeof (sess as any).ws.terminate === "function") {
                    (sess as any).ws.terminate();
                  } else if (typeof (sess as any).ws.close === "function") {
                    (sess as any).ws.close();
                  }
                } catch {}
              }
            }
          })
          .catch(() => {});

        const technicalSession = await sessionPromise;
        this.pendingTechnicalSession = technicalSession;

        if (abortCtrl.signal.aborted) {
          throw new Error("Traspaso cancelado durante la creación de la sesión técnica.");
        }

        // 4. Locución de cortesía anunciando el traspaso
        this.setState("announcing", "Emitiendo locución de traspaso");
        const courtesyPhrase = "Un momento, te paso con el asistente técnico, que te va a resolver esa duda.";
        await this.options.onAnnouncePhrase(courtesyPhrase);

        if (abortCtrl.signal.aborted) {
          throw new Error("Traspaso cancelado tras locución de cortesía.");
        }

        // 5. Esperar estrictamente a que termine la reproducción física del audio de la locución
        this.setState("draining", "Esperando fin de reproducción física de la locución");
        if (this.options.onWaitForPlaybackDrain) {
          await this.options.onWaitForPlaybackDrain();
        }

        if (abortCtrl.signal.aborted) {
          throw new Error("Traspaso cancelado durante el vaciado de audio.");
        }

        // 6. Conmutación atómica de sesión
        this.setState("switching", "Conmutando flujo de audio al asistente técnico");
        await this.options.onSwitchSession(technicalSession);

        this.pendingTechnicalSession = null;
        this.contextStore.setRole("technical");
        this.setState("active", "Asistente técnico activo");
        return { success: true, message: "Traspaso al asistente técnico completado." };
      })();

      const result = await Promise.race([preparePromise, timeoutPromise]);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.activeAbortController = null;
      return result;
    } catch (err: any) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.cancel(err.message);
      console.error("[HandoffController] Error en traspaso:", err.message);
      return {
        success: false,
        message: `No se pudo conectar con el técnico (${err.message}). Continuando con asesor comercial.`,
      };
    }
  }

  /**
   * Validador estricto para registro de autorización de WhatsApp:
   * Requiere evidencia textual verificable de la frase del cliente, validación contra transcripciones reales
   * y confirmación separada del número de destino.
   */
  public handleWhatsAppConsent(args: {
    consent_given?: boolean;
    client_evidence_quote?: string;
    phone?: string;
    phone_confirmed?: boolean;
    reason?: string;
    userTranscripts?: string[];
  }): { authorized: boolean; feedback: string } {
    if (args.consent_given === false) {
      this.contextStore.setWhatsAppAuthorized(false);
      this.contextStore.setOutcome("RECHAZADO");
      return { authorized: false, feedback: "Rechazo registrado. Despídete cordialmente y finaliza la llamada con request_end_call." };
    }

    const quote = (args.client_evidence_quote || "").trim();

    // Comprobar si la última intervención fue una negativa tajante a recibir la muestra
    if (args.userTranscripts && args.userTranscripts.length > 0) {
      const lastTranscript = args.userTranscripts[args.userTranscripts.length - 1];
      if (/\b(no\s+quiero|no\s+me\s+interesa|para\s+nada|dejadme|no\s+lo\s+envies|no\s+mandes\s+nada)\b/i.test(lastTranscript)) {
        this.contextStore.setWhatsAppAuthorized(false);
        this.contextStore.setOutcome("RECHAZADO");
        return {
          authorized: false,
          feedback: "El cliente ha indicado que no está interesado. Despídete amablemente y finaliza la llamada con request_end_call.",
        };
      }
    }

    const userSpokenAll = (args.userTranscripts || []).join(" ").toLowerCase();
    const explicitOther = /\b(otro\s+m[oó]vil|otro\s+n[uú]mero|a\s+otro|no\s+a\s+este|no\s+al\s+mismo|apunta\s+otro)\b/i.test(userSpokenAll);

    // Resolver número de teléfono evaluando cada fuente por separado (NUNCA concatenar phone + quote + transcripts)
    let phone = args.phone ? args.phone.trim() : "";
    let matched9 = "";

    const candidates = [
      normalizeSpokenSpanishDigits(phone).replace(/\D/g, ""),
      normalizeSpokenSpanishDigits(quote).replace(/\D/g, ""),
      normalizeSpokenSpanishDigits((args.userTranscripts || []).join(" ")).replace(/\D/g, ""),
    ];

    for (const cand of candidates) {
      if (cand.length === 9 && /^[6789]\d{8}$/.test(cand)) {
        matched9 = cand;
        break;
      }
      if (cand.length > 9) {
        const tail9 = cand.slice(-9);
        if (/^[6789]\d{8}$/.test(tail9)) {
          matched9 = tail9;
          break;
        }
        const m = cand.match(/([6789]\d{8})/g);
        if (m && m.length > 0) {
          matched9 = m[m.length - 1];
          break;
        }
      }
    }

    if (matched9) {
      phone = matched9;
    } else if (explicitOther) {
      const rawDigits = phone.replace(/\D/g, "");
      if (rawDigits.length > 0 && rawDigits.length < 9) {
        return {
          authorized: false,
          feedback: `El número de teléfono facilitado (${rawDigits}) está incompleto (tiene ${rawDigits.length} dígitos y un móvil español tiene 9 dígitos). Pídele amablemente al cliente que te complete los números que faltan: 'Disculpa, me he quedado en el ${rawDigits}, ¿cuáles son los números que faltan?'`,
        };
      }
      return {
        authorized: false,
        feedback: "El cliente indicó facilitar otro móvil. Pídele directamente el número: 'Perfecto, dime el número de móvil y te lo apunto.'",
      };
    } else {
      // Por defecto: cualquier aceptación sin dictar otro móvil se envía al número que llama ("este")
      phone = this.contextStore.getState().confirmed_phone || "este";
    }

    const normalizedPhone = normalizeSpanishPhone(phone) || (phone ? phone : "este");

    this.contextStore.setWhatsAppAuthorized(true, normalizedPhone, quote || "Autorizado por el cliente");
    this.contextStore.setOutcome("AUTORIZADO");
    this.contextStore.setStage(5);

    const isThisNumber = phone === "este" || !matched9;
    const farewellPhrase = isThisNumber
      ? "¡Perfecto! En uno o dos días se la preparamos y te la dejamos en este WhatsApp. Muchas gracias y que tengas un gran día."
      : "¡Anotado! En uno o dos días se la dejamos preparada en ese WhatsApp. Muchas gracias y que tengas un gran día.";

    return {
      authorized: true,
      feedback: `Autorización confirmada. Despídete amablemente en una sola frase breve: "${farewellPhrase}". No llames a ninguna otra herramienta.`,
    };
  }

  /**
   * Ejecuta la transferencia de la llamada a un responsable humano (ej. Miguel)
   * Dispara una alerta urgente por WhatsApp al número de transferencia configurado.
   */
  public async transferToHuman(args: {
    reason?: string;
    customer_notes?: string;
  }): Promise<{ transferred: boolean; targetPhone: string; feedback: string }> {
    const state = this.contextStore.getState();
    const cfg = loadConfig();
    const targetPhone = cfg.humanTransferPhone || "";
    const targetName = cfg.humanTransferName || "Miguel";
    const notifyWhatsApp = cfg.notifyTransferViaWhatsApp !== false;

    console.log(`[HandoffController] 🔄 Solicitud de transferencia a humano (${targetName}: ${targetPhone}) - Motivo: ${args.reason || "solicitud_cliente"}`);

    if (notifyWhatsApp && targetPhone) {
      try {
        const clientBiz = state.business.name || "Cliente Local";
        const clientTrade = state.business.trade || "Negocio";
        const clientPhone = state.confirmed_phone || "En llamada directa";
        const reason = args.customer_notes || args.reason || "El cliente solicita hablar con un responsable";

        outboxProducer.emitHumanTransferRequested(state.call_id || `call_${Date.now()}`, {
          phone: clientPhone,
          reason,
          customerNotes: `Empresa: ${clientBiz} (${clientTrade})`,
          targetPhone,
        });
        console.log(`[HandoffController] ✅ Evento de alerta de transferencia registrado en buzón para ${targetName} (${targetPhone})`);
      } catch (e: any) {
        console.warn(`[HandoffController] Error registrando alerta de transferencia: ${e.message}`);
      }
    }

    // Enviar orden de transferencia SIP REFER a la centralita Netelip
    sendNetelipCommand(`TRANSFER:${targetPhone}`).catch((e) => {
      console.warn(`[HandoffController] Aviso al transferir SIP: ${e.message}`);
    });

    return {
      transferred: true,
      targetPhone,
      feedback: `Transferencia en curso hacia ${targetName} (${targetPhone}). Di en voz alta con tono amable: "Por supuesto, le transfiero ahora mismo con nuestro responsable, un segundo." y si el interlocutor vuelve a hablar o preguntar algo mientras conecta la llamada, respóndele con amabilidad indicándole que la llamada se está comunicando con el responsable.`,
    };
  }
}
