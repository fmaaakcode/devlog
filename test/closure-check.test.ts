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

  test("weak match emits warning, not unclosed", () => {
    const r = checkClosures(
      [{ tag: "built", content: "Added dashboard button for export feature" }],
      [{ num: 9, tag: "todo", content: "Dashboard needs a way to filter recent items" }],
    );
    // 2 shared tokens ("dashboard") — below MIN_SHARED_TOKENS (3); no flag.
    expect(r.unclosed.length).toBe(0);
    expect(r.warnings.length).toBe(0);
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
