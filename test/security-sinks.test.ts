// Regression guard for the XSS fixes (defense D2/D3). These read the REAL UI
// files (not a copy) and assert the escaping/allowlist stay wired — so removing
// esc()/safeHref() from a sink breaks the build instead of silently reopening XSS.

import { test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("stack-map.js escapes untrusted tooltip fields (D2)", async () => {
  // The stack-map script was extracted from stack-map.html to an external file
  // (report #5) so CSP can drop script-src 'unsafe-inline'; the escaping guard
  // moved with it.
  const js = await Bun.file(join(ROOT, "assets", "stack-map.js")).text();
  expect(js).toMatch(/function esc\(/);
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
  expect(js).toMatch(/function safeHref\(/);
  expect(js).toContain("safeHref(p.gitRemote)");
  expect(js).toContain("safeHref(v?.detailsUrl)");
});
