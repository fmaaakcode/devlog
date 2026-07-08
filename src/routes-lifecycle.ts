// Daemon-lifecycle route group: the boot/freshness verdict and the stop/restart
// controls. Extracted from server.ts under the file-size ratchet when the
// freshness watchdog landed. `stopAll` is injected: it must release BOTH
// loopback listeners (v4 + v6) for a deterministic port hand-over — a
// half-stopped pair is how two processes ended up alternating on 7777
// (2026-07-08 dual-listener incident).

import { appendAudit } from "./audit";
import { isStale, newestSourceMtime, scheduleRestart } from "./freshness";

type ApiReq = Bun.BunRequest;

export interface LifecycleDeps {
  bootMs: number;
  assetRoot: string;
  stopAll: () => void;
}

/** Build the lifecycle route group. Spread into server.ts's routeDefs. */
export function makeLifecycleRoutes(deps: LifecycleDeps): Record<string, unknown> {
  return {
    // Daemon freshness (#326): `boot` = server start (ms); `stale` = true when any
    // source file on disk is newer than boot (the daemon loads code once and, with
    // no --watch, serves it until restarted). The comparison runs here (portable
    // fs.stat) instead of `find -newermt` in the shell (GNU-only, dead on macOS).
    "/api/boot": {
      async GET() {
        const newest = await newestSourceMtime(deps.assetRoot);
        return Response.json({ boot: deps.bootMs, stale: isStale(deps.bootMs, newest) });
      },
    },

    // Stop the server. Used by the dashboard kill button to reload code
    // changes when running under `bun --watch`. Schedules exit AFTER the
    // response is flushed so the client receives 200 OK before the socket
    // closes.
    "/api/server/stop": {
      async POST(req: ApiReq) {
        await appendAudit("server.stop", req);
        setTimeout(() => process.exit(0), 100);
        return Response.json({ ok: true, stopping: true });
      },
    },

    // Self-restart, pairing with /api/boot's stale verdict: close both
    // listeners (deterministic port hand-over), spawn the replacement, exit.
    // Token-gated like stop via PROTECTED_PREFIXES. The freshness watchdog
    // triggers the same hand-over automatically (see startAutoRestart).
    "/api/server/restart": {
      async POST(req: ApiReq) {
        await appendAudit("server.restart", req);
        scheduleRestart(deps.stopAll);
        return Response.json({ ok: true, restarting: true });
      },
    },
  };
}
