/**
 * Nexus Leads CRM - Modelos de Datos Multiproducto & Automatización Outbound
 * Versión 1.0 (Octubre 2026)
 */

export type TipoGancho = "muestra_web" | "pdf_oferta" | "descuento_directo" | "otro";

export interface Proyecto {
  id: string;
  nombre: string;
  descripcion?: string;
  webhook_generador: string; // ej. /api/interna/v1/muestras de Forja Web
  tipo_gancho: TipoGancho;
  script_llamada: string;
  plantillas_whatsapp: Record<string, string>;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

export type CampaniaEstado = "activa" | "pausada" | "completada";

export interface CampaniaFiltros {
  ciudad?: string;
  categoria?: string;
  solo_sin_web?: boolean;
  [key: string]: any;
}

export interface Campania {
  id: string;
  proyecto_id: string;
  nombre: string;
  estado: CampaniaEstado;
  criterios_filtro: CampaniaFiltros;
  total_leads?: number;
  created_at: string;
  updated_at: string;
}

export type LeadEstado =
  | "nuevo"              // Importado sin procesar
  | "muestra_generada"   // Propuesta o gancho creado
  | "cola_llamada"       // Listo para que el worker de llamadas lo tome
  | "en_llamada"         // Marcando o llamada en curso (contacto reservado)
  | "llamado"            // Llamada efectuada
  | "cola_whatsapp"      // Autorizó WhatsApp, en cola de envío
  | "enviando_whatsapp"  // En proceso de envío por el consumidor de outbox
  | "whatsapp_enviado"   // Mensaje enviado por worker de WhatsApp
  | "interesado"         // Abrió la muestra o respondió positivamente
  | "en_negociacion"     // Asignado a comercial
  | "ganado"             // Venta cerrada
  | "descartado"         // No interesado / buzón / número inválido
  | "no_contactar";      // Oposición explícita / Lista Robinson

export type LeadCalificacion = "frio" | "tibio" | "caliente" | null;

export interface Lead {
  id: string;
  proyecto_id: string;
  campania_id: string;
  place_id: string;          // Clave única Google Maps para deduplicación
  empresa_nombre: string;
  categoria_maps: string;    // ej. "Fontanero", "Instalador de gas"
  oficio_mapeado: string;    // ej. "fontaneria"
  telefono: string;          // E.164 normalizado (+34...)
  telefono_original: string; // Como venía en Google Maps
  ciudad: string;
  codigo_postal: string;
  direccion: string;
  tiene_web_previa: boolean;
  web_actual: string;
  estado: LeadEstado;
  url_propuesta: string;     // URL generada para mostrar o enviar
  token_seguimiento: string; // Token para tracking de apertura
  veces_llamado: number;
  veces_whatsapp: number;
  calificacion: LeadCalificacion;
  notas: string;
  asignado_a: string;
  ultimo_contacto_at: string | null;
  whatsapp_idempotency_key?: string;
  consentimiento_whatsapp?: boolean;
  evidencia_consentimiento?: string;
  telefono_confirmado?: string;
  transcripcion_resumen?: string;
  script_variant?: "cercano" | "formal";
  analisis_llamada?: any;
  es_simulacion?: boolean;
  created_at: string;
  updated_at: string;
}

export interface PropuestaGenerada {
  id: string;
  lead_id: string;
  proyecto_id: string;
  tipo_gancho: TipoGancho;
  url_publica: string;
  token_seguimiento: string;
  abierta: boolean;
  veces_abierta: number;
  primera_apertura_at: string | null;
  ultima_apertura_at: string | null;
  created_at: string;
}

export type TipoInteraccion = "llamada" | "whatsapp" | "apertura_propuesta" | "nota_comercial" | "cambio_estado";

export interface Interaccion {
  id: string;
  lead_id: string;
  tipo: TipoInteraccion;
  resultado: string; // ej: "autorizo_whatsapp", "rechazo", "no_contesta", "buzon", "duda_precio", "enviado_ok", "apertura", "fallo_marcado", "ocupado", "desconexion", "colgado"
  duracion_segundos?: number;
  resumen_transcripcion?: string;
  linea_usada?: string;
  sessionId?: string;
  es_simulacion?: boolean;
  datos_adicionales?: Record<string, any>;
  created_at: string;
}

export interface LineaTelefonica {
  id: string;
  nombre: string;
  numero: string;
  limite_diario: number;     // Cuota máx diaria (ej: 25 a 30)
  llamadas_hoy: number;
  fecha_contador: string;    // YYYY-MM-DD
  activa: boolean;
  en_uso?: boolean;          // Indica si la línea está físicamente ocupada en una llamada activa
  ultima_llamada_at: string | null;
}

export interface RobinsonEntry {
  telefono: string;          // E.164 normalizado
  motivo: string;
  origen_lead_id?: string | null;
  created_at: string;
}

export interface CrmSettings {
  horario_comercial_inicio: string;       // "09:30"
  horario_comercial_fin_manana: string;   // "13:30"
  horario_comercial_inicio_tarde: string; // "16:00"
  horario_comercial_fin_tarde: string;    // "19:30"
  enforce_horario: boolean;               // false para pruebas/tests, true para producción
  max_llamadas_por_linea: number;         // 30
  dias_laborables: number[];              // [1,2,3,4,5] (1=Lunes, 7=Domingo)
  whatsapp_mensajes_hoy?: number;         // Contador persistente de WhatsApp
  whatsapp_fecha_contador?: string;       // YYYY-MM-DD
}

export interface CrmDatabase {
  proyectos: Proyecto[];
  campanias: Campania[];
  leads: Lead[];
  propuestas: PropuestaGenerada[];
  interacciones: Interaccion[];
  lineas: LineaTelefonica[];
  robinson: RobinsonEntry[];
  settings: CrmSettings;
}

export interface ImportLeadItem {
  place_id?: string;
  empresa_nombre: string;
  categoria_maps?: string;
  oficio_mapeado?: string;
  telefono: string;
  ciudad?: string;
  codigo_postal?: string;
  direccion?: string;
  tiene_web_previa?: boolean;
  web_actual?: string;
  notas?: string;
}

export interface ImportResult {
  total_recibidos: number;
  importados_nuevos: number;
  duplicados_omitidos: number;
  robinson_bloqueados: number;
  telefonos_invalidos: number;
  leads_creados: Lead[];
  errores: Array<{ lead: ImportLeadItem; razon: string }>;
}

export interface CallQueueItem {
  callId: string;
  lead: Lead;
  linea: LineaTelefonica;
  script: string;
  proyecto: Proyecto;
}

export interface CallOutcomePayload {
  callId?: string;
  lead_id: string;
  linea_id?: string;
  resultado:
    | "autorizo_whatsapp"
    | "rechazo"
    | "no_contesta"
    | "buzon"
    | "numero_invalido"
    | "volver_a_llamar"
    | "ocupado"
    | "fallo_marcado"
    | "desconexion"
    | "colgado"
    | "otro";
  whatsappAuthorized: boolean;
  telefono_confirmado?: string;
  evidence_quote?: string;
  transcripcion?: string;
  sessionId?: string;
  es_simulacion?: boolean;
  duracion_segundos?: number;
  resumen?: string;
  agregar_a_robinson?: boolean;
  motivo_robinson?: string;
}

export interface WhatsAppQueueItem {
  lead: Lead;
  mensaje: string;
  url_propuesta: string;
  proyecto: Proyecto;
  idempotency_key?: string;
}

export interface WhatsAppOutcomePayload {
  lead_id: string;
  success: boolean;
  error?: string;
  mensaje_enviado?: string;
  es_simulacion?: boolean;
}
