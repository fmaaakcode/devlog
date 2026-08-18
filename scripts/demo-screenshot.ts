// Demo-dashboard screenshot: isolated server + synthetic project seeded through
// the REAL hooks (so every shape is what the product produces), then Edge
// headless over raw CDP → assets/dashboard.jpeg. Nothing from the dev machine
// appears: temp data dir, temp project dirs, English UI.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook } from "../test/_helpers";

const PORT = 17899;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[2] || join(import.meta.dir, "..", "assets", "dashboard.jpeg");
const W = 1800, H = 1000;

const root = mkdtempSync(join(tmpdir(), "devlog-demo-"));
const dataDir = join(root, "data"); mkdirSync(dataDir);
const udd = join(root, "udd"); mkdirSync(udd);
const projects = join(root, "projects"); mkdirSync(projects);

function mkProject(name: string, files: Record<string, string>): string {
  const d = join(projects, name); mkdirSync(d, { recursive: true });
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  return d;
}
const tsFile = (n: number) => Array.from({ length: n }, (_, i) => `export function fn${i}(x: number): number {\n  return x * ${i + 1};\n}\n`).join("\n");

const orbit = mkProject("orbit-api", {
  "package.json": JSON.stringify({ name: "orbit-api", version: "1.4.0", dependencies: { hono: "^4.6.0", zod: "^3.23.0", drizzle: "^0.36.0" } }, null, 2),
  "README.md": "# orbit-api\nRate-limited REST API for the Orbit mobile app.\n",
  "tsconfig.json": "{}",
  "src/index.ts": tsFile(12), "src/router.ts": tsFile(9), "src/auth/session.ts": tsFile(20), "src/auth/token.ts": tsFile(14),
  "src/billing/invoice.ts": tsFile(31), "src/billing/webhook.ts": tsFile(18), "src/db/schema.ts": tsFile(25), "src/db/client.ts": tsFile(7),
  "src/lib/rate-limit.ts": tsFile(16), "src/lib/log.ts": tsFile(5), "src/lib/retry.ts": tsFile(9),
  "test/auth.test.ts": tsFile(10), "test/billing.test.ts": tsFile(14), "test/rate-limit.test.ts": tsFile(8),
});
const nimbus = mkProject("nimbus-cli", { "package.json": JSON.stringify({ name: "nimbus-cli", version: "0.9.2" }), "src/main.ts": tsFile(6), "src/cmd/deploy.ts": tsFile(9) });
const atlas = mkProject("atlas-web", { "package.json": JSON.stringify({ name: "atlas-web", version: "2.1.0" }), "src/app.ts": tsFile(8), "src/pages/home.ts": tsFile(5) });

const server = startServer(dataDir, PORT);
try {
  await waitForServer(BASE);
  const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });

  let n = 0;
  const RUN = Date.now().toString(36); const sid = `demo-s1-${RUN}`; const S2 = `demo-s2-${RUN}`;
  function transcript(text: string): string {
    const uuid = `u${++n}`;
    const p = join(root, `tx-${uuid}.jsonl`);
    writeFileSync(p, [
      { type: "user", uuid, message: { role: "user", content: "go" } },
      { type: "assistant", uuid: `a-${uuid}`, message: { role: "assistant", content: [{ type: "text", text }] } },
    ].map(l => JSON.stringify(l)).join("\n"));
    return p;
  }
  async function turn(cwd: string, text: string, session = sid): Promise<string> {
    const tp = transcript(text);
    let r = await runHook(PORT, { cwd, session_id: session, transcript_path: tp, stop_hook_active: false });
    // one-shot nudges (story etc.) block once and ask for a re-emit — do what Claude would do
    if ((r.code === 2 || /"decision":"block"/.test(r.out)) && !/recorded in DevLog/.test(r.out)) {
      const squash = (t: string) => t.split(/\s+/).join(" ");
      console.log("  [blocked once] " + squash(r.out || r.err).slice(0, 160));
      r = await runHook(PORT, { cwd, session_id: session, transcript_path: tp, stop_hook_active: true });
      if (r.code === 2 || /"decision":"block"/.test(r.out)) console.log("  [STILL BLOCKED] " + squash(r.out || r.err).slice(0, 300));
    }
    return r.out;
  }
  const edit = (cwd: string, file: string, oldS: string, newS: string, session = sid) => post("/api/hook", { hook_event_name: "PostToolUse", tool_name: "Edit", cwd, session_id: session, tool_input: { file_path: join(cwd, file), old_string: oldS, new_string: newS } });
  const cmd = (cwd: string, command: string, exit = 0, session = sid) => post("/api/hook", { hook_event_name: "PostToolUse", tool_name: "Bash", cwd, session_id: session, tool_input: { command, description: command }, tool_response: { exit_code: exit } });

  // ── side projects (small, so the sidebar looks alive) ─────────────────────
  await turn(nimbus, "-(desc) One-command deploys for the Nimbus edge platform\n-(built) `deploy` command with dry-run diff\n-(todo) Retry on 502 from the edge API");
  await turn(atlas, "-(desc) Marketing site for Atlas — static, no framework\n-(built) Home page + pricing table\n-(bug found) Pricing toggle loses state on back-navigation");
  await edit(nimbus, "src/cmd/deploy.ts", "a", "b\nc\nd", `demo-n-${RUN}`);
  await edit(atlas, "src/pages/home.ts", "x", "y\nz", `demo-a-${RUN}`);

  // ── orbit-api: a believable history ────────────────────────────────────────
  await turn(orbit, [
    "-(desc) Rate-limited REST API behind the Orbit mobile app — auth, billing, webhooks",
    "-(about) TypeScript on Bun with Hono for routing, Zod for validation, Drizzle over Postgres; Stripe webhooks for billing.",
    "-(feature) [v1.0.0] Email + magic-link sign-in with device sessions",
    "-(feature) [v1.2.0] Usage-based billing with Stripe invoices",
    "-(feature) [v1.3.0] Per-key rate limits with burst allowance",
    "-(lib) hono — HTTP router; chosen over Express for edge-runtime compatibility",
    "-(lib) zod — request/response validation shared with the mobile client types",
    "-(lib) drizzle — typed SQL over Postgres without a heavy ORM runtime",
    "-(decision) Sessions live in Postgres, not Redis: one fewer service to run; Redis rejected because p99 was already under 40 ms without it",
    "-(insight) Every rate-limit bug so far came from clock skew between pods — always compare server time, never client timestamps",
  ].join("\n"));
  await turn(orbit, "-(release) v1.3.0 — per-key rate limits");

  await edit(orbit, "src/billing/webhook.ts", "const sig = req.header('stripe-signature')", "const sig = req.header('stripe-signature')\nif (!sig) return c.text('missing signature', 400)\nconst event = await verify(sig, raw)");
  await cmd(orbit, "bun test test/billing.test.ts", 1);
  await turn(orbit, [
    "-(bug found) Stripe webhook retries are processed twice when the first attempt times out after writing the invoice",
    "-(todo) Idempotency key on invoice creation keyed by Stripe event id",
    "-(security:dep) drizzle 0.36.0 — advisory on prepared-statement cache; upgrade path to 0.36.4",
    "-(built) Signature verification for Stripe webhooks with a 5-minute tolerance window",
  ].join("\n"));
  await edit(orbit, "src/billing/invoice.ts", "insert(invoices)", "insert(invoices).onConflictDoNothing({ target: invoices.eventId })");
  await edit(orbit, "src/db/schema.ts", "amount: integer()", "amount: integer(),\n  eventId: text().unique()");
  await cmd(orbit, "bun test test/billing.test.ts", 0);
  await cmd(orbit, "bun run typecheck", 0);
  await turn(orbit, [
    "-(bug fix) #1 the invoice row was written before the retry-safe ack; the fix makes creation idempotent on the Stripe event id so a replayed webhook is a no-op",
    "-(done) #2",
    "-(feature) Duplicate-safe billing webhooks — a retried Stripe event never bills twice",
    "-(built) Rate-limit headers (X-RateLimit-Remaining / Reset) on every authenticated route",
    "-(todo) Publish the OpenAPI schema from the Zod definitions",
    "-(bug found) Session refresh returns 401 when the device clock is more than 30 s ahead",
    "-(insight) The webhook double-processing only reproduced with the retry delay under 2 s — the test suite now pins that timing",
  ].join("\n"));
  await edit(orbit, "src/auth/session.ts", "if (exp < now)", "if (exp < now - SKEW_MS)");
  await edit(orbit, "src/lib/rate-limit.ts", "bucket.tokens -= 1", "bucket.tokens = Math.max(0, bucket.tokens - cost)");
  await cmd(orbit, "bun test", 0);
  await turn(orbit, [
    "-(bug fix) #6 the refresh check compared the token expiry against the pod clock with zero tolerance; a 60 s skew allowance fixes it and the mobile team confirmed on a skewed device",
    "-(built) Weighted rate-limit cost per route (uploads count 5×)",
    "-(decision) Keep the OpenAPI export as a build step, not a runtime route: runtime generation added 120 ms cold start for no reader who isn't a developer",
    "-(security fix) #3 bumped drizzle to 0.36.4; the advisory only affected the cache path we do use for the invoice query",
    "-(upcoming) #5",
  ].join("\n"));
  await turn(orbit, "-(release) v1.4.0 — duplicate-safe billing and rate-limit headers");
  await turn(orbit, [
    "-(built) Retry helper with jitter for outbound Stripe calls",
    "-(todo) Load-test the rate limiter at 5k rps before the app-store launch",
    "-(feature) Outbound retries with jitter — transient Stripe errors no longer surface to users",
    "-(todo) Dashboard for per-key usage (needs a read replica first)",
    "-(bug found) `/v1/keys` lists revoked keys when the `include_revoked` flag is absent",
  ].join("\n"), S2);
  await edit(orbit, "src/lib/retry.ts", "delay", "delay * (1 + Math.random() * 0.2)", S2);
  await edit(orbit, "src/router.ts", "app.get('/v1/keys'", "app.get('/v1/keys', requireScope('keys:read')", S2);
  await cmd(orbit, "bun test test/rate-limit.test.ts", 0, S2);
  await turn(orbit, [
    "-(doc:plan) App-store launch readiness",
    "## Goal",
    "Ship v1.5.0 before the mobile app-store submission.",
    "### P1 — Reliability",
    "- [x] Duplicate-safe webhooks",
    "- [x] Clock-skew tolerant sessions",
    "- [ ] Load-test the rate limiter at 5k rps",
    "### P2 — Developer surface",
    "- [ ] Publish the OpenAPI schema",
    "- [ ] Per-key usage dashboard",
    "### P3 — Launch",
    "- [ ] Rotate all API keys and revoke test keys",
    "- [ ] Tag v1.5.0",
  ].join("\n"), S2);

  // scans → file tree, language, stats
  for (const p of ["orbit-api", "nimbus-cli", "atlas-web"]) await post(`/api/scan/${p}`, {});
  await Bun.sleep(1500);

  // ── browser ────────────────────────────────────────────────────────────────
  const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);
  if (!edge) throw new Error("no browser");
  const browser = Bun.spawn({ cmd: [edge, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--hide-scrollbars", `--window-size=${W},${H}`, "about:blank"], stdout: "ignore", stderr: "ignore" });
  try {
    const portFile = join(udd, "DevToolsActivePort");
    const dl = Date.now() + 20000;
    while (!existsSync(portFile) && Date.now() < dl) await Bun.sleep(200);
    const cdpPort = parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10);
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
    let id = 0; const pending = new Map<number, (v: unknown) => void>();
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (typeof m.id === "number") { pending.get(m.id)?.(m.error ? { error: m.error } : m.result); pending.delete(m.id); } };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((res) => { const i = ++id; pending.set(i, res as (v: unknown) => void); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    await send("Page.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send("Page.navigate", { url: `${BASE}/#project=orbit-api` }, sessionId);
    const evalJ = async (expr: string) => { const r = await send("Runtime.evaluate", { expression: `JSON.stringify(${expr})`, returnByValue: true, awaitPromise: true }, sessionId) as { result?: { value?: string } }; return JSON.parse(r.result?.value ?? "null"); };
    // wait for the project + stat numbers to render
    const dl2 = Date.now() + 20000; let st: unknown = null;
    while (Date.now() < dl2) {
      st = await evalJ(`({items: document.querySelectorAll('.project-item').length, vals: document.querySelectorAll('#statsNumbers .ss-val').length, hdr: document.title})`).catch(() => null);
      if (st && (st as { items: number; vals: number }).items >= 3 && (st as { vals: number }).vals >= 5) break;
      await Bun.sleep(300);
    }
    console.log("page state:", JSON.stringify(st));
    await Bun.sleep(2500);
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 88, captureBeyondViewport: false }, sessionId) as { data: string };
    writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log("wrote", OUT, Buffer.from(shot.data, "base64").length, "bytes");
    ws.close();
  } finally { try { browser.kill(); } catch { /* already gone */ } }
} finally {
  await stopServer(server);
  await Bun.sleep(1500); try { rmSync(root, { recursive: true, force: true }); } catch { /* browser profile still locked — temp dir */ }
}
