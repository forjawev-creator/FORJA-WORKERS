import type { CrmDatabase, Lead } from "../crm/types.js";
import { DeferredWork } from "../outbox/retry.js";

export function proposalMessage(db: CrmDatabase, lead: Lead): { message: string; url: string } {
  const proposal = db.propuestas.find(p => p.lead_id === lead.id && p.proyecto_id === lead.proyecto_id && p.token_seguimiento === lead.token_seguimiento);
  if (!proposal || !proposal.url_publica) throw new DeferredWork("La muestra de este negocio aún no está preparada", 60_000);
  let url: URL;
  try { url = new URL(proposal.url_publica); } catch { throw new DeferredWork("La muestra no tiene un enlace público válido", 60_000); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".local") || host === "[::1]" || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    throw new DeferredWork("La muestra necesita una dirección HTTPS pública", 60_000);
  }
  const project = db.proyectos.find(p => p.id === lead.proyecto_id && p.activo);
  if (!project) throw new DeferredWork("El proyecto de la muestra no está activo", 60_000);
  const template = project.plantillas_whatsapp.default;
  if (!template || !template.includes("{{enlace}}")) throw new DeferredWork("La plantilla debe incluir el enlace de la muestra", 60_000);
  const values: Record<string, string> = { nombre: lead.empresa_nombre, oficio: lead.oficio_mapeado || lead.categoria_maps, ciudad: lead.ciudad, enlace: url.href };
  return { message: template.replace(/\{\{(nombre|oficio|ciudad|enlace)\}\}/g, (_, key) => values[key]), url: url.href };
}
