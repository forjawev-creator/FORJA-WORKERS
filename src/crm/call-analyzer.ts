/**
 * Módulo de Inteligencia de Conversaciones y Analítica de Llamadas
 * Analiza transcripciones para detectar sentimiento, fricción, objeciones y calidad del diálogo.
 */

export type CustomerSentiment =
  | "muy_receptivo"
  | "receptivo"
  | "neutral"
  | "esceptico"
  | "desinteresado"
  | "molesto";

export type FrictionPoint =
  | "saludo"
  | "propuesta"
  | "precio"
  | "whatsapp_permiso"
  | "numero_telefono"
  | "ninguno";

export type DetectedObjection =
  | "ninguna"
  | "ya_tengo_web"
  | "no_tengo_tiempo"
  | "precio_caro"
  | "desconfianza_origen"
  | "no_interesa"
  | "otra";

export interface CallAnalysis {
  sentiment: CustomerSentiment;
  frictionPoint: FrictionPoint;
  objectionDetected: DetectedObjection;
  qualityScore: number; // 1 a 10
  summaryNote: string;
  recommendedAction: string;
  evaluatedAt: string;
}

/**
 * Analizador heurístico rápido y fiable (fallback o análisis local)
 */
export function analyzeCallHeuristically(
  transcripts: Array<{ role: "user" | "assistant"; text: string }>,
  durationSeconds: number,
  outcome: string,
  variant: "cercano" | "formal" = "cercano"
): CallAnalysis {
  const userTexts = transcripts.filter((t) => t.role === "user").map((t) => t.text.toLowerCase());
  const allUserText = userTexts.join(" ");
  const isAuthorized = outcome === "AUTORIZADO";
  const now = new Date().toISOString();

  // 1. Detección de objeción
  let objection: DetectedObjection = "ninguna";
  if (/ya\s+tengo\s+web|ya\s+tenemos|tenemos\s+p[aá]gina/i.test(allUserText)) {
    objection = "ya_tengo_web";
  } else if (/no\s+tengo\s+tiempo|estoy\s+ocupado|ahora\s+no\s+puedo|ll[aá]mame\s+luego/i.test(allUserText)) {
    objection = "no_tengo_tiempo";
  } else if (/cu[aá]nto\s+cuesta|cu[aá]nto\s+vale|es\s+caro|precio|cobrar/i.test(allUserText)) {
    objection = "precio_caro";
  } else if (/de\s+d[oó]nde\s+(has\s+sacado|tienes)|qui[eé]n\s+te\s+ha\s+dado|por\s+qu[eé]\s+llamas/i.test(allUserText)) {
    objection = "desconfianza_origen";
  } else if (/no\s+me\s+interesa|para\s+nada|no\s+quiero|d[eé]jame/i.test(allUserText)) {
    objection = "no_interesa";
  }

  // 2. Sentimiento
  let sentiment: CustomerSentiment = "neutral";
  if (isAuthorized) {
    if (/genial|perfecto|encantado|estupendo|gracias|qu[eé]\s+bien/i.test(allUserText)) {
      sentiment = "muy_receptivo";
    } else {
      sentiment = "receptivo";
    }
  } else if (/no\s+me\s+interesa|para\s+nada|no\s+molest|pesado|spam|borra/i.test(allUserText)) {
    sentiment = "molesto";
  } else if (objection === "desconfianza_origen" || objection === "precio_caro") {
    sentiment = "esceptico";
  } else if (durationSeconds < 12 || /no|nada/i.test(allUserText)) {
    sentiment = "desinteresado";
  }

  // 3. Punto de fricción
  let friction: FrictionPoint = "ninguno";
  if (!isAuthorized) {
    if (durationSeconds < 15) {
      friction = "saludo";
    } else if (objection === "ya_tengo_web" || /muestra|p[aá]gina|web/i.test(allUserText)) {
      friction = "propuesta";
    } else if (objection === "precio_caro") {
      friction = "precio";
    } else if (/whatsapp/i.test(allUserText)) {
      friction = "whatsapp_permiso";
    } else {
      friction = "propuesta";
    }
  }

  // 4. Puntuación de calidad (1 a 10)
  let score = 5;
  if (isAuthorized) {
    score = sentiment === "muy_receptivo" ? 10 : 9;
  } else if (durationSeconds > 40) {
    score = 7; // Buena retención e interacción aunque no haya cerrado
  } else if (durationSeconds > 25) {
    score = 6;
  } else if (sentiment === "molesto") {
    score = 2;
  } else {
    score = 4;
  }

  // 5. Resumen ejecutivo y recomendación
  let summary = "";
  let action = "";
  if (isAuthorized) {
    summary = `El cliente aceptó la muestra con tono ${sentiment} usando el guion ${variant}. Facilitó o confirmó su número correctamente.`;
    action = "Monitorear apertura del enlace en WhatsApp para llamada o chat de cierre.";
  } else if (objection === "ya_tengo_web") {
    summary = "El cliente indicó que ya dispone de web. El bot ofreció comparativa móvil.";
    action = "Enviar comparativa de optimización móvil si está disponible el contacto.";
  } else if (objection === "no_tengo_tiempo") {
    summary = "El cliente indicó falta de tiempo en ese momento.";
    action = "Programar reintento en franja de tarde o enviar WhatsApp recordatorio.";
  } else {
    summary = `Llamada finalizada (${outcome}) con fricción en ${friction}. Duración: ${durationSeconds}s.`;
    action = "Analizar si la frase gancho inicial conecta mejor en la variante opuesta.";
  }

  return {
    sentiment,
    frictionPoint: friction,
    objectionDetected: objection,
    qualityScore: score,
    summaryNote: summary,
    recommendedAction: action,
    evaluatedAt: now,
  };
}

/**
 * Analizador avanzado con IA (OpenAI gpt-4o-mini) con fallback heurístico garantizado
 */
export async function analyzeCallWithAI(
  transcripts: Array<{ role: "user" | "assistant"; text: string }>,
  durationSeconds: number,
  outcome: string,
  variant: "cercano" | "formal" = "cercano",
  apiKey?: string
): Promise<CallAnalysis> {
  const fallback = analyzeCallHeuristically(transcripts, durationSeconds, outcome, variant);

  if (!apiKey || transcripts.length < 2) {
    return fallback;
  }

  try {
    const dialogueLines = transcripts
      .map((t) => `${t.role === "assistant" ? "Bot" : "Cliente"}: ${t.text}`)
      .join("\n");

    const prompt = `Analiza esta llamada comercial en frío de diseño web para un negocio local.
Variante de guion usada: ${variant} (${variant === "cercano" ? "Cercano / Google Maps" : "Formal / Consultoría Digital"}).
Duración: ${durationSeconds} segundos.
Resultado del bot: ${outcome}.

Transcripción completa:
${dialogueLines}

Devuelve ÚNICAMENTE un objeto JSON con este formato exacto:
{
  "sentiment": "muy_receptivo" | "receptivo" | "neutral" | "esceptico" | "desinteresado" | "molesto",
  "frictionPoint": "saludo" | "propuesta" | "precio" | "whatsapp_permiso" | "numero_telefono" | "ninguno",
  "objectionDetected": "ninguna" | "ya_tengo_web" | "no_tengo_tiempo" | "precio_caro" | "desconfianza_origen" | "no_interesa" | "otra",
  "qualityScore": 1 a 10,
  "summaryNote": "Breve frase ejecutiva explicando cómo reaccionó el cliente y qué funcionó o falló",
  "recommendedAction": "Siguiente paso comercial sugerido"
}`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });

    if (!resp.ok) {
      return fallback;
    }

    const data = (await resp.json()) as any;
    const content = data.choices?.[0]?.message?.content;
    if (!content) return fallback;

    const parsed = JSON.parse(content);
    return {
      sentiment: parsed.sentiment || fallback.sentiment,
      frictionPoint: parsed.frictionPoint || fallback.frictionPoint,
      objectionDetected: parsed.objectionDetected || fallback.objectionDetected,
      qualityScore: typeof parsed.qualityScore === "number" ? Math.min(10, Math.max(1, parsed.qualityScore)) : fallback.qualityScore,
      summaryNote: parsed.summaryNote || fallback.summaryNote,
      recommendedAction: parsed.recommendedAction || fallback.recommendedAction,
      evaluatedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    console.warn("[CallAnalyzer] Error en análisis IA, usando heurístico:", err.message);
    return fallback;
  }
}
