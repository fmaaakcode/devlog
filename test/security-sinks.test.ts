// Regression guard for the XSS fixes (defense D2/D3). These read the REAL UI
// files (not a copy) and assert the escaping/allowlist stay wired — so removing
// esc()/safeHref() from a sink breaks the build instead of silently reopening XSS.

import { test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("stack-map.html escapes untrusted tooltip fields (D2)", async () => {
  const html = await Bun.file(join(ROOT, "stack-map.html")).text();
  expect(html).toMatch(/function esc\(/);
  // node.path / node.description come from DEVLOG_STACK.md (project-controlled).
  expect(html).toContain("esc(node.path)");
  expect(html).toContain("esc(node.description)");
});

test("dashboard.js allowlists link schemes via safeHref (D3)", async () => {
  const js = await Bun.file(join(ROOT, "assets", "dashboard.js")).text();
  expect(js).toMatch(/function safeHref\(/);
  expect(js).toContain("safeHref(p.gitRemote)");
  expect(js).toContain("safeHref(v?.detailsUrl)");
});
