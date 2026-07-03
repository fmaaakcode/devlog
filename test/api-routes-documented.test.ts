// Parity guard for the HTTP API reference (plan fable/round2 task 4.5). Scans the
// route tables in server.ts + every routes-*.ts for their route keys, and asserts
// the committed API.md documents exactly that set — no more, no less. Adding a
// route without documenting it (or leaving a stale doc line after removing one)
// fails here, so API.md can't silently drift from the code.

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

// A "real" route key: "/", "/ws", "/api/…", "/releases/…", "/assets/…", or a
// top-level *.html page. Matches the string keys of the Bun.serve route tables.
const ROUTE_RE = /"(\/(?:api\/[^"]*|ws|releases[^"]*|assets\/[^"]*|[a-z-]+\.html)?)"/g;

function routesFromCode(): Set<string> {
  const files = ["server.ts", ...readdirSync(SRC).filter(f => /^routes-.*\.ts$/.test(f))];
  const found = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(SRC, f), "utf8");
    for (const m of text.matchAll(ROUTE_RE)) {
      // Only lines that are actual route-table keys: `    "/api/x": {` or spread.
      // The regex already constrains the shape; guard against arbitrary strings.
      if (m[1] === "/" || m[1].startsWith("/api/") || m[1].startsWith("/releases")
        || m[1].startsWith("/assets") || m[1] === "/ws" || m[1].endsWith(".html")) {
        found.add(m[1]);
      }
    }
  }
  return found;
}

function routesFromDoc(): Set<string> {
  const md = readFileSync(join(ROOT, "API.md"), "utf8");
  const found = new Set<string>();
  // Each route is documented as an inline-code token: `- \`/api/x\` — …`
  for (const m of md.matchAll(/`(\/[^`]*)`/g)) found.add(m[1]);
  return found;
}

describe("API.md stays in sync with the route tables", () => {
  const code = routesFromCode();
  const doc = routesFromDoc();

  test("every route in code is documented in API.md", () => {
    const undocumented = [...code].filter(r => !doc.has(r)).sort();
    expect(undocumented).toEqual([]);
  });

  test("every route in API.md still exists in code (no stale entries)", () => {
    const stale = [...doc].filter(r => !code.has(r)).sort();
    expect(stale).toEqual([]);
  });

  test("the API surface is non-trivial (sanity: the scan found routes)", () => {
    expect(code.size).toBeGreaterThan(40);
  });
});
