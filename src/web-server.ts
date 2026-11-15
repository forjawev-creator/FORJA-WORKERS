import { runtimePolicy } from "./runtime-policy.js";
import { controlToken, requireControl, isControlAuthorized, handleControlLogin } from "./control-auth.js";
import http from "http";
import fs from "fs";
import path from "path";
import net from "net";
import { WebSocketServer, WebSocket } from "ws";
import {
  encodePacket,
  PacketFramer,
  PACKET_AUDIO,
  PACKET_FLUSH,
  PACKET_PLAYBACK_DRAINED,
  PACKET_CALL_START,
  PACKET_CALL_END,
  PACKET_TURN_END,
  encodeWav,
  bufferToInt16Array,
} from "./audio-bridge.js";
import { appEvents, UiEvent } from "./events.js";
import {
  loadConfig,
  saveConfig,
  getSanitizedConfig,
  loadCalls,
  saveCall,
  updateCall,
  CallRecord,
  BotConfig,
  CallOutcomeStatus,
  resolveTtsVoice,
  cleanTextForTts,
} from "./storage.js";
import {
  getBridgeStatus,
  startBridge,
  stopBridge,
  dialNetelip,
  hangupNetelip,
  transferNetelip,
} from "./bridge-manager.js";
import { handleCrmRoutes, isAllowedOrigin } from "./crm/index.js";
import { crmStorage } from "./crm/crm-storage.js";
import os from "os";
import { analyzeCallWithAI } from "./crm/call-analyzer.js";
import { normalizeSpanishPhone } from "./crm/crm-service.js";

const TCP_PORT = parseInt(process.env.AUDIO_TCP_PORT || "8080", 10);
const TCP_HOST = process.env.AUDIO_TCP_HOST || "127.0.0.1";
const WEB_PORT = parseInt(process.env.WEB_PORT || "3000", 10);

export function getLocalIpAddress(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal && !net.address.startsWith("127.")) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

export function getPublicBaseUrl(port: number = WEB_PORT): string {
  const cfg = loadConfig();
  if (cfg.publicBaseUrl && cfg.publicBaseUrl.trim()) {
    return cfg.publicBaseUrl.trim().replace(/\/+$/, "");
  }
  if (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) {
    return process.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, "");
  }
  const localIp = getLocalIpAddress();
  return `http://${localIp}:${port}`;
}

function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: any, origin?: string): void {
  const allowOrigin = isAllowedOrigin(origin) && origin ? origin : "http://127.0.0.1:3000";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

export interface CompletedCallPayload {
  sessionId?: string;
  channel?: "browser" | "telephony";
  company?: string;
  phone?: string;
  durationSeconds: number;
  status: CallOutcomeStatus;
  currentStage?: number;
  whatsappAuthorized: boolean;
  phoneConfirmed: boolean;
  confirmedPhone?: string;
  evidenceQuote?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  scriptVariant?: "cercano" | "formal";
  metrics?: any;
}

export function recordCompletedCall(payload: CompletedCallPayload): CallRecord | null {
  const {
    sessionId,
    channel = "telephony",
    company = "Cliente",
    phone = "",
    durationSeconds,
    status,
    currentStage = 1,
    whatsappAuthorized,
    phoneConfirmed,
    confirmedPhone,
    evidenceQuote,
    transcript: rawTranscript = [],
    metrics = {},
  } = payload;

  let transcript = rawTranscript || [];
  if (transcript.length === 0 && (payload as any).transcriptPath) {
    try {
      if (fs.existsSync((payload as any).transcriptPath)) {
        const rawT = JSON.parse(fs.readFileSync((payload as any).transcriptPath, "utf-8"));
        transcript = rawT.transcript || [];
      }
    } catch {}
  }

  if (transcript.length === 0 && durationSeconds < 2) {
    return null;
  }

  let finalStatus: CallOutcomeStatus = status;
  if (whatsappAuthorized) {
    finalStatus = "AUTORIZADO";
  } else if (status === "RECHAZADO") {
    finalStatus = "RECHAZADO";
  } else if (transcript.length <= 1) {
    finalStatus = "NO_RESPONDE";
  } else if (!finalStatus || finalStatus === "EN_CURSO") {
    finalStatus = "TERMINADO";
  }

  const cfg = loadConfig();
  let assignedVariant: "cercano" | "formal" = payload.scriptVariant || "cercano";
  if (!payload.scriptVariant) {
    if (cfg.scriptVariant === "formal") {
      assignedVariant = "formal";
    } else if (cfg.scriptVariant === "ab_test") {
      const totalPast = loadCalls().length;
      assignedVariant = totalPast % 2 === 0 ? "cercano" : "formal";
    }
  }

  const resolvedPhone = confirmedPhone && confirmedPhone !== "este" ? confirmedPhone : phone;
  const record: CallRecord = {
    id: sessionId && sessionId.startsWith("call_") ? sessionId : `call_${Date.now()}`,
    timestamp: new Date().toISOString(),
    company: company,
    phone: resolvedPhone,
    channel,
    durationSeconds,
    status: finalStatus,
    currentStage,
    whatsappAuthorized,
    phoneConfirmed,
    confirmedPhone: resolvedPhone,
    whatsappSent: false,
    scriptVariant: assignedVariant,
    transcript: transcript.map((t) => ({
      role: t.role,
      text: t.text,
      timestamp: (t as any).timestamp || new Date().toISOString(),
    })),
    metrics: { ...metrics },
  };

  setImmediate(async () => {
    try {
      saveCall(record);
      console.log(`[CallRecord] Llamada guardada en historial (${record.id}) - Canal: ${channel}, Estado: ${finalStatus} (Etapa ${currentStage}, Guion: ${assignedVariant})`);

      // Registrar o actualizar Lead automáticamente en el CRM Nexus
      const db = crmStorage.getDb();
      const targetPhone = resolvedPhone;
      const normalizedPhone = normalizeSpanishPhone(targetPhone) || targetPhone;
      let lead = db.leads.find((l) => l.telefono === normalizedPhone || l.telefono === targetPhone);
      const nowIso = new Date().toISOString();

      if (!lead) {
        const token = `tok_${Math.random().toString(36).substring(2, 8)}`;
        const baseOrigin = getPublicBaseUrl(WEB_PORT);
        const urlPropuesta = `${baseOrigin}/api/crm/propuesta/${token}`;

        lead = {
          id: `lead_${Date.now()}`,
          proyecto_id: db.proyectos[0]?.id || "forja-web",
          campania_id: db.campanias[0]?.id || "campania-madrid-fontaneria",
          place_id: `call_${Date.now()}`,
          empresa_nombre: company && company !== "Cliente Netelip" ? company : (resolvedPhone ? `Contacto ${resolvedPhone}` : "Cliente Web"),
          categoria_maps: "Negocio Local",
          oficio_mapeado: "negocio local",
          telefono: normalizedPhone,
          telefono_original: targetPhone,
          ciudad: "Madrid",
          codigo_postal: "",
          direccion: "",
          tiene_web_previa: false,
          web_actual: "",
          estado: whatsappAuthorized ? "cola_whatsapp" : (finalStatus === "RECHAZADO" ? "descartado" : "llamado"),
          url_propuesta: urlPropuesta,
          token_seguimiento: token,
          veces_llamado: 1,
          veces_whatsapp: 0,
          calificacion: whatsappAuthorized ? "caliente" : "tibio",
          consentimiento_whatsapp: whatsappAuthorized,
          evidencia_consentimiento: evidenceQuote || (whatsappAuthorized ? "Autorizado en llamada" : undefined),
          telefono_confirmado: whatsappAuthorized ? resolvedPhone : undefined,
          notas: `Llamada ${channel} completada (${durationSeconds}s) - Estado: ${finalStatus}`,
          asignado_a: "",
          script_variant: assignedVariant,
          ultimo_contacto_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        };
        db.leads.unshift(lead);
      } else {
        lead.veces_llamado = (lead.veces_llamado || 0) + 1;
        lead.script_variant = assignedVariant;
        lead.ultimo_contacto_at = nowIso;
        lead.updated_at = nowIso;
        if (whatsappAuthorized) {
          lead.estado = "cola_whatsapp";
          lead.calificacion = "caliente";
          lead.consentimiento_whatsapp = true;
          lead.evidencia_consentimiento = evidenceQuote || "Autorizado en llamada";
          lead.telefono_confirmado = resolvedPhone;
        } else if (finalStatus === "RECHAZADO") {
          lead.estado = "descartado";
        }
      }
      crmStorage.save();
      console.log(`[CRM Nexus] Lead sincronizado en CRM: ${lead.empresa_nombre} (${lead.telefono}) -> Estado: ${lead.estado}`);

      // Ejecutar análisis de inteligencia de conversación (IA / Heurístico)
      const openAiKey = cfg.openaiApiKey || process.env.OPENAI_API_KEY;
      analyzeCallWithAI(transcript, durationSeconds, finalStatus, assignedVariant, openAiKey)
        .then((analysis) => {
          updateCall(record.id, { analysis });
          console.log(`[CallAnalyzer] Análisis completado (${record.id}): Sentimiento=${analysis.sentiment}, Objeción=${analysis.objectionDetected}, Score=${analysis.qualityScore}/10`);
          appEvents.broadcast({
            type: "call_analyzed",
            callId: record.id,
            analysis,
          });
          try {
            const dbRef = crmStorage.getDb();
            const target = resolvedPhone;
            const norm = normalizeSpanishPhone(target) || target;
            const leadToUpdate = dbRef.leads.find((l) => l.telefono === target || l.telefono === norm);
            if (leadToUpdate) {
              leadToUpdate.analisis_llamada = analysis;
              crmStorage.save();
            }
          } catch {}
        })
        .catch((e) => console.warn("[CallAnalyzer] Error analizando llamada:", e.message));
    } catch (saveErr: any) {
      console.error("[CallRecord Error]", saveErr.message);
    }
  });

  return record;
}

export function startWebServer(): http.Server {
  controlToken();
  const publicDir = path.resolve(process.cwd(), "public");
  const indexPath = path.join(publicDir, "index.html");

  const server = http.createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;
    const origin = req.headers.origin;

    if (pathname === "/api/control/login") { await handleControlLogin(req, res); return; }
    const publicProposal = req.method === "GET" && pathname.startsWith("/api/crm/propuesta/");
    if (pathname.startsWith("/api/") && !publicProposal && !requireControl(req, res)) return;
    if (pathname === "/api/safety") { sendJson(res, 200, runtimePolicy()); return; }
    if (pathname === "/api/control/session") { sendJson(res, 200, { success: true }); return; }
    if (pathname === "/control-auth.js" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(path.join(publicDir, "control-auth.js"), "utf8"));
      return;
    }

    // Validación estricta de origen: rechazar peticiones cruzadas no autorizadas
    if (origin && !isAllowedOrigin(origin)) {
      if (req.method === "OPTIONS" || req.method === "POST" || req.method === "PATCH" || req.method === "DELETE" || req.method === "PUT") {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Origen no autorizado en entorno local." }));
        return;
      }
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      const allowOrigin = isAllowedOrigin(origin) && origin ? origin : "http://127.0.0.1:3000";
      res.writeHead(204, {
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // Rutas del CRM Multiproducto Nexus Leads y Línea de WhatsApp
    if (pathname.startsWith("/api/crm") || pathname.startsWith("/api/whatsapp") || pathname === "/crm" || pathname === "/crm.html") {
      const handled = await handleCrmRoutes(req, res, pathname, url);
      if (handled) return;
    }

    // Rutas de API REST
    if (pathname === "/api/config") {
      if (req.method === "GET") {
        return sendJson(res, 200, getSanitizedConfig(loadConfig()));
      } else if (req.method === "POST") {
        try {
          const body = await parseJsonBody<BotConfig>(req);
          saveConfig(body);
          // Actualizar variables de entorno para la sesión en curso
          if (body.togetherApiKey) process.env.TOGETHER_API_KEY = body.togetherApiKey;
          if (body.openaiApiKey) process.env.OPENAI_API_KEY = body.openaiApiKey;
          if (body.geminiApiKey) process.env.GEMINI_API_KEY = body.geminiApiKey;
          if (body.geminiCommercialModel) process.env.GEMINI_COMMERCIAL_MODEL = body.geminiCommercialModel;
          if (body.geminiCommercialVoice) process.env.GEMINI_COMMERCIAL_VOICE = body.geminiCommercialVoice;
          if (body.geminiTechnicalModel) process.env.GEMINI_TECHNICAL_MODEL = body.geminiTechnicalModel;
          if (body.geminiTechnicalVoice) process.env.GEMINI_TECHNICAL_VOICE = body.geminiTechnicalVoice;
          if (body.conversationEngine) process.env.CONVERSATION_ENGINE = body.conversationEngine;
          if (body.systemPrompt) process.env.SYSTEM_PROMPT = body.systemPrompt;
          if (body.llmModel) process.env.LLM_MODEL = body.llmModel;
          if (body.ttsVoice) process.env.TTS_VOICE = body.ttsVoice;
          if (body.ttsSpeed !== undefined) process.env.TTS_SPEED = String(body.ttsSpeed);
          if (body.naturalPauses !== undefined) process.env.NATURAL_PAUSES = body.naturalPauses ? "true" : "false";
          if (body.ttsModel) process.env.TTS_MODEL = body.ttsModel;
          if (body.sttModel) process.env.STT_MODEL = body.sttModel;
          if (body.maxTokens) process.env.LLM_MAX_TOKENS = String(body.maxTokens);
          process.env.DISABLE_REASONING = body.disableReasoning ? "true" : "false";

          return sendJson(res, 200, { success: true, message: "Configuración guardada correctamente." });
        } catch (err: any) {
          return sendJson(res, 400, { success: false, error: err.message });
        }
      }
    }

    if (pathname === "/api/preview-voice" && (req.method === "POST" || req.method === "GET")) {
      try {
        const config = loadConfig();
        const isOpenAiMode = config.conversationEngine === "openai_realtime";

        let voice = isOpenAiMode ? (config.realtimeCommercialVoice || "marin") : (config.ttsVoice || "ef_dora");
        let speed = config.ttsSpeed || 1.0;
        let text = "Hola, buenas. Te llamo de forma rápida para prepararte una muestra gratuita de una página web para tu negocio.";

        if (req.method === "POST") {
          const body = await parseJsonBody<{ voice?: string; speed?: number; text?: string; engine?: string }>(req);
          if (body.voice) voice = body.voice;
          if (body.speed !== undefined) speed = body.speed;
          if (body.text) text = body.text;
        } else {
          const q = url.searchParams;
          if (q.get("voice")) voice = q.get("voice")!;
          if (q.get("speed")) speed = parseFloat(q.get("speed")!) || 1.0;
          if (q.get("text")) text = q.get("text")!;
        }

        const openAiVoices = ["marin", "cedar", "alloy", "echo", "fable", "onyx", "nova", "shimmer", "verse", "sage", "ballad", "coral", "ash"];
        const isOpenAiVoice = openAiVoices.includes(voice.toLowerCase());

        const geminiVoices = ["aoede", "kore", "puck", "charon", "fenrir", "leda", "orus", "zephyr"];
        const isGeminiVoice = geminiVoices.includes(voice.toLowerCase());
        const isGeminiMode = config.conversationEngine === "gemini_live";

        if (isGeminiVoice || (isGeminiMode && !isOpenAiVoice)) {
          const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
          if (!apiKey) {
            return sendJson(res, 400, { success: false, message: "GEMINI_API_KEY no configurada." });
          }
          const selectedGeminiVoice = isGeminiVoice ? voice : (config.geminiCommercialVoice || "Aoede");
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: cleanTextForTts(text, true) }] }],
                generationConfig: {
                  responseModalities: ["AUDIO"],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: selectedGeminiVoice },
                    },
                  },
                },
              }),
            }
          );

          if (!geminiRes.ok) {
            const err = await geminiRes.text();
            return sendJson(res, 400, { success: false, error: err });
          }

          const geminiData = (await geminiRes.json()) as any;
          const inlineB64 = geminiData?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (!inlineB64) {
            return sendJson(res, 400, { success: false, error: "Gemini no devolvió datos de audio." });
          }

          const rawBuf = Buffer.from(inlineB64, "base64");
          const pcmInt16 = bufferToInt16Array(rawBuf);
          const wavBuf = encodeWav(pcmInt16, 24000);

          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": wavBuf.length,
            "Cache-Control": "no-cache",
          });
          res.end(wavBuf);
          return;
        }

        if (isOpenAiMode || isOpenAiVoice) {
          const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
          if (!apiKey) {
            return sendJson(res, 400, { success: false, message: "OPENAI_API_KEY no configurada." });
          }

          // Usamos gpt-4o-mini-tts que soporta todas las voces nativas de Realtime (marin, cedar, verse, coral, sage, ash, ballad, alloy, echo, shimmer)
          const selectedVoice = openAiVoices.includes(voice.toLowerCase()) ? voice.toLowerCase() : (config.realtimeCommercialVoice || "marin");
          const openAiRes = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini-tts",
              input: cleanTextForTts(text, true),
              voice: selectedVoice,
              instructions: "Habla en español de España con tono natural, cercano y fluido de llamada telefónica comercial.",
              response_format: "wav",
            }),
          });

          if (!openAiRes.ok) {
            const err = await openAiRes.text();
            return sendJson(res, 400, { success: false, error: err });
          }

          const audioBuf = Buffer.from(await openAiRes.arrayBuffer());
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": audioBuf.length,
            "Cache-Control": "no-cache",
          });
          res.end(audioBuf);
          return;
        }

        const apiKey = config.togetherApiKey || process.env.TOGETHER_API_KEY;
        if (!apiKey) {
          return sendJson(res, 400, { success: false, message: "TOGETHER_API_KEY no configurada." });
        }

        const resolvedVoice = resolveTtsVoice(voice);
        const cleanText = cleanTextForTts(text, true);

        const ttsRes = await fetch("https://api.together.ai/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.ttsModel || "hexgrad/Kokoro-82M",
            input: cleanText,
            voice: resolvedVoice,
            speed,
            response_format: "pcm",
            sample_rate: 24000,
          }),
        });

        if (!ttsRes.ok) {
          const err = await ttsRes.text();
          return sendJson(res, 400, { success: false, error: err });
        }

        const rawBuf = Buffer.from(await ttsRes.arrayBuffer());
        const pcmInt16 = bufferToInt16Array(rawBuf);
        const wavBuf = encodeWav(pcmInt16, 24000);

        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": wavBuf.length,
          "Cache-Control": "no-cache",
        });
        res.end(wavBuf);
        return;
      } catch (err: any) {
        return sendJson(res, 500, { success: false, error: err.message });
      }
    }

    if (pathname === "/api/test-connection" && req.method === "POST") {
      try {
        const config = loadConfig();

        if (config.conversationEngine === "gemini_live") {
          const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
          if (!apiKey) {
            return sendJson(res, 400, {
              ok: false,
              message: "La clave GEMINI_API_KEY no está configurada.",
            });
          }

          const tStart = Date.now();
          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
          const latencyMs = Date.now() - tStart;

          if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            return sendJson(res, 400, {
              ok: false,
              message: `Error de API Google Gemini (${geminiRes.status}): ${errText}`,
            });
          }

          const modelsData = (await geminiRes.json().catch(() => ({}))) as any;
          const availableModels = (modelsData.models || [])
            .map((m: any) => m.name.replace(/^models\//, ""))
          // Validar además la disponibilidad del WebSocket Live bidireccional
          let liveWsOk = true;
          let liveWsError = "";
          try {
            const host = "generativelanguage.googleapis.com";
            const wsUrl = `wss://${host}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
            const testWs = new WebSocket(wsUrl);
            await new Promise<void>((resolveWs, rejectWs) => {
              const tm = setTimeout(() => {
                try {
                  testWs.terminate();
                } catch {}
                rejectWs(new Error("Timeout (4s) conectando a WebSocket Live"));
              }, 4000);
              testWs.on("open", () => {
                clearTimeout(tm);
                try {
                  testWs.close();
                } catch {}
                resolveWs();
              });
              testWs.on("error", (errWs: any) => {
                clearTimeout(tm);
                rejectWs(errWs);
              });
            });
          } catch (eWs: any) {
            liveWsOk = false;
            liveWsError = eWs.message || String(eWs);
          }

          if (!liveWsOk) {
            return sendJson(res, 400, {
              ok: false,
              message: `REST API OK pero falló la conexión WebSocket Live de Gemini: ${liveWsError}`,
              latencyMs,
            });
          }

          return sendJson(res, 200, {
            ok: true,
            engine: "gemini_live",
            message: `Conexión REST y WebSocket Live verificadas con éxito con Google Gemini.`,
            latencyMs,
            commercialModel: config.geminiCommercialModel || "gemini-2.0-flash-live-001",
            technicalModel: config.geminiTechnicalModel || "gemini-2.0-flash-live-001",
            commercialVoice: config.geminiCommercialVoice || "Aoede",
            technicalVoice: config.geminiTechnicalVoice || "Charon",
            availableModels,
          });
        }

        if (config.conversationEngine === "openai_realtime") {
          const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
          if (!apiKey) {
            return sendJson(res, 400, {
              ok: false,
              message: "La clave OPENAI_API_KEY no está configurada.",
            });
          }

          const tStart = Date.now();
          const openAiRes = await fetch("https://api.openai.com/v1/models", {
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
          });
          const latencyMs = Date.now() - tStart;

          if (!openAiRes.ok) {
            const errText = await openAiRes.text();
            return sendJson(res, 400, {
              ok: false,
              message: `Error de API OpenAI (${openAiRes.status}): ${errText}`,
            });
          }

          return sendJson(res, 200, {
            ok: true,
            engine: "openai_realtime",
            message: `Conexión verificada con éxito con OpenAI Realtime.`,
            latencyMs,
            commercialModel: config.realtimeCommercialModel || "gpt-realtime-2.1-mini",
            technicalModel: config.realtimeTechnicalModel || "gpt-realtime-2.1",
            commercialVoice: config.realtimeCommercialVoice || "marin",
            technicalVoice: config.realtimeTechnicalVoice || "cedar",
          });
        }

        // Modo Together AI
        const apiKey = config.togetherApiKey || process.env.TOGETHER_API_KEY;
        if (!apiKey || apiKey === "tu_api_key_aqui") {
          return sendJson(res, 400, {
            ok: false,
            message: "La clave TOGETHER_API_KEY no está configurada.",
          });
        }

        const tStart = Date.now();
        const llmRes = await fetch("https://api.together.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.llmModel || "Qwen/Qwen3.5-9B",
            messages: [{ role: "user", content: "Test ping" }],
            max_tokens: 3,
            stream: false,
          }),
        });

        const llmDuration = Date.now() - tStart;

        if (!llmRes.ok) {
          const errText = await llmRes.text();
          return sendJson(res, 400, {
            ok: false,
            message: `Error de API Together AI (${llmRes.status}): ${errText}`,
          });
        }

        return sendJson(res, 200, {
          ok: true,
          engine: "together_pipeline",
          message: `Conexión verificada con éxito con Together AI.`,
          llmLatencyMs: llmDuration,
          model: config.llmModel,
          voice: config.ttsVoice,
        });
      } catch (err: any) {
        return sendJson(res, 500, {
          ok: false,
          message: `Fallo de red o conexión: ${err.message}`,
        });
      }
    }

    if (pathname === "/api/calls") {
      if (req.method === "GET") {
        return sendJson(res, 200, loadCalls());
      } else if (req.method === "POST") {
        try {
          const body = await parseJsonBody<CallRecord>(req);
          saveCall(body);
          return sendJson(res, 200, { success: true });
        } catch (e: any) {
          return sendJson(res, 400, { success: false, error: e.message });
        }
      }
    }

    if (pathname.startsWith("/api/calls/") && req.method === "PATCH") {
      const id = pathname.replace("/api/calls/", "");
      try {
        const body = await parseJsonBody<Partial<CallRecord>>(req);
        const updated = updateCall(id, body);
        if (updated) {
          return sendJson(res, 200, { success: true, call: updated });
        } else {
          return sendJson(res, 404, { success: false, error: "Llamada no encontrada" });
        }
      } catch (e: any) {
        return sendJson(res, 400, { success: false, error: e.message });
      }
    }

    if (pathname === "/api/leads" && req.method === "GET") {
      const calls = loadCalls();
      const leads = calls.filter((c) => c.whatsappAuthorized);
      return sendJson(res, 200, leads);
    }

    if (pathname === "/api/bridge/status" && req.method === "GET") {
      return sendJson(res, 200, getBridgeStatus());
    }

    if (pathname === "/api/bridge/start" && req.method === "POST") {
      const result = startBridge();
      return sendJson(res, result.success ? 200 : 400, result);
    }

    if (pathname === "/api/bridge/stop" && req.method === "POST") {
      const result = stopBridge();
      return sendJson(res, result.success ? 200 : 400, result);
    }

    if (pathname === "/api/netelip/dial" && req.method === "POST") {
      const body = await parseJsonBody<{ phone: string; company?: string }>(req);
      if (!body.phone) {
        return sendJson(res, 400, { success: false, message: "Teléfono requerido" });
      }
      const result = await dialNetelip(body.phone, body.company || "Cliente");
      return sendJson(res, result.success ? 200 : 400, result);
    }

    if (pathname === "/api/netelip/hangup" && req.method === "POST") {
      const result = await hangupNetelip();
      return sendJson(res, result.success ? 200 : 400, result);
    }

    if (pathname === "/api/netelip/transfer" && req.method === "POST") {
      const body = await parseJsonBody<{ phone?: string }>(req);
      const result = await transferNetelip(body.phone);
      return sendJson(res, result.success ? 200 : 400, result);
    }

    // Servir página principal sin caché
    if (pathname === "/" || pathname === "/index.html") {
      fs.readFile(indexPath, "utf-8", (err, content) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error cargando index.html");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        });
        res.end(content);
      });
      return;
    }

    if (pathname === "/api/test-audio.wav" && (req.method === "GET" || req.method === "HEAD")) {
      const wavPath = path.resolve(process.cwd(), "fixtures/test-16k.wav");
      if (fs.existsSync(wavPath)) {
        const stat = fs.statSync(wavPath);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": stat.size,
          "Cache-Control": "no-cache",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(wavPath).pipe(res);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No encontrado");
    })().catch(() => {
      if (!res.headersSent) res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No se pudo completar la operación. Revisa el estado antes de reintentar." }));
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws-client" });

  wss.on("connection", (clientWs: WebSocket, req: http.IncomingMessage) => {
    if (!isControlAuthorized(req)) { clientWs.close(1008, "Autenticación requerida"); return; }
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      console.warn(`[Web UI] Conexión WebSocket rechazada por origen no autorizado: ${origin}`);
      clientWs.close(1008, "Origen no permitido");
      return;
    }

    // Generar identificador de sesión único para esta pestaña
    const sessionId = `browser_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    console.log(`[Web UI] Navegador conectado (Session: ${sessionId})`);

    clientWs.send(JSON.stringify({ type: "session_id", sessionId }));

    let tcpSocket: net.Socket | null = null;
    const framer = new PacketFramer();

    // Seguimiento del historial y estado de la llamada de esta sesión
    let callStartTime = 0;
    let callMetadata = { company: "Cliente Web", phone: "Navegador Web" };
    let callTranscript: Array<{ role: "user" | "assistant"; text: string; timestamp: string }> = [];
    let isWhatsappAuthorized = false;
    let phoneConfirmed = false;
    let confirmedPhone: string | undefined = undefined;
    let evidenceQuote: string | undefined = undefined;
    let currentStage = 1;
    let outcomeStatus: CallOutcomeStatus = "EN_CURSO";
    let lastMetrics: { ttft?: number; ttfa?: number; stt?: number; turns?: number } = {};

    const eventHandler = (event: UiEvent) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;

      // Filtrar por sesión: solo enviar eventos dirigidos a esta sesión o globales
      if (event.sessionId && event.sessionId !== sessionId && event.sessionId !== "global") {
        return;
      }

      if (event.type === "transcript") {
        // Para el historial persistido, omitir deltas parciales (isPartial) y registrar solo intervenciones completas
        if (!event.isPartial) {
          callTranscript.push({
            role: event.role,
            text: event.text,
            timestamp: new Date().toLocaleTimeString(),
          });
        }
      } else if (event.type === "stage_update") {
        const ctx = (event as any).context || (event as any).sessionContext;
        if (ctx) {
          currentStage = ctx.currentStage;
          outcomeStatus = ctx.outcomeStatus;
          isWhatsappAuthorized = ctx.whatsappAuthorized;
          phoneConfirmed = ctx.phoneConfirmed;
          if (ctx.confirmedPhone) {
            confirmedPhone = ctx.confirmedPhone;
          }
          if (ctx.evidenceQuote) {
            evidenceQuote = ctx.evidenceQuote;
          }
        }
      } else if (event.type === "whatsapp_authorized") {
        isWhatsappAuthorized = true;
        if ((event as any).phone) confirmedPhone = (event as any).phone;
        if ((event as any).evidenceQuote) evidenceQuote = (event as any).evidenceQuote;
      } else if (event.type === "call_end") {
        // Extraer resultado final fidedigno del resumen del motor
        if (event.outcome && event.outcome !== "DESCONOCIDO") {
          outcomeStatus = event.outcome;
        }
        if (event.sessionSummary) {
          const sum = event.sessionSummary;
          if (sum.outcomeStatus && sum.outcomeStatus !== "DESCONOCIDO") {
            outcomeStatus = sum.outcomeStatus;
          }
          if (sum.whatsappAuthorized !== undefined) {
            isWhatsappAuthorized = Boolean(sum.whatsappAuthorized);
          }
          if (sum.phoneConfirmed !== undefined) {
            phoneConfirmed = Boolean(sum.phoneConfirmed);
          }
          if (sum.confirmedPhone) {
            confirmedPhone = sum.confirmedPhone;
          }
          if (sum.evidenceQuote) {
            evidenceQuote = sum.evidenceQuote;
          }
        }
        if (event.whatsappAuthorized !== undefined) {
          isWhatsappAuthorized = Boolean(event.whatsappAuthorized);
        }
        if (event.confirmedPhone) {
          confirmedPhone = event.confirmedPhone;
        }
        if (event.evidenceQuote) {
          evidenceQuote = event.evidenceQuote;
        }

        finalizeAndSaveCall();
        if (tcpSocket && !tcpSocket.destroyed) {
          tcpSocket.end();
          tcpSocket = null;
        }
      } else if (event.type === "metrics") {
        lastMetrics = { ...lastMetrics, ...event };
      }

      clientWs.send(JSON.stringify(event));
    };

    appEvents.on("ui-event", eventHandler);

    const finalizeAndSaveCall = () => {
      if (callStartTime > 0 && callTranscript.length > 0) {
        const durationSeconds = Math.max(1, Math.round((Date.now() - callStartTime) / 1000));
        recordCompletedCall({
          sessionId: `call_${Date.now()}`,
          channel: "browser",
          company: callMetadata.company,
          phone: callMetadata.phone,
          durationSeconds,
          status: outcomeStatus,
          currentStage,
          whatsappAuthorized: isWhatsappAuthorized,
          phoneConfirmed,
          confirmedPhone,
          evidenceQuote,
          transcript: [...callTranscript],
          metrics: { ...lastMetrics },
        });
        callStartTime = 0;
      }
    };

    clientWs.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        // Audio del micrófono del cliente en PCM 16kHz
        if (tcpSocket && !tcpSocket.destroyed) {
          const buf = Buffer.from(raw as ArrayBuffer);
          tcpSocket.write(encodePacket(PACKET_AUDIO, 0, buf));
        }
        return;
      }

      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "call_start") {
          console.log(`[Web UI] Iniciando llamada para sesión ${sessionId}...`);
          callStartTime = Date.now();
          callTranscript = [];
          isWhatsappAuthorized = false;
          phoneConfirmed = false;
          confirmedPhone = undefined;
          currentStage = 1;
          outcomeStatus = "EN_CURSO";
          lastMetrics = {};
          if (msg.company) callMetadata.company = msg.company;
          if (msg.phone) callMetadata.phone = msg.phone;

          const callStartPayload = JSON.stringify({
            sessionId,
            company: callMetadata.company,
            phone: callMetadata.phone,
          });

          if (!tcpSocket || tcpSocket.destroyed) {
            tcpSocket = net.createConnection({ port: TCP_PORT, host: TCP_HOST }, () => {
              console.log(`[Web UI] Conexión TCP establecida para sesión ${sessionId}.`);
              tcpSocket?.write(encodePacket(PACKET_CALL_START, 0, Buffer.from(callStartPayload, "utf-8")));
            });

            tcpSocket.on("data", (chunk: Buffer) => {
              const packets = framer.push(chunk);
              for (const pkt of packets) {
                if (pkt.type === PACKET_AUDIO) {
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(pkt.payload);
                  }
                } else if (pkt.type === PACKET_FLUSH) {
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: "flush", turnId: pkt.turnId }));
                  }
                } else if (pkt.type === PACKET_TURN_END) {
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: "turn_end", turnId: pkt.turnId }));
                  }
                } else if (pkt.type === PACKET_CALL_END) {
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: "call_end", turnId: pkt.turnId }));
                  }
                  finalizeAndSaveCall();
                  if (tcpSocket && !tcpSocket.destroyed) {
                    tcpSocket.end();
                    tcpSocket = null;
                  }
                }
              }
            });

            tcpSocket.on("error", (err) => {
              console.error(`[Web UI Session ${sessionId}] Error socket TCP:`, err.message);
            });

            tcpSocket.on("close", () => {
              finalizeAndSaveCall();
            });
          } else {
            tcpSocket.write(encodePacket(PACKET_CALL_START, 0, Buffer.from(callStartPayload, "utf-8")));
          }
        } else if (msg.type === "playback_drained") {
          if (tcpSocket && !tcpSocket.destroyed) {
            tcpSocket.write(encodePacket(PACKET_PLAYBACK_DRAINED, msg.turnId || 0));
          }
        } else if (msg.type === "call_end") {
          console.log(`[Web UI] Colgado desde el navegador (Session: ${sessionId}).`);
          if (tcpSocket && !tcpSocket.destroyed) {
            tcpSocket.write(encodePacket(PACKET_CALL_END));
            tcpSocket.end();
            tcpSocket = null;
          }
          finalizeAndSaveCall();
        }
      } catch (err) {
        console.error("[Web UI] Error procesando mensaje WS:", err);
      }
    });

    clientWs.on("close", () => {
      console.log(`[Web UI] Navegador desconectado (Session: ${sessionId}).`);
      appEvents.off("ui-event", eventHandler);
      finalizeAndSaveCall();
      if (tcpSocket && !tcpSocket.destroyed) {
        try {
          tcpSocket.write(encodePacket(PACKET_CALL_END));
          tcpSocket.end();
        } catch {}
      }
    });
  });

  server.on("error", (err: any) => {
    console.error(`[Web Server Error]: ${err.message}`);
  });

  server.listen(WEB_PORT, process.env.WEB_HOST || "127.0.0.1", () => {
    const localIp = getLocalIpAddress();
    console.log(`=======================================================`);
    console.log(`  🌐 Panel de Control Web: http://127.0.0.1:${WEB_PORT}`);
    console.log(`  📱 Acceso Móvil / Red:   http://${localIp}:${WEB_PORT}`);
    console.log(`=======================================================`);
  });

  return server;
}
