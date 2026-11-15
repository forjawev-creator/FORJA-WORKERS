import { monitorEventLoopDelay, IntervalHistogram } from "node:perf_hooks";

export interface VoiceCallMetrics {
  callId: string;
  provider: "openai_realtime" | "gemini_live" | "together_pipeline";
  model: string;
  voice: string;
  startTime: number;
  endTime?: number;
  durationSeconds?: number;
  ttfbMs?: number;
  turnLatenciesMs: number[];
  interruptionCount: number;
  audioCancelCount: number;
  eventLoopLagMeanMs: number;
  eventLoopLagMaxMs: number;
  rtpPacketsSent?: number;
  rtpJitterMeanMs?: number;
  rtpJitterMaxMs?: number;
  bufferUnderruns?: number;
  bufferOverflows?: number;
  tokens?: Record<string, number>;
  estimatedCostUsd?: number;
}

export class VoiceTelemetryMonitor {
  private histogram: IntervalHistogram | null = null;
  private currentMetrics: Map<string, VoiceCallMetrics> = new Map();

  constructor() {
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 10 });
      this.histogram.enable();
    } catch (err: any) {
      console.warn("[VoiceTelemetry] No se pudo inicializar monitorEventLoopDelay:", err.message);
    }
  }

  public getEventLoopLag(): { meanMs: number; maxMs: number; minMs: number; p99Ms: number } {
    if (!this.histogram) {
      return { meanMs: 0, maxMs: 0, minMs: 0, p99Ms: 0 };
    }
    const toMs = (nanos: number) => {
      if (!nanos || isNaN(nanos) || !isFinite(nanos)) return 0;
      return Math.round((nanos / 1_000_000) * 100) / 100;
    };
    return {
      meanMs: toMs(this.histogram.mean),
      maxMs: toMs(this.histogram.max),
      minMs: toMs(this.histogram.min),
      p99Ms: toMs(this.histogram.percentile(99)),
    };
  }

  public startCall(callId: string, provider: "openai_realtime" | "gemini_live" | "together_pipeline", model: string, voice: string): void {
    if (this.histogram) {
      this.histogram.reset();
    }
    this.currentMetrics.set(callId, {
      callId,
      provider,
      model,
      voice,
      startTime: Date.now(),
      turnLatenciesMs: [],
      interruptionCount: 0,
      audioCancelCount: 0,
      eventLoopLagMeanMs: 0,
      eventLoopLagMaxMs: 0,
    });
  }

  public recordTtfb(callId: string, ttfbMs: number): void {
    const m = this.currentMetrics.get(callId);
    if (m && m.ttfbMs === undefined) {
      m.ttfbMs = Math.round(ttfbMs);
    }
  }

  public recordTurnLatency(callId: string, latencyMs: number): void {
    const m = this.currentMetrics.get(callId);
    if (m) {
      m.turnLatenciesMs.push(Math.round(latencyMs));
    }
  }

  public recordInterruption(callId: string): void {
    const m = this.currentMetrics.get(callId);
    if (m) {
      m.interruptionCount++;
    }
  }

  public recordAudioCancel(callId: string): void {
    const m = this.currentMetrics.get(callId);
    if (m) {
      m.audioCancelCount++;
    }
  }

  public updateBridgeMetrics(callId: string, data: { rtpPacketsSent?: number; rtpJitterMeanMs?: number; rtpJitterMaxMs?: number; bufferUnderruns?: number; bufferOverflows?: number }): void {
    const m = this.currentMetrics.get(callId);
    if (m) {
      Object.assign(m, data);
    }
  }

  public finalizeCall(callId: string): VoiceCallMetrics | null {
    const m = this.currentMetrics.get(callId);
    if (!m) return null;
    m.endTime = Date.now();
    m.durationSeconds = Math.round((m.endTime - m.startTime) / 1000);

    const lag = this.getEventLoopLag();
    m.eventLoopLagMeanMs = lag.meanMs;
    m.eventLoopLagMaxMs = lag.maxMs;

    this.currentMetrics.delete(callId);
    return m;
  }
}

export const voiceTelemetry = new VoiceTelemetryMonitor();
