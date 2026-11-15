import net from "net";
import {
  IConversationEngine,
  EngineEvents,
} from "./conversation-engine.js";
import {
  ConversationEngineType,
  AssistantRole,
  HandoffState,
  CallState,
  AgentConfig,
  CallSessionContext,
  ChatMessage,
} from "../types.js";
import { SileroVad } from "../vad.js";
import {
  RealtimeSttSession,
  RealtimeTtsSession,
  processConversationTurn,
  CallStateMachine,
} from "../pipeline.js";
import {
  StreamingResampler,
  int16ArrayToBuffer,
} from "../audio-bridge.js";

interface ActiveTurn {
  turnId: number;
  speechEndTime: number;
  vadConfirmedTime: number;
  abortController: AbortController;
  isAborted: boolean;
}

export class TogetherEngine implements IConversationEngine {
  public readonly engineType: ConversationEngineType = "together_pipeline";
  public readonly activeRole: AssistantRole = "commercial";
  public readonly handoffState: HandoffState = "idle";

  private callId: string = "";
  private socket: net.Socket | null = null;
  private isCallActive = false;
  private state: CallState = "listening";
  private turnCounter = 0;
  private activeTurn: ActiveTurn | null = null;
  private conversationHistory: ChatMessage[] = [];

  private vad: SileroVad | null = null;
  private stt: RealtimeSttSession | null = null;
  private tts: RealtimeTtsSession | null = null;
  private ttsResampler: StreamingResampler | null = null;
  private stateMachine: CallStateMachine | null = null;
  private playbackDrainedResolver: ((turnId: number) => void) | null = null;
  private lastDrainedTurnId: number | null = null;
  private callDurationTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly events: EngineEvents
  ) {}

  public async start(callId: string, socket: net.Socket, context?: CallSessionContext): Promise<void> {
    this.callId = callId;
    this.socket = socket;
    this.isCallActive = true;
    this.state = "speaking";
    this.events.onState("speaking");
    this.conversationHistory = [];

    const maxCallSeconds = this.config.callMaxDurationSeconds || 180;
    this.callDurationTimer = setTimeout(() => {
      console.warn(`[TogetherEngine] Límite máximo de duración de llamada alcanzado (${maxCallSeconds}s). Finalizando.`);
      this.events.onHangupRequested("call_max_duration_exceeded", "TERMINADO");
    }, maxCallSeconds * 1000);

    this.stateMachine = new CallStateMachine(this.config, callId);
    this.vad = await SileroVad.create();
    this.stt = new RealtimeSttSession(this.config);

    this.ttsResampler = new StreamingResampler(24000, this.config.sampleRate || 16000);
    this.tts = new RealtimeTtsSession(this.config, (chunkTurnId, pcmChunk24k) => {
      if (!this.isCallActive || !this.activeTurn || this.activeTurn.turnId !== chunkTurnId || this.activeTurn.isAborted) {
        return;
      }

      if (this.state !== "speaking") {
        this.state = "speaking";
        this.events.onState("speaking");
      }

      if (!this.ttsResampler) return;
      const pcmResampled = this.ttsResampler.process(pcmChunk24k);
      if (pcmResampled.length === 0) return;

      this.events.onAudio(pcmResampled, chunkTurnId);
    });

    await Promise.all([this.stt.warmup(), this.tts.warmup()]);
  }

  public async requestInitialGreeting(): Promise<void> {
    if (!this.isCallActive || !this.tts) return;

    this.turnCounter = (this.turnCounter + 1) & 0xff;
    const turnId = this.turnCounter;
    const now = Date.now();

    const currentTurn: ActiveTurn = {
      turnId,
      speechEndTime: now,
      vadConfirmedTime: now,
      abortController: new AbortController(),
      isAborted: false,
    };
    this.activeTurn = currentTurn;
    this.state = "speaking";
    this.events.onTurnStart(turnId);
    this.events.onState("speaking");

    const greetingText =
      this.config.stages?.stage1?.guidePhrase ||
      "Hola, buenas. ¿Hablo con el responsable del negocio?";

    console.log(`[TogetherEngine - Comercial]: "${greetingText}"`);
    this.conversationHistory.push({ role: "assistant", content: greetingText });
    this.events.onTranscript("assistant", greetingText, turnId, false);

    await this.tts.sendSentence(greetingText, turnId);
    await this.tts.waitForAllAudioGenerated();

    if (!currentTurn.isAborted && this.isCallActive) {
      this.events.onTurnEnd(turnId);
      await this.waitForPlaybackDrained(turnId);
    }

    if (!currentTurn.isAborted && this.isCallActive && this.activeTurn?.turnId === turnId) {
      this.state = "listening";
      this.events.onState("listening");
      this.vad?.resetState();
      this.stt?.clearAudio();
      this.activeTurn = null;
      console.log("[TogetherEngine]: Saludo finalizado. Escuchando respuesta del cliente...");
    }
  }

  public pushInputAudio(pcm: Int16Array, raw: Buffer): void {
    if (!this.isCallActive || !this.vad || !this.stt) return;

    if (this.state === "speaking") {
      this.vad.checkBargeIn(pcm).then((bargeInResult) => {
        if (bargeInResult.triggered && this.activeTurn) {
          if (this.activeTurn.turnId === 1 && Date.now() - this.activeTurn.speechEndTime < 1200) {
            return;
          }

          console.log(`[TogetherEngine Barge-in] Interrupción detectada en Turno #${this.activeTurn.turnId}.`);
          const interruptedTurnId = this.activeTurn.turnId;
          this.activeTurn.isAborted = true;
          this.activeTurn.abortController.abort();

          this.events.onFlush(interruptedTurnId);
          this.events.onState("listening");

          this.tts?.interrupt();
          this.ttsResampler?.reset();
          this.state = "listening";
          this.vad?.resetState();
          this.stt?.clearAudio();

          for (const frame of bargeInResult.frames) {
            this.stt?.sendAudio(int16ArrayToBuffer(frame));
          }

          this.activeTurn = null;
        }
      }).catch((err) => console.error("[TogetherEngine VAD error]:", err));
      return;
    }

    if (this.state === "listening") {
      this.stt.sendAudio(raw);
      this.vad.evaluateTurnBoundary(pcm).then((isEndOfSpeech) => {
        if (isEndOfSpeech && this.state === "listening") {
          const vadConfirmedTime = Date.now();
          const speechEndTime = vadConfirmedTime - 500;

          this.state = "processing";
          this.events.onState("processing");
          this.turnCounter = (this.turnCounter + 1) & 0xff;
          const turnId = this.turnCounter;

          const newTurn: ActiveTurn = {
            turnId,
            speechEndTime,
            vadConfirmedTime,
            abortController: new AbortController(),
            isAborted: false,
          };
          this.activeTurn = newTurn;
          this.runTurn(newTurn);
        }
      }).catch((err) => console.error("[TogetherEngine Turn error]:", err));
    }
  }

  private async runTurn(turn: ActiveTurn): Promise<void> {
    if (!this.stt || !this.tts || !this.stateMachine) return;

    try {
      this.activeTurn = turn;
      this.events.onTurnStart(turn.turnId);
      this.events.onState("processing");

      const turnResult = await processConversationTurn(
        this.stt,
        this.config,
        this.tts,
        {
          turnId: turn.turnId,
          speechEndTime: turn.speechEndTime,
          vadConfirmedTime: turn.vadConfirmedTime,
          abortController: turn.abortController,
          isAborted: () => turn.isAborted || !this.isCallActive,
          onFirstAudioEmitted: () => {
            this.state = "speaking";
            this.events.onState("speaking");
          },
          stateMachine: this.stateMachine,
          sessionId: this.callId,
        },
        this.conversationHistory
      );

      if (!turn.isAborted && this.isCallActive && this.activeTurn?.turnId === turn.turnId) {
        this.state = "speaking";
        this.events.onTurnEnd(turn.turnId);
        await this.waitForPlaybackDrained(turn.turnId);
      }

      if (!turn.isAborted && this.isCallActive && this.activeTurn?.turnId === turn.turnId) {
        if (turnResult?.shouldHangUp) {
          const outcome = this.stateMachine.getContext().outcomeStatus;
          console.log(`[TogetherEngine]: Fin de llamada determinado por la máquina de estados (${outcome}).`);
          this.isCallActive = false;
          this.state = "listening";
          this.events.onHangupRequested("state_machine_completed", outcome);
          this.vad?.resetState();
          this.activeTurn = null;
        } else {
          this.state = "listening";
          this.events.onState("listening");
          this.vad?.resetState();
          this.stt?.clearAudio();
          this.activeTurn = null;
        }
      }
    } catch (err: any) {
      console.error(`[TogetherEngine Turn #${turn.turnId} Error]:`, err);
      this.events.onError(err);
      if (this.isCallActive && this.activeTurn?.turnId === turn.turnId) {
        this.state = "listening";
        this.events.onState("listening");
        this.vad?.resetState();
        this.stt?.clearAudio();
        this.activeTurn = null;
      }
    }
  }

  public interrupt(): void {
    if (this.activeTurn) {
      this.activeTurn.isAborted = true;
      this.activeTurn.abortController.abort();
      this.events.onFlush(this.activeTurn.turnId);
      this.activeTurn = null;
    }
    this.tts?.interrupt();
    this.ttsResampler?.reset();
    this.state = "listening";
    this.vad?.resetState();
    this.stt?.clearAudio();
  }

  public handlePlaybackDrained(turnId: number): void {
    this.lastDrainedTurnId = turnId;
    if (this.playbackDrainedResolver) {
      this.playbackDrainedResolver(turnId);
    }
  }

  public handlePlaybackStarted(turnId: number): void {
    // Registrado para telemetría
  }

  private waitForPlaybackDrained(turnId: number, timeoutMs = 30000): Promise<void> {
    if (this.lastDrainedTurnId === turnId) {
      this.lastDrainedTurnId = null;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.playbackDrainedResolver = null;
        resolve();
      }, timeoutMs);

      this.playbackDrainedResolver = (completedTurnId: number) => {
        if (completedTurnId === turnId) {
          clearTimeout(timer);
          this.playbackDrainedResolver = null;
          resolve();
        }
      };
    });
  }

  public getCallSessionSummary() {
    const ctx = this.stateMachine?.getContext();
    return {
      outcomeStatus: ctx?.outcomeStatus || "EN_CURSO",
      whatsappAuthorized: Boolean(ctx?.whatsappAuthorized),
      evidenceQuote: ctx?.evidenceQuote || undefined,
      confirmedPhone: ctx?.confirmedPhone || undefined,
      transcripts: this.conversationHistory.filter((h) => h.role === "user" || h.role === "assistant") as any,
      userTranscripts: this.conversationHistory.filter((h) => h.role === "user").map((h) => h.content),
    };
  }

  public async stop(reason: string): Promise<void> {
    console.log(`[TogetherEngine] Deteniendo sesión (${reason})...`);
    this.isCallActive = false;
    if (this.callDurationTimer) {
      clearTimeout(this.callDurationTimer);
      this.callDurationTimer = null;
    }
    this.interrupt();
    this.stt?.close();
    this.tts?.close();
    this.stt = null;
    this.tts = null;
    this.vad = null;
    this.stateMachine = null;
  }
}
