import { CallSessionContext, CallOutcomeStatus, PendingQuestion, AssistantRole, AgentConfig } from "./types.js";
import {
  getCatalogPrices,
  renderInboundPrompt,
  renderCommercialPrompt,
  renderTechnicalPrompt,
} from "./prompts-loader.js";

export interface ConfirmedBusiness {
  name: string | null;
  trade: string | null;
  confirmed: boolean;
}

export interface ConfirmedCatalog {
  installPrice: string;
  monthlyPriceBasic: string;
  monthlyPriceFull: string;
  freeDemo: boolean;
  features: Record<string, string>;
}

export interface SharedContextState {
  schema_version: 1;
  call_id: string;
  role: AssistantRole;
  business: ConfirmedBusiness;
  stage: number;
  interest: string | null;
  exact_question: string | null;
  confirmed_facts: string[];
  uncertain_facts: string[];
  doubts_resolved: string[];
  offers_mentioned: string[];
  whatsapp_authorized: boolean;
  phone_confirmed: boolean;
  confirmed_phone: string | null;
  evidence_quote?: string | null;
  call_direction: "outbound" | "inbound";
  pending_question: PendingQuestion;
  outcome: CallOutcomeStatus;
  last_heard_assistant_text: string | null;
  catalog: ConfirmedCatalog;
}

/**
 * Devuelve el saludo horario adecuado según la hora oficial en España (Europe/Madrid):
 * - De 06:00 a 13:59: "Buenos días"
 * - De 14:00 a 20:59: "Buenas tardes"
 * - De 21:00 a 05:59: "Buenas noches"
 */
export function getSpainTimeGreeting(): "Buenos días" | "Buenas tardes" | "Buenas noches" {
  try {
    const formatter = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      hour: "numeric",
      hourCycle: "h23",
    });
    const hour = parseInt(formatter.format(new Date()), 10);
    if (hour >= 6 && hour < 14) {
      return "Buenos días";
    } else if (hour >= 14 && hour < 21) {
      return "Buenas tardes";
    } else {
      return "Buenas noches";
    }
  } catch {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 14) {
      return "Buenos días";
    } else if (hour >= 14 && hour < 21) {
      return "Buenas tardes";
    } else {
      return "Buenas noches";
    }
  }
}

export class ContextStore {
  private state: SharedContextState;

  constructor(callId: string, config: AgentConfig, initialSessionContext?: CallSessionContext) {
    const defaultPrices = getCatalogPrices();
    const install = config.installPrice || defaultPrices.installPrice || "99";
    const basic = config.monthlyPriceBasic || defaultPrices.monthlyPriceBasic || "10";
    const full = config.monthlyPriceFull || defaultPrices.monthlyPriceFull || "15";

    this.state = {
      schema_version: 1,
      call_id: callId,
      call_direction: initialSessionContext?.callDirection || "outbound",
      role: "commercial",
      business: {
        name: initialSessionContext?.companyName || null,
        trade: initialSessionContext?.trade || null,
        confirmed: initialSessionContext ? initialSessionContext.businessConfirmed : false,
      },
      stage: initialSessionContext ? initialSessionContext.currentStage : 1,
      interest: null,
      exact_question: null,
      confirmed_facts: [],
      uncertain_facts: [],
      doubts_resolved: initialSessionContext ? [...initialSessionContext.doubtsResolved] : [],
      offers_mentioned: ["demo interactiva gratuita de web con datos de Google Maps sin compromiso"],
      whatsapp_authorized: initialSessionContext ? initialSessionContext.whatsappAuthorized : false,
      phone_confirmed: initialSessionContext ? initialSessionContext.phoneConfirmed : false,
      confirmed_phone: initialSessionContext ? initialSessionContext.confirmedPhone || null : null,
      pending_question: initialSessionContext ? initialSessionContext.pendingQuestion : "CONFIRM_BUSINESS",
      outcome: initialSessionContext ? initialSessionContext.outcomeStatus : "EN_CURSO",
      last_heard_assistant_text: null,
      catalog: {
        installPrice: install,
        monthlyPriceBasic: basic,
        monthlyPriceFull: full,
        freeDemo: true,
        features: {
          dominio_alojamiento: "Incluido en la cuota de mantenimiento de 10 € al mes",
          adaptacion_movil: "100% optimizada para teléfonos móviles y captación local",
          muestra_previa: "Demo interactiva con la información de Google Maps en 1-2 días, 100% gratuita y sin compromiso",
          cambios_soporte: "Soporte técnico y mantenimiento incluido",
        },
      },
    };
  }

  public getState(): Readonly<SharedContextState> {
    return { ...this.state };
  }

  public setRole(role: AssistantRole): void {
    this.state.role = role;
  }

  public setBusinessConfirmed(name?: string, trade?: string): void {
    this.state.business.confirmed = true;
    if (name) this.state.business.name = name;
    if (trade) this.state.business.trade = trade;
  }

  public setExactQuestion(question: string): void {
    this.state.exact_question = question.trim();
  }

  public addConfirmedFact(fact: string): void {
    const trimmed = fact.trim();
    if (trimmed && !this.state.confirmed_facts.includes(trimmed)) {
      this.state.confirmed_facts.push(trimmed);
    }
  }

  public addResolvedDoubt(doubt: string): void {
    const trimmed = doubt.trim();
    if (trimmed && !this.state.doubts_resolved.includes(trimmed)) {
      this.state.doubts_resolved.push(trimmed);
    }
  }

  public setWhatsAppAuthorized(authorized: boolean, phone?: string, evidenceQuote?: string): void {
    this.state.whatsapp_authorized = authorized;
    if (evidenceQuote) {
      this.state.evidence_quote = evidenceQuote;
    }
    if (phone) {
      this.state.phone_confirmed = true;
      this.state.confirmed_phone = phone;
    }
    if (authorized) {
      this.state.outcome = "AUTORIZADO";
      this.addConfirmedFact(`Cliente autorizó el envío de la muestra por WhatsApp (evidencia: "${evidenceQuote || "confirmado"}").`);
    }
  }

  public setOutcome(outcome: CallOutcomeStatus): void {
    this.state.outcome = outcome;
  }

  public setStage(stage: number): void {
    this.state.stage = stage;
  }

  public setLastHeardAssistantText(text: string): void {
    this.state.last_heard_assistant_text = text;
  }

  /**
   * Genera las instrucciones de sistema para el Asistente Comercial
   */
  public buildCommercialInstructions(voice?: string, variant: "cercano" | "formal" = "cercano"): string {
    const cat = this.state.catalog;
    const v = (voice || "marin").toLowerCase();
    const isFemale = ["marin", "coral", "shimmer", "sage", "ballad"].includes(v);
    const agentName = isFemale ? "Laura" : "Juan";
    const rawBizName = (this.state.business.name || "").trim();
    const hasSpecificBizName =
      rawBizName.length > 1 &&
      !/^(cliente\s*web|negocio\s*local|desconocido|test|prueba)$/i.test(rawBizName);

    const bizRef = variant === "formal"
      ? (hasSpecificBizName ? `de ${rawBizName}` : "de su negocio")
      : (hasSpecificBizName ? `de ${rawBizName}` : "de vuestro negocio");

    return renderCommercialPrompt({
      variant,
      agentName,
      bizRef,
      installPrice: cat.installPrice,
      monthlyPrice: cat.monthlyPriceBasic,
    });
  }

  /**
   * Genera las instrucciones de sistema para llamadas ENTRANTES (devolución de llamada perdida / consulta)
   */
  public buildInboundInstructions(voice?: string, variant: "cercano" | "formal" = "cercano"): string {
    const v = (voice || "cedar").toLowerCase();
    const isFemale = ["marin", "coral", "shimmer", "sage", "ballad"].includes(v);
    const agentName = isFemale ? "Laura" : "Juan";
    const timeGreeting = getSpainTimeGreeting();
    const wishClosing =
      timeGreeting === "Buenos días"
        ? "que tengas muy buen día"
        : timeGreeting === "Buenas tardes"
        ? "que pases muy buena tarde"
        : "que pases muy buena noche";

    return renderInboundPrompt({
      agentName,
      timeGreeting,
      wishClosing,
    });
  }

  /**
   * Genera las instrucciones de sistema para el Asistente Técnico (gpt-realtime-2.1)
   */
  public buildTechnicalInstructions(voice?: string): string {
    const cat = this.state.catalog;
    const q = this.state.exact_question || "duda sobre la web";
    const facts = this.state.confirmed_facts.length > 0 ? this.state.confirmed_facts.join("; ") : "Ninguno registrado";
    const v = (voice || "cedar").toLowerCase();
    const isFemale = ["marin", "coral", "shimmer", "sage", "ballad"].includes(v);
    const agentName = isFemale ? "Elena" : "Marcos";

    return renderTechnicalPrompt({
      agentName,
      bizName: this.state.business.name || "Negocio local",
      trade: this.state.business.trade || "Profesional local",
      exactQuestion: q,
      facts,
      installPrice: cat.installPrice,
      monthlyPrice: cat.monthlyPriceBasic,
    });
  }
}

