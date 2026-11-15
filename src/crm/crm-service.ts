import { proposalMessage } from "../whatsapp/proposal-message.js";
import crypto from "crypto";
import { crmStorage } from "./crm-storage.js";
import {
  Lead,
  LeadEstado,
  Proyecto,
  Campania,
  PropuestaGenerada,
  Interaccion,
  LineaTelefonica,
  ImportLeadItem,
  ImportResult,
  CallQueueItem,
  CallOutcomePayload,
  WhatsAppQueueItem,
  WhatsAppOutcomePayload,
  CrmSettings,
} from "./types.js";
import { isExplicitWhatsAppAuthorization } from "../pipeline.js";
import { appEvents } from "../events.js";
import { loadCalls } from "../storage.js";
import { getPublicBaseUrl } from "../web-server.js";

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function normalizeSpanishPhone(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  // Limpiar espacios, guiones, paréntesis y puntos
  let cleaned = raw.replace(/[\s\-\(\)\.]/g, "").trim();

  // Reemplazar 0034 por +34
  if (cleaned.startsWith("0034")) {
    cleaned = "+34" + cleaned.substring(4);
  }

  // Si no empieza por +, comprobar si es número nacional español de 9 dígitos (empieza por 6, 7, 8 o 9)
  if (!cleaned.startsWith("+")) {
    if (/^[6789]\d{8}$/.test(cleaned)) {
      cleaned = "+34" + cleaned;
    } else {
      // Podría ser número local con prefijo provincial
      return null;
    }
  }

  // Validar formato E.164 español: +34 seguido de 9 dígitos
  if (/^\+34[6789]\d{8}$/.test(cleaned)) {
    return cleaned;
  }

  // Soporte para otros números internacionales estándar (+ y 8 a 15 dígitos)
  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

export function normalizeSpokenSpanishDigits(text: string): string {
  if (!text || typeof text !== "string") return "";
  let s = text.toLowerCase();

  // Quitar puntos o guiones que Whisper inserta dentro de un mismo bloque numérico (ej. "6.48" -> "648")
  s = s.replace(/(\d)[\.\-](\d)/g, "$1$2");

  // Evitar que artículos indefinidos ("una pregunta", "un momento", "un segundo", "una duda", "una web") se conviertan en el dígito "1"
  s = s.replace(/\b(un|una)\s+(pregunta|momento|momentito|segundo|segundito|minuto|minutito|cosa|cosita|duda|consulta|web|p[aá]gina|muestra|enlace|mensaje|whatsapp|correo|saludo|poco|poquito|par|favor)\b/gi, "$2");

  // Proteger expresiones multiplicadoras ("dos veces 648", "doble 6", "una vez") para no convertir "dos" en un "2" intruso
  s = s.replace(/\b(dos\s+veces|doble)\b/gi, "__TWICE__");
  s = s.replace(/\b(tres\s+veces|triple)\b/gi, "__THRICE__");
  s = s.replace(/\b(una\s+vez)\b/gi, "");

  // IMPORTANTE: Las decenas compuestas ("cuarenta y ocho") DEBEN evaluarse ANTES que las unidades ("ocho")
  const wordMap: [RegExp, string][] = [
    [/\b(treinta\s+y\s+uno)\b/g, "31"],
    [/\b(treinta\s+y\s+dos)\b/g, "32"],
    [/\b(treinta\s+y\s+tres)\b/g, "33"],
    [/\b(treinta\s+y\s+cuatro)\b/g, "34"],
    [/\b(treinta\s+y\s+cinco)\b/g, "35"],
    [/\b(treinta\s+y\s+seis)\b/g, "36"],
    [/\b(treinta\s+y\s+siete)\b/g, "37"],
    [/\b(treinta\s+y\s+ocho)\b/g, "38"],
    [/\b(treinta\s+y\s+nueve)\b/g, "39"],
    [/\b(treinta)\b/g, "30"],
    [/\b(cuarenta\s+y\s+uno)\b/g, "41"],
    [/\b(cuarenta\s+y\s+dos)\b/g, "42"],
    [/\b(cuarenta\s+y\s+tres)\b/g, "43"],
    [/\b(cuarenta\s+y\s+cuatro)\b/g, "44"],
    [/\b(cuarenta\s+y\s+cinco)\b/g, "45"],
    [/\b(cuarenta\s+y\s+seis)\b/g, "46"],
    [/\b(cuarenta\s+y\s+siete)\b/g, "47"],
    [/\b(cuarenta\s+y\s+ocho)\b/g, "48"],
    [/\b(cuarenta\s+y\s+nueve)\b/g, "49"],
    [/\b(cuarenta)\b/g, "40"],
    [/\b(cincuenta\s+y\s+uno)\b/g, "51"],
    [/\b(cincuenta\s+y\s+dos)\b/g, "52"],
    [/\b(cincuenta\s+y\s+tres)\b/g, "53"],
    [/\b(cincuenta\s+y\s+cuatro)\b/g, "54"],
    [/\b(cincuenta\s+y\s+cinco)\b/g, "55"],
    [/\b(cincuenta\s+y\s+seis)\b/g, "56"],
    [/\b(cincuenta\s+y\s+siete)\b/g, "57"],
    [/\b(cincuenta\s+y\s+ocho)\b/g, "58"],
    [/\b(cincuenta\s+y\s+nueve)\b/g, "59"],
    [/\b(cincuenta)\b/g, "50"],
    [/\b(sesenta\s+y\s+uno)\b/g, "61"],
    [/\b(sesenta\s+y\s+dos)\b/g, "62"],
    [/\b(sesenta\s+y\s+tres)\b/g, "63"],
    [/\b(sesenta\s+y\s+cuatro)\b/g, "64"],
    [/\b(sesenta\s+y\s+cinco)\b/g, "65"],
    [/\b(sesenta\s+y\s+seis)\b/g, "66"],
    [/\b(sesenta\s+y\s+siete)\b/g, "67"],
    [/\b(sesenta\s+y\s+ocho)\b/g, "68"],
    [/\b(sesenta\s+y\s+nueve)\b/g, "69"],
    [/\b(sesenta)\b/g, "60"],
    [/\b(setenta\s+y\s+uno)\b/g, "71"],
    [/\b(setenta\s+y\s+dos)\b/g, "72"],
    [/\b(setenta\s+y\s+tres)\b/g, "73"],
    [/\b(setenta\s+y\s+cuatro)\b/g, "74"],
    [/\b(setenta\s+y\s+cinco)\b/g, "75"],
    [/\b(setenta\s+y\s+seis)\b/g, "76"],
    [/\b(setenta\s+y\s+siete)\b/g, "77"],
    [/\b(setenta\s+y\s+ocho)\b/g, "78"],
    [/\b(setenta\s+y\s+nueve)\b/g, "79"],
    [/\b(setenta)\b/g, "70"],
    [/\b(ochenta\s+y\s+uno)\b/g, "81"],
    [/\b(ochenta\s+y\s+dos)\b/g, "82"],
    [/\b(ochenta\s+y\s+tres)\b/g, "83"],
    [/\b(ochenta\s+y\s+cuatro)\b/g, "84"],
    [/\b(ochenta\s+y\s+cinco)\b/g, "85"],
    [/\b(ochenta\s+y\s+seis)\b/g, "86"],
    [/\b(ochenta\s+y\s+siete)\b/g, "87"],
    [/\b(ochenta\s+y\s+ocho)\b/g, "88"],
    [/\b(ochenta\s+y\s+nueve)\b/g, "89"],
    [/\b(ochenta)\b/g, "80"],
    [/\b(noventa\s+y\s+uno)\b/g, "91"],
    [/\b(noventa\s+y\s+dos)\b/g, "92"],
    [/\b(noventa\s+y\s+tres)\b/g, "93"],
    [/\b(noventa\s+y\s+cuatro)\b/g, "94"],
    [/\b(noventa\s+y\s+cinco)\b/g, "95"],
    [/\b(noventa\s+y\s+seis)\b/g, "96"],
    [/\b(noventa\s+y\s+siete)\b/g, "97"],
    [/\b(noventa\s+y\s+ocho)\b/g, "98"],
    [/\b(noventa\s+y\s+nueve)\b/g, "99"],
    [/\b(noventa)\b/g, "90"],
    [/\b(diez)\b/g, "10"],
    [/\b(once)\b/g, "11"],
    [/\b(doce)\b/g, "12"],
    [/\b(trece)\b/g, "13"],
    [/\b(catorce)\b/g, "14"],
    [/\b(quince)\b/g, "15"],
    [/\b(diecis[eé]is)\b/g, "16"],
    [/\b(diecisiete)\b/g, "17"],
    [/\b(dieciocho)\b/g, "18"],
    [/\b(diecinueve)\b/g, "19"],
    [/\b(veinte)\b/g, "20"],
    [/\b(veintiuno)\b/g, "21"],
    [/\b(veintid[oó]s)\b/g, "22"],
    [/\b(veintitr[eé]s)\b/g, "23"],
    [/\b(veinticuatro)\b/g, "24"],
    [/\b(veinticinco)\b/g, "25"],
    [/\b(veintis[eé]is)\b/g, "26"],
    [/\b(veintisiete)\b/g, "27"],
    [/\b(veintiocho)\b/g, "28"],
    [/\b(veintinueve)\b/g, "29"],
    [/\b(cero)\b/g, "0"],
    [/\b(uno)\b/g, "1"],
    [/\b(dos)\b/g, "2"],
    [/\b(tres)\b/g, "3"],
    [/\b(cuatro)\b/g, "4"],
    [/\b(cinco)\b/g, "5"],
    [/\b(seis|séis|stay|say)\b/g, "6"],
    [/\b(siete)\b/g, "7"],
    [/\b(ocho)\b/g, "8"],
    [/\b(nueve)\b/g, "9"],
  ];

  for (const [pattern, repl] of wordMap) {
    s = s.replace(pattern, repl);
  }

  // Centenas compuestas (ej. "seiscientos 48" -> "648", "cuatrocientos 5" -> "405")
  const hundredsPrefixMap: [RegExp, string][] = [
    [/\b(ciento)\s+(\d{2})\b/g, "1$2"],
    [/\b(ciento)\s+(\d)\b/g, "10$2"],
    [/\b(doscientos|doscientas)\s+(\d{2})\b/g, "2$2"],
    [/\b(doscientos|doscientas)\s+(\d)\b/g, "20$2"],
    [/\b(trescientos|trescientas)\s+(\d{2})\b/g, "3$2"],
    [/\b(trescientos|trescientas)\s+(\d)\b/g, "30$2"],
    [/\b(cuatrocientos|cuatrocientas)\s+(\d{2})\b/g, "4$2"],
    [/\b(cuatrocientos|cuatrocientas)\s+(\d)\b/g, "40$2"],
    [/\b(quinientos|quinientas)\s+(\d{2})\b/g, "5$2"],
    [/\b(quinientos|quinientas)\s+(\d)\b/g, "50$2"],
    [/\b(seiscientos|seiscientas)\s+(\d{2})\b/g, "6$2"],
    [/\b(seiscientos|seiscientas)\s+(\d)\b/g, "60$2"],
    [/\b(setecientos|setecientas)\s+(\d{2})\b/g, "7$2"],
    [/\b(setecientos|setecientas)\s+(\d)\b/g, "70$2"],
    [/\b(ochocientos|ochocientas)\s+(\d{2})\b/g, "8$2"],
    [/\b(ochocientos|ochocientas)\s+(\d)\b/g, "80$2"],
    [/\b(novecientos|novecientas)\s+(\d{2})\b/g, "9$2"],
    [/\b(novecientos|novecientas)\s+(\d)\b/g, "90$2"],
    [/\b(cien|ciento)\b/g, "100"],
    [/\b(doscientos|doscientas)\b/g, "200"],
    [/\b(trescientos|trescientas)\b/g, "300"],
    [/\b(cuatrocientos|cuatrocientas)\b/g, "400"],
    [/\b(quinientos|quinientas)\b/g, "500"],
    [/\b(seiscientos|seiscientas)\b/g, "600"],
    [/\b(setecientos|setecientas)\b/g, "700"],
    [/\b(ochocientos|ochocientas)\b/g, "800"],
    [/\b(novecientos|novecientas)\b/g, "900"],
  ];

  for (const [pattern, repl] of hundredsPrefixMap) {
    s = s.replace(pattern, repl);
  }

  // Expandir "dos veces 648" / "dos veces 6 48" -> "648 648"
  s = s.replace(/__TWICE__\s*(?:el\s+)?(\d\s+\d{2}|\d{1,3})\b/g, (_, grp) => {
    const cleanGrp = grp.replace(/\s+/g, "");
    return `${cleanGrp} ${cleanGrp}`;
  });
  s = s.replace(/__THRICE__\s*(?:el\s+)?(\d\s+\d{2}|\d{1,3})\b/g, (_, grp) => {
    const cleanGrp = grp.replace(/\s+/g, "");
    return `${cleanGrp} ${cleanGrp} ${cleanGrp}`;
  });
  s = s.replace(/__(?:TWICE|THRICE)__/g, "");

  return s;
}

export function isWithinCommercialHours(settings: CrmSettings, testDate?: Date): boolean {
  if (!settings.enforce_horario) {
    return true; // En modo flexible o test, siempre disponible
  }

  const now = testDate || new Date();
  // Obtener día de la semana y hora según huso horario Europe/Madrid
  const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", weekday: "short" });
  const dayStr = dayFormatter.format(now);
  const dayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  const day = dayMap[dayStr] || 1;

  if (!settings.dias_laborables.includes(day)) {
    return false;
  }

  const timeFormatter = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = timeFormatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour")?.value || "00";
  const minPart = parts.find((p) => p.type === "minute")?.value || "00";
  const currentTime = `${hourPart.padStart(2, "0")}:${minPart.padStart(2, "0")}`;

  const inMorning =
    currentTime >= settings.horario_comercial_inicio &&
    currentTime <= settings.horario_comercial_fin_manana;

  const inAfternoon =
    currentTime >= settings.horario_comercial_inicio_tarde &&
    currentTime <= settings.horario_comercial_fin_tarde;

  return inMorning || inAfternoon;
}

export class CrmService {
  /**
   * Importar lote de leads procedentes de Google Maps u otras fuentes
   */
  public importLeads(
    items: ImportLeadItem[],
    proyectoId: string,
    campaniaId: string
  ): ImportResult {
    const db = crmStorage.getDb();
    const result: ImportResult = {
      total_recibidos: items.length,
      importados_nuevos: 0,
      duplicados_omitidos: 0,
      robinson_bloqueados: 0,
      telefonos_invalidos: 0,
      leads_creados: [],
      errores: [],
    };

    const proyecto = db.proyectos.find((p) => p.id === proyectoId) || db.proyectos[0];
    const campania = db.campanias.find((c) => c.id === campaniaId) || db.campanias[0];

    if (!proyecto) {
      throw new Error(`Proyecto no encontrado con id: ${proyectoId}`);
    }

    const now = new Date().toISOString();

    for (const item of items) {
      const normalizedPhone = normalizeSpanishPhone(item.telefono);
      if (!normalizedPhone) {
        result.telefonos_invalidos++;
        result.errores.push({
          lead: item,
          razon: `Teléfono inválido o formato no reconocido: ${item.telefono}`,
        });
        continue;
      }

      // 1. Chequeo de Lista Robinson
      if (crmStorage.isPhoneInRobinson(normalizedPhone)) {
        result.robinson_bloqueados++;
        result.errores.push({
          lead: item,
          razon: `Teléfono en Lista Robinson: ${normalizedPhone}`,
        });
        continue;
      }

      // 2. Deduplicación por place_id y por teléfono en el mismo proyecto
      const duplicatePlace = item.place_id && db.leads.some((l) => l.place_id === item.place_id);
      const duplicatePhone = db.leads.some(
        (l) => l.proyecto_id === proyecto.id && l.telefono === normalizedPhone
      );

      if (duplicatePlace || duplicatePhone) {
        result.duplicados_omitidos++;
        continue;
      }

      // 3. Crear Lead nuevo
      const leadId = generateId("lead");
      const token = `tok_${crypto.randomBytes(6).toString("hex")}`;
      
      // Simulación/Construcción de URL de gancho (Forja Web u otro)
      const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
      const port = process.env.PORT || "3000";
      const baseOrigin = publicBaseUrl || `http://localhost:${port}`;
      const urlPropuesta = `${baseOrigin}/api/crm/propuesta/${token}`;

      const isTestItem = (item as any).es_simulacion === true || Boolean(item.place_id && (item.place_id.includes("E2E") || item.place_id.startsWith("test_") || item.place_id.includes("test")));

      const nuevoLead: Lead = {
        id: leadId,
        proyecto_id: proyecto.id,
        campania_id: campania ? campania.id : proyecto.id,
        place_id: item.place_id || `place_${crypto.randomBytes(6).toString("hex")}`,
        empresa_nombre: (item.empresa_nombre || "Empresa Local").trim(),
        categoria_maps: item.categoria_maps || "Negocio Local",
        oficio_mapeado: item.oficio_mapeado || item.categoria_maps || "servicios",
        telefono: normalizedPhone,
        telefono_original: item.telefono,
        ciudad: item.ciudad || "Madrid",
        codigo_postal: item.codigo_postal || "",
        direccion: item.direccion || "",
        tiene_web_previa: item.tiene_web_previa ?? Boolean(item.web_actual),
        web_actual: item.web_actual || "",
        estado: "cola_llamada", // Entra directamente listo para prospección
        url_propuesta: urlPropuesta,
        token_seguimiento: token,
        veces_llamado: 0,
        veces_whatsapp: 0,
        calificacion: null,
        notas: item.notas || "",
        asignado_a: "",
        ultimo_contacto_at: null,
        es_simulacion: isTestItem ? true : undefined,
        created_at: now,
        updated_at: now,
      };

      // Registrar propuesta
      const propuesta: PropuestaGenerada = {
        id: generateId("prop"),
        lead_id: leadId,
        proyecto_id: proyecto.id,
        tipo_gancho: proyecto.tipo_gancho,
        url_publica: urlPropuesta,
        token_seguimiento: token,
        abierta: false,
        veces_abierta: 0,
        primera_apertura_at: null,
        ultima_apertura_at: null,
        created_at: now,
      };

      db.leads.push(nuevoLead);
      db.propuestas.push(propuesta);
      result.leads_creados.push(nuevoLead);
      result.importados_nuevos++;
    }

    if (campania) {
      campania.total_leads = (campania.total_leads || 0) + result.importados_nuevos;
      campania.updated_at = now;
    }

    crmStorage.save();
    return result;
  }

  /**
   * Verifica si un teléfono está incluido en la Lista Robinson
   */
  public isPhoneInRobinson(phone: string): boolean {
    return crmStorage.isPhoneInRobinson(phone);
  }

  /**
   * Obtiene el siguiente lead para llamar respetando límites, horarios y periodo de enfriamiento
   */
  public getNextCallLead(options: { lineaId?: string; overrideHorario?: boolean; campaniaId?: string; cooldownMinutes?: number; isSimulation?: boolean } = {}): { item?: CallQueueItem; error?: string } {
    return crmStorage.transaction(() => this.reserveNextCallLead(options));
  }

  private reserveNextCallLead(options: {
    lineaId?: string;
    overrideHorario?: boolean;
    campaniaId?: string;
    cooldownMinutes?: number;
    isSimulation?: boolean;
  } = {}): { item?: CallQueueItem; error?: string } {
    const db = crmStorage.getDb();

    // 1. Horario comercial
    if (!options.overrideHorario && !isWithinCommercialHours(db.settings)) {
      return {
        error: `Fuera de horario comercial (${db.settings.horario_comercial_inicio}-${db.settings.horario_comercial_fin_manana} y ${db.settings.horario_comercial_inicio_tarde}-${db.settings.horario_comercial_fin_tarde})`,
      };
    }

    // 2. Línea telefónica disponible (cuota diaria máx 30 y no en uso actualmente)
    let linea: LineaTelefonica | null = null;
    if (options.lineaId) {
      linea = db.lineas.find((l) => l.id === options.lineaId && l.activa && !l.en_uso) || null;
      if (!linea) {
        return { error: `Línea especificada (${options.lineaId}) no encontrada, inactiva u ocupada` };
      }
      crmStorage.checkAndResetDailyQuotas();
      if (linea.llamadas_hoy >= linea.limite_diario) {
        return {
          error: `Línea ${linea.nombre} ha alcanzado su límite diario de ${linea.limite_diario} llamadas`,
        };
      }
    } else {
      linea = crmStorage.getNextAvailableLine();
      if (!linea) {
        return {
          error: "Todas las líneas telefónicas han agotado su cuota diaria (límite 25-30), están inactivas u ocupadas",
        };
      }
    }

    // 3. Buscar siguiente lead en cola_llamada o muestra_generada respetando enfriamiento (anti-rellamadas inmediatas)
    const minCooldownMs = (options.cooldownMinutes ?? 30) * 60 * 1000;
    const nowMs = Date.now();

    const candidatos = db.leads.filter((l) => {
      if (l.estado !== "cola_llamada" && l.estado !== "muestra_generada") return false;
      if (options.campaniaId && l.campania_id !== options.campaniaId) return false;
      if (options.isSimulation !== undefined) {
        if (options.isSimulation ? !l.es_simulacion : Boolean(l.es_simulacion)) {
          return false;
        }
      }
      // Comprobar oposición / lista Robinson antes de seleccionar
      if (this.isPhoneInRobinson(l.telefono)) {
        l.estado = "no_contactar";
        l.updated_at = new Date().toISOString();
        return false;
      }
      // Respetar tiempo mínimo entre llamadas al mismo contacto
      if (l.ultimo_contacto_at) {
        const lastContactMs = new Date(l.ultimo_contacto_at).getTime();
        if (nowMs - lastContactMs < minCooldownMs) {
          return false;
        }
      }
      return true;
    });

    if (candidatos.length === 0) {
      return { error: "No hay leads pendientes en la cola de llamadas (o están en periodo de enfriamiento)" };
    }

    const lead = candidatos[0];
    const proyecto = db.proyectos.find((p) => p.id === lead.proyecto_id) || db.proyectos[0];
    const callId = `call_${Date.now()}_${lead.id}`;

    // Marcar llamada en la línea y reservar el contacto en estado 'en_llamada'
    crmStorage.incrementLineCalls(linea.id);
    crmStorage.setLineInUse(linea.id, true);
    lead.estado = "en_llamada"; // RESERVA ACTIVA DEL CONTACTO
    lead.veces_llamado += 1;
    lead.ultimo_contacto_at = new Date().toISOString();
    lead.updated_at = new Date().toISOString();
    crmStorage.save();

    return {
      item: {
        callId,
        lead,
        linea,
        script: proyecto.script_llamada,
        proyecto,
      },
    };
  }

  /**
   * Reconcilia reservas huérfanas al reiniciar el servidor o worker.
   * Evita que contactos queden bloqueados en 'en_llamada' o líneas en 'en_uso' tras un cierre anómalo.
   */
  public reconcileOrphanReservations(): { leadsReconciled: number; linesReleased: number } {
    const db = crmStorage.getDb();
    let leadsReconciled = 0;
    let linesReleased = 0;

    for (const lead of db.leads) {
      if (lead.estado === "en_llamada") {
        lead.estado = lead.veces_llamado >= 3 ? "descartado" : "cola_llamada";
        lead.updated_at = new Date().toISOString();
        leadsReconciled++;
      }
    }

    for (const linea of db.lineas) {
      if (linea.en_uso) {
        linea.en_uso = false;
        linesReleased++;
      }
    }

    if (leadsReconciled > 0 || linesReleased > 0) {
      crmStorage.save();
      console.warn(`[CrmService] Reconciliación de reservas huérfanas: ${leadsReconciled} leads reincorporados, ${linesReleased} líneas liberadas.`);
    }

    return { leadsReconciled, linesReleased };
  }

  /**
   * Libera la reserva de un contacto si la llamada falló antes de conectar
   */
  public releaseLeadReservation(leadId: string, lineaId?: string, outcome: string = "fallo_marcado"): void {
    crmStorage.transaction(() => this.releaseReservation(leadId, lineaId, outcome));
  }

  private releaseReservation(leadId: string, lineaId?: string, outcome: string = "fallo_marcado"): void {
    const db = crmStorage.getDb();
    const lead = db.leads.find((l) => l.id === leadId);
    if (lineaId) {
      crmStorage.setLineInUse(lineaId, false);
    }
    if (lead && lead.estado === "en_llamada") {
      lead.estado = lead.veces_llamado >= 3 ? "descartado" : "cola_llamada";
      lead.updated_at = new Date().toISOString();
      crmStorage.save();
    }
  }

  /**
   * Procesa el resultado de una llamada telefónica vinculando sesión, evidencia y transcripción
   */
  public recordCallOutcome(payload: CallOutcomePayload): { success: boolean; lead: Lead; deduplicated?: boolean } {
    return crmStorage.transaction(() => this.applyCallOutcome(payload));
  }

  private applyCallOutcome(payload: CallOutcomePayload): { success: boolean; lead: Lead; deduplicated?: boolean } {
    const db = crmStorage.getDb();
    const lead = db.leads.find((l) => l.id === payload.lead_id);
    if (!lead) {
      throw new Error(`Lead no encontrado: ${payload.lead_id}`);
    }

    // Evitar resultados duplicados para la misma sesión de llamada ANTES de alterar la línea o el lead
    const sessionKey = payload.sessionId || payload.callId;
    if (sessionKey) {
      const existing = db.interacciones.find(
        (i) => (i.sessionId === sessionKey || (payload.callId && i.datos_adicionales?.callId === payload.callId)) && i.lead_id === payload.lead_id
      );
      if (existing) {
        console.warn(`[CrmService] Resultado duplicado detectado para sesión ${sessionKey}. Evitando registro repetido y preservando asignación de línea.`);
        return { success: true, lead, deduplicated: true };
      }
    }

    // Liberar la línea telefónica utilizada una vez verificado que es un resultado nuevo legítimo
    if (payload.linea_id) {
      crmStorage.setLineInUse(payload.linea_id, false);
    }

    const now = new Date().toISOString();

    // 1. Registrar interacción con metadatos de auditoría
    const interaccion: Interaccion = {
      id: generateId("int"),
      lead_id: lead.id,
      tipo: "llamada",
      resultado: payload.resultado,
      duracion_segundos: payload.duracion_segundos || 0,
      resumen_transcripcion: payload.resumen || "",
      linea_usada: payload.linea_id,
      sessionId: payload.sessionId,
      es_simulacion: payload.es_simulacion === true,
      datos_adicionales: {
        whatsappAuthorized: payload.whatsappAuthorized,
        telefono_confirmado: payload.telefono_confirmado,
        evidence_quote: payload.evidence_quote,
        transcripcion: payload.transcripcion,
      },
      created_at: now,
    };
    db.interacciones.push(interaccion);

    // Si se invoca resultado simulado sobre un contacto real (no de prueba), no alterar su estado comercial ni sacarlo del circuito
    if (payload.es_simulacion === true && !lead.es_simulacion) {
      if (lead.estado === "en_llamada") {
        lead.estado = "cola_llamada";
      }
      lead.updated_at = now;
      crmStorage.save();
      return { success: true, lead };
    }

    // 2. Comprobar si pide Robinson u oposición tajante
    if (payload.agregar_a_robinson || (payload.resultado === "rechazo" && payload.motivo_robinson)) {
      crmStorage.addToRobinson(
        lead.telefono,
        payload.motivo_robinson || "Solicitó no ser contactado en llamada",
        lead.id
      );
      lead.estado = "no_contactar";
      lead.calificacion = "frio";
      lead.updated_at = now;
      crmStorage.save();
      return { success: true, lead };
    }

    // 3. Validación de consentimiento de WhatsApp: cualquier aceptación es válida
    let consentGranted = false;
    if (payload.whatsappAuthorized) {
      const quote = (payload.evidence_quote || "").trim();
      const hasValidQuote = !quote || quote.length < 2 || isExplicitWhatsAppAuthorization(quote);

      // Resolver teléfono de WhatsApp: si es "este", nulo o vacío, usar el propio teléfono del lead
      let resolvedPhone = payload.telefono_confirmado;
      if (!resolvedPhone || resolvedPhone === "este" || resolvedPhone.trim().toLowerCase() === "este") {
        resolvedPhone = lead.telefono;
      }
      const hasConfirmedPhone = Boolean(resolvedPhone && (normalizeSpanishPhone(resolvedPhone) || resolvedPhone.length >= 9));

      if (hasValidQuote && hasConfirmedPhone) {
        consentGranted = true;
        if (resolvedPhone) {
          const norm = normalizeSpanishPhone(resolvedPhone);
          lead.telefono = norm || resolvedPhone;
          lead.telefono_confirmado = lead.telefono;
        }
      } else {
        console.warn(
          `[CrmService Alerta] Autorización de WhatsApp rechazada: evidencia insuficiente ("${quote}") o teléfono no confirmado (${resolvedPhone}).`
        );
      }
    }

    // 4. Transición de estado del Lead
    if (consentGranted) {
      lead.estado = "cola_whatsapp";
      lead.calificacion = "caliente";
      lead.consentimiento_whatsapp = true;
      lead.evidencia_consentimiento = payload.evidence_quote || "Aceptado en llamada";
      lead.transcripcion_resumen = payload.transcripcion || payload.resumen;
    } else {
      switch (payload.resultado) {
        case "rechazo":
          lead.estado = "descartado";
          lead.calificacion = "frio";
          break;
        case "no_contesta":
        case "buzon":
        case "ocupado":
        case "desconexion":
          if (lead.veces_llamado >= 3) {
            lead.estado = "descartado";
          } else {
            // Mantiene en cola para reintentar tras periodo de enfriamiento
            lead.estado = "cola_llamada";
          }
          break;
        case "fallo_marcado":
          // Si el marcado falló, dejar en cola para reintentar tras cooldown
          lead.estado = "cola_llamada";
          break;
        case "numero_invalido":
          lead.estado = "descartado";
          break;
        case "colgado":
        default:
          lead.estado = "llamado";
          break;
      }
    }

    lead.ultimo_contacto_at = now;
    lead.updated_at = now;
    crmStorage.save();

    return { success: true, lead };
  }

  /**
   * Obtiene el siguiente lead en cola de WhatsApp con la plantilla renderizada
   */
  public getNextWhatsAppLead(options: { campaniaId?: string; isSimulation?: boolean } = {}): { item?: WhatsAppQueueItem; error?: string } {
    const db = crmStorage.getDb();
    const isSim = options.isSimulation;
    const lead = db.leads.find((l) => {
      if (l.estado !== "cola_whatsapp") return false;
      if (options.campaniaId && l.campania_id !== options.campaniaId) return false;
      if (isSim !== undefined) {
        return isSim ? Boolean(l.es_simulacion) : !l.es_simulacion;
      }
      return true;
    });
    if (!lead) {
      return { error: "No hay leads pendientes en la cola de WhatsApp" };
    }

    const proyecto = db.proyectos.find(p => p.id === lead.proyecto_id);
    if (!proyecto) return { error: "Proyecto no disponible" };
    let prepared;
    try { prepared = proposalMessage(db, lead); }
    catch (e: any) { return { error: e.message }; }
    const mensaje = prepared.message;
    const absolutePropuestaUrl = prepared.url;

    // Clave de idempotencia única y persistente en disco (evita duplicados ante reintentos o reinicios)
    if (!lead.whatsapp_idempotency_key) {
      lead.whatsapp_idempotency_key = `wa_${lead.id}_${crypto.randomBytes(4).toString("hex")}`;
      lead.updated_at = new Date().toISOString();
      crmStorage.save();
    }

    return {
      item: {
        lead,
        mensaje,
        url_propuesta: absolutePropuestaUrl,
        proyecto,
        idempotency_key: lead.whatsapp_idempotency_key,
      },
    };
  }

  /**
   * Registra el resultado del envío por WhatsApp
   */
  public recordWhatsAppOutcome(payload: WhatsAppOutcomePayload): {
    success: boolean;
    lead: Lead;
  } {
    const db = crmStorage.getDb();
    const lead = db.leads.find((l) => l.id === payload.lead_id);
    if (!lead) {
      throw new Error(`Lead no encontrado: ${payload.lead_id}`);
    }

    const now = new Date().toISOString();

    const isSim = payload.es_simulacion === true;
    const interaccion: Interaccion = {
      id: generateId("int"),
      lead_id: lead.id,
      tipo: "whatsapp",
      resultado: payload.success ? "enviado_ok" : "error_envio",
      resumen_transcripcion: payload.mensaje_enviado || payload.error || "",
      es_simulacion: isSim,
      created_at: now,
    };
    db.interacciones.push(interaccion);

    if (payload.success) {
      if (isSim) {
        // En simulación: si es un lead creado para pruebas/simulación, actualizar su estado
        if (lead.es_simulacion) {
          lead.estado = "whatsapp_enviado";
        }
        // Para contactos comerciales reales, el envío simulado NO modifica su estado ni lo saca del circuito
      } else {
        lead.estado = "whatsapp_enviado";
        lead.veces_whatsapp += 1;
      }
    } else {
      const attempts = ((lead as any).veces_whatsapp_intentos || 0) + 1;
      (lead as any).veces_whatsapp_intentos = attempts;

      const errorMsg = `[Error WhatsApp] ${payload.error}`;
      if (!lead.notas || !lead.notas.endsWith(errorMsg)) {
        lead.notas = lead.notas ? `${lead.notas}\n${errorMsg}` : errorMsg;
      }

      // Si el número es claramente inválido o supera los 3 intentos, descartar de la cola
      const isInvalidNumber = !lead.telefono || lead.telefono === "este" || /no v[aá]lido/i.test(payload.error || "");
      if (isInvalidNumber || attempts >= 3) {
        lead.estado = "descartado";
      }
    }

    lead.ultimo_contacto_at = now;
    lead.updated_at = now;
    crmStorage.save();

    return { success: true, lead };
  }

  /**
   * Registra un mensaje entrante recibido por WhatsApp desde un cliente
   */
  public recordIncomingWhatsAppMessage(
    rawPhone: string,
    text: string
  ): {
    lead?: Lead;
    previousInteractions: Interaccion[];
  } {
    const db = crmStorage.getDb();
    const cleanDigits = rawPhone.replace(/[^0-9]/g, "");
    const last9 = cleanDigits.slice(-9);

    const lead = db.leads.find((l) => {
      const lDigits = (l.telefono || "").replace(/[^0-9]/g, "");
      return lDigits.slice(-9) === last9;
    });

    const now = new Date().toISOString();

    if (lead) {
      // Actualizar estado del lead al responder
      if (
        ["whatsapp_enviado", "llamado", "cola_whatsapp", "nuevo", "muestra_generada"].includes(
          lead.estado
        )
      ) {
        lead.estado = "interesado";
        lead.calificacion = "caliente";
      }
      lead.ultimo_contacto_at = now;
      lead.updated_at = now;

      const interaccion: Interaccion = {
        id: generateId("int"),
        lead_id: lead.id,
        tipo: "whatsapp",
        resultado: "mensaje_cliente",
        resumen_transcripcion: text,
        created_at: now,
      };
      db.interacciones.push(interaccion);
      crmStorage.save();

      appEvents.broadcast({
        type: "whatsapp_message_received",
        leadId: lead.id,
        empresa: lead.empresa_nombre,
        phone: lead.telefono,
        text,
        timestamp: now,
      });

      const previousInteractions = db.interacciones.filter(
        (i) => i.lead_id === lead.id && i.tipo === "whatsapp"
      );

      return { lead, previousInteractions };
    }

    return { lead: undefined, previousInteractions: [] };
  }

  /**
   * Registra la respuesta del Asistente IA enviada al cliente por WhatsApp
   */
  public recordOutgoingWhatsAppReply(
    leadId: string,
    replyText: string,
    success = true
  ): void {
    const db = crmStorage.getDb();
    const lead = db.leads.find((l) => l.id === leadId);
    const now = new Date().toISOString();

    const interaccion: Interaccion = {
      id: generateId("int"),
      lead_id: leadId,
      tipo: "whatsapp",
      resultado: success ? "respuesta_ia" : "error_envio_ia",
      resumen_transcripcion: replyText,
      created_at: now,
    };
    db.interacciones.push(interaccion);

    if (lead) {
      lead.ultimo_contacto_at = now;
      lead.updated_at = now;
    }

    crmStorage.save();

    appEvents.broadcast({
      type: "whatsapp_ai_reply",
      leadId,
      empresa: lead?.empresa_nombre,
      phone: lead?.telefono,
      text: replyText,
      timestamp: now,
    });
  }

  /**
   * Registra cuando el usuario abre el enlace de la propuesta/muestra
   */
  public trackProposalOpen(token: string): {
    success: boolean;
    propuesta?: PropuestaGenerada;
    lead?: Lead;
  } {
    const db = crmStorage.getDb();
    const propuesta = db.propuestas.find((p) => p.token_seguimiento === token);
    if (!propuesta) {
      return { success: false };
    }

    const now = new Date().toISOString();
    propuesta.abierta = true;
    propuesta.veces_abierta += 1;
    if (!propuesta.primera_apertura_at) {
      propuesta.primera_apertura_at = now;
    }
    propuesta.ultima_apertura_at = now;

    const lead = db.leads.find((l) => l.id === propuesta.lead_id);
    if (lead) {
      if (lead.estado === "whatsapp_enviado" || lead.estado === "llamado" || lead.estado === "muestra_generada") {
        lead.estado = "interesado";
        lead.calificacion = "caliente";
      }
      lead.updated_at = now;

      // Registrar interacción con señal explícita de apertura de enlace
      db.interacciones.push({
        id: generateId("int"),
        lead_id: lead.id,
        tipo: "apertura_propuesta",
        resultado: "clic_enlace",
        created_at: now,
      });

      appEvents.broadcast({
        type: "propuesta_abierta",
        leadId: lead.id,
        empresa: lead.empresa_nombre,
        token,
        timestamp: now,
      });
    }

    crmStorage.save();
    return { success: true, propuesta, lead };
  }

  /**
   * Obtiene métricas agregadas del embudo de ventas y estado de líneas
   */
  public getFunnelStats() {
    const db = crmStorage.getDb();
    crmStorage.checkAndResetDailyQuotas();

    const totalLeads = db.leads.length;

    const porEstado: Record<LeadEstado, number> = {
      nuevo: 0,
      muestra_generada: 0,
      cola_llamada: 0,
      en_llamada: 0,
      llamado: 0,
      cola_whatsapp: 0,
      enviando_whatsapp: 0,
      whatsapp_enviado: 0,
      interesado: 0,
      en_negociacion: 0,
      ganado: 0,
      descartado: 0,
      no_contactar: 0,
    };

    for (const lead of db.leads) {
      if (porEstado[lead.estado] !== undefined) {
        porEstado[lead.estado]++;
      }
    }

    // Separación estricta de producción real vs pruebas simuladas
    const realLeads = db.leads.filter((l) => !l.es_simulacion);
    const simLeads = db.leads.filter((l) => l.es_simulacion);

    const porEstadoProduccion: Record<LeadEstado, number> = {
      nuevo: 0,
      muestra_generada: 0,
      cola_llamada: 0,
      en_llamada: 0,
      llamado: 0,
      cola_whatsapp: 0,
      enviando_whatsapp: 0,
      whatsapp_enviado: 0,
      interesado: 0,
      en_negociacion: 0,
      ganado: 0,
      descartado: 0,
      no_contactar: 0,
    };

    for (const lead of realLeads) {
      if (porEstadoProduccion[lead.estado] !== undefined) {
        porEstadoProduccion[lead.estado]++;
      }
    }

    const totalRealLlamados = realLeads.filter((l) => l.veces_llamado > 0).length;
    const totalRealAutorizados = realLeads.filter(
      (l) =>
        l.estado === "cola_whatsapp" ||
        l.estado === "whatsapp_enviado" ||
        l.estado === "interesado" ||
        l.estado === "en_negociacion" ||
        l.estado === "ganado"
    ).length;

    const tasaAutorizacionReal =
      totalRealLlamados > 0 ? Math.round((totalRealAutorizados / totalRealLlamados) * 100) : 0;

    const totalLlamadasHoy = db.lineas.reduce((acc, l) => acc + l.llamadas_hoy, 0);
    const limiteTotalHoy = db.lineas.reduce((acc, l) => acc + (l.activa ? l.limite_diario : 0), 0);

    const totalLlamados = db.leads.filter((l) => l.veces_llamado > 0).length;
    const totalAutorizados = db.leads.filter(
      (l) =>
        l.estado === "cola_whatsapp" ||
        l.estado === "whatsapp_enviado" ||
        l.estado === "interesado" ||
        l.estado === "en_negociacion" ||
        l.estado === "ganado"
    ).length;

    const tasaAutorizacion =
      totalLlamados > 0 ? Math.round((totalAutorizados / totalLlamados) * 100) : 0;

    const totalPropuestasAbiertas = db.propuestas.filter((p) => p.abierta).length;
    const totalPropuestasEnviadas = db.leads.filter(
      (l) =>
        l.veces_whatsapp > 0 ||
        l.estado === "whatsapp_enviado" ||
        l.estado === "interesado" ||
        l.estado === "en_negociacion" ||
        l.estado === "ganado"
    ).length;
    const tasaApertura =
      totalPropuestasEnviadas > 0
        ? Math.min(100, Math.round((totalPropuestasAbiertas / totalPropuestasEnviadas) * 100))
        : 0;

    const totalSimLlamados = simLeads.filter((l) => l.veces_llamado > 0).length;
    const totalSimAutorizados = simLeads.filter(
      (l) =>
        l.estado === "cola_whatsapp" ||
        l.estado === "whatsapp_enviado" ||
        l.estado === "interesado" ||
        l.estado === "en_negociacion" ||
        l.estado === "ganado"
    ).length;

    return {
      total_leads: totalLeads,
      por_estado: porEstado,
      llamadas_hoy: totalLlamadasHoy,
      limite_hoy: limiteTotalHoy,
      lineas: db.lineas,
      tasa_autorizacion_whatsapp: `${tasaAutorizacion}%`,
      tasa_apertura_propuestas: `${tasaApertura}%`,
      total_robinson: db.robinson.length,
      settings: db.settings,
      produccion: {
        total_leads: realLeads.length,
        por_estado: porEstadoProduccion,
        llamados: totalRealLlamados,
        autorizados: totalRealAutorizados,
        tasa_autorizacion: `${tasaAutorizacionReal}%`,
      },
      simulacion: {
        total_leads: simLeads.length,
        llamados: totalSimLlamados,
        autorizados: totalSimAutorizados,
      },
    };
  }

  /**
   * Parseador de CSV de leads compatible con comillas y delimitadores coma/punto y coma
   */
  public parseCsvLeads(csvContent: string): ImportLeadItem[] {
    const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return [];

    const splitCsvLine = (line: string): string[] => {
      const result: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' || char === "'") {
          inQuotes = !inQuotes;
        } else if ((char === "," || char === ";") && !inQuotes) {
          result.push(current.trim().replace(/^["']|["']$/g, ""));
          current = "";
        } else {
          current += char;
        }
      }
      result.push(current.trim().replace(/^["']|["']$/g, ""));
      return result;
    };

    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const items: ImportLeadItem[] = [];

    const idxNombre = header.findIndex((h) => h.includes("nombre") || h.includes("empresa"));
    const idxTel = header.findIndex((h) => h.includes("telefono") || h.includes("tel") || h.includes("phone"));
    const idxCat = header.findIndex((h) => h.includes("cat") || h.includes("oficio"));
    const idxCiudad = header.findIndex((h) => h.includes("ciudad") || h.includes("poblacion"));
    const idxDir = header.findIndex((h) => h.includes("dir") || h.includes("address"));
    const idxWeb = header.findIndex((h) => h.includes("web") || h.includes("url"));
    const idxPlace = header.findIndex((h) => h.includes("place") || h.includes("id"));

    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      const tel = idxTel >= 0 ? cols[idxTel] : "";
      if (!tel) continue;

      items.push({
        empresa_nombre: idxNombre >= 0 ? cols[idxNombre] : `Empresa ${i}`,
        telefono: tel,
        categoria_maps: idxCat >= 0 ? cols[idxCat] : "Servicios",
        ciudad: idxCiudad >= 0 ? cols[idxCiudad] : "Madrid",
        direccion: idxDir >= 0 ? cols[idxDir] : "",
        web_actual: idxWeb >= 0 ? cols[idxWeb] : "",
        tiene_web_previa: idxWeb >= 0 && Boolean(cols[idxWeb]),
        place_id: idxPlace >= 0 ? cols[idxPlace] : undefined,
      });
    }

    return items;
  }

  /**
   * Métricas comparativas y análisis de A/B Testing entre variantes de guion (Cercano vs Formal)
   */
  public getAbTestMetrics(): any {
    const db = crmStorage.getDb();
    const calls = loadCalls();

    const result = {
      cercano: {
        totalCalls: 0,
        completedCalls: 0,
        whatsappAuthorized: 0,
        whatsappSent: 0,
        proposalsOpened: 0,
        dealsWon: 0,
        authRate: 0,
        openRate: 0,
        avgDurationSeconds: 0,
        topObjections: {} as Record<string, number>,
        sentimentDistribution: {} as Record<string, number>,
      },
      formal: {
        totalCalls: 0,
        completedCalls: 0,
        whatsappAuthorized: 0,
        whatsappSent: 0,
        proposalsOpened: 0,
        dealsWon: 0,
        authRate: 0,
        openRate: 0,
        avgDurationSeconds: 0,
        topObjections: {} as Record<string, number>,
        sentimentDistribution: {} as Record<string, number>,
      },
      winner: "pocos_datos" as "cercano" | "formal" | "empate" | "pocos_datos",
      recommendation: "Realiza más llamadas para acumular significancia estadística en ambas variantes.",
      recentAnalyses: [] as any[],
    };

    let totalDurationCercano = 0;
    let totalDurationFormal = 0;

    for (const call of calls) {
      const v: "cercano" | "formal" = call.scriptVariant === "formal" ? "formal" : "cercano";
      const target = result[v];
      target.totalCalls++;
      if (call.durationSeconds > 15) target.completedCalls++;
      if (call.whatsappAuthorized) target.whatsappAuthorized++;
      if (call.whatsappSent) target.whatsappSent++;

      if (v === "cercano") totalDurationCercano += call.durationSeconds;
      else totalDurationFormal += call.durationSeconds;

      if (call.analysis) {
        const obj = call.analysis.objectionDetected || "ninguna";
        if (obj !== "ninguna") {
          target.topObjections[obj] = (target.topObjections[obj] || 0) + 1;
        }
        const sent = call.analysis.sentiment || "neutral";
        target.sentimentDistribution[sent] = (target.sentimentDistribution[sent] || 0) + 1;
      }
    }

    // Calcular propuestas abiertas y ventas cerradas a partir de los leads en CRM
    for (const lead of db.leads) {
      const v: "cercano" | "formal" = lead.script_variant === "formal" ? "formal" : "cercano";
      const target = result[v];
      if (lead.veces_whatsapp > 0 || lead.estado === "whatsapp_enviado" || lead.estado === "interesado" || lead.estado === "en_negociacion" || lead.estado === "ganado") {
        target.whatsappSent = Math.max(target.whatsappSent, target.whatsappAuthorized);
      }
      if (lead.estado === "interesado" || lead.estado === "en_negociacion" || lead.estado === "ganado") {
        target.proposalsOpened++;
      }
      if (lead.estado === "ganado") {
        target.dealsWon++;
      }
    }

    // Calcular promedios y tasas
    if (result.cercano.totalCalls > 0) {
      result.cercano.authRate = Math.round((result.cercano.whatsappAuthorized / result.cercano.totalCalls) * 100);
      result.cercano.avgDurationSeconds = Math.round(totalDurationCercano / result.cercano.totalCalls);
    }
    if (result.cercano.whatsappSent > 0) {
      result.cercano.openRate = Math.round((result.cercano.proposalsOpened / result.cercano.whatsappSent) * 100);
    }

    if (result.formal.totalCalls > 0) {
      result.formal.authRate = Math.round((result.formal.whatsappAuthorized / result.formal.totalCalls) * 100);
      result.formal.avgDurationSeconds = Math.round(totalDurationFormal / result.formal.totalCalls);
    }
    if (result.formal.whatsappSent > 0) {
      result.formal.openRate = Math.round((result.formal.proposalsOpened / result.formal.whatsappSent) * 100);
    }

    // Evaluar ganador
    if (result.cercano.totalCalls >= 2 && result.formal.totalCalls >= 2) {
      if (result.cercano.authRate > result.formal.authRate + 5) {
        result.winner = "cercano";
        result.recommendation = `La Variante A (Cercano - Google Maps) tiene mayor conversión (+${result.cercano.authRate - result.formal.authRate}% en WhatsApp). Es el guion más eficaz.`;
      } else if (result.formal.authRate > result.cercano.authRate + 5) {
        result.winner = "formal";
        result.recommendation = `La Variante B (Formal - Auditoría) tiene mayor tasa de aceptación (+${result.formal.authRate - result.cercano.authRate}% en WhatsApp). Transmite más autoridad.`;
      } else {
        result.winner = "empate";
        result.recommendation = "Ambas variantes presentan un rendimiento similar. Continúa el test para desempatar con aperturas de propuesta.";
      }
    }

    // Últimos análisis
    result.recentAnalyses = calls
      .filter((c) => c.analysis)
      .slice(0, 15)
      .map((c) => ({
        callId: c.id,
        company: c.company,
        phone: c.phone,
        variant: c.scriptVariant || "cercano",
        sentiment: c.analysis?.sentiment,
        objection: c.analysis?.objectionDetected,
        frictionPoint: c.analysis?.frictionPoint,
        score: c.analysis?.qualityScore,
        summary: c.analysis?.summaryNote,
        timestamp: c.timestamp,
      }));

    return result;
  }
}

export const crmService = new CrmService();
