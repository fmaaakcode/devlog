// Drift guard for the token's destructive-route list (swept in after #755).
//
// #755 was a hand-maintained classification that fell out of step with reality
// in silence. PROTECTED_ROUTES in token.ts is the same shape of thing: a list a
// developer must remember to extend when a new DELETE route lands. The sweep
// that followed #755 found it had already drifted — /api/event/:id and
// /api/injection/:id erase captured records for good and neither was covered.
//
// So instead of just adding them, this enumerates the DELETE handlers that
// actually exist in src/routes-*.ts and fails when one is neither protected nor
// listed as a deliberate exemption. A new destructive route now forces a
// decision at test time rather than being discovered during an incident.

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isProtectedPath } from "../src/token";

const SRC = join(import.meta.dir, "..", "src");

// Routes whose DELETE is deliberately NOT token-gated, each with the reason it
// doesn't belong in a list reserved for irreversible data loss.
const EXEMPT: Record<string, string> = {
  "/api/stack/:project/layout": "removes a cosmetic stack-map layout file; regenerated on next drag",
  "/api/injection/config": "resets a project's injection settings to defaults — reversible, no captured data lost",
};

/** Every `"path": { METHOD… }` pair declared across the route modules. */
function scanRouteFiles(): { path: string; methods: string[] }[] {
  const out: { path: string; methods: string[] }[] = [];
  for (const file of readdirSync(SRC).filter(f => f.startsWith("routes-") && f.endsWith(".ts"))) {
    for (const line of readFileSync(join(SRC, file), "utf8").split("\n")) {
      const path = line.match(/^\s*"(\/[^"]*)":/);
      if (path) { out.push({ path: path[1], methods: [] }); continue; }
      const method = line.match(/^\s*(?:async\s+)?(GET|POST|PUT|PATCH|DELETE)\s*[(:]/);
      if (method && out.length > 0) out[out.length - 1].methods.push(method[1]);
    }
  }
  return out;
}

/** ":param" segments can't be matched by prefix as written — make them concrete. */
const concrete = (path: string) => path.replace(/:[^/]+/g, "x");

describe("token — destructive-route classification can't drift", () => {
  const routes = scanRouteFiles();

  test("the scan actually found the route table", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.some(r => r.path === "/api/data/clear")).toBe(true);
    expect(routes.filter(r => r.methods.includes("DELETE")).length).toBeGreaterThanOrEqual(8);
  });

  test("every DELETE route is either protected or a documented exemption", () => {
    const unclassified = routes
      .filter(r => r.methods.includes("DELETE"))
      .filter(r => !isProtectedPath(concrete(r.path), "DELETE") && !(r.path in EXEMPT))
      .map(r => r.path);
    expect(unclassified).toEqual([]);
  });

  test("the exemption list has no stale entries", () => {
    const deleteRoutes = new Set(routes.filter(r => r.methods.includes("DELETE")).map(r => r.path));
    for (const path of Object.keys(EXEMPT)) expect(deleteRoutes.has(path)).toBe(true);
  });

  test("the routes swept in after #755 are covered", () => {
    expect(isProtectedPath("/api/event/abc", "DELETE")).toBe(true);
    expect(isProtectedPath("/api/injection/abc", "DELETE")).toBe(true);
  });

  // The reason /api/injection/ carries a `methods` restriction: without it the
  // prefix would also demand a token to READ the injection config.
  test("a method-restricted prefix doesn't leak onto that prefix's reads", () => {
    expect(isProtectedPath("/api/injection/config", "GET")).toBe(false);
    expect(isProtectedPath("/api/injection/config", "POST")).toBe(false);
  });

  test("unrestricted prefixes still protect every verb", () => {
    expect(isProtectedPath("/api/data/clear", "DELETE")).toBe(true);
    expect(isProtectedPath("/api/project/foo", "POST")).toBe(true);
  });

  test("near-miss paths stay unprotected", () => {
    expect(isProtectedPath("/api/projects-summary", "GET")).toBe(false);
    expect(isProtectedPath("/api/tags", "GET")).toBe(false);
  });

  test("the method comparison is case-insensitive", () => {
    expect(isProtectedPath("/api/injection/abc", "delete")).toBe(true);
  });
});
