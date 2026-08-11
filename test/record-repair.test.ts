// The repair path (plan تدقيق-السجل-الذاتي, P4) — the only code in this feature
// that MODIFIES stored history.
//
// So what is pinned here is mostly what it REFUSES: no write without an explicit
// confirmation, no bulk repair, no write when the original could not be
// archived first. A repair that loses the original is not a repair; it is data
// loss with a nice name.
//
// The pure preview is tested directly; the endpoint is driven in-process
// against the isolated test store.

import { describe, test, expect, beforeAll } from "bun:test";
import { previewRepair, repairedContent } from "../src/record-audit";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

const PROJ = "repair-proj";
let _id = 0;
const tag = (t: string, content: string): TagEntry =>
  ({ id: `r${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z" });

const data = (tags: TagEntry[]): DevLogData =>
  ({ projects: {}, tags, events: [], plans: [], worklog: [], injections: [],
     injectionConfig: {}, projectInjectionConfigs: {}, descendants: [], migrations: {} } as unknown as DevLogData);

describe("a repair only ever trims", () => {
  test("it cuts at the paragraph break, keeping the statement", () => {
    expect(repairedContent("built", "وصف العمل\n\nنثر محادثة")).toBe("وصف العمل");
  });

  test("an adjacent continuation survives — it is not swallowed prose", () => {
    const c = "وصف\nتكملة ملاصقة";
    expect(repairedContent("built", c)).toBe(c);
  });

  test("`about` and doc bodies are never trimmed", () => {
    const c = "أداة\n\nالستاك: Bun";
    expect(repairedContent("about", c)).toBe(c);
    expect(repairedContent("doc:report", c)).toBe(c);
  });

  test("the result is always a PREFIX of the original — nothing is invented", () => {
    const before = "وصف العمل\n\nنثر\n\nمزيد";
    const after = repairedContent("built", before);
    expect(before.startsWith(after)).toBe(true);
  });
});

describe("previewRepair refuses to offer a no-op", () => {
  test("a clean entry yields no preview", () => {
    const d = data([tag("built", "وصف نظيف")]);
    expect(previewRepair(d, d.tags[0].id)).toBeNull();
  });

  test("an unknown id yields no preview", () => {
    expect(previewRepair(data([]), "nope")).toBeNull();
  });

  test("an entry that would be emptied entirely is refused", () => {
    // Trimming to nothing would silently delete the record instead of cleaning
    // it — the one outcome a "repair" must never produce.
    const d = data([tag("built", "\n\nكل شيء بعد سطر فارغ")]);
    expect(previewRepair(d, d.tags[0].id)).toBeNull();
  });

  test("a dirty entry yields before, after and how much is dropped", () => {
    const d = data([tag("built", "وصف العمل\n\nنثر محادثة طويل هنا")]);
    const p = previewRepair(d, d.tags[0].id);
    expect(p?.before).toContain("نثر");
    expect(p?.after).toBe("وصف العمل");
    expect(p?.removed).toBeGreaterThan(10);
  });
});

describe("POST /api/record-repair", () => {
  const DIRTY = "وصف العمل الحقيقي\n\nتم الإغلاق. جرّب الآن.";
  let id = "";

  type Handler = { POST: (req: Request) => Promise<Response> };
  const call = async (body: unknown) => {
    const { makeFeatureRoutes } = await import("../src/routes-features");
    const h = (makeFeatureRoutes({ htmlResponse: b => new Response(String(b)) })["/api/record-repair"] as Handler).POST;
    const res = await h(new Request("http://x/api/record-repair", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  beforeAll(async () => {
    const { withData } = await import("../src/data");
    await withData(async (d) => {
      d.projects[PROJ] = { name: PROJ, path: "D:/repair", files: {}, directories: [], totalFiles: 0 } as unknown as ProjectProfile;
      id = `repair-fixture-${Date.now()}`;
      d.tags.push({ id, project: PROJ, tag: "built", content: DIRTY, timestamp: "2026-06-01T00:00:00Z" });
    });
  });

  test("no id is a 400 — there is no bulk repair", async () => {
    const r = await call({ confirm: true });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("id required");
  });

  test("an unknown id is a 404", async () => {
    expect((await call({ id: "no-such-entry", confirm: true })).status).toBe(404);
  });

  test("without confirm it previews and writes NOTHING", async () => {
    const r = await call({ id });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
    expect(r.body.after).toBe("وصف العمل الحقيقي");
    const { loadData } = await import("../src/data");
    expect((await loadData()).tags.find(t => t.id === id)?.content).toBe(DIRTY);
  });

  test("with confirm it applies, and the stored entry is the trimmed one", async () => {
    const r = await call({ id, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    const { loadData } = await import("../src/data");
    expect((await loadData()).tags.find(t => t.id === id)?.content).toBe("وصف العمل الحقيقي");
  });

  test("repairing the same entry twice is a 404 — it is already clean", async () => {
    expect((await call({ id, confirm: true })).status).toBe(404);
  });
});
