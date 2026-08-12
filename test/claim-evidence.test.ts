// Claim vs. evidence (#855) — the verdict stamped on a work tag at capture.
//
// Every branch is exercised by injecting the condition, not by watching a happy
// path (verification #2), and the two rules that keep the mark from lying are
// pinned as tests because they are stated as invariants in the module header:
//   · only WORK tags are judged — a decision or an insight gets no mark
//   · "unverifiable" wins over "unsupported" whenever a command channel existed,
//     because absence of edit events proves nothing when a script could have
//     written the files
//
// The window helpers are here too: the footprint and the verdict MUST describe
// the same span, so batchWindowStart has exactly one definition and both readers
// use it.

import { describe, test, expect } from "bun:test";
import { judgeClaim, tallyEvidence, WORK_CLAIM_TAGS } from "../src/claim-evidence";
import { batchWindowStart, sessionCommandCount, sessionTouchedFiles } from "../src/file-story";
import type { DevLogData } from "../src/types";

const judge = (tag: string, touchedCount: number, commandCount = 0) =>
  judgeClaim({ tag, touchedCount, commandCount });

describe("the verdict", () => {
  test("a work claim with edits in its window is supported", () => {
    expect(judge("built", 3)).toBe("supported");
    expect(judge("bug fix", 1)).toBe("supported");
  });

  test("a work claim with NO edits and no command channel is unsupported", () => {
    expect(judge("built", 0)).toBe("unsupported");
    expect(judge("refactor", 0)).toBe("unsupported");
    expect(judge("security fix", 0)).toBe("unsupported");
  });

  test("commands in the window make it unverifiable, never unsupported", () => {
    // A script can write files without emitting a change event. Claiming
    // "unsupported" here would be the confident false alarm this project has
    // already been burned by twice.
    expect(judge("built", 0, 1)).toBe("unverifiable");
    expect(judge("bug fix", 0, 12)).toBe("unverifiable");
  });

  test("edits win over commands — evidence beats doubt", () => {
    expect(judge("built", 2, 5)).toBe("supported");
  });

  test("knowledge tags get NO mark at all", () => {
    for (const tag of ["decision", "insight", "note", "bug found", "todo", "feature", "release", "doc:report"]) {
      expect(judge(tag, 0)).toBeUndefined();
      expect(judge(tag, 4)).toBeUndefined();
    }
  });

  test("the judged vocabulary is exactly the tags that assert work", () => {
    expect([...WORK_CLAIM_TAGS].sort()).toEqual(
      ["bug fix", "bug fix:interim", "built", "refactor", "security fix"].sort());
  });

  test("an interim fix is judged like any other fix — a stopgap still edits files", () => {
    expect(judge("bug fix:interim", 0)).toBe("unsupported");
    expect(judge("bug fix:interim", 1)).toBe("supported");
  });
});

describe("the tally a surface reads", () => {
  test("counts each verdict, and keeps pre-stamp history separate", () => {
    const tally = tallyEvidence([
      { tag: "built", evidence: "supported" },
      { tag: "built", evidence: "supported" },
      { tag: "bug fix", evidence: "unsupported" },
      { tag: "refactor", evidence: "unverifiable" },
      { tag: "built" },                       // stored before the stamp existed
      { tag: "decision", evidence: "supported" },  // not a work claim → ignored
      { tag: "note" },
    ]);
    // `unmarked` must never be folded into "supported": an unjudged tag would
    // then read as a verified one.
    expect(tally).toEqual({ supported: 2, unsupported: 1, unverifiable: 1, unmarked: 1 });
  });

  test("an empty record tallies to zeros, not to health", () => {
    expect(tallyEvidence([])).toEqual({ supported: 0, unsupported: 0, unverifiable: 0, unmarked: 0 });
  });
});

describe("the window both readers share", () => {
  const data = (): DevLogData => ({
    projects: { p: { path: "D:/p" } },
    tags: [
      { tag: "built", project: "p", session_id: "s1", content: "earlier batch", timestamp: "2026-08-12T10:00:00Z" },
      { tag: "note", project: "other", session_id: "s1", content: "other project", timestamp: "2026-08-12T12:00:00Z" },
    ],
    events: [
      // Before the previous batch → belongs to work already recorded.
      { project: "p", type: "change", file_path: "D:/p/old.ts", session_id: "s1", timestamp: "2026-08-12T09:00:00Z" },
      // After it → this capture's work.
      { project: "p", type: "change", file_path: "D:/p/new.ts", session_id: "s1", timestamp: "2026-08-12T11:00:00Z" },
      { project: "p", type: "command", command: "bun test", session_id: "s1", timestamp: "2026-08-12T11:30:00Z" },
      // Another session's activity must never leak in.
      { project: "p", type: "change", file_path: "D:/p/elsewhere.ts", session_id: "s2", timestamp: "2026-08-12T11:45:00Z" },
    ],
    plans: [], worklog: [],
  } as unknown as DevLogData);

  test("the window starts at this session's newest tag for THIS project", () => {
    expect(batchWindowStart(data(), "s1", "p")).toBe(+new Date("2026-08-12T10:00:00Z"));
  });

  test("footprint and command count cover the same span", () => {
    expect(sessionTouchedFiles(data(), "s1", "p")).toEqual(["D:/p/new.ts"]);
    expect(sessionCommandCount(data(), "s1", "p")).toBe(1);
  });

  test("no session id means no claim of either kind", () => {
    expect(sessionTouchedFiles(data(), undefined, "p")).toEqual([]);
    expect(sessionCommandCount(data(), undefined, "p")).toBe(0);
  });

  test("the pair produces the verdict the route stamps", () => {
    const d = data();
    expect(judgeClaim({
      tag: "built",
      touchedCount: sessionTouchedFiles(d, "s1", "p").length,
      commandCount: sessionCommandCount(d, "s1", "p"),
    })).toBe("supported");
  });
});
