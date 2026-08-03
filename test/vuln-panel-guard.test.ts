// #766 source guard: the vuln-scan panel must render the shape the server
// actually sends. GET /api/vuln/:project returns { project, libraries: {
// results } } — nothing else. The dead block read `d.runtime` and
// `d.libraries.summary` (fields from a retired response shape), so every
// successful scan blanked the panel; the fix computes the summary client-side
// from `results` statuses. Same source-pin style as the direction guard (#712):
// no DOM harness, so the guard fails closed on a reintroduction of the dead
// fields or removal of the client-side computation.
import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("vuln panel renders the server's real shape (#766)", () => {
  test("dashboard-data.js: dead response fields are gone, results drive the summary", async () => {
    const js = await Bun.file(join(ROOT, "assets/dashboard-data.js")).text();
    expect(js).not.toContain("d.runtime");            // retired field — server never sends it
    expect(js).not.toContain("libraries.summary");    // retired field — summary is client-side now
    expect(js).toContain("d.libraries?.results");     // the one field the server does send
    // The client-side buckets match the PkgVuln status union (osv.ts).
    for (const status of ['"safe"', '"danger"', '"update"']) expect(js).toContain(`count(${status})`);
  });

  test("severity mapping is not inverted: danger=pink/❌, update=gold/⚠️", async () => {
    const js = await Bun.file(join(ROOT, "assets/dashboard-data.js")).text();
    expect(js).toMatch(/--pink\)">❌ \$\{tr\("vuln\.dangerCount"/);
    expect(js).toMatch(/--gold\)">⚠️ \$\{tr\("vuln\.updateCount"/);
  });

  test("every vuln.* key the panel uses exists in both dictionary languages", async () => {
    const js = await Bun.file(join(ROOT, "assets/dashboard-data.js")).text();
    const dict = await Bun.file(join(ROOT, "assets/dashboard-i18n.js")).text();
    const used = [...js.matchAll(/tr\("(vuln\.[\w.]+)"/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const key of new Set(used)) {
      const row = new RegExp(`"${key.replace(".", "\\.")}":\\s*\\{ en: "[^"]+", ar: "[^"]+" \\}`);
      expect(dict).toMatch(row);
    }
  });
});
