import { test, expect, describe } from "bun:test";
import { runProjectAudit, formatAuditReport, type AuditResult } from "../src/vuln-audit";
import type { PkgVuln } from "../src/osv";

const mkVuln = (over: Partial<PkgVuln> = {}): PkgVuln => ({
  ok: true, vulns: 1, status: "update", icon: "warning", message: "", severity: "high",
  topVuln: null, fixVersion: "", detailsUrl: "", advisories: [], ...over,
});

describe("formatAuditReport", () => {
  test("no-ecosystem → friendly message, no crash", () => {
    expect(formatAuditReport("x", { ok: false, reason: "no-ecosystem", items: [], scanned: 0, ignored: 0 }))
      .toContain("لا فحص ثغرات");
  });

  test("clean project → check line with the scanned count", () => {
    const out = formatAuditReport("proj", { ok: true, items: [], scanned: 131, ignored: 0 });
    expect(out).toContain("لا ثغرات معروفة");
    expect(out).toContain("131");
  });

  test("active ignore list → footer note", () => {
    const out = formatAuditReport("proj", { ok: true, items: [], scanned: 131, ignored: 12 });
    expect(out).toContain("قائمة تجاهل مفعّلة");
    expect(out).toContain("12");
  });

  test("vulnerable packages → grouped report with advisories, links, direct/transitive", () => {
    const r: AuditResult = { ok: true, scanned: 131, ignored: 0, items: [
      { name: "@sveltejs/kit", version: "2.53.4", direct: true, vuln: mkVuln({
        fixVersion: "2.60.1",
        advisories: [{ id: "GHSA-2crg-3p73-43xp", severity: "high", summary: "BODY_SIZE_LIMIT bypass", fix: "2.57.1", url: "https://example/adv" }],
      }) },
      { name: "devalue", version: "5.6.3", direct: false, vuln: mkVuln({
        fixVersion: "5.8.1",
        advisories: [{ id: "GHSA-77vg-94rm-hx3p", severity: "high", summary: "DoS", fix: "5.8.1", url: "https://example/d" }],
      }) },
    ] };
    const out = formatAuditReport("proj", r);
    expect(out).toContain("2 حزمة مصابة / 2 ثغرة");
    expect(out).toContain("@sveltejs/kit@2.53.4  (مباشرة)");
    expect(out).toContain("devalue@5.6.3  (غير مباشرة)");
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
