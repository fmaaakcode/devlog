type ServerWebSocket<T> = import("bun").ServerWebSocket<T>;

export const wsClients = new Set<ServerWebSocket<unknown>>();

export function broadcast(type: string, payload?: any) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}
