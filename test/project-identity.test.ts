// Project identity marker (src/project-identity.ts): moved, copied and
// same-named folders are told apart by the random id in .devlog/project.json,
// never by name or path. Resolver rules run on an injected probe; the marker
// writers and the relocation run against real temp folders.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectFor, type IdentityProbe, type GitRootFn } from "../src/project-resolve";
import {
  readMarkerId, writeMarker, ensureProjectIdentity, applyRelocation, sameFolder, ownsLegacyIndex,
} from "../src/project-identity";
import type { DevLogData, ProjectProfile } from "../src/types";

const noGit: GitRootFn = () => null;
const noMarkers = () => false;
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_X = "99999999-9999-4999-8999-999999999999";

function proj(name: string, path: string, id?: string): ProjectProfile {
  return { name, path, ...(id ? { id } : {}) } as ProjectProfile;
}

// Probe over a fake disk: `live` paths exist, `markers` maps dir → id.
function probe(opts: { live?: string[]; markers?: Record<string, string>; same?: [string, string][]; legacy?: string[] }): IdentityProbe {
  return {
    readId: d => opts.markers?.[d] ?? null,
    exists: p => (opts.live ?? []).includes(p),
    sameFolder: (a, b) => (opts.same ?? []).some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
    ownsLegacy: (_n, dir) => (opts.legacy ?? []).includes(dir),
  };
}
const resolve = (projects: Record<string, ProjectProfile>, cwd: string, p: IdentityProbe) =>
  resolveProjectFor({ projects }, cwd, noGit, noMarkers, p);

describe("resolver — identity marker", () => {
  test("move: the id's owner path is gone → same project, relocatedFrom set", () => {
    const r = resolve({ app: proj("app", "C:/old/app", ID_A) }, "B:/new/app",
      probe({ live: ["B:/new/app"], markers: { "B:/new/app": ID_A } }));
    expect(r).toEqual({ name: "app", cwd: "B:/new/app", registered: true, relocatedFrom: "C:/old/app" });
  });

  test("move works under a different folder name too (the id, not the name, decides)", () => {
    const r = resolve({ app: proj("app", "C:/old/app", ID_A) }, "D:/renamed",
      probe({ markers: { "D:/renamed": ID_A } }));
    expect(r.name).toBe("app");
    expect(r.relocatedFrom).toBe("C:/old/app");
  });

  test("copy: the owner still lives at its own path → a new project, never the original", () => {
    const r = resolve({ app: proj("app", "D:/app", ID_A) }, "E:/app",
      probe({ live: ["D:/app", "E:/app"], markers: { "D:/app": ID_A, "E:/app": ID_A } }));
    expect(r).toEqual({ name: "app-2", cwd: "E:/app", registered: false });
  });

  test("alias: the same directory under another spelling resolves to the registered project", () => {
    const r = resolve({ app: proj("app", "D:/app", ID_A) }, "X:/app",
      probe({ live: ["D:/app", "X:/app"], markers: { "X:/app": ID_A }, same: [["D:/app", "X:/app"]] }));
    expect(r).toEqual({ name: "app", cwd: "D:/app", registered: true });
  });

  test("a foreign id (repo from another machine) never claims a local project", () => {
    const r = resolve({ app: proj("app", "C:/gone/app", ID_A) }, "D:/clone/app",
      probe({ live: ["D:/clone/app"], markers: { "D:/clone/app": ID_X } }));
    expect(r.relocatedFrom).toBeUndefined();
    expect(r.registered).toBe(false);
  });
});

describe("resolver — same-named folder without a marker", () => {
  test("registered namesake still lives → <name>-2, then -3", () => {
    const live = probe({ live: ["D:/app", "E:/app", "F:/app"] });
    expect(resolve({ app: proj("app", "D:/app") }, "E:/app", live).name).toBe("app-2");
    expect(resolve({ app: proj("app", "D:/app"), "app-2": proj("app-2", "E:/app") }, "F:/app", live).name).toBe("app-3");
  });

  test("once registered, the minted name is an exact match", () => {
    const r = resolve({ app: proj("app", "D:/app"), "app-2": proj("app-2", "E:/app") }, "E:/app", probe({ live: ["D:/app", "E:/app"] }));
    expect(r).toEqual({ name: "app-2", cwd: "E:/app", registered: true });
  });

  test("a subfolder named like its project stays the project's (no phantom -2, #529/#691)", () => {
    const r = resolve({ app: proj("app", "D:/app") }, "D:/app/app", probe({ live: ["D:/app", "D:/app/app"] }));
    expect(r).toEqual({ name: "app", cwd: "D:/app", registered: true });
  });

  test("registered folder gone + DevLog's own index in the new folder → legacy move", () => {
    const r = resolve({ app: proj("app", "C:/old/app") }, "B:/app", probe({ live: ["B:/app"], legacy: ["B:/app"] }));
    expect(r.relocatedFrom).toBe("C:/old/app");
    expect(r.name).toBe("app");
  });

  test("registered folder gone, no evidence → unchanged basename fallback (git relocation may still claim it)", () => {
    const r = resolve({ app: proj("app", "C:/old/app") }, "B:/app", probe({ live: ["B:/app"] }));
    expect(r).toEqual({ name: "app", cwd: "B:/app", registered: false });
  });
});

describe("marker on disk", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "devlog-identity-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("ensureProjectIdentity mints an id, writes the marker and a .devlog/.gitignore for it", () => {
    const dir = join(root, "app"); mkdirSync(dir);
    const data = { projects: { app: proj("app", dir) } };
    ensureProjectIdentity(data, "app");
    const id = data.projects.app.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readMarkerId(dir)).toBe(id);
    expect(readFileSync(join(dir, ".devlog", ".gitignore"), "utf8")).toContain("project.json");
  });

  test("an existing .devlog/.gitignore is appended to, never replaced", () => {
    const dir = join(root, "app"); mkdirSync(join(dir, ".devlog"), { recursive: true });
    writeFileSync(join(dir, ".devlog", ".gitignore"), "cache/");
    writeMarker(dir, ID_A);
    expect(readFileSync(join(dir, ".devlog", ".gitignore"), "utf8")).toBe("cache/\nproject.json\n");
    writeMarker(dir, ID_A);   // idempotent
    expect(readFileSync(join(dir, ".devlog", ".gitignore"), "utf8")).toBe("cache/\nproject.json\n");
  });

  test("an unclaimed on-disk id is adopted (registry rebuilt); a claimed one is replaced (copy)", () => {
    const a = join(root, "a"); const b = join(root, "b"); mkdirSync(a); mkdirSync(b);
    writeMarker(a, ID_A); writeMarker(b, ID_A);
    const data = { projects: { a: proj("a", a) } as Record<string, ProjectProfile> };
    ensureProjectIdentity(data, "a");
    expect(data.projects.a.id).toBe(ID_A);
    data.projects.b = proj("b", b);
    ensureProjectIdentity(data, "b");
    expect(data.projects.b.id).not.toBe(ID_A);
    expect(readMarkerId(b)).toBe(data.projects.b.id as string);
    expect(readMarkerId(a)).toBe(ID_A);   // the original is untouched
  });

  test("never creates a missing project folder", () => {
    const ghost = join(root, "ghost");
    expect(writeMarker(ghost, ID_A)).toBe(false);
    ensureProjectIdentity({ projects: { g: proj("g", ghost) } }, "g");
    expect(existsSync(ghost)).toBe(false);
  });

  test("malformed marker reads as no marker", () => {
    const dir = join(root, "app"); mkdirSync(join(dir, ".devlog"), { recursive: true });
    writeFileSync(join(dir, ".devlog", "project.json"), '{"id":"app"}');
    expect(readMarkerId(dir)).toBeNull();
  });

  test("sameFolder: one directory under two spellings yes, two directories no", () => {
    const a = join(root, "a"); const b = join(root, "b"); mkdirSync(a); mkdirSync(b);
    expect(sameFolder(a, `${a}/`)).toBe(true);
    expect(sameFolder(a, b)).toBe(false);
    expect(sameFolder(a, join(root, "missing"))).toBe(false);
  });

  test("ownsLegacyIndex matches only this registry's tag ids for that project", () => {
    const dir = join(root, "app"); mkdirSync(join(dir, ".devlog"), { recursive: true });
    writeFileSync(join(dir, ".devlog", ".changelog-index.json"), JSON.stringify({ ids: ["t1", "t2"] }));
    expect(ownsLegacyIndex("app", dir, [{ id: "t2", project: "app" }])).toBe(true);
    expect(ownsLegacyIndex("app", dir, [{ id: "t2", project: "other" }])).toBe(false);
    expect(ownsLegacyIndex("app", dir, [{ id: "zz", project: "app" }])).toBe(false);
  });

  test("applyRelocation moves the path and nested projects; a raced path is left alone", async () => {
    const data = { projects: {
      app: { ...proj("app", "C:\\old\\app", ID_A), disconnectedSince: "2026-01-01" },
      sub: proj("sub", "C:\\old\\app\\sub"),
    } } as unknown as DevLogData;
    expect(await applyRelocation(data, { name: "app", cwd: "B:\\new\\app", relocatedFrom: "C:\\old\\app" })).toBe(true);
    expect(data.projects.app.path).toBe("B:\\new\\app");
    expect(data.projects.app.disconnectedSince).toBeUndefined();
    expect(data.projects.sub.path).toBe("B:\\new\\app\\sub");
    expect(await applyRelocation(data, { name: "app", cwd: "Z:\\x", relocatedFrom: "C:\\old\\app" })).toBe(false);
    expect(await applyRelocation(data, { name: "app", cwd: "Z:\\x" })).toBe(false);
  });
});
