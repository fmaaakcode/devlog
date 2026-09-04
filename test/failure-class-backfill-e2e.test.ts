// E2E: /api/failure-class-backfill (#998). Boots a real server, opens and
// closes two bugs through /api/tags (one closer writes its own class, one
// writes none), then proves: GET serves only the unclassified closer; POST
// without confirm previews and writes nothing; a class the closer wrote is
// refused; a confirmed batch writes the class WITH the backfilled stamp, the
// original row lands in the `undone` archive first, and the class-scoped rule
// effect in /api/retro sees the new coverage.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer } from "./_helpers";

const TEST_PORT = 17981;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

async function register(cwd: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=fcb-e2e&type=SessionStart`, { signal: AbortSignal.timeout(10000) });
}
async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
const getJson = async (path: string): Promise<any> => (await fetch(`${BASE}${path}`)).json();

describe("failure-class backfill route (E2E)", () => {
  let dataDir: string, projDir: string, server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "fcb-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "fcb-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir);
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("serve → preview → refuse closer-written → confirmed write with archive and stamp", async () => {
    const cwd = encodeURIComponent(projDir);
    const tagsBody = (entries: unknown[]) => ({ cwd: projDir, session_id: "fcb-e2e", entries });
    await post("/api/tags", tagsBody([
      { tag: "bug found", content: "the anchor regex eats the tail" },
      { tag: "bug found", content: "cache never invalidated on rename" },
    ]));
    const open = await getJson(`/api/open-items?cwd=${cwd}`);
    const nums = open.items.filter((it: any) => it.tag === "bug found").map((it: any) => it.num).sort((a: number, b: number) => a - b);
    expect(nums).toHaveLength(2);
    const [a, b] = nums;
    // A closes with no class; B's closer writes its own.
    await post("/api/tags", tagsBody([
      { tag: "bug fix", content: `#${a} the anchor was missing` },
      { tag: "bug fix", content: `#${b} [stale] the cache key ignored the rename` },
    ]));

    // GET: only A is a candidate; B counts as classified by its closer.
    const corpus = await getJson(`/api/failure-class-backfill?cwd=${cwd}`);
    expect(corpus.total).toBe(2);
    expect(corpus.byCloser).toBe(1);
    expect(corpus.backfilled).toBe(0);
    expect(corpus.candidates.map((c: any) => c.num)).toEqual([a]);
    const candidate = corpus.candidates[0];
    expect(typeof candidate.closerId).toBe("string");
    expect(candidate.cause).toBe("the anchor was missing");
    const closedB = (await getJson(`/api/closed-items?cwd=${cwd}&num=${b}`)).items[0];
    expect(closedB.failureClass).toBe("stale");

    // Preview: nothing written.
    const preview = await post("/api/failure-class-backfill", { assignments: [{ closerId: candidate.closerId, class: "مطابق" }] });
    expect(preview.status).toBe(200);
    expect(preview.json.applied).toBe(false);
    expect(preview.json.rows).toEqual([{ closerId: candidate.closerId, num: a, from: "unclassified", to: "matcher" }]);
    expect((await getJson(`/api/failure-class-backfill?cwd=${cwd}`)).candidates).toHaveLength(1);

    // A class the closer wrote itself is refused, and the refusal sinks the whole batch.
    const refused = await post("/api/failure-class-backfill", { confirm: true, assignments: [
      { closerId: candidate.closerId, class: "matcher" },
      { closerId: closedB.closerId, class: "drift" },
    ] });
    expect(refused.status).toBe(422);
    expect(refused.json.applied).toBe(false);
    expect(refused.json.refused[0].reason).toContain("closer wrote its own class [stale]");
    expect((await getJson(`/api/failure-class-backfill?cwd=${cwd}`)).candidates).toHaveLength(1);

    // Confirmed write.
    const applied = await post("/api/failure-class-backfill", { confirm: true, assignments: [{ closerId: candidate.closerId, class: "matcher" }] });
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ applied: true, changed: 1 });
    const closedA = (await getJson(`/api/closed-items?cwd=${cwd}&num=${a}`)).items[0];
    expect(closedA.failureClass).toBe("matcher");
    expect(closedA.failureClassBackfilled).toBe(true);
    expect(closedA.cause).toBe("the anchor was missing");   // untouched
    const after = await getJson(`/api/failure-class-backfill?cwd=${cwd}`);
    expect(after.candidates).toEqual([]);
    expect(after.backfilled).toBe(1);
    expect(after.byCloser).toBe(1);

    // Archive-before-modify: the pre-write closer row is in the undone stream.
    const months: string[] = (await getJson("/api/undone")).months;
    expect(months).toHaveLength(1);
    const { records } = await getJson(`/api/undone?month=${months[0]}`);
    const archivedA = records.find((r: any) => r.entry?.id === candidate.closerId);
    expect(archivedA).toBeDefined();
    expect(archivedA.entry.failureClass).toBeUndefined();
    expect(archivedA.entry.cause).toBe("the anchor was missing");

    // The retro corpus carries both classes now.
    const retro = await getJson(`/api/retro?cwd=${cwd}`);
    const classes = Object.fromEntries(retro.items.map((it: any) => [it.num, it.failureClass]));
    expect(classes[a]).toBe("matcher");
    expect(classes[b]).toBe("stale");
  });

  test("bad input: no assignments → 400; unknown id → 422 with the reason; nothing archived", async () => {
    const empty = await post("/api/failure-class-backfill", { assignments: [] });
    expect(empty.status).toBe(400);
    const unknown = await post("/api/failure-class-backfill", { confirm: true, assignments: [{ closerId: "nope", class: "matcher" }] });
    expect(unknown.status).toBe(422);
    expect(unknown.json.refused[0].reason).toContain("unknown id");
    // A refused batch archives nothing.
    expect((await getJson("/api/undone")).months).toEqual([]);
  });
});
