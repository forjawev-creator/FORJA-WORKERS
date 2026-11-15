import { CallOutcomeStatus, ScriptVariant } from "../types.js";

export type OutboxEventType =
  | "phone_confirmed"
  | "whatsapp_authorized"
  | "contact_opted_out"
  | "human_transfer_requested"
  | "call_completed";

export interface OutboxEvent<T = any> {
  eventId: string;
  callId: string;
  type: OutboxEventType;
  createdAt: string;
  idempotencyKey?: string;
  payload: T;
}

export interface PhoneConfirmedPayload {
  phone: string;
  evidenceQuote?: string;
}

export interface WhatsAppAuthorizedPayload {
  phone: string;
  confirmedPhone: string;
  company?: string;
  evidenceQuote?: string;
}

export interface ContactOptedOutPayload {
  phone: string;
  reason?: string;
  evidenceQuote?: string;
}

export interface HumanTransferPayload {
  phone?: string;
  reason: string;
  customerNotes?: string;
  targetPhone?: string;
}

export interface CompletedCallOutboxPayload {
  sessionId: string;
  channel?: "telephony" | "web" | "browser";
  company?: string;
  phone?: string;
  durationSeconds: number;
  status: CallOutcomeStatus;
  currentStage?: number;
  whatsappAuthorized?: boolean;
  phoneConfirmed?: boolean;
  confirmedPhone?: string;
  evidenceQuote?: string;
  scriptVariant?: "cercano" | "formal";
  transcriptPath?: string;
  metrics?: Record<string, any>;
}
