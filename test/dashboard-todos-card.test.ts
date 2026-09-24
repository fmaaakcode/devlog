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

// The × on an open task row withdraws it (`-(dropped) #N`) — it must never
// reach the permanent-delete route the security card uses, and closed rows
// must not offer it. Source-level, like the rest of this file; dictionary
// keys are pinned, never the rendered text (i18n insight, 2026-07-27).
describe("dashboard todos card — drop ×", () => {
  const body = SRC.slice(SRC.indexOf("function buildTodosHtml"), SRC.indexOf("function patchSessions"));

  test("open rows (current + upcoming) render the drop button, closed rows do not", () => {
    const rows = body.split("for (const t of ");
    const rowFor = (list: string) => rows.find(r => r.startsWith(list)) || "";
    expect(rowFor("openTodos)")).toContain("dropBtn(t)");
    expect(rowFor("upcoming)")).toContain("dropBtn(t)");
    expect(rowFor("closedTodos)")).not.toContain("dropBtn(t)");
    expect(body).toContain('data-action="drop-item"');
    expect(body).toContain('tr("todos.dropTitle")');
  });

  test("the drop action posts to /api/tag/:id/drop with the destructive headers, never DELETE", () => {
    expect(SRC).toContain('"drop-item": (el, e)');
    const fn = SRC.slice(SRC.indexOf("async function dropItem"), SRC.indexOf("function libFromSecurityTag"));
    expect(fn).toContain("/drop`");
    expect(fn).toContain('method: "POST"');
    expect(fn).toContain("destructiveHeaders()");
    expect(fn).not.toContain("DELETE");
    expect(fn).toContain('tr("todos.dropConfirm"');
    expect(fn).toContain("refreshActiveView(true)");
  });
});
