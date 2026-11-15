import fs from "node:fs";
import path from "node:path";

export const communicationsBlockedMessage = "Comunicaciones reales bloqueadas. El panel funciona en modo de control sin llamadas ni envíos.";
export function runtimePolicy(): { realCallsEnabled: boolean; realWhatsAppEnabled: boolean; controlOnly: boolean } {
  try {
    const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data", "runtime-policy.json"), "utf8"));
    const realCallsEnabled = data.realCallsEnabled === true;
    const realWhatsAppEnabled = data.realWhatsAppEnabled === true;
    return { realCallsEnabled, realWhatsAppEnabled, controlOnly: !realCallsEnabled && !realWhatsAppEnabled };
  } catch { return { realCallsEnabled: false, realWhatsAppEnabled: false, controlOnly: true }; }
}
