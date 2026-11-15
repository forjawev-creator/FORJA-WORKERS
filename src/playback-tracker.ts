export interface AudioItemTracking {
  itemId: string;
  contentIndex: number;
  sampleRate: number;
  receivedSamples: number;
  queuedSamples: number;
  playedSamples: number;
  epoch: number;
  isTruncated: boolean;
  truncatedAudioEndMs?: number;
  startedPlaybackAt?: number;
}

export class PlaybackTracker {
  private items: Map<string, AudioItemTracking> = new Map();
  private activeItemId: string | null = null;
  private currentEpoch: number = 1;

  constructor(private readonly bridgeSampleRate: number = 16000) {}

  public setEpoch(epoch: number): void {
    this.currentEpoch = epoch;
  }

  public getEpoch(): number {
    return this.currentEpoch;
  }

  public newEpoch(): number {
    this.currentEpoch++;
    return this.currentEpoch;
  }

  public registerAudioItem(itemId: string, contentIndex: number = 0, sourceSampleRate: number = 24000): void {
    this.activeItemId = itemId;
    if (!this.items.has(itemId)) {
      this.items.set(itemId, {
        itemId,
        contentIndex,
        sampleRate: sourceSampleRate,
        receivedSamples: 0,
        queuedSamples: 0,
        playedSamples: 0,
        epoch: this.currentEpoch,
        isTruncated: false,
      });
    }
  }

  public recordSamplesReceived(itemId: string, sampleCountAtSourceRate: number): void {
    const item = this.items.get(itemId);
    if (item && item.epoch === this.currentEpoch) {
      item.receivedSamples += sampleCountAtSourceRate;
    }
  }

  public recordSamplesSent(itemId: string, sampleCountAtSourceRate: number): void {
    const item = this.items.get(itemId);
    if (item && item.epoch === this.currentEpoch) {
      item.receivedSamples += sampleCountAtSourceRate;
      item.queuedSamples += sampleCountAtSourceRate;
    }
  }

  public recordSamplesPlayed(itemId: string, sampleCountAtSourceRate: number): void {
    const item = this.items.get(itemId);
    if (item && item.epoch === this.currentEpoch) {
      item.playedSamples += sampleCountAtSourceRate;
    }
  }

  public markPlaybackStarted(itemId?: string): void {
    const targetId = itemId || this.activeItemId;
    if (targetId) {
      const item = this.items.get(targetId);
      if (item && !item.startedPlaybackAt) {
        item.startedPlaybackAt = Date.now();
      }
    }
  }

  public getActiveItem(): AudioItemTracking | null {
    if (!this.activeItemId) return null;
    return this.items.get(this.activeItemId) || null;
  }

  /**
   * Calcula con precisión de muestra la posición en milisegundos en la que se interrumpió la reproducción
   * para emitir `conversation.item.truncate`.
   * Trunca según lo escuchado realmente por el cliente físico.
   */
  public truncateActiveItem(playbackOffsetMs: number = 0): { itemId: string; contentIndex: number; audioEndMs: number } | null {
    const active = this.getActiveItem();
    if (!active || active.isTruncated || active.epoch !== this.currentEpoch) {
      return null;
    }

    let heardSamples = 0;
    if (active.playedSamples > 0) {
      heardSamples = active.playedSamples;
    } else if (active.startedPlaybackAt) {
      // Estimar con precisión el audio reproducido desde que comenzó a sonar físicamente
      const elapsedSec = (Date.now() - active.startedPlaybackAt) / 1000;
      heardSamples = Math.min(active.queuedSamples, Math.max(0, Math.round(elapsedSec * active.sampleRate)));
    } else {
      // Si todavía no ha comenzado la reproducción física en el dispositivo, NO se contabiliza nada como escuchado (0 ms)
      heardSamples = 0;
    }

    let audioEndMs = Math.round((heardSamples / active.sampleRate) * 1000) - playbackOffsetMs;
    if (audioEndMs < 0) audioEndMs = 0;

    active.isTruncated = true;
    active.truncatedAudioEndMs = audioEndMs;

    return {
      itemId: active.itemId,
      contentIndex: active.contentIndex,
      audioEndMs,
    };
  }

  public reset(): void {
    this.items.clear();
    this.activeItemId = null;
    this.currentEpoch++;
  }
}
