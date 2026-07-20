// The deps explainer (#663) — pure logic: `-(lib) name — غرض` parsing, the
// latest-wins purpose merge, and the /api/deps payload assembly (coverage
// counters, uncovered-first order, description/vuln enrichment).

import { describe, test, expect } from "bun:test";
import { parseLibTag, depPurposes, buildDepsPayload } from "../src/deps-explain";
import type { DevLogData } from "../src/types";

const tag = (project: string, t: string, content: string, ts: string) =>
  ({ id: `${ts}-${content}`, project, tag: t, content, timestamp: ts });

function makeData(overrides: Partial<{ tags: unknown[]; projects: Record<string, unknown> }> = {}): DevLogData {
  return {
    tags: overrides.tags ?? [],
    projects: overrides.projects ?? {},
  } as unknown as DevLogData;
}

describe("parseLibTag — `-(lib) name — غرض`", () => {
  test.each([
    ["zod — التحقق من مخططات الإدخال", "zod", "التحقق من مخططات الإدخال"],
    ["zod - dash separator", "zod", "dash separator"],
    ["@scope/pkg — scoped npm name", "@scope/pkg", "scoped npm name"],
    ["serde  purpose with no separator", "serde", "purpose with no separator"],
  ])("parses %p", (content, name, purpose) => {
    expect(parseLibTag(content)).toEqual({ name, purpose });
  });

  test.each([
    ["zod", "name alone — nothing to record"],
    ["zod —", "separator but empty purpose"],
    ["", "empty content"],
  ])("rejects %p (%s)", (content) => {
    expect(parseLibTag(content)).toBeNull();
  });
});

describe("depPurposes — latest per name wins", () => {
  test("a re-emitted name replaces the purpose; case-variant re-emit replaces too", () => {
    const data = makeData({
      tags: [
        tag("p", "lib", "zod — الغرض القديم", "2026-07-01T00:00:00Z"),
        tag("p", "lib", "hono — راوتر HTTP", "2026-07-02T00:00:00Z"),
        tag("p", "lib", "Zod — الغرض الجديد", "2026-07-03T00:00:00Z"),
        tag("other", "lib", "zod — من مشروع آخر", "2026-07-04T00:00:00Z"),
      ],
    });
    const m = depPurposes(data, "p");
    expect(m.size).toBe(2);
    expect(m.get("zod")?.purpose).toBe("الغرض الجديد");
    expect(m.get("hono")?.purpose).toBe("راوتر HTTP");
  });

  test("malformed lib tags are skipped", () => {
    const data = makeData({ tags: [tag("p", "lib", "loneword", "2026-07-01T00:00:00Z")] });
    expect(depPurposes(data, "p").size).toBe(0);
  });
});

describe("buildDepsPayload — the /api/deps shape", () => {
  const project = {
    name: "p", path: "/x",
    libraries: [
      { name: "zod", version: "3.23.8", eco: "npm" },
      { name: "hono", version: "4.4.0", eco: "npm" },
      { name: "typescript", version: "5.4.0", dev: true, eco: "npm" },
    ],
    vulnResults: {
      zod: { status: "safe", icon: "check", message: "", vulns: 0, isLatest: false, latestVersion: "3.24.0", description: "TypeScript-first schema validation" },
      hono: { status: "danger", icon: "x", message: "1 vuln", vulns: 1, severity: "high", detailsUrl: "https://osv.dev/x" },
    },
  };

  test("merges purpose + description + vuln status; uncovered sort first; coverage counted", () => {
    const data = makeData({
      projects: { p: project },
      tags: [tag("p", "lib", "zod — التحقق من الحمولات", "2026-07-01T00:00:00Z")],
    });
    const payload = buildDepsPayload(data, "p");
    expect(payload).not.toBeNull();
    expect(payload?.total).toBe(3);
    expect(payload?.withPurpose).toBe(1);
    // Uncovered first (alphabetical inside each group): hono, typescript, then zod.
    expect(payload?.libraries.map(l => l.name)).toEqual(["hono", "typescript", "zod"]);
    const zod = payload?.libraries.find(l => l.name === "zod");
    expect(zod?.purpose).toBe("التحقق من الحمولات");
    expect(zod?.description).toBe("TypeScript-first schema validation");
    expect(zod?.isLatest).toBe(false);
    expect(zod?.latestVersion).toBe("3.24.0");
    expect(zod?.vulns).toBeUndefined();  // zero vulns → field absent
    const hono = payload?.libraries.find(l => l.name === "hono");
    expect(hono?.vulns).toBe(1);
    expect(hono?.severity).toBe("high");
    expect(hono?.detailsUrl).toBe("https://osv.dev/x");
    const ts = payload?.libraries.find(l => l.name === "typescript");
    expect(ts?.dev).toBe(true);
    expect(ts?.description).toBeUndefined();
  });

  test("unknown project → null; project with no libraries → empty payload", () => {
    expect(buildDepsPayload(makeData(), "ghost")).toBeNull();
    const data = makeData({ projects: { p: { ...project, libraries: [] } } });
    expect(buildDepsPayload(data, "p")).toEqual({ project: "p", total: 0, withPurpose: 0, libraries: [] });
  });
});
