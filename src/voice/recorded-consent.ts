export interface ConsentTurn { role: "user" | "assistant"; text: string }
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
/** Evidence must come from this conversation, with no refusal or condition. */
export function hasRecordedConsent(quote: unknown, turns: ConsentTurn[]): boolean {
    if (typeof quote !== "string" || !quote.trim())
        return false;
    const evidence = normalize(quote);
    const users = turns.filter(t => t.role === "user").map(t => normalize(t.text));
    const spoken = users.join(" ");
    if (!spoken.includes(evidence))
        return false;
    const latest = users.slice(-3).join(" ");
    if (/^(no|no gracias)$/.test(users.at(-1) || "")) return false;
    const refuses = /\b(no (quiero|me interesa|me (mandes|envies)|lo envies|mandes|envies|gracias)|no quiero nada|dejame|dejadme|no hace falta)\b/;
    const conditional = /\b(si (es|fuera|cuesta|tiene|me|no)|depende|primero|pero|solo si|antes de)\b/;
    if (refuses.test(latest) || refuses.test(evidence) || conditional.test(evidence))
        return false;
    const explicitSend = /\b(enviamelo|enviamela|mandamelo|mandamela|puedes (enviar|mandar)|te autorizo|autorizo)\b/.test(evidence);
    const affirmative = /\b(si|vale|de acuerdo|adelante|claro)\b/.test(evidence);
    const whatsappContext = turns.some(t => t.role === "assistant" && /\bwhatsapp\b/.test(normalize(t.text))) || /\bwhatsapp\b/.test(evidence);
    return whatsappContext && (explicitSend || (affirmative && evidence.split(" ").length <= 12));
}
