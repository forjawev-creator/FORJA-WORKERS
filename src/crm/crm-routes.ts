import { requestWhatsAppControl } from "../whatsapp/service-control.js";
import { requireControl } from "../control-auth.js";
import http from "http";
import fs from "fs";
import path from "path";
import { crmStorage } from "./crm-storage.js";
import { crmService, normalizeSpanishPhone } from "./crm-service.js";
import {
  Proyecto,
  Campania,
  Lead,
  LineaTelefonica,
  CallOutcomePayload,
  WhatsAppOutcomePayload,
  ImportLeadItem,
} from "./types.js";
import { callWorker } from "./call-worker.js";
import { whatsAppWorker } from "./whatsapp-worker.js";
import { orchestrator } from "./orchestrator.js";
import { hookGenerator } from "./hook-generator.js";
import { baileysWhatsAppService } from "../whatsapp/baileys-service.js";
import { loadConfig, saveConfig } from "../storage.js";
import { ScriptVariant } from "../types.js";
import { getPublicBaseUrl, getLocalIpAddress } from "../web-server.js";

function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : ({} as T));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function parseTextBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sendJson(res: http.ServerResponse, status: number, data: any, origin?: string): void {
  const allowOrigin = isAllowedOrigin(origin) && origin ? origin : "http://127.0.0.1:3000";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

export async function handleCrmRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL
): Promise<boolean> {
  const publicProposal = req.method === "GET" && pathname.startsWith("/api/crm/propuesta/");
  if (pathname.startsWith("/api/") && !publicProposal && !requireControl(req, res)) return true;
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    if (req.method === "OPTIONS" || req.method === "POST" || req.method === "PATCH" || req.method === "DELETE" || req.method === "PUT") {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Origen no autorizado en entorno CRM local." }));
      return true;
    }
  }

  // CORS Preflight
  if (req.method === "OPTIONS" && (pathname.startsWith("/api/crm") || pathname.startsWith("/api/whatsapp") || pathname === "/crm")) {
    const allowOrigin = isAllowedOrigin(origin) && origin ? origin : "http://127.0.0.1:3000";
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  // 1. Servir interfaz de CRM Kanban
  if (pathname === "/crm" || pathname === "/crm.html") {
    const crmHtmlPath = path.resolve(process.cwd(), "public", "crm.html");
    if (fs.existsSync(crmHtmlPath)) {
      fs.readFile(crmHtmlPath, "utf-8", (err, content) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error cargando CRM Dashboard");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        res.end(content);
      });
      return true;
    }
  }

  // 2. Tracking de apertura de propuestas
  if (pathname.startsWith("/api/crm/propuesta/")) {
    const token = pathname.replace("/api/crm/propuesta/", "");
    const tracked = crmService.trackProposalOpen(token);

    if (req.headers.accept?.includes("application/json")) {
      sendJson(res, tracked.success ? 200 : 404, tracked);
      return true;
    }

    // Renderizar página de muestra para el cliente
    const lead = tracked.lead;
    const dbForProposal = crmStorage.getDb();
    const proyecto = lead ? dbForProposal.proyectos.find((p) => p.id === lead.proyecto_id) : dbForProposal.proyectos[0];
    const contactPhoneRaw = process.env.PUBLIC_CONTACT_PHONE || process.env.WHATSAPP_PHONE || (proyecto as any)?.configuracion?.telefono_remitente || (dbForProposal.lineas && dbForProposal.lineas[0]?.numero) || "34612345678";
    const contactPhone = normalizeSpanishPhone(contactPhoneRaw) ? normalizeSpanishPhone(contactPhoneRaw)!.replace(/^\+/, "") : contactPhoneRaw.replace(/[^0-9]/g, "");

    const rawEmpresaNombre = lead ? lead.empresa_nombre : "Tu Empresa";
    const rawOficio = lead ? lead.oficio_mapeado || lead.categoria_maps : "Servicios Profesionales";
    const safeEmpresaNombre = escapeHtml(rawEmpresaNombre);
    const safeOficio = escapeHtml(rawOficio);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${safeEmpresaNombre} • Muestra Web Interactiva</title>
  <style>
    :root {
      --primary: #2563eb;
      --accent: #10b981;
      --bg: #0b1329;
      --card: #152238;
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; padding-bottom: 90px; }
    .header { background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%); border-bottom: 1px solid #334155; padding: 1.25rem 1rem; text-align: center; }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); padding: 4px 12px; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .hero { padding: 2rem 1.25rem; text-align: center; max-width: 600px; margin: 0 auto; }
    .hero h1 { font-size: 1.85rem; font-weight: 800; color: #fff; margin: 0.75rem 0 0.5rem; line-height: 1.2; }
    .hero p { color: var(--muted); font-size: 1.05rem; }
    .card { background: var(--card); border: 1px solid #1e293b; border-radius: 16px; padding: 1.5rem; margin: 1rem 1.25rem; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
    .feature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 1rem; }
    .feature-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 1rem; text-align: center; }
    .feature-icon { font-size: 1.6rem; margin-bottom: 0.25rem; }
    .feature-title { font-size: 0.9rem; font-weight: 600; color: #e2e8f0; }
    .price-box { background: linear-gradient(135deg, rgba(37,99,235,0.15) 0%, rgba(16,185,129,0.15) 100%); border: 1px solid rgba(37,99,235,0.3); border-radius: 14px; padding: 1.25rem; text-align: center; margin: 1.25rem 0; }
    .price-tag { font-size: 2rem; font-weight: 800; color: #38bdf8; }
    .price-sub { font-size: 0.85rem; color: #cbd5e1; margin-top: 0.25rem; }
    .floating-bar { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(12px); border-top: 1px solid #334155; padding: 0.85rem 1.25rem; display: flex; justify-content: center; z-index: 100; box-shadow: 0 -10px 25px rgba(0,0,0,0.5); }
    .cta-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; max-width: 500px; background: #25d366; color: #fff; font-size: 1.1rem; font-weight: 700; text-decoration: none; padding: 14px 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(37,211,102,0.4); text-align: center; }
    .footer { text-align: center; font-size: 0.8rem; color: #64748b; padding: 1.5rem 1rem 0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="badge">✨ Propuesta Exclusiva para tu Negocio</div>
  </div>

  <div class="hero">
    <h1>${safeEmpresaNombre}</h1>
    <p>Portal web profesional de <strong>${safeOficio}</strong> diseñado para captar clientes en Google y móvil.</p>
  </div>

  <div class="card">
    <h3 style="color: #38bdf8; margin-bottom: 0.5rem;">📱 Adaptada 100% para tu Negocio</h3>
    <p style="color: #cbd5e1; font-size: 0.95rem;">Esta es la muestra interactiva previa que preparamos para ti. Con esta web tus clientes locales podrán encontrarte y llamarte con un solo toque.</p>
    
    <div class="feature-grid">
      <div class="feature-item">
        <div class="feature-icon">📍</div>
        <div class="feature-title">Posicionamiento Google Maps</div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">⚡</div>
        <div class="feature-title">Carga Rápida en Móvil</div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">💬</div>
        <div class="feature-title">Botón WhatsApp Directo</div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">🔒</div>
        <div class="feature-title">Dominio y SSL Incluido</div>
      </div>
    </div>

    <div class="price-box">
      <div class="price-tag">99 € <span style="font-size: 1rem; font-weight: 400; color: #94a3b8;">instalación</span></div>
      <div class="price-sub">y solo 10 €/mes de mantenimiento integral con todo incluido. Sin permanencia.</div>
    </div>
  </div>

  <div class="footer">
    Forja Web • Propuesta personalizada para ${safeEmpresaNombre}<br>
    Pulsa abajo para confirmar que te gusta o resolver cualquier duda.
  </div>

  <div class="floating-bar">
    <a href="https://wa.me/${contactPhone}?text=Hola,%20he%20visto%20la%20muestra%20web%20de%20${encodeURIComponent(safeEmpresaNombre)}%20y%20me%20interesa%20activarla" class="cta-btn">
      💬 Confirmar y Activar por WhatsApp
    </a>
  </div>
</body>
</html>
    `);
    return true;
  }

  // Rutas bajo /api/crm/* o /api/whatsapp/*
  if (!pathname.startsWith("/api/crm") && !pathname.startsWith("/api/whatsapp")) {
    return false;
  }

  const db = crmStorage.getDb();

  // 3. Métricas A/B Testing e Inteligencia de Conversaciones
  if (pathname === "/api/crm/ab-metrics" && req.method === "GET") {
    sendJson(res, 200, crmService.getAbTestMetrics());
    return true;
  }

  // 3.1 Selector y configuración de variante de guión (Cercano / Formal / A/B Test)
  if (pathname === "/api/crm/script-variant") {
    if (req.method === "GET") {
      const cfg = loadConfig();
      sendJson(res, 200, {
        scriptVariant: cfg.scriptVariant || "cercano",
        publicBaseUrl: getPublicBaseUrl(3000),
        localIp: getLocalIpAddress(),
      });
      return true;
    } else if (req.method === "POST") {
      const body = await parseJsonBody<{ scriptVariant?: ScriptVariant; publicBaseUrl?: string }>(req);
      const cfg = loadConfig();
      if (body.scriptVariant) {
        cfg.scriptVariant = body.scriptVariant;
      }
      if (body.publicBaseUrl !== undefined) {
        cfg.publicBaseUrl = body.publicBaseUrl.trim();
      }
      saveConfig(cfg);
      sendJson(res, 200, {
        success: true,
        scriptVariant: cfg.scriptVariant,
        publicBaseUrl: cfg.publicBaseUrl || getPublicBaseUrl(3000),
      });
      return true;
    }
  }

  // 4. Estadísticas del embudo y cuotas
  if (pathname === "/api/crm/estadisticas" && req.method === "GET") {
    sendJson(res, 200, crmService.getFunnelStats());
    return true;
  }

  // 4. Configuración del CRM
  if (pathname === "/api/crm/settings") {
    if (req.method === "GET") {
      sendJson(res, 200, db.settings);
      return true;
    } else if (req.method === "POST" || req.method === "PATCH") {
      const body = await parseJsonBody<any>(req);
      db.settings = { ...db.settings, ...body };
      crmStorage.save();
      sendJson(res, 200, { success: true, settings: db.settings });
      return true;
    }
  }

  // 5. Proyectos
  if (pathname === "/api/crm/proyectos") {
    if (req.method === "GET") {
      sendJson(res, 200, db.proyectos);
      return true;
    } else if (req.method === "POST") {
      const body = await parseJsonBody<Proyecto>(req);
      const existingIdx = db.proyectos.findIndex((p) => p.id === body.id);
      const now = new Date().toISOString();
      if (existingIdx >= 0) {
        db.proyectos[existingIdx] = { ...db.proyectos[existingIdx], ...body, updated_at: now };
      } else {
        const nuevoProyecto: Proyecto = {
          id: body.id || `proy_${Date.now()}`,
          nombre: body.nombre || "Nuevo Proyecto",
          descripcion: body.descripcion || "",
          webhook_generador: body.webhook_generador || "",
          tipo_gancho: body.tipo_gancho || "muestra_web",
          script_llamada: body.script_llamada || "",
          plantillas_whatsapp: body.plantillas_whatsapp || { default: "Hola {{nombre}}: {{enlace}}" },
          activo: body.activo ?? true,
          created_at: now,
          updated_at: now,
        };
        db.proyectos.push(nuevoProyecto);
      }
      crmStorage.save();
      sendJson(res, 200, { success: true, proyectos: db.proyectos });
      return true;
    }
  }

  // 6. Campañas
  if (pathname === "/api/crm/campanias") {
    if (req.method === "GET") {
      sendJson(res, 200, db.campanias);
      return true;
    } else if (req.method === "POST") {
      const body = await parseJsonBody<Campania>(req);
      const existingIdx = db.campanias.findIndex((c) => c.id === body.id);
      const now = new Date().toISOString();
      if (existingIdx >= 0) {
        db.campanias[existingIdx] = { ...db.campanias[existingIdx], ...body, updated_at: now };
      } else {
        const nuevaCampania: Campania = {
          id: body.id || `camp_${Date.now()}`,
          proyecto_id: body.proyecto_id || (db.proyectos[0]?.id ?? "forja-web"),
          nombre: body.nombre || "Nueva Campaña",
          estado: body.estado || "activa",
          criterios_filtro: body.criterios_filtro || {},
          total_leads: 0,
          created_at: now,
          updated_at: now,
        };
        db.campanias.push(nuevaCampania);
      }
      crmStorage.save();
      sendJson(res, 200, { success: true, campanias: db.campanias });
      return true;
    }
  }

  // 7. Leads - Listado y filtrado
  if (pathname === "/api/crm/leads" && req.method === "GET") {
    const proyectoId = url.searchParams.get("proyecto_id");
    const campaniaId = url.searchParams.get("campania_id");
    const estado = url.searchParams.get("estado");
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();

    let list = db.leads;
    if (proyectoId) list = list.filter((l) => l.proyecto_id === proyectoId);
    if (campaniaId) list = list.filter((l) => l.campania_id === campaniaId);
    if (estado) list = list.filter((l) => l.estado === estado);
    if (q) {
      list = list.filter(
        (l) =>
          l.empresa_nombre.toLowerCase().includes(q) ||
          l.telefono.includes(q) ||
          l.ciudad.toLowerCase().includes(q) ||
          l.oficio_mapeado.toLowerCase().includes(q)
      );
    }

    sendJson(res, 200, list);
    return true;
  }

  // 8. Ingestión masiva de Leads (JSON o CSV)
  if (pathname === "/api/crm/leads/importar" && req.method === "POST") {
    try {
      const contentType = req.headers["content-type"] || "";
      const proyectoId = url.searchParams.get("proyecto_id") || db.proyectos[0]?.id || "forja-web";
      const campaniaId = url.searchParams.get("campania_id") || db.campanias[0]?.id || "campania-madrid-fontaneria";

      let items: ImportLeadItem[] = [];

      if (contentType.includes("application/json")) {
        const body = await parseJsonBody<any>(req);
        if (Array.isArray(body)) {
          items = body;
        } else if (body.leads && Array.isArray(body.leads)) {
          items = body.leads;
        } else {
          items = [body];
        }
      } else {
        // Asumir CSV o texto delimitado
        const csvText = await parseTextBody(req);
        items = crmService.parseCsvLeads(csvText);
      }

      const result = crmService.importLeads(items, proyectoId, campaniaId);
      sendJson(res, 200, result);
      return true;
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err.message });
      return true;
    }
  }

  // 9. Actualización / Borrado de un lead
  if (pathname.startsWith("/api/crm/leads/")) {
    const id = pathname.replace("/api/crm/leads/", "");

    if (req.method === "PATCH") {
      const body = await parseJsonBody<Partial<Lead>>(req);
      const lead = db.leads.find((l) => l.id === id);
      if (!lead) {
        sendJson(res, 404, { success: false, error: "Lead no encontrado" });
        return true;
      }
      Object.assign(lead, body, { updated_at: new Date().toISOString() });
      crmStorage.save();
      sendJson(res, 200, { success: true, lead });
      return true;
    }

    if (req.method === "DELETE") {
      const idx = db.leads.findIndex((l) => l.id === id);
      if (idx === -1) {
        sendJson(res, 404, { success: false, error: "Lead no encontrado" });
        return true;
      }
      db.leads.splice(idx, 1);
      crmStorage.save();
      sendJson(res, 200, { success: true, message: "Lead eliminado" });
      return true;
    }
  }

  // 10. Worker de Llamadas - Cola: Siguiente
  if (pathname === "/api/crm/cola/llamada/siguiente" && req.method === "GET") {
    const lineaId = url.searchParams.get("linea_id") || undefined;
    const campaniaId = url.searchParams.get("campania_id") || undefined;
    const overrideHorario = url.searchParams.get("override_horario") === "true";

    const nextCall = crmService.getNextCallLead({ lineaId, campaniaId, overrideHorario });
    if (nextCall.error) {
      sendJson(res, 400, { success: false, message: nextCall.error });
    } else {
      sendJson(res, 200, { success: true, ...nextCall.item });
    }
    return true;
  }

  // 11. Worker de Llamadas - Reporte de Resultado
  if (pathname === "/api/crm/cola/llamada/resultado" && req.method === "POST") {
    try {
      const body = await parseJsonBody<CallOutcomePayload>(req);
      const outcome = crmService.recordCallOutcome(body);
      sendJson(res, 200, outcome);
      return true;
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err.message });
      return true;
    }
  }

  // 12. Worker de WhatsApp - Cola: Siguiente
  if (pathname === "/api/crm/cola/whatsapp/siguiente" && req.method === "GET") {
    const nextWa = crmService.getNextWhatsAppLead();
    if (nextWa.error) {
      sendJson(res, 404, { success: false, message: nextWa.error });
    } else {
      sendJson(res, 200, { success: true, ...nextWa.item });
    }
    return true;
  }

  // 13. Worker de WhatsApp - Reporte de Resultado
  if (pathname === "/api/crm/cola/whatsapp/resultado" && req.method === "POST") {
    try {
      const body = await parseJsonBody<WhatsAppOutcomePayload>(req);
      const outcome = crmService.recordWhatsAppOutcome(body);
      sendJson(res, 200, outcome);
      return true;
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err.message });
      return true;
    }
  }

  // 14. Lista Robinson
  if (pathname === "/api/crm/robinson") {
    if (req.method === "GET") {
      sendJson(res, 200, db.robinson);
      return true;
    } else if (req.method === "POST") {
      const body = await parseJsonBody<{ telefono: string; motivo?: string }>(req);
      const normalized = normalizeSpanishPhone(body.telefono);
      if (!normalized) {
        sendJson(res, 400, { success: false, error: "Teléfono inválido para Lista Robinson" });
        return true;
      }
      const entry = crmStorage.addToRobinson(
        normalized,
        body.motivo || "Añadido manualmente al CRM",
        null
      );
      sendJson(res, 200, { success: true, entry });
      return true;
    }
  }

  if (pathname.startsWith("/api/crm/robinson/") && req.method === "DELETE") {
    const rawTel = pathname.replace("/api/crm/robinson/", "");
    const decodedTel = decodeURIComponent(rawTel);
    const idx = db.robinson.findIndex((r) => r.telefono === decodedTel);
    if (idx >= 0) {
      db.robinson.splice(idx, 1);
      crmStorage.save();
      sendJson(res, 200, { success: true, message: "Eliminado de Lista Robinson" });
    } else {
      sendJson(res, 404, { success: false, error: "No encontrado en Lista Robinson" });
    }
    return true;
  }

  // 15. Líneas Telefónicas & Cuotas
  if (pathname === "/api/crm/lineas") {
    if (req.method === "GET") {
      crmStorage.checkAndResetDailyQuotas();
      sendJson(res, 200, db.lineas);
      return true;
    } else if (req.method === "POST") {
      const body = await parseJsonBody<LineaTelefonica>(req);
      const existing = db.lineas.find((l) => l.id === body.id);
      if (existing) {
        Object.assign(existing, body);
      } else {
        db.lineas.push({
          id: body.id || `linea_${db.lineas.length + 1}`,
          nombre: body.nombre || "Nueva Línea",
          numero: body.numero || "",
          limite_diario: body.limite_diario || 30,
          llamadas_hoy: 0,
          fecha_contador: new Date().toISOString().split("T")[0],
          activa: body.activa ?? true,
          ultima_llamada_at: null,
        });
      }
      crmStorage.save();
      sendJson(res, 200, { success: true, lineas: db.lineas });
      return true;
    }
  }

  // 16. Worker de Llamadas Automáticas
  if (pathname === "/api/crm/worker/calls/start" && req.method === "POST") {
    sendJson(res, 200, callWorker.start());
    return true;
  }
  if (pathname === "/api/crm/worker/calls/stop" && req.method === "POST") {
    sendJson(res, 200, await callWorker.stop());
    return true;
  }
  if (pathname === "/api/crm/worker/calls/status" && req.method === "GET") {
    sendJson(res, 200, callWorker.getStatus());
    return true;
  }
  if (pathname === "/api/crm/worker/calls/config" && req.method === "POST") {
    const body = await parseJsonBody<any>(req);
    sendJson(res, 200, { success: true, config: callWorker.setConfig(body) });
    return true;
  }

  // 17. Worker de WhatsApp Automático
  if (pathname === "/api/crm/worker/whatsapp/start" && req.method === "POST") {
    sendJson(res, 200, whatsAppWorker.start());
    return true;
  }
  if (pathname === "/api/crm/worker/whatsapp/stop" && req.method === "POST") {
    sendJson(res, 200, await whatsAppWorker.stop());
    return true;
  }
  if (pathname === "/api/crm/worker/whatsapp/status" && req.method === "GET") {
    sendJson(res, 200, whatsAppWorker.getStatus());
    return true;
  }
  if (pathname === "/api/crm/worker/whatsapp/config" && req.method === "POST") {
    const body = await parseJsonBody<any>(req);
    sendJson(res, 200, { success: true, config: whatsAppWorker.setConfig(body) });
    return true;
  }

  // 18. Orquestador Comercial Completo
  if (pathname === "/api/crm/orchestrator/start" && req.method === "POST") {
    const body = await parseJsonBody<{ campaignId?: string }>(req).catch(() => ({ campaignId: undefined }));
    sendJson(res, 200, orchestrator.start(body.campaignId));
    return true;
  }
  if (pathname === "/api/crm/orchestrator/stop" && req.method === "POST") {
    sendJson(res, 200, await orchestrator.stop());
    return true;
  }
  if (pathname === "/api/crm/orchestrator/status" && req.method === "GET") {
    sendJson(res, 200, orchestrator.getStatus());
    return true;
  }

  // 19. Generación manual de gancho para un lead
  if (pathname.startsWith("/api/crm/leads/") && pathname.endsWith("/generar-gancho") && req.method === "POST") {
    const leadId = pathname.replace("/api/crm/leads/", "").replace("/generar-gancho", "");
    const lead = db.leads.find((l) => l.id === leadId);
    if (!lead) {
      sendJson(res, 404, { success: false, error: "Lead no encontrado" });
      return true;
    }
    const proyecto = db.proyectos.find((p) => p.id === lead.proyecto_id) || db.proyectos[0];
    const hook = await hookGenerator.generateHook(lead, proyecto);
    sendJson(res, 200, hook);
    return true;
  }

  // 20. Control de Línea WhatsApp Nativa (Baileys + Código QR)
  if (pathname === "/api/whatsapp/status" && req.method === "GET") {
    const statusFile = path.resolve(process.cwd(), "data", "whatsapp-status.json");
    if (fs.existsSync(statusFile)) {
      try {
        const raw = fs.readFileSync(statusFile, "utf-8");
        const statusData = JSON.parse(raw);
        if (Date.now() - Date.parse(statusData.updatedAt) > 10_000 || !Number.isFinite(Date.parse(statusData.updatedAt))) throw new Error("Estado obsoleto");
        sendJson(res, 200, statusData);
        return true;
      } catch {}
    }
    sendJson(res, 200, baileysWhatsAppService.getStatus());
    return true;
  }

  if (pathname === "/api/whatsapp/connect" && req.method === "POST") {
    const body = await parseJsonBody<{ forceNew?: boolean }>(req).catch(() => ({ forceNew: false }));
    const status = whatsAppWorker.isExternalService() ? await requestWhatsAppControl({ action: "connect", forceNew: Boolean(body.forceNew) }) : await baileysWhatsAppService.startConnection(Boolean(body.forceNew));
    sendJson(res, 200, status);
    return true;
  }

  if (pathname === "/api/whatsapp/logout" && req.method === "POST") {
    await whatsAppWorker.stop();
    if (whatsAppWorker.isExternalService()) await requestWhatsAppControl({ action: "logout" });
    else await baileysWhatsAppService.logout();
    sendJson(res, 200, { success: true, message: "Sesión de WhatsApp cerrada" });
    return true;
  }

  if (pathname === "/api/whatsapp/test" && req.method === "POST") {
    const body = await parseJsonBody<{ phone: string; message?: string }>(req);
    if (!body.phone) {
      sendJson(res, 400, { success: false, error: "Teléfono requerido" });
      return true;
    }
    const msg = body.message || "¡Hola! Este es un mensaje de prueba desde el Bot de Llamadas Forja Web.";
    const result = whatsAppWorker.isExternalService() ? await requestWhatsAppControl({ action: "test", phone: body.phone, message: msg }) : await baileysWhatsAppService.sendMessage(body.phone, msg);
    sendJson(res, result.success ? 200 : 400, result);
    return true;
  }

  // Ruta API no encontrada
  sendJson(res, 404, { success: false, error: `Ruta CRM no encontrada: ${pathname}` });
  return true;
}
