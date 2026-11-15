import * as ort from "onnxruntime-node";
import path from "path";
import { int16ToFloat32, AudioFrameAccumulator } from "./audio-bridge.js";
import { VadConfig } from "./types.js";

/**
 * Motor de Inferencia Silero VAD (ONNX CPU)
 * Procesa ventanas de audio de 32 ms para detección de turnos y corte (barge-in).
 */
export class SileroVad {
  private session: ort.InferenceSession;
  private stateTensor: ort.Tensor;
  private srTensor: ort.Tensor;
  private accumulator: AudioFrameAccumulator;

  private sampleRate: number;
  private frameSize: number;
  private frameDurationMs: number;
  private contextSize: number;
  private contextBuffer: Float32Array;

  private speechThreshold: number;
  private silenceThreshold: number;
  private silenceTimeoutMs: number;
  private bargeInThreshold: number;
  private bargeInConsecutiveFrames: number;

  // Seguimiento de estado de conversación y turnos
  private isSpeaking = false;
  private silenceDurationMs = 0;
  private speechDurationMs = 0;
  private consecutiveBargeInCount = 0;

  // Buffer circular de audio reciente (pre-roll) para no perder las primeras palabras al interrumpir
  private recentFramesBuffer: Int16Array[] = [];
  private readonly maxPreRollFrames = 10; // ~320ms de audio

  private constructor(session: ort.InferenceSession, config: VadConfig) {
    this.session = session;
    this.sampleRate = config.sampleRate;
    this.frameSize = this.sampleRate === 8000 ? 256 : 512;
    this.contextSize = this.sampleRate === 8000 ? 32 : 64;
    this.contextBuffer = new Float32Array(this.contextSize);
    this.frameDurationMs = (this.frameSize / this.sampleRate) * 1000; // ~32ms

    this.speechThreshold = config.speechThreshold;
    this.silenceThreshold = config.silenceThreshold;
    this.silenceTimeoutMs = config.silenceTimeoutMs;
    this.bargeInThreshold = config.bargeInThreshold;
    this.bargeInConsecutiveFrames = config.bargeInConsecutiveFrames;

    this.accumulator = new AudioFrameAccumulator(this.frameSize);

    // Estado recurrente para Silero VAD v5 [2, 1, 128] y sr escalar []
    this.stateTensor = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.srTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(this.sampleRate)]), []);
  }

  public static async create(
    modelPath?: string,
    customConfig?: Partial<VadConfig>
  ): Promise<SileroVad> {
    const defaultPath = path.resolve(process.cwd(), "silero_vad.onnx");
    const targetPath = modelPath || defaultPath;

    const session = await ort.InferenceSession.create(targetPath, {
      executionProviders: ["cpu"],
    });

    const config: VadConfig = {
      sampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE || "16000", 10),
      speechThreshold: parseFloat(process.env.VAD_SPEECH_THRESHOLD || "0.60"),
      silenceThreshold: parseFloat(process.env.VAD_SILENCE_THRESHOLD || "0.35"),
      silenceTimeoutMs: parseInt(process.env.VAD_SILENCE_TIMEOUT_MS || "500", 10),
      bargeInThreshold: parseFloat(process.env.BARGE_IN_THRESHOLD || "0.88"),
      bargeInConsecutiveFrames: parseInt(process.env.BARGE_IN_CONSECUTIVE_FRAMES || "8", 10),
      ...customConfig,
    };

    return new SileroVad(session, config);
  }

  /**
   * Ejecuta una ventana de audio (512 muestras a 16kHz o 256 a 8kHz) en el modelo Silero VAD.
   */
  public async inferFrame(frameSamples: Int16Array): Promise<number> {
    if (frameSamples.length !== this.frameSize) {
      throw new Error(`Tamaño de frame inválido: ${frameSamples.length}. Se esperaban ${this.frameSize}`);
    }

    const floatSamples = int16ToFloat32(frameSamples);
    const inputData = new Float32Array(this.contextSize + this.frameSize);
    inputData.set(this.contextBuffer, 0);
    inputData.set(floatSamples, this.contextSize);
    this.contextBuffer = floatSamples.slice(this.frameSize - this.contextSize);

    const inputTensor = new ort.Tensor("float32", inputData, [1, this.contextSize + this.frameSize]);

    const feeds: Record<string, ort.Tensor> = {
      input: inputTensor,
      state: this.stateTensor,
      sr: this.srTensor,
    };

    const results = await this.session.run(feeds);
    const prob = Number(results.output.data[0]);

    if (results.stateN) {
      this.stateTensor = results.stateN;
    }

    return prob;
  }

  /**
   * Evalúa si hay interrupción (Barge-in) durante el estado SPEAKING.
   * Aplica estrictamente el conteo de frames consecutivos (bargeInConsecutiveFrames)
   * y retorna todos los frames acumulados para no perder las primeras palabras.
   */
  public async checkBargeIn(pcmChunk: Int16Array): Promise<{ triggered: boolean; frames: Int16Array[] }> {
    const frames = this.accumulator.append(pcmChunk);
    if (frames.length === 0) {
      return { triggered: false, frames: [] };
    }

    for (const frame of frames) {
      // Guardar en el buffer circular de audio reciente
      this.recentFramesBuffer.push(frame);
      if (this.recentFramesBuffer.length > this.maxPreRollFrames) {
        this.recentFramesBuffer.shift();
      }

      const prob = await this.inferFrame(frame);

      if (prob >= this.bargeInThreshold) {
        this.consecutiveBargeInCount++;
        // Solo se dispara cuando alcanza estrictamente los frames consecutivos configurados
        if (this.consecutiveBargeInCount >= this.bargeInConsecutiveFrames) {
          const recoveredFrames = [...this.recentFramesBuffer];
          this.recentFramesBuffer = [];
          this.consecutiveBargeInCount = 0;
          return { triggered: true, frames: recoveredFrames };
        }
      } else {
        this.consecutiveBargeInCount = 0;
      }
    }

    return { triggered: false, frames: [] };
  }

  /**
   * Evalúa la frontera de turno durante el modo de escucha (LISTENING).
   * Devuelve true cuando el usuario ha terminado de hablar (silencio > VAD_SILENCE_TIMEOUT_MS).
   */
  public async evaluateTurnBoundary(pcmChunk: Int16Array): Promise<boolean> {
    const frames = this.accumulator.append(pcmChunk);
    if (frames.length === 0) return false;

    let speechCommitted = false;

    for (const frame of frames) {
      const prob = await this.inferFrame(frame);

      if (prob >= this.speechThreshold) {
        this.isSpeaking = true;
        this.speechDurationMs += this.frameDurationMs;
        this.silenceDurationMs = 0;
      } else if (prob <= this.silenceThreshold) {
        if (this.isSpeaking) {
          this.silenceDurationMs += this.frameDurationMs;

          // Se confirma fin de turno tras silencio prolongado y al menos 150ms de habla previa.
          // Si hubo menos de 150ms (ruido/chasquido aislado), limpiar contadores para no acumularlos.
          if (this.silenceDurationMs >= this.silenceTimeoutMs) {
            if (this.speechDurationMs >= 150) {
              speechCommitted = true;
            }
            this.isSpeaking = false;
            this.speechDurationMs = 0;
            this.silenceDurationMs = 0;
          }
        }
      }
    }

    return speechCommitted;
  }

  /**
   * Reinicia el estado recurrente y los contadores entre turnos o en nuevas llamadas.
   */
  public resetState(): void {
    this.stateTensor = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.contextBuffer.fill(0);
    this.accumulator.clear();
    this.isSpeaking = false;
    this.silenceDurationMs = 0;
    this.speechDurationMs = 0;
    this.consecutiveBargeInCount = 0;
    this.recentFramesBuffer = [];
  }
}
