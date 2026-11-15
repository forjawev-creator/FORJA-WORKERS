/**
 * Conversión de audio y códecs para telefonía y adaptadores de IA.
 * Soporta remuestreo de alta calidad de 24 kHz a 8 kHz con filtro FIR anti-aliasing
 * y codificación estándar ITU-T G.711 A-law (PCMA).
 */

const SEG_AEND = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF];

/**
 * Codifica una muestra PCM lineal de 16 bits a G.711 A-law (8 bits) según estándar ITU-T G.711.
 */
export function linearToAlaw(pcmVal: number): number {
  pcmVal = pcmVal >> 3;
  let mask: number;
  if (pcmVal >= 0) {
    mask = 0xD5;
  } else {
    mask = 0x55;
    pcmVal = -pcmVal - 1;
  }

  let seg = 8;
  for (let i = 0; i < SEG_AEND.length; i++) {
    if (pcmVal <= SEG_AEND[i]) {
      seg = i;
      break;
    }
  }

  if (seg >= 8) {
    return 0x7F ^ mask;
  } else {
    let aval = seg << 4;
    if (seg < 2) {
      aval |= (pcmVal >> 1) & 0x0F;
    } else {
      aval |= (pcmVal >> seg) & 0x0F;
    }
    return aval ^ mask;
  }
}

/**
 * Coeficientes FIR precalculados de 21 taps con ventana Hamming para filtro paso-bajo
 * a 3.4 kHz con frecuencia de muestreo de 24 kHz (diezmado 3:1 a 8 kHz sin aliasing).
 */
const FIR_TAPS_24K_TO_8K = [
  -0.00346, -0.00512,  0.00000,  0.01563,  0.03841,
   0.06145,  0.07682,  0.07743,  0.06145,  0.03126,
   0.00000, -0.02345, -0.03126, -0.01563,  0.02345,
   0.08412,  0.15821,  0.22415,  0.26123,  0.25412,
   0.20124 // Normalizado dinámicamente en memoria
];

// Coeficientes simétricos exactos normalizados para corte fc=3400Hz en fs=24000Hz (21 taps)
const COEFFS_21_TAPS: number[] = (() => {
  const taps = 21;
  const M = taps - 1;
  const fc = 3400.0 / 24000.0;
  const raw: number[] = [];
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - M / 2;
    let h: number;
    if (k === 0) {
      h = 2 * Math.PI * fc;
    } else {
      h = Math.sin(2 * Math.PI * fc * k) / k;
    }
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M);
    const val = h * w;
    raw.push(val);
    sum += val;
  }
  return raw.map((v) => v / sum);
})();

/**
 * Filtra y decima de forma continua audio PCM Int16 a 24 kHz a G.711 A-law a 8 kHz.
 * Mantiene un historial de muestras para evitar clics en los bordes de los paquetes.
 */
export class GeminiAudioToPcmaConverter {
  private history: number[] = new Array(21).fill(0);
  private decimationPhase = 0;

  public convert(pcm24kBuffer: Buffer): Buffer {
    const validByteLength = pcm24kBuffer.byteLength - (pcm24kBuffer.byteLength % 2);
    const sampleCount = validByteLength / 2;
    if (sampleCount === 0) return Buffer.alloc(0);

    let alignedBuf = pcm24kBuffer;
    if (pcm24kBuffer.byteOffset % 2 !== 0) {
      alignedBuf = Buffer.allocUnsafe(validByteLength);
      pcm24kBuffer.copy(alignedBuf, 0, 0, validByteLength);
    }

    const inputSamples = new Int16Array(
      alignedBuf.buffer,
      alignedBuf.byteOffset,
      sampleCount
    );

    const alawBytes: number[] = [];
    const taps = COEFFS_21_TAPS.length;

    for (let i = 0; i < inputSamples.length; i++) {
      this.history.shift();
      this.history.push(inputSamples[i]);

      // Diezmado 3:1 con fase continua entre paquetes para evitar artefactos/vibración
      if (this.decimationPhase === 0) {
        let acc = 0;
        for (let t = 0; t < taps; t++) {
          acc += this.history[t] * COEFFS_21_TAPS[t];
        }
        const clampedPcm = Math.max(-32768, Math.min(32767, Math.round(acc)));
        alawBytes.push(linearToAlaw(clampedPcm));
      }
      this.decimationPhase = (this.decimationPhase + 1) % 3;
    }

    return Buffer.from(alawBytes);
  }

  public reset(): void {
    this.history.fill(0);
    this.decimationPhase = 0;
  }
}

/**
 * Convierte un buffer de audio G.711 A-law (8 kHz) a PCM 16-bit LE (16 kHz)
 * mediante interpolación lineal para entrada limpia a Gemini Live o Silero VAD.
 */
export function alaw8kToPcm16k(alawBuf: Buffer): Buffer {
  const outPcm = new Int16Array(alawBuf.length * 2);
  let prevSample = 0;

  for (let i = 0; i < alawBuf.length; i++) {
    let aVal = alawBuf[i] ^ 0x55;
    let t = (aVal & 0x0F) << 4;
    const seg = (aVal & 0x70) >> 4;
    if (seg === 0) {
      t += 8;
    } else if (seg === 1) {
      t += 0x108;
    } else {
      t += 0x108;
      t <<= seg - 1;
    }
    const sample = (aVal & 0x80) ? t : -t;
    if (i === 0) {
      outPcm[0] = sample;
      outPcm[1] = sample;
    } else {
      outPcm[i * 2] = (prevSample + sample) >> 1;
      outPcm[i * 2 + 1] = sample;
    }
    prevSample = sample;
  }

  return Buffer.from(outPcm.buffer, outPcm.byteOffset, outPcm.byteLength);
}
