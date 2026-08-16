// Regression guard for the XSS fixes (defense D2/D3). These read the REAL UI
// files (not a copy) and assert the escaping/allowlist stay wired — so removing
// esc()/safeHref() from a sink breaks the build instead of silently reopening XSS.

import { test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("dom-safe.js holds the single esc()/safeHref() copy (C2)", async () => {
  // Audit C2 collapsed the three drifting esc() copies (dashboard-core /
  // stack-map / deps) into one stateless module. The definitions must live
  // HERE and nowhere else — a re-grown local copy is the drift reopening.
  const domSafe = await Bun.file(join(ROOT, "assets", "dom-safe.js")).text();
  expect(domSafe).toMatch(/export function esc\(/);
  expect(domSafe).toMatch(/export function safeHref\(/);
  for (const f of ["dashboard-core.js", "stack-map.js", "deps.js"]) {
    const js = await Bun.file(join(ROOT, "assets", f)).text();
    expect(js, `${f} must import esc from dom-safe.js, not define its own`).toContain('./dom-safe.js');
    expect(js, `${f} re-grew a local esc()`).not.toMatch(/function esc\(|const esc =/);
  }
});

test("stack-map.js escapes untrusted tooltip fields (D2)", async () => {
  // The stack-map script was extracted from stack-map.html to an external file
  // (report #5) so CSP can drop script-src 'unsafe-inline'; the escaping guard
  // moved with it. esc's definition lives in dom-safe.js (C2) — here we pin
  // that the SINKS still route through it.
  const js = await Bun.file(join(ROOT, "assets", "stack-map.js")).text();
  // node.path / node.description come from DEVLOG_STACK.md (project-controlled).
  expect(js).toContain("esc(node.path)");
  expect(js).toContain("esc(node.description)");
});

test("dashboard.js allowlists link schemes via safeHref (D3)", async () => {
  // dashboard.js was split into topical files (report #9); check them as one body.
  const parts = await Promise.all(
    ["core", "data", "project", "panels", "tree-ws"].map(
      p => Bun.file(join(ROOT, "assets", `dashboard-${p}.js`)).text()));
  const js = parts.join("\n");
  expect(js).toContain("safeHref(p.gitRemote)");
  // The live detailsUrl sink is the vuln modal in dashboard-core.js (#777
  // removed the dead `#hdr-libraries` twin that used `v?.detailsUrl`).
  expect(js).toContain("safeHref(v.detailsUrl)");
});
