import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

async function testTts() {
  const apiKey = process.env.TOGETHER_API_KEY;
  console.log("Testing Together TTS REST endpoint...");
  const res = await fetch("https://api.together.ai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "hexgrad/Kokoro-82M",
      input: "Hola mundo.",
      voice: "ef_dora",
      response_format: "pcm",
      sample_rate: 24000,
    }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log("Total bytes:", buf.length);
  fs.writeFileSync("fixtures/tts-sample.pcm", buf);

  // Check if it's WAV
  const magic = buf.subarray(0, 4).toString("ascii");
  console.log("Magic bytes:", magic);

  // Check Int16 samples
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  let min = 0, max = 0, nonZero = 0;
  for (let i = 0; i < int16.length; i++) {
    const val = int16[i];
    if (val !== 0) nonZero++;
    if (val < min) min = val;
    if (val > max) max = val;
  }
  console.log("Int16 length:", int16.length, "Non-zero:", nonZero, "Min:", min, "Max:", max);

  // Check if it could be Float32
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  let fMin = 0, fMax = 0, fInRange = 0;
  for (let i = 0; i < float32.length; i++) {
    const v = float32[i];
    if (v < fMin) fMin = v;
    if (v > fMax) fMax = v;
    if (v >= -1.0 && v <= 1.0) fInRange++;
  }
  console.log("Float32 length:", float32.length, "Min:", fMin, "Max:", fMax, "InRange (-1..1):", fInRange);
}
testTts();
