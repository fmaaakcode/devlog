import { test, expect, describe } from "bun:test";
import { join } from "node:path";

// #229 regression. The events card and the about-button state were each built
// in TWO places — the full render and the surgical updateCards/patchHeader path
// — and had already drifted (item-new highlight on one events path, absent on
// the other). The fix routes both through shared builders (buildEventsHtml,
// aboutBtnAttrs), mirroring the buildTodosHtml unification from #227. dashboard.js
// is browser JS with no DOM harness, so we pin the single-source invariant at
// the source level (same approach as security-sinks.test.ts / #227).

const SRC = await Bun.file(join(import.meta.dir, "..", "assets", "dashboard.js")).text();

describe("dashboard events card unified (#229)", () => {
  test("exactly one buildEventsHtml definition", () => {
    expect((SRC.match(/function\s+buildEventsHtml\s*\(/g) || [])).toHaveLength(1);
  });

  test("the per-event filter+slice lives only inside the builder (no second copy)", () => {
    const filters = SRC.match(/\.filter\(e => e\.project === \w+\)\.slice\(-50\)\.reverse\(\)/g) || [];
    expect(filters).toHaveLength(1);
  });

  test("every eventsCard write routes through the shared builder", () => {
    const writes = SRC.match(/eventsCard'?\)?(?:\.innerHTML\s*=|',)\s*[^;]*/g) || [];
    expect(writes.length).toBeGreaterThanOrEqual(2); // surgical + full render
    for (const w of writes) expect(w).toContain("buildEventsHtml");
  });
});

describe("dashboard about-button state unified (#229)", () => {
  test("exactly one aboutBtnAttrs definition", () => {
    expect((SRC.match(/function\s+aboutBtnAttrs\s*\(/g) || [])).toHaveLength(1);
  });

  test("the about title literal appears once (only inside aboutBtnAttrs)", () => {
    const hits = SRC.match(/مرر الماوس لعرض التفاصيل/g) || [];
    expect(hits).toHaveLength(1);
  });

  test("both the full build and the surgical patch consume aboutBtnAttrs", () => {
    const uses = SRC.match(/aboutBtnAttrs\(/g) || [];
    // 1 definition + 2 call sites (buildHeaderOnce, patchHeader).
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });
});
