// Regression guard: no route shape may reach its handler without guard().
//
// The old inline wrapRoutes skipped any route value that wasn't a method object,
// which left every route in routes-static.ts unguarded — including /api/file,
// which reads any file inside a tracked project. A DNS-rebinding page could pull
// .env or source off the daemon; the Host check that exists to stop exactly that
// never ran.
//
// Two layers here. The unit tests pin the invariant at the mechanism (every
// shape wrapped), so a future route declared as a bare function is safe by
// construction rather than by reviewer memory. The e2e half pins the eight paths
// that were actually exposed, against the real server.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { wrapRoutes } from "../src/route-guard";
import { startServer, stopServer, waitForServer } from "./_helpers";

const TEST_PORT = 17951;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// Stand-in for the real guard: refuses anything whose Host isn't loopback.
const stubDeps = () => {
  const seen: string[] = [];
  return {
    seen,
    deps: {
      guard: (req: Request) =>
        (req.headers.get("host") || "") === "evil.com"
          ? new Response("Forbidden host", { status: 403 })
          : null,
      onRequest: (method: string) => { seen.push(method); },
    },
  };
};

const hostile = (url = "http://127.0.0.1/x") => new Request(url, { headers: { host: "evil.com" } });
const friendly = (url = "http://127.0.0.1/x", init?: RequestInit) => new Request(url, init);

async function call(route: unknown, req: Request): Promise<Response> {
  return await (route as (r: Request) => Promise<Response>)(req);
}

describe("route-guard — every route shape is guarded", () => {
  test("bare function route: hostile request is blocked before the handler runs", async () => {
    let ran = false;
    const { deps } = stubDeps();
    const routes = wrapRoutes({ "/api/file": async () => { ran = true; return new Response("SECRET"); } }, deps);

    const r = await call(routes["/api/file"], hostile());
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("Forbidden host");
    expect(ran).toBe(false);
  });

  test("bare function route: a friendly request still reaches the handler with its args", async () => {
    const { deps } = stubDeps();
    const routes = wrapRoutes({
      "/api/file": async (_req: Request, extra: string) => new Response(`ok:${extra}`),
    }, deps);

    const handler = routes["/api/file"] as (r: Request, e: string) => Promise<Response>;
    expect(await (await handler(friendly(), "arg")).text()).toBe("ok:arg");
  });

  test("static Response route is served through the guard, and survives repeat hits", async () => {
    const { deps } = stubDeps();
    const routes = wrapRoutes({ "/static": new Response("body") }, deps);

    expect((await call(routes["/static"], hostile())).status).toBe(403);
    // clone() per hit — a body may only be consumed once.
    expect(await (await call(routes["/static"], friendly())).text()).toBe("body");
    expect(await (await call(routes["/static"], friendly())).text()).toBe("body");
  });

  test("method-object route: every method is wrapped, not just the common five", async () => {
    const { deps } = stubDeps();
    const routes = wrapRoutes({
      "/api/data": {
        GET: async () => new Response("data"),
        HEAD: async () => new Response(null, { status: 204 }),
      },
    }, deps);
    const def = routes["/api/data"] as Record<string, (r: Request) => Promise<Response>>;

    expect((await def.GET(hostile())).status).toBe(403);
    expect((await def.HEAD(hostile())).status).toBe(403);
    expect((await def.GET(friendly())).status).toBe(200);
  });

  test("non-function values on a method object are passed through untouched", async () => {
    const { deps } = stubDeps();
    const routes = wrapRoutes({ "/api/data": { GET: async () => new Response("x"), meta: 42 } }, deps);
    expect((routes["/api/data"] as Record<string, unknown>).meta).toBe(42);
  });

  test("the freshness callback sees allowed requests only, with their method", async () => {
    const { deps, seen } = stubDeps();
    const routes = wrapRoutes({ "/api/file": async () => new Response("ok") }, deps);

    await call(routes["/api/file"], hostile());
    expect(seen).toEqual([]);           // blocked → never counted
    await call(routes["/api/file"], friendly());
    await call(routes["/api/file"], friendly("http://127.0.0.1/x", { method: "POST" }));
    expect(seen).toEqual(["GET", "POST"]);
  });
});

// ── e2e: the eight paths that were exposed, against the real server ──────────

let server: Subprocess;
let dataDir: string;

// Every route declared in routes-static.ts. If a ninth is added there and this
// list isn't updated, the coverage test below fails.
const STATIC_PATHS = [
  "/",
  "/stack-map.html",
  "/features.html",
  "/deps.html",
  "/assets/dashboard.css",
  "/api/file?path=D:/anything/secret.txt",
  "/releases/someproject",
  "/releases/someproject/v1.0.0.html",
];

describe("route-guard e2e — the previously unguarded static routes", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "devlog-routeguard-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
  });

  afterAll(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  });

  for (const path of STATIC_PATHS) {
    test(`GET ${path} rejects a forged Host (DNS rebinding)`, async () => {
      const r = await fetch(`${BASE}${path}`, { headers: { host: "test.com" } });
      expect(r.status).toBe(403);
      expect(await r.text()).toBe("Forbidden host");
    });

    test(`GET ${path} rejects a cross-site fetch`, async () => {
      const r = await fetch(`${BASE}${path}`, { headers: { "sec-fetch-site": "cross-site" } });
      expect(r.status).toBe(403);
      expect(await r.text()).toBe("Forbidden cross-site");
    });

    test(`GET ${path} rejects a foreign Origin`, async () => {
      const r = await fetch(`${BASE}${path}`, { headers: { origin: "https://test.com" } });
      expect(r.status).toBe(403);
      expect(await r.text()).toBe("Forbidden origin");
    });
  }

  // The dashboard itself must keep working: same-origin navigation and
  // sub-resource loads carry the headers a browser really sends.
  test("a normal browser navigation to the dashboard still succeeds", async () => {
    const r = await fetch(`${BASE}/`, { headers: { "sec-fetch-site": "none" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });

  test("a same-origin asset load still succeeds", async () => {
    const r = await fetch(`${BASE}/assets/dashboard.css`, {
      headers: { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${TEST_PORT}` },
    });
    expect(r.status).toBe(200);
  });

  test("STATIC_PATHS still covers every route declared in routes-static.ts", async () => {
    const src = await Bun.file(join(import.meta.dir, "..", "src", "routes-static.ts")).text();
    const declared = [...src.matchAll(/^\s{4}"(\/[^"]*)":/gm)].map(m => m[1]);
    expect(declared.length).toBe(STATIC_PATHS.length);
  });
});
