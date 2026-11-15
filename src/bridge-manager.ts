import { runtimePolicy, communicationsBlockedMessage } from "./runtime-policy.js";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import dgram from "dgram";
import { getOrCreateVoiceControlSecret } from "./utils/secret-manager.js";

let bridgeProcess: ChildProcess | null = null;
let bridgeStartTime: number | null = null;
const bridgeLogs: string[] = [];

function appendLog(line: string): void {
  const clean = line.trim();
  if (!clean) return;
  const timestamp = new Date().toLocaleTimeString();
  bridgeLogs.push(`[${timestamp}] ${clean}`);
  if (bridgeLogs.length > 50) {
    bridgeLogs.shift();
  }
}

export function getBridgeStatus(): {
  running: boolean;
  pid?: number;
  mode: string;
  uptimeSeconds?: number;
  logs: string[];
} {
  const isRunning = bridgeProcess !== null && !bridgeProcess.killed;
  const uptime = isRunning && bridgeStartTime ? Math.floor((Date.now() - bridgeStartTime) / 1000) : 0;
  return {
    running: isRunning,
    pid: bridgeProcess?.pid,
    mode: "netelip",
    uptimeSeconds: uptime,
    logs: [...bridgeLogs],
  };
}

export async function fetchBridgeTelemetry(): Promise<Record<string, any>> {
  try {
    const secret = getOrCreateVoiceControlSecret();
    const res = await fetch("http://127.0.0.1:8086/api/v1/status", {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      return ((await res.json()) as Record<string, any>) || {};
    }
  } catch {}
  return {};
}

export function startBridge(): {
  success: boolean;
  message: string;
} {
  if (!runtimePolicy().realCallsEnabled) return { success: false, message: communicationsBlockedMessage };
  if (bridgeProcess && !bridgeProcess.killed) {
    return { success: true, message: `La centralita ya está ejecutándose (PID ${bridgeProcess.pid})` };
  }

  const scriptPath = path.resolve(process.cwd(), "bridge/netelip-bridge.py");

  try {
    const secret = getOrCreateVoiceControlSecret();
    bridgeProcess = spawn("python", ["-u", scriptPath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        VOICE_CONTROL_SECRET: secret,
      },
    });

    bridgeStartTime = Date.now();
    appendLog(`Centralita Netelip iniciada (PID: ${bridgeProcess.pid})`);

    bridgeProcess.stdout?.on("data", (data: Buffer) => {
      appendLog(data.toString());
    });

    bridgeProcess.stderr?.on("data", (data: Buffer) => {
      appendLog(data.toString());
    });

    bridgeProcess.on("close", (code) => {
      appendLog(`Centralita detenida (código de salida: ${code})`);
      bridgeProcess = null;
      bridgeStartTime = null;
    });

    bridgeProcess.on("error", (err) => {
      appendLog(`Error en proceso de centralita: ${err.message}`);
      bridgeProcess = null;
      bridgeStartTime = null;
    });

    return { success: true, message: `Centralita Netelip iniciada correctamente (PID ${bridgeProcess.pid})` };
  } catch (err: any) {
    appendLog(`Error iniciando centralita: ${err.message}`);
    return { success: false, message: `Error iniciando centralita: ${err.message}` };
  }
}

export function stopBridge(): { success: boolean; message: string } {
  if (!bridgeProcess || bridgeProcess.killed) {
    return { success: false, message: "La centralita no está en ejecución." };
  }

  try {
    bridgeProcess.kill("SIGTERM");
    appendLog("Se envió señal de detención a la centralita.");
    bridgeProcess = null;
    bridgeStartTime = null;
    return { success: true, message: "Centralita detenida correctamente." };
  } catch (err: any) {
    return { success: false, message: `Error deteniendo centralita: ${err.message}` };
  }
}

/**
 * Envía un comando estructurado a la API HTTP local de la centralita en 127.0.0.1:8086 con token Bearer
 */
export async function sendHttpNetelipCommand(payload: {
  command: "dial" | "hangup" | "transfer";
  call_id?: string;
  phone?: string;
  company?: string;
  target_phone?: string;
}): Promise<{ success: boolean; message: string; data?: any }> {
  if (payload.command !== "hangup" && !runtimePolicy().realCallsEnabled) return { success: false, message: communicationsBlockedMessage };
  const secret = getOrCreateVoiceControlSecret();
  try {
    const res = await fetch("http://127.0.0.1:8086/api/v1/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });

    const data: any = await res.json().catch(() => ({}));
    if (res.status === 202 || res.status === 200) {
      appendLog(`[HTTP Control] Comando '${payload.command}' aceptado: ${JSON.stringify(data)}`);
      return { success: true, message: data.status || "Operación aceptada", data };
    } else if (res.status === 409) {
      return { success: false, message: "Centralita ocupada en otra llamada activa." };
    } else if (res.status === 503) {
      return { success: false, message: "Centralita Netelip no registrada en SIP." };
    } else {
      return { success: false, message: data.error || `Error HTTP ${res.status}` };
    }
  } catch (httpErr: any) {
    // Si la API HTTP no responde o está en arranque, recurrir al canal UDP como respaldo secundario
    appendLog(`[HTTP Control Fallback UDP] ${httpErr.message}`);
    return fallbackUdpCommand(payload);
  }
}

function fallbackUdpCommand(payload: any): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    let cmdStr = "";
    if (payload.command === "dial") {
      cmdStr = payload.call_id
        ? `DIAL:${payload.phone}:${payload.company || "Cliente"}:${payload.call_id}`
        : `DIAL:${payload.phone}:${payload.company || "Cliente"}`;
    } else if (payload.command === "hangup") {
      cmdStr = "HANGUP";
    } else if (payload.command === "transfer") {
      cmdStr = `TRANSFER:${payload.target_phone || payload.phone || ""}`;
    }

    const client = dgram.createSocket("udp4");
    const msg = Buffer.from(cmdStr, "utf-8");
    client.send(msg, 0, msg.length, 8085, "127.0.0.1", (err) => {
      client.close();
      if (err) {
        appendLog(`Error UDP fallback: ${err.message}`);
        resolve({ success: false, message: err.message });
      } else {
        appendLog(`Comando enviado por UDP fallback: ${cmdStr}`);
        resolve({ success: true, message: "Comando enviado (UDP fallback)" });
      }
    });
  });
}

export function sendNetelipCommand(command: string): Promise<boolean> {
  const parts = command.split(":");
  const op = parts[0].toLowerCase();
  if (op === "dial") {
    return sendHttpNetelipCommand({
      command: "dial",
      phone: parts[1],
      company: parts[2] || "Cliente",
      call_id: parts[3],
    }).then((r) => r.success);
  } else if (op === "hangup" || op === "end") {
    return sendHttpNetelipCommand({ command: "hangup" }).then((r) => r.success);
  } else if (op === "transfer") {
    return sendHttpNetelipCommand({ command: "transfer", target_phone: parts[1] }).then((r) => r.success);
  }
  return Promise.resolve(false);
}

export async function dialNetelip(
  phoneNumber: string,
  company: string = "Cliente",
  callId?: string
): Promise<{ success: boolean; message: string }> {
  if (!runtimePolicy().realCallsEnabled) return { success: false, message: communicationsBlockedMessage };
  if (!bridgeProcess || bridgeProcess.killed) {
    const started = startBridge();
    if (!started.success) {
      return { success: false, message: `No se pudo iniciar la centralita Netelip: ${started.message}` };
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  const cleanNumber = phoneNumber.replace(/[^0-9+*#]/g, "");
  if (!cleanNumber) {
    return { success: false, message: "Número de teléfono no válido." };
  }

  const safeCallId = callId || `call_${Date.now()}`;
  return sendHttpNetelipCommand({
    command: "dial",
    phone: cleanNumber,
    company: company.replace(/:/g, " "),
    call_id: safeCallId,
  });
}

export async function hangupNetelip(): Promise<{ success: boolean; message: string }> {
  return sendHttpNetelipCommand({ command: "hangup" });
}

export async function transferNetelip(targetPhone?: string): Promise<{ success: boolean; message: string }> {
  return sendHttpNetelipCommand({
    command: "transfer",
    target_phone: targetPhone,
  });
}
