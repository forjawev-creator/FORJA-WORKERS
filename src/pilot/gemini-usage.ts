import type { UsageEstimate } from "./probe-controller.js";
export interface GeminiRateCard { version: string; model: string; inputMicroUsdPerMillionTokens: { TEXT: number; AUDIO: number }; outputMicroUsdPerMillionTokens: { TEXT: number; AUDIO: number } }
type Detail = { modality: string; tokenCount: number };
type Snapshot = { sequence: number; turn: number; complete: boolean; metadata: Record<string, number | Detail[]> };
const scalarKeys = ["promptTokenCount", "responseTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount"];
const detailKeys = ["promptTokensDetails", "responseTokensDetails", "cacheTokensDetails", "toolUsePromptTokensDetails"];
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Raw usage observations are not provider invoices or cumulative session counters. */
export class GeminiUsageMeter {
  snapshots: Snapshot[] = [];
  private reports = new Map<number, Snapshot>();
  private unresolved = new Set<number>();
  private sequence = 0;
  constructor(private readonly rates?: GeminiRateCard) {
    if (rates && (!rates.version || !rates.model || ![rates.inputMicroUsdPerMillionTokens?.TEXT, rates.inputMicroUsdPerMillionTokens?.AUDIO, rates.outputMicroUsdPerMillionTokens?.TEXT, rates.outputMicroUsdPerMillionTokens?.AUDIO].every(count))) throw new Error("Tarifa Gemini por modalidad inválida");
  }
  accept(metadata: Record<string, unknown>, turn = 0, complete = false): UsageEstimate | null {
    const clean: Snapshot["metadata"] = {};
    for (const key of scalarKeys) if (count(metadata[key])) clean[key] = metadata[key];
    for (const key of detailKeys) {
      const value = metadata[key];
      if (Array.isArray(value) && value.length <= 8 && value.every(d => d && typeof d.modality === "string" && d.modality.length <= 32 && count(d.tokenCount))) clean[key] = value.map(d => ({ modality: d.modality, tokenCount: d.tokenCount }));
    }
    if (!count(clean.totalTokenCount)) return null;
    const snapshot = { sequence: ++this.sequence, turn, complete, metadata: clean };
    this.snapshots.push(snapshot); if (this.snapshots.length > 64) this.snapshots.shift();
    if (complete) { this.reports.set(turn, snapshot); this.unresolved.delete(turn); } else this.unresolved.add(turn);
    let input = 0, output = 0, total = 0, numerator = 0n;
    let estimable = !!this.rates && this.unresolved.size === 0 && this.reports.size > 0;
    for (const report of this.reports.values()) {
      const m = report.metadata;
      if (!count(m.promptTokenCount) || !count(m.responseTokenCount)) { estimable = false; continue; }
      input += m.promptTokenCount; output += m.responseTokenCount; total += Number(m.totalTokenCount);
      if (Number(m.cachedContentTokenCount || 0) || Number(m.thoughtsTokenCount || 0) || Number(m.toolUsePromptTokenCount || 0)) estimable = false;
      for (const [detailsKey, expected, rates] of [["promptTokensDetails", m.promptTokenCount, this.rates?.inputMicroUsdPerMillionTokens], ["responseTokensDetails", m.responseTokenCount, this.rates?.outputMicroUsdPerMillionTokens]] as const) {
        const details = m[detailsKey];
        if (!Array.isArray(details) || details.reduce((s, d) => s + d.tokenCount, 0) !== expected || details.some(d => !["TEXT", "AUDIO"].includes(d.modality))) { estimable = false; continue; }
        for (const detail of details) if (rates) numerator += BigInt(detail.tokenCount) * BigInt(rates[detail.modality as "TEXT" | "AUDIO"]);
      }
    }
    if (![input, output, total].every(count)) throw new Error("Consumo Gemini fuera de rango");
    const estimate = estimable ? Number((numerator + 999999n) / 1000000n) : null;
    if (estimate !== null && !Number.isSafeInteger(estimate)) throw new Error("Coste Gemini fuera de rango");
    return { inputTokens: input, outputTokens: output, totalTokens: total, estimatedMicroUsd: estimate, tariffVersion: this.rates?.version ?? null, observations: this.snapshots.map(s => ({ ...s, metadata: { ...s.metadata } })), accountingComplete: estimable, actualMicroUsd: null };
  }
}
