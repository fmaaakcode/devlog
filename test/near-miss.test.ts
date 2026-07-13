// Unit tests for near-miss tag-head detection (#555): a typo'd head must be
// paired with its closest known tag; legitimate heads, command heads, code
// examples and unrecognizable prose must stay silent.

import { describe, test, expect } from "bun:test";
import { nearMissTags } from "../src/tag-parser";

describe("nearMissTags", () => {
  test("pairs a typo'd head with the closest known tag", () => {
    expect(nearMissTags("-(bulit) wired the export pipeline"))
      .toEqual([{ head: "bulit", suggestion: "built" }]);
    expect(nearMissTags("-(insigt) root cause was the cache"))
      .toEqual([{ head: "insigt", suggestion: "insight" }]);
    expect(nearMissTags("-(bug fond) the scanner races"))
      .toEqual([{ head: "bug fond", suggestion: "bug found" }]);
  });

  test("known tag heads and command heads are never near-misses", () => {
    expect(nearMissTags("-(built) real work")).toEqual([]);
    expect(nearMissTags("-(ask:open)")).toEqual([]);
    expect(nearMissTags("-(release) v1.0.0 — reason")).toEqual([]);
    expect(nearMissTags("-(audit) deep")).toEqual([]);
  });

  // #605: rule:ack sat at edit distance 1 from rule:add but was missing from
  // COMMAND_HEADS, so a legitimate ack drew a "not captured" warning right
  // after standards.ts had accepted it. Every head standards.ts / parse-tags
  // actually serves must be exempt.
  test("served command heads absent from the old list are exempt (#605)", () => {
    expect(nearMissTags("-(rule:ack) dep:astro — user asked for v5")).toEqual([]);
    expect(nearMissTags("-(rule:acks)")).toEqual([]);
    expect(nearMissTags("-(ask:lib) astro")).toEqual([]);
  });

  test("a typo'd rule:ack still gets a hint", () => {
    // rule:ac — distance 1 from rule:ack, 2 from rule:add, so the pick is unambiguous.
    expect(nearMissTags("-(rule:ac) dep:astro"))
      .toEqual([{ head: "rule:ac", suggestion: "rule:ack" }]);
  });

  test("heads inside fenced or inline code are invisible", () => {
    expect(nearMissTags("example:\n```\n-(bulit) doc sample\n```")).toEqual([]);
    expect(nearMissTags("write `-(bulit)` to see the hint")).toEqual([]);
  });

  test("prose parens resembling nothing stay silent", () => {
    expect(nearMissTags("-(whatever this is) some text")).toEqual([]);
    expect(nearMissTags("-(xy) too short and unlike anything")).toEqual([]);
  });

  test("the same malformed head twice reports once", () => {
    expect(nearMissTags("-(bulit) a\n\n-(bulit) b")).toHaveLength(1);
  });

  test("breaking marker on a typo'd head still matches", () => {
    expect(nearMissTags("-(bulit!) breaking work"))
      .toEqual([{ head: "bulit", suggestion: "built" }]);
  });
});
