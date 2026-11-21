import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export interface PilotAttempt { id: string; createdAt: string; state: "requested" | "connected" | "finished" | "uncertain" | "uncertain_after_restart"; endedAt?: string; result?: string }
export class PilotJournal {
  constructor(readonly file: string) {}
  read(): PilotAttempt[] {
    if (!fs.existsSync(this.file)) return [];
    const data: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Array.isArray(data) || data.some(r => !r || typeof r.id !== "string" || !Number.isFinite(Date.parse(r.createdAt)) || !["requested", "connected", "finished", "uncertain", "uncertain_after_restart"].includes(r.state))) throw new Error("Historial de llamadas inválido");
    return data;
  }
  update(action: (attempts: PilotAttempt[]) => void) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = fs.openSync(this.file + ".lock", "wx", 0o600);
    const temp = this.file + ".tmp." + crypto.randomUUID();
    try {
      const attempts = this.read(); action(attempts);
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(attempts)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); fs.closeSync(lock); fs.unlinkSync(this.file + ".lock"); }
  }
}
