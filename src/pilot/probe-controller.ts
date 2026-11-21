import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface UsageEstimate { inputTokens: number; outputTokens: number; totalTokens: number; estimatedMicroUsd: number | null; tariffVersion: string | null; observations?: unknown[]; accountingComplete?: boolean; actualMicroUsd?: number | null }
export interface ProbeRecord { id: string; at: number; day: string; reservedMicroUsd: number; state: "reserved" | "finished" | "failed"; usage?: UsageEstimate }
export interface ProbePolicy { dailyAttempts: number; dailyMicroUsd: number; reservationMicroUsd: number; cooldownMs: number; ttlMs: number; timeoutMs: number }
export const defaultProbePolicy: ProbePolicy = { dailyAttempts: 3, dailyMicroUsd: 300000, reservationMicroUsd: 100000, cooldownMs: 60000, ttlMs: 300000, timeoutMs: 15000 };
const madridDay = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date(at));
export class ProbeLedger {
  constructor(readonly file: string, readonly policy: ProbePolicy = defaultProbePolicy) {
    for (const value of Object.values(policy)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Política de pruebas inválida");
    if (policy.dailyAttempts > 3 || policy.reservationMicroUsd > policy.dailyMicroUsd) throw new Error("Política de pruebas fuera del límite del piloto");
  }
  read(): ProbeRecord[] {
    if (!fs.existsSync(this.file)) return [];
    const rows: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r.id !== "string" || !Number.isFinite(r.at) || typeof r.day !== "string" || !Number.isSafeInteger(r.reservedMicroUsd) || r.reservedMicroUsd <= 0 || !["reserved", "finished", "failed"].includes(r.state))) throw new Error("Historial de pruebas inválido; operación bloqueada");
    return rows;
  }
  private update(action: (rows: ProbeRecord[]) => void): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = this.file + ".lock";
    let fd: number;
    try { fd = fs.openSync(lock, "wx", 0o600); } catch { throw new Error("Presupuesto ocupado; si hubo un cierre abrupto, revisar el bloqueo antes de continuar"); }
    const tmp = this.file + ".tmp." + crypto.randomUUID();
    try {
      const rows = this.read(); action(rows);
      const out = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(out, JSON.stringify(rows)); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      fs.renameSync(tmp, this.file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  reserve(at: number): string {
    const id = crypto.randomUUID();
    this.update(rows => {
      if (rows.some(r => r.state === "reserved")) throw new Error("Prueba en curso o resultado incierto pendiente de revisión");
      if (rows.some(r => at < r.at || at - r.at < this.policy.cooldownMs)) throw new Error("Espera antes de repetir la prueba");
      const today = rows.filter(r => r.day === madridDay(at));
      if (today.length >= this.policy.dailyAttempts || today.reduce((sum, r) => sum + Math.max(r.reservedMicroUsd, r.usage?.estimatedMicroUsd ?? 0), 0) + this.policy.reservationMicroUsd > this.policy.dailyMicroUsd) throw new Error("Cupo o presupuesto diario de pruebas agotado");
      rows.push({ id, at, day: madridDay(at), reservedMicroUsd: this.policy.reservationMicroUsd, state: "reserved" });
    });
    return id;
  }
  finish(id: string, success: boolean, usage?: UsageEstimate): void {
    this.update(rows => { const row = rows.find(r => r.id === id); if (!row || row.state !== "reserved") throw new Error("Reserva no disponible"); row.state = success ? "finished" : "failed"; if (usage) row.usage = usage; });
    // No release based on an estimate: reserved money remains charged until reconciliation.
  }
}

export interface ProbeEngine { start(): Promise<void>; greet(): Promise<void>; stop(): Promise<void> }
export interface ProbeDependencies<C> {
  enabled(): boolean; canProbe(): Promise<boolean>; loadConfig(): C; fingerprint(config: C): string;
  engine(config: C, audio: (bytes: number) => void, error: (error: Error) => void, usage: (value: UsageEstimate) => void): ProbeEngine;
  now?(): number;
}
export class ProbeController<C> {
  busy = false;
  private checkedAt = 0;
  private verifiedFingerprint = "";
  private healthy = false;
  message = "Pendiente de comprobar la voz";
  cleanupError = "";
  constructor(readonly ledger: ProbeLedger, private readonly deps: ProbeDependencies<C>) {}
  invalidate(message: string): void { this.healthy = false; this.message = message; }
  status() {
    let valid = false;
    try { valid = this.healthy && this.deps.enabled() && this.now() >= this.checkedAt && this.now() - this.checkedAt < this.ledger.policy.ttlMs && this.verifiedFingerprint === this.deps.fingerprint(this.deps.loadConfig()); }
    catch { this.invalidate("No se puede leer la configuración de voz"); }
    return { ready: valid, checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : "", expiresAt: this.checkedAt ? new Date(this.checkedAt + this.ledger.policy.ttlMs).toISOString() : "", message: valid ? this.message : this.healthy ? "Comprobación de voz caducada o configuración modificada" : this.message, busy: this.busy, cleanupError: this.cleanupError };
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  async run() {
    if (this.busy) throw new Error("Ya hay una prueba en curso");
    this.busy = true;
    let engine: ProbeEngine | undefined, reservation: string | undefined, usage: UsageEstimate | undefined;
    let failure: unknown, succeeded = false, timer: ReturnType<typeof setTimeout> | undefined;
    let audioBytes = 0, accepting = true;
    let terminalFailure: Error | undefined;
    this.cleanupError = "";
    this.invalidate("Comprobando voz");
    try {
      if (!this.deps.enabled()) throw new Error("Pruebas de proveedor bloqueadas por la política de comunicaciones");
      if (!(await this.deps.canProbe())) throw new Error("La línea está ocupada o su estado es desconocido");
      const config = this.deps.loadConfig();
      const fingerprint = this.deps.fingerprint(config);
      reservation = this.ledger.reserve(this.now());
      let done!: () => void, reject!: (e: Error) => void;
      const audio = new Promise<void>((resolve, fail) => { done = resolve; reject = fail; });
      void audio.catch(() => {});
      const failProbe = (error: Error) => { terminalFailure ??= error; reject(error); };
      engine = this.deps.engine(config, bytes => { if (!accepting) return; audioBytes += bytes; if (audioBytes > 320) done(); }, failProbe, value => { usage = value; if (value.estimatedMicroUsd !== null && value.estimatedMicroUsd >= this.ledger.policy.reservationMicroUsd) failProbe(new Error("Límite estimado de coste de la prueba alcanzado")); });
      const timeout = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error("Tiempo de prueba agotado")), this.ledger.policy.timeoutMs); });
      await Promise.race([(async () => { await engine!.start(); if (!accepting) return; await engine!.greet(); await audio; })(), timeout]);
      if (terminalFailure) throw terminalFailure;
      this.checkedAt = this.now(); this.verifiedFingerprint = fingerprint; succeeded = true;
    } catch (error) { failure = error; this.invalidate(error instanceof Error ? error.message : "Error comprobando voz"); }
    finally {
      accepting = false;
      if (timer) clearTimeout(timer);
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try { if (engine) await Promise.race([engine.stop(), new Promise<never>((_, reject) => { stopTimer = setTimeout(() => reject(new Error("Cierre del proveedor sin confirmar")), 2000); })]); }
      catch (error) { this.cleanupError = error instanceof Error ? error.message : "Error al cerrar proveedor"; failure ??= error; succeeded = false; }
      finally { if (stopTimer) clearTimeout(stopTimer); }
      if (terminalFailure) { failure ??= terminalFailure; succeeded = false; this.invalidate(terminalFailure.message); }
      try { if (reservation && !this.cleanupError) this.ledger.finish(reservation, succeeded, usage); }
      catch (error) { failure ??= error; succeeded = false; this.cleanupError = "No se pudo confirmar el consumo; revisar la reserva"; }
      this.busy = false;
    }
    if (failure) { this.healthy = false; throw failure; }
    this.healthy = succeeded; this.message = "Voz comprobada: el proveedor devolvió audio";
    return { ...this.status(), audioBytes };
  }
}
