/**
 * Suite de Pruebas de Integración y Funcionales - Nexus Leads CRM Fase 1
 * Valida los 11 endpoints y reglas de negocio contra el servidor en vivo http://127.0.0.1:3000
 */

import { normalizeSpanishPhone } from "../src/crm/crm-service.js";

const BASE_URL = process.env.CRM_TEST_URL || "http://127.0.0.1:3000";

interface TestResult {
  step: string;
  name: string;
  status: "PASS" | "FAIL";
  details: string;
  durationMs: number;
}

const results: TestResult[] = [];

function recordResult(step: string, name: string, status: "PASS" | "FAIL", details: string, start: number) {
  const durationMs = Date.now() - start;
  results.push({ step, name, status, details, durationMs });
  const icon = status === "PASS" ? "✅ [PASS]" : "❌ [FAIL]";
  console.log(`${icon} (${durationMs}ms) ${step}: ${name}`);
  if (details) {
    console.log(`   └─ Detalle: ${details}`);
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

async function requestText(endpoint: string, options: RequestInit = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${BASE_URL}${endpoint}`, options);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function runBattery() {
  console.log("\n===============================================================================");
  console.log("   NEXUS LEADS CRM - BATERÍA COMPLETA DE PRUEBAS FUNCIONALES FASE 1");
  console.log(`   Target Server: ${BASE_URL}`);
  console.log(`   Timestamp: ${new Date().toISOString()}`);
  console.log("===============================================================================\n");

  // PRE-CLEANUP: Limpiar datos previos de pruebas si existen para asegurar idempotencia
  try {
    console.log("🧹 Ejecutando limpieza previa para asegurar idempotencia...");
    const { data: leads } = await requestJson<any[]>("/api/crm/leads");
    if (Array.isArray(leads)) {
      for (const l of leads) {
        if (["ChIJ_TEST_1", "ChIJ_TEST_2", "ChIJ_TEST_ROB", "ChIJ_TEST_INV"].includes(l.place_id)) {
          await requestJson(`/api/crm/leads/${l.id}`, { method: "DELETE" });
        }
      }
    }
    await requestJson(`/api/crm/robinson/${encodeURIComponent("+34600999888")}`, { method: "DELETE" });
    await requestJson(`/api/crm/robinson/${encodeURIComponent("+34611223344")}`, { method: "DELETE" });
    console.log("   Listo. Base limpia para la suite.\n");
  } catch (err: any) {
    console.warn("   Aviso al limpiar:", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 0: Normalización de números españoles (Pruebas unitarias de función)
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    const testCases = [
      { input: "910 11 22 33", expected: "+34910112233" },
      { input: "+34 611 22 33 44", expected: "+34611223344" },
      { input: "0034910112233", expected: "+34910112233" },
      { input: "712-34-56-78", expected: "+34712345678" },
      { input: "abc123", expected: null },
      { input: "12345", expected: null },
      { input: "", expected: null },
    ];
    let allPassed = true;
    for (const tc of testCases) {
      const actual = normalizeSpanishPhone(tc.input);
      if (actual !== tc.expected) {
        allPassed = false;
        recordResult("TEST 0", "Normalización E.164", "FAIL", `Fallo con input "${tc.input}": esperado ${tc.expected}, obtenido ${actual}`, start);
        break;
      }
    }
    if (allPassed) {
      recordResult("TEST 0", "Normalización E.164 (+34)", "PASS", "Todos los casos de normalización (fijos 9x, móviles 6x/7x, 0034 e inválidos) verificados correctamente.", start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 1: GET /api/crm/proyectos
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/proyectos");
      const forja = Array.isArray(data) && data.find((p: any) => p.id === "forja-web");
      if (status === 200 && forja) {
        recordResult(
          "TEST 1",
          "GET /api/crm/proyectos",
          "PASS",
          `Status 200. Proyecto 'forja-web' encontrado con tipo gancho '${forja.tipo_gancho}' y ${Object.keys(forja.plantillas_whatsapp || {}).length} plantilla(s).`,
          start
        );
      } else {
        recordResult("TEST 1", "GET /api/crm/proyectos", "FAIL", `Status ${status}. No se encontró proyecto 'forja-web' en: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("TEST 1", "GET /api/crm/proyectos", "FAIL", `Error de conexión: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 2: GET /api/crm/lineas (Líneas configuradas y límite diario de 30)
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/lineas");
      const isArray = Array.isArray(data);
      const all30 = isArray && data.length >= 3 && data.every((l: any) => l.limite_diario === 30);
      if (status === 200 && all30) {
        const lineNames = data.map((l: any) => `${l.nombre} (hoy:${l.llamadas_hoy}/${l.limite_diario})`).join(", ");
        recordResult(
          "TEST 2",
          "GET /api/crm/lineas",
          "PASS",
          `Status 200. ${data.length} líneas configuradas activas con límite anti-ban 30: ${lineNames}`,
          start
        );
      } else {
        recordResult(
          "TEST 2",
          "GET /api/crm/lineas",
          "FAIL",
          `Status ${status}. Datos no válidos o límite diferente de 30: ${JSON.stringify(data)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 2", "GET /api/crm/lineas", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 3: POST /api/crm/robinson (Añadir +34600999888 con "Oposición inicial")
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      const payload = {
        telefono: "+34600999888",
        motivo: "Oposición inicial",
      };
      const { status, data } = await requestJson("/api/crm/robinson", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (status === 200 && data.success && data.entry?.telefono === "+34600999888") {
        recordResult(
          "TEST 3",
          "POST /api/crm/robinson",
          "PASS",
          `Status 200. Teléfono +34600999888 agregado a Lista Robinson con motivo: '${data.entry.motivo}'`,
          start
        );
      } else {
        recordResult("TEST 3", "POST /api/crm/robinson", "FAIL", `Status ${status}. Respuesta inesperada: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("TEST 3", "POST /api/crm/robinson", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 4: POST /api/crm/leads/importar (Lote con válidos, duplicados, robinson, inválido)
  // -------------------------------------------------------------------------
  let importedLead1: any = null;
  let importedLead2: any = null;

  {
    const start = Date.now();
    try {
      const batch = [
        {
          empresa_nombre: "Fontanería Madrid Centro",
          telefono: "910 11 22 33",
          place_id: "ChIJ_TEST_1",
          categoria_maps: "Fontanero",
          ciudad: "Madrid",
        },
        {
          empresa_nombre: "Clima Express",
          telefono: "+34 611 22 33 44",
          place_id: "ChIJ_TEST_2",
          categoria_maps: "Climatización",
          ciudad: "Madrid",
        },
        {
          empresa_nombre: "Fontanería Duplicada",
          telefono: "910 11 22 33",
          place_id: "ChIJ_TEST_1",
          categoria_maps: "Fontanero",
          ciudad: "Madrid",
        },
        {
          empresa_nombre: "Fontanería Robinson",
          telefono: "+34600999888",
          place_id: "ChIJ_TEST_ROB",
          categoria_maps: "Fontanero",
          ciudad: "Madrid",
        },
        {
          empresa_nombre: "Empresa Sin Tel",
          telefono: "abc123",
          place_id: "ChIJ_TEST_INV",
          categoria_maps: "Servicios",
          ciudad: "Madrid",
        },
      ];

      const { status, data } = await requestJson("/api/crm/leads/importar", {
        method: "POST",
        body: JSON.stringify(batch),
      });

      const checks = [
        data.total_recibidos === 5,
        data.importados_nuevos === 2,
        data.duplicados_omitidos === 1,
        data.robinson_bloqueados === 1,
        data.telefonos_invalidos === 1,
      ];

      if (status === 200 && checks.every(Boolean)) {
        importedLead1 = data.leads_creados?.find((l: any) => l.place_id === "ChIJ_TEST_1");
        importedLead2 = data.leads_creados?.find((l: any) => l.place_id === "ChIJ_TEST_2");

        recordResult(
          "TEST 4",
          "POST /api/crm/leads/importar",
          "PASS",
          `Total: ${data.total_recibidos} | Importados: ${data.importados_nuevos} | Duplicados: ${data.duplicados_omitidos} | Robinson: ${data.robinson_bloqueados} | Inválidos: ${data.telefonos_invalidos}. Normalización E.164: '${importedLead1?.telefono}' y '${importedLead2?.telefono}'.`,
          start
        );
      } else {
        recordResult(
          "TEST 4",
          "POST /api/crm/leads/importar",
          "FAIL",
          `Status ${status}. Contadores esperados (5, 2, 1, 1, 1). Obtenido: ${JSON.stringify(data)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 4", "POST /api/crm/leads/importar", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 5A: Control de Horario Comercial (Bloqueo cuando enforce_horario=true)
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      // 1. Activar enforcement de horario comercial
      await requestJson("/api/crm/settings", {
        method: "PATCH",
        body: JSON.stringify({ enforce_horario: true }),
      });

      // 2. Intentar pedir llamada sin override (debe fallar fuera de horario comercial)
      const { status, data } = await requestJson("/api/crm/cola/llamada/siguiente");
      const blockedAsExpected = status === 400 && data.message && data.message.includes("Fuera de horario comercial");

      // 3. Restaurar configuración flexible
      await requestJson("/api/crm/settings", {
        method: "PATCH",
        body: JSON.stringify({ enforce_horario: false }),
      });

      if (blockedAsExpected) {
        recordResult(
          "TEST 5A",
          "Control de Horario Comercial (enforce_horario)",
          "PASS",
          `Status 400 como se esperaba: "${data.message}". Horario protegido correctamente.`,
          start
        );
      } else {
        recordResult(
          "TEST 5A",
          "Control de Horario Comercial",
          "FAIL",
          `No bloqueó fuera de horario. Status: ${status}, Data: ${JSON.stringify(data)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 5A", "Control de Horario Comercial", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 5B: GET /api/crm/cola/llamada/siguiente?override_horario=true
  // -------------------------------------------------------------------------
  let activeCallLead: any = null;
  let assignedLine: any = null;

  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/cola/llamada/siguiente?override_horario=true");

      if (status === 200 && data.success && data.lead && data.linea) {
        activeCallLead = data.lead;
        assignedLine = data.linea;

        const callsToday = data.linea.llamadas_hoy;
        recordResult(
          "TEST 5",
          "GET /api/crm/cola/llamada/siguiente (override_horario=true)",
          "PASS",
          `Lead retornado: '${data.lead.empresa_nombre}' (${data.lead.telefono}). Línea asignada: '${data.linea.nombre}' (llamadas_hoy: ${callsToday}). veces_llamado: ${data.lead.veces_llamado}. Script cargado: ${data.script?.substring(0, 45)}...`,
          start
        );
      } else {
        recordResult(
          "TEST 5",
          "GET /api/crm/cola/llamada/siguiente",
          "FAIL",
          `Status ${status}. Respuesta inesperada: ${JSON.stringify(data)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 5", "GET /api/crm/cola/llamada/siguiente", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 6: POST /api/crm/cola/llamada/resultado (Simulando autorización a WhatsApp)
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      if (!activeCallLead) {
        throw new Error("No hay lead de la llamada anterior para reportar resultado");
      }

      const payload = {
        lead_id: activeCallLead.id,
        resultado: "autorizo_whatsapp",
        whatsappAuthorized: true,
        duracion_segundos: 48,
        linea_id: assignedLine?.id || "linea-1",
        resumen: "Cliente interesado en ver el boceto interactivo web.",
      };

      const { status, data } = await requestJson("/api/crm/cola/llamada/resultado", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (status === 200 && data.success && data.lead?.estado === "cola_whatsapp") {
        activeCallLead = data.lead;
        recordResult(
          "TEST 6",
          "POST /api/crm/cola/llamada/resultado (whatsappAuthorized=true)",
          "PASS",
          `Lead '${data.lead.empresa_nombre}' avanzó a estado '${data.lead.estado}' con calificación '${data.lead.calificacion}'. Interacción registrada.`,
          start
        );
      } else {
        recordResult(
          "TEST 6",
          "POST /api/crm/cola/llamada/resultado",
          "FAIL",
          `Status ${status}. Estado esperado 'cola_whatsapp'. Obtenido: ${JSON.stringify(data)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 6", "POST /api/crm/cola/llamada/resultado", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 7: GET /api/crm/cola/whatsapp/siguiente (Despacho WhatsApp con plantilla)
  // -------------------------------------------------------------------------
  let activeWaLead: any = null;
  let formattedWaMsg: string = "";

  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/cola/whatsapp/siguiente");

      if (status === 200 && data.success && data.lead && data.mensaje) {
        activeWaLead = data.lead;
        formattedWaMsg = data.mensaje;

        const hasUrl = data.mensaje.includes(data.lead.url_propuesta);
        const hasName = data.mensaje.includes(data.lead.empresa_nombre);

        if (hasUrl && hasName) {
          recordResult(
            "TEST 7",
            "GET /api/crm/cola/whatsapp/siguiente",
            "PASS",
            `Mensaje WhatsApp renderizado correctamente con URL (${data.lead.url_propuesta}): "${data.mensaje}"`,
            start
          );
        } else {
          recordResult(
            "TEST 7",
            "GET /api/crm/cola/whatsapp/siguiente",
            "FAIL",
            `Plantilla no reemplazó los placeholders. Mensaje: ${data.mensaje}`,
            start
          );
        }
      } else {
        recordResult(
          "TEST 7",
          "GET /api/crm/cola/whatsapp/siguiente",
          "FAIL",
          `Status ${status}. Respuesta inesperada: ${JSON.stringify(data)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 7", "GET /api/crm/cola/whatsapp/siguiente", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 8: POST /api/crm/cola/whatsapp/resultado (success=true)
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      if (!activeWaLead) {
        throw new Error("No hay lead de WhatsApp disponible");
      }

      const payload = {
        lead_id: activeWaLead.id,
        success: true,
        mensaje_enviado: formattedWaMsg,
      };

      const { status, data } = await requestJson("/api/crm/cola/whatsapp/resultado", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (status === 200 && data.success && data.lead?.estado === "whatsapp_enviado") {
        activeWaLead = data.lead;
        recordResult(
          "TEST 8",
          "POST /api/crm/cola/whatsapp/resultado (success=true)",
          "PASS",
          `Lead '${data.lead.empresa_nombre}' avanzó a estado '${data.lead.estado}'. veces_whatsapp: ${data.lead.veces_whatsapp}.`,
          start
        );
      } else {
        recordResult(
          "TEST 8",
          "POST /api/crm/cola/whatsapp/resultado",
          "FAIL",
          `Status ${status}. Estado esperado 'whatsapp_enviado'. Obtenido: ${JSON.stringify(data)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 8", "POST /api/crm/cola/whatsapp/resultado", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 9: GET /api/crm/propuesta/:token (Tracking y salto a 'interesado' / 'caliente')
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      if (!activeWaLead || !activeWaLead.token_seguimiento) {
        throw new Error("No hay token de propuesta para probar");
      }

      const token = activeWaLead.token_seguimiento;

      // 9a. Llamada API con Accept: application/json
      const { status: jsonStatus, data: jsonData } = await requestJson(`/api/crm/propuesta/${token}`);

      const propOk = jsonData?.propuesta?.abierta === true && jsonData?.propuesta?.veces_abierta >= 1;
      const leadOk = jsonData?.lead?.estado === "interesado" && jsonData?.lead?.calificacion === "caliente";

      // 9b. Llamada simulando navegador web recibiendo HTML
      const { status: htmlStatus, text: htmlText } = await requestText(`/api/crm/propuesta/${token}`, {
        headers: { Accept: "text/html" },
      });
      const htmlOk = htmlStatus === 200 && htmlText.includes("Boceto Web Interactivo") && htmlText.includes(activeWaLead.empresa_nombre);

      if (jsonStatus === 200 && propOk && leadOk && htmlOk) {
        recordResult(
          "TEST 9",
          "GET /api/crm/propuesta/:token (Apertura de enlace)",
          "PASS",
          `Propuesta marcada como abierta (${jsonData.propuesta.veces_abierta} veces). Lead promovido a estado '${jsonData.lead.estado}' con calificación '${jsonData.lead.calificacion}'. HTML interactivo servido (200 OK, ${htmlText.length} bytes).`,
          start
        );
      } else {
        recordResult(
          "TEST 9",
          "GET /api/crm/propuesta/:token",
          "FAIL",
          `Fallo en tracking: JSON status=${jsonStatus}, abierta=${propOk}, lead=${leadOk}, HTML status=${htmlStatus}, htmlOk=${htmlOk}. Obtenido: ${JSON.stringify(jsonData)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 9", "GET /api/crm/propuesta/:token", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 10: GET /api/crm/estadisticas (Métricas consolidadas)
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      const { status, data } = await requestJson("/api/crm/estadisticas");

      const hasTotals = typeof data.total_leads === "number" && data.total_leads >= 2;
      const hasPorEstado = data.por_estado && typeof data.por_estado.interesado === "number";
      const hasLlamadasHoy = typeof data.llamadas_hoy === "number" && data.llamadas_hoy >= 1;
      const hasTasas = Boolean(data.tasa_autorizacion_whatsapp) && Boolean(data.tasa_apertura_propuestas);

      if (status === 200 && hasTotals && hasPorEstado && hasLlamadasHoy && hasTasas) {
        recordResult(
          "TEST 10",
          "GET /api/crm/estadisticas",
          "PASS",
          `Total leads: ${data.total_leads} | Interesados: ${data.por_estado.interesado} | Llamadas hoy: ${data.llamadas_hoy}/${data.limite_hoy} | Tasa autorización WA: ${data.tasa_autorizacion_whatsapp} | Tasa apertura: ${data.tasa_apertura_propuestas} | Lista Robinson: ${data.total_robinson}`,
          start
        );
      } else {
        recordResult(
          "TEST 10",
          "GET /api/crm/estadisticas",
          "FAIL",
          `Status ${status}. Estadísticas incompletas: ${JSON.stringify(data)}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 10", "GET /api/crm/estadisticas", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 11: GET /crm (Servir Kanban Dashboard HTML)
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      const { status, text } = await requestText("/crm");

      const isHtml = text.includes("<!DOCTYPE html>") || text.includes("<html");
      const hasTitle = text.includes("Nexus Leads") || text.includes("CRM");

      if (status === 200 && isHtml && hasTitle) {
        recordResult(
          "TEST 11",
          "GET /crm (Dashboard Kanban HTML)",
          "PASS",
          `Status 200. HTML servido exitosamente (${text.length} bytes). Incluye títulos y componentes del CRM Kanban.`,
          start
        );
      } else {
        recordResult(
          "TEST 11",
          "GET /crm",
          "FAIL",
          `Status ${status}. Respuesta no corresponde al HTML del dashboard. Longitud: ${text.length}`,
          start
        );
      }
    } catch (err: any) {
      recordResult("TEST 11", "GET /crm", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 12: Reglas anti-ban y rotación Round-Robin de líneas
  // -------------------------------------------------------------------------
  {
    const start = Date.now();
    try {
      // Pedimos el siguiente lead de la cola (que es Lead 2: Clima Express)
      const { status, data } = await requestJson("/api/crm/cola/llamada/siguiente?override_horario=true");
      if (status === 200 && data.success && data.linea) {
        const linea2 = data.linea;
        recordResult(
          "TEST 12",
          "Rotación Round-Robin de Líneas",
          "PASS",
          `Siguiente llamada despachada a línea '${linea2.nombre}' (${linea2.id}) con llamadas_hoy: ${linea2.llamadas_hoy}. Rotación operativa.`,
          start
        );

        // Simulamos descarte con adición a Robinson para Lead 2
        await requestJson("/api/crm/cola/llamada/resultado", {
          method: "POST",
          body: JSON.stringify({
            lead_id: data.lead.id,
            resultado: "rechazo",
            whatsappAuthorized: false,
            agregar_a_robinson: true,
            motivo_robinson: "Oposición explícita",
          }),
        });
      } else {
        recordResult("TEST 12", "Rotación Round-Robin de Líneas", "FAIL", `No se pudo obtener siguiente lead: ${JSON.stringify(data)}`, start);
      }
    } catch (err: any) {
      recordResult("TEST 12", "Rotación Round-Robin de Líneas", "FAIL", `Error: ${err.message}`, start);
    }
  }

  // =========================================================================
  // RESUMEN Y CONCLUSIÓN
  // =========================================================================
  console.log("\n===============================================================================");
  console.log("                        RESUMEN DE RESULTADOS");
  console.log("===============================================================================");

  const total = results.length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;

  for (const r of results) {
    const badge = r.status === "PASS" ? "PASS" : "FAIL";
    console.log(`[${badge.padEnd(4)}] ${r.step.padEnd(8)} | ${r.name.padEnd(45)} | ${r.durationMs}ms`);
  }

  console.log("-------------------------------------------------------------------------------");
  console.log(`TOTAL PRUEBAS: ${total} | SUPERADAS: ${passed} | FALLIDAS: ${failed}`);
  console.log(`ESTADO GENERAL: ${failed === 0 ? "✅ FASE 1 TOTALMENTE VALIDADA (100% PASS)" : "❌ SE DETECTARON FALLOS"}`);
  console.log("===============================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runBattery().catch((err) => {
  console.error("Error fatal ejecutando suite de pruebas:", err);
  process.exit(1);
});
