// E2E for the deps explainer (#663), driven through the REAL Stop hook
// (parse-tags.ts) against a live server:
//   - `-(lib) name — غرض` is a STORED tag; re-emitting the name replaces the purpose.
//   - `/api/deps` merges the scanned manifest libraries with the purposes,
//     uncovered-first, with coverage counters.
//   - `-(ask:deps)` serves the inventory in-turn (✓ covered / ∅ uncovered) and
//     is never stored.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17923;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

async function register(cwd: string, sid: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
async function post(cwd: string, sid: string, entries: unknown[]): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: sid, entries }),
  });
  return await r.json() as Record<string, unknown>;
}
async function getDeps(cwd: string): Promise<{ total: number; withPurpose: number; libraries: Array<{ name: string; purpose?: string; dev?: boolean }> }> {
  const r = await fetch(`${BASE}/api/deps?cwd=${encodeURIComponent(cwd)}`);
  return await r.json() as Awaited<ReturnType<typeof getDeps>>;
}
function writeTranscript(dir: string, userUuid: string, assistantTexts: string[]): string {
  const lines: unknown[] = [
    { type: "user", uuid: userUuid, message: { role: "user", content: "go" } },
    ...assistantTexts.map((text, i) => ({
      type: "assistant", uuid: `a-${userUuid}-${i}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    })),
  ];
  const p = join(dir, `transcript-${userUuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

describe("deps explainer (E2E)", () => {
  let dataDir: string, projDir: string, sid: string, server: Subprocess;

  beforeEach(async () => {
    sid = `deps-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "deps-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "deps-e2e-proj-"));
    // A real manifest so the registration scan yields p.libraries.
    writeFileSync(join(projDir, "package.json"), JSON.stringify({
      name: "deps-e2e", version: "1.0.0",
      dependencies: { zod: "3.23.8", hono: "4.4.0" },
      devDependencies: { typescript: "5.4.0" },
    }));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir, sid);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("lib tag stores a purpose; /api/deps merges it uncovered-first; re-emit replaces", async () => {
    let deps = await getDeps(projDir);
    expect(deps.total).toBe(3);
    expect(deps.withPurpose).toBe(0);

    await post(projDir, sid, [{ tag: "lib", content: "zod — التحقق من مخططات الإدخال" }]);
    deps = await getDeps(projDir);
    expect(deps.withPurpose).toBe(1);
    // Uncovered first — zod (covered) sorts last.
    expect(deps.libraries[deps.libraries.length - 1].name).toBe("zod");
    expect(deps.libraries.find(l => l.name === "zod")?.purpose).toBe("التحقق من مخططات الإدخال");
    expect(deps.libraries.find(l => l.name === "typescript")?.dev).toBe(true);

    await post(projDir, sid, [{ tag: "lib", content: "zod — تحقق + تحويل أنواع" }]);
    deps = await getDeps(projDir);
    expect(deps.withPurpose).toBe(1);   // replaced, not duplicated
    expect(deps.libraries.find(l => l.name === "zod")?.purpose).toBe("تحقق + تحويل أنواع");
  });

  test("-(ask:deps) serves the inventory in-turn and is not stored", async () => {
    await post(projDir, sid, [{ tag: "lib", content: "hono — راوتر HTTP للـAPI" }]);
    const tx = writeTranscript(projDir, "D1", ["checking\n\n-(ask:deps)"]);
    const res = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(res.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog deps]");
    expect(parsed.reason).toContain("✓ hono@4.4.0");
    expect(parsed.reason).toContain("راوتر HTTP للـAPI");
    expect(parsed.reason).toContain("∅ zod@3.23.8");
    expect(parsed.reason).toContain("-(lib)");   // the backfill footer

    // Ephemeral: the ask left no stored tag behind.
    const deps = await getDeps(projDir);
    expect(deps.withPurpose).toBe(1);
  });
});
