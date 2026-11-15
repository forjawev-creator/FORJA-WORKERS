import fs from "fs";
import path from "path";
import crypto from "crypto";

const ENV_FILE_PATH = path.resolve(process.cwd(), ".env");

/**
 * Obtiene o inicializa de forma segura un secreto de autenticación para la API local de control de voz.
 * Nunca utiliza contraseñas por defecto en código fuente.
 */
export function getOrCreateVoiceControlSecret(): string {
  if (process.env.VOICE_CONTROL_SECRET && process.env.VOICE_CONTROL_SECRET.trim().length >= 16) {
    return process.env.VOICE_CONTROL_SECRET.trim();
  }

  try {
    if (fs.existsSync(ENV_FILE_PATH)) {
      const content = fs.readFileSync(ENV_FILE_PATH, "utf-8");
      const match = content.match(/^VOICE_CONTROL_SECRET\s*=\s*(.+)$/m);
      if (match && match[1].trim().length >= 16) {
        const secret = match[1].trim().replace(/^["']|["']$/g, "");
        process.env.VOICE_CONTROL_SECRET = secret;
        return secret;
      }
    }
  } catch (err: any) {
    console.warn("[SecretManager] Advertencia leyendo .env:", err.message);
  }

  // Generar secreto criptográfico seguro de 256 bits (64 hex)
  const newSecret = crypto.randomBytes(32).toString("hex");
  process.env.VOICE_CONTROL_SECRET = newSecret;

  try {
    const lineToAppend = `\n# Clave secreta generada para API local de control de voz\nVOICE_CONTROL_SECRET=${newSecret}\n`;
    fs.appendFileSync(ENV_FILE_PATH, lineToAppend, "utf-8");
    console.log("[SecretManager] Nuevo VOICE_CONTROL_SECRET generado y persistido en .env de forma segura.");
  } catch (err: any) {
    console.warn("[SecretManager] No se pudo persistir VOICE_CONTROL_SECRET en .env:", err.message);
  }

  return newSecret;
}
