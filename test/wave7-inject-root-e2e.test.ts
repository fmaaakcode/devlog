// Wave 7 (audit round 10) end-to-end, against the real subprocess server:
//   · #1053 — a SessionStart inject from a conventional SUBFOLDER of a
//     registered project writes `.devlog/` at the project root, never inside
//     the subfolder (the phantom folder git used to see);
//   · #1060 — DELETE /api/data/clear zeroes the stores the wipe forgot: the
//     prompts field of meta.json, every archive month on disk, and the
//     rule-telemetry trail — and says so in its response.
// Stores are seeded on disk BEFORE boot so the proof is about the server's
// own reads, not about a fixture the test could shape to pass.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asJson, startServer, stopServer, waitForServer } from "./_helpers";

const TEST_PORT = 17996;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server: Subprocess;
let dataDir: string;
let root: string;
let sub: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-wave7-data-"));
  root = mkdtempSync(join(tmpdir(), "devlog-wave7-proj-"));
  sub = join(root, "api");   // a NESTED_MANIFEST_DIRS name: the convention layer folds it into the parent
  mkdirSync(sub);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "rootproj", version: "1.0.0" }));
  writeFileSync(join(sub, "package.json"), JSON.stringify({ name: "api", version: "1.0.0" }));

  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    rootproj: {
      name: "rootproj", path: root, description: "", blueprint: [], language: "TypeScript", framework: "",
      libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-07-01T00:00:00.000Z",
    },
  }));
  // One tag, so exportStatusMd has something to mirror (it writes nothing for an empty project).
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
    { id: "t1", project: "rootproj", tag: "todo", content: "seed item", timestamp: "2026-08-01T00:00:00.000Z" },
  ]));
  writeFileSync(join(dataDir, "meta.json"), JSON.stringify({
    worklog: [],
    prompts: [{ id: "pr1", project: "rootproj", text: "كلمات المستخدم", tagIds: [], timestamp: "2026-08-01T00:00:00.000Z" }],
  }));
  mkdirSync(join(dataDir, "archive"));
  writeFileSync(join(dataDir, "archive", "events-2020-01.jsonl"),
    `${JSON.stringify({ id: "old-e1", project: "rootproj", event: "PostToolUse", type: "change", timestamp: "2020-01-01T00:00:00.000Z" })}\n`);
  writeFileSync(join(dataDir, "rule-telemetry.jsonl"),
    `${JSON.stringify({ ts: "2026-08-01T00:00:00.000Z", gate: "turn", action: "pass", rule: "closure", project: "rootproj" })}\n`);

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("#1053: a SessionStart from a folded subfolder writes .devlog at the project ROOT, not in the subfolder", async () => {
  const r = await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(sub)}&session_id=wave7-s1&type=SessionStart`,
    { signal: AbortSignal.timeout(15000) });
  expect(r.status).toBe(200);
  expect(existsSync(join(sub, ".devlog"))).toBe(false);
  expect(existsSync(join(root, ".devlog", "DEVLOG_STATUS.md"))).toBe(true);
  // And the attribution itself folded: no phantom "api" project was minted.
  const data = await asJson(await fetch(`${BASE}/api/data`));
  expect(Object.keys(data.projects)).toEqual(["rootproj"]);
});

// LAST on purpose: it empties everything the test above read.
test("#1060: the wipe zeroes prompts, the archive months and the telemetry trail", async () => {
  const before = await asJson(await fetch(`${BASE}/api/data`));
  expect((before.prompts ?? []).length).toBe(1);

  const r = await fetch(`${BASE}/api/data/clear`, { method: "DELETE", headers: { "X-Confirm": "yes" } });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, archiveRows: 1, telemetryCleared: true });

  const after = await asJson(await fetch(`${BASE}/api/data`));
  expect((after.prompts ?? []).length).toBe(0);
  expect(existsSync(join(dataDir, "archive", "events-2020-01.jsonl"))).toBe(false);
  expect(existsSync(join(dataDir, "archive", "events-2020-01.jsonl.gz"))).toBe(false);
  expect(existsSync(join(dataDir, "rule-telemetry.jsonl"))).toBe(false);
});
