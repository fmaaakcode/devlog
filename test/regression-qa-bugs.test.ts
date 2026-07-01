// Regression tests for findings from an internal QA review. Each `test.failing`
// here proves the bug exists on main today. Once the fix ships, flip the test
// from `test.failing` to `test` — it must then pass and serves as a permanent
// guard against regression.

import { test, expect, describe } from "bun:test";
import { parseTags } from "../src/tag-parser";

// ---------------------------------------------------------------------------
// Bug #3 — order of tags in activity log
// ---------------------------------------------------------------------------
// QA Finding #3: parseTags() collects matches in two passes — first
// every doc:* tag, then every non-doc tag. The returned array is therefore
// "doc-tags first, others second", regardless of the order the user wrote them.
// The server stamps each entry with new Date().toISOString() on receipt, so
// the dashboard timeline ends up reordered.
//
// The contract this regression test pins down:
//   parseTags(input).map(t => t.tag)  ===  the order the tags appear in `input`.
//
// Source-of-truth offset is the byte index of the `-(` opener in the original
// message. Until the source is fixed, this test is expected to FAIL.

describe("regression — Bug #3: tag order must follow source order", () => {
  test(
    "doc:* tag written AFTER a built/note tag must appear AFTER it in output",
    () => {
      const msg = [
        "-(built) Added retry logic to fetch wrapper",
        "-(doc:plan) refactor-fetch",
        "# خطّة",
        "- [ ] handle 5xx",
        "-(note) need to verify with backend team",
      ].join("\n");

      const tags = parseTags(msg).map(t => t.tag);

      // Source-order: built (offset 0) → doc:plan (offset ~45) → note (offset ~120)
      expect(tags).toEqual(["built", "doc:plan", "note"]);
    },
  );

  test(
    "two doc:* tags interleaved with non-doc preserve relative order",
    () => {
      const msg = [
        "-(note) first observation",
        "-(doc:report) report-a",
        "# A",
        "-(built) feature added",
        "-(doc:analysis) analysis-b",
        "# B",
        "-(note) closing thought",
      ].join("\n");

      const tags = parseTags(msg).map(t => t.tag);

      expect(tags).toEqual([
        "note",
        "doc:report",
        "built",
        "doc:analysis",
        "note",
      ]);
    },
  );

  test(
    "a single doc:* tag at the end stays at the end (does NOT float to front)",
    () => {
      const msg = [
        "-(built) one",
        "-(built) two",
        "-(built) three",
        "-(doc:plan) plan-name",
        "# trailing plan",
      ].join("\n");

      const tags = parseTags(msg).map(t => t.tag);

      expect(tags[tags.length - 1]).toBe("doc:plan");
    },
  );
});

// ---------------------------------------------------------------------------
// Bug #3 — sanity (non-failing): ordering already correct when there are no
// doc:* tags. Pinning this so a future "fix" can't accidentally break the
// already-correct path.
// ---------------------------------------------------------------------------
describe("regression — Bug #3: non-doc-only ordering is correct (sanity)", () => {
  test("ordering of pure non-doc tags is preserved", () => {
    const msg = "-(built) A\n-(note) B\n-(refactor) C\n-(insight) D";
    const tags = parseTags(msg).map(t => t.tag);
    expect(tags).toEqual(["built", "note", "refactor", "insight"]);
  });

  test("ordering of pure doc tags is preserved", () => {
    const msg = "-(doc:report) r1\n# A\n-(doc:analysis) a1\n# B\n-(doc:plan) p1\n# C";
    const tags = parseTags(msg).map(t => t.tag);
    expect(tags).toEqual(["doc:report", "doc:analysis", "doc:plan"]);
  });
});
