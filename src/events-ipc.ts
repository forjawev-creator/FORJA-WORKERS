import net from "net";
import { appEvents, UiEvent } from "./events.js";

const DEFAULT_IPC_PORT = 8089;

/**
 * Servidor IPC (utilizado por el proceso de Voz).
 * Retransmite todos los eventos emitidos por appEvents a cualquier proceso de Negocio/Dashboard conectado.
 */
export function startIpcServer(port = DEFAULT_IPC_PORT): net.Server {
  const clients = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setNoDelay(true);

    socket.on("error", () => {
      clients.delete(socket);
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  // Retransmitir eventos locales a clientes remotos (Dashboard/Negocio)
  const listener = (event: UiEvent) => {
    if (clients.size === 0) return;
    const payload = JSON.stringify(event) + "\n";
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  appEvents.on("ui-event", listener);

  server.on("close", () => {
    appEvents.off("ui-event", listener);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[EventsIPC] 📡 Servidor de telemetría de voz escuchando en 127.0.0.1:${port}`);
  });

  return server;
}

/**
 * Cliente IPC (utilizado por el proceso de Negocio / Servidor Web).
 * Se conecta al proceso de Voz y reenvía los eventos al appEvents local para alimentar el WebSocket del Dashboard.
 */
export function connectIpcClient(port = DEFAULT_IPC_PORT): { close: () => void } {
  let socket: net.Socket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let isClosed = false;

  function connect() {
    if (isClosed) return;
    socket = new net.Socket();
    socket.setNoDelay(true);

    let buffer = "";

    socket.connect(port, "127.0.0.1", () => {
      console.log(`[EventsIPC] 🔗 Conectado a la telemetría en tiempo real del motor de voz (127.0.0.1:${port})`);
    });

    socket.on("data", (data) => {
      buffer += data.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event: UiEvent = JSON.parse(line);
          // Emitir en el bus local del proceso de negocio para actualizar el dashboard web
          appEvents.broadcast(event);
        } catch {}
      }
    });

    socket.on("error", () => {
      // Ignorar errores transitorios de desconexión
    });

    socket.on("close", () => {
      socket = null;
      if (!isClosed) {
        retryTimer = setTimeout(connect, 2000);
      }
    });
  }

  connect();

  return {
    close: () => {
      isClosed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) socket.destroy();
    },
  };
}
