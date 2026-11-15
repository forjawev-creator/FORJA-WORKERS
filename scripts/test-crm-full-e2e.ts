/**
 * Suite de Pruebas de Integración E2E - Fases 2, 3 y 4 de Nexus Leads CRM
 * Valida los Workers (Calls, WhatsApp), el Orquestador Comercial, el Ciclo de Vida Completo del Lead,
 * y la Integración de UI & Assets contra http://127.0.0.1:3000.
 */

const BASE_URL = process.env.CRM_TEST_URL || "http://127.0.0.1:3000";

interface TestStepResult {
  suite: string;
  id: string;
  name: string;
  status: "PASS" | "FAIL";
  details: string;
  durationMs: number;
}

const results: TestStepResult[] = [];

function recordResult(suite: string, id: string, name: string, status: "PASS" | "FAIL", details: string, start: number) {
  const durationMs = Date.now() - start;
  results.push({ suite, id, name, status, details, durationMs });
  const icon = status === "PASS" ? "✅ [PASS]" : "❌ [FAIL]";
  console.log(`${icon} (${durationMs}ms) [${suite}] ${id}: ${name}`);
  if (details) {
    console.log(`   └─ ${details}`);
  }
}

async function requestJson<T = any>(endpoint: string, options: RequestInit = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });
  let data: any = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function requestText(endpoint: string, options: RequestInit = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE_URL}${endpoint}`, options);
  const text = await res.text();
  return { status: res.status, text };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLeadState(leadId: string, targetState: string, timeoutMs = 12000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, data: leads } = await requestJson<any[]>("/api/crm/leads");
    if (status === 200 && Array.isArray(leads)) {
      const found = leads.find((l) => l.id === leadId);
      if (found && found.estado === targetState) {
        return found;
      }
    }
    await sleep(400);
  }
  // Último intento antes de fallar
  const { data: leads } = await requestJson<any[]>("/api/crm/leads");
  const found = Array.isArray(leads) ? leads.find((l) => l.id === leadId) : null;
  throw new Error(`Timeout (${timeoutMs}ms) esperando estado '${targetState}'. Estado actual: '${found?.estado || "no encontrado"}'`);
}

async function runFullE2e() {
  console.log("\n===============================================================================");
  console.log("   NEXUS LEADS CRM - AUDITORÍA Y VERIFICACIÓN COMPLETA (FASES 2, 3 Y 4)");
  console.log(`   Target Server: ${BASE_URL}`);
  console.log(`   Timestamp: ${new Date().toISOString()}`);
  console.log("===============================================================================\n");

  let serverInstance: any = null;
  try {
    const probe = await fetch(`${BASE_URL}/api/config`);
    if (!probe.ok && probe.status >= 500) throw new Error("Server not ready");
  } catch {
    console.log("Iniciando servidor web integrado para pruebas E2E en http://127.0.0.1:3000...");
    const { startWebServer } = await import("../src/web-server.js");
    serverInstance = startWebServer();
    await sleep(1000);
  }

  // PRE-CLEANUP: Garantizar estado limpio y seguro
  try {
    console.log("🧹 Limpieza preventiva y detención de procesos previos...");
    await requestJson("/api/crm/orchestrator/stop", { method: "POST" }).catch(() => {});
    await requestJson("/api/crm/worker/calls/stop", { method: "POST" }).catch(() => {});
    await requestJson("/api/crm/worker/whatsapp/stop", { method: "POST" }).catch(() => {});

    const { data: leads } = await requestJson<any[]>("/api/crm/leads");
    if (Array.isArray(leads)) {
      for (const l of leads) {
        if (l.place_id === "ChIJ_FULL_E2E_1") {
          await requestJson(`/api/crm/leads/${l.id}`, { method: "DELETE" });
        }
      }
    }
    console.log("   Listo. Entorno estabilizado.\n");
  } catch (e: any) {
    console.warn("   Aviso en preparación:", e.message);
  }

  // =========================================================================
  // BLOQUE 1: Pruebas de APIs de Workers y Orquestador
  // =========================================================================
  console.log("▶ BLOQUE 1: Pruebas Unitarias de APIs de Workers y Orquestador\n");

  // 1.1 GET /api/crm/worker/calls/status
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/worker/calls/status");
      if (status === 200 && typeof data.running === "boolean" && data.config) {
        recordResult("WORKERS", "W1.1", "GET /api/crm/worker/calls/status", "PASS", `Status 200. running=${data.running}, mode=${data.config.mode}`, start);
      } else {
        recordResult("WORKERS", "W1.1", "GET /api/crm/worker/calls/status", "FAIL", `Respuesta inesperada: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.1", "GET /api/crm/worker/calls/status", "FAIL", err.message, start);
    }
  }

  // 1.2 POST /api/crm/worker/calls/config
  {
    const start = Date.now();
    try {
      const configPayload = { pollIntervalMs: 1000, callCooldownMs: 1000, mode: "simulation", overrideHorario: true };
      const { status, data } = await requestJson("/api/crm/worker/calls/config", {
        method: "POST",
        body: JSON.stringify(configPayload),
      });

      if (status === 200 && data.success && data.config?.pollIntervalMs === 1000 && data.config?.mode === "simulation") {
        recordResult("WORKERS", "W1.2", "POST /api/crm/worker/calls/config", "PASS", `Config aplicada: poll=1000ms, cooldown=1000ms, mode=simulation`, start);
      } else {
        recordResult("WORKERS", "W1.2", "POST /api/crm/worker/calls/config", "FAIL", `Error configurando: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.2", "POST /api/crm/worker/calls/config", "FAIL", err.message, start);
    }
  }

  // 1.3 POST /api/crm/worker/calls/start y verificación
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/worker/calls/start", { method: "POST" });
      const { data: statusData } = await requestJson("/api/crm/worker/calls/status");

      if (status === 200 && data.success && statusData.running === true) {
        recordResult("WORKERS", "W1.3", "POST /api/crm/worker/calls/start", "PASS", `Worker de llamadas iniciado. status.running=true`, start);
      } else {
        recordResult("WORKERS", "W1.3", "POST /api/crm/worker/calls/start", "FAIL", `No arrancó correctamente: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.3", "POST /api/crm/worker/calls/start", "FAIL", err.message, start);
    }
  }

  // 1.4 POST /api/crm/worker/calls/stop y verificación
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/worker/calls/stop", { method: "POST" });
      const { data: statusData } = await requestJson("/api/crm/worker/calls/status");

      if (status === 200 && data.success && statusData.running === false) {
        recordResult("WORKERS", "W1.4", "POST /api/crm/worker/calls/stop", "PASS", `Worker de llamadas detenido. status.running=false`, start);
      } else {
        recordResult("WORKERS", "W1.4", "POST /api/crm/worker/calls/stop", "FAIL", `No se detuvo limpiamente: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.4", "POST /api/crm/worker/calls/stop", "FAIL", err.message, start);
    }
  }

  // 1.5 GET /api/crm/worker/whatsapp/status
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/worker/whatsapp/status");
      if (status === 200 && typeof data.running === "boolean" && data.config) {
        recordResult("WORKERS", "W1.5", "GET /api/crm/worker/whatsapp/status", "PASS", `Status 200. running=${data.running}, provider=${data.config.provider}`, start);
      } else {
        recordResult("WORKERS", "W1.5", "GET /api/crm/worker/whatsapp/status", "FAIL", `Respuesta inesperada: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.5", "GET /api/crm/worker/whatsapp/status", "FAIL", err.message, start);
    }
  }

  // 1.6 POST /api/crm/worker/whatsapp/config
  {
    const start = Date.now();
    try {
      const configPayload = { pollIntervalMs: 1000, sendDelayMs: 1000, jitterDelayMs: 200, provider: "mock" };
      const { status, data } = await requestJson("/api/crm/worker/whatsapp/config", {
        method: "POST",
        body: JSON.stringify(configPayload),
      });

      if (status === 200 && data.success && data.config?.pollIntervalMs === 1000 && data.config?.provider === "mock") {
        recordResult("WORKERS", "W1.6", "POST /api/crm/worker/whatsapp/config", "PASS", `Config aplicada: poll=1000ms, sendDelay=1000ms, provider=mock`, start);
      } else {
        recordResult("WORKERS", "W1.6", "POST /api/crm/worker/whatsapp/config", "FAIL", `Error en config WhatsApp: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.6", "POST /api/crm/worker/whatsapp/config", "FAIL", err.message, start);
    }
  }

  // 1.7 POST /api/crm/worker/whatsapp/start y verificación
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/worker/whatsapp/start", { method: "POST" });
      const { data: statusData } = await requestJson("/api/crm/worker/whatsapp/status");

      if (status === 200 && data.success && statusData.running === true) {
        recordResult("WORKERS", "W1.7", "POST /api/crm/worker/whatsapp/start", "PASS", `Worker de WhatsApp iniciado. status.running=true`, start);
      } else {
        recordResult("WORKERS", "W1.7", "POST /api/crm/worker/whatsapp/start", "FAIL", `No inició correctamente: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.7", "POST /api/crm/worker/whatsapp/start", "FAIL", err.message, start);
    }
  }

  // 1.8 POST /api/crm/worker/whatsapp/stop y verificación
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/worker/whatsapp/stop", { method: "POST" });
      const { data: statusData } = await requestJson("/api/crm/worker/whatsapp/status");

      if (status === 200 && data.success && statusData.running === false) {
        recordResult("WORKERS", "W1.8", "POST /api/crm/worker/whatsapp/stop", "PASS", `Worker de WhatsApp detenido. status.running=false`, start);
      } else {
        recordResult("WORKERS", "W1.8", "POST /api/crm/worker/whatsapp/stop", "FAIL", `No se detuvo: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.8", "POST /api/crm/worker/whatsapp/stop", "FAIL", err.message, start);
    }
  }

  // 1.9 POST /api/crm/orchestrator/start
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/orchestrator/start", {
        method: "POST",
        body: JSON.stringify({ campaignId: "campania-madrid-fontaneria" }),
      });
      const { data: orchStatus } = await requestJson("/api/crm/orchestrator/status");

      const ok = status === 200 && data.success && orchStatus.active === true && orchStatus.callWorker?.running === true && orchStatus.whatsAppWorker?.running === true;

      if (ok) {
        recordResult("WORKERS", "W1.9", "POST /api/crm/orchestrator/start", "PASS", `Orquestador activado al 100%. Ambos subworkers iniciados en paralelo.`, start);
      } else {
        recordResult("WORKERS", "W1.9", "POST /api/crm/orchestrator/start", "FAIL", `Fallo al orquestar: ${JSON.stringify(orchStatus)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.9", "POST /api/crm/orchestrator/start", "FAIL", err.message, start);
    }
  }

  // 1.10 GET /api/crm/orchestrator/status (Telemetría unificada)
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/orchestrator/status");
      const hasProps = data.active !== undefined && data.callWorker && data.whatsAppWorker && data.funnelStats && typeof data.uptimeSeconds === "number";

      if (status === 200 && hasProps) {
        recordResult(
          "WORKERS",
          "W1.10",
          "GET /api/crm/orchestrator/status",
          "PASS",
          `Telemetría unificada recibida. active=${data.active}, uptime=${data.uptimeSeconds}s, campaignId=${data.campaignId}`,
          start
        );
      } else {
        recordResult("WORKERS", "W1.10", "GET /api/crm/orchestrator/status", "FAIL", `Telemetría inválida: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.10", "GET /api/crm/orchestrator/status", "FAIL", err.message, start);
    }
  }

  // 1.11 POST /api/crm/orchestrator/stop
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/orchestrator/stop", { method: "POST" });
      const { data: orchStatus } = await requestJson("/api/crm/orchestrator/status");

      const stopped = status === 200 && data.success && orchStatus.active === false && orchStatus.callWorker?.running === false && orchStatus.whatsAppWorker?.running === false;

      if (stopped) {
        recordResult("WORKERS", "W1.11", "POST /api/crm/orchestrator/stop", "PASS", `Detención limpia. Orquestador y ambos subworkers completamente detenidos.`, start);
      } else {
        recordResult("WORKERS", "W1.11", "POST /api/crm/orchestrator/stop", "FAIL", `Fallo en detención: ${JSON.stringify(orchStatus)}`, start);
      }
    } catch (err: any) {
      recordResult("WORKERS", "W1.11", "POST /api/crm/orchestrator/stop", "FAIL", err.message, start);
    }
  }

  // =========================================================================
  // BLOQUE 2: Flujo Completo E2E Autónomo (Lead Lifecycle)
  // =========================================================================
  console.log("\n▶ BLOQUE 2: Flujo Autónomo de Prospección y Ciclo de Vida del Lead\n");

  let e2eLead: any = null;
  let generatedHookToken: string = "";

  // 2.1 Importar lead fresco
  {
    const start = Date.now();
    try {
      const newLeadPayload = [
        {
          empresa_nombre: "Instalaciones Clima Pro",
          telefono: "912 34 56 78",
          place_id: "ChIJ_FULL_E2E_1",
          ciudad: "Madrid",
          categoria_maps: "Climatización",
        },
      ];

      const { status, data } = await requestJson("/api/crm/leads/importar", {
        method: "POST",
        body: JSON.stringify(newLeadPayload),
      });

      if (status === 200 && data.importados_nuevos === 1 && data.leads_creados?.length > 0) {
        e2eLead = data.leads_creados[0];
        recordResult(
          "LIFECYCLE",
          "L2.1",
          "Importación de Lead Fresco",
          "PASS",
          `Lead '${e2eLead.empresa_nombre}' creado con ID ${e2eLead.id}, teléfono normalizado ${e2eLead.telefono}, estado inicial '${e2eLead.estado}'.`,
          start
        );
      } else {
        recordResult("LIFECYCLE", "L2.1", "Importación de Lead Fresco", "FAIL", `Fallo importando lead: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("LIFECYCLE", "L2.1", "Importación de Lead Fresco", "FAIL", err.message, start);
    }
  }

  // 2.2 Generar gancho/propuesta manualmente vía POST /api/crm/leads/{id}/generar-gancho
  {
    const start = Date.now();
    try {
      if (!e2eLead) throw new Error("No hay lead de la etapa anterior");

      const { status, data } = await requestJson(`/api/crm/leads/${e2eLead.id}/generar-gancho`, {
        method: "POST",
      });

      if (status === 200 && data.success && data.urlPropuesta && data.tokenSeguimiento) {
        generatedHookToken = data.tokenSeguimiento;
        recordResult(
          "LIFECYCLE",
          "L2.2",
          "POST /api/crm/leads/{id}/generar-gancho",
          "PASS",
          `Gancho generado determinista. urlPropuesta='${data.urlPropuesta}', token='${data.tokenSeguimiento}'`,
          start
        );
      } else {
        recordResult("LIFECYCLE", "L2.2", "POST /api/crm/leads/{id}/generar-gancho", "FAIL", `Error generando gancho: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("LIFECYCLE", "L2.2", "POST /api/crm/leads/{id}/generar-gancho", "FAIL", err.message, start);
    }
  }

  // 2.3 Iniciar Orquestador para ciclo autónomo
  {
    const start = Date.now();
    try {
      // Ajustar configuración ultrarrápida para la prueba (1s poll)
      await requestJson("/api/crm/worker/calls/config", {
        method: "POST",
        body: JSON.stringify({ pollIntervalMs: 800, callCooldownMs: 800, mode: "simulation", overrideHorario: true }),
      });
      await requestJson("/api/crm/worker/whatsapp/config", {
        method: "POST",
        body: JSON.stringify({ pollIntervalMs: 800, sendDelayMs: 800, jitterDelayMs: 200, provider: "mock" }),
      });

      const { status, data } = await requestJson("/api/crm/orchestrator/start", { method: "POST" });
      if (status === 200 && data.success) {
        recordResult("LIFECYCLE", "L2.3", "Arranque de Orquestador Outbound", "PASS", `Motor de prospección autónomo en ejecución.`, start);
      } else {
        recordResult("LIFECYCLE", "L2.3", "Arranque de Orquestador Outbound", "FAIL", `Fallo iniciando: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("LIFECYCLE", "L2.3", "Arranque de Orquestador Outbound", "FAIL", err.message, start);
    }
  }

  // 2.4 Esperar a que CallWorker procese la llamada y avance a 'cola_whatsapp'
  {
    const start = Date.now();
    try {
      console.log("   ⏳ Esperando procesamiento de llamada por CallWorker (duración simulación ~2s + poll)...");
      const updatedLead = await waitForLeadState(e2eLead.id, "cola_whatsapp", 9000);
      recordResult(
        "LIFECYCLE",
        "L2.4",
        "Llamada completada y autorización WhatsApp",
        "PASS",
        `Lead avanzó a estado '${updatedLead.estado}' con calificación '${updatedLead.calificacion}'. veces_llamado=${updatedLead.veces_llamado}.`,
        start
      );
    } catch (err: any) {
      recordResult("LIFECYCLE", "L2.4", "Llamada completada y autorización WhatsApp", "FAIL", err.message, start);
    }
  }

  // 2.5 Esperar a que WhatsAppWorker despache el mensaje y avance a 'whatsapp_enviado'
  {
    const start = Date.now();
    try {
      console.log("   ⏳ Esperando despacho de mensaje por WhatsAppWorker (poll + jitter ~1-2s)...");
      const updatedLead = await waitForLeadState(e2eLead.id, "whatsapp_enviado", 9000);
      recordResult(
        "LIFECYCLE",
        "L2.5",
        "Despacho y Envío de WhatsApp",
        "PASS",
        `Lead avanzó a estado '${updatedLead.estado}'. veces_whatsapp=${updatedLead.veces_whatsapp}. Enlace de muestra enviado.`,
        start
      );
    } catch (err: any) {
      recordResult("LIFECYCLE", "L2.5", "Despacho y Envío de WhatsApp", "FAIL", err.message, start);
    }
  }

  // 2.6 Simular apertura del enlace por el cliente llamando a GET /api/crm/propuesta/{token}
  {
    const start = Date.now();
    try {
      const token = generatedHookToken || e2eLead.token_seguimiento;
      const { status, data } = await requestJson(`/api/crm/propuesta/${token}`);

      const propOpened = data.success && data.propuesta?.abierta === true;
      const leadUpgraded = data.lead?.estado === "interesado" && data.lead?.calificacion === "caliente";

      if (status === 200 && propOpened && leadUpgraded) {
        recordResult(
          "LIFECYCLE",
          "L2.6",
          "Apertura de Enlace por el Cliente (Tracking)",
          "PASS",
          `Propuesta abierta con éxito. Lead ascendió automáticamente a '${data.lead.estado}' con calificación '${data.lead.calificacion}'.`,
          start
        );
      } else {
        recordResult("LIFECYCLE", "L2.6", "Apertura de Enlace por el Cliente (Tracking)", "FAIL", `Fallo en tracking de apertura: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("LIFECYCLE", "L2.6", "Apertura de Enlace por el Cliente (Tracking)", "FAIL", err.message, start);
    }
  }

  // 2.7 Detener el orquestador limpio
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/orchestrator/stop", { method: "POST" });
      const { data: statusData } = await requestJson("/api/crm/orchestrator/status");

      if (status === 200 && data.success && statusData.active === false) {
        recordResult("LIFECYCLE", "L2.7", "Detención Final de Orquestador", "PASS", `Orquestador detenido exitosamente tras completar el ciclo de vida del lead.`, start);
      } else {
        recordResult("LIFECYCLE", "L2.7", "Detención Final de Orquestador", "FAIL", `Error deteniendo orquestador: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("LIFECYCLE", "L2.7", "Detención Final de Orquestador", "FAIL", err.message, start);
    }
  }

  // =========================================================================
  // BLOQUE 3: Verificación de UI y Assets
  // =========================================================================
  console.log("\n▶ BLOQUE 3: Verificación de Interfaz de Usuario y Assets\n");

  // 3.1 GET /crm (Tablero Kanban HTML)
  {
    const start = Date.now();
    try {
      const { status, text } = await requestText("/crm");
      const ok = status === 200 && text.includes("Nexus Leads") && text.includes("Kanban");

      if (ok) {
        recordResult("UI", "U3.1", "GET /crm (Tablero Kanban)", "PASS", `Status 200. HTML servido íntegro (${text.length} bytes). Componentes Kanban listos.`, start);
      } else {
        recordResult("UI", "U3.1", "GET /crm (Tablero Kanban)", "FAIL", `Respuesta HTML no válida. Status ${status}`, start);
      }
    } catch (err: any) {
      recordResult("UI", "U3.1", "GET /crm (Tablero Kanban)", "FAIL", err.message, start);
    }
  }

  // 3.2 GET /index.html (Monitor de Voz y Botón Acceso CRM)
  {
    const start = Date.now();
    try {
      const { status, text } = await requestText("/index.html");
      const hasVoice = text.includes("Kira Voice Agent") || text.includes("Monitor");
      const hasCrmBtn = text.includes('href="/crm"') || text.includes("CRM Nexus Leads");

      if (status === 200 && hasVoice && hasCrmBtn) {
        recordResult(
          "UI",
          "U3.2",
          "GET /index.html (Monitor de Voz & Enlace CRM)",
          "PASS",
          `Status 200. Monitor de Voz operativo (${text.length} bytes) con botón visible hacia /crm.`,
          start
        );
      } else {
        recordResult("UI", "U3.2", "GET /index.html", "FAIL", `No se detectó el enlace o componentes. Status ${status}`, start);
      }
    } catch (err: any) {
      recordResult("UI", "U3.2", "GET /index.html", "FAIL", err.message, start);
    }
  }

  // 3.3 GET /api/crm/estadisticas (Métricas consolidadas actualizadas)
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/estadisticas");
      const ok = status === 200 && data.total_leads >= 1 && data.por_estado?.interesado >= 1 && data.llamadas_hoy >= 1;

      if (ok) {
        recordResult(
          "UI",
          "U3.3",
          "GET /api/crm/estadisticas (Consolidación de Métricas)",
          "PASS",
          `Total leads: ${data.total_leads} | Interesados: ${data.por_estado.interesado} | Llamadas hoy: ${data.llamadas_hoy}/${data.limite_hoy} | Autorización WA: ${data.tasa_autorizacion_whatsapp} | Apertura: ${data.tasa_apertura_propuestas}`,
          start
        );
      } else {
        recordResult("UI", "U3.3", "GET /api/crm/estadisticas", "FAIL", `Métricas incompletas: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("UI", "U3.3", "GET /api/crm/estadisticas", "FAIL", err.message, start);
    }
  }

  // =========================================================================
  // RESUMEN GLOBAL
  // =========================================================================
  console.log("\n===============================================================================");
  console.log("                        RESUMEN DE AUDITORÍA COMPLETA");
  console.log("===============================================================================");

  const total = results.length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;

  for (const r of results) {
    const badge = r.status === "PASS" ? "PASS" : "FAIL";
    console.log(`[${badge.padEnd(4)}] ${r.suite.padEnd(9)} | ${r.id.padEnd(6)} | ${r.name.padEnd(46)} | ${r.durationMs}ms`);
  }

  console.log("-------------------------------------------------------------------------------");
  console.log(`TOTAL PRUEBAS: ${total} | SUPERADAS: ${passed} | FALLIDAS: ${failed}`);
  console.log(`ESTADO GENERAL: ${failed === 0 ? "✅ 100% AUDITADO Y VALIDADO SIN CABOS SUELTOS" : "❌ SE ENCONTRARON FALLOS"}`);
  console.log("===============================================================================\n");

  if (serverInstance) {
    try {
      serverInstance.close();
    } catch {}
  }

  restoreCrmSnapshot();

  if (failed > 0) {
    process.exit(1);
  }
}

import fs from "fs";
import path from "path";

const crmDbFile = path.join(process.cwd(), "data", "crm", "crm.json");
const crmBackupSnapshot = fs.existsSync(crmDbFile) ? fs.readFileSync(crmDbFile, "utf-8") : null;

function restoreCrmSnapshot() {
  if (crmBackupSnapshot !== null) {
    try {
      fs.writeFileSync(crmDbFile, crmBackupSnapshot, "utf-8");
      fs.writeFileSync(`${crmDbFile}.bak`, crmBackupSnapshot, "utf-8");
    } catch {}
  }
}

runFullE2e().catch((err) => {
  restoreCrmSnapshot();
  console.error("Error crítico ejecutando suite E2E:", err);
  process.exit(1);
});
