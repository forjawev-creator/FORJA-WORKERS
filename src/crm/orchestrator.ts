import { callWorker, CallWorkerStatus } from "./call-worker.js";
import { whatsAppWorker, WhatsAppWorkerStatus } from "./whatsapp-worker.js";
import { crmService } from "./crm-service.js";
import { crmStorage } from "./crm-storage.js";

export interface OrchestratorStatus {
  active: boolean;
  campaignId?: string;
  callWorker: CallWorkerStatus;
  whatsAppWorker: WhatsAppWorkerStatus;
  funnelStats: any;
  startedAt: string | null;
  uptimeSeconds: number;
}

export class CommercialOrchestrator {
  private active = false;
  private startedAt: number | null = null;
  private currentCampaignId?: string;

  public start(campaignId?: string): { success: boolean; message: string } {
    this.active = true;
    this.startedAt = Date.now();
    this.currentCampaignId = campaignId;

    if (campaignId) {
      callWorker.setConfig({ campaignId });
    }
    callWorker.start();
    whatsAppWorker.start();

    console.log("[Orchestrator] 🚀 Motor de Prospección Comercial Outbound iniciado al 100%");
    return {
      success: true,
      message: "Orquestador comercial activado: Workers de Llamadas y WhatsApp en operación continua",
    };
  }

  public async stop(): Promise<{ success: boolean; message: string }> {
    this.active = false;
    this.startedAt = null;

    const calls = await callWorker.stop();
    await whatsAppWorker.stop();
    if (!calls.success) return calls;

    console.log("[Orchestrator] 🛑 Motor de Prospección Comercial Outbound detenido");
    return {
      success: true,
      message: "Orquestador comercial y todos los workers detenidos",
    };
  }

  public getStatus(): OrchestratorStatus {
    const uptimeSeconds = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    return {
      active: this.active,
      campaignId: this.currentCampaignId,
      callWorker: callWorker.getStatus(),
      whatsAppWorker: whatsAppWorker.getStatus(),
      funnelStats: crmService.getFunnelStats(),
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeSeconds,
    };
  }
}

export const orchestrator = new CommercialOrchestrator();
