import fs from "fs";
import { resamplePcm, bufferToInt16Array } from "../src/audio-bridge.js";

const pcm24k = fs.readFileSync("fixtures/tts-sample.pcm");
const int16_24k = bufferToInt16Array(pcm24k);
console.log("24k samples:", int16_24k.length);

const int16_16k = resamplePcm(int16_24k, 24000, 16000);
console.log("16k samples:", int16_16k.length);

function writeWav(filename: string, pcmSamples: Int16Array, sampleRate: number) {
  const dataSize = pcmSamples.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const data = Buffer.from(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength);
  fs.writeFileSync(filename, Buffer.concat([header, data]));
  console.log("Wrote", filename, "bytes:", header.length + data.length);
}

writeWav("fixtures/test-24k.wav", int16_24k, 24000);
writeWav("fixtures/test-16k.wav", int16_16k, 16000);
