import { runtimePolicy } from "./runtime-policy.js";
import net from "net";
import {
  bufferToInt16Array,
  int16ArrayToBuffer,
  encodePacket,
  encodeAudioPackets,
  PacketFramer,
  PACKET_AUDIO,
  PACKET_FLUSH,
  PACKET_PLAYBACK_DRAINED,
  PACKET_CALL_START,
  PACKET_CALL_END,
  PACKET_TURN_END,
  PACKET_PLAYBACK_STARTED,
} from "./audio-bridge.js";
import { AgentConfig, CallState, CallSessionContext } from "./types.js";
import { appEvents } from "./events.js";
import { loadConfig } from "./storage.js";
import { IConversationEngine, EngineEvents } from "./engines/conversation-engine.js";
import { TogetherEngine } from "./engines/together-engine.js";
import { OpenAIRealtimeEngine } from "./engines/openai-realtime-engine.js";
import { GeminiLiveEngine } from "./engines/gemini-live-engine.js";
import { outboxProducer } from "./outbox/outbox-producer.js";

export interface VoiceServerOptions {
  port?: number;
  host?: string;
  sampleRate?: number;
}

export function createConversationEngine(config: AgentConfig, events: EngineEvents): IConversationEngine {
  if (config.conversationEngine === "gemini_live") {
    console.log("[EngineFactory] Seleccionado modo: Google Gemini Live (BidiGenerateContent)");
    return new GeminiLiveEngine(config, events);
  }
  if (config.conversationEngine === "openai_realtime") {
    console.log("[EngineFactory] Seleccionado modo: OpenAI Realtime (Voz a Voz con Doble Asistente)");
    return new OpenAIRealtimeEngine(config, events);
  }
  console.log("[EngineFactory] Seleccionado modo: Together Pipeline (STT -> LLM -> TTS)");
  return new TogetherEngine(config, events);
}

export function startVoiceBridge(options: VoiceServerOptions = {}): { server: net.Server; close: () => void } {
  const tcpPort = options.port || parseInt(process.env.AUDIO_TCP_PORT || "8080", 10);
  const tcpHost = options.host || process.env.AUDIO_TCP_HOST || "127.0.0.1";
  const sampleRate = options.sampleRate || parseInt(process.env.AUDIO_SAMPLE_RATE || "16000", 10);

  const server = net.createServer(async (socket) => {
    if (!runtimePolicy().realCallsEnabled) { socket.destroy(); return; }
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[Bridge] Conexión TCP de audio establecida desde ${remoteAddress}`);

    let isCallActive = false;
    let activeOutboundCallId: string | null = null;
    let activeOutboundLead: any = null;
    let callStartTime = 0;
    let currentCallPhone = "";
    let currentCallCompany = "";

    const outboundListener = (event: any) => {
      if (event.type === "lead_call_start" && event.callId) {
        activeOutboundCallId = event.callId;
        activeOutboundLead = event.lead || null;
      }
    };
    appEvents.on("ui-event", outboundListener);

    let currentSessionId = `tcp_${Date.now()}`;
    let engine: IConversationEngine | null = null;
    const framer = new PacketFramer();

    socket.setNoDelay(true);
    let audioCodec: "pcm16" | "pcma" = "pcm16";

    function buildAgentConfig(): AgentConfig {
      const savedCfg = loadConfig();
      return {
        apiKey: process.env.TOGETHER_API_KEY || savedCfg.togetherApiKey,
        persona: "kira",
        systemPrompt: savedCfg.systemPrompt || process.env.SYSTEM_PROMPT || "",
        sttModel: savedCfg.sttModel || process.env.STT_MODEL || "openai/whisper-large-v3",
        llmModel: savedCfg.llmModel || process.env.LLM_MODEL || "Qwen/Qwen3.5-9B",
        ttsModel: savedCfg.ttsModel || process.env.TTS_MODEL || "hexgrad/Kokoro-82M",
        ttsVoice: savedCfg.ttsVoice || process.env.TTS_VOICE || "ef_dora",
        ttsSpeed: savedCfg.ttsSpeed !== undefined ? savedCfg.ttsSpeed : 1.0,
        naturalPauses: savedCfg.naturalPauses !== false,
        sampleRate,
        audioCodec,
        maxTokens: savedCfg.maxTokens || parseInt(process.env.LLM_MAX_TOKENS || "90", 10),
        disableReasoning: savedCfg.disableReasoning !== undefined ? savedCfg.disableReasoning : (process.env.DISABLE_REASONING !== "false"),
        installPrice: savedCfg.installPrice,
        monthlyPriceBasic: savedCfg.monthlyPriceBasic,
        monthlyPriceFull: savedCfg.monthlyPriceFull,
        stages: savedCfg.stages,

        // OpenAI Realtime & Google Gemini Live
        conversationEngine: savedCfg.conversationEngine || "openai_realtime",
        openaiApiKey: process.env.OPENAI_API_KEY || savedCfg.openaiApiKey || "",
        geminiApiKey: process.env.GEMINI_API_KEY || savedCfg.geminiApiKey || "",
        geminiCommercialModel: savedCfg.geminiCommercialModel || "gemini-2.0-flash-live-001",
        geminiCommercialVoice: savedCfg.geminiCommercialVoice || "Aoede",
        geminiTechnicalModel: savedCfg.geminiTechnicalModel || "gemini-2.0-flash-live-001",
        geminiTechnicalVoice: savedCfg.geminiTechnicalVoice || "Charon",
        realtimeCommercialModel: savedCfg.realtimeCommercialModel || "gpt-realtime-2.1-mini",
        realtimeTechnicalModel: savedCfg.realtimeTechnicalModel || "gpt-realtime-2.1",
        realtimeCommercialVoice: savedCfg.realtimeCommercialVoice || "marin",
        realtimeTechnicalVoice: savedCfg.realtimeTechnicalVoice || "cedar",
        realtimeTurnDetection: savedCfg.realtimeTurnDetection || "semantic_vad",
        realtimeEagerness: savedCfg.realtimeEagerness || "medium",
        realtimeMaxOutputTokens: savedCfg.realtimeMaxOutputTokens || 512,
        handoffEnabled: savedCfg.handoffEnabled !== false,
        handoffMaxCount: savedCfg.handoffMaxCount || 1,
        handoffTimeoutMs: savedCfg.handoffTimeoutMs || 8000,
        callMaxDurationSeconds: savedCfg.callMaxDurationSeconds || 180,
        technicalMaxDurationSeconds: savedCfg.technicalMaxDurationSeconds || 90,
        callCostAlertUsd: savedCfg.callCostAlertUsd || 0.10,
        callCostSoftLimitUsd: savedCfg.callCostSoftLimitUsd || 0.20,
        callCostHardLimitUsd: savedCfg.callCostHardLimitUsd || 0.30,
        inputTranscriptionEnabled: savedCfg.inputTranscriptionEnabled === true,
        rateCardVersion: savedCfg.rateCardVersion || "2026-10-15",
      };
    }

    const engineEvents: EngineEvents = {
      onAudio: (pcmResampled, turnId) => {
        if (!isCallActive || socket.destroyed) return;
        const audioBuf = int16ArrayToBuffer(pcmResampled);
        const packets = encodeAudioPackets(turnId, audioBuf);
        for (const pkt of packets) {
          socket.write(pkt);
        }
      },
      onAudioRaw: (audio, turnId) => {
        if (!isCallActive || socket.destroyed) return;
        const packets = encodeAudioPackets(turnId, audio);
        for (const pkt of packets) {
          socket.write(pkt);
        }
      },
      onState: (state: CallState) => {
        appEvents.broadcast({ type: "state", state, sessionId: currentSessionId });
      },
      onRoleChanged: (role) => {
        console.log(`[Bridge Event] Rol activo cambiado a: ${role}`);
        appEvents.broadcast({ type: "role_changed", role, sessionId: currentSessionId });
      },
      onHandoffState: (state, detail) => {
        console.log(`[Bridge Event] Estado de traspaso: ${state} (${detail || ""})`);
        appEvents.broadcast({ type: "handoff_state", state, detail, sessionId: currentSessionId });
      },
      onTranscript: (role, text, turnId, isPartial) => {
        appEvents.broadcast({
          type: "transcript",
          role,
          text,
          turnId,
          isPartial: !!isPartial,
          sessionId: currentSessionId,
        });
      },
      onTurnStart: (turnId) => {
        appEvents.broadcast({ type: "turn_start", turnId, sessionId: currentSessionId });
      },
      onTurnEnd: (turnId) => {
        if (!socket.destroyed) {
          socket.write(encodePacket(PACKET_TURN_END, turnId));
        }
        appEvents.broadcast({ type: "turn_end", turnId, sessionId: currentSessionId });
      },
      onFlush: (turnId) => {
        if (!socket.destroyed) {
          socket.write(encodePacket(PACKET_FLUSH, turnId));
        }
        appEvents.broadcast({ type: "flush", turnId, sessionId: currentSessionId });
      },
      onUsageUpdate: (costSummary) => {
        appEvents.broadcast({
          type: "usage_update",
          costSummary,
          sessionId: currentSessionId,
        });
      },
      onError: (err) => {
        console.error("[Engine Error Event]:", err.message);
        appEvents.broadcast({
          type: "provider_error",
          error: err.message,
          sessionId: currentSessionId,
        });
      },
      onHangupRequested: (reason, outcome) => {
        console.log(`[Bridge] Solicitud de colgado recibida: ${reason} (${outcome})`);
        if (!socket.destroyed) {
          socket.write(encodePacket(PACKET_CALL_END, 0));
        }
        isCallActive = false;
        const sessionSummary = engine?.getCallSessionSummary ? engine.getCallSessionSummary() : undefined;
        appEvents.broadcast({
          type: "call_end",
          sessionId: currentSessionId,
          outcome: outcome || sessionSummary?.outcomeStatus,
          sessionSummary,
          whatsappAuthorized: sessionSummary?.whatsappAuthorized,
          evidenceQuote: sessionSummary?.evidenceQuote,
          confirmedPhone: sessionSummary?.confirmedPhone,
        });
        appEvents.broadcast({ type: "state", state: "idle", sessionId: currentSessionId });
        engine?.stop(reason).catch((e) => console.error("[Engine Stop Error]:", e));
      },
    };

    socket.on("data", async (chunk: Buffer) => {
      const packets = framer.push(chunk);

      for (const packet of packets) {
        if (packet.type === PACKET_AUDIO) {
          if (isCallActive && engine) {
            const pcm = audioCodec === "pcma" ? new Int16Array(0) : bufferToInt16Array(packet.payload);
            engine.pushInputAudio(pcm, packet.payload);
          }
        } else if (packet.type === PACKET_PLAYBACK_STARTED) {
          engine?.handlePlaybackStarted(packet.turnId);
        } else if (packet.type === PACKET_PLAYBACK_DRAINED) {
          engine?.handlePlaybackDrained(packet.turnId);
        } else if (packet.type === PACKET_CALL_START) {
          let parsedCompany: string | undefined = undefined;
          let parsedPhone: string | undefined = undefined;
          let parsedDirection: "outbound" | "inbound" = "outbound";
          audioCodec = "pcm16";

          if (packet.payload && packet.payload.length > 0) {
            const rawStr = packet.payload.toString("utf-8").trim();
            if (rawStr.startsWith("{")) {
              try {
                const meta = JSON.parse(rawStr);
                currentSessionId = meta.sessionId || `tcp_${Date.now()}`;
                parsedCompany = meta.company;
                parsedPhone = meta.phone;
                if (meta.direction === "inbound") {
                  parsedDirection = "inbound";
                }
                if (meta.codec === "pcma") {
                  audioCodec = "pcma";
                }
              } catch {
                currentSessionId = rawStr;
              }
            } else {
              currentSessionId = rawStr;
            }
          } else if (activeOutboundCallId) {
            currentSessionId = activeOutboundCallId;
            activeOutboundCallId = null;
          } else {
            currentSessionId = `tcp_${Date.now()}`;
          }

          let initialContext: CallSessionContext | undefined = undefined;
          if (activeOutboundLead && activeOutboundLead.telefono) {
            initialContext = {
              currentStage: 1,
              pendingQuestion: "CONFIRM_BUSINESS",
              businessConfirmed: false,
              companyName: activeOutboundLead.empresa_nombre || parsedCompany,
              trade: activeOutboundLead.oficio_mapeado || activeOutboundLead.categoria_maps,
              interestShown: false,
              doubtsResolved: [],
              whatsappAuthorized: false,
              phoneConfirmed: true,
              confirmedPhone: activeOutboundLead.telefono,
              outcomeStatus: "EN_CURSO",
              callDirection: "outbound",
            };
          } else if (parsedCompany || parsedPhone || parsedDirection === "inbound") {
            initialContext = {
              currentStage: 1,
              pendingQuestion: parsedDirection === "inbound" ? "NONE" : "CONFIRM_BUSINESS",
              businessConfirmed: false,
              companyName: parsedCompany,
              interestShown: false,
              doubtsResolved: [],
              whatsappAuthorized: false,
              phoneConfirmed: !!parsedPhone,
              confirmedPhone: parsedPhone,
              outcomeStatus: "EN_CURSO",
              callDirection: parsedDirection,
            };
          }
          activeOutboundLead = null;

          if (isCallActive) {
            console.warn(`[Bridge] Ignorando PACKET_CALL_START redundante para llamada ya en curso (sesión: ${currentSessionId})`);
            return;
          }

          callStartTime = Date.now();
          currentCallPhone = activeOutboundLead?.telefono || parsedPhone || "";
          currentCallCompany = activeOutboundLead?.empresa_nombre || parsedCompany || "";

          console.log(`\n[Telefonía] >>> LLAMADA CONECTADA (CALL_START). Sesión: ${currentSessionId} <<<`);
          isCallActive = true;
          appEvents.broadcast({ type: "state", state: "speaking", sessionId: currentSessionId });

          const config = buildAgentConfig();
          engine = createConversationEngine(config, engineEvents);

          try {
            await engine.start(currentSessionId, socket, initialContext);
            if (isCallActive) {
              await engine.requestInitialGreeting();
            }
          } catch (err: any) {
            console.error("[Telefonía] Error iniciando motor de conversación:", err);
            socket.write(encodePacket(PACKET_CALL_END, 0));
            isCallActive = false;
            appEvents.broadcast({ type: "state", state: "idle", sessionId: currentSessionId });
          }
        } else if (packet.type === PACKET_CALL_END) {
          console.log(`\n[Telefonía] >>> LLAMADA FINALIZADA (CALL_END). Sesión: ${currentSessionId} <<<`);
          isCallActive = false;
          activeOutboundCallId = null;

          const durationSeconds = callStartTime > 0 ? Math.max(1, Math.round((Date.now() - callStartTime) / 1000)) : 1;
          const sessionSummary = engine?.getCallSessionSummary ? engine.getCallSessionSummary() : undefined;
          appEvents.broadcast({
            type: "call_end",
            sessionId: currentSessionId,
            outcome: sessionSummary?.outcomeStatus || "DESCONOCIDO",
            sessionSummary,
            whatsappAuthorized: sessionSummary?.whatsappAuthorized,
            evidenceQuote: sessionSummary?.evidenceQuote,
            confirmedPhone: sessionSummary?.confirmedPhone,
          });
          appEvents.broadcast({ type: "state", state: "idle", sessionId: currentSessionId });

          if (!currentSessionId.startsWith("browser_")) {
            try {
              outboxProducer.emitCallCompleted({
                sessionId: currentSessionId,
                channel: "telephony",
                company: currentCallCompany,
                phone: currentCallPhone,
                durationSeconds,
                status: sessionSummary?.outcomeStatus || "TERMINADO",
                whatsappAuthorized: Boolean(sessionSummary?.whatsappAuthorized),
                phoneConfirmed: Boolean(sessionSummary?.phoneConfirmed || currentCallPhone),
                confirmedPhone: sessionSummary?.confirmedPhone || currentCallPhone,
                evidenceQuote: sessionSummary?.evidenceQuote,
                transcript: sessionSummary?.transcripts || [],
                scriptVariant: sessionSummary?.scriptVariant,
              });
            } catch (saveErr: any) {
              console.error("[Telefonía] Error encolando llamada en buzón:", saveErr.message);
            }
          }
          callStartTime = 0;

          if (engine) {
            await engine.stop("packet_call_end");
            engine = null;
          }
        }
      }
    });

    socket.on("error", (err) => {
      console.error(`[Bridge] Error en socket: ${err.message}`);
    });

    socket.on("close", async () => {
      console.log(`[Bridge] Conexión cerrada (${remoteAddress})`);
      appEvents.off("ui-event", outboundListener);

      if (isCallActive && !currentSessionId.startsWith("browser_")) {
        const durationSeconds = callStartTime > 0 ? Math.max(1, Math.round((Date.now() - callStartTime) / 1000)) : 1;
        const sessionSummary = engine?.getCallSessionSummary ? engine.getCallSessionSummary() : undefined;
        try {
          outboxProducer.emitCallCompleted({
            sessionId: currentSessionId,
            channel: "telephony",
            company: currentCallCompany,
            phone: currentCallPhone,
            durationSeconds,
            status: sessionSummary?.outcomeStatus || "TERMINADO",
            whatsappAuthorized: Boolean(sessionSummary?.whatsappAuthorized),
            phoneConfirmed: Boolean(sessionSummary?.phoneConfirmed || currentCallPhone),
            confirmedPhone: sessionSummary?.confirmedPhone || currentCallPhone,
            evidenceQuote: sessionSummary?.evidenceQuote,
            transcript: sessionSummary?.transcripts || [],
            scriptVariant: sessionSummary?.scriptVariant,
          });
        } catch (saveErr: any) {
          console.error("[Telefonía] Error encolando llamada en buzón tras cierre:", saveErr.message);
        }
      }

      isCallActive = false;
      activeOutboundCallId = null;
      callStartTime = 0;
      appEvents.broadcast({ type: "call_end", sessionId: currentSessionId });
      appEvents.broadcast({ type: "state", state: "idle", sessionId: currentSessionId });

      if (engine) {
        await engine.stop("socket_closed");
        engine = null;
      }
    });
  });

  server.listen(tcpPort, tcpHost, () => {
    console.log(`[Bridge] 🎙️ Puente de audio TCP escuchando en ${tcpHost}:${tcpPort}`);
  });

  return {
    server,
    close: () => server.close(),
  };
}
