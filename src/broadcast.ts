// The dashboard's live-update channel: the set of connected WebSocket clients
// plus the one function that pushes a typed message to all of them. It is its
// own module (not part of server.ts) because every route group broadcasts —
// tags, events, releases, scans — and importing the router from a route file
// would be circular.
//
// Send is best-effort and self-healing: a socket that throws on send is a dead
// client, so it is dropped from the set right there. A broadcast must never
// fail the request that triggered it.

type ServerWebSocket<T> = import("bun").ServerWebSocket<T>;

export const wsClients = new Set<ServerWebSocket<unknown>>();

export function broadcast(type: string, payload?: unknown) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}
