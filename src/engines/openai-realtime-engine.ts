import WebSocket from "ws";
import net from "net";
import {
  IConversationEngine,
  EngineEvents,
} from "./conversation-engine.js";
import {
  ConversationEngineType,
  AssistantRole,
  HandoffState,
  CallState,
  AgentConfig,
  CallSessionContext,
  CallOutcomeStatus,
  ActiveSessionHandle,
} from "../types.js";
import { ContextStore, getSpainTimeGreeting } from "../context-store.js";
import { CostMeter } from "../cost-meter.js";
import { PlaybackTracker } from "../playback-tracker.js";
import { HandoffController } from "../handoff-controller.js";
import { StreamingResampler } from "../audio-bridge.js";
import { appEvents } from "../events.js";
import { normalizeSpokenSpanishDigits } from "../utils/phone-utils.js";
import { outboxProducer } from "../outbox/outbox-producer.js";
import { buildSessionTools, formatPhoneForSpeech } from "../voice/voice-tools.js";

export class OpenAIRealtimeEngine implements IConversationEngine {
  public readonly engineType: ConversationEngineType = "openai_realtime";
  public activeRole: AssistantRole = "commercial";
  public handoffState: HandoffState = "idle";

  private callId: string = "";
  private socket: net.Socket | null = null;
  private isCallActive = false;
  private state: CallState = "listening";
  private turnCounter = 0;
  private generationEpoch = 1;
  private userTranscripts: Array<{ text: string; timestamp: number; itemId: string }> = [];
  private assistantTranscripts: Array<{ text: string; timestamp: number }> = [];
  private drainedTurns: Set<number> = new Set();

  private contextStore: ContextStore;
  private costMeter: CostMeter;
  private playbackTracker: PlaybackTracker;
  private handoffController: HandoffController | null = null;

  private activeSession: ActiveSessionHandle | null = null;
  private uplinkResampler: StreamingResampler;
  private downlinkResampler: StreamingResampler;
  private isTransferring = false;

  private activeResponseId: string | null = null;
  private cancelledResponseIds: Set<string> = new Set();
  private activeItemId: string | null = null;
  private isMuted: boolean = false;
  private pendingGreetingResolver: (() => void) | null = null;
  private playbackDrainedResolver: ((turnId: number) => void) | null = null;

  private callDurationTimer: NodeJS.Timeout | null = null;
  private technicalDurationTimer: NodeJS.Timeout | null = null;
  private farewellHangupTimer: NodeJS.Timeout | null = null;
  private pendingHangup: { reason: string; outcome?: CallOutcomeStatus } | null = null;
  private isFarewellInProgress: boolean = false;
  private isAwaitingPostFarewell: boolean = false;
  private farewellReason: string = "authorized_closed";
  private farewellOutcome: CallOutcomeStatus = "AUTORIZADO";
  private proposalPresented: boolean = false;
  private whatsappToolUnlocked: boolean = false;
  private playbackEndTimeMs: number = 0;
  private currentTurnAudioSamples24k: number = 0;
  private turnSpeechStartWallMs: number = 0;
  private pendingToolFollowup: boolean = false;
  private pendingToolInstruction: string | null = null;
  private selectedVariant: "cercano" | "formal" = "cercano";
  private accumulatedPhoneDigits: string = "";
  private userPhoneChunks: string[] = [];
  private hadPhoneDictationInCall: boolean = false;

  private readonly isPcma: boolean;

  constructor(
    private readonly config: AgentConfig,
    private readonly events: EngineEvents
  ) {
    this.isPcma = config.audioCodec === "pcma";
    this.uplinkResampler = new StreamingResampler(config.sampleRate || 16000, 24000);
    this.downlinkResampler = new StreamingResampler(24000, config.sampleRate || 16000);
    this.playbackTracker = new PlaybackTracker(config.sampleRate || 16000);
    this.contextStore = new ContextStore(this.callId, this.config);
    this.costMeter = new CostMeter(
      this.callId,
      this.config.callCostAlertUsd || 0.10,
      this.config.callCostSoftLimitUsd || 0.20,
      this.config.callCostHardLimitUsd || 0.30
    );
  }

  private cancelPendingFarewellHangup(reason: string): void {
    if (this.farewellHangupTimer) {
      console.log(`[OpenAIRealtime] 🛑 Cancelando temporizador de colgado en curso (${reason}). La llamada continúa activa.`);
      clearTimeout(this.farewellHangupTimer);
      this.farewellHangupTimer = null;
    }
    this.isFarewellInProgress = false;
    this.isAwaitingPostFarewell = false;
    this.pendingHangup = null;
  }

  public async start(callId: string, socket: net.Socket, context?: CallSessionContext): Promise<void> {
    this.callId = callId;
    this.socket = socket;
    this.isCallActive = true;
    this.activeRole = "commercial";
    this.handoffState = "idle";
    this.generationEpoch = 1;
    this.proposalPresented = false;
    this.whatsappToolUnlocked = false;
    this.isTransferring = false;
    this.playbackEndTimeMs = 0;
    this.currentTurnAudioSamples24k = 0;
    this.turnSpeechStartWallMs = 0;
    this.pendingToolFollowup = false;
    this.pendingToolInstruction = null;
    this.cancelPendingFarewellHangup("call_start");
    this.farewellReason = "authorized_closed";
    this.farewellOutcome = "AUTORIZADO";
    this.cancelledResponseIds.clear();
    this.accumulatedPhoneDigits = "";
    this.userPhoneChunks = [];
    this.hadPhoneDictationInCall = false;

    let activeVariant: "cercano" | "formal" = "cercano";
    if (this.config.scriptVariant === "formal") {
      activeVariant = "formal";
    } else if (this.config.scriptVariant === "ab_test") {
      activeVariant = Math.random() < 0.5 ? "cercano" : "formal";
    }
    this.selectedVariant = activeVariant;
    console.log(`[OpenAIRealtime] Variante comercial asignada: ${this.selectedVariant.toUpperCase()} (Modo: ${this.config.scriptVariant || "cercano"})`);

    this.contextStore = new ContextStore(callId, this.config, context);
    this.costMeter = new CostMeter(
      callId,
      this.config.callCostAlertUsd || 0.10,
      this.config.callCostSoftLimitUsd || 0.20,
      this.config.callCostHardLimitUsd || 0.30
    );

    // Aplicar límite estricto de duración total de la llamada
    const maxCallSeconds = this.config.callMaxDurationSeconds || 180;
    this.callDurationTimer = setTimeout(() => {
      console.warn(`[OpenAIRealtime] Límite máximo de duración de llamada alcanzado (${maxCallSeconds}s). Finalizando.`);
      this.events.onHangupRequested("call_max_duration_exceeded", "TERMINADO");
    }, maxCallSeconds * 1000);

    this.handoffController = new HandoffController(this.contextStore, {
      handoffTimeoutMs: this.config.handoffTimeoutMs || 8000,
      onStateChange: (newState, detail) => {
        this.handoffState = newState;
        this.events.onHandoffState(newState, detail);
      },
      onAnnouncePhrase: async (phrase) => {
        await this.speakPhraseDirectly(phrase);
      },
      onWaitForPlaybackDrain: async (phraseTurnId?: number) => {
        // Esperar estrictamente a que el audio de la frase de transferencia se reproduzca físicamente
        const targetTurn = phraseTurnId !== undefined ? phraseTurnId : this.turnCounter;
        if (this.drainedTurns.has(targetTurn)) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.playbackDrainedResolver = null;
            reject(new Error(`Timeout esperando confirmación física de reproducción del turno #${targetTurn} (3500ms excedido)`));
          }, 3500);

          this.playbackDrainedResolver = (drainedTurnId: number) => {
            if (drainedTurnId === targetTurn) {
              clearTimeout(timeout);
              this.playbackDrainedResolver = null;
              resolve();
            }
          };
        });
      },
      onSwitchSession: async (technicalSession: ActiveSessionHandle) => {
        await this.switchToTechnicalSession(technicalSession);
      },
      createTechnicalSession: async () => {
        return this.createSession(
          this.config.realtimeTechnicalModel || "gpt-realtime-2.1",
          this.config.realtimeTechnicalVoice || "cedar",
          "technical"
        );
      },
    });

    // Crear sesión comercial inicial
    const commercialModel = this.config.realtimeCommercialModel || "gpt-realtime-2.1";
    const commercialVoice = this.config.realtimeCommercialVoice || "marin";

    console.log(`[OpenAIRealtime] Conectando Asistente Comercial (${commercialModel}, voz: ${commercialVoice})...`);
    this.activeSession = await this.createSession(commercialModel, commercialVoice, "commercial");
  }

  private createSession(model: string, voice: string, role: AssistantRole): Promise<ActiveSessionHandle> {
    return new Promise((resolve, reject) => {
      const apiKey = this.config.openaiApiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return reject(new Error("OPENAI_API_KEY no configurada. Configure la clave en el panel o variables de entorno."));
      }

      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      const handle: ActiveSessionHandle = {
        ws,
        model,
        voice,
        role,
        isReady: false,
        close: () => {
          try {
            ws.close();
          } catch {}
        },
      };

      const connectTimeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Timeout al conectar con OpenAI Realtime (${model})`));
      }, 10000);

      ws.on("open", () => {
        console.log(`[OpenAIRealtime] WebSocket conectado para rol: ${role} (${model})`);
      });

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleServerEvent(handle, event, () => {
            clearTimeout(connectTimeout);
            resolve(handle);
          });
        } catch (err: any) {
          console.error("[OpenAIRealtime] Error procesando evento JSON:", err);
        }
      });

      ws.on("error", (err) => {
        clearTimeout(connectTimeout);
        console.error(`[OpenAIRealtime] Error en WebSocket (${role}):`, err.message);
        this.events.onError(err);
        reject(err);
      });

      ws.on("close", (code, reason) => {
        console.log(`[OpenAIRealtime] WebSocket cerrado (${role}): code=${code}, reason=${reason.toString()}`);
        handle.isReady = false;
      });
    });
  }

  private buildSessionTools(handle: ActiveSessionHandle, includeWhatsappTool: boolean): any[] {
    return buildSessionTools({
      role: handle.role,
      includeWhatsappTool,
      handoffEnabled: this.config.handoffEnabled !== false,
    });
  }

  private unlockWhatsappTool(handle: ActiveSessionHandle): void {
    if (this.whatsappToolUnlocked || handle.role !== "commercial") return;
    if (handle.ws.readyState !== WebSocket.OPEN) return;

    this.whatsappToolUnlocked = true;
    const tools = this.buildSessionTools(handle, true);
    console.log(`[OpenAIRealtime] 🔓 Desbloqueando herramienta record_whatsapp_consent tras presentar la propuesta.`);
    handle.ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          tools,
          tool_choice: "auto",
        },
      })
    );
  }

  /**
   * Formatea los 9 dígitos exactamente con la misma agrupación que usó el cliente
   * (ej. de 3 en 3 -> "648, 648, 441" o de 3 y 2 en 2 -> "648, 64, 84, 41").
   */
  private formatPhoneForSpeech(phone: string, clientEvidenceQuote?: string): string {
    const allUserText = this.userTranscripts.map((u) => u.text).join(" ").toLowerCase();
    return formatPhoneForSpeech(phone, clientEvidenceQuote, this.userPhoneChunks, allUserText);
  }

  private configureSession(handle: ActiveSessionHandle): void {
    const isCommercial = handle.role === "commercial";
    const isInbound = this.contextStore.getState().call_direction === "inbound";
    let instructions = "";

    if (!isCommercial) {
      instructions = this.contextStore.buildTechnicalInstructions(handle.voice);
    } else if (isInbound) {
      instructions = this.contextStore.buildInboundInstructions(handle.voice, this.selectedVariant);
    } else {
      instructions = this.contextStore.buildCommercialInstructions(handle.voice, this.selectedVariant);
    }

    let turnDetection: any = null;
    if (this.config.realtimeTurnDetection === "none") {
      turnDetection = null;
    } else if (this.config.realtimeTurnDetection === "semantic_vad") {
      turnDetection = {
        type: "semantic_vad",
        eagerness: this.config.realtimeEagerness || "low",
        create_response: true,
        interrupt_response: true,
      };
    } else {
      turnDetection = {
        type: "server_vad",
        threshold: 0.80,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
        create_response: true,
        interrupt_response: false,
      };
    }

    // Dynamic Tool Gating: Al inicio de la llamada comercial (Etapa 1), ocultar record_whatsapp_consent
    // para que sea físicamente imposible que el modelo cierre la llamada durante el saludo.
    const tools = this.buildSessionTools(handle, this.whatsappToolUnlocked);

    const validRealtimeVoices = [
      "marin",
      "cedar",
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "sage",
      "shimmer",
      "verse",
    ];
    const resolvedVoice = validRealtimeVoices.includes((handle.voice || "").toLowerCase())
      ? handle.voice.toLowerCase()
      : "marin";

    const sessionUpdatePayload = {
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions,
        tools,
        tool_choice: "auto",
        max_output_tokens: this.config.realtimeMaxOutputTokens || 512,
        audio: {
          input: {
            format: this.isPcma ? { type: "audio/pcma" } : { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: "whisper-1",
              language: "es",
            },
            // Audio telefónico (G.711 8 kHz): el operador ya lo ha filtrado y near_field está
            // calibrado para micros de banda ancha, así que lo desactivamos para no deformar la voz.
            noise_reduction: this.isPcma ? null : { type: "near_field" },
            turn_detection: turnDetection,
          },
          output: {
            format: this.isPcma ? { type: "audio/pcma" } : { type: "audio/pcm", rate: 24000 },
            voice: resolvedVoice,
          },
        },
      },
    };

    handle.ws.send(JSON.stringify(sessionUpdatePayload));
  }

  private handleServerEvent(handle: ActiveSessionHandle, event: any, onReadyCallback?: () => void): void {
    const isCurrentActive = this.activeSession === handle;

    switch (event.type) {
      case "session.created": {
        this.configureSession(handle);
        break;
      }

      case "session.updated": {
        handle.isReady = true;
        if (onReadyCallback) onReadyCallback();
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = event.transcript?.trim() || "";
        if (transcript) {
          console.log(`[OpenAIRealtime] 🎙️ Transcripción cliente: "${transcript}"`);

          // Rastrear y acumular números de teléfono dictados y su agrupación exacta
          const normTranscript = normalizeSpokenSpanishDigits(transcript);
          const hasCorrectionOrNegation = /\b(no|espera|esp[eé]rate|mal|equivocado|borra|borralo|cancela|de\s+nuevo|empieza|repite|otro)\b/i.test(transcript);
          const rawGroups = normTranscript.match(/\d+/g) || [];
          const newDigits = rawGroups.join("");

          this.userTranscripts.push({
            itemId: event.item_id || "",
            text: transcript,
            timestamp: Date.now(),
          });
          this.events.onTranscript("user", transcript, this.turnCounter, false);

          // Si estábamos en proceso de despedida o esperando cierre tras la despedida:
          if (this.farewellHangupTimer || this.isFarewellInProgress || this.isAwaitingPostFarewell) {
            if (hasCorrectionOrNegation || newDigits.length > 0 || transcript.includes("?")) {
              // El cliente está corrigiendo el número o haciendo una pregunta -> cancelar colgado y mantener llamada viva
              this.cancelPendingFarewellHangup(`cliente corrigió tras despedida: "${transcript}"`);
            } else {
              // El cliente solo ha contestado a la despedida ("¡Muy bien!", "Perfecto, gracias. Hasta luego.")
              console.log(`[OpenAIRealtime] 👋 Cliente respondió a la despedida ("${transcript}"). Cerrando llamada en 1500ms.`);
              this.isAwaitingPostFarewell = true;
              if (this.farewellHangupTimer) clearTimeout(this.farewellHangupTimer);
              const reason = this.farewellReason || "authorized_closed";
              const outcome = this.farewellOutcome || "AUTORIZADO";
              const remainingAudioMs = Math.max(0, this.playbackEndTimeMs - Date.now());
              const waitMs = Math.max(1500, Math.min(6000, remainingAudioMs + 1500));
              this.farewellHangupTimer = setTimeout(() => {
                this.farewellHangupTimer = null;
                if (this.isCallActive) {
                  console.log(`[OpenAIRealtime] Ejecutando fin de llamada tras respuesta de despedida (${reason}).`);
                  this.events.onHangupRequested(reason, outcome);
                }
              }, waitMs);
              return;
            }
          }

          const isPhoneResetPhrase =
            /\b(borra|borralo|cancela|de\s+nuevo|empieza|no\s+te\s+he\s+dicho|no\s+no|eso\s+no\s+es|no\s+es\s+ese|no\s+es\s+as[ií]|est[aá]\s+mal|te\s+dije|equivocado|mal|te\s+lo\s+repito)\b/i.test(transcript) ||
            (/^no[\.,!\s]*$/i.test(transcript) && this.accumulatedPhoneDigits.length > 0);

          if (isPhoneResetPhrase) {
            console.log(`[OpenAIRealtime] 🔄 Cliente corrigió o reinició el número dictado.`);
            this.accumulatedPhoneDigits = "";
            this.userPhoneChunks = [];
          }

          // Extraer bloques de dígitos del turno conservando cómo los separó el cliente
          if (newDigits) {
            this.hadPhoneDictationInCall = true;
            // Si en este único turno ya dictó los 9+ dígitos completos, reemplazar el buffer por este número limpio
            if (newDigits.length >= 9 && /^[6789]/.test(newDigits)) {
              this.accumulatedPhoneDigits = newDigits;
              this.userPhoneChunks = [];
            } else {
              this.accumulatedPhoneDigits += newDigits;
            }

            const tensCountInTurn = (transcript.match(/\b(veint|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|diez|once|doce|trece|catorce|quince|diecis)/gi) || []).length;

            // Si el cliente dictó 3 dígitos sueltos en un mismo turno (ej. "4 4 1" -> ["4","4","1"]), agruparlos como un bloque de 3 ("441")
            if (rawGroups.length === 3 && rawGroups.every((g) => g.length === 1)) {
              this.userPhoneChunks.push(rawGroups.join(""));
            } else if (rawGroups.length === 2 && rawGroups.every((g) => g.length === 1)) {
              this.userPhoneChunks.push(rawGroups.join(""));
            } else {
              for (const g of rawGroups) {
                if (g.length === 6) {
                  // Si Whisper pegó 6 dígitos seguidos (ej. "648441"), dividir según si usó decenas (2-2-2) o tripletas (3-3)
                  if (tensCountInTurn >= 3) {
                    this.userPhoneChunks.push(g.slice(0, 2), g.slice(2, 4), g.slice(4, 6));
                  } else {
                    this.userPhoneChunks.push(g.slice(0, 3), g.slice(3, 6));
                  }
                } else if (g.length === 9) {
                  if (tensCountInTurn >= 3) {
                    this.userPhoneChunks.push(g.slice(0, 3), g.slice(3, 5), g.slice(5, 7), g.slice(7, 9));
                  } else {
                    this.userPhoneChunks.push(g.slice(0, 3), g.slice(3, 6), g.slice(6, 9));
                  }
                } else {
                  this.userPhoneChunks.push(g);
                }
              }
            }

            console.log(`[OpenAIRealtime] 📱 Dígitos acumulados en sesión: "${this.accumulatedPhoneDigits}" (Grupos: [${this.userPhoneChunks.join(", ")}])`);
            this.unlockWhatsappTool(handle);
          }
        }
        break;
      }

      case "input_audio_buffer.speech_started": {
        if (!isCurrentActive || !this.isCallActive) return;

        // Si el bot NO está hablando ni generando respuesta activa, simplemente es el cliente hablando
        const isBotSpeaking = this.state === "speaking" || Date.now() < this.playbackEndTimeMs || !!this.activeResponseId;
        if (!isBotSpeaking) {
          // El bot ya terminó de hablar y está escuchando. No hay nada que cortar ni reiniciar.
          return;
        }

        // Si es el saludo inicial (primer turno), no permitir que ruido de línea corte el saludo
        if (this.turnCounter <= 1) {
          console.log(`[OpenAIRealtime] 🛡️ Protegiendo saludo inicial completo frente a eco o ruido de línea.`);
          return;
        }

        // En telefonía (isPcma), la red móvil/PSTN carece de AEC (Acoustic Echo Cancellation) del navegador.
        // El eco de la locución del bot regresa por RTP y activa erróneamente el VAD.
        // Mientras el bot esté hablando activamente (isBotSpeaking), protegemos la locución frente a falsos cortes.
        if (this.isPcma) {
          console.log(`[OpenAIRealtime] 🛡️ Protegiendo locución telefónica frente a eco de línea en turno #${this.turnCounter}.`);
          return;
        }

        // Modo navegador: Reloj Real Anti-Eco (Wall-Clock)
        const wallElapsedMs = this.turnSpeechStartWallMs > 0 ? Date.now() - this.turnSpeechStartWallMs : 0;
        const antiEchoWindowMs = 1200;
        if (wallElapsedMs < antiEchoWindowMs) {
          console.log(`[OpenAIRealtime] 🛡️ Ignorando speech_started en ventana Wall-Clock anti-eco (${wallElapsedMs}ms < ${antiEchoWindowMs}ms).`);
          return;
        }

        // Si el cliente habla durante o después de la despedida, pausar temporalmente el reloj de colgado
        // PERO manteniendo isAwaitingPostFarewell = true para que cuando llegue la transcripción ("¡Muy bien!", "Hasta luego" vs "No, espera")
        // sepamos si colgar o cancelar el cierre.
        if (this.farewellHangupTimer || this.isFarewellInProgress || this.isAwaitingPostFarewell) {
          console.log(`[OpenAIRealtime] ⏸️ Pausando temporizador de colgado (cliente hablando tras despedida) a la espera de transcripción...`);
          if (this.farewellHangupTimer) {
            clearTimeout(this.farewellHangupTimer);
          }
          this.isAwaitingPostFarewell = true;
          const reason = this.farewellReason || "authorized_closed";
          const outcome = this.farewellOutcome || "AUTORIZADO";
          this.farewellHangupTimer = setTimeout(() => {
            this.farewellHangupTimer = null;
            if (this.isCallActive && this.isAwaitingPostFarewell) {
              console.log(`[OpenAIRealtime] Finalizando llamada tras pausa post-despedida (${reason}).`);
              this.events.onHangupRequested(reason, outcome);
            }
          }, 6000);
        }

        // Barge-in detectado por el VAD del servidor
        console.log(`[OpenAIRealtime] ⚡ Barge-in (speech_started tras ${wallElapsedMs}ms). Cortando reproducción del turno #${this.turnCounter}...`);

        this.events.onFlush(this.turnCounter);
        this.events.onState("listening");
        this.state = "listening";
        this.downlinkResampler.reset();
        this.playbackEndTimeMs = Date.now();

        // Truncar item activo en OpenAI solo si era un mensaje con muestras de audio emitidas
        const trunc = this.playbackTracker.truncateActiveItem();
        if (trunc && trunc.audioEndMs > 0 && this.currentTurnAudioSamples24k > 0 && handle.ws.readyState === WebSocket.OPEN) {
          handle.ws.send(
            JSON.stringify({
              type: "conversation.item.truncate",
              item_id: trunc.itemId,
              content_index: trunc.contentIndex,
              audio_end_ms: trunc.audioEndMs,
            })
          );
        }

        // Cancelar respuesta en curso en el servidor y registrar su ID para descartar fragmentos tardíos
        if (this.activeResponseId) {
          this.cancelledResponseIds.add(this.activeResponseId);
          if (handle.ws.readyState === WebSocket.OPEN) {
            handle.ws.send(JSON.stringify({ type: "response.cancel" }));
          }
        }

        this.activeResponseId = null;
        break;
      }

      case "input_audio_buffer.speech_stopped": {
        if (!isCurrentActive || !this.isCallActive) return;
        this.state = "processing";
        this.events.onState("processing");
        break;
      }

      case "response.created": {
        if (!isCurrentActive) return;
        this.activeResponseId = event.response?.id || null;
        if (this.activeResponseId) {
          this.cancelledResponseIds.delete(this.activeResponseId);
        }
        this.currentTurnAudioSamples24k = 0;
        this.turnSpeechStartWallMs = 0;
        this.turnCounter = (this.turnCounter + 1) & 0xff;
        this.state = "speaking";
        this.events.onState("speaking");
        this.events.onTurnStart(this.turnCounter);
        break;
      }

      case "response.output_item.added": {
        if (!isCurrentActive) return;
        if (event.item?.id && event.item?.type === "message") {
          this.activeItemId = event.item.id;
          this.playbackTracker.registerAudioItem(event.item.id, 0, this.isPcma ? 8000 : 24000);
        }
        break;
      }

      case "response.output_audio.delta": {
        if (!isCurrentActive || !this.isCallActive || this.isMuted) return;

        // Descartar deltas tardíos si pertenecen a una respuesta cancelada
        if (event.response_id && this.cancelledResponseIds.has(event.response_id)) {
          return;
        }
        // Descartar deltas si no coinciden con la respuesta activa
        if (this.activeResponseId && event.response_id && event.response_id !== this.activeResponseId) {
          return;
        }

        if (this.state !== "speaking") {
          this.state = "speaking";
          this.events.onState("speaking");
        }

        const deltaBase64 = event.delta;
        if (!deltaBase64) return;

        const audioChunk = Buffer.from(deltaBase64, "base64");
        // PCM16 @24kHz: 2 bytes/muestra. G.711 A-law @8kHz: 1 byte/muestra.
        const sourceRate = this.isPcma ? 8000 : 24000;
        const sourceSamples = this.isPcma ? audioChunk.length : audioChunk.length / 2;

        // Registrar inicio Wall-Clock en la primera muestra de audio del turno
        const now = Date.now();
        if (this.currentTurnAudioSamples24k === 0) {
          this.turnSpeechStartWallMs = now;
        }

        // Registrar muestras y duración real de reproducción en cola
        this.currentTurnAudioSamples24k += sourceSamples;
        const chunkDurationMs = (sourceSamples / sourceRate) * 1000;
        this.playbackEndTimeMs = Math.max(now, this.playbackEndTimeMs) + chunkDurationMs;

        if (this.activeItemId) {
          this.playbackTracker.recordSamplesSent(this.activeItemId, sourceSamples);
        }

        if (this.isPcma) {
          // Telefonía: OpenAI ya entrega A-law 8 kHz. Se reenvía tal cual, sin remuestreo ni filtrado.
          if (this.events.onAudioRaw && audioChunk.length > 0) {
            this.events.onAudioRaw(audioChunk, this.turnCounter);
          }
        } else {
          // Navegador: remuestrear 24kHz -> frecuencia del puente (16kHz)
          const pcm24k = new Int16Array(
            audioChunk.buffer,
            audioChunk.byteOffset,
            sourceSamples
          );
          const pcmResampled = this.downlinkResampler.process(pcm24k);
          if (pcmResampled.length > 0) {
            this.events.onAudio(pcmResampled, this.turnCounter);
          }
        }
        break;
      }

      case "response.output_audio_transcript.delta": {
        if (!isCurrentActive) return;
        if (event.delta) {
          this.events.onTranscript("assistant", event.delta, this.turnCounter, true);
        }
        break;
      }

      case "response.output_audio_transcript.done": {
        if (!isCurrentActive) return;
        const transcript = event.transcript || "";
        this.contextStore.setLastHeardAssistantText(transcript);
        this.assistantTranscripts.push({ text: transcript, timestamp: Date.now() });
        this.events.onTranscript("assistant", transcript, this.turnCounter, false);

        // La propuesta SOLO se considera presentada si el asistente explicó explícitamente la demo/muestra/web
        // (excluyendo mención a la marca 'Forja Web' en el saludo o turno inicial)
        const cleanedTranscript = transcript.replace(/forja\s*web/gi, "");
        const pitchedProposal = /\b(preparar|prepararte|prepararos|muestra|demo|diseño|diseñar|ejemplo|sin\s+compromiso|google\s+maps)\b/i.test(cleanedTranscript) &&
                               /\b(whatsapp|m[oó]vil|tel[eé]fono|envi[aá]r|mandar|pasar)\b/i.test(cleanedTranscript);

        if (pitchedProposal) {
          if (!this.proposalPresented) {
            this.proposalPresented = true;
            this.unlockWhatsappTool(handle);
            if (this.contextStore.getState().stage < 2) {
              this.contextStore.setStage(2);
              appEvents.broadcast({
                type: "stage_update",
                stage: 2,
                sessionId: this.callId,
                context: {
                  currentStage: 2,
                  outcomeStatus: this.contextStore.getState().outcome,
                  whatsappAuthorized: this.contextStore.getState().whatsapp_authorized,
                  phoneConfirmed: this.contextStore.getState().phone_confirmed,
                },
              });
            }
          }
        }

        // Salvaguarda: si el cliente ya se despidió ("hasta luego", "adiós") y el bot también responde despidiéndose sin haber invocado herramienta
        const lastUserTurn = this.userTranscripts.length > 0 ? this.userTranscripts[this.userTranscripts.length - 1].text : "";
        const userSaidGoodbye = /\b(hasta\s+luego|adi[oó]s|chao|hasta\s+pronto|nos\s+vemos|cuelgo)\b/i.test(lastUserTurn);
        const botSaidGoodbye = /\b(hasta\s+luego|adi[oó]s|chao|que\s+tengas?\s+(?:un\s+)?(?:muy\s+)?buen\s+d[ií]a|excelente\s+d[ií]a|hasta\s+la\s+pr[oó]xima|un\s+d[ií]a\s+estupendo)\b/i.test(transcript);
        if (userSaidGoodbye && botSaidGoodbye && !this.isFarewellInProgress && !this.isAwaitingPostFarewell) {
          console.log(`[OpenAIRealtime] 👋 Despedida mutua detectada en transcripción. Activando cierre automático de llamada.`);
          this.isFarewellInProgress = true;
          this.isAwaitingPostFarewell = true;
          const currentOutcome = this.contextStore.getState().outcome;
          this.farewellOutcome = currentOutcome && currentOutcome !== "EN_CURSO" ? currentOutcome : "TERMINADO";
          this.farewellReason = this.farewellOutcome === "AUTORIZADO" ? "authorized_closed" : "mutual_goodbye";
        }
        break;
      }

      case "response.function_call_arguments.done": {
        if (!isCurrentActive) return;
        this.handleFunctionCall(handle, event);
        break;
      }

      case "response.done": {
        if (!isCurrentActive) return;
        const resp = event.response;
        if (resp) {
          const costSummary = this.costMeter.recordResponseUsage(
            resp.id,
            handle.model,
            handle.role,
            resp.usage
          );
          this.events.onUsageUpdate(costSummary);

          if (this.costMeter.isHardLimitExceeded()) {
            console.warn(`[OpenAIRealtime] Presupuesto duro excedido (${costSummary.totalCostUsd} USD). Solicitando fin de llamada.`);
            this.events.onHangupRequested("hard_limit_exceeded", "TERMINADO");
          }
        }

        // Si este response.done pertenece a una respuesta previa o inactiva, NO alterar el turno activo
        if (resp?.id && this.activeResponseId && resp.id !== this.activeResponseId) {
          console.log(`[OpenAIRealtime] Recibido response.done de respuesta previa/inactiva (${resp.id}). Conservando turno activo (${this.activeResponseId}).`);
          return;
        }

        this.events.onTurnEnd(this.turnCounter);

        if (this.pendingGreetingResolver) {
          this.pendingGreetingResolver();
          this.pendingGreetingResolver = null;
        }

        this.activeResponseId = null;

        // Si este response.done corresponde a un turno de llamada a herramientas, lanzar ahora la respuesta hablada con instrucciones exactas
        if (this.pendingToolFollowup && handle.ws.readyState === WebSocket.OPEN) {
          this.pendingToolFollowup = false;
          const createPayload: any = { type: "response.create" };
          if (this.pendingToolInstruction) {
            createPayload.response = { instructions: this.pendingToolInstruction };
            this.pendingToolInstruction = null;
          }
          handle.ws.send(JSON.stringify(createPayload));
          return;
        }

        // Si se emitió la despedida hablada final (o respuesta posterior a despedida) y terminó de generarse el audio
        if ((this.isFarewellInProgress || this.isAwaitingPostFarewell) && this.currentTurnAudioSamples24k > 0) {
          this.isFarewellInProgress = false;
          this.isAwaitingPostFarewell = true;
          const reason = this.farewellReason || "authorized_closed";
          const outcome = this.farewellOutcome || "AUTORIZADO";
          const remainingAudioMs = Math.max(0, this.playbackEndTimeMs - Date.now());
          const waitMs = Math.min(15000, remainingAudioMs + 2200);
          console.log(`[OpenAIRealtime] Despedida final hablada emitida (${Math.round(remainingAudioMs)}ms de audio restante). Colgando en ${Math.round(waitMs)}ms (${reason}).`);
          if (this.farewellHangupTimer) clearTimeout(this.farewellHangupTimer);
          this.farewellHangupTimer = setTimeout(() => {
            this.farewellHangupTimer = null;
            if (this.isCallActive) {
              console.log(`[OpenAIRealtime] Finalizando llamada tras reproducción íntegra de la despedida (${reason}).`);
              this.events.onHangupRequested(reason, outcome);
            }
          }, waitMs);
        } else if (this.pendingHangup && this.currentTurnAudioSamples24k > 0) {
          const { reason, outcome } = this.pendingHangup;
          this.pendingHangup = null;
          this.isAwaitingPostFarewell = true;
          const remainingAudioMs = Math.max(0, this.playbackEndTimeMs - Date.now());
          const waitMs = Math.min(15000, remainingAudioMs + 2200);
          console.log(`[OpenAIRealtime] Esperando ${Math.round(waitMs)}ms (audio restante: ${Math.round(remainingAudioMs)}ms) para finalizar llamada (${reason}).`);
          if (this.farewellHangupTimer) clearTimeout(this.farewellHangupTimer);
          this.farewellHangupTimer = setTimeout(() => {
            this.farewellHangupTimer = null;
            if (this.isCallActive) {
              console.log(`[OpenAIRealtime] Ejecutando fin de llamada tras reproducción completa (${reason}).`);
              this.events.onHangupRequested(reason, outcome || "AUTORIZADO");
            }
          }, waitMs);
        }

        this.state = "listening";
        this.events.onState("listening");
        break;
      }

      case "error": {
        if (
          event.error?.code === "response_cancel_not_active" ||
          event.error?.code === "conversation_already_has_active_response"
        ) {
          // Ignorar cancelación benigna o colisión de respuesta en vuelo
          break;
        }
        console.error(`[OpenAIRealtime] Evento de error del servidor (${handle.role}):`, event.error);
        this.events.onError(new Error(event.error?.message || "OpenAI Realtime error"));
        break;
      }
    }
  }

  private async handleFunctionCall(handle: ActiveSessionHandle, event: any): Promise<void> {
    const callId = event.call_id;
    const name = event.name;
    let args: any = {};
    try {
      args = JSON.parse(event.arguments || "{}");
    } catch {
      args = {};
    }

    // Si entra una nueva llamada a herramienta (p. ej. el cliente corrigió el teléfono), cancelar cualquier colgado previo pendiente
    if (this.farewellHangupTimer || this.isAwaitingPostFarewell) {
      this.cancelPendingFarewellHangup(`nueva herramienta invocada: ${name}`);
    }

    console.log(`[OpenAIRealtime Herramienta]: ${name}`, args);
    let outputResult = "ok";
    const isFormal = this.selectedVariant === "formal";

    if (name === "transfer_to_technical") {
      if (this.handoffController) {
        const transferRes = await this.handoffController.executeTransfer(args);
        outputResult = JSON.stringify(transferRes);
      } else {
        outputResult = JSON.stringify({ success: false, message: "Traspaso no configurado" });
      }
    } else if (name === "transfer_to_human") {
      this.isTransferring = true;
      if (this.handoffController) {
        const transferRes = await this.handoffController.transferToHuman(args);
        outputResult = JSON.stringify(transferRes);
        this.pendingToolInstruction = transferRes.feedback;
      } else {
        outputResult = JSON.stringify({ success: false, message: "Transferencia no disponible" });
      }
    } else if (name === "get_product_info") {
      const topic = (args.topic || "").toLowerCase();
      const cat = this.contextStore.getState().catalog;
      let info = `Muestra gratuita sin compromiso. Web completa: instalación ${cat.installPrice} euros y mantenimiento ${cat.monthlyPriceBasic} o ${cat.monthlyPriceFull} euros al mes.`;
      if (topic.includes("precio") || topic.includes("tarifa")) {
        info = `Precio oficial: Muestra previa 100% gratuita. Contratación final: ${cat.installPrice} € de alta y ${cat.monthlyPriceBasic} € o ${cat.monthlyPriceFull} €/mes según plan.`;
      } else if (topic.includes("movil") || topic.includes("telefono")) {
        info = cat.features.adaptacion_movil;
      } else if (topic.includes("dominio") || topic.includes("alojamiento")) {
        info = cat.features.dominio_alojamiento;
      }
      this.pendingToolInstruction = `Responde directamente a la duda del cliente en una sola frase natural y cercana en Español de España usando esta información (${info}), y pregúntale si le parece bien que le mandemos primero la muestra gratuita por WhatsApp sin compromiso. PROHIBIDO decir frases como 'voy a explicarte' o 'con esta información'.`;
      outputResult = JSON.stringify({ topic, info });
    } else if (name === "record_whatsapp_consent") {
      // Consentimiento explícito y estricto booleano true (argumentos vacíos o false NO autorizan)
      const consentGiven = args.consent_given === true;
      const allUserText = `${args.client_evidence_quote || ""} ${this.userTranscripts.map((u) => u.text).join(" ")}`;
      const explicitlyAskedToSend = /\b(whatsapp|muestra|demo|env[ií]a|m[aá]nda|p[aá]sa|ap[uú]nta|[6789]\d{8})\b/i.test(allUserText);

      if (!consentGiven) {
        console.log("[OpenAIRealtime] Consentimiento no afirmativo en record_whatsapp_consent:", args);
        this.contextStore.setOutcome("RECHAZADO");
        outputResult = JSON.stringify({ authorized: false, feedback: "Cliente no otorgó consentimiento afirmativo explícito." });
      } else if (!this.proposalPresented && !explicitlyAskedToSend) {
        console.log("[OpenAIRealtime] Bloqueado cierre prematuro en saludo inicial: pidiendo presentar la propuesta primero.");
        this.proposalPresented = true;
        this.unlockWhatsappTool(handle);
        this.contextStore.setStage(2);
        appEvents.broadcast({
          type: "stage_update",
          stage: 2,
          sessionId: this.callId,
          context: {
            currentStage: 2,
            outcomeStatus: "EN_CURSO",
            whatsappAuthorized: false,
            phoneConfirmed: false,
          },
        });
        const directProposal = isFormal
          ? "Mire, le llamo muy brevemente de Forja Web porque vimos su ficha en Google Maps sin página web y nos gustaría prepararle una muestra gratuita sin compromiso y enviársela por WhatsApp. ¿Le parecería bien?"
          : "Mira, te llamo nada, medio minuto, porque estaba viendo vuestra ficha en Google Maps y como vi que no tenéis página web, quería prepararos una muestra gratuita sin compromiso y pasártela por WhatsApp para que veas cómo quedaría. ¿Te parece bien?";
        this.pendingToolInstruction = `PROHIBIDO decir frases previas como 'voy a darte el contexto' o 'perfecto, te cuento'. Di directamente esta frase en voz alta con naturalidad: "${directProposal}"`;
        outputResult = JSON.stringify({
          authorized: false,
          feedback: directProposal,
        });
      } else {
        const realUserText = this.userTranscripts.map((u) => u.text).join(" ").toLowerCase();
        const lastUserText = this.userTranscripts.length > 0 ? this.userTranscripts[this.userTranscripts.length - 1].text.toLowerCase() : "";

        // 1. Candado de objeción de coste: Si el cliente expresó duda o reparo sobre pagar ("no voy a pagar nada", "¿cuánto cuesta?")
        const isPriceConcern = /(pagar|cu[aá]nto|cuesta|precio|cobro|coste|tarifa)/i.test(lastUserText) &&
          !/(env[ií]a|m[aá]nda|p[aá]sa|vale|s[ií]|de\s+acuerdo|adelante|m[aá]ndala)/i.test(lastUserText);

        if (consentGiven && isPriceConcern) {
          console.log("[OpenAIRealtime] Bloqueada autorización prematura: el cliente solo preguntó por el coste o aclaró que no pagará.");
          const directFreeClarification = isFormal
            ? "Por supuesto, faltaría más. La muestra que le enviamos por WhatsApp es cien por cien gratuita y sin ningún compromiso, solo para que usted la vea. ¿Le parece bien que se la preparemos sin coste y se la enviemos por WhatsApp?"
            : "¡Nada, cero compromiso, faltaría más! La muestra que te paso por WhatsApp es cien por cien gratis para que le eches un ojo sin pagar ni un céntimo. ¿Te parece bien que te la mande por WhatsApp?";
          this.pendingToolInstruction = `PROHIBIDO decir frases como 'con ese consentimiento en cuenta' o 'entiendo tu punto'. Di directamente esta frase en voz alta con tono cercano y natural: "${directFreeClarification}"`;
          outputResult = JSON.stringify({
            authorized: false,
            feedback: directFreeClarification,
          });
        } else {
          // 2. Extraer y validar dígitos evaluando cada fuente POR SEPARADO (jamás concatenar acumulador + transcripción + args.phone)
          const accumClean = this.accumulatedPhoneDigits.replace(/\D/g, "");
          const argPhoneClean = normalizeSpokenSpanishDigits(args.phone || "").replace(/\D/g, "");
          const quotePhoneClean = normalizeSpokenSpanishDigits(args.client_evidence_quote || "").replace(/\D/g, "");

          let finalPhone = "";
          // 1. Si argPhoneClean o quotePhoneClean ya traen los 9 dígitos de España (detectados directamente del audio por el modelo):
          if (argPhoneClean.length === 9 && /^[6789]\d{8}$/.test(argPhoneClean)) {
            finalPhone = argPhoneClean;
          } else if (quotePhoneClean.length === 9 && /^[6789]\d{8}$/.test(quotePhoneClean)) {
            finalPhone = quotePhoneClean;
          } else if (accumClean.length === 9 && /^[6789]\d{8}$/.test(accumClean)) {
            finalPhone = accumClean;
          } else if (
            accumClean.length >= 5 &&
            accumClean.length < 9 &&
            argPhoneClean.length >= 1 &&
            argPhoneClean.length <= 4 &&
            !accumClean.endsWith(argPhoneClean) &&
            (accumClean + argPhoneClean).length === 9 &&
            /^[6789]\d{8}$/.test(accumClean + argPhoneClean)
          ) {
            // El modelo escuchó el último bloque de dígitos antes de que llegase el evento de transcripción de Whisper
            finalPhone = accumClean + argPhoneClean;
          } else if (accumClean.length > 9) {
            if (argPhoneClean.length === 9 && /^[6789]\d{8}$/.test(argPhoneClean)) {
              finalPhone = argPhoneClean;
            } else if (/^[6789]\d{8}$/.test(accumClean.slice(-9))) {
              finalPhone = accumClean.slice(-9);
            } else {
              const m = accumClean.match(/([6789]\d{8})/g);
              if (m && m.length > 0) {
                finalPhone = m[m.length - 1];
              }
            }
          } else if (argPhoneClean.length > 9 && /^[6789]\d{8}$/.test(argPhoneClean.slice(-9))) {
            finalPhone = argPhoneClean.slice(-9);
          }

          if (finalPhone) {
            console.log(`[OpenAIRealtime] 🎯 Número móvil de 9 dígitos detectado y validado: ${finalPhone}`);
          }

          // 3. Comprobar si el cliente en sus propias palabras indicó otro número
          const lastTwoTurns = this.userTranscripts.slice(-2).map((u) => u.text).join(" ").toLowerCase();
          const deniesThisNumber = /\b(este\s+no|a\s+este\s+no|al\s+mismo\s+no|otro\s+m[oó]vil|otro\s+n[uú]mero|no\s+a\s+este|no\s+al\s+mismo|no,\s*otro|apunta)\b/i.test(lastTwoTurns);
          const rawDigits = (finalPhone || accumClean || argPhoneClean).trim();

          // Si el cliente empezó a dictar un número pero tiene entre 1 y 8 dígitos
          if (consentGiven && !finalPhone && rawDigits.length > 0 && rawDigits.length < 9) {
            console.log(`[OpenAIRealtime] Número incompleto recibido (${rawDigits}, ${rawDigits.length} dígitos). Pidiendo los dígitos restantes.`);
            const partialSpoken = this.formatPhoneForSpeech(rawDigits, args.client_evidence_quote);
            const askRestPhrase = isFormal
              ? `Disculpe, tengo anotado el ${partialSpoken}, ¿me podría indicar los últimos números que faltan?`
              : `Perdona, tengo apuntado el ${partialSpoken}, ¿me dices los últimos números que faltan?`;
            this.pendingToolInstruction = `Di directamente esta frase en voz alta sin añadir preámbulos: "${askRestPhrase}"`;
            outputResult = JSON.stringify({
              authorized: false,
              feedback: askRestPhrase,
            });
          } else if (consentGiven && !finalPhone && deniesThisNumber) {
            // El cliente indicó explícitamente enviar a otro móvil
            console.log("[OpenAIRealtime] El cliente indicó enviar a otro móvil. Pidiendo el número.");
            const askPhonePhrase = isFormal
              ? "Perfecto, dígame el número de móvil al que se lo enviamos y se lo anoto."
              : "Perfecto, dime el número de móvil y te lo apunto para el WhatsApp.";
            this.pendingToolInstruction = `PROHIBIDO decir 'con ese consentimiento en cuenta' ni frases internas. Di directamente esta pregunta en voz alta con naturalidad: "${askPhonePhrase}"`;
            outputResult = JSON.stringify({
              authorized: false,
              feedback: askPhonePhrase,
            });
          } else {
            // El cliente aceptó la demo: cualquier tipo de aceptación es suficiente. Se envía a los 9 dígitos dictados o a "este" por defecto.
            const isThisNumber = !finalPhone;
            const phoneArg = isThisNumber ? "este" : finalPhone;

            let res: any = null;
            if (this.handoffController) {
              res = this.handoffController.handleWhatsAppConsent({
                ...args,
                consent_given: consentGiven,
                phone: phoneArg,
                userTranscripts: this.userTranscripts.map((u) => u.text),
              });
            } else {
              res = { authorized: consentGiven, feedback: "Consentimiento registrado." };
            }

            if (res.authorized) {
              const confirmedPhone = isThisNumber
                ? (this.contextStore.getState().confirmed_phone || "este")
                : phoneArg;
              this.contextStore.setWhatsAppAuthorized(true, confirmedPhone, args.client_evidence_quote || "Aceptado");
              this.contextStore.setOutcome("AUTORIZADO");
              this.contextStore.setStage(5);
              this.isFarewellInProgress = true;
              this.isAwaitingPostFarewell = true;
              this.farewellReason = "authorized_closed";
              this.farewellOutcome = "AUTORIZADO";

              // Despedida formal / cercana prometiendo la demo en 1 o 2 días con info de Maps (sin "10 minutos")
              let farewellPhrase = "";
              if (finalPhone && finalPhone.length === 9) {
                const spokenPhone = this.formatPhoneForSpeech(finalPhone, args.client_evidence_quote);
                farewellPhrase = isFormal
                  ? `¡Perfecto! Queda anotado el ${spokenPhone}. En uno o dos días se la preparamos con la información de Maps y se la enviamos por WhatsApp. Muchas gracias y que tenga un excelente día.`
                  : `¡Perfecto! Me queda apuntado el ${spokenPhone}. En uno o dos días te la preparamos con los datos de Maps y te la dejamos en el WhatsApp. ¡Muchas gracias y que pases muy buen día!`;
              } else {
                farewellPhrase = isFormal
                  ? "¡Perfecto! En uno o dos días se la preparamos con la información de Maps y se la enviamos por WhatsApp a este mismo número. Muchas gracias y que tenga un excelente día."
                  : "¡Genial! Pues en uno o dos días te la preparamos con los datos de Maps y te la dejamos en el WhatsApp a este mismo número. ¡Muchas gracias y que tengas muy buen día!";
              }
              this.pendingToolInstruction = `Di directamente esta frase de despedida en voz alta respetando exactamente las pausas de las comas en el teléfono ("${farewellPhrase}"), sin añadir nada antes.`;

              appEvents.broadcast({ type: "whatsapp_authorized", sessionId: this.callId });
              appEvents.broadcast({
                type: "stage_update",
                stage: 5,
                sessionId: this.callId,
                context: {
                  currentStage: 5,
                  outcomeStatus: "AUTORIZADO",
                  whatsappAuthorized: true,
                  phoneConfirmed: true,
                  confirmedPhone,
                },
              });

              // Emisión atómica inmediata en el Outbox sin esperar al colgado
              try {
                const bizName = this.contextStore.getState().business.name || "";
                outboxProducer.emitWhatsAppAuthorized(this.callId, {
                  phone: confirmedPhone,
                  confirmedPhone,
                  company: bizName,
                  evidenceQuote: args.client_evidence_quote || "Autorizado explícitamente en llamada",
                });
                if (finalPhone && finalPhone.length === 9) {
                  outboxProducer.emitPhoneConfirmed(this.callId, {
                    phone: finalPhone,
                    evidenceQuote: args.client_evidence_quote,
                  });
                }
              } catch (e: any) {
                console.warn("[OpenAIRealtime] Advertencia encolando evento whatsapp_authorized:", e.message);
              }
            } else if (!consentGiven) {
              this.isFarewellInProgress = true;
              this.isAwaitingPostFarewell = true;
              this.farewellReason = "refusal";
              this.farewellOutcome = "RECHAZADO";
              const refusalPhrase = isFormal
                ? "Entendido perfectamente, le agradezco mucho su tiempo. Que tenga un muy buen día."
                : "Nada, sin problema ninguno, ¡muchas gracias por tu tiempo y que tengas muy buen día!";
              this.pendingToolInstruction = `Despídete amablemente diciendo: "${refusalPhrase}"`;

              try {
                const currentPhone = this.contextStore.getState().confirmed_phone || "";
                if (currentPhone) {
                  outboxProducer.emitContactOptedOut(this.callId, {
                    phone: currentPhone,
                    reason: "refusal",
                    evidenceQuote: args.client_evidence_quote || "Rechazo en llamada",
                  });
                }
              } catch (e: any) {
                console.warn("[OpenAIRealtime] Advertencia encolando evento contact_opted_out:", e.message);
              }
            }
            outputResult = JSON.stringify(res);
          }
        }
      }
    } else if (name === "mark_call_outcome") {
      const outcome = (args.outcome || "EN_CURSO") as CallOutcomeStatus;
      this.contextStore.setOutcome(outcome);
      outputResult = JSON.stringify({ outcome_updated: outcome });
    } else if (name === "request_end_call") {
      if (this.isTransferring) {
        console.log("[OpenAIRealtime] Ignorando request_end_call porque la llamada ya está siendo transferida a un humano.");
        outputResult = JSON.stringify({ status: "ignored_transfer_in_progress" });
        return;
      }
      const reason = args.reason || "despedida_normal";
      const lastUserText = this.userTranscripts.length > 0 ? this.userTranscripts[this.userTranscripts.length - 1].text.trim() : "";
      const hadPhoneActivity = this.hadPhoneDictationInCall || this.userPhoneChunks.length > 0 || this.accumulatedPhoneDigits.length > 0;
      const isExplicitRefusal = /\b(no\s+quiero|no\s+me\s+interesa|d[eé]jalo|olv[ií]dalo|no\s+mandes|no\s+hace\s+falta|paso|cuelga|ahora\s+mismo\s+no|hasta\s+luego|adi[oó]s)\b/i.test(lastUserText);
      const looksLikePhoneCorrection =
        hadPhoneActivity &&
        !isExplicitRefusal &&
        (/\b(no|mal|equivocado|otro|veces|repite|espera|\d)\b/i.test(lastUserText));

      if (!this.proposalPresented && reason === "authorized_closed") {
        console.log("[OpenAIRealtime] Ignorando request_end_call prematuro antes de presentar la propuesta.");
        this.proposalPresented = true;
        this.unlockWhatsappTool(handle);
        const explainFirst = "Mira, te llamo medio minuto porque vi vuestra ficha en Google Maps sin página web y quería prepararte una muestra gratuita sin compromiso y pasártela por WhatsApp. ¿Te parece bien?";
        this.pendingToolInstruction = `Di directamente esta frase en voz alta: "${explainFirst}"`;
        outputResult = JSON.stringify({
          status: "ignored_explain_proposal_first",
          feedback: explainFirst,
        });
      } else if (looksLikePhoneCorrection) {
        console.log(`[OpenAIRealtime] 🛡️ Bloqueado request_end_call erróneo durante corrección de teléfono ("${lastUserText}"). Pidiendo repetir el número.`);
        this.accumulatedPhoneDigits = "";
        this.userPhoneChunks = [];
        const retryPhonePhrase = isFormal
          ? "Disculpe, le he entendido mal el número. ¿Me lo podría repetir despacio desde el principio para anotarlo bien?"
          : "Perdona, te he entendido mal el número. ¿Me lo repites despacio desde el principio para apuntarlo bien?";
        this.pendingToolInstruction = `El cliente NO ha rechazado la muestra, solo ha dicho que el número apuntado estaba mal. Di directamente esta frase en voz alta: "${retryPhonePhrase}"`;
        outputResult = JSON.stringify({
          status: "phone_correction_in_progress_do_not_end",
          feedback: retryPhonePhrase,
        });
      } else {
        const currentOutcome = this.contextStore.getState().outcome;
        const outcome: CallOutcomeStatus =
          currentOutcome && currentOutcome !== "EN_CURSO"
            ? currentOutcome
            : reason.includes("refus")
            ? "RECHAZADO"
            : "AUTORIZADO";
        this.contextStore.setOutcome(outcome);
        console.log(`[OpenAIRealtime]: Solicitud de fin de llamada recibida (${reason}). Se colgará tras finalizar el audio de despedida.`);
        this.isFarewellInProgress = true;
        this.isAwaitingPostFarewell = true;
        this.farewellReason = reason;
        this.farewellOutcome = outcome;
        const goodbyePhrase = isFormal
          ? "Entendido perfectamente, muchas gracias por su atención y que tenga un buen día."
          : "Nada, sin problema, ¡muchas gracias por tu tiempo y que tengas muy buen día!";
        this.pendingToolInstruction = `Despídete cordialmente en una sola frase breve diciendo: "${goodbyePhrase}"`;
        outputResult = JSON.stringify({
          status: "ending_call_scheduled",
          feedback: goodbyePhrase,
        });
      }
    }

    // Enviar resultado de función al modelo y programar continuación al finalizar el turno de herramientas
    if (handle.ws.readyState === WebSocket.OPEN) {
      handle.ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: outputResult,
          },
        })
      );

      if (name !== "transfer_to_technical") {
        // Si response.done ya ocurrió antes de terminar el async handler, enviar response.create con las instrucciones exactas;
        // si la respuesta aún sigue abierta, marcar pendingToolFollowup para enviarlo en response.done sin colisión.
        if (!this.activeResponseId) {
          this.pendingToolFollowup = false;
          const createPayload: any = { type: "response.create" };
          if (this.pendingToolInstruction) {
            createPayload.response = { instructions: this.pendingToolInstruction };
            this.pendingToolInstruction = null;
          }
          handle.ws.send(JSON.stringify(createPayload));
        } else {
          this.pendingToolFollowup = true;
        }
      }
    }
  }

  public async requestInitialGreeting(): Promise<void> {
    if (!this.activeSession || !this.activeSession.isReady) {
      // Esperar brevemente a que la sesión esté lista
      await new Promise((r) => setTimeout(r, 500));
    }

    const rawBizName = (this.contextStore.getState().business.name || "").trim();
    const hasSpecificBizName =
      rawBizName.length > 1 &&
      !/^(taller\s*de\s*prueba|cliente\s*web|negocio\s*local|desconocido|test|prueba)$/i.test(rawBizName);

    const isInbound = this.contextStore.getState().call_direction === "inbound";
    const timeGreeting = getSpainTimeGreeting();
    const isFemale = ["marin", "coral", "shimmer", "sage", "ballad"].includes((this.activeSession?.voice || "cedar").toLowerCase());
    const agentName = isFemale ? "Laura" : "Juan";
    let greetingPhrase = "";
    if (isInbound) {
      greetingPhrase = `${timeGreeting}, Forja Web, le atiende ${agentName}, dígame.`;
    } else if (this.selectedVariant === "formal") {
      greetingPhrase = hasSpecificBizName
        ? `${timeGreeting}. ¿Sería tan amable de indicarme si hablo con la persona responsable de ${rawBizName}?`
        : `${timeGreeting}. ¿Sería tan amable de indicarme si hablo con la persona responsable del negocio?`;
    } else {
      greetingPhrase = hasSpecificBizName
        ? `Hola, ${timeGreeting.toLowerCase()}. ¿Hablo con el responsable de ${rawBizName}?`
        : `Hola, ${timeGreeting.toLowerCase()}. ¿Hablo con el responsable del negocio?`;
    }

    console.log(`[OpenAIRealtime - Saludo (${isInbound ? "Entrante" : this.selectedVariant})]: "${greetingPhrase}"`);
    await this.speakPhraseDirectly(greetingPhrase);
  }

  private speakPhraseDirectly(phrase: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.activeSession || this.activeSession.ws.readyState !== WebSocket.OPEN) {
        return resolve();
      }

      const timer = setTimeout(() => {
        if (this.pendingGreetingResolver) {
          this.pendingGreetingResolver = null;
          resolve();
        }
      }, 5000);

      this.pendingGreetingResolver = () => {
        clearTimeout(timer);
        resolve();
      };

      this.activeSession.ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: `Di exactamente la siguiente frase en voz alta en Español de España con tono humano, cercano y natural, sin añadir ninguna palabra antes ni después: "${phrase}"`,
          },
        })
      );
    });
  }

  private async switchToTechnicalSession(technicalSession: ActiveSessionHandle): Promise<void> {
    console.log("[OpenAIRealtime] Conmutando atómicamente al Asistente Técnico...");
    this.generationEpoch++;
    this.activeRole = "technical";
    this.events.onRoleChanged("technical");

    // Cerrar sesión comercial previa
    if (this.activeSession) {
      try {
        this.activeSession.ws.close();
      } catch {
        // Ignorar
      }
    }

    this.activeSession = technicalSession;
    this.playbackTracker.reset();
    this.downlinkResampler.reset();

    // Técnico responde a la duda con saludo único
    const exactQuestion = this.contextStore.getState().exact_question || "tu consulta sobre la página web";
    const promptForTechnical = `[INSTRUCCIÓN DE TRASPASO: El cliente tiene la siguiente duda técnica: "${exactQuestion}". Saluda una vez como asistente técnico de Forja Web y resuelve su duda con claridad y brevedad].`;

    // Aplicar límite estricto de duración de la intervención técnica
    const maxTechSeconds = this.config.technicalMaxDurationSeconds || 90;
    if (this.technicalDurationTimer) clearTimeout(this.technicalDurationTimer);
    this.technicalDurationTimer = setTimeout(() => {
      console.warn(`[OpenAIRealtime] Límite de intervención técnica alcanzado (${maxTechSeconds}s). Finalizando.`);
      this.events.onHangupRequested("technical_max_duration_exceeded", "TERMINADO");
    }, maxTechSeconds * 1000);

    technicalSession.ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: promptForTechnical,
            },
          ],
        },
      })
    );

    technicalSession.ws.send(
      JSON.stringify({
        type: "response.create",
      })
    );
  }

  public pushInputAudio(pcm: Int16Array, raw: Buffer): void {
    if (!this.isCallActive || !this.activeSession || !this.activeSession.isReady) {
      return;
    }

    let base64Audio: string;
    if (this.isPcma) {
      // Telefonía: el puente ya entrega A-law 8 kHz (audio/pcma). Sin remuestreo.
      if (raw.length === 0) return;
      base64Audio = raw.toString("base64");
    } else {
      // Navegador: remuestrear audio del micrófono de 16kHz a 24kHz requerido por OpenAI
      const pcm24k = this.uplinkResampler.process(pcm);
      if (pcm24k.length === 0) return;

      base64Audio = Buffer.from(
        pcm24k.buffer,
        pcm24k.byteOffset,
        pcm24k.byteLength
      ).toString("base64");
    }

    if (this.activeSession.ws.readyState === WebSocket.OPEN) {
      this.activeSession.ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio,
        })
      );
    }
  }

  public interrupt(playbackPositionMs?: number): void {
    if (!this.activeSession || this.activeSession.ws.readyState !== WebSocket.OPEN) return;

    this.events.onFlush(this.turnCounter);
    const trunc = this.playbackTracker.truncateActiveItem(playbackPositionMs || 0);
    if (trunc) {
      this.activeSession.ws.send(
        JSON.stringify({
          type: "conversation.item.truncate",
          item_id: trunc.itemId,
          content_index: trunc.contentIndex,
          audio_end_ms: trunc.audioEndMs,
        })
      );
    }

    if (this.activeResponseId) {
      this.cancelledResponseIds.add(this.activeResponseId);
      this.activeSession.ws.send(JSON.stringify({ type: "response.cancel" }));
      this.activeResponseId = null;
    }
  }

  public handlePlaybackDrained(turnId: number): void {
    this.drainedTurns.add(turnId);
    if (this.playbackDrainedResolver) {
      // El resolver solo se anula a sí mismo cuando drainedTurnId === targetTurn.
      // No anularlo aquí para no perder turnos pendientes si llega confirmación de otro turno.
      this.playbackDrainedResolver(turnId);
    }
  }

  public handlePlaybackStarted(turnId: number): void {
    this.playbackTracker.markPlaybackStarted();
  }

  public getCallSessionSummary() {
    const s = this.contextStore.getState();
    const allItems: Array<{ role: "user" | "assistant"; text: string; timestamp: number }> = [];
    for (const u of this.userTranscripts) {
      allItems.push({ role: "user", text: u.text, timestamp: u.timestamp });
    }
    for (const a of this.assistantTranscripts) {
      allItems.push({ role: "assistant", text: a.text, timestamp: a.timestamp });
    }
    allItems.sort((x, y) => x.timestamp - y.timestamp);

    return {
      outcomeStatus: s.outcome,
      whatsappAuthorized: s.whatsapp_authorized,
      phoneConfirmed: s.phone_confirmed,
      evidenceQuote: s.evidence_quote || undefined,
      confirmedPhone: s.confirmed_phone || undefined,
      scriptVariant: this.selectedVariant,
      transcripts: allItems.map((item) => ({ role: item.role, text: item.text })),
      userTranscripts: this.userTranscripts.map((u) => u.text),
    };
  }

  public async stop(reason: string): Promise<void> {
    console.log(`[OpenAIRealtime] Cerrando sesión (${reason})...`);
    this.isCallActive = false;
    this.cancelPendingFarewellHangup("stop");
    if (this.pendingGreetingResolver) {
      this.pendingGreetingResolver();
      this.pendingGreetingResolver = null;
    }

    if (this.callDurationTimer) {
      clearTimeout(this.callDurationTimer);
      this.callDurationTimer = null;
    }
    if (this.technicalDurationTimer) {
      clearTimeout(this.technicalDurationTimer);
      this.technicalDurationTimer = null;
    }

    this.handoffController?.cancel(`call_stopped: ${reason}`);
    this.interrupt();

    if (this.activeSession) {
      try {
        this.activeSession.ws.close();
      } catch {
        // Ignorar
      }
      this.activeSession = null;
    }
  }
}
