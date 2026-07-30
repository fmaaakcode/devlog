// R9 F5: the isDetector filter (skip pattern/route/security detection for
// files containing DevLog's own detection code) matched by bare substring on
// names like "export"/"analyze" in EVERY scanned project — a user's
// src/export.ts lost its routes and patterns from the stack map with no trace.
// The fix anchors the exclusion to a DevLog self-scan fingerprint
// (src/tag-parser.ts), so user projects keep full detection.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "../src/analyze";

// A file whose NAME triggers the old substring filter and whose content
// carries an unmistakable route.
const EXPORT_TS =
  `import { db } from "./db";\n` +
  `export const routes = {\n` +
  `  "/api/export": { async GET() { return Response.json(await db()); } },\n` +
  `};\n`;

describe("isDetector is self-scan only (R9 F5)", () => {
  test("user project: a file named export.ts keeps route detection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-user-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "user-app", version: "1.0.0" }));
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "export.ts"), EXPORT_TS);

      const analysis = await analyzeProject(dir);
      expect(analysis.apiRoutes.map(r => r.path)).toContain("/api/export");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("DevLog itself (src/tag-parser.ts fingerprint): detector files stay excluded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-self-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "devlog", version: "1.0.0" }));
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "tag-parser.ts"), "export function parseTags() { return []; }\n");
      writeFileSync(join(dir, "src", "export.ts"), EXPORT_TS);

      const analysis = await analyzeProject(dir);
      expect(analysis.apiRoutes.map(r => r.path)).not.toContain("/api/export");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
