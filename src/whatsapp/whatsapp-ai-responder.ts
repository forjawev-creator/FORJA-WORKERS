import fs from "fs";
import path from "path";
import pino from "pino";
import { proto, downloadMediaMessage } from "@whiskeysockets/baileys";
import { crmService } from "../crm/crm-service.js";
import { loadConfig } from "../storage.js";
import { baileysWhatsAppService } from "./baileys-service.js";

// Registro de mensajes procesados para evitar duplicidades
const processedMessageIds = new Set<string>();

interface PendingBuffer {
  timer: NodeJS.Timeout;
  messages: string[];
  remoteJid: string;
  phone: string;
  msgKey: proto.IMessageKey;
}
const pendingBuffers = new Map<string, PendingBuffer>();

/**
 * Resuelve el número de teléfono real a partir del remoteJid (@lid o @s.whatsapp.net)
 */
export function resolvePhoneFromJid(remoteJid: string): string {
  if (remoteJid.endsWith("@s.whatsapp.net")) {
    return remoteJid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
  }

  if (remoteJid.endsWith("@lid")) {
    const lid = remoteJid.split("@")[0].split(":")[0];
    const lidFile = path.resolve(process.cwd(), "data", "whatsapp_auth", `lid-mapping-${lid}_reverse.json`);
    if (fs.existsSync(lidFile)) {
      try {
        const content = fs.readFileSync(lidFile, "utf-8").trim();
        const parsed = JSON.parse(content);
        if (typeof parsed === "string") {
          return parsed.replace(/[^0-9]/g, "");
        }
      } catch {}
    }
    return lid;
  }

  return remoteJid.split("@")[0].replace(/[^0-9]/g, "");
}

/**
 * Extrae texto de un mensaje o transcribe nota de voz con OpenAI Whisper
 */
export async function extractMessageTextOrAudio(
  msg: proto.IWebMessageInfo,
  apiKey?: string
): Promise<string> {
  const m = msg.message;
  if (!m) return "";

  // 1. Mensaje de texto estándar
  const directText = (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.ephemeralMessage?.message?.conversation ||
    m.viewOnceMessage?.message?.extendedTextMessage?.text ||
    m.viewOnceMessage?.message?.conversation ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();

  if (directText) return directText;

  // 2. Nota de voz / audio de WhatsApp (PTT)
  const audioObj =
    m.audioMessage ||
    m.ephemeralMessage?.message?.audioMessage ||
    m.viewOnceMessage?.message?.audioMessage;

  if (audioObj && apiKey) {
    try {
      console.log("[WhatsApp AI] 🎙️ Nota de voz entrante detectada. Descargando y transcribiendo con Whisper...");
      const sock = baileysWhatsAppService.getSocket();
      if (!sock) return "";

      const buffer = await downloadMediaMessage(
        msg as any,
        "buffer",
        {},
        {
          logger: pino({ level: "silent" }),
          reuploadRequest: sock.updateMediaMessage,
        }
      );

      if (buffer && buffer.length > 0) {
        const formData = new FormData();
        const blob = new Blob([buffer], { type: "audio/ogg; codecs=opus" });
        formData.append("file", blob, "voice.ogg");
        formData.append("model", "whisper-1");
        formData.append("language", "es");

        const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
        });

        if (resp.ok) {
          const result = (await resp.json()) as any;
          const transcript = result.text?.trim() || "";
          console.log(`[WhatsApp AI] 🎙️ Transcripción Whisper obtenida: "${transcript}"`);
          return transcript;
        } else {
          console.warn(`[WhatsApp AI] Error en Whisper API (${resp.status}):`, await resp.text());
        }
      }
    } catch (err: any) {
      console.error("[WhatsApp AI] Error procesando nota de voz:", err?.message || err);
    }

    return "[El cliente envió una nota de voz]";
  }

  return "";
}

/**
 * Procesa el evento 'messages.upsert' emitido por Baileys
 */
export async function handleIncomingWhatsAppUpsert(upsert: {
  messages: proto.IWebMessageInfo[];
  type: string;
}): Promise<void> {
  if (!upsert || !Array.isArray(upsert.messages)) return;

  for (const msg of upsert.messages) {
    try {
      await processSingleIncomingMessage(msg);
    } catch (err: any) {
      console.error("[WhatsApp AI] Error procesando mensaje individual:", err?.message || err);
    }
  }
}

/**
 * Valida y encola un mensaje individual para respuesta por IA
 */
async function processSingleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
  if (!msg || !msg.key) return;
  // 1. Ignorar mensajes propios enviados por la propia línea
  if (msg.key.fromMe) return;

  // 2. Ignorar estados de difusión y grupos
  const remoteJid = msg.key.remoteJid || "";
  if (!remoteJid || remoteJid.includes("@broadcast") || remoteJid.includes("@g.us")) {
    return;
  }

  // 3. Bloqueo total anti-bucle y anti-autorrespuesta:
  // Ignorar si el mensaje proviene o va dirigido al propio número de la línea emisora (609)
  const botStatus = baileysWhatsAppService.getStatus();
  const botPhone = (botStatus.phone || "").replace(/[^0-9]/g, ""); // ej: "34609046902"
  const botSock = baileysWhatsAppService.getSocket();
  const botUser = botSock ? (botSock.user as any) : null;
  const botLid = botUser?.lid
    ? botUser.lid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
    : "";

  const remoteDigits = remoteJid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
  if (botPhone && remoteDigits.endsWith(botPhone.slice(-9))) {
    return;
  }
  if (botLid && remoteDigits === botLid) {
    return;
  }

  // Resolver teléfono real
  const phone = resolvePhoneFromJid(remoteJid);
  if (botPhone && phone.replace(/[^0-9]/g, "").endsWith(botPhone.slice(-9))) {
    return;
  }

  // 4. Deduplicación por ID de mensaje
  const msgId = msg.key.id;
  if (msgId) {
    if (processedMessageIds.has(msgId)) return;
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 5000) {
      const first = processedMessageIds.values().next().value;
      if (first) processedMessageIds.delete(first);
    }
  }

  // 5. Comprobación de antigüedad: ignorar mensajes de más de 45 minutos (ej: sincronizaciones históricas)
  const msgTimestamp =
    typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp
      : typeof (msg.messageTimestamp as any)?.low === "number"
      ? (msg.messageTimestamp as any).low
      : Number(msg.messageTimestamp) || 0;

  const nowSec = Math.floor(Date.now() / 1000);
  if (msgTimestamp > 0 && nowSec - msgTimestamp > 2700) {
    return;
  }

  // 6. Cargar API Key para posible transcripción de audio o respuesta
  const config = loadConfig();
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;

  // 7. Extraer texto o transcribir audio
  const text = await extractMessageTextOrAudio(msg, apiKey);
  if (!text) return;

  // 8. Búfer anti-fragmentación: si el cliente envía varios mensajes seguidos,
  // esperamos 2.5 segundos de silencio para responderle a todo junto
  const bufferKey = phone || remoteJid;
  const existing = pendingBuffers.get(bufferKey);
  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(text);
    existing.timer = setTimeout(() => {
      pendingBuffers.delete(bufferKey);
      dispatchAiResponse(existing.phone, existing.remoteJid, existing.messages.join("\n"), existing.msgKey, apiKey);
    }, 2500);
  } else {
    // Marcar como leído y mostrar estado "escribiendo..." en WhatsApp
    baileysWhatsAppService.readMessages([msg.key as any]).catch(() => {});
    baileysWhatsAppService.sendPresenceUpdate("composing", remoteJid).catch(() => {});

    const newBuffer: PendingBuffer = {
      messages: [text],
      remoteJid,
      phone,
      msgKey: msg.key as any,
      timer: setTimeout(() => {
        pendingBuffers.delete(bufferKey);
        dispatchAiResponse(newBuffer.phone, newBuffer.remoteJid, newBuffer.messages.join("\n"), newBuffer.msgKey, apiKey);
      }, 2500),
    };
    pendingBuffers.set(bufferKey, newBuffer);
  }
}

/**
 * Genera la respuesta del Asistente Comercial IA y la envía por WhatsApp
 */
async function dispatchAiResponse(
  phone: string,
  remoteJid: string,
  clientText: string,
  msgKey: proto.IMessageKey,
  apiKey?: string
): Promise<void> {
  try {
    console.log(`\n[WhatsApp AI] 📩 Mensaje entrante de ${phone} (${remoteJid}): "${clientText}"`);

    // 1. Registrar en CRM y actualizar estado del lead
    const crmResult = crmService.recordIncomingWhatsAppMessage(phone, clientText);
    const lead = crmResult.lead;
    const pastChat = crmResult.previousInteractions || [];

    // 2. Indicar presencia de escritura
    await baileysWhatsAppService.sendPresenceUpdate("composing", remoteJid);

    let aiReplyText = "";

    if (!apiKey) {
      console.warn("[WhatsApp AI] No hay API Key de OpenAI configurada. Usando respuesta estándar de cortesía.");
      aiReplyText =
        "¡Hola! Hemos recibido tu mensaje. En breves minutos uno de nuestros asesores lo revisará para responderte directamente. Si tienes dudas sobre tu muestra web gratuita, estamos a tu total disposición.";
    } else {
      const empresaNombre = lead ? lead.empresa_nombre : "tu negocio";
      const oficio = lead ? lead.oficio_mapeado || lead.categoria_maps || "servicios" : "servicios";
      const linkPropuesta = lead?.url_propuesta || "";

      const systemPrompt = `Eres Juan, asesor comercial y gestor web de Forja Web. Estás atendiendo por WhatsApp a un cliente del negocio local "${empresaNombre}" (sector: ${oficio}).
Previamente hablamos por teléfono y le enviamos una muestra web interactiva gratuita por WhatsApp${linkPropuesta ? ` (su enlace personalizado es: ${linkPropuesta})` : ""}.

Tu objetivo:
Resolver dudas del cliente con total naturalidad, amabilidad, cercanía y concisión (estilo mensaje real de WhatsApp, español de España, tuteo respetuoso).

Instrucciones estrictas:
1. Longitud: 1 a 3 oraciones breves (máximo 40 palabras). NUNCA envíes parrafadas ni listas con viñetas.
2. Si el cliente te escribe o proporciona un número de teléfono (ej. 9 dígitos como 636... o 648...): agradécele el número y dile que le llamaremos ahí para coordinar los detalles de su web o pregúntale a qué hora le viene mejor hablar.
3. Precios y condiciones:
   - La muestra previa interactiva en su móvil es 100% gratuita y sin compromiso.
   - Si más adelante decide contratar la web completa: son 99 € de instalación y 10 €/mes de mantenimiento (incluye dominio, hosting ultra rápido, adaptaciones y soporte continuo).
   - Cualquier cambio de fotos, textos, logo o teléfono en su muestra se lo adaptamos sin coste.
4. Si el cliente dice que ha visto el enlace o la muestra: pregúntale amablemente qué le ha parecido y si le gustaría que adaptemos algún texto, foto o servicio.
5. Si el cliente tiene dudas de diseño o funcionamiento: explícale que podemos adaptar la muestra exactamente como necesite.
6. Si dice que no le interesa o pide no recibir mensajes: sé muy educado, dale las gracias y despídete amablemente sin insistir.
7. Si pregunta de dónde tenemos sus datos: recuérdale que vimos su ficha pública en Google Maps donde no tenían página web registrada.
8. Tono: natural, cálido y profesional con algún emoji moderado (😊, 👍, 🌐), sin parecer un robot.`;

      // Construir historial de diálogo para contexto conversacional
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt },
      ];

      // Añadir hasta 6 interacciones anteriores para mantener hilo
      for (const item of pastChat.slice(-6)) {
        if (item.resultado === "enviado_ok") {
          messages.push({
            role: "assistant",
            content: item.resumen_transcripcion || "Hola, te enviamos la muestra web gratuita acordada.",
          });
        } else if (item.resultado === "mensaje_cliente") {
          messages.push({
            role: "user",
            content: item.resumen_transcripcion || "",
          });
        } else if (item.resultado === "respuesta_ia") {
          messages.push({
            role: "assistant",
            content: item.resumen_transcripcion || "",
          });
        }
      }

      // Mensaje actual del cliente
      messages.push({ role: "user", content: clientText });

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 180,
          temperature: 0.35,
        }),
      });

      if (resp.ok) {
        const data = (await resp.json()) as any;
        aiReplyText = data.choices?.[0]?.message?.content?.trim() || "";
      } else {
        const errText = await resp.text();
        console.error(`[WhatsApp AI] Error en API OpenAI (${resp.status}):`, errText);
        aiReplyText =
          "¡Hola! He recibido tu mensaje. En un momento te respondo con detalle a tu consulta. ¡Muchas gracias!";
      }
    }

    if (!aiReplyText) return;

    // 4. Enviar la respuesta por WhatsApp DIRECTAMENTE al número canónico del cliente (@s.whatsapp.net)
    // Usar el número de teléfono limpio para que se entregue en el hilo de chat del cliente (648)
    // y NUNCA se duplique ni se mande al chat del 609 consigo mismo.
    const targetRecipient = phone && phone.length >= 8 ? `${phone}@s.whatsapp.net` : remoteJid;
    const sendResult = await baileysWhatsAppService.sendMessage(targetRecipient, aiReplyText);

    // 5. Quitar estado "escribiendo"
    await baileysWhatsAppService.sendPresenceUpdate("paused", remoteJid);

    // 6. Registrar respuesta en CRM
    if (lead) {
      crmService.recordOutgoingWhatsAppReply(lead.id, aiReplyText, sendResult.success);
    }

    console.log(`[WhatsApp AI] 🤖 Respuesta automática enviada a ${targetRecipient}: "${aiReplyText}"\n`);
  } catch (error: any) {
    console.error(`[WhatsApp AI] Error procesando respuesta para ${phone || remoteJid}:`, error?.message || error);
    try {
      await baileysWhatsAppService.sendPresenceUpdate("paused", remoteJid);
    } catch {}
  }
}
