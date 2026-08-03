// The single place where the origin/host guard is attached to the route table.
//
// It used to live inline in server.ts and skipped any route value that wasn't a
// `{ GET(){…} }` object:
//
//     if (typeof def === "function" || def instanceof Response) { out[path] = def; continue; }
//
// That is a SHAPE filter, not an allowlist — and Bun accepts a bare function as
// a route value just as happily. Every route in routes-static.ts is written that
// way, so all eight of them (the four dashboard pages, /assets/:file, /api/file
// and both /releases/* forms) reached their handler without ever passing
// guard(). /api/file reads any file inside a tracked project, so a DNS-rebinding
// page could read .env / source straight off the daemon — exactly the attack the
// Host check exists to stop. The token check sits at the end of guard(), so it
// fell with it.
//
// The fix is the invariant, not the eight paths: NO route value shape may reach
// its handler unguarded. Bare functions and static Responses are wrapped too, and
// on the object shape every method handler is wrapped — not just the five in a
// hard-coded set, since an unguarded HEAD leaks the same headers a GET would.
// Adding a route in any shape is now safe by construction.

export interface RouteGuardDeps {
  /** Returns a blocking Response when the request must be refused, else null. */
  guard: (req: Request) => Response | null;
  /** Called with the method of every allowed request (freshness watchdog). */
  onRequest: (method: string) => void;
}

type Handler = (req: Request, ...rest: unknown[]) => unknown;

function wrapHandler(handler: Handler, { guard, onRequest }: RouteGuardDeps): Handler {
  return async (req: Request, ...rest: unknown[]) => {
    const blocked = guard(req);
    if (blocked) return blocked;
    onRequest(req.method);
    return handler(req, ...rest);
  };
}

/**
 * Attach `deps.guard` to every handler in a Bun route table, whatever shape the
 * route was declared in: a method object, a bare function, or a static Response.
 */
export function wrapRoutes<T extends Record<string, unknown>>(routes: T, deps: RouteGuardDeps): T {
  const out: Record<string, unknown> = {};
  for (const [path, def] of Object.entries(routes)) {
    if (typeof def === "function") {
      out[path] = wrapHandler(def as Handler, deps);
      continue;
    }
    if (def instanceof Response) {
      // A static Response can't carry a check, so serve it from a guarded
      // handler instead. clone() because a body may only be consumed once and
      // this route can be hit repeatedly.
      out[path] = wrapHandler(() => def.clone(), deps);
      continue;
    }
    const wrapped: Record<string, unknown> = {};
    for (const [method, handler] of Object.entries(def as Record<string, unknown>)) {
      wrapped[method] = typeof handler === "function"
        ? wrapHandler(handler as Handler, deps)
        : handler;
    }
    out[path] = wrapped;
  }
  return out as T;
}
