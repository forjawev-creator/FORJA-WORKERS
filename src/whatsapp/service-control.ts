import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson } from "../storage.js";

type Command = { action: "connect" | "logout" | "test"; forceNew?: boolean; phone?: string; message?: string };
const dir = path.resolve(process.cwd(), "data", "whatsapp-control");
export async function requestWhatsAppControl(command: Command): Promise<any> {
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID(), request = path.join(dir, `${id}.request.json`), response = path.join(dir, `${id}.response.json`);
  atomicWriteJson(request, { ...command, expiresAt: Date.now() + 10_000 });
  const expires = Date.now() + 75_000;
  while (Date.now() < expires) {
    if (fs.existsSync(response)) {
      const result = JSON.parse(fs.readFileSync(response, "utf8"));
      fs.unlinkSync(response);
      if (!result.ok) throw new Error(result.error || "No se pudo completar el control de WhatsApp");
      return result.result;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (fs.existsSync(request)) fs.unlinkSync(request);
  throw new Error("El servicio externo no confirmó la operación; comprueba su estado antes de repetirla");
}

export async function processWhatsAppControls(service: {
  startConnection: (forceNew?: boolean) => Promise<any>; logout: () => Promise<any>;
  sendMessage: (phone: string, message: string) => Promise<any>;
}): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir).filter(f => /^[\da-f-]+\.request\.json$/.test(f))) {
    const request = path.join(dir, file), processing = request.replace('.request.json', '.processing.json');
    try { fs.renameSync(request, processing); } catch { continue; }
    let result: any;
    try {
      const command = JSON.parse(fs.readFileSync(processing, "utf8"));
      if (!Number.isFinite(command.expiresAt) || command.expiresAt < Date.now()) throw new Error("La orden de control ha caducado");
      if (command.action === "connect") result = await service.startConnection(command.forceNew === true);
      else if (command.action === "logout") { await service.logout(); result = { success: true }; }
      else if (command.action === "test" && typeof command.phone === "string" && /^\+?\d{9,15}$/.test(command.phone) && typeof command.message === "string" && command.message.length <= 4000) {
        result = await service.sendMessage(command.phone, command.message);
      } else throw new Error("Orden de WhatsApp no válida");
      atomicWriteJson(request.replace('.request.json', '.response.json'), { ok: true, result });
    } catch {
      atomicWriteJson(request.replace('.request.json', '.response.json'), { ok: false, error: "La operación no se confirmó; revisa el estado del servicio" });
    }
    // Processing files surviving a crash are never automatically replayed.
    fs.unlinkSync(processing);
  }
}
