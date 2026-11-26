// #1342 / #1344 — `-(ask:about)`: the stored description, the scanner's facts,
// and the drift checks. The fixtures replay what the D:\kb scenario found: a
// description 20 releases old naming a replaced MCP package, purposes kept for
// libraries removed since, and a finished experiment's folder mixed into the
// library list.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAboutPayload, missingLibMentions } from "../src/project-about";
import { buildDepsPayload } from "../src/deps-explain";
import { PROJECT_ASK_ROWS } from "../src/hook-ask-project";
import { detectPackages } from "../src/scanner";
import type { AskCtx } from "../src/hook-asks";
import type { DevLogData, ProjectProfile, TagEntry } from "../src/types";

let seq = 0;
const tag = (t: string, content: string, timestamp: string): TagEntry =>
  ({ id: `t${++seq}`, project: "kb", tag: t, content, timestamp } as unknown as TagEntry);

const profile = (over: Partial<ProjectProfile> = {}): ProjectProfile => ({
  name: "kb", path: "D:/kb", description: "قاعدة معرفة ذاتية البناء", blueprint: [],
  language: "TypeScript", framework: "Hono 4.13.19", files: {}, totalFiles: 751, lastScan: "2026-11-26T00:00:00Z",
  directories: ["kb", "slice"],
  about: "خادم MCP عبر @modelcontextprotocol/sdk وأداة adm-zip، وhono للـHTTP.",
  libraries: [
    { name: "hono", version: "4.13.19", dir: "kb" },
    { name: "@modelcontextprotocol/server", version: "2.4.0", dir: "kb" },
    { name: "@types/bun", version: "latest", dev: true, dir: "kb" },
    { name: "@mozilla/readability", version: "0.6.0", dir: "slice" },
  ],
  ...over,
} as ProjectProfile);

const data = (p: ProjectProfile, tags: TagEntry[]): DevLogData =>
  ({ projects: { kb: p }, tags, events: [], plans: [], worklog: [] } as unknown as DevLogData);

const releases = (n: number, from: string) =>
  Array.from({ length: n }, (_, i) => tag("release", `v0.${i}.0`, new Date(+new Date(from) + (i + 1) * 86400000).toISOString()));

const ctx = { L: (_en: string, ar: string) => ar } as unknown as AskCtx;
const row = (key: string) => {
  const r = PROJECT_ASK_ROWS.find(x => x.key === key);
  if (!r?.format) throw new Error(`no row ${key}`);
  return r.format;
};

describe("missingLibMentions — narrow on purpose, never crying wolf", () => {
  const known = new Set(["hono", "@modelcontextprotocol/server"]);

  test("a scoped name the manifest lacks is flagged", () => {
    expect(missingLibMentions("عبر @modelcontextprotocol/sdk.", known, [])).toEqual(["@modelcontextprotocol/sdk"]);
  });

  test("a scoped name the manifest HAS is not", () => {
    expect(missingLibMentions("عبر @modelcontextprotocol/server", known, [])).toEqual([]);
  });

  test("a plain word is flagged only when its -(lib) purpose outlived the library", () => {
    expect(missingLibMentions("يستخدم adm-zip وsharp", known, ["adm-zip"])).toEqual(["adm-zip"]);
    expect(missingLibMentions("Bun وTypeScript وhono", known, [])).toEqual([]);
  });

  test("a removed name inside a longer identifier is not a mention", () => {
    expect(missingLibMentions("يستخدم sharp-cli فقط", known, ["sharp"])).toEqual([]);
  });
});

describe("buildAboutPayload", () => {
  const removedPurposes = [tag("lib", "adm-zip — مفروضة في overrides", "2026-08-01T00:00:00Z")];

  test("counts releases since the description was written (file mtime wins)", () => {
    const d = data(profile(), [...releases(20, "2026-09-12T00:00:00Z"), ...removedPurposes]);
    expect(buildAboutPayload(d, "kb", "2026-09-12T00:00:00Z")?.drift.releasesSince).toBe(20);
    expect(buildAboutPayload(d, "kb", "2026-11-30T00:00:00Z")?.drift.releasesSince).toBe(0);
  });

  test("without a file, the last -(about) tag dates the text", () => {
    const d = data(profile(), [tag("about", "x", "2026-10-01T00:00:00Z"), ...releases(3, "2026-10-01T00:00:00Z")]);
    const p = buildAboutPayload(d, "kb");
    expect(p?.aboutAt).toBe("2026-10-01T00:00:00Z");
    expect(p?.drift.releasesSince).toBe(3);
  });

  test("drift names the replaced package and the stale purpose", () => {
    const p = buildAboutPayload(data(profile(), removedPurposes), "kb");
    expect(p?.drift.missingLibs).toEqual(["@modelcontextprotocol/sdk", "adm-zip"]);
    expect(p?.drift.stalePurposes).toEqual(["adm-zip"]);
  });

  test("facts: counts, runtime and the manifest folders", () => {
    const p = buildAboutPayload(data(profile({ runtime: { name: "Bun", version: "1.4.5" } as ProjectProfile["runtime"] }), []), "kb");
    expect(p?.facts.libraries).toEqual({ runtime: 3, dev: 1, forced: 0 });
    expect(p?.facts.runtime).toBe("Bun 1.4.5");
    expect(p?.facts.dirs).toEqual(["kb", "slice"]);
  });

  test("an unknown project is null", () => {
    expect(buildAboutPayload(data(profile(), []), "nope")).toBeNull();
  });
});

describe("ask:about answer", () => {
  test("serves the text, the scan's facts and every drift warning", () => {
    const d = data(profile(), [...releases(20, "2026-09-12T00:00:00Z"), tag("lib", "adm-zip — x", "2026-08-01T00:00:00Z")]);
    const out = row("ask:about")(buildAboutPayload(d, "kb", "2026-09-12T00:00:00Z"), [] as unknown as RegExpMatchArray, ctx);
    expect(out).toContain("@modelcontextprotocol/sdk وأداة adm-zip");   // the text itself
    expect(out).toContain("كُتب 2026-09-12");
    expect(out).toContain("ما يراه الفحص");
    expect(out).toContain("مانيفستات في: kb · slice");
    expect(out).toContain("الوصف أقدم من 20 إصدارًا");
    expect(out).toContain("لم تعد في المانيفست: @modelcontextprotocol/sdk، adm-zip");
    expect(out).toContain("-(ask:map)");
  });

  test("a fresh, accurate description raises no drift block", () => {
    const p = profile({ about: "خادم بـhono", libraries: [{ name: "hono", version: "4" }] });
    const out = row("ask:about")(buildAboutPayload(data(p, []), "kb", "2026-11-26T00:00:00Z"), [] as unknown as RegExpMatchArray, ctx);
    expect(out).not.toContain("انجراف");
  });

  test("no description says how to write one", () => {
    const out = row("ask:about")(buildAboutPayload(data(profile({ about: undefined }), []), "kb"), [] as unknown as RegExpMatchArray, ctx);
    expect(out).toContain(".devlog/ABOUT.md");
  });
});

describe("ask:deps groups by manifest folder", () => {
  test("two folders → one block each, the experiment's library under its own folder", () => {
    const out = row("ask:deps")(buildDepsPayload(data(profile(), []), "kb"), [] as unknown as RegExpMatchArray, ctx);
    const kbAt = out.indexOf("[مجلد kb/]");
    const sliceAt = out.indexOf("[مجلد slice/]");
    expect(kbAt).toBeGreaterThan(-1);
    expect(sliceAt).toBeGreaterThan(kbAt);
    expect(out.indexOf("@mozilla/readability")).toBeGreaterThan(sliceAt);
  });

  test("one manifest → no folder headers (the ordinary project is unchanged)", () => {
    const p = profile({ libraries: [{ name: "hono", version: "4" }] });
    expect(buildDepsPayload(data(p, []), "kb")?.dirs).toBeUndefined();
    expect(row("ask:deps")(buildDepsPayload(data(p, []), "kb"), [] as unknown as RegExpMatchArray, ctx)).not.toContain("[مجلد");
  });

  test("a stale purpose leads with 'removed from the project?'", () => {
    const out = row("ask:deps")(buildDepsPayload(data(profile(), [tag("lib", "sharp — x", "2026-08-01T00:00:00Z")]), "kb"), [] as unknown as RegExpMatchArray, ctx);
    expect(out).toContain("أُزيلت من المشروع؟");
  });
});

describe("scanner stamps the manifest folder on nested libraries", () => {
  test("root without a manifest: each subfolder's libraries carry its name", async () => {
    const root = mkdtempSync(join(tmpdir(), "about-dirs-"));
    try {
      for (const [dir, deps] of [["kb", { hono: "4.0.0" }], ["slice", { "@mozilla/readability": "0.6.0" }]] as const) {
        mkdirSync(join(root, dir));
        writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir, dependencies: deps }));
      }
      const r = await detectPackages(root);
      const byName = Object.fromEntries(r.libraries.map(l => [l.name, l.dir]));
      expect(byName).toEqual({ hono: "kb", "@mozilla/readability": "slice" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("root manifest libraries carry no folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "about-root-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r", dependencies: { zod: "3.0.0" } }));
      const r = await detectPackages(root);
      expect(r.libraries[0]).not.toHaveProperty("dir");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
