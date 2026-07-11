// UI smoke test (#433): the one BEHAVIORAL browser proof for the dashboard.
// The test suite pins dashboard invariants at the source level (regex over the
// JS — "exactly one builder definition") because browser JS has no DOM harness;
// this script closes the gap by driving the real page in a real headless
// browser over raw CDP (Bun WebSocket, zero deps) and asserting the two
// invariants that matter most:
//
//   A. Happy path: a seeded project deep-linked via #project= renders the five
//      stat numbers, live (opacity 1 — server verdicts arrived).
//   B. Degraded path (#394/#414): with /api/verdicts blocked at the network
//      layer, the numbers still render but DIMMED (opacity 0.5) with the
//      fallback tooltip — never a confident green zero.
//
// Usage: bun scripts/ui-smoke.ts   (finds Chrome/Edge/Chromium; override with
// DEVLOG_SMOKE_BROWSER=<path>). Exit 0 = both scenarios proved; 1 = failure.

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { startServer, waitForServer } from "../test/_helpers";

const PORT = 17877;
const BASE = `http://127.0.0.1:${PORT}`;
const DEADLINE_MS = 90_000;

// ── Browser discovery ────────────────────────────────────────────────────────
function findBrowser(): string {
  const env = process.env.DEVLOG_SMOKE_BROWSER;
  if (env && (existsSync(env) || Bun.which(env))) return env;
  for (const name of ["google-chrome", "chromium-browser", "chromium", "msedge", "chrome"]) {
    const p = Bun.which(name);
    if (p) return p;
  }
  for (const p of [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]) if (existsSync(p)) return p;
  throw new Error("no Chrome/Edge/Chromium found — set DEVLOG_SMOKE_BROWSER");
}

// ── Minimal raw-CDP client ───────────────────────────────────────────────────
type CdpMsg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

class Cdp {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onEvent: (method: string, params: Record<string, unknown>, sessionId?: string) => void = () => { /* default: events ignored until a scenario subscribes */ };

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("CDP websocket failed"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMsg;
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(`${msg.error.message}`)) : p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.onEvent(msg.method, msg.params || {}, msg.sessionId);
      }
    };
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 15_000);
    });
  }

  close(): void { try { this.ws.close(); } catch { /* gone */ } }
}

// Evaluate an expression in the page, JSON round-tripped.
async function evalJson<T>(cdp: Cdp, sessionId: string, expr: string): Promise<T> {
  const r = await cdp.send<{ result: { value?: string } }>("Runtime.evaluate",
    { expression: `JSON.stringify(${expr})`, returnByValue: true }, sessionId);
  return JSON.parse(r.result.value ?? "null") as T;
}

/** Poll `expr` in the page until `ok(value)` or the deadline. Returns last value. */
async function pollPage<T>(cdp: Cdp, sessionId: string, expr: string, ok: (v: T) => boolean, label: string, maxMs = 15_000): Promise<T> {
  const deadline = Date.now() + maxMs;
  let last: T = null as T;
  while (Date.now() < deadline) {
    try {
      last = await evalJson<T>(cdp, sessionId, expr);
      if (ok(last)) return last;
    } catch { /* page mid-navigation */ }
    await Bun.sleep(250);
  }
  throw new Error(`${label}: condition not met within ${maxMs}ms — last: ${JSON.stringify(last)}`);
}

const STATS_EXPR = `({
  vals: document.querySelectorAll('#statsNumbers .ss-val').length,
  text: [...document.querySelectorAll('#statsNumbers .ss-val')].map(e => e.textContent).join(','),
  opacity: document.getElementById('statsNumbers')?.style.opacity ?? '',
  title: document.getElementById('statsNumbers')?.title ?? '',
})`;
type Stats = { vals: number; text: string; opacity: string; title: string };

// ── Scenario driver ──────────────────────────────────────────────────────────
async function openDashboard(cdp: Cdp, blockPatterns: string[] = []): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  if (blockPatterns.length) {
    await cdp.send("Fetch.enable", { patterns: blockPatterns.map(urlPattern => ({ urlPattern })) }, sessionId);
  }
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url: `${BASE}/#project=real` }, sessionId);
  return sessionId;
}

async function main(): Promise<void> {
  const killAtExit: Array<() => void> = [];
  const hardDeadline = setTimeout(() => {
    console.error(`✗ ui-smoke: global deadline (${DEADLINE_MS}ms) exceeded`);
    for (const k of killAtExit) k();
    process.exit(1);
  }, DEADLINE_MS);

  // 1. Seeded server: one project, enough tags for non-zero cards.
  const dataDir = mkdtempSync(join(tmpdir(), "devlog-smoke-"));
  const userDataDir = mkdtempSync(join(tmpdir(), "devlog-smoke-udd-"));
  const now = new Date().toISOString();
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    real: { name: "real", path: join(dataDir, "nowhere"), description: "smoke", blueprint: [], language: "TypeScript", framework: "", libraries: [], files: { ts: 1 }, directories: [], totalFiles: 1, lastScan: now },
  }));
  // Position memory (#486) seed: a change event + a tag stamped with the same
  // file, so scenario D can click the 📍 button and see a non-empty story.
  const smokeFile = join(dataDir, "nowhere", "src", "main.ts").replace(/\\/g, "/");
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
    { id: crypto.randomUUID(), project: "real", tag: "built", content: "بناء أول", timestamp: now, files: [smokeFile] },
    { id: crypto.randomUUID(), project: "real", tag: "todo", content: "مهمة مفتوحة", num: 1, timestamp: now },
    { id: crypto.randomUUID(), project: "real", tag: "bug found", content: "خلل مفتوح", num: 2, timestamp: now },
    { id: crypto.randomUUID(), project: "real", tag: "feature", content: "قدرة تجريبية للعميل", num: 3, timestamp: now },
  ]));
  writeFileSync(join(dataDir, "events.json"), JSON.stringify([
    { id: crypto.randomUUID(), project: "real", event: "PostToolUse", tool: "Edit", type: "change",
      file_path: smokeFile, old_string: "a", new_string: "b", session_id: "smoke", timestamp: now },
  ]));
  const server: Subprocess = startServer(dataDir, PORT);
  killAtExit.push(() => { try { server.kill(); } catch { /* dead */ } });
  await waitForServer(BASE);

  // 2. Headless browser with an ephemeral CDP port (read from DevToolsActivePort).
  const browser = Bun.spawn({
    cmd: [findBrowser(), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "about:blank"],
    stdout: "ignore", stderr: "ignore",
  });
  killAtExit.push(() => { try { browser.kill(); } catch { /* dead */ } });
  const portFile = join(userDataDir, "DevToolsActivePort");
  const bootDeadline = Date.now() + 20_000;
  while (!existsSync(portFile) && Date.now() < bootDeadline) await Bun.sleep(200);
  if (!existsSync(portFile)) throw new Error("browser did not write DevToolsActivePort");
  const cdpPort = parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10);
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json() as { webSocketDebuggerUrl: string };

  const cdp = new Cdp();
  await cdp.connect(webSocketDebuggerUrl);
  killAtExit.push(() => cdp.close());
  // Fail every intercepted request — only /api/verdicts/* is ever patterned.
  cdp.onEvent = (method, params, sessionId) => {
    if (method === "Fetch.requestPaused" && sessionId) {
      cdp.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" }, sessionId)
        .catch(() => { /* request already gone */ });
    }
  };

  // 3A. Happy path: five live stat numbers, not dimmed.
  const happy = await openDashboard(cdp, []);
  const a = await pollPage<Stats>(cdp, happy, STATS_EXPR,
    v => v.vals === 5 && v.opacity === "1", "scenario A (live verdicts)");
  console.log(`✓ A: five stat numbers live [${a.text}], opacity=${a.opacity}`);

  // 3A2. Features chip: the «قدرات» header chip renders the server-resolved
  //      capability inventory (count + popup text) on the same happy session.
  const FEATS_EXPR = `({
    count: document.getElementById('hdr-feats-count')?.textContent ?? '',
    popup: document.getElementById('hdr-feats-popup')?.textContent ?? '',
  })`;
  const a2 = await pollPage<{ count: string; popup: string }>(cdp, happy, FEATS_EXPR,
    v => v.count === "1" && v.popup.includes("قدرة تجريبية للعميل"), "scenario A2 (features chip)");
  console.log(`✓ A2: features chip live [count=${a2.count}]`);

  // 3A3. Live git-badge swap (#492): the badge starts as «📁 local» (seeded
  //      project has no remote). Mutate the shared state module in-page, call
  //      patchHeader(), and the badge must swap to the linked 🔗 form without a
  //      project switch or reload — the exact behavior the bug said was missing.
  const GIT_EXPR = `({
    tag: document.getElementById('hdr-git')?.tagName ?? '',
    text: document.getElementById('hdr-git')?.textContent ?? '',
  })`;
  const beforeGit = await evalJson<{ tag: string; text: string }>(cdp, happy, GIT_EXPR);
  if (!beforeGit.text.includes("local")) throw new Error(`scenario A3 precondition: expected the local badge, got ${JSON.stringify(beforeGit)}`);
  await evalJson<string>(cdp, happy, `(import('/assets/dashboard-state.js').then(s => {
    s.data.projects['real'].gitRemote = 'https://github.com/acme/shop.git';
    s.data.projects['real'].gitRepoSlug = 'acme/shop';
    return import('/assets/dashboard-project.js');
  }).then(m => m.patchHeader()), 'fired')`);
  const a3 = await pollPage<{ tag: string; text: string }>(cdp, happy, GIT_EXPR,
    v => v.tag === "A" && v.text.includes("acme/shop"), "scenario A3 (live git badge)");
  console.log(`✓ A3: git badge swapped live [${a3.tag}: ${a3.text.trim()}]`);

  // 3B. Degraded path: verdicts blocked at the network layer → numbers render
  //     dimmed with the fallback tooltip, never a confident zero.
  const degraded = await openDashboard(cdp, ["*/api/verdicts/*"]);
  const b = await pollPage<Stats>(cdp, degraded, STATS_EXPR,
    v => v.vals === 5 && v.opacity === "0.5" && v.title.length > 0, "scenario B (blocked verdicts)");
  console.log(`✓ B: degraded render dimmed [${b.text}], tooltip="${b.title.slice(0, 40)}…"`);

  // 3C. R7 order-guard (#460): the project switch must NOT wait on /api/sessions
  //     (a ~400ms process snapshot) or /api/projects-summary — both moved off
  //     the render gate into a background refresh (fetchProjectView). Block BOTH
  //     at the network layer; the project must still render its five LIVE stat
  //     numbers (verdicts unblocked → opacity 1). Before the R7 fix these sat in
  //     the render's Promise.all, so failing them rejected it → the error bar
  //     showed and the numbers never rendered: this scenario would time out.
  const noWait = await openDashboard(cdp, ["*/api/sessions*", "*/api/projects-summary*"]);
  const c = await pollPage<Stats>(cdp, noWait, STATS_EXPR,
    v => v.vals === 5 && v.opacity === "1", "scenario C (sessions+summary blocked)");
  console.log(`✓ C: switch rendered without waiting on sessions/summary [${c.text}], opacity=${c.opacity}`);

  // 3D. Position memory (#486): the changes card carries a 📍 button per row;
  //     clicking it opens the file-story modal showing the tags stamped with
  //     that file — proved end-to-end (seeded event → row → click → modal).
  await pollPage<number>(cdp, happy, `document.querySelectorAll('#changesList .ch-story').length`,
    v => v > 0, "scenario D precondition (story button rendered)");
  await evalJson<string>(cdp, happy, `(document.querySelector('#changesList .ch-story').click(), 'clicked')`);
  const D_EXPR = `({
    open: !!document.getElementById('fileStoryOverlay'),
    text: document.getElementById('fileStoryOverlay')?.textContent ?? '',
  })`;
  const d = await pollPage<{ open: boolean; text: string }>(cdp, happy, D_EXPR,
    v => v.open && v.text.includes("بناء أول") && v.text.includes("main.ts"), "scenario D (file-story modal)");
  console.log(`✓ D: file-story modal opened [tags shown, file=main.ts, chars=${d.text.length}]`);

  // 3E. Card isolation (flicker guard): a live data update that changes the
  //     TAGS card must not touch the CHANGES card at all — no teardown, no
  //     "جاري التحميل…" placeholder blink, no scroll reset. Arm a real DOM
  //     MutationObserver on the changes card, fire a real tag through
  //     POST /api/tags (server broadcasts → WS pulse → surgical updateCards),
  //     wait until the tags card shows the new content, then read the counters.
  await evalJson<string>(cdp, happy, `(() => {
    const W = window; W.__iso = { changesMuts: 0, changesLoading: 0 };
    const changes = document.getElementById('cardChanges');
    new MutationObserver(muts => {
      W.__iso.changesMuts += muts.length;
      if ((changes.textContent || '').includes('جاري التحميل')) W.__iso.changesLoading++;
    }).observe(changes, { childList: true, subtree: true, characterData: true });
    return 'armed';
  })()`);
  const tagContent = `وسم عزل البطاقات ${Date.now()}`;
  const postRes = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: join(dataDir, "nowhere"), entries: [{ tag: "note", content: tagContent, breaking: false }] }),
  });
  if (!postRes.ok) throw new Error(`scenario E: POST /api/tags failed (${postRes.status})`);
  await pollPage<boolean>(cdp, happy,
    `(document.getElementById('cardTags')?.textContent || '').includes(${JSON.stringify(tagContent)})`,
    v => v === true, "scenario E precondition (tags card updated live)");
  // One extra settle window: the debounced refresh is 500ms + the async
  // /api/changes fetch — give a straggler rewrite time to land before judging.
  await Bun.sleep(1200);
  const iso = await evalJson<{ changesMuts: number; changesLoading: number }>(cdp, happy, `window.__iso`);
  if (iso.changesMuts > 0 || iso.changesLoading > 0) {
    throw new Error(`scenario E (card isolation): changes card was touched by an unrelated update — mutations=${iso.changesMuts}, loading-blinks=${iso.changesLoading}`);
  }
  console.log(`✓ E: changes card untouched by a tags update [mutations=0, loading-blinks=0]`);

  // 4. Teardown.
  clearTimeout(hardDeadline);
  cdp.close();
  try { browser.kill(); } catch { /* dead */ }
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([Promise.allSettled([browser.exited, server.exited]), Bun.sleep(3000)]);
  rmSync(dataDir, { recursive: true, force: true });
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* browser may still hold files on Windows */ }
  console.log("✓ ui-smoke: all scenarios proved");
  process.exit(0);
}

main().catch(e => {
  console.error(`✗ ui-smoke: ${(e as Error).message}`);
  process.exit(1);
});
