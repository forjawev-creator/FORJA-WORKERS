import { EventEmitter } from "events";

export interface UiEvent {
  type:
    | "state"
    | "transcript"
    | "metrics"
    | "whatsapp_authorized"
    | "turn_start"
    | "turn_end"
    | "flush"
    | "call_summary"
    | "stage_update"
    | "call_end"
    | "lead_call_start"
    | "role_changed"
    | "handoff_state"
    | "usage_update"
    | "provider_error"
    | "propuesta_abierta"
    | "call_analyzed"
    | "whatsapp_message_received"
    | "whatsapp_ai_reply";
  sessionId?: string;
  [key: string]: any;
}

class AppEvents extends EventEmitter {
  public broadcast(event: UiEvent): void {
    this.emit("ui-event", event);
  }
}

export const appEvents = new AppEvents();
