import "dotenv/config";
import { PilotShutdown } from "./pilot/shutdown.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type net from "node:net";
import { requireControl, handleControlLogin, controlToken } from "./control-auth.js";
import { runtimePolicy } from "./runtime-policy.js";
import { loadConfig } from "./storage.js";
import { startVoiceBridge } from "./voice-server.js";
import { startBridge, stopBridge, startBridgeSupervisor, fetchBridgeHealth, fetchBridgeTelemetry, sendHttpNetelipCommand, hangupNetelip } from "./bridge-manager.js";
import { appEvents } from "./events.js";
import { GeminiLiveEngine } from "./engines/gemini-live-engine.js";
import { ProbeController, ProbeLedger, defaultProbePolicy } from "./pilot/probe-controller.js";
import type { GeminiRateCard } from "./pilot/gemini-usage.js";
import { PilotJournal } from "./pilot/journal.js";

const dayMadrid = (date: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date(date));
export function pilotDestination(): string {
  const values = (process.env.CALL_ALLOWED_NUMBERS || "").split(",").map(s => s.trim().replace(/^\+/, "")).filter(Boolean);
  if (process.env.CALLS_PILOT !== "1" || values.length !== 1 || !/^[1-9]\d{7,14}$/.test(values[0])) throw new Error("El piloto requiere CALLS_PILOT=1 y un único destino autorizado");
  return values[0];
}
function loadRates(): GeminiRateCard {
  const filename = path.resolve("data", "gemini-probe-rates.json");
  if (!fs.existsSync(filename)) throw new Error("Configura una tarifa Gemini versionada antes de habilitar pruebas pagadas");
  return JSON.parse(fs.readFileSync(filename, "utf8")) as GeminiRateCard;
}
export function createPilotServer() {
  const phone = pilotDestination();
  const journal = new PilotJournal(path.resolve("data", "pilot-journal.json"));
  journal.update(attempts => { for (const a of attempts) if (["requested", "connected"].includes(a.state)) a.state = "uncertain_after_restart"; });
  controlToken();
  let actionBusy = false, storageError = "", stopping = false;
  const recent: Array<{ type: string; text: string; at: string }> = [];
  function log(type: string, text: string) { recent.push({ type, text, at: new Date().toISOString() }); if (recent.length > 60) recent.shift(); }
  const ledger = new ProbeLedger(path.resolve("data", "pilot-probes.json"), defaultProbePolicy);
  const probes = new ProbeController(ledger, {
    enabled: () => !stopping && runtimePolicy().realCallsEnabled,
    canProbe: async () => { const bridge = await fetchBridgeTelemetry(); return !actionBusy && bridge.call_active === false; },
    loadConfig: () => ({ config: loadConfig(), rates: loadRates() }),
    fingerprint: config => crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    engine: ({ config, rates }, audio, fail, usage) => {
      if (rates.model !== config.geminiCommercialModel) throw new Error("La tarifa no corresponde al modelo Gemini configurado");
      const engine = new GeminiLiveEngine({ ...config, apiKey: config.togetherApiKey, persona: "kira", sampleRate: 16000, audioCodec: "pcma", callMaxDurationSeconds: 20, handoffEnabled: false }, {
        onAudio: value => audio(value.byteLength), onAudioRaw: value => audio(value.length), onError: fail,
        onHangupRequested: () => fail(new Error("La conexión de prueba se cerró")), onState() {}, onRoleChanged() {}, onHandoffState() {}, onTranscript() {}, onTurnStart() {}, onTurnEnd() {}, onFlush() {}, onUsageUpdate() {},
      });
      engine.configureUsage(usage, rates);
      return {
        start: () => engine.start("pilot_probe_" + crypto.randomUUID(), {} as net.Socket, { callDirection: "outbound", companyName: "Prueba de sonido", doubtsResolved: [], currentStage: 1, pendingQuestion: "CONFIRM_BUSINESS", businessConfirmed: false, interestShown: false, whatsappAuthorized: false, phoneConfirmed: false, outcomeStatus: "EN_CURSO" }),
        greet: () => engine.requestInitialGreeting(), stop: () => engine.stopAndConfirm("pilot_probe_end"),
      };
    },
  });
  const onEvent = (event: { type: string; sessionId?: string; [key: string]: unknown }) => {
    if (event.type === "provider_error") { probes.invalidate("Error del proveedor; vuelve a comprobar la voz"); log("error", "Error del proveedor de voz"); }
    if (!["state", "call_end"].includes(event.type)) return;
    try {
      journal.update(attempts => {
        const attempt = attempts.find(a => a.id === event.sessionId); if (!attempt) return;
        if (event.type === "state" && event.state === "speaking") attempt.state = "connected";
        if (event.type === "call_end") { attempt.state = "finished"; attempt.endedAt = new Date().toISOString(); attempt.result = String(event.reason || event.outcome || "TERMINADO"); }
      });
    } catch { storageError = "No se pudo guardar el estado de la llamada; nuevas llamadas bloqueadas"; }
  };
  appEvents.on("ui-event", onEvent);
  async function status() {
    const bridge = await fetchBridgeTelemetry(), health = await fetchBridgeHealth();
    const attempts = journal.read(), today = attempts.filter(a => dayMadrid(a.createdAt) === dayMadrid(new Date().toISOString()));
    const provider = probes.status(), uncertain = attempts.some(a => a.state.startsWith("uncertain"));
    return { stopping, ready: !stopping && runtimePolicy().realCallsEnabled && health.processRunning && health.reachable && bridge.registered === true && bridge.call_active === false && provider.ready && !actionBusy && !probes.busy && !storageError && !uncertain && today.length < 3,
      phone, maxSeconds: 120, attemptsToday: today.length, maxAttempts: 3, registered: bridge.registered === true, active: bridge.call_active === true, ending: bridge.call_ending === true, established: bridge.established === true,
      packetsSent: bridge.rtp_packets_sent || 0, packetsReceived: bridge.rtp_packets_received || 0, provider, health, storageError, uncertain, attempts: attempts.slice(-10), recent, busy: actionBusy || probes.busy,
      controlOnly: !runtimePolicy().realCallsEnabled, whatsappEnabled: false, campaignsEnabled: false, probeAttemptsToday: ledger.read().filter(r => r.day === dayMadrid(new Date().toISOString())).length, probePolicy: defaultProbePolicy };
  }
  function respond(res: http.ServerResponse, code: number, value: unknown) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value)); }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers["sec-fetch-site"] === "cross-site") return respond(res, 403, { error: "Acceso privado requerido" });
      if (req.method === "GET" && req.url === "/healthz") {
        const health = await fetchBridgeHealth();
        const ok = !runtimePolicy().realCallsEnabled || (health.processRunning && health.reachable);
        return respond(res, ok ? 200 : 503, { process: "running", mode: runtimePolicy().realCallsEnabled ? "enabled" : "control_only", bridge: ok ? "available_or_disabled" : "unavailable" });
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'", "X-Frame-Options": "DENY" }); return res.end(fs.readFileSync(path.resolve("public", "pilot.html")));
      }
      if (req.url === "/api/login") return await handleControlLogin(req, res);
      if (!requireControl(req, res)) return;
      if (req.method === "GET" && req.url === "/api/status") return respond(res, 200, await status());
      if (req.method !== "POST" || req.headers["x-pilot-action"] !== "1" || (req.headers.origin && req.headers.origin !== "http://" + host)) return respond(res, 403, { error: "Acción no autorizada" });
      if (req.url === "/api/hangup") { const result = await hangupNetelip(); return respond(res, result.success ? 200 : 409, result); }
      if (req.url === "/api/probe") return respond(res, 200, await probes.run());
      if (req.url !== "/api/call") return respond(res, 404, { error: "Operación no disponible" });
      if (actionBusy) return respond(res, 409, { error: "Ya hay una orden en curso" });
      const current = await status();
      if (stopping || !current.ready || actionBusy || probes.busy) return respond(res, 409, { error: "El piloto no está listo; revisa el estado" });
      actionBusy = true;
      const attemptId = "pilot_" + crypto.randomUUID();
      try {
        journal.update(attempts => {
          const today = dayMadrid(new Date().toISOString());
          if (attempts.some(a => a.state !== "finished") || attempts.filter(a => dayMadrid(a.createdAt) === today).length >= 3) throw new Error("Intento activo, incierto o cupo agotado");
          attempts.push({ id: attemptId, createdAt: new Date().toISOString(), state: "requested" });
        });
        appEvents.broadcast({ type: "lead_call_start", callId: attemptId, sessionId: attemptId, lead: { telefono: phone, empresa_nombre: "Prueba autorizada" } });
        const result = await sendHttpNetelipCommand({ command: "dial", call_id: attemptId, phone, company: "Prueba autorizada" });
        if (!result.success) journal.update(attempts => { const a = attempts.find(a => a.id === attemptId); if (a) a.state = "uncertain"; });
        return respond(res, result.success ? 202 : 409, result);
      } finally { actionBusy = false; }
    } catch (error) { log("error", error instanceof Error ? error.message : "Error del piloto"); return respond(res, 500, { error: error instanceof Error ? error.message : "Error del piloto" }); }
  });
  server.on("close", () => appEvents.off("ui-event", onEvent));
  return { server, probes, status,
    beginShutdown() { stopping = true; probes.invalidate("Cierre solicitado; llamadas bloqueadas"); },
    markUncertain() { journal.update(rows => { for (const row of rows) if (row.state !== "finished") row.state = "uncertain"; }); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const pilot = createPilotServer();
  const { server } = pilot;
  const audio = startVoiceBridge();
  server.listen(Number(process.env.WEB_PORT || 3012), process.env.PILOT_BIND_HOST || "127.0.0.1");
  if (runtimePolicy().realCallsEnabled) { startBridge(); startBridgeSupervisor(); }
  const shutdown = new PilotShutdown({
    enabled: () => runtimePolicy().realCallsEnabled,
    begin: () => pilot.beginShutdown(), markUncertain: () => pilot.markUncertain(),
    hangup: () => hangupNetelip(),
    idle: async () => { const health = await fetchBridgeHealth(); return health.processRunning && health.reachable && health.callActive === false; },
    close: () => { stopBridge(); audio.close(); server.close(); },
  });
  process.on("SIGTERM", () => void shutdown.run()); process.on("SIGINT", () => void shutdown.run());
}
