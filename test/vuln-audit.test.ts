import { test, expect, describe } from "bun:test";
import { runProjectAudit, formatAuditReport, type AuditResult } from "../src/vuln-audit";
import type { PkgVuln } from "../src/osv";

const mkVuln = (over: Partial<PkgVuln> = {}): PkgVuln => ({
  ok: true, version: "", vulns: 1, notices: 0, status: "update", icon: "warning", message: "", severity: "high",
  topVuln: null, fixVersion: "", detailsUrl: "", advisories: [], ...over,
});

describe("formatAuditReport", () => {
  test("no-ecosystem → friendly message, no crash", () => {
    expect(formatAuditReport("x", { ok: false, reason: "no-ecosystem", items: [], scanned: 0, unresolved: 0, ignored: 0 }))
      .toMatch(/No vulnerability audit|لا فحص ثغرات/);
  });

  test("clean project → check line with the scanned count", () => {
    const out = formatAuditReport("proj", { ok: true, items: [], scanned: 131, unresolved: 0, ignored: 0 });
    expect(out).toMatch(/no known vulnerabilities|لا ثغرات معروفة/);
    expect(out).toContain("131");
  });

  test("active ignore list → footer note", () => {
    const out = formatAuditReport("proj", { ok: true, items: [], scanned: 131, unresolved: 0, ignored: 12 });
    expect(out).toMatch(/ignore list active|قائمة تجاهل مفعّلة/);
    expect(out).toContain("12");
  });

  test("vulnerable packages → grouped report with advisories, links, direct/transitive", () => {
    const r: AuditResult = { ok: true, scanned: 131, unresolved: 0, ignored: 0, items: [
      { name: "@sveltejs/kit", version: "2.53.4", eco: "npm", direct: true, vuln: mkVuln({
        fixVersion: "2.60.1",
        advisories: [{ id: "GHSA-2crg-3p73-43xp", severity: "high", summary: "BODY_SIZE_LIMIT bypass", fix: "2.57.1", url: "https://example/adv", kind: "vuln" }],
      }) },
      { name: "devalue", version: "5.6.3", eco: "npm", direct: false, vuln: mkVuln({
        fixVersion: "5.8.1",
        advisories: [{ id: "GHSA-77vg-94rm-hx3p", severity: "high", summary: "DoS", fix: "5.8.1", url: "https://example/d", kind: "vuln" }],
      }) },
    ] };
    const out = formatAuditReport("proj", r);
    expect(out).toMatch(/2 affected package\(s\) \/ 2 advisories|2 حزمة مصابة \/ 2 ثغرة/);
    expect(out).toMatch(/@sveltejs\/kit@2\.53\.4 {2}\((direct|مباشرة)\)/);
    expect(out).toMatch(/devalue@5\.6\.3 {2}\((transitive|غير مباشرة)\)/);
    expect(out).toContain("GHSA-2crg-3p73-43xp");
    expect(out).toContain("https://example/adv");
    expect(out.indexOf("@sveltejs/kit")).toBeLessThan(out.indexOf("devalue")); // direct sorts first
  });
});

describe("runProjectAudit", () => {
  test("language with no OSV ecosystem (vcpkg/C++) → ok:false, no network", async () => {
    const r = await runProjectAudit({ dirPath: "/nonexistent", ecosystem: "vcpkg", directNames: new Set(), directLibs: [] });
    expect(r).toMatchObject({ ok: false, reason: "no-ecosystem" });
  });
});
