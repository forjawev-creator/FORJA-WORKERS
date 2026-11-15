import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  StagesConfig,
  CallOutcomeStatus,
  ConversationEngineType,
  RealtimeTurnDetection,
  RealtimeEagerness,
  ScriptVariant,
} from "./types.js";
import { CallAnalysis } from "./crm/call-analyzer.js";
export type { StagesConfig, CallOutcomeStatus, ScriptVariant, CallAnalysis };

export interface BotConfig {
  togetherApiKey: string;
  systemPrompt: string;
  installPrice: string;
  monthlyPriceBasic: string;
  monthlyPriceFull: string;
  llmModel: string;
  ttsVoice: string;
  ttsSpeed?: number;
  naturalPauses?: boolean;
  ttsModel: string;
  sttModel: string;
  maxTokens: number;
  disableReasoning: boolean;
  stages?: StagesConfig;

  // Modos y configuración OpenAI Realtime & Gemini Live
  conversationEngine?: ConversationEngineType;
  openaiApiKey?: string;
  geminiApiKey?: string;
  geminiCommercialModel?: string;
  geminiTechnicalModel?: string;
  geminiCommercialVoice?: string;
  geminiTechnicalVoice?: string;
  realtimeCommercialModel?: string;
  realtimeTechnicalModel?: string;
  realtimeCommercialVoice?: string;
  realtimeTechnicalVoice?: string;
  realtimeTurnDetection?: RealtimeTurnDetection;
  realtimeEagerness?: RealtimeEagerness;
  realtimeMaxOutputTokens?: number;
  handoffEnabled?: boolean;
  handoffMaxCount?: number;
  handoffTimeoutMs?: number;
  handoffMaxBufferedAudioMs?: number;
  callMaxDurationSeconds?: number;
  technicalMaxDurationSeconds?: number;
  callCostAlertUsd?: number;
  callCostSoftLimitUsd?: number;
  callCostHardLimitUsd?: number;
  inputTranscriptionEnabled?: boolean;
  rateCardVersion?: string;
  scriptVariant?: ScriptVariant;
  publicBaseUrl?: string;

  // Telefonía SIP / Netelip y Transferencia a Humano
  sipProvider?: "netelip" | "twilio";
  sipServer?: string;
  sipUser?: string;
  sipPassword?: string;
  sipCallerId?: string;
  humanTransferPhone?: string;
  humanTransferName?: string;
  notifyTransferViaWhatsApp?: boolean;
}


/**
 * Mapeo de nombres amigables en español (interfaz Kokoro AI / web)
 * a los identificadores nativos del modelo Kokoro-82M de Together AI.
 */
export const VOICE_ALIASES: Record<string, string> = {
  // Voces en Español (Web Kokoro AI)
  carlos: "em_alex",      // Carlos (Masculina - Claro y seguro)
  carmen: "ef_dora",      // Carmen (Femenina - Expresiva y profesional)
  diego: "em_santa",     // Diego (Masculina - Tono cálido)
  isabel: "bf_isabella",  // Isabel (Femenina - Dulce y pausada)
  isabella: "bf_isabella",// Isabella (Femenina - Refinada y clara)
  javier: "bm_george",    // Javier (Masculina - Varonil y formal)
  jose: "bm_daniel",      // José (Masculina - Convincente y sobrio)
  lucia: "af_bella",      // Lucía (Femenina - Juvenil y dinámica)
  lucía: "af_bella",
  maria: "if_sara",       // María (Femenina - Cálida y cercana)
  maría: "if_sara",
  mateo: "am_michael",    // Mateo (Masculina - Ejecutivo y natural)
  miguel: "am_liam",      // Miguel (Masculina - Energético y comercial)
  santiago: "am_adam",    // Santiago (Masculina - Dinámico)
  sofia: "af_sarah",      // Sofía (Femenina - Amigable y cordial)
  sofía: "af_sarah",
};

/**
 * Resuelve cualquier alias o nombre de voz a un ID nativo válido de Kokoro-82M
 */
export function resolveTtsVoice(voice?: string): string {
  if (!voice) return "em_alex";
  const normalized = voice.trim().toLowerCase();
  return VOICE_ALIASES[normalized] || voice.trim();
}

/**
 * Normaliza y pule el texto para síntesis de voz natural en español:
 * - Convierte símbolos monetarios y porcentajes a palabras habladas
 * - Limpia formato markdown y emojis que causan artefactos o ruidos
 * - Preserva comas y signos de puntuación clave para la entonación y respiración de Kokoro
 */
export function cleanTextForTts(text: string, naturalPauses = true): string {
  if (!text) return "";
  let clean = text
    // Eliminar formato markdown
    .replace(/[*_#`~>]/g, "")
    // Convertir símbolos monetarios y porcentajes a palabras en español
    .replace(/(\d+)\s*€/g, "$1 euros")
    .replace(/€\s*(\d+)/g, "$1 euros")
    .replace(/(\d+)\s*\$/g, "$1 dólares")
    .replace(/(\d+)\s*%/g, "$1 por ciento")
    // Emojis fuera para evitar artefactos en la voz
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "")
    // Normalizar signos de exclamación e interrogación repetidos
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/\.{3,}/g, "...")
    .replace(/\s+/g, " ")
    .trim();

  // Si las pausas naturales están activadas, asegurar que haya una coma en conectores habituales si no la hay
  if (naturalPauses) {
    clean = clean
      .replace(/\s+(pero|porque|aunque|por lo tanto|además)\s+/gi, ", $1 ")
      .replace(/,\s*,/g, ",");
  }

  return clean;
}

export interface CallRecord {
  id: string;
  timestamp: string;
  company: string;
  phone: string;
  channel: "browser" | "netelip" | "telephony";
  durationSeconds: number;
  status: CallOutcomeStatus;
  currentStage?: number;
  whatsappAuthorized: boolean;
  phoneConfirmed?: boolean;
  confirmedPhone?: string;
  whatsappSent: boolean;
  scriptVariant?: "cercano" | "formal";
  analysis?: CallAnalysis;
  transcript: Array<{ role: "user" | "assistant"; text: string; timestamp?: string }>;
  metrics: {
    ttft?: number;
    ttfa?: number;
    stt?: number;
    turns?: number;
  };
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const CALLS_FILE = path.join(DATA_DIR, "calls.json");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getDefaultStagesConfig(): StagesConfig {
  return {
    stage1: {
      id: 1,
      name: "Presentación",
      goal: "Presentarse y comprobar que habla con el negocio adecuado o la persona indicada.",
      guidePhrase: "Hola, buenas. ¿Hablo con el responsable del negocio?",
      advanceCondition: "Confirma que es el negocio o la persona indicada.",
    },
    stage2: {
      id: 2,
      name: "Propuesta",
      goal: "Ofrecer preparar una muestra previa gratuita de su página web, sin ningún compromiso.",
      guidePhrase: "Te llamo porque nos gustaría prepararte una muestra previa gratuita de una web para tu negocio, sin ningún compromiso. ¿Te parecería bien que te la preparemos para que la valores?",
      advanceCondition: "Muestra interés o pregunta cómo funciona.",
    },
    stage3: {
      id: 3,
      name: "Aclaraciones",
      goal: "Resolver dudas sobre la muestra, funcionalidades y precios (instalación 99 € y 5 o 10 €/mes).",
      guidePhrase: "La muestra es totalmente gratis para que la valores. Si luego decides contratarla, la instalación son 99 euros y 5 o 10 al mes según el plan, pero primero te la preparamos sin coste.",
      advanceCondition: "Está suficientemente informado para decidir.",
    },
    stage4: {
      id: 4,
      name: "Autorización y Contacto",
      goal: "Pedir permiso explícito para enviarla por WhatsApp y confirmar el número de destino.",
      guidePhrase: "¿Nos autorizas a preparártela y enviártela por WhatsApp?",
      advanceCondition: "Autoriza el envío expresamente y el número de teléfono queda confirmado.",
    },
    stage5: {
      id: 5,
      name: "Despedida",
      goal: "Confirmar lo acordado cordialmente y terminar brevemente.",
      guidePhrase: "Perfecto, te la preparo y te la envío a este mismo WhatsApp. ¡Muchas gracias y que tengas buen día!",
      advanceCondition: "Finaliza la llamada.",
    },
    objections: {
      price: "La preparación y entrega de la muestra es 100% gratuita y sin compromiso. Si más adelante te gusta y quieres contratar la web definitiva, son 99 euros de instalación y 5 o 10 euros al mes según el plan.",
      alreadyHasWeb: "Nos parece genial que ya tengas web. Por eso te preparamos una comparativa moderna y optimizada para captar clientes en móvil, sin ningún coste ni compromiso.",
      noTime: "Entiendo perfectamente que vas con el tiempo justo, por eso precisamente te la preparamos nosotros y te la enviamos por WhatsApp para que la mires en 1 minuto cuando estés libre.",
      callLater: "Sin ningún problema, te llamamos en otro momento con más calma. Muchas gracias y buen día.",
      wrongPerson: "Disculpa las molestias, me habré equivocado de número. Un saludo y que tengas buen día.",
      refusal: "Entendido perfectamente, no te preocupes. Muchas gracias por tu tiempo y que tengas buen día.",
    },
  };
}

export function maskApiKey(key?: string): string {
  if (!key) return "";
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "********";
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

export function getDefaultConfig(): BotConfig {
  return {
    togetherApiKey: process.env.TOGETHER_API_KEY || "",
    systemPrompt:
      process.env.SYSTEM_PROMPT ||
      "Eres Juan, asesor comercial de diseño y desarrollo web para negocios locales. Tu objetivo es ofrecer amablemente la preparación de una muestra previa gratuita de una página web para su negocio y conseguir su autorización explícita para enviársela por WhatsApp al número al que estamos llamando o a otro que nos facilite. Instrucciones estrictas: 1. Responde SIEMPRE en un máximo de 1 o 2 oraciones breves y conversacionales (menos de 25 palabras). Nunca uses listas ni viñetas. 2. Oferta: Ofrecemos prepararte una muestra gratuita sin ningún compromiso. 3. Precios: Si preguntan precio directamente, di que la instalación son 99 euros y luego 5 o 10 euros al mes según el plan, pero que primero le preparamos la muestra gratuita para que la valore. 4. Si dicen que no tienen tiempo, di que por eso se la mandas por WhatsApp y la mira en 1 minuto cuando pueda. 5. Si ya tienen web, ofrece enviar una comparativa moderna para captar más clientes en móvil. 6. Respeta SIEMPRE la etapa actual indicada en [CONTROL DEL PROGRAMA / ETAPA]: nunca te despidas ni des por cerrada la llamada hasta alcanzar la ETAPA 5 (una vez confirmados el permiso de WhatsApp y el número de teléfono).",
    installPrice: "99",
    monthlyPriceBasic: "5",
    monthlyPriceFull: "10",
    llmModel: process.env.LLM_MODEL || "Qwen/Qwen3.5-9B",
    ttsVoice: process.env.TTS_VOICE || "ef_dora",
    ttsSpeed: parseFloat(process.env.TTS_SPEED || "1.0"),
    naturalPauses: process.env.NATURAL_PAUSES !== "false",
    ttsModel: process.env.TTS_MODEL || "hexgrad/Kokoro-82M",
    sttModel: process.env.STT_MODEL || "openai/whisper-large-v3",
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS || "90", 10),
    disableReasoning: process.env.DISABLE_REASONING !== "false",
    stages: getDefaultStagesConfig(),

    // OpenAI Realtime & Gemini Live por defecto
    conversationEngine: (process.env.CONVERSATION_ENGINE as any) || "openai_realtime",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiCommercialModel: process.env.GEMINI_COMMERCIAL_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025",
    geminiCommercialVoice: process.env.GEMINI_COMMERCIAL_VOICE || "Aoede",
    geminiTechnicalModel: process.env.GEMINI_TECHNICAL_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025",
    geminiTechnicalVoice: process.env.GEMINI_TECHNICAL_VOICE || "Charon",
    realtimeCommercialModel: process.env.REALTIME_COMMERCIAL_MODEL || "gpt-realtime-2.1-mini",
    realtimeTechnicalModel: process.env.REALTIME_TECHNICAL_MODEL || "gpt-realtime-2.1",
    realtimeCommercialVoice: process.env.REALTIME_COMMERCIAL_VOICE || "marin",
    realtimeTechnicalVoice: process.env.REALTIME_TECHNICAL_VOICE || "cedar",
    realtimeTurnDetection: (process.env.REALTIME_TURN_DETECTION as any) || "semantic_vad",
    realtimeEagerness: (process.env.REALTIME_EAGERNESS as any) || "medium",
    realtimeMaxOutputTokens: parseInt(process.env.REALTIME_MAX_OUTPUT_TOKENS || "512", 10),
    handoffEnabled: process.env.HANDOFF_ENABLED !== "false",
    handoffMaxCount: parseInt(process.env.HANDOFF_MAX_COUNT || "1", 10),
    handoffTimeoutMs: parseInt(process.env.HANDOFF_TIMEOUT_MS || "8000", 10),
    handoffMaxBufferedAudioMs: parseInt(process.env.HANDOFF_MAX_BUFFERED_AUDIO_MS || "10000", 10),
    callMaxDurationSeconds: parseInt(process.env.CALL_MAX_DURATION_SECONDS || "180", 10),
    technicalMaxDurationSeconds: parseInt(process.env.TECHNICAL_MAX_DURATION_SECONDS || "90", 10),
    callCostAlertUsd: parseFloat(process.env.CALL_COST_ALERT_USD || "0.10"),
    callCostSoftLimitUsd: parseFloat(process.env.CALL_COST_SOFT_LIMIT_USD || "0.20"),
    callCostHardLimitUsd: parseFloat(process.env.CALL_COST_HARD_LIMIT_USD || "0.30"),
    inputTranscriptionEnabled: process.env.INPUT_TRANSCRIPTION_ENABLED === "true",
    rateCardVersion: process.env.RATE_CARD_VERSION || "2026-10-15",
    scriptVariant: (process.env.SCRIPT_VARIANT as any) || "cercano",
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  };
}

export class StorageCorruptedError extends Error {
  constructor(public readonly filePath: string, public readonly originalError: any) {
    super(`[StorageCorruptedError] Archivo corrupto o inválido: ${filePath}. Se ha preservado para evitar pérdida de datos.`);
    this.name = "StorageCorruptedError";
  }
}

// Mutex simple en memoria para evitar colisiones entre escrituras simultáneas sobre el mismo archivo JSON
const fileWriteLocks = new Set<string>();

/**
 * Validador de esquema básico para configuración
 */
export function isValidBotConfig(data: any): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  // Debe contener al menos algunos campos característicos de BotConfig
  return typeof data.conversationEngine === "string" ||
    typeof data.persona === "string" ||
    typeof data.sttModel === "string" ||
    typeof data.llmModel === "string" ||
    typeof data.stages === "object";
}

/**
 * Validador de esquema para el historial de llamadas
 */
export function isValidCallsHistory(data: any): boolean {
  if (!Array.isArray(data)) return false;
  return data.every((item) => item && typeof item === "object" && typeof item.id === "string");
}

function acquireCrossProcessLock(filePath: string, maxWaitMs = 3000): () => void {
  const lockFile = `${filePath}.lock`;
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try { fs.writeSync(fd, `${process.pid}\n${Date.now()}`); } finally { fs.closeSync(fd); }
      return () => { fs.unlinkSync(lockFile); };
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      // A slow but live writer must never lose its lock to another process.
      try {
        const pid = Number(fs.readFileSync(lockFile, "utf8").split("\n")[0]);
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (e: any) { if (e.code === "ESRCH") fs.unlinkSync(lockFile); }
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error("Almacenamiento ocupado: no se adquirió el bloqueo de escritura.");
}

export function acquireAppInstanceLock(): boolean {
  const lockFile = path.join(DATA_DIR, "app.lock");
  ensureDataDir();

  if (fs.existsSync(lockFile)) {
    try {
      const content = fs.readFileSync(lockFile, "utf-8").trim();
      const [pidStr] = content.split("\n");
      const pid = parseInt(pidStr, 10);
      if (pid && !isNaN(pid)) {
        try {
          // Comprobar si el proceso existe y está activo
          process.kill(pid, 0);

          if (process.platform === "win32") {
            const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { windowsHide: true, encoding: "utf-8" });
            if (!out.toLowerCase().includes("node.exe")) {
              throw new Error("El PID encontrado no pertenece a Node.js (PID reciclado por el sistema)");
            }
          }

          console.error(`[App Error] Otra instancia de la aplicación ya está en ejecución (PID ${pid}). Abortando arranque concurrente.`);
          return false;
        } catch {
          // Proceso huérfano terminado o PID reciclado
          try { fs.unlinkSync(lockFile); } catch {}
        }
      }
    } catch {}
  }

  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
    fs.closeSync(fd);

    const cleanup = () => {
      try {
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      } catch {}
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    return true;
  } catch {
    console.error(`[App Error] No se pudo adquirir el cerrojo de aplicación única en ${lockFile}.`);
    return false;
  }
}

/**
 * Escribe un archivo JSON de forma atómica:
 * 1. Serializa la escritura mediante cerrojos intra-proceso y entre procesos (.lock).
 * 2. Crea una copia de respaldo (.bak) del archivo previo si es válido.
 * 3. Escribe en un archivo temporal (.tmp.<timestamp>).
 * 4. Renombra atómicamente el temporal al destino definitivo.
 */
export function atomicWriteJson(filePath: string, data: any): void {
  atomicUpdateJson(filePath, () => data);
}

/** Read, decide and write under one cross-process lock; never writes after lock timeout. */
export function atomicUpdateJson<T>(filePath: string, update: (current: T | null) => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fileWriteLocks.has(filePath)) throw new Error("Escritura reentrante no permitida");
  const release = acquireCrossProcessLock(filePath);
  fileWriteLocks.add(filePath);
  try {
    const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) as T : null;
    const previous = current === null ? null : JSON.stringify(current);
    const next = update(current);
    if (previous !== null) fs.writeFileSync(`${filePath}.bak`, previous, "utf8");
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
      // Windows readers/antivirus can briefly hold the destination open.
      // Keep the old file and the writer lock while retrying the atomic replacement.
      const deadline = Date.now() + 1500;
      for (;;) {
        try { fs.renameSync(tempPath, filePath); break; }
        catch (error: any) {
          if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    } finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
    return next;
  } finally { fileWriteLocks.delete(filePath); release(); }
}

/**
 * Lee un archivo JSON de forma segura:
 * - Si está vacío (0 bytes) o sólo contiene espacios en blanco, se trata como CORRUPCIÓN.
 * - Si está corrupto, lo aísla en .corrupt.<timestamp> y jamás lo destruye.
 * - Intenta recuperar automáticamente de .bak si existe y es válido.
 * - Si no hay .bak o también está dañado, lanza StorageCorruptedError sin sobrescribir con vacíos.
 */
export function safeReadJson<T>(
  filePath: string,
  validator?: (data: any) => boolean
): { data: T | null; recoveredFromBackup: boolean } {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    return { data: null, recoveredFromBackup: false };
  }

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf-8");
    // Un archivo de 0 bytes o solo espacios en blanco es CORRUPCIÓN, no un archivo inexistente
    if (!raw.trim()) {
      throw new Error(`Archivo JSON existente está vacío (0 bytes o whitespace). Se considera corrupción.`);
    }
    const parsed = JSON.parse(raw);
    if (validator && !validator(parsed)) {
      throw new Error("Validación de estructura de esquema falló para el archivo JSON.");
    }
    return { data: parsed as T, recoveredFromBackup: false };
  } catch (err: any) {
    console.error(`[Storage Alerta] Detección de archivo corrupto en ${filePath}: ${err.message}`);

    // Preservar copia del archivo corrupto para análisis forense y evitar pérdida irreversible
    const corruptBackupPath = `${filePath}.corrupt.${Date.now()}`;
    try {
      if (raw !== undefined) {
        fs.writeFileSync(corruptBackupPath, raw, "utf-8");
      } else if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, corruptBackupPath);
      }
      console.warn(`[Storage Preservación] Archivo dañado preservado como: ${corruptBackupPath}`);
    } catch (e: any) {
      console.error(`[Storage Error] No se pudo crear copia corrupta: ${e.message}`);
    }

    // Intentar recuperación desde .bak
    const bakPath = `${filePath}.bak`;
    if (fs.existsSync(bakPath)) {
      try {
        const bakRaw = fs.readFileSync(bakPath, "utf-8");
        if (bakRaw && bakRaw.trim().length > 0) {
          const bakParsed = JSON.parse(bakRaw);
          if (!validator || validator(bakParsed)) {
            console.warn(`[Storage Recuperación] Datos recuperados exitosamente desde copia de seguridad .bak (${bakPath}).`);
            return { data: bakParsed as T, recoveredFromBackup: true };
          }
        }
      } catch (bakErr: any) {
        console.error(`[Storage Error] Copia de seguridad .bak también está dañada: ${bakErr.message}`);
      }
    }

    throw new StorageCorruptedError(filePath, err);
  }
}

export function loadConfig(): BotConfig {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig = getDefaultConfig();
    saveConfig(defaultConfig);
    return defaultConfig;
  }

  try {
    const { data } = safeReadJson<BotConfig>(CONFIG_FILE, (c) => typeof c === "object" && c !== null);
    if (!data) {
      const defaultConfig = getDefaultConfig();
      saveConfig(defaultConfig);
      return defaultConfig;
    }
    const defaults = getDefaultConfig();
    return {
      ...defaults,
      ...data,
      conversationEngine: data.conversationEngine || defaults.conversationEngine || "together_pipeline",
      stages: data.stages ? { ...defaults.stages, ...data.stages } : defaults.stages,
    };
  } catch (err) {
    if (err instanceof StorageCorruptedError) {
      console.error(`[Storage CRÍTICO] config.json está dañado. NO se sobrescribirá. Corrija o restaure desde .corrupt o .bak.`);
      throw err;
    }
    return getDefaultConfig();
  }
}

export function getSanitizedConfig(config: BotConfig): any {
  const sanitized = { ...config } as any;
  sanitized.openaiApiKeyConfigured = Boolean(config.openaiApiKey && config.openaiApiKey.trim().length > 0);
  sanitized.openaiApiKeyMasked = maskApiKey(config.openaiApiKey);
  delete sanitized.openaiApiKey;

  sanitized.geminiApiKeyConfigured = Boolean(config.geminiApiKey && config.geminiApiKey.trim().length > 0);
  sanitized.geminiApiKeyMasked = maskApiKey(config.geminiApiKey);
  delete sanitized.geminiApiKey;

  sanitized.togetherApiKeyConfigured = Boolean(
    config.togetherApiKey &&
    config.togetherApiKey.trim().length > 0 &&
    config.togetherApiKey !== "tu_api_key_aqui"
  );
  sanitized.togetherApiKeyMasked = maskApiKey(config.togetherApiKey);
  delete sanitized.togetherApiKey;

  return sanitized;
}

export function saveConfig(config: BotConfig): void {
  ensureDataDir();
  let existing: BotConfig | null = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const res = safeReadJson<BotConfig>(CONFIG_FILE, isValidBotConfig);
      existing = res.data;
    } catch (err) {
      if (err instanceof StorageCorruptedError) {
        console.error(`[Storage CRÍTICO] Bloqueando saveConfig(): config.json está dañado y no se pudo recuperar de respaldo.`);
        throw new Error(`[Storage CRÍTICO] No se puede sobrescribir config.json porque el archivo existente está dañado. Se ha preservado para recuperación manual.`);
      }
    }
  }

  // Preservar claves secretas si el cliente envió la versión enmascarada
  if (existing) {
    if (config.openaiApiKey && (config.openaiApiKey.includes("...") || config.openaiApiKey.includes("****"))) {
      config.openaiApiKey = existing.openaiApiKey;
    } else if (!config.openaiApiKey && existing.openaiApiKey) {
      config.openaiApiKey = existing.openaiApiKey;
    }

    if (config.geminiApiKey && (config.geminiApiKey.includes("...") || config.geminiApiKey.includes("****"))) {
      config.geminiApiKey = existing.geminiApiKey;
    } else if (!config.geminiApiKey && existing.geminiApiKey) {
      config.geminiApiKey = existing.geminiApiKey;
    }

    if (config.togetherApiKey && (config.togetherApiKey.includes("...") || config.togetherApiKey.includes("****"))) {
      config.togetherApiKey = existing.togetherApiKey;
    } else if (!config.togetherApiKey && existing.togetherApiKey) {
      config.togetherApiKey = existing.togetherApiKey;
    }

    if (config.sipPassword && (config.sipPassword.includes("...") || config.sipPassword.includes("****"))) {
      config.sipPassword = existing.sipPassword;
    } else if (!config.sipPassword && existing.sipPassword) {
      config.sipPassword = existing.sipPassword;
    }
  }

  atomicWriteJson(CONFIG_FILE, config);
}

export function loadCalls(): CallRecord[] {
  ensureDataDir();
  if (!fs.existsSync(CALLS_FILE)) {
    return [];
  }
  try {
    const { data } = safeReadJson<CallRecord[]>(CALLS_FILE, isValidCallsHistory);
    return data || [];
  } catch (err) {
    if (err instanceof StorageCorruptedError) {
      console.error(`[Storage CRÍTICO] calls.json está dañado. NO se vaciará ni sobrescribirá. Preservado para recuperación.`);
      throw err;
    }
    return [];
  }
}

export function saveCall(call: CallRecord): void {
  ensureDataDir();
  const calls = loadCalls();
  const existingIdx = calls.findIndex((c) => c.id === call.id);
  if (existingIdx >= 0) {
    calls[existingIdx] = call;
  } else {
    calls.unshift(call);
  }
  atomicWriteJson(CALLS_FILE, calls);
}

export function updateCall(id: string, partial: Partial<CallRecord>): CallRecord | null {
  ensureDataDir();
  const calls = loadCalls();
  const call = calls.find((c) => c.id === id);
  if (!call) return null;
  Object.assign(call, partial);
  atomicWriteJson(CALLS_FILE, calls);
  return call;
}
