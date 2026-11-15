import crypto from "crypto";
import { crmStorage } from "./crm-storage.js";
import { Lead, PropuestaGenerada, Proyecto } from "./types.js";

export interface HookGenerationResult {
  success: boolean;
  urlPropuesta: string;
  tokenSeguimiento: string;
  propuesta: PropuestaGenerada;
  error?: string;
}

export class HookGenerator {
  /**
   * Genera el gancho o propuesta comercial (boceto interactivo Forja Web o landing)
   */
  public async generateHook(
    lead: Lead,
    proyecto: Proyecto
  ): Promise<HookGenerationResult> {
    const token = `tok_${crypto.randomBytes(6).toString("hex")}`;
    const now = new Date().toISOString();

    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    const port = process.env.PORT || "3000";
    const baseOrigin = publicBaseUrl || (process.env.NODE_ENV === "production" ? "" : `http://localhost:${port}`);

    let urlPublica = baseOrigin ? `${baseOrigin}/api/crm/propuesta/${token}` : `/api/crm/propuesta/${token}`;

    // Si el proyecto tiene un webhook configurado para generador determinista (ej. Forja Web)
    const isDefaultLocalPlaceholder = proyecto.webhook_generador === "http://localhost:3001/api/interna/v1/muestras";
    if (proyecto.webhook_generador && proyecto.webhook_generador.startsWith("http")) {
      try {
        const response = await fetch(proyecto.webhook_generador, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nombre: lead.empresa_nombre,
            telefono: lead.telefono,
            categoria: lead.categoria_maps,
            oficio: lead.oficio_mapeado,
            ciudad: lead.ciudad,
            tiene_web: lead.tiene_web_previa,
            token_seguimiento: token,
          }),
        });

        if (response.ok) {
          const json = (await response.json()) as any;
          if (json && (json.success === false || json.error)) {
            return {
              success: false,
              urlPropuesta: "",
              tokenSeguimiento: token,
              propuesta: {} as any,
              error: `El generador de propuestas devolvió un error: ${json.error || "Fallo en generación"}`,
            };
          }
          if (json && json.url) {
            urlPublica = json.url;
          }
        } else {
          return {
            success: false,
            urlPropuesta: "",
            tokenSeguimiento: token,
            propuesta: {} as any,
            error: `El generador de propuestas (${proyecto.webhook_generador}) devolvió HTTP ${response.status}.`,
          };
        }
      } catch (e: any) {
        if (!isDefaultLocalPlaceholder) {
          return {
            success: false,
            urlPropuesta: "",
            tokenSeguimiento: token,
            propuesta: {} as any,
            error: `Fallo al conectar con el generador de propuestas (${proyecto.webhook_generador}): ${e.message}`,
          };
        }
        console.warn(`[HookGenerator] Webhook local por defecto ${proyecto.webhook_generador} no activo. Usando generador interno integrado.`);
      }
    }

    // Asegurar que la URL pública sea 100% absoluta (nunca una ruta relativa incompleta)
    if (!urlPublica.startsWith("http://") && !urlPublica.startsWith("https://")) {
      if (publicBaseUrl) {
        urlPublica = `${publicBaseUrl}${urlPublica.startsWith("/") ? "" : "/"}${urlPublica}`;
      } else if (process.env.NODE_ENV === "production") {
        return {
          success: false,
          urlPropuesta: "",
          tokenSeguimiento: token,
          propuesta: {} as any,
          error: "PUBLIC_BASE_URL no está configurada. Se requiere una URL pública absoluta (HTTPS) para compartir la propuesta por WhatsApp.",
        };
      } else {
        urlPublica = `http://localhost:${port}${urlPublica.startsWith("/") ? "" : "/"}${urlPublica}`;
      }
    }

    const propuesta: PropuestaGenerada = {
      id: `prop_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      lead_id: lead.id,
      proyecto_id: proyecto.id,
      tipo_gancho: proyecto.tipo_gancho,
      url_publica: urlPublica,
      token_seguimiento: token,
      abierta: false,
      veces_abierta: 0,
      primera_apertura_at: null,
      ultima_apertura_at: null,
      created_at: now,
    };

    const db = crmStorage.getDb();
    db.propuestas.push(propuesta);
    lead.url_propuesta = urlPublica;
    lead.token_seguimiento = token;
    lead.updated_at = now;
    crmStorage.save();

    return {
      success: true,
      urlPropuesta: urlPublica,
      tokenSeguimiento: token,
      propuesta,
    };
  }
}

export const hookGenerator = new HookGenerator();
