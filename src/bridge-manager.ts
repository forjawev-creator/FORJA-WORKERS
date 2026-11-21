import { BridgeSupervisor, type BridgeObservation } from "./bridge-supervisor.js";
import { runtimePolicy, communicationsBlockedMessage } from "./runtime-policy.js";
import { spawn, ChildProcess } from "child_process";
import path from "path";
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

const supervision = new BridgeSupervisor();
let supervisorTimer: ReturnType<typeof setInterval> | undefined;
let supervisorBusy = false;
export async function fetchBridgeHealth(): Promise<BridgeObservation> {
  const telemetry = await fetchBridgeTelemetry();
  return supervision.observe({
    processRunning: bridgeProcess !== null && !bridgeProcess.killed,
    reachable: telemetry.reachable === true,
    registered: telemetry.registered === true,
    callActive: typeof telemetry.call_active === "boolean" ? telemetry.call_active : null,
    error: telemetry.error,
  });
}
export function startBridgeSupervisor() {
  if (supervisorTimer) return;
  supervisorTimer = setInterval(async () => {
    if (supervisorBusy) return;
    supervisorBusy = true;
    try {
      const state = await fetchBridgeHealth();
      await supervision.recover(state, runtimePolicy().realCallsEnabled, Date.now(), startBridge);
    } finally { supervisorBusy = false; }
  }, 5000);
  supervisorTimer.unref();
}
export async function fetchBridgeTelemetry(): Promise<Record<string, any>> {
  const revision = supervision.revision;
  try {
    const secret = getOrCreateVoiceControlSecret();
    const res = await fetch("http://127.0.0.1:8086/api/v1/status", {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`Control del puente: HTTP ${res.status}`);
    const value = await res.json() as Record<string, any>;
    if (revision !== supervision.revision) throw new Error("Estado anterior a una orden de telefonía; se requiere nueva comprobación");
    if (!value || typeof value.call_active !== "boolean" || typeof value.registered !== "boolean")
      throw new Error("Respuesta de estado del puente inválida");
    supervision.observe({ processRunning: bridgeProcess !== null && !bridgeProcess.killed,
      reachable: true, registered: value.registered, callActive: value.call_active });
    return { ...value, reachable: true };
  } catch (error) {
    return { reachable: false, registered: false, error: error instanceof Error ? error.message : "Fallo de comunicación con el puente" };
  }
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
    bridgeProcess = spawn(process.env.PYTHON_BIN || "python", ["-u", scriptPath], {
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
  supervision.stop();
  if (supervisorTimer) clearInterval(supervisorTimer);
  supervisorTimer = undefined;
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
  supervision.beginCommand();
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
  } catch {
    appendLog("Orden de telefonía sin confirmación; se bloquea el reintento automático.");
    return { success: false, message: "Resultado incierto. Reconciliar con la centralita antes de reintentar." };
  } finally {
    supervision.endCommand();
  }
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
  const result = await sendHttpNetelipCommand({ command: "hangup" });
  if (!result.success) return result;
  for (let i = 0; i < 24; i++) {
    const status = await fetchBridgeTelemetry();
    if (status.call_active === false) return { success: true, message: "Colgado confirmado" };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { success: false, message: "Colgado pendiente de confirmación; conservar la reserva de línea." };
}

export async function transferNetelip(targetPhone?: string): Promise<{ success: boolean; message: string }> {
  return sendHttpNetelipCommand({
    command: "transfer",
    target_phone: targetPhone,
  });
}
