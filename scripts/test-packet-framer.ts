import { encodeAudioPackets, PacketFramer, PACKET_AUDIO } from "../src/audio-bridge.js";

const original = Buffer.alloc(20000);
for (let i = 0; i < original.length; i++) {
  original[i] = (i * 7) & 0xff;
}

const packets = encodeAudioPackets(1, original);
const framer = new PacketFramer();
const received: Buffer[] = [];

for (const pkt of packets) {
  const parsed = framer.push(pkt);
  for (const p of parsed) {
    if (p.type === PACKET_AUDIO) {
      received.push(p.payload);
    }
  }
}

const reconstructed = Buffer.concat(received);
console.log("Original length:", original.length);
console.log("Reconstructed length:", reconstructed.length);
console.log("Matches:", original.equals(reconstructed));
