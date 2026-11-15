import { dataEqual, mergeChanges, reconcileInPlace } from "./merge-storage.js";
import fs from "fs";
import path from "path";
import {
  CrmDatabase,
  Proyecto,
  Campania,
  Lead,
  PropuestaGenerada,
  Interaccion,
  LineaTelefonica,
  RobinsonEntry,
  CrmSettings,
} from "./types.js";
import { safeReadJson, atomicUpdateJson, StorageCorruptedError } from "../storage.js";

const DATA_DIR = path.resolve(process.cwd(), "data", "crm");
const DB_FILE = path.join(DATA_DIR, "crm.json");

export function getMadridDateString(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

export function isValidCrmData(data: any): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (!Array.isArray(data.leads)) return false;
  if (!Array.isArray(data.lineas)) return false;
  if (!Array.isArray(data.interacciones)) return false;
  if (!Array.isArray(data.campanias)) return false;
  if (!Array.isArray(data.proyectos)) return false;
  return true;
}

function getDefaultSettings(): CrmSettings {
  return {
    horario_comercial_inicio: "09:30",
    horario_comercial_fin_manana: "13:30",
    horario_comercial_inicio_tarde: "16:00",
    horario_comercial_fin_tarde: "19:30",
    enforce_horario: false, // Por defecto flexible; se activa en producción
    max_llamadas_por_linea: 30,
    dias_laborables: [1, 2, 3, 4, 5],
    whatsapp_mensajes_hoy: 0,
    whatsapp_fecha_contador: getMadridDateString(),
  };
}

function createDefaultDatabase(): CrmDatabase {
  const today = getMadridDateString();
  const now = new Date().toISOString();

  const defaultProyecto: Proyecto = {
    id: "forja-web",
    nombre: "Forja Web V4",
    descripcion: "Propuesta de modernización y muestra web instantánea para negocios locales",
    webhook_generador: "http://localhost:3001/api/interna/v1/muestras",
    tipo_gancho: "muestra_web",
    script_llamada:
      "Hola, buenos días. Te llamo rápido de parte de Forja Web porque hemos preparado un boceto interactivo gratuito de la web de tu negocio. ¿Te interesaría que te lo enviemos por WhatsApp para que lo veas sin ningún compromiso?",
    plantillas_whatsapp: {
      default:
        "¡Hola {{nombre}}! Como acordamos en la llamada, aquí tienes la muestra web interactiva de {{oficio}} que preparamos para ti: {{enlace}} . Échale un vistazo cuando puedas. ¡Un saludo!",
      recordatorio:
        "Hola {{nombre}}, ¿has podido ver el boceto de la web en {{enlace}}? Cualquier duda estamos a tu disposición.",
    },
    activo: true,
    created_at: now,
    updated_at: now,
  };

  const defaultCampania: Campania = {
    id: "campania-madrid-fontaneria",
    proyecto_id: "forja-web",
    nombre: "Fontanería & Climatización Madrid",
    estado: "activa",
    criterios_filtro: {
      ciudad: "Madrid",
      categoria: "Fontanero",
      solo_sin_web: false,
    },
    total_leads: 0,
    created_at: now,
    updated_at: now,
  };

  const defaultLineas: LineaTelefonica[] = [
    {
      id: "linea-1",
      nombre: "Línea SIP Primaria (Netelip)",
      numero: "+34910000001",
      limite_diario: 30,
      llamadas_hoy: 0,
      fecha_contador: today,
      activa: true,
      ultima_llamada_at: null,
    },
    {
      id: "linea-2",
      nombre: "Línea Móvil Outbound 1",
      numero: "+34600000001",
      limite_diario: 30,
      llamadas_hoy: 0,
      fecha_contador: today,
      activa: true,
      ultima_llamada_at: null,
    },
    {
      id: "linea-3",
      nombre: "Línea Móvil Outbound 2",
      numero: "+34600000002",
      limite_diario: 30,
      llamadas_hoy: 0,
      fecha_contador: today,
      activa: true,
      ultima_llamada_at: null,
    },
  ];

  return {
    proyectos: [defaultProyecto],
    campanias: [defaultCampania],
    leads: [],
    propuestas: [],
    interacciones: [],
    lineas: defaultLineas,
    robinson: [],
    settings: getDefaultSettings(),
  };
}

export class CrmStorage {
  private baseline: CrmDatabase | null = null;
  private inTransaction = false;
  private db: CrmDatabase | null = null;
  private lineRoundRobinIndex = 0;

  constructor() {
    this.ensureStorage();
  }

  private ensureStorage(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      const initial = createDefaultDatabase();
      this.writeDb(initial);
      this.db = this.readCurrent();
      this.baseline = structuredClone(this.db);
    } else {
      this.load();
    }
  }

  public load(): CrmDatabase {
    if (!fs.existsSync(DB_FILE)) {
      this.db = createDefaultDatabase();
      this.writeDb(this.db);
      return this.db;
    }

    try {
      const { data } = safeReadJson<CrmDatabase>(DB_FILE, isValidCrmData);
      if (!data) {
        throw new StorageCorruptedError(DB_FILE, new Error("Datos de CRM vacíos o no válidos"));
      }
      this.db = reconcileInPlace(this.db, data) as CrmDatabase;
      this.baseline = structuredClone(data);

      // Garantizar que todos los campos requeridos existen
      if (!this.db.proyectos) this.db.proyectos = [];
      if (!this.db.campanias) this.db.campanias = [];
      if (!this.db.leads) this.db.leads = [];
      if (!this.db.propuestas) this.db.propuestas = [];
      if (!this.db.interacciones) this.db.interacciones = [];
      if (!this.db.lineas || this.db.lineas.length === 0) {
        this.db.lineas = createDefaultDatabase().lineas;
      }
      if (!this.db.robinson) this.db.robinson = [];
      if (!this.db.settings) this.db.settings = getDefaultSettings();
      if (this.db.settings.whatsapp_mensajes_hoy === undefined) {
        this.db.settings.whatsapp_mensajes_hoy = 0;
        this.db.settings.whatsapp_fecha_contador = getMadridDateString();
      }

      // Verificar y resetear contadores diarios si cambió de día (Madrid)
      this.checkAndResetDailyQuotas();

      return this.db;
    } catch (err: any) {
      console.error(`[CrmStorage CRÍTICO] Error al cargar ${DB_FILE}: ${err.message}`);
      throw err;
    }
  }

  private readCurrent(): CrmDatabase {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!isValidCrmData(data)) throw new Error("CRM no válido; edición bloqueada");
    return data;
  }

  public save(): void {
    if (!this.db || this.inTransaction) return;
    const local = structuredClone(this.db);
    const baseline = this.baseline;
    try {
      const saved = atomicUpdateJson<CrmDatabase>(DB_FILE, current => {
        if (!current || !isValidCrmData(current)) throw new Error("CRM no disponible; edición bloqueada");
        return mergeChanges(baseline, local, current);
      });
      this.db = reconcileInPlace(this.db, saved);
      this.baseline = structuredClone(saved);
    } catch (error) {
      this.db = reconcileInPlace(this.db, this.readCurrent());
      this.baseline = structuredClone(this.db);
      throw error;
    }
  }

  private writeDb(data: CrmDatabase): void {
    atomicUpdateJson<CrmDatabase>(DB_FILE, current => current ?? data);
  }

  public getDb(): CrmDatabase {
    if (!this.db) return this.load();
    if (!this.inTransaction && dataEqual(this.db, this.baseline)) {
      const current = this.readCurrent();
      this.db = reconcileInPlace(this.db, current);
      this.baseline = structuredClone(current);
    }
    return this.db!;
  }

  /** Synchronous only: the lock covers quota/reservation decisions as well as their commit. */
  public transaction<T>(action: (db: CrmDatabase) => T): T {
    if (this.inTransaction) return action(this.db!);
    if (!dataEqual(this.db, this.baseline)) this.save();
    let result: T;
    try {
      const saved = atomicUpdateJson<CrmDatabase>(DB_FILE, current => {
        if (!current || !isValidCrmData(current)) throw new Error("CRM no disponible; edición bloqueada");
        this.db = reconcileInPlace(this.db, current);
        this.inTransaction = true;
        try {
          result = action(this.db!);
          if (result && typeof (result as any).then === "function") throw new Error("Transacción asíncrona no permitida");
          return this.db!;
        } finally { this.inTransaction = false; }
      });
      this.baseline = structuredClone(saved);
      return result!;
    } catch (error) {
      this.db = reconcileInPlace(this.db, this.readCurrent());
      this.baseline = structuredClone(this.db);
      throw error;
    }
  }

  public checkAndResetDailyQuotas(): boolean {
    this.getDb();
    if (!this.db) return false;
    const today = getMadridDateString();
    let modified = false;

    for (const linea of this.db.lineas) {
      if (linea.fecha_contador !== today) {
        linea.llamadas_hoy = 0;
        linea.fecha_contador = today;
        linea.en_uso = false;
        modified = true;
      }
    }

    if (this.db.settings.whatsapp_fecha_contador !== today) {
      this.db.settings.whatsapp_mensajes_hoy = 0;
      this.db.settings.whatsapp_fecha_contador = today;
      modified = true;
    }

    if (modified) {
      this.save();
    }
    return modified;
  }

  public getDailyWhatsAppCount(): number {
    this.checkAndResetDailyQuotas();
    return this.db?.settings.whatsapp_mensajes_hoy || 0;
  }

  public incrementDailyWhatsAppCount(): number {
    return this.transaction(db => {
      this.checkAndResetDailyQuotas();
      return db.settings.whatsapp_mensajes_hoy = (db.settings.whatsapp_mensajes_hoy || 0) + 1;
    });
  }

  public getNextAvailableLine(): LineaTelefonica | null {
    if (!this.db) this.load();
    this.checkAndResetDailyQuotas();

    const activas = this.db!.lineas.filter((l) => l.activa && !l.en_uso && l.llamadas_hoy < l.limite_diario);
    if (activas.length === 0) {
      return null;
    }

    // Round-robin selection
    const index = this.lineRoundRobinIndex % activas.length;
    this.lineRoundRobinIndex = (this.lineRoundRobinIndex + 1) % activas.length;
    return activas[index];
  }

  public setLineInUse(lineaId: string, inUse: boolean): void {
    if (!this.db) this.load();
    const linea = this.db!.lineas.find((l) => l.id === lineaId);
    if (linea) {
      linea.en_uso = inUse;
      this.save();
    }
  }

  public incrementLineCalls(lineaId: string): void {
    if (!this.db) this.load();
    const linea = this.db!.lineas.find((l) => l.id === lineaId);
    if (linea) {
      this.checkAndResetDailyQuotas();
      linea.llamadas_hoy += 1;
      linea.ultima_llamada_at = new Date().toISOString();
      linea.en_uso = true;
      this.save();
    }
  }

  public isPhoneInRobinson(phoneE164: string): boolean {
    if (!this.db) this.load();
    return this.db!.robinson.some((r) => r.telefono === phoneE164);
  }

  public addToRobinson(telefonoE164: string, motivo: string, origenLeadId?: string | null): RobinsonEntry {
    if (!this.db) this.load();
    const existing = this.db!.robinson.find((r) => r.telefono === telefonoE164);
    if (existing) {
      existing.motivo = motivo;
      this.save();
      return existing;
    }

    const entry: RobinsonEntry = {
      telefono: telefonoE164,
      motivo,
      origen_lead_id: origenLeadId || null,
      created_at: new Date().toISOString(),
    };
    this.db!.robinson.push(entry);

    // Actualizar leads existentes con ese teléfono a 'no_contactar'
    for (const lead of this.db!.leads) {
      if (lead.telefono === telefonoE164) {
        lead.estado = "no_contactar";
        lead.notas = lead.notas ? `${lead.notas}\n[Robinson] ${motivo}` : `[Robinson] ${motivo}`;
        lead.updated_at = new Date().toISOString();
      }
    }

    this.save();
    return entry;
  }
}

export const crmStorage = new CrmStorage();
