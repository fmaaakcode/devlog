// #432 e2e proof: a PRESENT-but-corrupt store file must never be silently
// buried. Before the fix, readJsonOr swallowed the parse failure, the server
// booted with an empty store, and the first save rewrote the file — total
// history loss with zero signal. Now the corrupt original is quarantined to a
// dated `.corrupt-*` sibling (immune to the `.bak` pruning) before the server
// continues, so the evidence survives any number of later saves. Also proves
// the daily backupStores copy covers the history stores, not just the registry.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, startServer, stopServer, waitForServer } from "./_helpers";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      // A real folder: /api/tags refuses a cwd absent from disk (#1199). The
      // body carries `entries` — the shape the route stores. The old fixture
      // sent `response: "-(note) …"`, a field the route ignores: it answered
      // `count: 0`, tags.json stayed `[]`, and "survives a write" was asserted
      // over a write that never happened (#1205).
      body: JSON.stringify({ cwd: dataDir, session_id: "quarantine-e2e", entries: [{ tag: "note", content: "بعد التلف" }] }),
    });
    expect(r.status).toBe(200);
    expect((await asJson(r)).count).toBe(1);
    const saved = JSON.parse(readFileSync(join(dataDir, "tags.json"), "utf8")) as Array<{ tag: string; content: string }>;
    expect(saved.some(t => t.tag === "note" && t.content === "بعد التلف")).toBe(true);   // the write landed on disk
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
    // The quarantine left tags.json as a fresh `[]`; an empty store takes no
    // daily slot (found here, wave 9: the boot copy of that `[]` used to claim
    // the day, and the real rows saved minutes later got no copy until tomorrow).
    expect(baks).not.toContain(`tags.${stamp}.bak`);
  });

  // #1205: the case above proves the REGISTRY copy only, yet the header claims
  // the daily backup "covers the history stores". tags.json was quarantined at
  // the first boot and empty until the save above, so the claim needs a SECOND
  // boot after a real save. Restart the same data dir: the daily copy of
  // tags.json must now exist, parse, and carry the note the earlier save wrote.
  test("after a save, the next boot's daily backup covers tags.json (the history store) with the saved rows", async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    await stopServer(server);
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    const deadline = Date.now() + 4000;
    let bak = join(dataDir, `tags.${stamp}.bak`);
    while (Date.now() < deadline && !existsSync(bak)) await Bun.sleep(100);
    expect(existsSync(bak)).toBe(true);
    const rows = JSON.parse(readFileSync(bak, "utf8")) as Array<{ tag: string; content: string }>;
    expect(rows.some(r => r.tag === "note" && r.content === "بعد التلف")).toBe(true);
    // The quarantined corrupt bytes were never "backed up" as tags.json.
    expect(readFileSync(bak, "utf8")).not.toBe(CORRUPT_BYTES);
    bak = "";
  });
});
