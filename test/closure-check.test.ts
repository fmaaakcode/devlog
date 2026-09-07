import { describe, test, expect } from "bun:test";
import { checkClosures, formatClosureMessage } from "../src/closure-check";

describe("closure-check", () => {
  test("flags built that strongly matches open todo without closure", () => {
    const r = checkClosures(
      [{ tag: "built", content: "Stop hook closure enforcement with fuzzy matching" }],
      [{ num: 7, tag: "todo", content: "Implement Stop hook closure enforcement matching" }],
    );
    expect(r.unclosed.length).toBe(1);
    expect(r.unclosed[0].item.num).toBe(7);
    expect(r.unclosed[0].strength).toBe("strong");
  });

  test("does NOT flag when matching closure is emitted in same response", () => {
    const r = checkClosures(
      [
        { tag: "built", content: "Stop hook closure enforcement with fuzzy matching" },
        { tag: "done", content: "#7" },
      ],
      [{ num: 7, tag: "todo", content: "Implement Stop hook closure enforcement matching" }],
    );
    expect(r.unclosed.length).toBe(0);
    expect(r.closuresEmitted).toContain(7);
  });

  test("ignores built with no fuzzy match to any open item", () => {
    const r = checkClosures(
      [{ tag: "built", content: "Renamed CSS variable from --bg to --background" }],
      [{ num: 1, tag: "todo", content: "Investigate WebSocket reconnection logic" }],
    );
    expect(r.unclosed.length).toBe(0);
    expect(r.warnings.length).toBe(0);
  });

  test("flags refactor the same way as built", () => {
    const r = checkClosures(
      [{ tag: "refactor", content: "Split user authentication module into smaller files" }],
      [{ num: 3, tag: "plan-step", content: "Split user authentication module for testability" }],
    );
    expect(r.unclosed.length).toBe(1);
    expect(r.unclosed[0].item.tag).toBe("plan-step");
  });

  test("below MIN_SHARED_TOKENS: no flag at all, not even a warning", () => {
    const r = checkClosures(
      [{ tag: "built", content: "Added dashboard button for export feature" }],
      [{ num: 9, tag: "todo", content: "Dashboard needs a way to filter recent items" }],
    );
    // 1 shared token ("dashboard") — below MIN_SHARED_TOKENS (3); no flag.
    expect(r.unclosed.length).toBe(0);
    expect(r.warnings.length).toBe(0);
  });

  // #1167 (F-9.8): the old "weak match emits warning" title asserted ZERO
  // warnings on a fixture that never reached MIN_SHARED_TOKENS, so the whole
  // WEAK_THRESHOLD path (0.25 ≤ jaccard < 0.5 with ≥ 3 shared tokens) and its
  // "⚠ … weak match" rendering had no witness — deleting either kept the file
  // green. This fixture shares 4 tokens (dashboard/filter/recent/items) over a
  // union of 10 → jaccard 0.4: inside the weak band, outside the strong one.
  test("weak match (0.25 ≤ jaccard < 0.5, ≥ 3 shared tokens) emits a warning, not unclosed", () => {
    const r = checkClosures(
      [{ tag: "built", content: "Added dashboard export button with filter for recent items" }],
      [{ num: 9, tag: "todo", content: "Dashboard needs a way to filter recent items quickly" }],
    );
    expect(r.unclosed.length).toBe(0);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0].item.num).toBe(9);
    expect(r.warnings[0].strength).toBe("weak");
    expect(r.warnings[0].confidence).toBeGreaterThanOrEqual(0.25);
    expect(r.warnings[0].confidence).toBeLessThan(0.5);
    const en = formatClosureMessage(r, "en");
    expect(en).toContain("⚠ 1 work item(s) that may need closing (weak match");
    expect(en).toContain("#9");
    expect(en).not.toContain("✗");            // never rendered as a strong miss
    const ar = formatClosureMessage(r, "ar");
    expect(ar).toContain("تطابق ضعيف");
    expect(ar).toContain("#9");
  });

  test("formatClosureMessage produces actionable output (default English)", () => {
    const r = checkClosures(
      [{ tag: "built", content: "Stop hook closure enforcement with fuzzy matching" }],
      [{ num: 7, tag: "todo", content: "Implement Stop hook closure enforcement matching" }],
    );
    const en = formatClosureMessage(r, "en");
    expect(en).toContain("#7");
    expect(en).toContain("-(done) #7");
    expect(en).toContain("add:");           // English label
    expect(en).not.toContain("أضف");        // no Arabic in English output

    const ar = formatClosureMessage(r, "ar");
    expect(ar).toContain("#7");
    expect(ar).toContain("-(done) #7");
    expect(ar).toContain("أضف");            // Arabic label present
  });

  test("returns empty when no open items provided", () => {
    const r = checkClosures(
      [{ tag: "built", content: "anything" }],
      [],
    );
    expect(r.unclosed.length).toBe(0);
    expect(r.warnings.length).toBe(0);
  });
});
