import WebSocket from "ws";
import {
  AgentConfig,
  AudioCallback,
  ChatMessage,
  CallStage,
  PendingQuestion,
  CallOutcomeStatus,
  CallSessionContext,
  StagesConfig,
} from "./types.js";
import { bufferToInt16Array } from "./audio-bridge.js";
import { appEvents } from "./events.js";
import { resolveTtsVoice, cleanTextForTts, getDefaultStagesConfig } from "./storage.js";

/**
 * Función que verifica si el cliente otorgó autorización explícita para enviar el WhatsApp,
 * descartando cláusulas condicionales y preguntas sobre precio, dudas o peticiones de información previa.
 */
export function isExplicitWhatsAppAuthorization(text: string): boolean {
  if (!text) return false;
  const lower = text.trim().toLowerCase();
  const norm = normalizeSpanish(text);

  // 1. Descartar si el cliente rechaza o niega de forma explícita
  // Excepción: "no hay problema", "sin problema"
  if (/\b(no\s+hay\s+problema|sin\s+problema)\b/i.test(norm)) {
    return true;
  }
  if (/\b(no|nunca|jamas|tampoco|ni\s+hablar|ningun|ninguno|ninguna|para\s+nada|de\s+ninguna\s+manera|rechazo|rechazar|cancela|cancelar|deja|dejadme|borra|borrar|no\s+quiero|no\s+me\s+interesa)\b/i.test(norm)) {
    return false;
  }

  // 2. Descartar si solo está preguntando dudas o precios sin aceptar
  if (/(cuanto\s+cuesta|que\s+precio|cuanto\s+vale|precio|coste|tarifa|cobra|explica|que\s+es|de\s+que|depende|pensar|duda)/i.test(norm)) {
    // Si además dice claramente "envíamelo", "mándalo", "vale", etc., prima la aceptación
    if (!/\b(envia|manda|pasa|vale|bueno|de\s+acuerdo|si)\b/i.test(norm)) {
      return false;
    }
  }

  // 3. Expresiones afirmativas y de aceptación en español (cualquier tipo de aceptación es válida)
  if (/\b(si|vale|bueno|de\s+acuerdo|perfecto|claro|por\s+supuesto|adelante|estupendo|genial|ok|okay|apuntamelo|apunta|enviamelo|enviamela|envialo|enviala|mandamelo|mandamela|mandalo|mandala|pasamelo|pasamela|puedes\s+enviar|mandame|enviame|pasame|venga|dale|hazlo|quiero|me\s+parece\s+bien|bien|esta\s+bien|por\s+mi\s+bien|al\s+mismo|este\s+numero|este\s+mismo|a\s+este|autorizado|confirmado|acepto|aceptado|hecho|trato\s+hecho|cuando\s+quieras|cuando\s+este|pruebalo|probar|verla)\b/i.test(norm)) {
    return true;
  }

  // 4. Si contiene un número de teléfono de 9 cifras
  if (/\b[6789]\d{2}[\s\-]?\d{3}[\s\-]?\d{3}\b/.test(lower)) {
    return true;
  }

  return false;
}


/**
 * Normaliza texto en español para concordancia fonética y semántica:
 * - Convierte a minúsculas
 * - Descompone y elimina tildes y diacríticos (á->a, é->e, í->i, ó->o, ú->u)
 * - Convierte signos de puntuación e interrogación en espacios
 * - Limpia espacios sobrantes
 */
export function normalizeSpanish(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:_()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Máquina de Estados Conversacional con 5 Etapas Controladas por Código,
 * Tratamiento Transversal de Objeciones y Cierre Determinista.
 */
export class CallStateMachine {
  private context: CallSessionContext;
  private stages: StagesConfig;
  private config: AgentConfig;
  private sessionId?: string;

  constructor(config: AgentConfig, sessionId?: string) {
    this.config = config;
    this.sessionId = sessionId;
    this.stages = config.stages || getDefaultStagesConfig();
    this.context = {
      currentStage: 1,
      pendingQuestion: "CONFIRM_BUSINESS",
      businessConfirmed: false,
      interestShown: false,
      doubtsResolved: [],
      whatsappAuthorized: false,
      phoneConfirmed: false,
      outcomeStatus: "EN_CURSO",
      shouldHangUp: false,
      sessionId,
    };
    this.broadcastUpdate();
  }

  public getContext(): CallSessionContext {
    return { ...this.context };
  }

  public setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.context.sessionId = sessionId;
  }

  public broadcastUpdate(): void {
    const ctx = this.getContext();
    appEvents.broadcast({
      type: "stage_update",
      context: ctx,
      sessionContext: ctx,
      sessionId: this.sessionId,
    });
  }

  public getPriceExplanation(): string {
    const install = (this.config as any).installPrice || "99";
    const basic = (this.config as any).monthlyPriceBasic || "5";
    const full = (this.config as any).monthlyPriceFull || "10";
    if (this.stages.objections?.price && this.stages.objections.price.trim().length > 0) {
      let p = this.stages.objections.price;
      p = p.replace(/99\s*euros?/gi, `${install} euros`);
      p = p.replace(/5\s*o\s*10\s*euros?/gi, `${basic} o ${full} euros`);
      return p;
    }
    return `La preparación y entrega de la muestra es 100% gratuita y sin ningún compromiso para que la valores. Si más adelante decides contratar la web definitiva, son ${install} euros de instalación y ${basic} o ${full} euros al mes según el plan, pero primero te la preparamos sin coste.`;
  }

  public isRefusal(norm: string): boolean {
    if (/^(no|para nada|en absoluto|paso|que va|nada|not interested)$/.test(norm)) return true;
    return /\b(no me interesa|no nos interesa|no interesa|no quiero|no gracias|no me hace falta|dejadme|dejadnos|no llameis|no llamen|borrad mi numero|borre mi numero|no llame mas|ya le he dicho que no|no me llamen|not interested|no thanks|dont call|do not call)\b/.test(norm);
  }

  public isWrongPerson(norm: string): boolean {
    return /\b(se equivoca|te equivocas|numero equivocado|aqui no es|no es ningun|no soy el responsable|no soy la responsable|no trabajo aqui|no conozco|wrong number|wrong person)\b/.test(norm);
  }

  public isCallLater(norm: string): boolean {
    return /\b(estoy ocupad|estoy conduciendo|estoy en reunion|estoy trabajando|estoy atendiendo|estoy comiendo|ahora no puedo|llamame mas tarde|llamame luego|llamame manana|llamame despues|llame mas tarde|llame luego|en otro momento|vuelve a llamar|call later|busy now)\b/.test(norm);
  }

  public isGreetingOnly(norm: string): boolean {
    return /^(hola|buenas|buenos dias|buenas tardes|hola buenas|hola que tal|quien es|de parte de quien|quien llama|quien me llama|con quien hablo|hello|hi)$/.test(norm);
  }

  public isBusinessConfirmation(norm: string): boolean {
    if (this.isRefusal(norm)) return false;
    if (this.isGreetingOnly(norm)) return false;

    if (/\b(soy yo|el mismo|la misma|al habla|conmigo|con el|con ella|yo soy|aqui es|es aqui|con quien habla)\b/.test(norm)) {
      return true;
    }
    if (/\b(dime|digame|cuentame|adelante|te escucho|le escucho)\b/.test(norm)) {
      return true;
    }
    if (/\b(dueno|duena|responsable|titular|gerente|encargado|encargada|propietario|propietaria)\b/.test(norm)) {
      return true;
    }
    if (/\b(si|claro|por supuesto|correcto|exacto|efectivamente)\b/.test(norm)) {
      return true;
    }
    return false;
  }

  public isConditionOrDoubt(norm: string, rawText: string): boolean {
    if (rawText.includes("?")) return true;
    return /\b(pero|antes|primero|si no me cobras|siempre que|si es gratis|si no hay que pagar|como funciona|de que se trata|de que va|que haceis|que incluye|explicame|explicamelo|cuenta me|cuentame|a ver|no entiendo|tengo dudas|que compromiso|no me fio)\b/.test(norm);
  }

  public isPriceDoubt(norm: string): boolean {
    return /\b(cuanto cuesta|que precio|cuanto vale|precio|coste|tarifa|cuanto cobrais|cobrais|presupuesto|pagar|gratis|de pago|hay que pagar|how much|cost|price)\b/.test(norm);
  }

  public isAlreadyHasWebDoubt(norm: string): boolean {
    return /\b(ya tengo web|ya tenemos web|ya tengo pagina|ya tenemos pagina|tenemos informatico|tengo informatico|ya esta hecha|ya la tenemos|already have a website|already have web)\b/.test(norm);
  }

  public isNoTimeDoubt(norm: string): boolean {
    return /\b(no tengo tiempo|no tenemos tiempo|voy liado|voy liada|vamos liados|mucho lio|estoy liado|estoy liada|no time|dont have time)\b/.test(norm);
  }

  public isAffirmativeOrInterest(norm: string, rawText: string): boolean {
    if (this.isRefusal(norm) || this.isPriceDoubt(norm) || this.isConditionOrDoubt(norm, rawText)) return false;
    if (/\b(envia|manda|pasa)(mela|melo|nosla|noslo|la|lo)?\b/.test(norm)) return true;
    if (/\b(me interesa|nos interesa|interesa|me gustaria|nos gustaria|buena idea|me parece bien|me parece genial|me parece estupendo|me parece perfecto)\b/.test(norm)) return true;
    if (/\b(si|vale|de acuerdo|perfecto|claro|adelante|por supuesto|estupendo|ok|bien|venga|genial|sin problema|por favor)\b/.test(norm)) return true;
    return false;
  }

  public isExplicitWhatsAppAgreement(norm: string, rawText: string): boolean {
    // Si contiene rechazo, duda de precio o cualquier condición/duda ("pero antes", "si no me cobras"), NO autoriza
    if (this.isRefusal(norm) || this.isPriceDoubt(norm) || this.isConditionOrDoubt(norm, rawText)) return false;
    if (/\b(envia|manda|pasa)(mela|melo|nosla|noslo|la|lo)?\b/.test(norm)) return true;
    if (/\b(mandamela por whatsapp|enviamela por whatsapp|pasamela por whatsapp|mandala por whatsapp|enviala por whatsapp)\b/.test(norm)) return true;
    if (/\b(me interesa|nos interesa|interesa|me gustaria|nos gustaria|buena idea|me parece bien|me parece genial|me parece estupendo|me parece perfecto)\b/.test(norm)) return true;
    if (/\b(si|vale|de acuerdo|perfecto|claro|adelante|por supuesto|estupendo|ok|bien|venga|genial|sin problema|por favor)\b/.test(norm)) return true;
    return false;
  }

  public isSamePhone(norm: string): boolean {
    return /\b(a este mismo|al mismo|este numero|este movil|este telefono|este whatsapp|aqui mismo|al que llamas|al que estas llamando|a este|en este|al movil con el que|al telefono)\b/.test(norm);
  }

  public extractPhoneNumber(text: string): string | null {
    const clean = text.replace(/[\s.-]/g, "");
    const m = clean.match(/\b([6789]\d{8})\b/);
    return m ? m[1] : null;
  }

  private getCurrentStageName(): string {
    switch (this.context.currentStage) {
      case 1: return this.stages.stage1.name;
      case 2: return this.stages.stage2.name;
      case 3: return this.stages.stage3.name;
      case 4: return this.stages.stage4.name;
      case 5: return this.stages.stage5.name;
      default: return "";
    }
  }

  private getCurrentStageGoal(): string {
    switch (this.context.currentStage) {
      case 1: return this.stages.stage1.goal;
      case 2: return this.stages.stage2.goal;
      case 3: return this.stages.stage3.goal;
      case 4: return this.stages.stage4.goal;
      case 5: return this.stages.stage5.goal;
      default: return "";
    }
  }

  private getCurrentStagePhrase(): string {
    switch (this.context.currentStage) {
      case 1: return this.stages.stage1.guidePhrase;
      case 2: return this.stages.stage2.guidePhrase;
      case 3: return this.stages.stage3.guidePhrase;
      case 4: return this.stages.stage4.guidePhrase;
      case 5: return this.stages.stage5.guidePhrase;
      default: return "";
    }
  }

  private getResumePhrase(): string {
    if (this.context.currentStage === 2) {
      return this.stages.stage2.guidePhrase || "¿Te parecería bien que te preparemos la muestra gratuita sin ningún compromiso para que la valores?";
    }
    if (this.context.currentStage === 3) {
      return "¿Te parecería bien que te preparemos la muestra gratuita y te la enviemos por WhatsApp para que le eches un vistazo?";
    }
    if (this.context.currentStage === 4) {
      if (this.context.pendingQuestion === "CONFIRM_PHONE") {
        return "¿Te la enviamos a este mismo número al que llamamos o prefieres otro móvil?";
      }
      return this.stages.stage4.guidePhrase || "¿Nos autorizas a preparártela y enviártela por WhatsApp a este número para que le eches un vistazo?";
    }
    return this.stages.stage2.guidePhrase || "¿Te parecería bien que te preparemos la muestra previa gratuita?";
  }

  public processUserTurn(userText: string): { dynamicPrompt: string } {
    const norm = normalizeSpanish(userText);

    // 1. RECHAZO / SALIDA INMEDIATA (Sin insistir)
    if (this.isRefusal(norm)) {
      this.context.outcomeStatus = "RECHAZADO";
      this.context.currentStage = 5;
      this.context.pendingQuestion = "NONE";
      this.context.shouldHangUp = true;
      this.broadcastUpdate();
      return {
        dynamicPrompt: `[CONTROL DEL PROGRAMA: SALIDA POR RECHAZO]
OBJETIVO: ${this.stages.stage5.goal}
El cliente rechaza la propuesta o dice que no le interesa.
REGLA ESTRICTA: NO insistas, no intentes argumentar nada. Acepta con educación y despídete en 1 frase:
"${this.stages.objections.refusal}"`,
      };
    }

    // 2. PERSONA EQUIVOCADA
    if (this.isWrongPerson(norm)) {
      this.context.outcomeStatus = "PERSONA_EQUIVOCADA";
      this.context.currentStage = 5;
      this.context.pendingQuestion = "NONE";
      this.context.shouldHangUp = true;
      this.broadcastUpdate();
      return {
        dynamicPrompt: `[CONTROL DEL PROGRAMA: SALIDA POR NÚMERO EQUIVOCADO]
OBJETIVO: ${this.stages.stage5.goal}
El interlocutor indica que no es el negocio o que el número es erróneo.
REGLA ESTRICTA: Pide disculpas brevemente y despídete en 1 frase:
"${this.stages.objections.wrongPerson}"`,
      };
    }

    // 3. LLAMAR MÁS TARDE / OCUPADO
    if (this.isCallLater(norm)) {
      this.context.outcomeStatus = "LLAMAR_DESPUES";
      this.context.currentStage = 5;
      this.context.pendingQuestion = "NONE";
      this.context.shouldHangUp = true;
      this.broadcastUpdate();
      return {
        dynamicPrompt: `[CONTROL DEL PROGRAMA: CLIENTE OCUPADO / LLAMAR DESPUÉS]
OBJETIVO: ${this.stages.stage5.goal}
El interlocutor está ocupado o pide llamar después.
REGLA ESTRICTA: Respeta su tiempo con amabilidad y despídete en 1 frase:
"${this.stages.objections.callLater}"`,
      };
    }

    // 4. CONSULTA DE PRECIO -> ENTRA EN ETAPA 3 (ACLARACIONES)
    if (this.isPriceDoubt(norm)) {
      this.context.currentStage = 3;
      if (!this.context.doubtsResolved.includes("precio")) {
        this.context.doubtsResolved.push("precio");
      }
      this.broadcastUpdate();
      return {
        dynamicPrompt: `[CONTROL DEL PROGRAMA: ETAPA 3 - ${this.stages.stage3.name.toUpperCase()}]
OBJETIVO: ${this.stages.stage3.goal}
RESPUESTA AL PRECIO OBLIGATORIA:
"${this.getPriceExplanation()}"
CONDICIÓN DE AVANCE: ${this.stages.stage3.advanceCondition}
DISTINCIÓN CRUCIAL: Dejar clarísimo que preparar la muestra previa es 100% GRATIS y sin compromiso.
Termina retomando la pregunta: "${this.getResumePhrase()}"`,
      };
    }

    // 5. YA TIENE PÁGINA WEB -> ENTRA EN ETAPA 3 (ACLARACIONES)
    if (this.isAlreadyHasWebDoubt(norm)) {
      this.context.currentStage = 3;
      if (!this.context.doubtsResolved.includes("ya_tengo_web")) {
        this.context.doubtsResolved.push("ya_tengo_web");
      }
      this.broadcastUpdate();
      return {
        dynamicPrompt: `[CONTROL DEL PROGRAMA: ETAPA 3 - ${this.stages.stage3.name.toUpperCase()}]
OBJETIVO: ${this.stages.stage3.goal}
El cliente comenta que ya tiene página web.
Responde: "${this.stages.objections.alreadyHasWeb}".
Termina preguntando: "${this.getResumePhrase()}"`,
      };
    }

    // 6. FALTA DE TIEMPO -> ENTRA EN ETAPA 3 (ACLARACIONES)
    if (this.isNoTimeDoubt(norm)) {
      this.context.currentStage = 3;
      if (!this.context.doubtsResolved.includes("no_tiempo")) {
        this.context.doubtsResolved.push("no_tiempo");
      }
      this.broadcastUpdate();
      return {
        dynamicPrompt: `[CONTROL DEL PROGRAMA: ETAPA 3 - ${this.stages.stage3.name.toUpperCase()}]
OBJETIVO: ${this.stages.stage3.goal}
El cliente dice no tener tiempo.
Responde: "${this.stages.objections.noTime}".
Termina preguntando: "${this.getResumePhrase()}"`,
      };
    }

    // 7. PREGUNTA O CONDICIÓN DEL CLIENTE -> ENTRA EN ETAPA 3 (ACLARACIONES)
    if (this.isConditionOrDoubt(norm, userText)) {
      this.context.currentStage = 3;
      if (!this.context.doubtsResolved.includes("condicion_duda")) {
        this.context.doubtsResolved.push("condicion_duda");
      }
      this.broadcastUpdate();
      return {
        dynamicPrompt: `[CONTROL DEL PROGRAMA: ETAPA 3 - ${this.stages.stage3.name.toUpperCase()}]
OBJETIVO: ${this.stages.stage3.goal}
El cliente plantea una condición o pregunta: "${userText}".
REGLAS ESTRICTAS:
1. Responde a su duda con calma y aclárale que la preparación de la muestra es 100% gratuita y sin compromiso.
2. NUNCA des por autorizada la muestra mientras el cliente tenga dudas o condiciones pendientes.
3. Termina retomando la pregunta: "${this.getResumePhrase()}"`,
      };
    }

    // 8. TRANSICIONES POR ETAPAS CONTROLADAS POR CÓDIGO
    switch (this.context.currentStage) {
      case 1: { // Presentación
        if (this.isGreetingOnly(norm)) {
          this.broadcastUpdate();
          return {
            dynamicPrompt: `[ETAPA 1: ${this.stages.stage1.name.toUpperCase()}]
El interlocutor ha saludado ("${userText}").
OBJETIVO: ${this.stages.stage1.goal}
FRASE GUÍA: "${this.stages.stage1.guidePhrase}"
Saluda amablemente y confirma si hablas con el responsable del negocio.`,
          };
        }

        if (this.isBusinessConfirmation(norm)) {
          this.context.businessConfirmed = true;
          this.context.currentStage = 2;
          this.context.pendingQuestion = "OFFER_PROPOSAL";
          this.broadcastUpdate();
          return {
            dynamicPrompt: `[TRANSICIÓN VALIDADA: AVANZAS A ETAPA 2 - ${this.stages.stage2.name.toUpperCase()}]
El cliente ha confirmado que es el negocio/responsable.
OBJETIVO: ${this.stages.stage2.goal}
FRASE GUÍA: "${this.stages.stage2.guidePhrase}"
CONDICIÓN PARA AVANZAR: ${this.stages.stage2.advanceCondition}
REGLA ESTRICTA DE ETAPA 2: Presenta la propuesta de preparar una muestra previa gratuita sin compromiso y pregunta si le parecería bien verla. NO te despidas todavía. Responde en 1 o máximo 2 oraciones breves y conversacionales.`,
          };
        }

        this.broadcastUpdate();
        return {
          dynamicPrompt: `[ETAPA 1: ${this.stages.stage1.name.toUpperCase()}]
El cliente respondió: "${userText}".
OBJETIVO: ${this.stages.stage1.goal}
FRASE GUÍA: "${this.stages.stage1.guidePhrase}"
Instrucciones estrictas: Atiende brevemente su intervención en 1 oración corta y cordial y confirma si es el responsable del negocio para poder comentarle la propuesta.`,
        };
      }

      case 2: { // Propuesta
        if (this.isAffirmativeOrInterest(norm, userText)) {
          this.context.interestShown = true;
          this.context.currentStage = 4;
          this.context.pendingQuestion = "WHATSAPP_PERMISSION";
          this.broadcastUpdate();
          return {
            dynamicPrompt: `[TRANSICIÓN VALIDADA: AVANZAS A ETAPA 4 - ${this.stages.stage4.name.toUpperCase()}]
El cliente muestra interés en la propuesta sin condiciones ni objeciones.
OBJETIVO: ${this.stages.stage4.goal}
FRASE GUÍA OBLIGATORIA: "${this.stages.stage4.guidePhrase}"
CONDICIÓN PARA AVANZAR: ${this.stages.stage4.advanceCondition}
REGLA ESTRICTA DE ETAPA 4: Pide permiso explícito para enviarle la muestra por WhatsApp. PROHIBIDO despedirse ("que tengas buen día") o dar por cerrada la llamada en este turno; espera su respuesta.`,
          };
        }
        break;
      }

      case 3: { // Aclaraciones
        if (this.isAffirmativeOrInterest(norm, userText) || this.isExplicitWhatsAppAgreement(norm, userText)) {
          this.context.interestShown = true;
          this.context.currentStage = 4;
          this.context.whatsappAuthorized = true;
          this.context.evidenceQuote = userText;
          this.context.pendingQuestion = "CONFIRM_PHONE";
          this.broadcastUpdate();
          return {
            dynamicPrompt: `[TRANSICIÓN VALIDADA: DUDAS RESUELTAS -> AVANZAS A ETAPA 4 - CONFIRMAR NÚMERO]
El cliente ha aceptado tras resolver sus dudas.
OBJETIVO: ${this.stages.stage4.goal}
Pregunta amablemente: "¿Te la envío a este mismo número al que te llamo o prefieres facilitarme otro móvil?"
REGLA ESTRICTA: NO te despidas todavía; espera a que confirme el número de teléfono.
CONDICIÓN PARA AVANZAR: ${this.stages.stage4.advanceCondition}`,
          };
        }
        break;
      }

      case 4: { // Autorización y Contacto
        if (this.context.pendingQuestion === "WHATSAPP_PERMISSION") {
          if (this.isExplicitWhatsAppAgreement(norm, userText)) {
            this.context.whatsappAuthorized = true;
            this.context.evidenceQuote = userText;
            const extractedNum = this.extractPhoneNumber(userText);
            const sameNum = this.isSamePhone(norm);

            // Si el cliente ya indicó el número o confirmó "a este mismo" en la misma frase
            if (sameNum || extractedNum) {
              this.context.phoneConfirmed = true;
              if (extractedNum) {
                this.context.confirmedPhone = extractedNum;
              }
              this.context.outcomeStatus = "AUTORIZADO";
              this.context.currentStage = 5;
              this.context.pendingQuestion = "NONE";
              this.context.shouldHangUp = true;
              this.broadcastUpdate();
              appEvents.broadcast({ type: "whatsapp_authorized", sessionId: this.sessionId });
              return {
                dynamicPrompt: `[TRANSICIÓN VALIDADA: PERMISO Y TELÉFONO CONFIRMADOS -> ETAPA 5 - ${this.stages.stage5.name.toUpperCase()}]
¡ÉXITO COMERCIAL! Permiso de WhatsApp otorgado y destino confirmado (${extractedNum || "este mismo número"}).
OBJETIVO: ${this.stages.stage5.goal}
FRASE DE CIERRE: "${this.stages.stage5.guidePhrase}"
Agradece amablemente y finaliza la llamada en 1 sola frase.`,
              };
            }

            this.context.pendingQuestion = "CONFIRM_PHONE";
            this.broadcastUpdate();
            return {
              dynamicPrompt: `[ETAPA 4: PERMISO WHATSAPP REGISTRADO -> AHORA CONFIRMAR NÚMERO]
El cliente autorizó el envío de la muestra por WhatsApp.
PASO OBLIGATORIO: Ahora DEBES confirmar el teléfono exacto.
Pregunta únicamente: "¿Te la envío a este mismo número al que te llamo o prefieres facilitarme otro móvil?"
PROHIBIDO despedirse todavía: no digas "que tengas buen día" hasta que confirme el número.`,
            };
          }
        } else if (this.context.pendingQuestion === "CONFIRM_PHONE") {
          const wantsDifferentPhone = /\b(otro|otra|distinto|diferente|cambiar|cambio|no es este)\b/.test(norm);
          const extractedNum = this.extractPhoneNumber(userText);
          const sameNum =
            !wantsDifferentPhone &&
            (this.isSamePhone(norm) ||
              /^(si|vale|correcto|exacto|este|a este)$/.test(norm) ||
              this.isAffirmativeOrInterest(norm, userText));

          if (sameNum || extractedNum) {
            this.context.phoneConfirmed = true;
            if (extractedNum) {
              this.context.confirmedPhone = extractedNum;
            }
            this.context.outcomeStatus = "AUTORIZADO";
            this.context.currentStage = 5;
            this.context.pendingQuestion = "NONE";
            this.context.shouldHangUp = true;
            this.broadcastUpdate();
            appEvents.broadcast({ type: "whatsapp_authorized", sessionId: this.sessionId });
            return {
              dynamicPrompt: `[TRANSICIÓN VALIDADA: AVANZAS A ETAPA 5 - ${this.stages.stage5.name.toUpperCase()}]
¡ÉXITO COMERCIAL! Permiso de WhatsApp otorgado y número de teléfono confirmado.
OBJETIVO: ${this.stages.stage5.goal}
FRASE DE CIERRE: "${this.stages.stage5.guidePhrase}"
CONDICIÓN DE AVANCE: ${this.stages.stage5.advanceCondition}`,
            };
          }
        }
        break;
      }

      case 5: { // Despedida
        this.context.shouldHangUp = true;
        this.broadcastUpdate();
        return {
          dynamicPrompt: `[ETAPA 5: ${this.stages.stage5.name.toUpperCase()}]
OBJETIVO: ${this.stages.stage5.goal}
La llamada ha concluido. Despídete amablemente en 1 sola frase y finaliza.`,
        };
      }
    }

    this.broadcastUpdate();
    return {
      dynamicPrompt: `[ETAPA ACTUAL: ${this.context.currentStage} - ${this.getCurrentStageName()}]
OBJETIVO DE LA ETAPA: ${this.getCurrentStageGoal()}
FRASE ORIENTATIVA: "${this.getCurrentStagePhrase()}"
Pregunta o acción pendiente: ${this.context.pendingQuestion}.
Mantén el tono conversacional, responde brevemente y guía al cliente hacia el objetivo de la etapa.`,
    };
  }

  /**
   * Sincroniza defensivamente la máquina de estados con la respuesta emitida por el asistente
   * si el asistente ya había preguntado por WhatsApp y tras el "Sí" del cliente emite el cierre final.
   */
  public syncWithAssistantTurn(userText: string, assistantText: string, conversationHistory: ChatMessage[]): void {
    if (!userText || !assistantText) return;
    const normUser = normalizeSpanish(userText);
    const normAssistant = normalizeSpanish(assistantText);

    // Verificar si el asistente acaba de confirmar el envío a este mismo WhatsApp y despedirse
    const assistantConfirmedSend =
      /\b(te la preparo y te la envio|te lo preparo y te lo envio|te la envio a este mismo whatsapp|te la mando a este mismo whatsapp)\b/.test(normAssistant);
    const assistantSaidGoodbye =
      /\b(buen dia|buena tarde|buenas tardes|muchas gracias|hasta luego|un saludo)\b/.test(normAssistant);

    // Verificar si en el historial previo el asistente ya había mencionado WhatsApp
    const prevAssistantAskedWhatsApp = conversationHistory.some(
      (m) => m.role === "assistant" && /whatsapp/i.test(m.content)
    );

    if (
      assistantConfirmedSend &&
      assistantSaidGoodbye &&
      prevAssistantAskedWhatsApp &&
      this.isExplicitWhatsAppAgreement(normUser, userText)
    ) {
      this.context.whatsappAuthorized = true;
      if (!this.context.evidenceQuote) {
        this.context.evidenceQuote = userText;
      }
      this.context.phoneConfirmed = true;
      const extractedNum = this.extractPhoneNumber(userText);
      if (extractedNum) {
        this.context.confirmedPhone = extractedNum;
      }
      this.context.outcomeStatus = "AUTORIZADO";
      this.context.currentStage = 5;
      this.context.pendingQuestion = "NONE";
      this.context.shouldHangUp = true;
      this.broadcastUpdate();
      appEvents.broadcast({ type: "whatsapp_authorized", sessionId: this.sessionId });
    }
  }
}

/**
 * Sesión de Reconocimiento de Voz en Tiempo Real (STT) vía WebSocket de Together AI
 */
export class RealtimeSttSession {
  private ws: WebSocket | null = null;
  private config: AgentConfig;
  private pendingAudioBuffers: Buffer[] = [];
  public isConnected = false;
  public connectionError: string | null = null;
  private currentTranscriptionResolver: ((text: string) => void) | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private commitTimeout: NodeJS.Timeout | null = null;
  private settleTimeout: NodeJS.Timeout | null = null;

  private deltaAccumulator = "";
  private finalTranscript = "";

  constructor(config: AgentConfig) {
    this.config = config;
  }

  private clearCommitTimers(): void {
    if (this.commitTimeout) {
      clearTimeout(this.commitTimeout);
      this.commitTimeout = null;
    }
    if (this.settleTimeout) {
      clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
  }

  private resolvePendingTranscription(text: string): void {
    this.clearCommitTimers();
    this.finalTranscript = "";
    this.deltaAccumulator = "";
    const resolver = this.currentTranscriptionResolver;
    this.currentTranscriptionResolver = null;
    if (resolver) {
      resolver(text);
    }
  }

  public async warmup(): Promise<void> {
    if (!this.config.apiKey || this.config.apiKey === "tu_api_key_aqui") {
      this.connectionError = "TOGETHER_API_KEY no configurada o inválida.";
      console.warn(`[STT] ${this.connectionError}`);
      return;
    }

    return new Promise((resolve) => {
      const url = `wss://api.together.ai/v1/realtime?model=${encodeURIComponent(
        this.config.sttModel
      )}&input_audio_format=pcm_s16le_${this.config.sampleRate}&language=es`;

      try {
        this.ws = new WebSocket(url, {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        });

        this.ws.on("open", () => {
          console.log("[STT] Conexión WebSocket establecida con Together AI (idioma: español)");
          this.isConnected = true;
          this.connectionError = null;
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }

          try {
            this.ws?.send(JSON.stringify({
              type: "session.update",
              session: {
                input_audio_transcription: {
                  model: this.config.sttModel,
                  language: "es",
                },
              },
            }));
          } catch {}

          if (this.pendingAudioBuffers.length > 0) {
            for (const buf of this.pendingAudioBuffers) {
              this.sendAudio(buf);
            }
            this.pendingAudioBuffers = [];
          }
          resolve();
        });

        this.ws.on("message", (raw: WebSocket.RawData) => {
          this.handleMessage(raw.toString());
        });

        this.ws.on("error", (err) => {
          this.connectionError = `Error de WebSocket STT: ${err.message}`;
          console.error(`[STT] ${this.connectionError}`);
          this.isConnected = false;
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }
          resolve();
        });

        this.ws.on("close", (code) => {
          console.log(`[STT] Conexión WebSocket cerrada (código ${code})`);
          this.isConnected = false;
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }
        });

        this.connectTimer = setTimeout(() => {
          if (!this.isConnected && !this.connectionError) {
            this.connectionError = "Timeout de conexión al servicio STT de Together AI";
            console.warn(`[STT] ${this.connectionError}`);
            resolve();
          }
        }, 3500);
      } catch (e: any) {
        this.connectionError = e.message;
        console.error(`[STT] Fallo crítico iniciando STT: ${e.message}`);
        resolve();
      }
    });
  }

  private handleMessage(dataStr: string): void {
    try {
      const msg = JSON.parse(dataStr);

      if (
        msg.type === "conversation.item.input_audio_transcription.completed" ||
        msg.type === "response.audio_transcript.done"
      ) {
        const text = (msg.transcript || msg.text || "").trim();
        if (text) {
          this.finalTranscript = [this.finalTranscript, text].filter(Boolean).join(" ").trim();
        } else if (this.deltaAccumulator.trim()) {
          this.finalTranscript = [this.finalTranscript, this.deltaAccumulator.trim()].filter(Boolean).join(" ").trim();
        }
        this.deltaAccumulator = "";

        if (this.currentTranscriptionResolver) {
          this.resolvePendingTranscription(this.finalTranscript);
        }
      } else if (msg.type === "conversation.item.input_audio_transcription.delta") {
        if (msg.delta) {
          this.deltaAccumulator += msg.delta;
          if (this.currentTranscriptionResolver) {
            if (this.settleTimeout) {
              clearTimeout(this.settleTimeout);
            }
            this.settleTimeout = setTimeout(() => {
              const combined = [this.finalTranscript, this.deltaAccumulator.trim()].filter(Boolean).join(" ").trim();
              if (combined && this.currentTranscriptionResolver) {
                this.resolvePendingTranscription(combined);
              }
            }, 250);
          }
        }
      }
    } catch {
      // Ignorar
    }
  }

  public sendAudio(chunk: Buffer): void {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudioBuffers.push(chunk);
      return;
    }

    try {
      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64"),
      });
      this.ws.send(payload);
    } catch {}
  }

  public clearAudio(): void {
    this.clearCommitTimers();
    this.pendingAudioBuffers = [];
    this.deltaAccumulator = "";
    this.finalTranscript = "";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      } catch {}
    }
  }

  public async commitAndGetTranscription(): Promise<string> {
    return new Promise((resolve) => {
      if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const fallback = [this.finalTranscript, this.deltaAccumulator.trim()].filter(Boolean).join(" ").trim();
        this.finalTranscript = "";
        this.deltaAccumulator = "";
        resolve(fallback);
        return;
      }

      this.clearCommitTimers();
      this.currentTranscriptionResolver = resolve;

      const alreadyHasCompleted = this.finalTranscript.trim().length > 0;
      const alreadyHasDelta = this.deltaAccumulator.trim().length > 0;

      // Si Together AI ya emitió .completed o .delta durante la ventana de silencio del VAD (500ms),
      // no bloquear 4000ms esperando otro evento que no llegará: dar solo un margen breve de asentamiento.
      const waitMs = alreadyHasCompleted ? 180 : alreadyHasDelta ? 300 : 1200;

      this.commitTimeout = setTimeout(() => {
        if (this.currentTranscriptionResolver) {
          const fallback = [this.finalTranscript, this.deltaAccumulator.trim()].filter(Boolean).join(" ").trim();
          this.resolvePendingTranscription(fallback);
        }
      }, waitMs);

      try {
        this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {
        this.resolvePendingTranscription("");
      }
    });
  }

  public close(): void {
    this.isConnected = false;
    this.clearCommitTimers();
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.on("error", () => {});
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close();
        } else {
          this.ws.terminate();
        }
      } catch {}
      this.ws = null;
    }
  }
}

/**
 * Sesión de Síntesis de Voz en Tiempo Real (TTS) vía WebSocket de Together AI
 * Separa estrictamente el ciclo de vida de la conexión física (connectionEpoch)
 * del turno activo (activeTurnId) para que turnos sucesivos reciban correctamente el audio.
 */
export class RealtimeTtsSession {
  private ws: WebSocket | null = null;
  private config: AgentConfig;
  private onAudioChunk: (turnId: number, pcmChunk24k: Int16Array) => void;
  public isConnected = false;
  public connectionError: string | null = null;

  private activeTurnId = 0;
  // connectionEpoch se incrementa ÚNICAMENTE cuando la conexión WebSocket se destruye/renueva
  private connectionEpoch = 0;
  private interrupted = false;

  private pendingSentencesCount = 0;
  private generationDoneResolvers: Array<() => void> = [];
  public onFirstAudioCallback: ((turnId: number) => void) | null = null;
  private activeAbortControllers: Set<AbortController> = new Set();
  private pcmTrailingBuffer: Buffer = Buffer.alloc(0);
  private restPlaybackChain: Promise<void> = Promise.resolve();

  constructor(
    config: AgentConfig,
    onAudioChunk: (turnId: number, pcmChunk24k: Int16Array) => void
  ) {
    this.config = config;
    this.onAudioChunk = onAudioChunk;
  }

  /**
   * Actualiza el turno activo sin alterar la época de conexión del WebSocket
   */
  public setTurnId(turnId: number): void {
    this.activeTurnId = turnId;
    this.interrupted = false;
    this.pcmTrailingBuffer = Buffer.alloc(0);
    this.restPlaybackChain = Promise.resolve();
  }

  public async warmup(): Promise<void> {
    if (!this.config.apiKey || this.config.apiKey === "tu_api_key_aqui") {
      this.connectionError = "TOGETHER_API_KEY no configurada o inválida.";
      console.warn(`[TTS] ${this.connectionError}`);
      return;
    }

    // El modelo Kokoro-82M en Together AI opera directamente sobre el endpoint REST de baja latencia
    // (su endpoint WebSocket no emite session.created y causaba 3.5s de retraso al inicio de cada llamada).
    if (/kokoro/i.test(this.config.ttsModel || "")) {
      this.isConnected = false;
      this.connectionError = null;
      return;
    }

    return new Promise((resolve) => {
      // Pedir explícitamente formato PCM de 16-bit a 24000 Hz en los parámetros de la URL
      const speed = this.config.ttsSpeed || 1.0;
      const voice = resolveTtsVoice(this.config.ttsVoice);
      const url = `wss://api.together.ai/v1/audio/speech/websocket?model=${encodeURIComponent(
        this.config.ttsModel
      )}&voice=${encodeURIComponent(
        voice
      )}&response_format=pcm&sample_rate=24000&speed=${speed}`;

      try {
        const localEpoch = this.connectionEpoch;
        const newWs = new WebSocket(url, {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        });
        this.ws = newWs;

        newWs.on("open", () => {
          if (localEpoch !== this.connectionEpoch) {
            try { newWs.close(); } catch {}
            return;
          }
          console.log("[TTS] Conexión física establecida. Esperando session.created de Together AI...");
        });

        newWs.on("message", (raw: WebSocket.RawData) => {
          if (localEpoch !== this.connectionEpoch) return;

          const str = raw.toString();
          try {
            const msg = JSON.parse(str);
            // Esperar estrictamente a que Together AI confirme session.created antes de marcar como listo
            if (msg.type === "session.created") {
              console.log("[TTS] Sesión WebSocket inicializada con éxito (session.created recibida).");
              this.isConnected = true;
              this.connectionError = null;
              resolve();
              return;
            }
          } catch {}

          if (!this.interrupted) {
            this.handleMessage(str);
          }
        });

        newWs.on("error", (err: any) => {
          if (localEpoch !== this.connectionEpoch) return;
          if (err.message?.includes("before the connection was established")) return;
          this.connectionError = `Error de WebSocket TTS: ${err.message}`;
          console.error(`[TTS] ${this.connectionError}`);
          this.isConnected = false;
          resolve();
        });

        newWs.on("close", () => {
          // Desactivar isConnected ÚNICAMENTE si este cierre corresponde a la época activa
          if (localEpoch === this.connectionEpoch) {
            this.isConnected = false;
          }
        });

        setTimeout(() => {
          if (!this.isConnected && localEpoch === this.connectionEpoch) {
            this.connectionError = "Timeout esperando session.created de Together Realtime TTS";
            console.warn(`[TTS] ${this.connectionError} (usando fallback REST optimizado)`);
            resolve();
          }
        }, 3500);
      } catch (e: any) {
        this.connectionError = e.message;
        console.error(`[TTS] Error iniciando TTS: ${e.message}`);
        resolve();
      }
    });
  }

  private handleMessage(dataStr: string): void {
    if (this.interrupted) return;

    try {
      const msg = JSON.parse(dataStr);

      // Procesar ÚNICAMENTE mensajes de audio genuinos
      if (msg.type === "conversation.item.audio_output.delta" && typeof msg.delta === "string") {
        if (this.onFirstAudioCallback) {
          this.onFirstAudioCallback(this.activeTurnId);
          this.onFirstAudioCallback = null;
        }

        const rawAudio = Buffer.from(msg.delta, "base64");
        // Descartar cabecera WAV (RIFF) si existiera para que nunca se reproduzca como muestras PCM
        const cleanAudio =
          rawAudio.length >= 44 && rawAudio.subarray(0, 4).toString("ascii") === "RIFF"
            ? rawAudio.subarray(44)
            : rawAudio;

        // Acumular byte impar residual para preservar estrictamente la alineación de palabras de 16-bit (Int16)
        // y evitar permutación de bytes altos y bajos que causaba ruido estático extremo.
        let combined = this.pcmTrailingBuffer.length > 0
          ? Buffer.concat([this.pcmTrailingBuffer, cleanAudio])
          : cleanAudio;

        if (combined.length % 2 !== 0) {
          this.pcmTrailingBuffer = combined.subarray(combined.length - 1);
          combined = combined.subarray(0, combined.length - 1);
        } else {
          this.pcmTrailingBuffer = Buffer.alloc(0);
        }

        if (combined.length > 0) {
          const pcmInt16 = bufferToInt16Array(combined);
          this.onAudioChunk(this.activeTurnId, pcmInt16);
        }
      }

      if (
        msg.type === "conversation.item.audio_output.done" ||
        msg.type === "response.audio.done" ||
        msg.type === "response.done"
      ) {
        this.pcmTrailingBuffer = Buffer.alloc(0);
        if (this.pendingSentencesCount > 0) {
          this.pendingSentencesCount--;
        }
        if (this.pendingSentencesCount === 0) {
          this.resolveAllDone();
        }
      }
    } catch {
      // Ignorar mensajes no JSON o malformados
    }
  }

  private resolveAllDone(): void {
    while (this.generationDoneResolvers.length > 0) {
      const r = this.generationDoneResolvers.shift();
      if (r) r();
    }
  }

  public async sendSentence(sentence: string, turnId?: number): Promise<void> {
    if (turnId !== undefined && turnId !== this.activeTurnId) {
      this.activeTurnId = turnId;
    }
    const targetTurnId = this.activeTurnId;
    const currentEpoch = this.connectionEpoch;
    this.interrupted = false;

    // Normalizar texto para pronunciación natural en español y filtrar símbolos/emojis
    const cleanSentence = cleanTextForTts(sentence, this.config.naturalPauses !== false);
    if (!cleanSentence) return;

    this.pendingSentencesCount++;

    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "input_text_buffer.append",
          text: cleanSentence,
        })
      );
      this.ws.send(
        JSON.stringify({
          type: "input_text_buffer.commit",
        })
      );
      return;
    }

    // Disparar petición HTTP inmediatamente en paralelo con la lectura del LLM,
    // pero encolar la emisión de audio en orden estricto de frase.
    const controller = new AbortController();
    this.activeAbortControllers.add(controller);

    const voice = resolveTtsVoice(this.config.ttsVoice);
    const fetchPromise = fetch("https://api.together.ai/v1/audio/speech", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.ttsModel,
        input: cleanSentence,
        voice,
        response_format: "pcm",
        sample_rate: 24000,
        speed: this.config.ttsSpeed || 1.0,
      }),
    });

    this.restPlaybackChain = this.restPlaybackChain.then(async () => {
      try {
        const res = await fetchPromise;
        if (!res.ok) {
          const errText = await res.text();
          console.error(`[TTS REST Error ${res.status}]: ${errText}`);
          return;
        }

        if (this.interrupted || currentEpoch !== this.connectionEpoch) {
          return;
        }

        if (res.body) {
          const reader = res.body.getReader();
          let isFirstChunk = true;

          while (true) {
            if (this.interrupted || currentEpoch !== this.connectionEpoch) {
              try { await reader.cancel(); } catch {}
              break;
            }

            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            if (this.onFirstAudioCallback) {
              this.onFirstAudioCallback(targetTurnId);
              this.onFirstAudioCallback = null;
            }

            let chunkBuf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            if (isFirstChunk) {
              isFirstChunk = false;
              if (chunkBuf.length >= 44 && chunkBuf.subarray(0, 4).toString("ascii") === "RIFF") {
                chunkBuf = chunkBuf.subarray(44);
              }
            }

            let combined =
              this.pcmTrailingBuffer.length > 0
                ? Buffer.concat([this.pcmTrailingBuffer, chunkBuf])
                : chunkBuf;

            if (combined.length % 2 !== 0) {
              this.pcmTrailingBuffer = combined.subarray(combined.length - 1);
              combined = combined.subarray(0, combined.length - 1);
            } else {
              this.pcmTrailingBuffer = Buffer.alloc(0);
            }

            if (combined.length > 0) {
              const pcmInt16 = bufferToInt16Array(combined);
              this.onAudioChunk(targetTurnId, pcmInt16);
            }
          }
        } else {
          const arrayBuf = await res.arrayBuffer();
          if (this.interrupted || currentEpoch !== this.connectionEpoch) {
            return;
          }
          if (this.onFirstAudioCallback) {
            this.onFirstAudioCallback(targetTurnId);
            this.onFirstAudioCallback = null;
          }
          const rawAudio = Buffer.from(arrayBuf);
          const cleanAudio =
            rawAudio.length >= 44 && rawAudio.subarray(0, 4).toString("ascii") === "RIFF"
              ? rawAudio.subarray(44)
              : rawAudio;

          let combined =
            this.pcmTrailingBuffer.length > 0
              ? Buffer.concat([this.pcmTrailingBuffer, cleanAudio])
              : cleanAudio;

          if (combined.length % 2 !== 0) {
            this.pcmTrailingBuffer = combined.subarray(combined.length - 1);
            combined = combined.subarray(0, combined.length - 1);
          } else {
            this.pcmTrailingBuffer = Buffer.alloc(0);
          }

          if (combined.length > 0) {
            const pcmInt16 = bufferToInt16Array(combined);
            this.onAudioChunk(targetTurnId, pcmInt16);
          }
        }
      } catch (e: any) {
        if (e.name === "AbortError") {
          return; // Cancelado limpiamente por interrupción
        }
        console.error(`[TTS REST] Error generando audio: ${e.message}`);
      } finally {
        this.activeAbortControllers.delete(controller);
        if (this.pendingSentencesCount > 0) {
          this.pendingSentencesCount--;
        }
        if (this.pendingSentencesCount === 0) {
          this.resolveAllDone();
        }
      }
    });
  }

  public async waitForAllAudioGenerated(timeoutMs: number = 8000): Promise<void> {
    if (this.pendingSentencesCount === 0 || this.interrupted) {
      return;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, timeoutMs);

      this.generationDoneResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Al interrumpir, se incrementa connectionEpoch, se abortan las peticiones REST en vuelo
   * y se desacoplan todos los listeners del WebSocket antiguo para evitar interferencias.
   */
  public interrupt(): void {
    this.interrupted = true;
    this.connectionEpoch++;
    this.pendingSentencesCount = 0;
    this.onFirstAudioCallback = null;
    this.restPlaybackChain = Promise.resolve();
    this.resolveAllDone();

    // Abortar todas las peticiones REST en vuelo
    for (const controller of this.activeAbortControllers) {
      try { controller.abort(); } catch {}
    }
    this.activeAbortControllers.clear();
    this.pcmTrailingBuffer = Buffer.alloc(0);

    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      this.isConnected = false;

      // Desacoplar listeners para que su evento 'close' o 'message' tardío jamás afecte a la nueva conexión
      oldWs.removeAllListeners();
      oldWs.on("error", () => {});
      try {
        if (oldWs.readyState === WebSocket.OPEN) {
          oldWs.close();
        } else {
          oldWs.terminate();
        }
      } catch {}
    }

    // Renovar conexión limpia para el siguiente turno
    this.warmup().catch(() => {});
  }

  public close(): void {
    this.isConnected = false;
    this.connectionEpoch++;
    this.pendingSentencesCount = 0;
    this.onFirstAudioCallback = null;
    this.restPlaybackChain = Promise.resolve();
    this.resolveAllDone();

    for (const controller of this.activeAbortControllers) {
      try { controller.abort(); } catch {}
    }
    this.activeAbortControllers.clear();

    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.removeAllListeners();
      oldWs.on("error", () => {});
      try {
        if (oldWs.readyState === WebSocket.OPEN) {
          oldWs.close();
        } else {
          oldWs.terminate();
        }
      } catch {}
    }
  }
}

export interface TurnExecutionParams {
  turnId: number;
  speechEndTime: number;
  vadConfirmedTime: number;
  abortController: AbortController;
  isAborted: () => boolean;
  onFirstAudioEmitted?: () => void;
  stateMachine?: CallStateMachine;
  sessionId?: string;
}

/**
 * Procesa un turno conversacional completo
 */
export async function processConversationTurn(
  stt: RealtimeSttSession,
  config: AgentConfig,
  tts: RealtimeTtsSession,
  params: TurnExecutionParams,
  conversationHistory: ChatMessage[] = []
): Promise<{ interrupted: boolean; assistantText: string; shouldHangUp?: boolean }> {
  const { turnId, speechEndTime, vadConfirmedTime, abortController, isAborted, onFirstAudioEmitted, stateMachine } = params;
  const sessionId = params.sessionId || stateMachine?.getContext().sessionId;

  tts.setTurnId(turnId);

  const userText = await stt.commitAndGetTranscription();
  if (!userText || userText.trim().length === 0) {
    console.log(`[Turno #${turnId}] Transcripción vacía o no capturada por STT. Emitiendo aclaración.`);
    let clarifyText = "Hola, ¿me escuchas bien? Quería confirmar si hablo con el responsable del negocio.";
    if (stateMachine) {
      const stage = stateMachine.getContext().currentStage;
      if (stage === 1) {
        clarifyText = "¿Hola? Disculpa, no te he escuchado bien. ¿Hablo con el responsable del negocio?";
      } else if (stage === 2) {
        clarifyText = "Disculpa, ¿me comentabas si te interesaría ver una muestra gratuita de la página web?";
      } else if (stage === 3) {
        clarifyText = "Perdona, no te he entendido bien. ¿Te gustaría que te preparemos la muestra gratuita?";
      } else if (stage === 4) {
        clarifyText = "¿Disculpa? ¿Nos autorizas a enviártela por WhatsApp a este número?";
      }
    }
    appEvents.broadcast({ type: "transcript", role: "assistant", text: clarifyText, turnId, sessionId });
    await tts.sendSentence(clarifyText, turnId);
    await tts.waitForAllAudioGenerated();
    return { interrupted: false, assistantText: clarifyText, shouldHangUp: false };
  }

  const sttDuration = Date.now() - vadConfirmedTime;
  console.log(`[Cliente (Turno #${turnId})]: "${userText}" (STT: ${sttDuration} ms)`);
  appEvents.broadcast({ type: "transcript", role: "user", text: userText, turnId, sessionId });
  appEvents.broadcast({ type: "metrics", stt: sttDuration, turnId, sessionId });

  let dynamicStagePrompt = "";
  if (stateMachine) {
    const analysis = stateMachine.processUserTurn(userText);
    dynamicStagePrompt = analysis.dynamicPrompt;
    console.log(`[Máquina de Estados Turno #${turnId}] Etapa: ${stateMachine.getContext().currentStage} | Pregunta: ${stateMachine.getContext().pendingQuestion} | Estado: ${stateMachine.getContext().outcomeStatus}`);
  } else if (isExplicitWhatsAppAuthorization(userText)) {
    console.log(`\n======================================================`);
    console.log(`  [ÉXITO COMERCIAL] AUTORIZACIÓN WHATSAPP: CONCEDIDA`);
    console.log(`======================================================\n`);
    appEvents.broadcast({ type: "whatsapp_authorized", turnId, sessionId });
  }

  conversationHistory.push({ role: "user", content: userText });

  const sentencesDispatched: string[] = [];
  let firstTokenMeasured = false;
  let firstSentenceMeasured = false;
  let firstAudioMeasured = false;

  tts.onFirstAudioCallback = () => {
    if (!firstAudioMeasured && !isAborted()) {
      firstAudioMeasured = true;
      const ttfaNode = Date.now() - vadConfirmedTime;
      const ttfaPerceived = Date.now() - speechEndTime;
      console.log(
        `[Métricas Turno #${turnId}] 🔊 TTFA_node: ${ttfaNode} ms [MEDIDO] (~${ttfaPerceived} ms [ESTIMADO desde fin de habla])`
      );
      appEvents.broadcast({ type: "metrics", ttfa: ttfaNode, turnId, sessionId });
      if (onFirstAudioEmitted) {
        onFirstAudioEmitted();
      }
    }
  };

  try {
    const fullSystemPrompt = [
      config.systemPrompt,
      dynamicStagePrompt,
    ].filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...conversationHistory.slice(-8),
    ];

    const requestBody: Record<string, any> = {
      model: config.llmModel,
      messages,
      stream: true,
      temperature: 0.2,
      max_tokens: config.maxTokens,
    };

    // En llamadas telefónicas conversacionales, desactivar siempre el razonamiento interno (CoT)
    // para evitar que el modelo agote los tokens de respuesta pensando en silencio en lugar de hablar.
    if (config.disableReasoning !== false) {
      requestBody.reasoning = { enabled: false };
    }

    const response = await fetch("https://api.together.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      const errDetail = await response.text();
      console.error(`[LLM Error ${response.status}]: ${errDetail}`);
      return { interrupted: false, assistantText: "" };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let sseLineBuffer = "";
    let textBuffer = "";
    let insideThinkingBlock = false;
    const punctuationRegex = /([.?!;\n]+)/;
    let sentencesSentCount = 0;
    const MAX_SENTENCES_PER_TURN = 2;

    while (true) {
      if (isAborted()) {
        console.log(`[LLM Turno #${turnId}] Generación abortada por Barge-in.`);
        abortController.abort();
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunkStr = decoder.decode(value, { stream: true });
      sseLineBuffer += chunkStr;

      const lines = sseLineBuffer.split("\n");
      sseLineBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        if (trimmed === "data: [DONE]") break;

        const jsonStr = trimmed.substring(5).trim();
        if (!jsonStr) continue;

        try {
          const json = JSON.parse(jsonStr);
          let delta = json.choices?.[0]?.delta?.content || "";
          if (!delta) continue;

          if (delta.includes("<think>")) {
            insideThinkingBlock = true;
            delta = delta.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
          } else if (insideThinkingBlock) {
            if (delta.includes("</think>")) {
              insideThinkingBlock = false;
              delta = delta.replace(/[\s\S]*?<\/think>/g, "");
            } else {
              continue;
            }
          }

          if (!delta) continue;

          if (!firstTokenMeasured) {
            firstTokenMeasured = true;
            const ttftNode = Date.now() - vadConfirmedTime;
            const ttftPerceived = Date.now() - speechEndTime;
            console.log(
              `[Métricas Turno #${turnId}] ⚡ TTFT (Primer token LLM): ${ttftNode} ms [MEDIDO] (~${ttftPerceived} ms [ESTIMADO desde fin de habla])`
            );
            appEvents.broadcast({ type: "metrics", ttft: ttftNode, turnId, sessionId });
          }

          textBuffer += delta;

          let match: RegExpExecArray | null;
          while ((match = punctuationRegex.exec(textBuffer)) !== null) {
            const splitIdx = match.index + match[0].length;
            const sentence = textBuffer.substring(0, splitIdx).trim();
            textBuffer = textBuffer.substring(splitIdx);

            if (sentence.length >= 4 && !isAborted()) {
              if (!firstSentenceMeasured) {
                firstSentenceMeasured = true;
                const ttfsNode = Date.now() - vadConfirmedTime;
                console.log(`[Métricas Turno #${turnId}] 📝 TTFS (Primera frase sintáctica para TTS): ${ttfsNode} ms [MEDIDO]`);
                appEvents.broadcast({ type: "metrics", ttfs: ttfsNode, turnId, sessionId });
              }

              console.log(`[Agente (Turno #${turnId}, Frase #${sentencesSentCount + 1})]: "${sentence}"`);
              appEvents.broadcast({ type: "transcript", role: "assistant", text: sentence, turnId, sessionId });
              sentencesDispatched.push(sentence);
              sentencesSentCount++;
              await tts.sendSentence(sentence, turnId);

              if (sentencesSentCount >= MAX_SENTENCES_PER_TURN) {
                textBuffer = "";
                abortController.abort();
                break;
              }
            }
          }
        } catch {
          // Fragmento incompleto
        }
      }

      if (sentencesSentCount >= MAX_SENTENCES_PER_TURN) {
        break;
      }
    }

    const remaining = textBuffer.trim();
    if (remaining.length >= 3 && !isAborted() && sentencesSentCount < MAX_SENTENCES_PER_TURN) {
      if (!firstSentenceMeasured) {
        firstSentenceMeasured = true;
        const ttfsNode = Date.now() - vadConfirmedTime;
        console.log(`[Métricas Turno #${turnId}] 📝 TTFS (Primera frase sintáctica para TTS): ${ttfsNode} ms [MEDIDO]`);
        appEvents.broadcast({ type: "metrics", ttfs: ttfsNode, turnId, sessionId });
      }
      console.log(`[Agente (Turno #${turnId}, Frase final)]: "${remaining}"`);
      appEvents.broadcast({ type: "transcript", role: "assistant", text: remaining, turnId, sessionId });
      sentencesDispatched.push(remaining);
      await tts.sendSentence(remaining, turnId);
    }

    if (sentencesDispatched.length === 0 && !isAborted()) {
      // Contingencia determinista si el LLM devuelve texto vacío o se queda en blanco
      let fallbackText = "";
      if (stateMachine) {
        const ctx = stateMachine.getContext();
        if (ctx.currentStage === 1) {
          fallbackText = ctx.businessConfirmed
            ? "Te llamo rápido porque queremos prepararte una muestra gratuita de la web de tu negocio, ¿te gustaría que te la enviemos por WhatsApp sin compromiso?"
            : "Hola, ¿me escuchas bien? Quería confirmar si hablo con el responsable del negocio.";
        } else if (ctx.currentStage === 2) {
          fallbackText = "Te preparamos un boceto previo gratuito de la web para tu negocio, ¿te gustaría verlo sin ningún compromiso?";
        } else if (ctx.currentStage === 3) {
          fallbackText = "La muestra es 100% gratuita y sin compromiso. ¿Te parecería bien que te la enviemos por WhatsApp para que la valores?";
        } else if (ctx.currentStage === 4) {
          fallbackText = "¿Te enviamos la muestra a este mismo número al que te llamamos o prefieres facilitarme otro móvil?";
        } else {
          fallbackText = "Muchas gracias por tu tiempo, que tengas un excelente día.";
        }
      } else {
        fallbackText = "¿Hola? ¿Me escuchas bien?";
      }

      console.warn(`[Agente (Turno #${turnId}, Contingencia Automática)]: "${fallbackText}"`);
      appEvents.broadcast({ type: "transcript", role: "assistant", text: fallbackText, turnId, sessionId });
      sentencesDispatched.push(fallbackText);
      await tts.sendSentence(fallbackText, turnId);
    }

    if (!isAborted()) {
      await tts.waitForAllAudioGenerated();
    }

    if (isAborted()) {
      const actuallyHeard = sentencesDispatched.length > 0 ? sentencesDispatched[0] : "";
      if (actuallyHeard) {
        conversationHistory.push({
          role: "assistant",
          content: `${actuallyHeard} [interrumpido en curso por el cliente]`,
        });
      }
      return { interrupted: true, assistantText: actuallyHeard, shouldHangUp: stateMachine?.getContext().shouldHangUp };
    } else {
      const full = sentencesDispatched.join(" ").trim();
      if (full && stateMachine) {
        stateMachine.syncWithAssistantTurn(userText, full, conversationHistory);
      }
      if (full) {
        conversationHistory.push({
          role: "assistant",
          content: full,
        });
      }
      return { interrupted: false, assistantText: full, shouldHangUp: stateMachine?.getContext().shouldHangUp };
    }
  } catch (error: any) {
    if (error.name !== "AbortError") {
      console.error(`[LLM Error Turno #${turnId}]: ${error.message}`);
    }
    const actuallyHeard = sentencesDispatched.length > 0 ? sentencesDispatched[0] : "";
    if (actuallyHeard) {
      conversationHistory.push({
        role: "assistant",
        content: `${actuallyHeard} [interrumpido en curso por el cliente]`,
      });
    }
    return { interrupted: true, assistantText: actuallyHeard, shouldHangUp: stateMachine?.getContext().shouldHangUp };
  }
}
