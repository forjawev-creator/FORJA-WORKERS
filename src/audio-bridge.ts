/**
 * Módulo de Procesamiento de Audio y Protocolo de Enlace (src/audio-bridge.ts)
 */

export const PACKET_AUDIO = 0x01;
export const PACKET_FLUSH = 0x02;
export const PACKET_PLAYBACK_DRAINED = 0x03;
export const PACKET_CALL_START = 0x04;
export const PACKET_CALL_END = 0x05;
export const PACKET_TURN_END = 0x06;
export const PACKET_PLAYBACK_STARTED = 0x07; // Notificación desde el hardware de audio: comenzó a sonar la voz

export const MAX_PACKET_PAYLOAD = 8192; // 8 KB máximo por paquete

export interface AudioPacket {
  type: number;
  turnId: number;
  payload: Buffer;
}

/**
 * Codifica un paquete con encabezado de 4 bytes:
 * [Tipo (1B)][TurnId (1B)][Longitud (2B BE)][Payload]
 */
export function encodePacket(
  type: number,
  turnId: number = 0,
  payload: Buffer = Buffer.alloc(0)
): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt8(type, 0);
  header.writeUInt8(turnId & 0xff, 1);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/**
 * Divide y emite buffers grandes de audio en fragmentos seguros (<= MAX_PACKET_PAYLOAD)
 */
export function encodeAudioPackets(turnId: number, audioBuffer: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;

  while (offset < audioBuffer.length) {
    const end = Math.min(offset + MAX_PACKET_PAYLOAD, audioBuffer.length);
    const chunk = audioBuffer.subarray(offset, end);
    packets.push(encodePacket(PACKET_AUDIO, turnId, Buffer.from(chunk)));
    offset = end;
  }

  return packets;
}

/**
 * Deserializa un flujo continuo de bytes TCP en paquetes completos.
 * Mantiene los bytes incompletos en un acumulador interno y nunca interpreta
 * fragmentos incompletos como audio crudo.
 */
export class PacketFramer {
  private buffer: Buffer = Buffer.alloc(0);

  public push(chunk: Buffer): AudioPacket[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets: AudioPacket[] = [];

    while (this.buffer.length >= 4) {
      const type = this.buffer.readUInt8(0);
      const turnId = this.buffer.readUInt8(1);
      const length = this.buffer.readUInt16BE(2);
      const totalSize = 4 + length;

      if (this.buffer.length < totalSize) {
        break; // Esperar resto del payload
      }

      const payload = Buffer.from(this.buffer.subarray(4, totalSize));
      packets.push({ type, turnId, payload });
      this.buffer = Buffer.from(this.buffer.subarray(totalSize));
    }

    return packets;
  }

  public clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Remuestrea un buffer PCM Int16 mediante interpolación lineal (para buffers completos estáticos).
 */
export function resamplePcm(
  input: Int16Array,
  fromRate: number,
  toRate: number
): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const low = Math.floor(srcIdx);
    const high = Math.min(low + 1, input.length - 1);
    const frac = srcIdx - low;
    output[i] = Math.round(input[low] * (1 - frac) + input[high] * frac);
  }
  return output;
}

/**
 * Remuestreador continuo de flujo PCM Int16.
 * Mantiene el residuo fraccionario entre bloques consecutivos para evitar
 * saltos de fase y discontinuidades en los límites de cada paquete.
 */
export class StreamingResampler {
  private remainder: Int16Array = new Int16Array(0);
  private cursor = 0.0;
  private readonly step: number;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number
  ) {
    this.step = fromRate / toRate;
  }

  public process(chunk: Int16Array): Int16Array {
    if (this.fromRate === this.toRate) return chunk;
    if (!chunk || chunk.length === 0) return new Int16Array(0);

    let input: Int16Array;
    if (this.remainder.length > 0) {
      input = new Int16Array(this.remainder.length + chunk.length);
      input.set(this.remainder);
      input.set(chunk, this.remainder.length);
    } else {
      input = chunk;
    }

    const out: number[] = [];
    const isDownsampling = this.step > 1.0;

    while (this.cursor < input.length - 1) {
      const low = Math.floor(this.cursor);
      const high = low + 1;
      const frac = this.cursor - low;

      let s: number;
      if (isDownsampling && low > 0 && high + 1 < input.length) {
        // Suavizado anti-aliasing de 3 taps antes de interpolar para evitar artefactos metálicos (8-12 kHz)
        const vLow = 0.15 * input[low - 1] + 0.70 * input[low] + 0.15 * input[high];
        const vHigh = 0.15 * input[low] + 0.70 * input[high] + 0.15 * input[high + 1];
        s = Math.round(vLow * (1 - frac) + vHigh * frac);
      } else {
        s = Math.round(input[low] * (1 - frac) + input[high] * frac);
      }

      out.push(Math.max(-32768, Math.min(32767, s)));
      this.cursor += this.step;
    }

    const lowIdx = Math.max(0, Math.floor(this.cursor) - 1);
    this.remainder = input.slice(lowIdx);
    this.cursor -= lowIdx;

    return new Int16Array(out);
  }

  public reset(): void {
    this.remainder = new Int16Array(0);
    this.cursor = 0.0;
  }
}

/**
 * Convierte un Buffer de Node.js a un Int16Array (PCM 16-bit LE).
 * Asegura la alineación de memoria independientemente del byteOffset.
 */
export function bufferToInt16Array(buf: Buffer): Int16Array {
  const validLength = buf.byteLength - (buf.byteLength % 2);
  if (buf.byteOffset % 2 !== 0) {
    const copy = Buffer.alloc(validLength);
    buf.copy(copy, 0, 0, validLength);
    return new Int16Array(copy.buffer, copy.byteOffset, validLength / 2);
  }
  return new Int16Array(buf.buffer, buf.byteOffset, validLength / 2);
}

/**
 * Convierte un Int16Array a un Buffer de Node.js.
 */
export function int16ArrayToBuffer(arr: Int16Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Convierte PCM Int16 a Float32 normalizado (-1.0 a 1.0) para Silero VAD.
 */
export function int16ToFloat32(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] / 32768.0;
  }
  return output;
}

/**
 * Buffer acumulador para garantizar que los chunks se dividan exactamente
 * en múltiplos del tamaño de ventana requerido (ej. 512 muestras para 16 kHz).
 */
export class AudioFrameAccumulator {
  private buffer: Int16Array = new Int16Array(0);

  constructor(private readonly frameSize: number) {}

  public append(samples: Int16Array): Int16Array[] {
    const totalLength = this.buffer.length + samples.length;
    const combined = new Int16Array(totalLength);
    combined.set(this.buffer);
    combined.set(samples, this.buffer.length);

    const frameCount = Math.floor(totalLength / this.frameSize);
    const frames: Int16Array[] = [];

    for (let i = 0; i < frameCount; i++) {
      frames.push(combined.subarray(i * this.frameSize, (i + 1) * this.frameSize));
    }

    const remainder = totalLength % this.frameSize;
    if (remainder > 0) {
      this.buffer = new Int16Array(combined.subarray(frameCount * this.frameSize));
    } else {
      this.buffer = new Int16Array(0);
    }

    return frames;
  }

  public clear(): void {
    this.buffer = new Int16Array(0);
  }
}

/**
 * Empaqueta muestras PCM Int16 en un buffer WAV estándar con cabecera RIFF de 44 bytes.
 */
export function encodeWav(pcmSamples: Int16Array, sampleRate: number): Buffer {
  const dataSize = pcmSamples.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  header.writeUInt16LE(2, 32); // BlockAlign
  header.writeUInt16LE(16, 34); // BitsPerSample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const data = Buffer.from(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength);
  return Buffer.concat([header, data]);
}
