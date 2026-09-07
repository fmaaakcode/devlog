// #1052 — deleting a project must release its fs.watch handles and cancel any
// pending debounced rescan, or the project comes back within the 5-minute
// sweep as a bare profile (a manifest touch, or a scan already in flight).
// The route takes the watcher helpers as injected deps, so the contract is
// assertable with spies and no live watchers; rescanVerdict (the pure check the
// timer body applies) is pinned alongside.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withData } from "../src/data";
import { makeProjectRoutes } from "../src/routes-projects";
import { rescanVerdict } from "../src/scanner";
import type { ProjectProfile } from "../src/types";

const NAME = "delete-frees-watchers-1052";
let folder: string;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "devlog-del1052-"));
  await withData(async (data) => {
    data.projects[NAME] = {
      name: NAME, path: folder, description: "", blueprint: [], language: "TypeScript", framework: "",
      libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-09-01T00:00:00.000Z",
    } as ProjectProfile;
  });
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("DELETE /api/project/:name (#1052)", () => {
  test("releases the watchers under the folder and cancels its pending rescan before purging", async () => {
    const released: string[] = [];
    const cancelled: string[] = [];
    const routes = makeProjectRoutes({
      releaseWatchersUnder: (p) => { released.push(p); },
      cancelRescan: (p) => { cancelled.push(p); },
      refreshWatchers: async () => { /* not exercised by DELETE */ },
      renameWithRetry: async () => { /* not exercised by DELETE */ },
    }) as Record<string, { DELETE: (req: Request & { params: { name: string } }) => Promise<Response> }>;
    const req = Object.assign(new Request(`http://127.0.0.1/api/project/${NAME}`, { method: "DELETE" }), { params: { name: NAME } });
    const r = await routes["/api/project/:name"].DELETE(req);
    expect(r.status).toBe(200);
    expect(released).toEqual([folder]);
    expect(cancelled).toEqual([folder]);
    const gone = await withData(async (d) => d.projects[NAME] === undefined);
    expect(gone).toBe(true);
  });

  test("an unknown project touches no watcher", async () => {
    const released: string[] = [];
    const routes = makeProjectRoutes({
      releaseWatchersUnder: (p) => { released.push(p); },
      cancelRescan: (p) => { released.push(p); },
      refreshWatchers: async () => { /* not exercised by DELETE */ },
      renameWithRetry: async () => { /* not exercised by DELETE */ },
    }) as Record<string, { DELETE: (req: Request & { params: { name: string } }) => Promise<Response> }>;
    const req = Object.assign(new Request("http://127.0.0.1/api/project/nope", { method: "DELETE" }), { params: { name: "nope" } });
    expect((await routes["/api/project/:name"].DELETE(req)).status).toBe(404);
    expect(released).toEqual([]);
  });
});

describe("rescanVerdict — the timer body's gate (#1052)", () => {
  const prof = (path: string) => ({ name: "x", path } as ProjectProfile);
  test("a project deleted between the watcher event and the timer is 'missing', never rescanned", () => {
    expect(rescanVerdict(undefined, "D:/x")).toBe("missing");
  });
  test("a name that moved to another folder is a collision; the same folder is ok", () => {
    expect(rescanVerdict(prof("E:/other"), "D:/x")).toBe("collision");
    expect(rescanVerdict(prof("d:\\x"), "D:/x")).toBe("ok");
  });
});
