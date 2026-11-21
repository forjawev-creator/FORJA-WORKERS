export interface ShutdownDependencies {
  enabled(): boolean;
  begin(): void;
  markUncertain(): void;
  hangup(): Promise<{ success: boolean }>;
  idle(): Promise<boolean>;
  close(): void;
}
/** Keep the SIP watchdog and diagnostic API alive until idle is positively observed. */
export class PilotShutdown {
  stopping = false;
  private busy = false;
  constructor(private readonly deps: ShutdownDependencies) {}
  async run(): Promise<boolean> {
    this.stopping = true; this.deps.begin();
    if (this.busy) return false;
    this.busy = true;
    try {
      if (this.deps.enabled()) {
        this.deps.markUncertain();
        if (!(await this.deps.hangup()).success || !(await this.deps.idle())) return false;
      }
      this.deps.close(); return true;
    } catch { return false; }
    finally { this.busy = false; }
  }
}
