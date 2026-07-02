import { test, expect, describe } from "bun:test";
import { join } from "node:path";

// #227 regression. The surgical `updateCards()` path used to build the todos
// card inline WITHOUT the #N badges or the pinned notes, so both vanished on a
// live refresh while the full render still showed them. The fix unifies both
// paths onto the shared `buildTodosHtml(tags)` builder. dashboard.js is browser
// JS with no DOM harness, so — like security-sinks.test.ts — we pin the invariant
// at the source level: one builder, used by both paths, that renders #N + notes.

const ROOT = join(import.meta.dir, "..");
// dashboard.js was split into topical files (report #9); read them as one body.
const SRC = (await Promise.all(
  ["core", "data", "project", "panels", "tree-ws"].map(
    p => Bun.file(join(ROOT, "assets", `dashboard-${p}.js`)).text()))).join("\n");

describe("dashboard todos card (#227)", () => {
  test("a single shared builder renders the todos card", () => {
    const defs = SRC.match(/function\s+buildTodosHtml\s*\(/g) || [];
    expect(defs).toHaveLength(1);
  });

  test("the builder renders #N badges and pinned notes", () => {
    const body = SRC.slice(SRC.indexOf("function buildTodosHtml"));
    // numBadge emits the "#N" chip; the notes section is the 📝 block.
    expect(body).toContain("numBadge");
    expect(body).toContain("#${n}");
    expect(body).toContain("📝");
  });

  test("the surgical updateCards path delegates to the shared builder (no inline cardTodos html)", () => {
    expect(SRC).toContain("updateCard('cardTodos', buildTodosHtml(tags))");
    // The old inline path assigned a hand-built string straight to cardTodos.
    // The full-render path may still set innerHTML, but only from the builder's
    // output — assert every cardTodos write references that, never raw markup.
    const assigns = SRC.match(/getElementById\('cardTodos'\)\.innerHTML\s*=\s*([^;]+);/g) || [];
    expect(assigns).toHaveLength(1);
    expect(assigns[0]).toContain("todosCardHtml");
  });
});
