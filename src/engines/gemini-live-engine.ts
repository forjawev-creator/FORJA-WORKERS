import WebSocket from "ws";
import net from "net";
import {
  IConversationEngine,
  EngineEvents,
  CallSessionSummary,
} from "./conversation-engine.js";
import {
  ConversationEngineType,
  AssistantRole,
  HandoffState,
  CallState,
  AgentConfig,
  CallSessionContext,
  CallOutcomeStatus,
} from "../types.js";
import { ContextStore, getSpainTimeGreeting } from "../context-store.js";
import { PlaybackTracker } from "../playback-tracker.js";
import { appEvents } from "../events.js";
import { normalizeSpokenSpanishDigits, normalizeSpanishPhone } from "../utils/phone-utils.js";
import { buildGeminiTools, formatPhoneForSpeech } from "../voice/voice-tools.js";
import { GeminiAudioToPcmaConverter, alaw8kToPcm16k } from "../voice/audio-codecs.js";
import { outboxProducer } from "../outbox/outbox-producer.js";
import { voiceTelemetry } from "../telemetry/voice-telemetry.js";
import { renderCommercialPrompt, renderInboundPrompt, getCatalogPrices } from "../prompts-loader.js";
import { bufferToInt16Array, StreamingResampler } from "../audio-bridge.js";

export class GeminiLiveEngine implements IConversationEngine {
  public readonly engineType: ConversationEngineType = "gemini_live";
  public activeRole: AssistantRole = "commercial";
  public handoffState: HandoffState = "idle";

  private callId: string = "";
  private socket: net.Socket | null = null;
  private ws: WebSocket | null = null;
  private isCallActive = false;
  private state: CallState = "listening";
  private turnCounter = 0;
  private audioCodec: "pcm16" | "pcma" = "pcm16";
  private isPcma = false;

  private contextStore!: ContextStore;
  private playbackTracker: PlaybackTracker;
  private audioConverter: GeminiAudioToPcmaConverter;
  private downlinkResampler: StreamingResampler;
  private currentTurnSamples = 0;
  private pcmOutAccumulator: Int16Array = new Int16Array(0);
  private currentAssistantText = "";
  private currentUserText = "";

  private userTranscripts: Array<{ text: string; timestamp: number }> = [];
  private accumulatedPhoneDigits = "";
  private clientEvidenceQuote = "";
  private confirmedPhone = "";
  private whatsappAuthorized = false;
  private phoneConfirmed = false;
  private outcomeStatus: CallOutcomeStatus = "EN_CURSO";
  private selectedVariant: "cercano" | "formal" = "cercano";

  private isSpeaking = false;
  private speechStartTime = 0;
  private lastInputAudioTime = 0;
  private isFarewellInProgress = false;
  private farewellHangupTimer: NodeJS.Timeout | null = null;
  private farewellReason: string = "authorized_closed";
  private farewellOutcome: CallOutcomeStatus = "AUTORIZADO";
  private farewellTurnId: number = -1;
  private isOutbound: boolean = true;
  private callDurationTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly events: EngineEvents
  ) {
    this.playbackTracker = new PlaybackTracker();
    this.audioConverter = new GeminiAudioToPcmaConverter();
    this.downlinkResampler = new StreamingResampler(24000, this.config.sampleRate || 16000);
  }

  private flushPcmAccumulator(): void {
    if (this.pcmOutAccumulator.length > 0) {
      const toSend = this.pcmOutAccumulator;
      this.pcmOutAccumulator = new Int16Array(0);
      this.events.onAudio(toSend, this.turnCounter);
    }
  }

  public async start(callId: string, socket: net.Socket, context?: CallSessionContext): Promise<void> {
    this.callId = callId;
    this.socket = socket;
    this.isCallActive = true;
    this.audioCodec = this.config.audioCodec || "pcm16";
    this.isPcma = this.audioCodec === "pcma";
    this.contextStore = new ContextStore(callId, this.config, context);
    this.pcmOutAccumulator = new Int16Array(0);
    this.currentAssistantText = "";
    this.currentUserText = "";
    this.isOutbound = context?.callDirection !== "inbound" && (context as any)?.isOutbound !== false;
    if (context?.confirmedPhone) {
      this.confirmedPhone = context.confirmedPhone;
      this.phoneConfirmed = true;
    }

    const maxCallSeconds = this.config.callMaxDurationSeconds || 180;
    this.callDurationTimer = setTimeout(() => {
      console.log(`[GeminiLive] ⏱️ Límite máximo de duración alcanzado (${maxCallSeconds}s). Finalizando llamada.`);
      this.events.onHangupRequested("call_max_duration_exceeded", "TERMINADO");
    }, maxCallSeconds * 1000);

    const apiKey = this.config.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const err = new Error("GEMINI_API_KEY no configurada. Configure la clave en el panel o en el archivo .env.");
      this.events.onError(err);
      throw err;
    }

    const rawModel = this.config.geminiCommercialModel || "gemini-2.5-flash-native-audio-preview-12-2025";
    const model = rawModel.replace(/^models\//, "");
    const voice = this.config.geminiCommercialVoice || "Aoede";

    voiceTelemetry.startCall(this.callId, "gemini_live", model, voice);

    const host = "generativelanguage.googleapis.com";
    const path = `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    const wsUrl = `wss://${host}${path}`;

    console.log(`[GeminiLive] Conectando WebSocket a ${host} (modelo: ${model}, voz: ${voice}, dirección: ${this.isOutbound ? "saliente" : "entrante"})...`);

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const setupTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const timeoutErr = new Error("Timeout (5000ms) esperando setupComplete de Google Gemini Live.");
          console.error(`[GeminiLive] ❌ ${timeoutErr.message}`);
          this.events.onError(timeoutErr);
          try {
            this.ws?.close();
          } catch {}
          reject(timeoutErr);
        }
      }, 5000);

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        console.log(`[GeminiLive] ✅ Conexión WebSocket establecida con Google Gemini Live. Enviando setup...`);

        const systemPrompt = this.buildPrompt();
        const geminiTools = buildGeminiTools({
          role: "commercial",
          includeWhatsappTool: true,
          handoffEnabled: false,
        });

        const setupMessage = {
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              thinkingConfig: {
                thinkingBudget: 0,
              },
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voice,
                  },
                },
              },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: systemPrompt }],
            },
            tools: geminiTools,
          },
        };

        this.ws?.send(JSON.stringify(setupMessage));
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const rawStr = data.toString();
          const parsed = JSON.parse(rawStr);
          if (parsed.setupComplete && !resolved) {
            console.log(`[GeminiLive] ✅ Setup confirmado por Google (setupComplete).`);
            clearTimeout(setupTimeout);
            resolved = true;
            resolve();
            return;
          }
          this.handleServerMessage(parsed);
        } catch (err: any) {
          console.error("[GeminiLive] Error procesando mensaje de servidor:", err.message);
        }
      });

      this.ws.on("error", (err: Error) => {
        clearTimeout(setupTimeout);
        console.error("[GeminiLive] Error en WebSocket:", err.message);
        this.events.onError(err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        clearTimeout(setupTimeout);
        console.log(`[GeminiLive] WebSocket cerrado (código: ${code}, motivo: ${reason.toString()})`);
        if (this.isCallActive) {
          this.events.onHangupRequested("gemini_ws_close", this.outcomeStatus);
        }
      });
    });
  }

  private buildPrompt(): string {
    const isOutbound = this.isOutbound;
    const bizName = this.contextStore.getState().business.name || "Cliente Local";
    const prices = getCatalogPrices();

    let basePrompt = "";
    if (isOutbound) {
      basePrompt = renderCommercialPrompt({
        variant: this.selectedVariant,
        agentName: "Silvia",
        bizRef: bizName,
        installPrice: prices.installPrice,
        monthlyPrice: prices.monthlyPriceBasic,
      });
    } else {
      basePrompt = renderInboundPrompt({
        agentName: "Silvia",
        timeGreeting: getSpainTimeGreeting(),
        wishClosing: "que tengas un gran día",
      });
    }

    return (
      basePrompt +
      "\n\nDIRECTIVA ESTRICTA DE VOZ Y ACENTO: Habla SIEMPRE en español de España (castellano peninsular) con tono natural, cercano y fluido de llamada telefónica real. Responde ÚNICAMENTE con tus palabras habladas en español para el interlocutor. NUNCA generes pensamientos internos ni explicaciones en inglés."
    );
  }

  public pushInputAudio(pcm: Int16Array, raw: Buffer): void {
    if (!this.isCallActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    let pcm16Buffer: Buffer;
    if (this.isPcma && raw && raw.length > 0) {
      pcm16Buffer = alaw8kToPcm16k(raw);
    } else {
      const pcmLE = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      pcm16Buffer = pcmLE;
    }

    const base64Data = pcm16Buffer.toString("base64");
    const audioMsg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: base64Data,
          },
        ],
      },
    };

    try {
      this.ws.send(JSON.stringify(audioMsg));
      this.lastInputAudioTime = Date.now();
    } catch {}
  }

  private handleServerMessage(msg: any): void {
    // 1. Audio y transcripciones generadas por el servidor
    if (msg.serverContent) {
      const { modelTurn, turnComplete, interrupted, outputTranscription, inputTranscription } = msg.serverContent;

      if (inputTranscription?.text) {
        this.currentUserText += inputTranscription.text;
        const cleanUser = this.currentUserText.trim();
        if (cleanUser) {
          this.events.onTranscript("user", inputTranscription.text, this.turnCounter, false);
          this.userTranscripts.push({ text: inputTranscription.text, timestamp: Date.now() });
        }
      }

      if (outputTranscription?.text) {
        this.currentAssistantText += outputTranscription.text;
        this.events.onTranscript("assistant", outputTranscription.text, this.turnCounter, true);
      }

      if (interrupted) {
        console.log(`[GeminiLive] ⚡ Interrupción detectada por el servidor`);
        voiceTelemetry.recordInterruption(this.callId);
        this.isSpeaking = false;
        this.currentTurnSamples = 0;
        this.pcmOutAccumulator = new Int16Array(0);
        this.currentAssistantText = "";
        this.downlinkResampler.reset();
        this.events.onFlush(this.turnCounter);
        this.audioConverter.reset();
        return;
      }

      if (modelTurn?.parts) {
        for (const part of modelTurn.parts) {
          // Ignorar partes de razonamiento interno (Thinking / CoT) de Gemini 2.0 / 2.5
          if ((part as any).thought === true) {
            continue;
          }

          if (part.inlineData && part.inlineData.data) {
            const rawBase64 = part.inlineData.data;
            const pcm24kBuf = Buffer.from(rawBase64, "base64");

            if (!this.isSpeaking) {
              this.isSpeaking = true;
              this.speechStartTime = Date.now();
              this.currentTurnSamples = 0;
              this.currentUserText = "";
              this.turnCounter++;
              this.events.onTurnStart(this.turnCounter);
              voiceTelemetry.recordTtfb(this.callId, Date.now() - this.lastInputAudioTime);
            }

            if (this.isPcma) {
              // Convertir 24 kHz PCM -> 8 kHz G.711 A-law con filtro FIR anti-aliasing
              const pcmaChunk = this.audioConverter.convert(pcm24kBuf);
              if (pcmaChunk.length > 0 && this.events.onAudioRaw) {
                this.currentTurnSamples += pcmaChunk.length * 2;
                this.events.onAudioRaw(pcmaChunk, this.turnCounter);
              }
            } else {
              // Remuestrear flujo de 24 kHz PCM -> 16 kHz PCM
              const pcm24k = bufferToInt16Array(pcm24kBuf);
              const pcmResampled = this.downlinkResampler.process(pcm24k);
              if (pcmResampled.length > 0) {
                this.currentTurnSamples += pcmResampled.length;
                // Acumular fragmentos pequeños de 40ms en bloques continuos de >=160ms (2560 muestras a 16kHz)
                // para evitar las 25 uniones por segundo que causan efecto "tubo" en el navegador
                const combined = new Int16Array(this.pcmOutAccumulator.length + pcmResampled.length);
                combined.set(this.pcmOutAccumulator);
                combined.set(pcmResampled, this.pcmOutAccumulator.length);
                if (combined.length >= 2560) {
                  this.pcmOutAccumulator = new Int16Array(0);
                  this.events.onAudio(combined, this.turnCounter);
                } else {
                  this.pcmOutAccumulator = combined;
                }
              }
            }
          }

          if (part.text) {
            const trimmed = part.text.trim();
            // Filtrar trazas de pensamiento markdown en inglés (ej: **Initiating the Dialogue**)
            if (/^\*\*(?:Initiating|Defining|Recording|Analyzing|Thinking|Prioritizing|Confirming)/i.test(trimmed)) {
              continue;
            }
            this.events.onTranscript("assistant", part.text, this.turnCounter, false);
          }
        }
      }

      if (turnComplete) {
        this.flushPcmAccumulator();
        if (this.currentAssistantText.trim()) {
          this.events.onTranscript("assistant", this.currentAssistantText.trim(), this.turnCounter, false);
          this.currentAssistantText = "";
        }
        this.isSpeaking = false;
        this.events.onTurnEnd(this.turnCounter);

        if (this.isFarewellInProgress) {
          this.farewellTurnId = this.turnCounter;
          // Calcular duración física del audio generado para este turno de despedida
          const targetRate = this.config.sampleRate || 16000;
          const turnDurationMs = (this.currentTurnSamples / targetRate) * 1000;
          const elapsedMs = Math.max(0, Date.now() - this.speechStartTime);
          const remainingAudioMs = Math.max(0, turnDurationMs - elapsedMs);
          const waitMs = Math.max(2500, Math.min(12000, remainingAudioMs + 2500));

          console.log(`[GeminiLive] 🏁 Despedida completada en servidor (Turno #${this.turnCounter}). Audio restante estimado: ${Math.round(remainingAudioMs)}ms. Programando colgado en ${Math.round(waitMs)}ms (${this.farewellReason}).`);

          if (this.farewellHangupTimer) clearTimeout(this.farewellHangupTimer);
          this.farewellHangupTimer = setTimeout(() => {
            if (this.isCallActive) {
              console.log(`[GeminiLive] ⏱️ Fin de llamada tras reproducción de despedida (${this.farewellReason}).`);
              this.events.onHangupRequested(this.farewellReason, this.farewellOutcome);
            }
          }, waitMs);
        }
      }
    }

    // 2. Llamadas a herramientas comerciales (Tool calls)
    if (msg.toolCall?.functionCalls) {
      for (const call of msg.toolCall.functionCalls) {
        this.handleFunctionCall(call).catch((err) => {
          console.error(`[GeminiLive] Error ejecutando herramienta ${call.name}:`, err.message);
        });
      }
    }
  }

  private async handleFunctionCall(call: { id: string; name: string; args: any }): Promise<void> {
    const { id, name, args } = call;
    console.log(`[GeminiLive Herramienta]: ${name}`, args);

    let outputResult: any = { status: "ok" };

    if (name === "get_product_info") {
      const topic = (args.topic || "").toLowerCase();
      const cat = this.contextStore.getState().catalog;
      let info = `Muestra gratuita sin compromiso. Web completa: instalación ${cat.installPrice} euros y mantenimiento ${cat.monthlyPriceBasic} o ${cat.monthlyPriceFull} euros al mes.`;
      if (topic.includes("precio") || topic.includes("tarifa")) {
        info = `Precio oficial: Muestra previa 100% gratuita. Contratación final: ${cat.installPrice} € de alta y ${cat.monthlyPriceBasic} € o ${cat.monthlyPriceFull} €/mes según plan.`;
      }
      outputResult = { topic, info };
    } else if (name === "request_end_call") {
      this.outcomeStatus = "RECHAZADO";
      this.contextStore.setOutcome("RECHAZADO");
      outputResult = { status: "call_ended", reason: args.reason || "client_refusal" };
      this.startFarewell("client_refusal", "RECHAZADO");
    } else if (name === "record_whatsapp_consent") {
      const consentGiven = args.consent_given === true;
      if (!consentGiven) {
        this.outcomeStatus = "RECHAZADO";
        this.contextStore.setOutcome("RECHAZADO");
        this.contextStore.setWhatsAppAuthorized(false);
        outputResult = { authorized: false, feedback: "Consentimiento no otorgado por el cliente. Despídete educadamente y finaliza con request_end_call." };
        this.startFarewell("refusal", "RECHAZADO");
      } else if (this.userTranscripts.length === 0) {
        // Bloqueo crítico: el modelo no puede autorizar si el cliente no ha hablado
        console.warn(`[GeminiLive] ⛔ Intento de autorizar WhatsApp sin intervenciones previas del cliente.`);
        outputResult = {
          authorized: false,
          status: "rejected_no_user_speech",
          feedback: "El cliente todavía no ha intervenido en la llamada. No puedes registrar autorización sin haber formulado primero la pregunta y haber recibido la confirmación hablada del interlocutor.",
        };
      } else {
        const allUserText = this.userTranscripts.map((t) => t.text).join(" ").toLowerCase();
        const lastUserText = (this.userTranscripts[this.userTranscripts.length - 1]?.text || "").toLowerCase();
        const isRefusal =
          /\b(no\s+(quiero|me\s+interesa|hace\s+falta|lo\s+env[ií]es?|mandes?|necesito)|para\s+nada|dejadme|no\s+gracias|no\s+quiero\s+nada)\b/i.test(lastUserText) ||
          /\b(no\s+(quiero|me\s+interesa|lo\s+env[ií]es?|mandes?))\b/i.test(args.client_evidence_quote || "");

        if (isRefusal) {
          this.outcomeStatus = "RECHAZADO";
          this.contextStore.setOutcome("RECHAZADO");
          this.contextStore.setWhatsAppAuthorized(false);
          outputResult = {
            authorized: false,
            status: "client_refusal",
            feedback: "El cliente ha expresado rechazo o falta de interés en recibir la muestra. Despídete cordialmente en una frase breve y finaliza la llamada con request_end_call.",
          };
          this.startFarewell("refusal", "RECHAZADO");
        } else {
          const rawPhone = args.phone ? String(args.phone).trim() : "";
          const quote = args.client_evidence_quote ? String(args.client_evidence_quote).trim() : "";
          const explicitOther = /\b(otro\s+m[oó]vil|otro\s+n[uú]mero|a\s+otro|no\s+a\s+este|no\s+al\s+mismo|apunta\s+otro)\b/i.test(allUserText);

          let resolvedPhone = "";
          const candidates = [
            normalizeSpokenSpanishDigits(rawPhone).replace(/\D/g, ""),
            normalizeSpokenSpanishDigits(quote).replace(/\D/g, ""),
            normalizeSpokenSpanishDigits(allUserText).replace(/\D/g, ""),
          ];

          for (const cand of candidates) {
            if (/^[6789]\d{8}$/.test(cand)) {
              resolvedPhone = cand;
              break;
            }
            if (cand.length > 9) {
              const tail9 = cand.slice(-9);
              if (/^[6789]\d{8}$/.test(tail9)) {
                resolvedPhone = tail9;
                break;
              }
              const matches = cand.match(/([6789]\d{8})/g);
              if (matches && matches.length > 0) {
                resolvedPhone = matches[matches.length - 1];
                break;
              }
            }
          }

          if (!resolvedPhone) {
            if (explicitOther) {
              outputResult = {
                authorized: false,
                status: "missing_dictated_phone",
                feedback: "El cliente indicó facilitar otro móvil pero no se detectaron los 9 dígitos completos. Pídele que te dicte el móvil: 'Dime el número de móvil y te lo apunto.'",
              };
            } else {
              // Confirmó "este mismo": verificar teléfono conocido de la llamada
              const callerPhoneRaw = (this.contextStore.getState().confirmed_phone || "").replace(/\D/g, "");
              if (callerPhoneRaw.length >= 9) {
                resolvedPhone = callerPhoneRaw.slice(-9);
              }
            }
          }

          if (!outputResult.status && (!resolvedPhone || !/^[6789]\d{8}$/.test(resolvedPhone))) {
            outputResult = {
              authorized: false,
              status: "phone_required",
              feedback: "El cliente ha dado su consentimiento, pero no disponemos de un número de móvil válido para enviar el WhatsApp. Pídele amablemente su número: '¿A qué número de móvil te dejamos preparada la muestra?'",
            };
          } else if (!outputResult.status) {
            this.confirmedPhone = resolvedPhone;
            this.phoneConfirmed = true;
            this.whatsappAuthorized = true;
            this.clientEvidenceQuote = quote || "Autorizado por el cliente en llamada";
            this.outcomeStatus = "AUTORIZADO";
            this.contextStore.setWhatsAppAuthorized(true, this.confirmedPhone, this.clientEvidenceQuote);
            this.contextStore.setOutcome("AUTORIZADO");
            this.contextStore.setStage(5);

            // Emisión atómica inmediata en el Outbox sin esperar a que termine la llamada
            try {
              const bizName = this.contextStore.getState().business.name || "";
              outboxProducer.emitWhatsAppAuthorized(this.callId, {
                phone: this.confirmedPhone,
                confirmedPhone: this.confirmedPhone,
                company: bizName,
                evidenceQuote: this.clientEvidenceQuote,
              });
              outboxProducer.emitPhoneConfirmed(this.callId, {
                phone: this.confirmedPhone,
                evidenceQuote: this.clientEvidenceQuote,
              });
            } catch (e: any) {
              console.warn("[GeminiLive] Advertencia encolando evento outbox:", e.message);
            }

            outputResult = {
              authorized: true,
              status: "ok",
              instructions: `Autorización guardada correctamente para el número ${this.confirmedPhone}. Si ya te has despedido, no digas nada más. Si aún no te has despedido, despídete cordialmente una sola vez sin repetir.`,
            };
            this.startFarewell("authorized_closed", "AUTORIZADO");
          }
        }
      }
    }

    const responseMsg = {
      toolResponse: {
        functionResponses: [
          {
            name: name,
            response: { output: outputResult },
            id,
          },
        ],
      },
    };

    try {
      this.ws?.send(JSON.stringify(responseMsg));
    } catch (err: any) {
      console.warn(`[GeminiLive] Error enviando respuesta de herramienta ${name}:`, err.message);
    }
  }

  private startFarewell(reason: string, outcome: CallOutcomeStatus): void {
    this.isFarewellInProgress = true;
    this.farewellReason = reason;
    this.farewellOutcome = outcome;
    // Temporizador de guardia amplio (15 segundos) por si la conexión del modelo se bloquease
    if (this.farewellHangupTimer) clearTimeout(this.farewellHangupTimer);
    this.farewellHangupTimer = setTimeout(() => {
      if (this.isCallActive) {
        console.log(`[GeminiLive] ⏱️ Temporizador de guardia cumplido (${reason}). Finalizando llamada.`);
        this.events.onHangupRequested(reason, outcome);
      }
    }, 15000);
  }

  public async requestInitialGreeting(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const isFormal = this.selectedVariant === "formal";
    const bizName = this.contextStore.getState().business.name || "su negocio";
    let initialText = "";
    if (this.isOutbound) {
      initialText = isFormal
        ? `Hola, buenos días. ¿Es el responsable de ${bizName}?`
        : `Hola, buenas. ¿Eres el responsable de ${bizName}?`;
    } else {
      initialText = `Hola, gracias por llamar a Forja Web, te atiende Silvia, ¿en qué puedo ayudarte hoy?`;
    }

    const clientMsg = {
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text: `Inicia la llamada diciendo exactamente: "${initialText}"` }],
          },
        ],
        turnComplete: true,
      },
    };

    try {
      this.ws.send(JSON.stringify(clientMsg));
    } catch {}
  }

  public interrupt(playbackPositionMs?: number): void {
    if (this.isSpeaking) {
      this.isSpeaking = false;
      this.currentTurnSamples = 0;
      this.pcmOutAccumulator = new Int16Array(0);
      this.downlinkResampler.reset();
      this.events.onFlush(this.turnCounter);
      this.audioConverter.reset();
      voiceTelemetry.recordAudioCancel(this.callId);
    }
  }

  public handlePlaybackDrained(turnId: number): void {
    if (this.events.onPlaybackDrained) {
      this.events.onPlaybackDrained(turnId);
    }
    // Si el cliente confirma que se terminó de reproducir el turno de despedida:
    if (this.isFarewellInProgress && this.farewellTurnId !== -1 && turnId >= this.farewellTurnId) {
      console.log(`[GeminiLive] 🔊 Reproducción de despedida física terminada en cliente (Turno #${turnId}). Colgando en 1.5s.`);
      if (this.farewellHangupTimer) clearTimeout(this.farewellHangupTimer);
      this.farewellHangupTimer = setTimeout(() => {
        if (this.isCallActive) {
          this.events.onHangupRequested(this.farewellReason, this.farewellOutcome);
        }
      }, 1500);
    }
  }

  public handlePlaybackStarted(turnId: number): void {
    this.speechStartTime = Date.now();
  }

  public async stop(reason: string): Promise<void> {
    console.log(`[GeminiLive] Deteniendo motor (${reason})...`);
    this.isCallActive = false;
    this.pcmOutAccumulator = new Int16Array(0);
    this.downlinkResampler.reset();
    if (this.callDurationTimer) {
      clearTimeout(this.callDurationTimer);
      this.callDurationTimer = null;
    }
    if (this.farewellHangupTimer) {
      clearTimeout(this.farewellHangupTimer);
      this.farewellHangupTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    voiceTelemetry.finalizeCall(this.callId);
  }

  public getCallSessionSummary(): CallSessionSummary {
    return {
      outcomeStatus: this.outcomeStatus,
      whatsappAuthorized: this.whatsappAuthorized,
      phoneConfirmed: this.phoneConfirmed,
      evidenceQuote: this.clientEvidenceQuote,
      confirmedPhone: this.confirmedPhone,
      scriptVariant: this.selectedVariant,
      transcripts: this.userTranscripts.map((t) => ({ role: "user", text: t.text })),
      userTranscripts: this.userTranscripts.map((t) => t.text),
    };
  }
}
