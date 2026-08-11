// buildFileWhy — the `ask:why` dossier for one file (plan ask-why-file-archaeology, P1).
//
// The contract this pins: path matching is inherited from file-story (relative,
// absolute, Windows separators, case), every section is capped with a reported
// remainder rather than a silent cut, a file with no history still answers, and
// a report carries how it ENDED — span, ⟲ when the fix did not hold, and the
// reasoning stored on the closer.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSlashes } from "../src/path-utils";
import { buildFileWhy, type FileWhy } from "../src/file-why";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

const PROJ = "why-proj";
const ROOT = "D:/proj";
const F = `${ROOT}/src/core.ts`;

let _id = 0;
function tag(t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return {
    id: `t${_id++}`, project: PROJ, tag: t, content,
    timestamp: "2026-06-01T00:00:00Z", files: [F], ...extra,
  };
}

function data(tags: TagEntry[], events: DevLogData["events"] = []): DevLogData {
  const profile = { name: PROJ, path: ROOT, files: {}, directories: [], totalFiles: 0 } as unknown as ProjectProfile;
  return {
    projects: { [PROJ]: profile }, tags, events, plans: [], worklog: [],
    injections: [], injectionConfig: {}, projectInjectionConfigs: {},
    descendants: [], migrations: {},
  } as unknown as DevLogData;
}

describe("path handling", () => {
  const d = data([tag("built", "شيء ما")]);

  test("the header path is project-relative, not the absolute one", () => {
    expect(buildFileWhy(d, PROJ, F).file).toBe("src/core.ts");
  });

  test("a relative query finds the same file as an absolute one", () => {
    expect(buildFileWhy(d, PROJ, "src/core.ts").work).toHaveLength(1);
    expect(buildFileWhy(d, PROJ, F).work).toHaveLength(1);
  });

  test("backslashes and case differences still match", () => {
    expect(buildFileWhy(d, PROJ, "D:\\proj\\SRC\\Core.ts").work).toHaveLength(1);
  });

  test("a noise path answers empty without scanning", () => {
    const noisy = data([tag("built", "x", { files: [`${ROOT}/node_modules/pkg/index.js`] })]);
    expect(buildFileWhy(noisy, PROJ, `${ROOT}/node_modules/pkg/index.js`).empty).toBe(true);
  });
});

describe("a file with no history still answers", () => {
  test("empty is flagged and the caller's purpose survives", () => {
    const w = buildFileWhy(data([]), PROJ, F, "نقطة الدخول");
    expect(w.empty).toBe(true);
    expect(w.purpose).toBe("نقطة الدخول");
    expect(w.file).toBe("src/core.ts");
    expect(w.reports).toEqual([]);
  });

  test("tags that touched OTHER files do not leak in", () => {
    const other = data([tag("decision", "قرار", { files: [`${ROOT}/src/other.ts`] })]);
    expect(buildFileWhy(other, PROJ, F).empty).toBe(true);
  });
});

describe("caps report their remainder — never a silent cut", () => {
  test("decisions cap at 8 and count the rest", () => {
    const tags = Array.from({ length: 11 }, (_, i) => tag("decision", `قرار ${i}`));
    const w = buildFileWhy(data(tags), PROJ, F);
    expect(w.decisions).toHaveLength(8);
    expect(w.decisionsMore).toBe(3);
  });

  test("work caps at 5 and counts the rest", () => {
    const tags = Array.from({ length: 7 }, (_, i) => tag("built", `عمل ${i}`));
    const w = buildFileWhy(data(tags), PROJ, F);
    expect(w.work).toHaveLength(5);
    expect(w.workMore).toBe(2);
  });

  test("reports cap at 12 and count the rest", () => {
    const tags = Array.from({ length: 15 }, (_, i) => tag("bug found", `خطأ ${i}`, { num: i + 1 }));
    const w = buildFileWhy(data(tags), PROJ, F);
    expect(w.reports).toHaveLength(12);
    expect(w.reportsMore).toBe(3);
  });

  test("an over-long line is clipped at a word boundary with an ellipsis", () => {
    const long = `${"كلمة ".repeat(80)}النهاية`;
    const [w] = buildFileWhy(data([tag("built", long)]), PROJ, F).work;
    expect(w.text.length).toBeLessThanOrEqual(121);
    expect(w.text.endsWith("…")).toBe(true);
    expect(w.text).not.toContain("\n");
  });
});

describe("a report carries how it ended", () => {
  const opened = "2026-06-01T00:00:00Z";
  const closed = "2026-06-11T00:00:00Z";

  test("open reports read as open, with no span", () => {
    const [r] = buildFileWhy(data([tag("bug found", "ما زال مفتوحًا", { num: 5 })]), PROJ, F).reports;
    expect(r.open).toBe(true);
    expect(r.closedAt).toBeUndefined();
    expect(r.spanDays).toBeUndefined();
  });

  test("a closed report carries its dates and the days it stayed open", () => {
    const d = data([
      tag("bug found", "كسر", { num: 5, timestamp: opened }),
      tag("bug fix", "#5 السبب كان كذا", { timestamp: closed }),
    ]);
    const [r] = buildFileWhy(d, PROJ, F).reports;
    expect(r.open).toBe(false);
    expect(r.openedAt).toBe("2026-06-01");
    expect(r.closedAt).toBe("2026-06-11");
    expect(r.spanDays).toBe(10);
  });

  test("the closer's surrounding prose surfaces as the fix's reasoning", () => {
    const d = data([
      tag("bug found", "كسر", { num: 5, timestamp: opened }),
      // `context` on the CLOSER is what the store keeps as the fix's reasoning.
      tag("bug fix", "#5", { timestamp: closed, context: "أُصلح بتغيير الترتيب" }),
    ]);
    const [r] = buildFileWhy(d, PROJ, F).reports;
    expect(r.fixContext).toBe("أُصلح بتغيير الترتيب");
  });

  test("a report that was later re-opened is marked — the fix did not hold", () => {
    const d = data([
      tag("bug found", "كسر", { num: 5, timestamp: opened }),
      tag("bug fix", "#5", { timestamp: closed }),
      tag("bug found", "كسر ثانية", { num: 9, timestamp: "2026-07-01T00:00:00Z", relatedTo: 5 } as Partial<TagEntry>),
    ]);
    const byNum = Object.fromEntries(buildFileWhy(d, PROJ, F).reports.map(r => [r.num, r]));
    expect(byNum[5].reopened).toBe(true);
    expect(byNum[9].reopened).toBe(false);
  });

  test("security reports of every flavour count as reports", () => {
    const d = data([
      tag("security", "ثغرة", { num: 1 }),
      tag("security:own", "ثغرتنا", { num: 2 }),
      tag("security:dep", "ثغرة تبعية", { num: 3 }),
    ]);
    expect(buildFileWhy(d, PROJ, F).reports.map(r => r.num)).toEqual([1, 2, 3]);
  });

  test("reports read oldest-first — a file's history, not a feed", () => {
    const d = data([
      tag("bug found", "أول", { num: 1, timestamp: "2026-01-01T00:00:00Z" }),
      tag("bug found", "ثانٍ", { num: 2, timestamp: "2026-05-01T00:00:00Z" }),
    ]);
    expect(buildFileWhy(d, PROJ, F).reports.map(r => r.num)).toEqual([1, 2]);
  });
});

describe("sections stay in their lanes", () => {
  test("each tag kind lands in exactly one section", () => {
    const d = data([
      tag("decision", "قرار"), tag("insight", "جذر"),
      tag("built", "بناء"), tag("refactor", "هيكلة"), tag("update", "رفع"),
      tag("bug found", "خطأ", { num: 1 }),
      tag("note", "ملاحظة"), tag("todo", "مهمة", { num: 2 }),
    ]);
    const w = buildFileWhy(d, PROJ, F);
    expect(w.decisions.map(x => x.tag).sort()).toEqual(["decision", "insight"]);
    expect(w.work.map(x => x.tag).sort()).toEqual(["built", "refactor", "update"]);
    expect(w.reports.map(x => x.kind)).toEqual(["bug found"]);
  });

  test("the newest recorded change to the file is reported", () => {
    const d = data([tag("built", "x")], [
      { id: "e1", project: PROJ, type: "change", file_path: F, timestamp: "2026-06-01T10:00:00Z" },
      { id: "e2", project: PROJ, type: "change", file_path: F, timestamp: "2026-06-09T10:00:00Z" },
    ] as unknown as DevLogData["events"]);
    expect(buildFileWhy(d, PROJ, F).lastChange).toBe("2026-06-09T10:00:00Z");
  });
});

// The endpoint (plan P2). Exercised through the route table in-process — the
// dossier itself is covered above, so what matters here is the HTTP contract:
// required params, unknown project, and the ONE untrusted surface (the header
// read) refusing to walk out of the project root.
describe("GET /api/file-why", () => {
  // Seeded into the ISOLATED test store, never read from the developer's real
  // one — the same reason bunfig forces DEVLOG_DATA_DIR for the whole suite.
  const EP = "file-why-endpoint-proj";
  let root = "";
  let outsideFile = "";

  beforeAll(async () => {
    const { withData } = await import("../src/data");
    root = mkdtempSync(join(tmpdir(), "fw-root-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "core.ts"), "// Core module: does the one thing.\nexport const x = 1;\n");
    // A readable file OUTSIDE the project, to prove traversal is refused
    // against a target that genuinely exists.
    outsideFile = join(mkdtempSync(join(tmpdir(), "fw-outside-")), "secret.ts");
    writeFileSync(outsideFile, "// Secret purpose line that must never be read.\n");
    await withData(async (d) => {
      d.projects[EP] = { name: EP, path: normalizeSlashes(root), files: {}, directories: [], totalFiles: 0 } as unknown as ProjectProfile;
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(outsideFile, ".."), { recursive: true, force: true });
  });

  // makeChangesRoutes is declared Record<string, unknown> (the route table is
  // spread into Bun.serve, which types it there) — narrow it to the one handler
  // shape this test drives.
  type Handler = { GET: (req: Request) => Promise<Response> };
  const call = async (qs: string) => {
    const { makeChangesRoutes } = await import("../src/routes-changes");
    const h = (makeChangesRoutes()["/api/file-why"] as Handler).GET;
    const res = await h(new Request(`http://x/api/file-why?${qs}`));
    return { status: res.status, body: await res.json() as Partial<FileWhy> & { error?: string } };
  };

  test("both params are required", async () => {
    expect((await call(`project=${EP}`)).status).toBe(400);
    expect((await call("file=src/core.ts")).status).toBe(400);
  });

  test("an unknown project is a 404, not an empty dossier", async () => {
    expect((await call("project=no-such-project-xyz&file=src/a.ts")).status).toBe(404);
  });

  test("the purpose is read from the file's own header", async () => {
    const r = await call(`project=${EP}&file=src/core.ts`);
    expect(r.status).toBe(200);
    expect(r.body.file).toBe("src/core.ts");
    expect(r.body.purpose).toContain("Core module");
  });

  test("a path outside the project root never has its header read", async () => {
    // The dossier still answers (it comes from the store); only the file read
    // is refused. A traversal must not turn this endpoint into a file reader —
    // and the target here EXISTS and is readable, so the refusal is the guard's.
    const r = await call(`project=${EP}&file=${encodeURIComponent(outsideFile)}`);
    expect(r.status).toBe(200);
    expect(r.body.purpose).toBeUndefined();
  });

  test("a file with no record answers empty rather than failing", async () => {
    const r = await call(`project=${EP}&file=src/definitely-not-here.ts`);
    expect(r.status).toBe(200);
    expect(r.body.empty).toBe(true);
  });
});

// P4 — the whisper points at the dossier, but only when there IS more to get.
// Position memory is auto-injected on the first read of every file in a
// session, so an unconditional hint would be a line of tokens per file open.
describe("position memory hints at ask:why — conditionally", () => {
  const story = (tags: string[]) =>
    data(tags.map(t => tag(t, `نص ${t}`, { num: undefined })));
  const HINT = "ask:why";

  test("a short, report-free history gets no hint", async () => {
    const { formatFileStoryContext } = await import("../src/file-story");
    expect(formatFileStoryContext(story(["built", "built"]), PROJ, F)).not.toContain(HINT);
  });

  test("history deeper than the three shown lines earns the hint", async () => {
    const { formatFileStoryContext } = await import("../src/file-story");
    expect(formatFileStoryContext(story(["built", "built", "built", "built"]), PROJ, F)).toContain(HINT);
  });

  test("a report earns it even when the history is short — its fix lives only in the dossier", async () => {
    const { formatFileStoryContext } = await import("../src/file-story");
    expect(formatFileStoryContext(story(["built", "bug found"]), PROJ, F)).toContain(HINT);
    expect(formatFileStoryContext(story(["security:own"]), PROJ, F)).toContain(HINT);
  });

  test("a file with no history injects nothing at all, hint included", async () => {
    const { formatFileStoryContext } = await import("../src/file-story");
    expect(formatFileStoryContext(data([]), PROJ, F)).toBe("");
  });
});
