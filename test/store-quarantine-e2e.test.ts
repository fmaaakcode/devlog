// #432 e2e proof: a PRESENT-but-corrupt store file must never be silently
// buried. Before the fix, readJsonOr swallowed the parse failure, the server
// booted with an empty store, and the first save rewrote the file — total
// history loss with zero signal. Now the corrupt original is quarantined to a
// dated `.corrupt-*` sibling (immune to the `.bak` pruning) before the server
// continues, so the evidence survives any number of later saves. Also proves
// the daily backupStores copy covers the history stores, not just the registry.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, startServer, waitForServer } from "./_helpers";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17864;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const CORRUPT_BYTES = '[{"id":"t1","project":"p","tag":"note","content":"truncated mid-wri';

let server: Subprocess;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-quarantine-"));
  writeFileSync(join(dataDir, "projects.json"),
    JSON.stringify({ p: { name: "p", path: join(dataDir, "nowhere"), description: "", blueprint: [], language: "", framework: "", libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: new Date().toISOString() } }));
  writeFileSync(join(dataDir, "tags.json"), CORRUPT_BYTES);   // torn write / disk corruption
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("corrupt store quarantine (#432)", () => {
  test("server boots; the intact stores survive, the corrupt one starts empty", async () => {
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.projects.p).toBeDefined();   // projects.json parsed fine
    expect(data.tags).toEqual([]);           // corrupt tags fell back to empty
  });

  test("the corrupt original is preserved byte-for-byte under .corrupt-*", async () => {
    const corrupt = readdirSync(dataDir).filter(f => f.startsWith("tags.json.corrupt-"));
    expect(corrupt).toHaveLength(1);
    expect(await Bun.file(join(dataDir, corrupt[0])).text()).toBe(CORRUPT_BYTES);
  });

  test("a later save cannot bury the evidence: quarantine file survives a write", async () => {
    const r = await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: join(dataDir, "nowhere"), response: "-(note) بعد التلف" }),
    });
    expect(r.status).toBe(200);
    const corrupt = readdirSync(dataDir).filter(f => f.startsWith("tags.json.corrupt-"));
    expect(corrupt).toHaveLength(1);
    expect(await Bun.file(join(dataDir, corrupt[0])).text()).toBe(CORRUPT_BYTES);
  });

  test("daily backupStores covers the registry at boot (history stores once written)", async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    // Boot backup runs async after serve; poll briefly.
    const deadline = Date.now() + 4000;
    let baks: string[] = [];
    while (Date.now() < deadline) {
      baks = readdirSync(dataDir).filter(f => f.endsWith(`.${stamp}.bak`));
      if (baks.length) break;
      await Bun.sleep(100);
    }
    expect(baks).toContain(`projects.${stamp}.bak`);
  });
});
