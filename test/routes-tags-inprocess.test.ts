// In-process coverage of the /api/tags route group (+ the project-view read
// routes and the recent digest). The e2e suites drive these through a spawned
// daemon, which the coverage report cannot see — so when the wave-0 unit tests
// (#1054, #1052) first imported these modules in-process, they entered the
// report at ~10–20% and pulled src/ under its 80% floor although nothing had
// regressed. This file exercises the handlers the way the daemon does, against
// the isolated store the preload provides, and pins the wave-1 response
// contract along the way: the `rejections` field and the phantom-cwd 400.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadData, withData } from "../src/data";
import { makeTagsRoutes } from "../src/routes-tags";
import { makeProjectRoutes } from "../src/routes-projects";
import { buildRecent } from "../src/recent";
import type { ProjectProfile } from "../src/types";

type Handler = (req: Request & { params: Record<string, string> }) => Promise<Response>;
const routes = makeTagsRoutes() as Record<string, Record<string, Handler>>;
const projectRoutes = makeProjectRoutes({
  releaseWatchersUnder: () => { /* no watchers in-process */ },
  refreshWatchers: async () => { /* no watchers in-process */ },
  renameWithRetry: async () => { /* not exercised */ },
  cancelRescan: () => { /* no scheduler in-process */ },
}) as Record<string, Record<string, Handler>>;

let folder: string;
let project: string;
const SID = "inproc-session";

const req = (url: string, init: RequestInit = {}, params: Record<string, string> = {}) =>
  Object.assign(new Request(`http://127.0.0.1${url}`, init), { params });
const post = (url: string, body: unknown) =>
  req(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const postTags = async (entries: unknown[], extra: Record<string, unknown> = {}) => {
  const r = await routes["/api/tags"].POST(post("/api/tags", { cwd: folder, session_id: SID, entries, ...extra }));
  return { status: r.status, json: await r.json() as Record<string, unknown> };
};

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "devlog-inproc-tags-"));
  project = basename(folder);
  await withData(async (data) => {
    data.projects[project] = {
      name: project, path: folder, description: "", blueprint: [], language: "TypeScript", framework: "",
      libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-09-01T00:00:00.000Z",
    } as ProjectProfile;
    data.events.push({ id: "ev1", project, type: "change", file_path: join(folder, "a.ts"), session_id: SID, timestamp: new Date().toISOString() } as never);
    data.events.push({ id: "ev2", project, type: "command", command: "bun test", session_id: SID, timestamp: new Date().toISOString(), ok: false } as never);
  });
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("POST /api/tags — in-process contract", () => {
  test("stores openers with numbers and echoes a numbered closure", async () => {
    const a = await postTags([
      { tag: "bug found", content: "exporter drops the last row" },
      { tag: "built", content: "wired the exporter test" },
    ], { user_prompt: "fix the exporter" });
    expect(a.status).toBe(200);
    expect(a.json.count).toBe(2);
    const data = await loadData();
    const bug = data.tags.find(t => t.project === project && t.tag === "bug found");
    const bugNum = bug?.num ?? -1;
    expect(bugNum).toBeGreaterThan(0);
    expect((data.prompts || []).some(p => p.project === project && p.text === "fix the exporter")).toBe(true);

    const b = await postTags([{ tag: "bug fix", content: `#${bugNum} [شرط] off-by-one on the last index` }]);
    expect((b.json.closed as Array<{ num: number }>).map(c => c.num)).toEqual([bugNum]);
    expect(b.json.rejections).toEqual([]);
  });

  test("this batch's rejections ride the response (#1206 via the generic channel)", async () => {
    const r = await postTags([{ tag: "undo", content: "#987654" }]);
    expect(r.status).toBe(200);
    const rejections = r.json.rejections as Array<{ reason: string; detail: string }>;
    expect(rejections.map(x => x.reason)).toEqual(["undo-no-match"]);
    expect(rejections[0].detail).toContain("#987654");
  });

  test("a closure mismatch ships the open snapshot", async () => {
    const r = await postTags([{ tag: "done", content: "#424242" }]);
    expect((r.json.closureHints as unknown[]).length).toBe(1);
    expect(Array.isArray(r.json.openSnapshot)).toBe(true);
  });

  test("story and release ordering: a story stored after its closers records relatedNums", async () => {
    await postTags([{ tag: "todo", content: "write the release notes" }]);
    const data = await loadData();
    const todo = data.tags.find(t => t.project === project && t.tag === "todo");
    const todoNum = todo?.num ?? -1;
    const r = await postTags([
      { tag: "story", content: "the notes needed a second pass after the first draft missed the breaking change" },
      { tag: "done", content: `#${todoNum}` },
    ]);
    expect((r.json.closed as Array<{ num: number }>).map(c => c.num)).toEqual([todoNum]);
    const after = await loadData();
    const story = after.tags.find(t => t.project === project && t.tag === "story");
    expect(story?.relatedNums).toEqual([todoNum]);
  });

  test("batch replay is dropped wholesale by batch_id", async () => {
    const first = await postTags([{ tag: "note", content: "replayed note" }], { batch_id: "b-replay-1" });
    expect(first.json.batchReplay).toBeUndefined();
    const second = await postTags([{ tag: "note", content: "replayed note" }], { batch_id: "b-replay-1" });
    expect(second.json.batchReplay).toBe(true);
    expect(second.json.rejections).toEqual([]);
  });

  test("a phantom cwd is a definitive 400 and mints no project (#1199)", async () => {
    const ghost = join(tmpdir(), "devlog-inproc-ghost-never-exists");
    const r = await routes["/api/tags"].POST(post("/api/tags", { cwd: ghost, entries: [{ tag: "note", content: "x" }] }));
    expect(r.status).toBe(400);
    expect(Object.keys((await loadData()).projects)).not.toContain(basename(ghost));
  });

  test("shape errors are 400, the entries cap is 413, unparsable JSON is 400", async () => {
    expect((await routes["/api/tags"].POST(post("/api/tags", { cwd: folder, entries: "nope" }))).status).toBe(400);
    expect((await routes["/api/tags"].POST(post("/api/tags", { cwd: folder, entries: Array.from({ length: 501 }, () => ({ tag: "note", content: "x" })) }))).status).toBe(413);
    const bad = req("/api/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    expect((await routes["/api/tags"].POST(bad)).status).toBe(400);
  });
});

describe("the read/delete/classify siblings", () => {
  test("GET /api/tags/:project returns the project's tags newest-first", async () => {
    const r = await routes["/api/tags/:project"].GET(req(`/api/tags/${project}?limit=3`, {}, { project }));
    const { tags } = await r.json() as { tags: Array<{ timestamp: string }> };
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.length).toBeLessThanOrEqual(3);
  });

  test("GET /api/recall needs q and finds a stored tag", async () => {
    expect((await routes["/api/recall"].GET(req("/api/recall"))).status).toBe(400);
    const r = await routes["/api/recall"].GET(req(`/api/recall?q=${encodeURIComponent("exporter last row")}&cwd=${encodeURIComponent(folder)}`));
    const j = await r.json() as { results: unknown[]; scope: string };
    expect(j.scope).toBe("project");
    expect(j.results.length).toBeGreaterThan(0);
  });

  test("DELETE /api/tag/:id archives then removes; unknown id is 404", async () => {
    const data = await loadData();
    const note = data.tags.find(t => t.project === project && t.tag === "note");
    expect(note).toBeDefined();
    expect((await routes["/api/tag/:id"].DELETE(req(`/api/tag/${note?.id}`, { method: "DELETE" }, { id: note?.id as string }))).status).toBe(200);
    expect((await loadData()).tags.some(t => t.id === note?.id)).toBe(false);
    expect((await routes["/api/tag/:id"].DELETE(req("/api/tag/nope", { method: "DELETE" }, { id: "nope" }))).status).toBe(404);
    const months = await (await routes["/api/undone"].GET(req("/api/undone"))).json() as { months: string[] };
    expect(Array.isArray(months.months)).toBe(true);
    expect((await routes["/api/undone"].GET(req("/api/undone?month=bad"))).status).toBe(400);
  });

  test("POST /api/classify refuses an unknown type and annotates recent changes", async () => {
    expect((await routes["/api/classify"].POST(post("/api/classify", { cwd: folder, type: "bogus" }))).status).toBe(400);
    const r = await routes["/api/classify"].POST(post("/api/classify", { cwd: folder, type: "plan", note: "design pass", count: 1 }));
    const j = await r.json() as { ok: boolean; tagged: number };
    expect(j.ok).toBe(true);
    expect(j.tagged).toBe(1);
  });
});

describe("project read routes + recent digest, in-process", () => {
  test("GET /api/project-view/:name windows the feed and 404s an unknown name", async () => {
    const r = await projectRoutes["/api/project-view/:name"].GET(req(`/api/project-view/${project}?limit=2`, {}, { name: project }));
    const j = await r.json() as { tags: unknown[]; tagsTotal: number; profile: { name: string } };
    expect(j.profile.name).toBe(project);
    expect(j.tagsTotal).toBeGreaterThanOrEqual(j.tags.length);
    expect((await projectRoutes["/api/project-view/:name"].GET(req("/api/project-view/nope", {}, { name: "nope" }))).status).toBe(404);
  });

  test("GET /api/orphan-projects reports store-only names", async () => {
    const j = await (await projectRoutes["/api/orphan-projects"].GET(req("/api/orphan-projects"))).json() as { orphans: unknown[]; count: number };
    expect(j.count).toBe(j.orphans.length);
  });

  test("buildRecent summarizes the session's tags, files and failed commands", async () => {
    const data = await loadData();
    const digest = buildRecent(data, project, { sessions: 1 });
    expect(digest.project).toBe(project);
    expect(digest.sessions).toHaveLength(1);
    const s = digest.sessions[0];
    expect(s.sessionId).toBe(SID);
    expect(s.tags.length).toBeGreaterThan(0);
    expect(s.prompts).toContain("fix the exporter");
    expect(s.commands.total).toBe(1);
    expect(s.commands.failed).toBe(1);
    expect(buildRecent(data, project, { sessions: 1, excludeSession: SID }).sessions).toHaveLength(0);
    expect(buildRecent(data, project, { days: 1 }).window).toEqual({ days: 1 });
  });
});
