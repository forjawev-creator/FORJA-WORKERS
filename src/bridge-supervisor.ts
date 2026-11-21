export type BridgeObservation = {
  processRunning: boolean;
  reachable: boolean;
  registered: boolean;
  callActive: boolean | null;
  error?: string;
};

/** Never infer an idle telephone line from a failed status request. */
export class BridgeSupervisor {
  private lastCallActive: boolean | null = null;
  private retries = 0;
  private nextRetry = 0;
  private stopped = false;
  private commandsPending = 0;
  revision = 0;
  beginCommand() { this.commandsPending++; this.revision++; this.lastCallActive = null; }
  endCommand() { this.commandsPending = Math.max(0, this.commandsPending - 1); this.revision++; this.lastCallActive = null; }
  observe(state: BridgeObservation) {
    if (!this.commandsPending && state.reachable && state.callActive !== null) this.lastCallActive = state.callActive;
    return { ...state, uncertain: this.lastCallActive !== false && !state.reachable,
      restartAttempts: this.retries, recoveryExhausted: this.retries >= 3 };
  }
  stop() { this.stopped = true; }
  async recover(state: BridgeObservation, enabled: boolean, now: number,
    start: () => { success: boolean }) {
    this.observe(state);
    if (!enabled || this.stopped || this.commandsPending || state.processRunning || this.lastCallActive !== false ||
        this.retries >= 3 || now < this.nextRetry) return false;
    this.retries++;
    this.nextRetry = now + Math.min(60000, 5000 * 2 ** this.retries);
    return start().success;
  }
}
