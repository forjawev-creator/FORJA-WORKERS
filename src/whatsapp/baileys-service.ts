import { runtimePolicy, communicationsBlockedMessage } from "../runtime-policy.js";
import path from "path";
import fs from "fs";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
  ConnectionState,
} from "@whiskeysockets/baileys";
import { normalizeSpanishPhone } from "../crm/crm-service.js";
import { handleIncomingWhatsAppUpsert } from "./whatsapp-ai-responder.js";

const AUTH_DIR = path.resolve(process.cwd(), "data", "whatsapp_auth");

export interface WhatsAppClientStatus {
  status: "disconnected" | "connecting" | "connected";
  phone: string | null;
  name: string | null;
  qrCodeDataUrl: string | null;
  lastError: string | null;
  updatedAt: string;
}

export class BaileysWhatsAppService {
  private sock: WASocket | null = null;
  private status: "disconnected" | "connecting" | "connected" = "disconnected";
  private qrCodeDataUrl: string | null = null;
  private connectedPhone: string | null = null;
  private connectedName: string | null = null;
  private lastError: string | null = null;
  private isInitializing = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor() {
    this.ensureAuthDir();
  }

  private ensureAuthDir(): void {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
  }

  public getStatus(): WhatsAppClientStatus {
    return {
      status: this.status,
      phone: this.connectedPhone,
      name: this.connectedName,
      qrCodeDataUrl: this.qrCodeDataUrl,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    };
  }

  public async startConnection(forceNew = false): Promise<WhatsAppClientStatus> {
    if (!runtimePolicy().realWhatsAppEnabled) { this.lastError = communicationsBlockedMessage; return this.getStatus(); }
    if (this.isInitializing) {
      return this.getStatus();
    }

    if (forceNew) {
      await this.logout();
    }

    this.isInitializing = true;
    this.status = "connecting";
    this.lastError = null;

    try {
      this.ensureAuthDir();
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      // Desactivar logs ruidosos de Baileys
      const logger = pino({ level: "silent" });

      this.sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ["Forja Web Agent", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        generateHighQualityLinkPreview: false,
      });

      this.sock.ev.on("creds.update", saveCreds);

      // Escuchar mensajes entrantes para el Asistente IA
      this.sock.ev.on("messages.upsert", async (m: any) => {
        try {
          await handleIncomingWhatsAppUpsert(m);
        } catch (err: any) {
          console.error("[WhatsApp Baileys] Error en messages.upsert:", err?.message || err);
        }
      });

      this.sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr, {
              margin: 2,
              scale: 6,
              color: { dark: "#000000", light: "#ffffff" },
            });
            this.status = "connecting";
            console.log("[WhatsApp Baileys] Nuevo código QR generado para escaneo con el móvil.");
          } catch (e: any) {
            console.error("[WhatsApp Baileys] Error generando DataURL de QR:", e);
          }
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          this.status = "disconnected";
          this.qrCodeDataUrl = null;
          this.connectedPhone = null;
          this.connectedName = null;
          this.lastError = lastDisconnect?.error?.message || "Conexión cerrada";

          console.warn(
            `[WhatsApp Baileys] Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`
          );

          if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(5000 * this.reconnectAttempts, 20000);
            console.log(`[WhatsApp Baileys] Reintentando conexión en ${delay / 1000}s... (Intento ${this.reconnectAttempts})`);
            setTimeout(() => {
              this.isInitializing = false;
              this.startConnection().catch(() => {});
            }, delay);
          } else if (statusCode === DisconnectReason.loggedOut) {
            console.log("[WhatsApp Baileys] Sesión cerrada desde el dispositivo. Limpiando credenciales.");
            await this.clearAuthData();
          }
        } else if (connection === "open") {
          this.status = "connected";
          this.reconnectAttempts = 0;
          this.qrCodeDataUrl = null;
          this.lastError = null;

          const me = this.sock?.user;
          if (me) {
            const rawId = me.id || "";
            const phoneOnly = rawId.split(":")[0] || rawId.split("@")[0];
            this.connectedPhone = phoneOnly ? `+${phoneOnly}` : null;
            this.connectedName = me.name || "Línea WhatsApp";
          }

          console.log(`=======================================================`);
          console.log(`  📱 WhatsApp Conectado: ${this.connectedPhone || "Activo"} (${this.connectedName})`);
          console.log(`=======================================================`);
        }
      });

      return this.getStatus();
    } catch (err: any) {
      this.status = "disconnected";
      this.lastError = err.message;
      console.error("[WhatsApp Baileys] Error iniciando conexión:", err);
      return this.getStatus();
    } finally {
      this.isInitializing = false;
    }
  }

  public async logout(): Promise<void> {
    try {
      if (this.sock) {
        try {
          await this.sock.logout();
        } catch {}
        try {
          this.sock.end(undefined);
        } catch {}
        this.sock = null;
      }
    } catch {}

    await this.clearAuthData();
    this.status = "disconnected";
    this.connectedPhone = null;
    this.connectedName = null;
    this.qrCodeDataUrl = null;
    this.reconnectAttempts = 0;
    this.lastError = null;
  }

  private async clearAuthData(): Promise<void> {
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    } catch (e: any) {
      console.error("[WhatsApp Baileys] Error borrando auth data:", e.message);
    }
  }

  public getSocket(): WASocket | null {
    return runtimePolicy().realWhatsAppEnabled ? this.sock : null;
  }

  public async sendMessage(
    recipient: string,
    message: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!runtimePolicy().realWhatsAppEnabled) return { success: false, error: communicationsBlockedMessage };
    if (this.status !== "connected" || !this.sock) {
      return {
        success: false,
        error: "Línea de WhatsApp no conectada. Escanea el código QR en el panel para vincularla.",
      };
    }

    try {
      let jid = recipient.trim();
      // Si el destinatario no incluye '@', es un número telefónico -> formatear a @s.whatsapp.net
      if (!jid.includes("@")) {
        const normalized = normalizeSpanishPhone(recipient);
        const cleanPhone = (normalized || recipient).replace(/[^0-9]/g, "");

        if (cleanPhone.length < 8) {
          return { success: false, error: `Número de teléfono no válido: ${recipient}` };
        }

        jid = `${cleanPhone}@s.whatsapp.net`;
      }

      // Enviar mensaje de texto directamente al JID del chat
      const result = await this.sock.sendMessage(jid, { text: message });

      const messageId = result?.key?.id || undefined;
      console.log(`[WhatsApp Baileys] Mensaje enviado a ${recipient} (${jid}) [ID: ${messageId}]`);

      return {
        success: true,
        messageId,
      };
    } catch (err: any) {
      console.error(`[WhatsApp Baileys] Error enviando a ${recipient}:`, err);
      return {
        success: false,
        error: err.message || "Fallo enviando mensaje por WhatsApp",
      };
    }
  }

  public async sendPresenceUpdate(type: "composing" | "paused", jid: string): Promise<void> {
    if (runtimePolicy().realWhatsAppEnabled && this.sock && this.status === "connected") {
      try {
        await this.sock.sendPresenceUpdate(type, jid);
      } catch {}
    }
  }

  public async readMessages(keys: any[]): Promise<void> {
    if (runtimePolicy().realWhatsAppEnabled && this.sock && this.status === "connected") {
      try {
        await this.sock.readMessages(keys);
      } catch {}
    }
  }
}

export const baileysWhatsAppService = new BaileysWhatsAppService();
