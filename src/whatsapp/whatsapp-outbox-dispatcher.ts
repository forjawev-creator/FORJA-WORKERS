import { runtimePolicy, communicationsBlockedMessage } from "../runtime-policy.js";
import crypto from "node:crypto";
import { baileysWhatsAppService } from "./baileys-service.js";
import { crmStorage, getMadridDateString } from "../crm/crm-storage.js";
import { normalizeSpanishPhone } from "../utils/phone-utils.js";
import { isOptedOut } from "./opt-out.js";
import type { OutboxProcessResult } from "../outbox/outbox-consumer.js";
import { DeferredWork } from "../outbox/retry.js";
import { proposalMessage } from "./proposal-message.js";

export async function dispatchWhatsAppProposal(event: {
  callId: string; leadId?: string; confirmedPhone?: string; phone?: string; company?: string; evidenceQuote?: string;
}): Promise<OutboxProcessResult> {
  if (!runtimePolicy().realWhatsAppEnabled) throw new DeferredWork(communicationsBlockedMessage);
  const phone = normalizeSpanishPhone(event.confirmedPhone || event.phone || "");
  if (!phone) throw new Error("Teléfono de WhatsApp inválido");
  if (isOptedOut(phone)) return true;
  if (baileysWhatsAppService.getStatus().status !== "connected") throw new DeferredWork("WhatsApp está desconectado o conectando");
  const reservation = crmStorage.transaction(db => {
    const config = (db.settings as any).whatsapp_worker_config;
    if (!config?.enabled) throw new DeferredWork("Envíos de WhatsApp pausados");
    if (config.provider && config.provider !== "baileys") throw new DeferredWork("El consumidor externo requiere el proveedor Baileys");
    const candidates = db.leads.filter(l => event.leadId ? l.id === event.leadId :
      l.place_id === event.callId || normalizeSpanishPhone(l.telefono_confirmado || l.telefono) === phone);
    if (candidates.length !== 1) throw new DeferredWork("No se ha identificado un único negocio para la muestra", 60_000);
    const lead = candidates[0];
    if (lead.es_simulacion) throw new Error("Un contacto de simulación no puede usar transporte real");
    if (lead.estado === "no_contactar" || lead.estado === "descartado" || db.robinson.some(r => r.telefono === phone)) return { done: true } as const;
    if (!lead.consentimiento_whatsapp || normalizeSpanishPhone(lead.telefono_confirmado || lead.telefono) !== phone) throw new DeferredWork("Pendiente de autorización y teléfono confirmado en CRM");
    if (lead.veces_whatsapp > 0 || lead.estado === "whatsapp_enviado") return { done: true } as const;
    const deliveries = ((db.settings as any).whatsapp_deliveries ??= {}) as Record<string, any>;
    const key = `proposal:${lead.id}`;
    if (deliveries[key]?.state === "sent") return { done: true } as const;
    if (["sending", "uncertain"].includes(deliveries[key]?.state)) return { uncertain: true } as const;
    const { message, url } = proposalMessage(db, lead);
    const today = getMadridDateString();
    if (db.settings.whatsapp_fecha_contador !== today) {
      db.settings.whatsapp_fecha_contador = today;
      db.settings.whatsapp_mensajes_hoy = 0;
    }
    const max = config.maxDailyMessages ?? 50;
    if (!Number.isInteger(max) || max < 0) throw new Error("Cuota diaria no válida");
    const held = Object.values(deliveries).filter(d => d.date === today && ["sending", "uncertain"].includes(d.state)).length;
    if ((db.settings.whatsapp_mensajes_hoy || 0) + held >= max) throw new DeferredWork("Cuota diaria alcanzada", 60_000);
    deliveries[key] = { state: "sending", date: today, callId: event.callId, phone, url, startedAt: new Date().toISOString() };
    lead.estado = "enviando_whatsapp";
    return { key, leadId: lead.id, message } as const;
  });
  if ("done" in reservation) return true;
  if ("uncertain" in reservation) return "uncertain";
  // Once transport has been invoked, quarantine any ambiguous result, never blindly resend.
  try {
    const sent = await baileysWhatsAppService.sendMessage(phone, reservation.message);
    if (!sent.success) throw new Error(sent.error || "Entrega sin confirmar");
    crmStorage.transaction(db => {
      const delivery = (db.settings as any).whatsapp_deliveries[reservation.key];
      if (delivery.state === "sent") return;
      delivery.state = "sent"; delivery.messageId = sent.messageId; delivery.finishedAt = new Date().toISOString();
      const today = getMadridDateString();
      if (db.settings.whatsapp_fecha_contador !== today) { db.settings.whatsapp_fecha_contador = today; db.settings.whatsapp_mensajes_hoy = 0; }
      db.settings.whatsapp_mensajes_hoy = (db.settings.whatsapp_mensajes_hoy || 0) + 1;
      const lead = db.leads.find(l => l.id === reservation.leadId);
      if (lead) {
        if (!["no_contactar", "descartado"].includes(lead.estado)) lead.estado = "whatsapp_enviado";
        lead.veces_whatsapp = (lead.veces_whatsapp || 0) + 1;
        lead.ultimo_contacto_at = delivery.finishedAt;
      }
      db.interacciones.push({ id: crypto.randomUUID(), lead_id: reservation.leadId, tipo: "whatsapp", resultado: "enviado_ok", resumen_transcripcion: reservation.message, created_at: delivery.finishedAt });
    });
    return true;
  } catch {
    crmStorage.transaction(db => {
      const delivery = (db.settings as any).whatsapp_deliveries[reservation.key];
      if (delivery.state !== "sent") delivery.state = "uncertain";
    });
    return "uncertain";
  }
}

export async function dispatchHumanTransferAlert(payload: {
  phone?: string; targetPhone?: string; reason?: string; customerNotes?: string;
}): Promise<OutboxProcessResult> {
  if (!runtimePolicy().realWhatsAppEnabled) throw new DeferredWork(communicationsBlockedMessage);
  if (baileysWhatsAppService.getStatus().status !== "connected") throw new DeferredWork("WhatsApp no está conectado");
  const targetPhone = payload.targetPhone || "";
  const message = `Aviso de transferencia de Forja Web\nCliente: ${payload.phone || "Desconocido"}\nMotivo: ${payload.reason || "Solicitud de transferencia"}\n${payload.customerNotes || ""}`;
  try { const result = await baileysWhatsAppService.sendMessage(targetPhone, message); return result.success ? true : "uncertain"; }
  catch { return "uncertain"; }
}
