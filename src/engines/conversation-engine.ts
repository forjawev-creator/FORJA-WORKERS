import net from "net";
import {
  ConversationEngineType,
  AssistantRole,
  CallState,
  HandoffState,
  CallSessionContext,
  CallCostSummary,
  CallOutcomeStatus,
} from "../types.js";

export interface EngineEvents {
  onAudio: (pcmResampled: Int16Array, turnId: number) => void;
  /** Audio crudo ya codificado (G.711 A-law 8 kHz) para el enlace telefónico, sin conversión. */
  onAudioRaw?: (audio: Buffer, turnId: number) => void;
  onState: (state: CallState) => void;
  onRoleChanged: (role: AssistantRole) => void;
  onHandoffState: (state: HandoffState, detail?: string) => void;
  onTranscript: (role: "user" | "assistant", text: string, turnId?: number, isPartial?: boolean) => void;
  onTurnStart: (turnId: number) => void;
  onTurnEnd: (turnId: number) => void;
  onFlush: (turnId: number) => void;
  onPlaybackDrained?: (turnId: number) => void;
  onUsageUpdate: (costSummary: CallCostSummary) => void;
  onError: (err: Error) => void;
  onHangupRequested: (reason: string, outcome: CallOutcomeStatus) => void;
}

export interface CallSessionSummary {
  outcomeStatus: CallOutcomeStatus;
  whatsappAuthorized: boolean;
  phoneConfirmed?: boolean;
  evidenceQuote?: string;
  confirmedPhone?: string;
  scriptVariant?: "cercano" | "formal";
  transcripts?: Array<{ role: "user" | "assistant"; text: string }>;
  userTranscripts?: string[];
}

export interface IConversationEngine {
  readonly engineType: ConversationEngineType;
  readonly activeRole: AssistantRole;
  readonly handoffState: HandoffState;

  start(callId: string, socket: net.Socket, context?: CallSessionContext): Promise<void>;
  pushInputAudio(pcm: Int16Array, raw: Buffer): void;
  requestInitialGreeting(): Promise<void>;
  interrupt(playbackPositionMs?: number): void;
  handlePlaybackDrained(turnId: number): void;
  handlePlaybackStarted(turnId: number): void;
  stop(reason: string): Promise<void>;
  getCallSessionSummary?(): CallSessionSummary;
}
