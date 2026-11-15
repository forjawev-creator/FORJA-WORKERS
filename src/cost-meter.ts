import { CallCostSummary, AssistantRole } from "./types.js";

export interface RateCardEntry {
  audioInPerM: number;
  audioCachePerM: number;
  audioOutPerM: number;
  textInPerM: number;
  textCachePerM: number;
  textOutPerM: number;
}

export const OFFICIAL_RATES: Record<string, RateCardEntry> = {
  // Tarifas oficiales de referencia 15/10/2026 (USD por millón de tokens)
  "gpt-realtime-2.1-mini": {
    audioInPerM: 10.0,
    audioCachePerM: 0.30,
    audioOutPerM: 20.0,
    textInPerM: 0.60,
    textCachePerM: 0.06,
    textOutPerM: 2.40,
  },
  "gpt-realtime-2.1": {
    audioInPerM: 32.0,
    audioCachePerM: 0.40,
    audioOutPerM: 64.0,
    textInPerM: 4.0,
    textCachePerM: 0.40,
    textOutPerM: 24.0,
  },
};

export interface ResponseUsagePayload {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    cached_tokens?: number;
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens_details?: {
      text_tokens?: number;
      audio_tokens?: number;
    };
  };
  output_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
  };
}

export class CostMeter {
  private processedResponseIds: Set<string> = new Set();
  private totalCostUsd: number = 0;
  private commercialCostUsd: number = 0;
  private technicalCostUsd: number = 0;

  private commercialTokens = {
    audioInput: 0,
    audioInputCached: 0,
    audioOutput: 0,
    textInput: 0,
    textInputCached: 0,
    textOutput: 0,
  };

  private technicalTokens = {
    audioInput: 0,
    audioInputCached: 0,
    audioOutput: 0,
    textInput: 0,
    textInputCached: 0,
    textOutput: 0,
  };

  private alertLimit: number;
  private softLimit: number;
  private hardLimit: number;

  constructor(
    private readonly callId: string,
    alertLimitUsd = 0.10,
    softLimitUsd = 0.20,
    hardLimitUsd = 0.30
  ) {
    this.alertLimit = alertLimitUsd;
    this.softLimit = softLimitUsd;
    this.hardLimit = hardLimitUsd;
  }

  public getSummary(lastResponseCostUsd?: number): CallCostSummary {
    return {
      callId: this.callId,
      totalCostUsd: Number(this.totalCostUsd.toFixed(6)),
      commercialCostUsd: Number(this.commercialCostUsd.toFixed(6)),
      technicalCostUsd: Number(this.technicalCostUsd.toFixed(6)),
      commercialTokens: { ...this.commercialTokens },
      technicalTokens: { ...this.technicalTokens },
      lastResponseCostUsd: lastResponseCostUsd !== undefined ? Number(lastResponseCostUsd.toFixed(6)) : undefined,
      alertTriggered: this.totalCostUsd >= this.alertLimit,
      softLimitExceeded: this.totalCostUsd >= this.softLimit,
      hardLimitExceeded: this.totalCostUsd >= this.hardLimit,
    };
  }

  /**
   * Registra el uso de tokens de una respuesta de OpenAI Realtime
   */
  public recordResponseUsage(
    responseId: string,
    modelName: string,
    role: AssistantRole,
    usage?: ResponseUsagePayload
  ): CallCostSummary {
    if (!responseId || this.processedResponseIds.has(responseId) || !usage) {
      return this.getSummary();
    }

    this.processedResponseIds.add(responseId);

    // Determinar rates para el modelo
    const ratesKey = modelName.includes("mini") ? "gpt-realtime-2.1-mini" : "gpt-realtime-2.1";
    const rates = OFFICIAL_RATES[ratesKey] || OFFICIAL_RATES["gpt-realtime-2.1-mini"];

    const inDetails = usage.input_token_details || {};
    const outDetails = usage.output_token_details || {};
    const cachedDetails = inDetails.cached_tokens_details || {};

    const totalCached = inDetails.cached_tokens || 0;
    const audioCached = cachedDetails.audio_tokens || (inDetails.audio_tokens ? Math.min(totalCached, inDetails.audio_tokens) : 0);
    const textCached = Math.max(0, totalCached - audioCached);

    const totalAudioIn = inDetails.audio_tokens || 0;
    const uncachedAudioIn = Math.max(0, totalAudioIn - audioCached);

    const totalTextIn = inDetails.text_tokens || Math.max(0, (usage.input_tokens || 0) - totalAudioIn);
    const uncachedTextIn = Math.max(0, totalTextIn - textCached);

    const audioOut = outDetails.audio_tokens || 0;
    const textOut = outDetails.text_tokens || Math.max(0, (usage.output_tokens || 0) - audioOut);

    // Calcular coste de esta respuesta
    const responseCost =
      (uncachedAudioIn * rates.audioInPerM +
        audioCached * rates.audioCachePerM +
        uncachedTextIn * rates.textInPerM +
        textCached * rates.textCachePerM +
        audioOut * rates.audioOutPerM +
        textOut * rates.textOutPerM) /
      1_000_000;

    this.totalCostUsd += responseCost;

    if (role === "commercial") {
      this.commercialCostUsd += responseCost;
      this.commercialTokens.audioInput += uncachedAudioIn;
      this.commercialTokens.audioInputCached += audioCached;
      this.commercialTokens.textInput += uncachedTextIn;
      this.commercialTokens.textInputCached += textCached;
      this.commercialTokens.audioOutput += audioOut;
      this.commercialTokens.textOutput += textOut;
    } else {
      this.technicalCostUsd += responseCost;
      this.technicalTokens.audioInput += uncachedAudioIn;
      this.technicalTokens.audioInputCached += audioCached;
      this.technicalTokens.textInput += uncachedTextIn;
      this.technicalTokens.textInputCached += textCached;
      this.technicalTokens.audioOutput += audioOut;
      this.technicalTokens.textOutput += textOut;
    }

    return this.getSummary(responseCost);
  }

  public isHardLimitExceeded(): boolean {
    return this.totalCostUsd >= this.hardLimit;
  }
}
