import dotenv from "dotenv";
import { WebSocket } from "ws";
dotenv.config();

async function testTogetherTtsWs() {
  const apiKey = process.env.TOGETHER_API_KEY;
  const url = `wss://api.together.ai/v1/audio/speech/websocket?model=hexgrad%2FKokoro-82M&voice=ef_dora&response_format=pcm&sample_rate=24000`;

  console.log("Conectando a:", url);
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  ws.on("open", () => {
    console.log("WebSocket open!");
  });

  ws.on("message", (raw) => {
    const str = raw.toString();
    console.log("WS message received (len " + str.length + "):");
    try {
      const json = JSON.parse(str);
      console.log("Type:", json.type);
      if (json.type === "session.created") {
        console.log("Session created! Sending text...");
        ws.send(JSON.stringify({
          type: "input_text_buffer.append",
          text: "Hola, buenas.",
        }));
        ws.send(JSON.stringify({
          type: "input_text_buffer.commit",
        }));
      } else if (json.type === "conversation.item.audio_output.delta") {
        console.log("Delta received! Base64 len:", json.delta?.length);
        const buf = Buffer.from(json.delta, "base64");
        console.log("Raw audio bytes:", buf.length);
      } else {
        console.log("Other message:", JSON.stringify(json).slice(0, 150));
      }
    } catch {
      console.log("Non-json message:", str.slice(0, 100));
    }
  });

  ws.on("error", (err) => {
    console.error("WS error:", err.message);
  });

  ws.on("close", (code, reason) => {
    console.log("WS closed:", code, reason.toString());
  });

  setTimeout(() => {
    ws.close();
  }, 6000);
}

testTogetherTtsWs();
