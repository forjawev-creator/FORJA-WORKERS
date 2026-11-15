import { DeferredWork } from "./retry.js";
import { atomicUpdateJson } from "../storage.js";
import fs from "fs";
import path from "path";
import { OutboxEvent } from "./outbox-types.js";

const BASE_OUTBOX_DIR = path.resolve(process.cwd(), "data", "outbox");

export type OutboxProcessResult = boolean | "uncertain";

export interface OutboxConsumerOptions {
  queueName: "crm" | "whatsapp";
  pollIntervalMs?: number;
  maxRetries?: number;
  canProcess?: () => boolean;
  retryBaseMs?: number;
  now?: () => number;
  handler: (event: OutboxEvent) => Promise<OutboxProcessResult>;
}

export class OutboxConsumer {
  private paused = false;
  private ownsLease = false;
  private canProcess: () => boolean;
  private retryBaseMs: number;
  private now: () => number;
  public lastError: string | null = null;
  public get busy(): boolean { return this.isProcessing; }
  public setPaused(value: boolean): void { this.paused = value; }
  private queueName: "crm" | "whatsapp";
  private pollIntervalMs: number;
  private maxRetries: number;
  private handler: (event: OutboxEvent) => Promise<OutboxProcessResult>;
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;
  private pendingDir: string;
  private processingDir: string;
  private completedDir: string;
  private uncertainDir: string;
  private failedDir: string;
  private ledgerPath: string;
  private seenLedger: Set<string> = new Set();

  constructor(options: OutboxConsumerOptions) {
    this.queueName = options.queueName;
    this.canProcess = options.canProcess || (() => true);
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.now = options.now || Date.now;
    this.pollIntervalMs = options.pollIntervalMs || 2500;
    this.maxRetries = options.maxRetries || 3;
    this.handler = options.handler;

    const baseQueueDir = path.join(BASE_OUTBOX_DIR, this.queueName);
    this.pendingDir = path.join(baseQueueDir, "pending");
    this.processingDir = path.join(baseQueueDir, "processing");
    this.completedDir = path.join(baseQueueDir, "completed");
    this.uncertainDir = path.join(baseQueueDir, "uncertain");
    this.failedDir = path.join(baseQueueDir, "failed");
    this.ledgerPath = path.join(baseQueueDir, "sent-ledger.json");

    this.ensureDirs();
    this.loadLedger();
  }

  private ensureDirs(): void {
    const dirs = [this.pendingDir, this.processingDir, this.completedDir, this.uncertainDir, this.failedDir];
    for (const d of dirs) {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
      }
    }
  }

  private loadLedger(): void {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const raw = fs.readFileSync(this.ledgerPath, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.seenLedger = new Set(list);
        }
      }
    } catch (err: any) {
      throw new Error(`No se pudo leer el registro de idempotencia: ${err.message}`);
    }
  }

  private recordInLedger(key: string): void {
    const saved = atomicUpdateJson<string[]>(this.ledgerPath, current => [...new Set([...(current || []), key])]);
    this.seenLedger = new Set(saved);
  }

  public isAlreadyProcessed(idempotencyKey?: string): boolean {
    if (!idempotencyKey) return false;
    return this.seenLedger.has(idempotencyKey);
  }

  /**
   * Recuperación ante caídas previas (Windows/Docker/Crash):
   * Inspecciona `processing/` al iniciar.
   */
  private recoverOrphanedTasks(): void {
    try {
      const orphans = fs.readdirSync(this.processingDir).filter((f) => f.endsWith(".json"));
      if (orphans.length === 0) return;

      console.warn(`[OutboxConsumer:${this.queueName}] ⚠️ Detectados ${orphans.length} eventos huérfanos en processing/`);
      for (const orphan of orphans) {
        const sourcePath = path.join(this.processingDir, orphan);
        if (this.queueName === "whatsapp") {
          // Para WhatsApp, si se interrumpió la ejecución mientras procesaba, el estado es incierto.
          // Nunca se reenvía a ciegas para evitar duplicados.
          const targetPath = path.join(this.uncertainDir, orphan);
          fs.renameSync(sourcePath, targetPath);
          console.warn(`[OutboxConsumer:whatsapp] Evento huérfano ${orphan} movido a UNCERTAIN (sin reenvío ciego).`);
        } else {
          // Para CRM, las operaciones son idempotentes, se puede reencolar a pending
          const targetPath = path.join(this.pendingDir, orphan);
          fs.renameSync(sourcePath, targetPath);
          console.log(`[OutboxConsumer:crm] Evento huérfano ${orphan} devuelto a PENDING.`);
        }
      }
    } catch (err: any) {
      console.error(`[OutboxConsumer:${this.queueName}] Error en recuperación de huérfanos:`, err.message);
    }
  }

  public start(): void {
    if (this.timer) return;
    this.paused = false;
    this.ensureDirs();
    const lease = path.join(path.dirname(this.pendingDir), "consumer.pid");
    if (fs.existsSync(lease)) {
      const pid = Number(fs.readFileSync(lease, "utf8"));
      if (!Number.isInteger(pid) || pid < 1) throw new Error("Bloqueo del consumidor no válido; revisar antes de iniciar");
      try { process.kill(pid, 0); }
      catch (e: any) { if (e.code === "ESRCH") fs.unlinkSync(lease); else throw e; }
    }
    fs.writeFileSync(lease, String(process.pid), { flag: "wx" });
    this.ownsLease = true;
    this.recoverOrphanedTasks();
    console.log(`[OutboxConsumer:${this.queueName}] 🚀 Consumidor iniciado (polling cada ${this.pollIntervalMs} ms)`);

    this.processNextBatch().catch(() => {});
    this.timer = setInterval(() => {
      this.processNextBatch().catch(() => {});
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.paused = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.isProcessing) this.releaseLease();
    console.log(`[OutboxConsumer:${this.queueName}] 🛑 Consumidor detenido`);
  }

  private releaseLease(): void {
    if (!this.ownsLease) return;
    fs.unlinkSync(path.join(path.dirname(this.pendingDir), "consumer.pid"));
    this.ownsLease = false;
  }

  public async processNextBatch(): Promise<number> {
    if (this.isProcessing || this.paused || !this.canProcess()) return 0;
    this.isProcessing = true;
    let count = 0;

    try {
      this.ensureDirs();
      const files = fs
        .readdirSync(this.pendingDir)
        .filter((f) => f.endsWith(".json"))
        .sort(); // FIFO por timestamp

      for (const file of files) {
        if (this.paused || !this.canProcess()) break;
        const metadataPath = path.join(this.processingDir, `${file}.meta`);
        let metadata = { retries: 0, deferrals: 0, nextAttemptAt: 0, error: "" };
        if (fs.existsSync(metadataPath)) {
          const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
          metadata = typeof parsed === "number" ? { ...metadata, retries: parsed } : { ...metadata, ...parsed };
        }
        if (metadata.nextAttemptAt > this.now()) continue;
        const pendingPath = path.join(this.pendingDir, file);
        const processingPath = path.join(this.processingDir, file);

        // Reclamación atómica
        try {
          fs.renameSync(pendingPath, processingPath);
        } catch {
          // Otro hilo o worker lo reclamó
          continue;
        }

        let event: OutboxEvent;
        try {
          const raw = fs.readFileSync(processingPath, "utf-8");
          event = JSON.parse(raw);
        } catch (err: any) {
          console.error(`[OutboxConsumer:${this.queueName}] JSON corrupto en ${file}:`, err.message);
          const failedPath = path.join(this.failedDir, file);
          try {
            fs.renameSync(processingPath, failedPath);
          } catch {}
          continue;
        }

        this.loadLedger();
        // Comprobar idempotencia si tiene clave
        if (event.idempotencyKey && this.seenLedger.has(event.idempotencyKey)) {
          console.log(`[OutboxConsumer:${this.queueName}] ⏭️ Ignorando evento duplicado por clave de idempotencia: ${event.idempotencyKey}`);
          const completedPath = path.join(this.completedDir, file);
          try {
            fs.renameSync(processingPath, completedPath);
          } catch {
            fs.unlinkSync(processingPath);
          }
          continue;
        }

        try {
          console.log(`[OutboxConsumer:${this.queueName}] ⚙️ Procesando ${event.type} (${event.eventId})...`);
          const result = await this.handler(event);

          if (result === true) {
            this.lastError = null;
            if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
            // Éxito confirmado
            if (event.idempotencyKey) {
              this.recordInLedger(event.idempotencyKey);
            }
            const completedPath = path.join(this.completedDir, file);
            try {
              if (fs.existsSync(completedPath)) fs.unlinkSync(completedPath);
              fs.renameSync(processingPath, completedPath);
            } catch {
              fs.unlinkSync(processingPath);
            }
            console.log(`[OutboxConsumer:${this.queueName}] ✅ Evento ${event.eventId} completado.`);
            count++;
          } else if (result === "uncertain") {
            // Entrega incierta (ej. socket cerrado tras enviar sin ACK)
            const uncertainPath = path.join(this.uncertainDir, file);
            try {
              if (fs.existsSync(uncertainPath)) fs.unlinkSync(uncertainPath);
              fs.renameSync(processingPath, uncertainPath);
            } catch {
              fs.unlinkSync(processingPath);
            }
            console.warn(`[OutboxConsumer:${this.queueName}] ⚠️ Evento ${event.eventId} marcado como UNCERTAIN (no se reintentará a ciegas).`);
            count++;
          } else {
            throw new Error("El manejador devolvió false sin excepción");
          }
        } catch (err: any) {
          console.error(`[OutboxConsumer:${this.queueName}] ❌ Error procesando ${event.eventId}:`, err.message);
          this.lastError = err.message || "Error al procesar el trabajo";
          if (err instanceof DeferredWork) metadata.deferrals++;
          else metadata.retries++;
          metadata.error = this.lastError!;
          if (!(err instanceof DeferredWork) && metadata.retries >= this.maxRetries) {
            fs.renameSync(processingPath, path.join(this.failedDir, file));
            fs.writeFileSync(path.join(this.failedDir, `${file}.meta`), JSON.stringify(metadata));
            if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
          } else {
            const delay = err instanceof DeferredWork
              ? Math.min(3_600_000, err.retryAfterMs * 2 ** Math.min(metadata.deferrals - 1, 6))
              : Math.min(300_000, this.retryBaseMs * 2 ** (metadata.retries - 1));
            metadata.nextAttemptAt = this.now() + delay;
            fs.writeFileSync(metadataPath, JSON.stringify(metadata));
            fs.renameSync(processingPath, pendingPath);
          }
        }
      }
    } catch (err: any) {
      console.error(`[OutboxConsumer:${this.queueName}] Error en bucle de consumo:`, err.message);
    } finally {
      this.isProcessing = false;
      if (this.paused && !this.timer) this.releaseLease();
    }

    return count;
  }
}
