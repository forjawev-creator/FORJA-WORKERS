import { normalizeSpokenSpanishDigits } from "../utils/phone-utils.js";

/**
 * Genera el esquema de herramientas (function tools) para la sesión de OpenAI Realtime
 */
export function buildSessionTools(options: {
  role: string;
  includeWhatsappTool: boolean;
  handoffEnabled?: boolean;
}): any[] {
  const isCommercial = options.role === "commercial";
  const tools: any[] = [
    {
      type: "function",
      name: "get_product_info",
      description: "Consulta información oficial y precios del catálogo de Forja Web.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Tema a consultar (ej. precios, dominio, movil, muestra)",
          },
        },
        required: ["topic"],
      },
    },
    {
      type: "function",
      name: "request_end_call",
      description: "Solicita la terminación de la llamada únicamente cuando el cliente rechaza explícitamente la propuesta y no desea recibir la muestra gratuita.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Motivo del fin de llamada (ej. refusal, call_later, wrong_person)" },
        },
        required: ["reason"],
      },
    },
  ];

  if (options.includeWhatsappTool || !isCommercial) {
    tools.push({
      type: "function",
      name: "record_whatsapp_consent",
      description: "Registra la autorización del cliente para enviar la muestra web por WhatsApp tras confirmar el número ('este mismo' o un móvil dictado). LLAMA A ESTA HERRAMIENTA EN SILENCIO una vez confirmado el número de destino ('este mismo' o los dígitos facilitados).",
      parameters: {
        type: "object",
        properties: {
          consent_given: { type: "boolean", description: "true si el cliente acepta el envío, false si lo rechaza" },
          client_evidence_quote: {
            type: "string",
            description: "Palabras del cliente separando con espacios los bloques de números EXACTAMENTE como los agrupó al hablar (ej. '648 648 441' si los dijo de 3 en 3, o '648 64 84 41' si los dijo de 3 y de 2 en 2)",
          },
          phone: { type: "string", description: "Número de teléfono especificado ('este' si confirmó este mismo o aceptó la llamada, o los dígitos que facilitó)" },
        },
        required: ["consent_given"],
      },
    });
  }

  if (isCommercial && options.handoffEnabled !== false) {
    tools.push({
      type: "function",
      name: "transfer_to_technical",
      description: "Transfiere la llamada al Asistente Técnico Especialista cuando el cliente plantea dudas técnicas avanzadas sobre desarrollo web, integraciones, hosting o soporte.",
      parameters: {
        type: "object",
        properties: {
          technical_doubt: { type: "string", description: "Pregunta o duda técnica exacta formulada por el cliente" },
          confirmed_trade: { type: "string", description: "Actividad o sector del negocio si se conoce" },
        },
        required: ["technical_doubt"],
      },
    });

    tools.push({
      type: "function",
      name: "transfer_to_human",
      description: "Transfiere la llamada a un responsable comercial humano cuando el cliente solicita explícitamente hablar con una persona de carne y hueso.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Motivo de la transferencia humana (ej. solicita_humano, duda_compleja, negociacion_especial)" },
          customer_notes: { type: "string", description: "Resumen breve de lo que necesita el cliente para el responsable humano" },
        },
        required: ["reason"],
      },
    });
  }

  return tools;
}

/**
 * Convierte el esquema de herramientas al formato oficial de Google Gemini Live
 */
export function buildGeminiTools(options: {
  role: string;
  includeWhatsappTool: boolean;
  handoffEnabled?: boolean;
}): any[] {
  const openAiTools = buildSessionTools(options);
  const functionDeclarations = openAiTools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  return [{ functionDeclarations }];
}

/**
 * Formatea los 9 dígitos exactamente con la misma agrupación que usó el cliente al hablar
 * (ej. de 3 en 3 -> "648, 648, 441" o de 3 y 2 en 2 -> "648, 64, 84, 41").
 */
export function formatPhoneForSpeech(
  phone: string,
  clientEvidenceQuote?: string,
  userPhoneChunks: string[] = [],
  allUserText = ""
): string {
  const clean = phone.replace(/\D/g, "");
  if (clean.length !== 9) {
    if (userPhoneChunks.length >= 2 && userPhoneChunks.join("") === clean) {
      return userPhoneChunks.join(", ");
    }
    return clean.split("").join(" ");
  }

  // 1. Comprobar si client_evidence_quote del modelo ya trae los grupos separados por espacios
  if (clientEvidenceQuote) {
    const normQuote = normalizeSpokenSpanishDigits(clientEvidenceQuote);
    const quoteGroups = normQuote.match(/\d+/g) || [];
    if (quoteGroups.length >= 2 && quoteGroups.join("") === clean) {
      return quoteGroups.join(", ");
    }
  }

  // 2. Reconstruir desde los bloques capturados por turno en userPhoneChunks
  if (userPhoneChunks.length >= 2) {
    const accGroups: string[] = [];
    let sumDigits = "";
    for (let i = userPhoneChunks.length - 1; i >= 0; i--) {
      accGroups.unshift(userPhoneChunks[i]);
      sumDigits = userPhoneChunks[i] + sumDigits;
      if (sumDigits === clean && accGroups.length >= 2) {
        return accGroups.join(", ");
      }
    }
  }

  // 3. Analizar si el cliente usó parejas de 2 dígitos o decenas habladas vs bloques de 3 dígitos
  const hasTwoDigitChunks =
    userPhoneChunks.some((c) => c.length === 2) ||
    (clientEvidenceQuote && (clientEvidenceQuote.match(/\b\d{2}\b/g) || []).length >= 2);

  const hasTensWords = /\b(veinte|veinti|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)\b/i.test(allUserText);

  if (hasTwoDigitChunks || hasTensWords) {
    // Formato español 3-2-2-2 (ej. "648, 64, 84, 41")
    return `${clean.slice(0, 3)}, ${clean.slice(3, 5)}, ${clean.slice(5, 7)}, ${clean.slice(7, 9)}`;
  }

  // Formato estándar español 3-3-3 (ej. "648, 648, 441")
  return `${clean.slice(0, 3)}, ${clean.slice(3, 6)}, ${clean.slice(6, 9)}`;
}
