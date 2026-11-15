export type CallState = "listening" | "processing" | "speaking";

export type CallStage = 1 | 2 | 3 | 4 | 5;

export type PendingQuestion =
  | "CONFIRM_BUSINESS"
  | "OFFER_PROPOSAL"
  | "EXPLAIN_DOUBT"
  | "WHATSAPP_PERMISSION"
  | "CONFIRM_PHONE"
  | "NONE";

export type CallOutcomeStatus =
  | "EN_CURSO"
  | "AUTORIZADO"
  | "RECHAZADO"
  | "PERSONA_EQUIVOCADA"
  | "LLAMAR_DESPUES"
  | "NO_RESPONDE"
  | "OCUPADO"
  | "FALLO_MARCADO"
  | "DESCONEXION"
  | "TERMINADO";

export interface CallSessionContext {
  currentStage: CallStage;
  pendingQuestion: PendingQuestion;
  businessConfirmed: boolean;
  companyName?: string;
  trade?: string;
  interestShown: boolean;
  doubtsResolved: string[];
  whatsappAuthorized: boolean;
  phoneConfirmed: boolean;
  confirmedPhone?: string;
  evidenceQuote?: string;
  outcomeStatus: CallOutcomeStatus;
  shouldHangUp?: boolean;
  sessionId?: string;
  callDirection?: "outbound" | "inbound";
}

export interface StageConfig {
  id: CallStage;
  name: string;
  goal: string;
  guidePhrase: string;
  advanceCondition: string;
}

export interface StagesConfig {
  stage1: StageConfig; // Presentación
  stage2: StageConfig; // Propuesta
  stage3: StageConfig; // Aclaraciones
  stage4: StageConfig; // Autorización y contacto
  stage5: StageConfig; // Despedida
  objections: {
    price: string;
    alreadyHasWeb: string;
    noTime: string;
    callLater: string;
    wrongPerson: string;
    refusal: string;
  };
}

export type ConversationEngineType = "together_pipeline" | "openai_realtime" | "gemini_live";

export type AssistantRole = "commercial" | "technical";

export type ScriptVariant = "cercano" | "formal" | "ab_test";

export type PhoneState = "disconnected" | "dialing" | "connected" | "ending" | "ended";
export type CallProgressState = "reservado" | "marcando" | "conectado" | "terminando" | "finalizado";

export interface ActiveSessionHandle {
  ws: any;
  model: string;
  voice: string;
  role: AssistantRole;
  isReady: boolean;
  close?: () => void;
}

export type HandoffState =
  | "idle"
  | "preparing"
  | "announcing"
  | "draining"
  | "switching"
  | "active"
  | "failed";

export type RealtimeTurnDetection = "semantic_vad" | "server_vad" | "none";
export type RealtimeEagerness = "low" | "medium" | "high";

export interface CallCostSummary {
  callId: string;
  totalCostUsd: number;
  commercialCostUsd: number;
  technicalCostUsd: number;
  commercialTokens: {
    audioInput: number;
    audioInputCached: number;
    audioOutput: number;
    textInput: number;
    textInputCached: number;
    textOutput: number;
  };
  technicalTokens: {
    audioInput: number;
    audioInputCached: number;
    audioOutput: number;
    textInput: number;
    textInputCached: number;
    textOutput: number;
  };
  lastResponseCostUsd?: number;
  alertTriggered: boolean;
  softLimitExceeded: boolean;
  hardLimitExceeded: boolean;
}

export interface AgentConfig {
  apiKey: string;
  persona: string;
  systemPrompt: string;
  sttModel: string;
  llmModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed?: number;
  naturalPauses?: boolean;
  sampleRate: number;
  /**
   * Códec del enlace de audio con el puente:
   *  - "pcm16": PCM 16-bit mono a `sampleRate` (navegador).
   *  - "pcma": G.711 A-law a 8 kHz crudo (centralita Netelip). Se envía tal cual a OpenAI
   *    Realtime (`audio/pcma`), sin remuestreos intermedios.
   */
  audioCodec?: "pcm16" | "pcma";
  maxTokens: number;
  disableReasoning: boolean;
  installPrice?: string;
  monthlyPriceBasic?: string;
  monthlyPriceFull?: string;
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

export interface VadConfig {
  sampleRate: number;
  speechThreshold: number;
  silenceThreshold: number;
  silenceTimeoutMs: number;
  bargeInThreshold: number;
  bargeInConsecutiveFrames: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TurnLatencyMetrics {
  speechEndTime: number;
  firstTokenTime?: number;
  firstSentenceTime?: number;
  firstAudioTime?: number;
  ttftMs?: number; // Time to First Text (primer texto/oración)
  ttfaMs?: number; // Time to First Audio (primera voz audible)
}

export type AudioCallback = (pcmChunk24k: Int16Array) => void;

