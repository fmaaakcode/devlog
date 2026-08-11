// decideDemolition — the load-bearing-wall notice (plan solution-altitude-guards, P4).
//
// What it must never do is more important than what it does: it is advisory,
// it speaks once, and it FAILS OPEN on every uncertainty. A gate that blocks
// when it cannot see gets switched off, and a switched-off gate protects
// nothing — which is why "no weight", "unknown file" and "below threshold" all
// pass here rather than erring toward caution.

import { describe, test, expect } from "bun:test";
import { decideDemolition, GATED_TOOLS, DEPENDENTS_THRESHOLD, type DemolitionWeight } from "../src/demolition-gate";

const heavy = (over: Partial<DemolitionWeight> = {}): DemolitionWeight =>
  ({ file: "src/data.ts", dependents: 35, reports: 10, openReports: 0, unknown: false, ...over });

describe("it fires on a load-bearing file", () => {
  test("a file many others import earns the notice", () => {
    const d = decideDemolition({ weight: heavy(), acked: false });
    expect(d.block).toBe(true);
    expect(d.reason).toBe("load-bearing");
    expect(d.message).toContain("35");
    expect(d.message).toContain("ask:why");        // it points at the deeper read
    expect(d.message).toContain("src/data.ts");
  });

  test("the notice names the scars when the file has any", () => {
    const d = decideDemolition({ weight: heavy({ reports: 4, openReports: 2 }), acked: false });
    expect(d.message).toContain("4");
    expect(d.message).toContain("2");
  });

  test("a clean load-bearing file says nothing about reports", () => {
    const d = decideDemolition({ weight: heavy({ reports: 0, openReports: 0 }), acked: false });
    expect(d.block).toBe(true);
    expect(d.message).not.toContain("report(s)");
  });

  test("it speaks Arabic when asked", () => {
    const d = decideDemolition({ weight: heavy(), acked: false }, "ar");
    expect(d.message).toContain("جدار حامل");
  });
});

describe("it fails open on every uncertainty", () => {
  test("no weight at all (daemon down, walk failed) passes", () => {
    expect(decideDemolition({ weight: null, acked: false }).block).toBe(false);
  });

  test("an unknown file passes — absent information is not a reason to block", () => {
    // A brand-new file is the common case here; treating "not in the analysis"
    // as "weight 0" would be right by accident, and as "suspicious" would be
    // wrong every time.
    const d = decideDemolition({ weight: heavy({ unknown: true }), acked: false });
    expect(d.block).toBe(false);
    expect(d.reason).toBe("unknown-file");
  });

  test("a leaf file passes", () => {
    const d = decideDemolition({ weight: heavy({ dependents: 1 }), acked: false });
    expect(d.block).toBe(false);
    expect(d.reason).toBe("below-threshold");
  });

  test("the threshold is inclusive at its boundary", () => {
    expect(decideDemolition({ weight: heavy({ dependents: DEPENDENTS_THRESHOLD - 1 }), acked: false }).block).toBe(false);
    expect(decideDemolition({ weight: heavy({ dependents: DEPENDENTS_THRESHOLD }), acked: false }).block).toBe(true);
  });

  test("an explicit threshold overrides the default", () => {
    expect(decideDemolition({ weight: heavy({ dependents: 6 }), acked: false, threshold: 20 }).block).toBe(false);
  });

  test("the kill switch passes everything", () => {
    const d = decideDemolition({ weight: heavy(), acked: false, disabled: true });
    expect(d.block).toBe(false);
    expect(d.reason).toBe("disabled");
  });
});

describe("it speaks once", () => {
  test("an acked file passes — the deliberate rebuild proceeds", () => {
    const d = decideDemolition({ weight: heavy(), acked: true });
    expect(d.block).toBe(false);
    expect(d.reason).toBe("acked");
  });
});

describe("the trigger matches how demolition actually happens", () => {
  test("Edit is gated, not only Write", () => {
    // Measured on this project's event log: 16 Edits, 0 Writes on code files.
    // Gating Write alone would have made this guard silent for an entire day of
    // rewriting 35-dependent modules.
    expect(GATED_TOOLS.has("Edit")).toBe(true);
    expect(GATED_TOOLS.has("Write")).toBe(true);
    expect(GATED_TOOLS.has("MultiEdit")).toBe(true);
  });

  test("reads and shell commands are not gated", () => {
    expect(GATED_TOOLS.has("Read")).toBe(false);
    expect(GATED_TOOLS.has("Bash")).toBe(false);
  });
});
