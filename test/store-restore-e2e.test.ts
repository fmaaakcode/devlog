// A corrupt store used to boot EMPTY with only a server.log line: the user
// worked on a blank history for days without knowing, and there was no way
// back. Now (src/store-incidents.ts) the newest backup that PARSES is loaded
// and written back in place, the incident is recorded, and every project's
// SessionStart tells Claude to tell the user — until the corrupt original is
// deleted. Against the real subprocess server.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, startServer, stopServer, waitForServer } from "./_helpers";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCIDENTS_FILE, openIncidents } from "../src/store-incidents";

const TEST_PORT = 17865;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const GOOD_ROW = { id: "t1", project: "p", tag: "note", content: "قبل التلف", timestamp: "2026-09-28T00:00:00.000Z" };

let server: Subprocess;
let dataDir: string;
let proj: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-restore-"));
  proj = join(dataDir, "proj");
  mkdirSync(proj);
  writeFileSync(join(dataDir, "projects.json"),
    JSON.stringify({ p: { name: "p", path: proj, description: "", blueprint: [], language: "", framework: "", libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: new Date().toISOString() } }));
  writeFileSync(join(dataDir, "tags.json"), '[{"id":"t9","project":"p","tag":"note","content":"torn mid-wri');
  // The NEWEST backup is corrupt too — the restore must walk back to the older one.
  writeFileSync(join(dataDir, "tags.2026-09-30.bak"), "{broken");
  writeFileSync(join(dataDir, "tags.2026-09-29.bak"), JSON.stringify([GOOD_ROW]));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("corrupt store → restored from the newest backup that parses", () => {
  test("the store boots with the backup's rows, written back in place", async () => {
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.tags).toEqual([GOOD_ROW]);
    expect(JSON.parse(readFileSync(join(dataDir, "tags.json"), "utf8"))).toEqual([GOOD_ROW]);
    expect(readdirSync(dataDir).filter(f => f.startsWith("tags.json.corrupt-"))).toHaveLength(1);
  });

  test("the incident is recorded, naming the backup it came from", () => {
    const incidents = openIncidents(dataDir);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].store).toBe("tags.json");
    expect(incidents[0].restoredFrom).toBe("tags.2026-09-29.bak");
  });

  test("SessionStart tells Claude, until the corrupt original is deleted", async () => {
    const inject = async () => (await asJson(await fetch(
      `${BASE}/api/inject?cwd=${encodeURIComponent(proj)}&session_id=restore-s1&type=SessionStart`,
      { signal: AbortSignal.timeout(15000) }))) as { additionalContext?: string; hookSpecificOutput?: { additionalContext?: string } };
    const ctxOf = (j: Awaited<ReturnType<typeof inject>>) => j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? "";
    const before = ctxOf(await inject());
    expect(before).toContain("tags.json");
    expect(before).toContain("tags.2026-09-29.bak");

    for (const f of readdirSync(dataDir).filter(f => f.startsWith("tags.json.corrupt-"))) rmSync(join(dataDir, f));
    expect(openIncidents(dataDir)).toHaveLength(0);
    expect(ctxOf(await inject())).not.toContain("tags.2026-09-29.bak");
    // The log line itself stays — deleting the file is the acknowledgement.
    expect(readFileSync(join(dataDir, INCIDENTS_FILE), "utf8")).toContain("tags.json");
  });
});
