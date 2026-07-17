// End-to-end proof of the recall layer over a real server: /api/recall answers
// a project-scoped and a cross-project (`all=1`) query from the seeded store,
// and the auto-recall hint rides the next UserPromptSubmit inject ONCE — the
// delivery advances the session's injection watermark past the fresh bug, so
// the second prompt stays silent. That once-only behavior is emergent (doInject
// logs the injection), which is why it needs a server round-trip; the
// trigger/gate matrix lives in the unit suite (recall.test.ts).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { asJson, runHook, PROJECT_ROOT as REPO_ROOT } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const TEST_PORT = 17921;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
const JSON_HEADERS = { "Content-Type": "application/json" };
const SESSION = "recall-session";

let server: Subprocess;
let dataDir: string;
let projDir: string;
let projName: string;

async function waitForServer(maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  throw new Error(`server failed to start within ${maxMs}ms`);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-recall-"));
  projDir = mkdtempSync(join(tmpdir(), "recall-proj-"));
  projName = basename(projDir);

  // Seed BEFORE boot. lastScan = now so doInject never rescans; libraries stays
  // empty so the startup vuln sweep early-returns (no network).
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    [projName]: {
      name: projName, path: projDir, description: "", blueprint: [],
      language: "TypeScript", framework: "", libraries: [], files: {},
      directories: [], totalFiles: 0, lastScan: iso(0),
    },
  }));
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
    // Recorded history: a decision, and a closed bug with its fix (files on the closer).
    { id: "d1", project: projName, tag: "decision", content: "اخترنا SSE بدل WebSocket للتحديثات لأنها أحادية الاتجاه وأخف", timestamp: iso(60 * 72) },
    { id: "b3", project: projName, tag: "bug found", content: "انقطاع اتصال websocket في الداشبورد بعد الخمول timeout", timestamp: iso(60 * 48), num: 3 },
    { id: "f3", project: projName, tag: "bug fix", content: "#3 keepalive ping كل 30 ثانية", timestamp: iso(60 * 47), files: ["assets/dashboard-core.js"] },
    // A sibling project's tag — reachable only through all=1.
    { id: "g1", project: "ghost-proj", tag: "note", content: "oembed rejection filter added at playlist import", timestamp: iso(60 * 24) },
    // The fresh open bug: minted 30 min ago, AFTER the session's last injection
    // (60 min ago) — past the watermark, so auto-recall owes it one delivery.
    { id: "b9", project: projName, tag: "bug found", content: "websocket الداشبورد ينقطع الاتصال عشوائيًا بعد فترة خمول", timestamp: iso(30), num: 9 },
  ]));
  writeFileSync(join(dataDir, "meta.json"), JSON.stringify({
    worklog: [],
    injections: [{ id: "i0", project: projName, type: "SessionStart", content: "seed", chars: 4, session_id: SESSION, timestamp: iso(60) }],
    injectionConfig: { userPromptSubmit: true },
    projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {}, processedBatches: [],
  }));

  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT),
      DEVLOG_VERSION_CHECK_DISABLED: "1", DEVLOG_REGISTRY_CHECK_DISABLED: "1", DEVLOG_LANG: "en",
    },
    stdout: "pipe", stderr: "pipe",
  });
  await waitForServer();
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  // Scrub the per-session ledger the hook test wrote into the repo's .devlog.
  rmSync(join(REPO_ROOT, ".devlog", "turn-state", `${SESSION}-hook.json`), { force: true });
});

// --- /api/recall (read-only — must run before the injects mutate the log) ---

test("GET /api/recall without q → 400", async () => {
  const r = await fetch(`${BASE}/api/recall?cwd=${encodeURIComponent(projDir)}`);
  expect(r.status).toBe(400);
});

test("project-scoped query finds the closed bug by mixed Arabic/English vocabulary", async () => {
  const r = await fetch(`${BASE}/api/recall?cwd=${encodeURIComponent(projDir)}&q=${encodeURIComponent("websocket خمول")}`);
  expect(r.status).toBe(200);
  const body = await asJson(r);
  expect(body.scope).toBe("project");
  const nums = body.results.map((x: any) => x.num).filter((n: any) => typeof n === "number");
  expect(nums).toContain(3);
  expect(body.results.every((x: any) => x.project === projName)).toBe(true);
});

test("all=1 widens the scope to sibling projects", async () => {
  const r = await fetch(`${BASE}/api/recall?cwd=${encodeURIComponent(projDir)}&q=${encodeURIComponent("oembed rejection filter")}&all=1`);
  const body = await asJson(r);
  expect(body.scope).toBe("all");
  expect(body.results.some((x: any) => x.project === "ghost-proj")).toBe(true);
});

// --- the real Stop hook serves -(ask:search) in the same turn ---

test("parse-tags serves -(ask:search) as a same-turn [devlog recall] block", async () => {
  const tx = join(projDir, "tx-recall.jsonl");
  writeFileSync(tx, [
    { type: "user", uuid: "U-recall", message: { role: "user", content: "go" } },
    { type: "assistant", uuid: "a-recall", message: { role: "assistant", content: [{ type: "text", text: "أبحث في السجل\n\n-(ask:search) websocket خمول" }] } },
  ].map(l => JSON.stringify(l)).join("\n"));
  const res = await runHook(TEST_PORT, { cwd: projDir, session_id: `${SESSION}-hook`, transcript_path: tx, stop_hook_active: false });
  const parsed = JSON.parse(res.out.trim());
  expect(parsed.decision).toBe("block");
  expect(parsed.reason).toContain("[devlog recall]");
  expect(parsed.reason).toContain("#3");
});

// --- auto-recall injection: delivered once, then the watermark silences it ---

async function inject(): Promise<string> {
  const r = await fetch(`${BASE}/api/inject`, {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: projDir, session_id: SESSION, prompt: "continue please" }),
  });
  expect(r.status).toBe(200);
  const body = await asJson(r);
  return String(body?.hookSpecificOutput?.additionalContext ?? "");
}

test("first prompt after the fresh bug: the 🧠 hint delivers the old fix (#3 + files), without the reminder", async () => {
  const ctx = await inject();
  expect(ctx).toContain("🧠");
  expect(ctx).toContain("#3");
  expect(ctx).toContain("assets/dashboard-core.js");
  expect(ctx).not.toContain("since the last reminder");
});

test("second prompt: the hint does NOT repeat (delivery advanced the watermark)", async () => {
  const ctx = await inject();
  expect(ctx).toBe("");
});
