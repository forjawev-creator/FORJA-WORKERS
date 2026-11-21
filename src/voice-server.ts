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

  const server = net.createServer((socket) => {
    if (!runtimePolicy().realCallsEnabled) { socket.destroy(); return; }
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[Bridge] Conexión TCP de audio establecida desde ${remoteAddress}`);

    let isCallActive = false;
    let activeOutboundCallId: string | null = null;
    let activeOutboundLead: any = null;
    let callStartTime = 0;
    let completionSaved = false;
    let endNotified = false;
    let connectionClosed = false;
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

    function reportError(error: unknown, prefix = "Fallo de voz") {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Voice] ${prefix}: ${message}`);
      appEvents.broadcast({ type: "provider_error", sessionId: currentSessionId, error: `${prefix}: ${message}` });
    }

    function finishCall(reason: string): boolean {
      if (!callStartTime) return true;
      const summary = engine?.getCallSessionSummary?.();
      if (!completionSaved && !currentSessionId.startsWith("browser_")) {
        try {
          outboxProducer.emitCallCompleted({
            sessionId: currentSessionId, channel: "telephony", company: currentCallCompany,
            phone: currentCallPhone, durationSeconds: Math.max(1, Math.round((Date.now() - callStartTime) / 1000)),
            status: summary?.outcomeStatus || "TERMINADO",
            whatsappAuthorized: Boolean(summary?.whatsappAuthorized),
            phoneConfirmed: Boolean(summary?.phoneConfirmed),
            confirmedPhone: summary?.confirmedPhone || currentCallPhone,
            evidenceQuote: summary?.evidenceQuote, transcript: summary?.transcripts || [],
            scriptVariant: summary?.scriptVariant,
          });
          completionSaved = true;
        } catch (error) {
          reportError(error, "No se pudo guardar el resultado");
          return false;
        }
      }
      if (!endNotified) {
        endNotified = true;
        appEvents.broadcast({ type: "call_end", sessionId: currentSessionId,
          outcome: summary?.outcomeStatus || "TERMINADO", sessionSummary: summary, reason,
          whatsappAuthorized: summary?.whatsappAuthorized, evidenceQuote: summary?.evidenceQuote,
          confirmedPhone: summary?.confirmedPhone });
        appEvents.broadcast({ type: "state", state: "idle", sessionId: currentSessionId });
      }
      return true;
    }

    async function stopEngine(reason: string) {
      try { await engine?.stop(reason); }
      catch (error) { reportError(error, "No se pudo cerrar el motor de voz"); }
    }

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
        finishCall(reason);
        void stopEngine(reason);

      },
    };

    async function processChunk(chunk: Buffer) {
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
          if (isCallActive || callStartTime || connectionClosed) continue;
          if (!runtimePolicy().realCallsEnabled) { socket.destroy(); return; }
          completionSaved = false;
          endNotified = false;
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
          if (!/^[a-zA-Z0-9_-]{1,160}$/.test(currentSessionId)) {
            throw new Error("Identificador de llamada inválido");
          }

          callStartTime = Date.now();
          currentCallPhone = activeOutboundLead?.telefono || parsedPhone || "";
          currentCallCompany = activeOutboundLead?.empresa_nombre || parsedCompany || "";
          activeOutboundLead = null;

          console.log(`\n[Telefonía] >>> LLAMADA CONECTADA (CALL_START). Sesión: ${currentSessionId} <<<`);
          isCallActive = true;
          appEvents.broadcast({ type: "state", state: "speaking", sessionId: currentSessionId });

          try {
            const config = buildAgentConfig();
            engine = createConversationEngine(config, engineEvents);
            await engine.start(currentSessionId, socket, initialContext);
            if (isCallActive && !connectionClosed && !socket.destroyed) {
              await engine.requestInitialGreeting();
            }
          } catch (err: any) {
            console.error("[Telefonía] Error iniciando motor de conversación:", err);
            socket.write(encodePacket(PACKET_CALL_END, 0));
            isCallActive = false;
            reportError(err, "No se pudo iniciar el motor de voz");
            finishCall("engine_start_failed");
            await stopEngine("engine_start_failed");
          }
        } else if (packet.type === PACKET_CALL_END) {
          if (process.env.CALLS_PILOT === "1" && !packet.payload.length) continue;
          let endMeta: { sessionId?: string; reason?: string } = {};
          if (packet.payload.length) {
            try {
              endMeta = JSON.parse(packet.payload.toString("utf8"));
              if (!endMeta || typeof endMeta !== "object" || typeof endMeta.sessionId !== "string") continue;
              if (endMeta.reason !== undefined && typeof endMeta.reason !== "string") continue;
            } catch { continue; }
            if (endMeta.sessionId !== currentSessionId && endMeta.sessionId !== activeOutboundCallId) continue;
          }
          if (!callStartTime && activeOutboundCallId && endMeta.sessionId === activeOutboundCallId) {
            currentSessionId = activeOutboundCallId;
            currentCallPhone = activeOutboundLead?.telefono || "";
            currentCallCompany = activeOutboundLead?.empresa_nombre || "";
            callStartTime = Date.now(); completionSaved = false; endNotified = false;
          }
          isCallActive = false;
          const saved = finishCall(endMeta.reason || "packet_call_end");
          await stopEngine("packet_call_end");
          // Keep the session reserved after a persistence failure; a repeated terminal
          // event may retry persistence but must never initiate another call.
          if (saved) { callStartTime = 0; activeOutboundCallId = null; activeOutboundLead = null; engine = null; }
        }
      }
    }

    let packetWork = Promise.resolve();
    let queuedBytes = 0;
    socket.on("data", (chunk: Buffer) => {
      queuedBytes += chunk.length;
      if (queuedBytes > 2 * 1024 * 1024) {
        reportError(new Error("Cola de audio saturada"));
        socket.destroy(); return;
      }
      packetWork = packetWork.then(() => connectionClosed ? undefined : processChunk(chunk))
        .catch((error: unknown) => {
          reportError(error);
          isCallActive = false;
          if (!socket.destroyed) socket.write(encodePacket(PACKET_CALL_END, 0));
          finishCall("packet_processing_failed");
          return stopEngine("packet_processing_failed");
        }).finally(() => { queuedBytes -= chunk.length; });
    });
    socket.on("error", (error) => { reportError(error, "Fallo de conexión de audio"); });
    socket.on("close", () => {
      connectionClosed = true;
      isCallActive = false;
      appEvents.off("ui-event", outboundListener);
      // Never allow an async EventEmitter listener to reject without an observer.
      void packetWork.then(async () => {
        if (!callStartTime && activeOutboundCallId) {
          currentSessionId = activeOutboundCallId;
          currentCallPhone = activeOutboundLead?.telefono || "";
          currentCallCompany = activeOutboundLead?.empresa_nombre || "";
          callStartTime = Date.now(); completionSaved = false; endNotified = false;
        }
        finishCall("socket_closed");
        await stopEngine("socket_closed");
      }).catch(error => reportError(error, "Fallo al cerrar la llamada"));
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
