// Unit tests for the pure helpers in src/data.ts (remediation round-3 P6 #185):
// normalizeTagContent (the closure-matching normalizer), assignNum (monotonic
// per-project counter), and backfillNums (retro-numbering of open items).

import { describe, test, expect } from "bun:test";
import {
  normalizeTagContent, assignNum, backfillNums, openTodos, openBugs, openSecurity,
  isMalformedPkgDescriptor, cleanupMalformedSecurityTags, cleanupMalformedOutdatedTags,
} from "../src/data";
import { withLockRetry } from "../src/fs-retry";
import type { DevLogData, TagEntry, PlanEntry, ProjectProfile } from "../src/types";

const PROJ = "fixture-proj";

function profile(extra: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: PROJ, path: "", description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-06-01T00:00:00Z", ...extra,
  };
}
let _id = 0;
function tag(t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}
function baseData(tags: TagEntry[], plans: PlanEntry[] = [], prof = profile()): DevLogData {
  return {
    projects: { [PROJ]: prof }, events: [], tags, plans, worklog: [], injections: [],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, outdatedLibs: true, describeNudge: true, upcomingItems: true, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

describe("order-aware text closure (#743)", () => {
  const at = (ts: string) => ({ timestamp: ts });

  test("a fix closes reports at or before its timestamp", () => {
    const tags = [
      tag("security", "lib@1 — vuln", { ...at("2026-01-01T00:00:00Z"), num: 1 }),
      tag("security fix", "lib@1 — vuln", at("2026-01-02T00:00:00Z")),
    ];
    expect(openSecurity(tags)).toEqual([]);
  });

  test("a report REINTRODUCED after its fix is open again — not born closed", () => {
    const tags = [
      tag("security", "lib@1 — vuln", { ...at("2026-01-01T00:00:00Z"), num: 1 }),
      tag("security fix", "lib@1 — vuln", at("2026-01-02T00:00:00Z")),
      tag("security", "lib@1 — vuln", { ...at("2026-03-01T00:00:00Z"), num: 9 }),
    ];
    expect(openSecurity(tags).map(t => t.num)).toEqual([9]);
  });

  test("same-timestamp atomic open+fix pair stays closed", () => {
    const ts = at("2026-01-01T00:00:00Z");
    const tags = [tag("bug found", "x breaks", { ...ts, num: 2 }), tag("bug fix", "x breaks", ts)];
    expect(openBugs(tags)).toEqual([]);
  });

  test("todos: a re-opened twin after done survives; the original stays closed", () => {
    const tags = [
      tag("todo", "polish intro", { ...at("2026-01-01T00:00:00Z"), num: 3 }),
      tag("done", "polish intro", at("2026-01-02T00:00:00Z")),
      tag("todo", "polish intro", { ...at("2026-02-01T00:00:00Z"), num: 7 }),
    ];
    expect(openTodos(tags).map(t => t.num)).toEqual([7]);
  });
});

describe("normalizeTagContent", () => {
  test("collapses whitespace, lowercases, trims", () => {
    expect(normalizeTagContent("  Fix   The   Bug  ")).toBe("fix the bug");
  });
  test("removes inline-code spans wholesale (content + backticks → space)", () => {
    expect(normalizeTagContent("call `foo()` now")).toBe("call now");
  });
  test("strips a stray (unpaired) backtick", () => {
    expect(normalizeTagContent("foo`bar")).toBe("foobar");
  });
});

describe("assignNum", () => {
  test("starts above the max existing number and is monotonic", () => {
    const data = baseData([tag("todo", "a", { num: 3 }), tag("bug found", "b", { num: 5 })]);
    expect(assignNum(data, PROJ)).toBe(6);
    expect(assignNum(data, PROJ)).toBe(7);
    expect(data.projects[PROJ].nextItemNum).toBe(8);
  });
  test("honors a pre-set nextItemNum that is AHEAD of the high-water mark", () => {
    // Ahead happens after deleting the highest-numbered tag: the counter must
    // win so the freed number is never reused.
    const data = baseData([tag("todo", "a", { num: 99 })], [], profile({ nextItemNum: 150 }));
    expect(assignNum(data, PROJ)).toBe(150);
  });
  test("reconciles a BEHIND nextItemNum instead of handing out a duplicate #N", () => {
    // Behind happens when projects.json is restored from a .bak while
    // tags.json kept the higher numbers (round-8 devops F1). The old code
    // returned 10 here — a number #99 already carried would have collided.
    const data = baseData([tag("todo", "a", { num: 99 })], [], profile({ nextItemNum: 10 }));
    expect(assignNum(data, PROJ)).toBe(100);
    expect(data.projects[PROJ].nextItemNum).toBe(101);
  });
  test("reconciles against plan-step numbers too", () => {
    const plan: PlanEntry = {
      id: "p1", project: PROJ, title: "t", timestamp: "2026-06-01T00:00:00Z",
      steps: [{ text: "s", num: 40 }],
    } as PlanEntry;
    const data = baseData([], [plan], profile({ nextItemNum: 5 }));
    expect(assignNum(data, PROJ)).toBe(41);
  });
  test("returns 1 for an unknown project", () => {
    expect(assignNum(baseData([]), "no-such-project")).toBe(1);
  });
});

describe("backfillNums", () => {
  test("numbers open openable tags that lack a num; skips closed ones", () => {
    const data = baseData([
      tag("todo", "open one"),                 // open, no num → gets numbered
      tag("todo", "closed one"),               // closed by text below → skipped
      tag("done", "closed one"),
      tag("note", "just a note"),              // not openable → skipped
      tag("security:own", "leak"),             // openable → numbered
    ]);
    const changed = backfillNums(data);
    expect(changed).toBe(true);
    const byContent = Object.fromEntries(data.tags.map(t => [t.content, t.num]));
    expect(typeof byContent["open one"]).toBe("number");
    expect(typeof byContent.leak).toBe("number");
    expect(byContent["closed one"]).toBeUndefined();
    expect(byContent["just a note"]).toBeUndefined();
  });

  test("numbers pre-numbering feature tags (feature update/removed #N need a target)", () => {
    // Ingest numbers features since the feature-numbering change, but the
    // backfill's own NUMBERED_TAGS copy lagged without `feature` — so old
    // feature history stayed permanently unnumbered and untargetable.
    const data = baseData([tag("feature", "tag capture on Stop")]);
    expect(backfillNums(data)).toBe(true);
    expect(typeof data.tags[0].num).toBe("number");
  });

  test("is idempotent — a second run changes nothing", () => {
    const data = baseData([tag("todo", "open one")]);
    expect(backfillNums(data)).toBe(true);
    expect(backfillNums(data)).toBe(false);
  });

  test("numbers open plan steps but not completed ones", () => {
    const plan: PlanEntry = {
      id: "p1", project: PROJ, title: "P", file_path: "p.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "done", completed: true }, { text: "todo", completed: false }],
    };
    const data = baseData([], [plan]);
    backfillNums(data);
    const steps = data.plans[0].steps;
    expect(steps[0].num).toBeUndefined();      // completed → not numbered
    expect(typeof steps[1].num).toBe("number");
  });
});

describe("withLockRetry — transient Windows lock retry (#781)", () => {
  const errWith = (code: string) => Object.assign(new Error(code), { code });
  const failNTimes = (n: number, code: string, result = "ok") => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls <= n) throw errWith(code);
      return result;
    };
    return { op, calls: () => calls };
  };

  test("succeeds after transient EPERM failures clear", async () => {
    const { op, calls } = failNTimes(2, "EPERM");
    expect(await withLockRetry(op, 6, 1)).toBe("ok");
    expect(calls()).toBe(3);
  });

  test.each(["EPERM", "EBUSY", "EACCES"])("retries %s", async (code) => {
    const { op } = failNTimes(1, code);
    expect(await withLockRetry(op, 6, 1)).toBe("ok");
  });

  test("a non-transient code propagates immediately — no retry", async () => {
    const { op, calls } = failNTimes(99, "ENOENT");
    await expect(withLockRetry(op, 6, 1)).rejects.toThrow("ENOENT");
    expect(calls()).toBe(1);
  });

  test("a lock that survives every attempt propagates", async () => {
    const { op, calls } = failNTimes(99, "EBUSY");
    await expect(withLockRetry(op, 3, 1)).rejects.toThrow("EBUSY");
    expect(calls()).toBe(3);
  });

  test("an error without a code is not treated as transient", async () => {
    let bare = 0;
    const bareOp = async () => { bare++; throw new Error("plain failure"); };
    await expect(withLockRetry(bareOp, 6, 1)).rejects.toThrow("plain failure");
    expect(bare).toBe(1);
  });
});

// The scanner-artifact detector and the two cleanups that consume it. These are
// pure (data in → count out) but were only ever exercised through the migration
// path, so the branches below — every BAD_TOKEN position, the no-`@` fallback
// shape, and the `security:own`/`security:dep` exemption — went unverified.
describe("isMalformedPkgDescriptor", () => {
  test("a bad token in the NAME position is malformed", () => {
    for (const name of ["undefined", "null", "unknown", "system", "bundled"]) {
      expect(isMalformedPkgDescriptor(`${name}@1.2.3 — GHSA-x`)).toBe(true);
    }
  });

  test("a bad token in the VERSION position is malformed", () => {
    for (const v of ["undefined", "null", "unknown"]) {
      expect(isMalformedPkgDescriptor(`astro@${v} — GHSA-x`)).toBe(true);
    }
  });

  test("an empty version is malformed (the empty string is a bad token)", () => {
    expect(isMalformedPkgDescriptor("astro@ — GHSA-x")).toBe(true);
  });

  test("a `vendored-` prefix is malformed on either side", () => {
    // The regression the v2 re-run existed for: the version capture must keep
    // its hyphen, or `vendored-unknown` truncates to `vendored` and slips past.
    expect(isMalformedPkgDescriptor("rnnoise@vendored-unknown — احدث: 0.1.8")).toBe(true);
    expect(isMalformedPkgDescriptor("vendored-rnnoise@0.1.8 — احدث: 0.2.0")).toBe(true);
  });

  test("the no-`@` fallback needs a bad token on BOTH sides", () => {
    expect(isMalformedPkgDescriptor("undefined  — undefined")).toBe(true);
    expect(isMalformedPkgDescriptor("undefined — astro")).toBe(false);
    expect(isMalformedPkgDescriptor("astro — undefined")).toBe(false);
  });

  test("a real advisory and ordinary prose are both left alone", () => {
    expect(isMalformedPkgDescriptor("astro@5.12.0 — GHSA-qqqq: SSRF in the image endpoint")).toBe(false);
    expect(isMalformedPkgDescriptor("just some prose with no descriptor")).toBe(false);
    expect(isMalformedPkgDescriptor("")).toBe(false);
  });
});

describe("cleanupMalformedSecurityTags / cleanupMalformedOutdatedTags", () => {
  const malformedSec = () => [
    tag("security", "undefined@undefined — GHSA-1", { num: 1 }),
    tag("security", "rnnoise@vendored-unknown — GHSA-2", { num: 2 }),
    tag("security", "astro@5.12.0 — GHSA-real", { num: 3 }),
    tag("security:own", "undefined@undefined — hand written", { num: 4 }),
    tag("security:dep", "null@null — hand written", { num: 5 }),
  ];

  test("splices out phantom `security` tags and reports the count", () => {
    const data = baseData(malformedSec());
    expect(cleanupMalformedSecurityTags(data)).toBe(2);
    expect(data.tags.map(t => t.num)).toEqual([3, 4, 5]);
  });

  test("user-authored security:own / security:dep are never touched", () => {
    const data = baseData(malformedSec());
    cleanupMalformedSecurityTags(data);
    expect(data.tags.filter(t => t.tag.startsWith("security:")).length).toBe(2);
  });

  test("it is idempotent — a second run removes nothing", () => {
    const data = baseData(malformedSec());
    expect(cleanupMalformedSecurityTags(data)).toBe(2);
    expect(data.migrations?.cleanup_malformed_security_v1).toBe(true);
    expect(data.migrations?.cleanup_malformed_security_v2).toBe(true);
    data.tags.push(tag("security", "null@null — GHSA-3", { num: 6 }));
    expect(cleanupMalformedSecurityTags(data)).toBe(0);
    expect(data.tags.some(t => t.num === 6)).toBe(true);
  });

  test("a data blob with no `migrations` object gets one", () => {
    const data = baseData(malformedSec());
    delete (data as { migrations?: unknown }).migrations;
    expect(cleanupMalformedSecurityTags(data)).toBe(2);
    expect(data.migrations?.cleanup_malformed_security_v2).toBe(true);
  });

  test("the outdated cleanup mirrors it and stays in its own lane", () => {
    const data = baseData([
      tag("outdated", "rnnoise@vendored-unknown — احدث: 0.1.8", { num: 1 }),
      tag("outdated", "astro@5.11.0 — احدث: 5.12.0", { num: 2 }),
      tag("security", "undefined@undefined — GHSA-1", { num: 3 }),
    ]);
    expect(cleanupMalformedOutdatedTags(data)).toBe(1);
    expect(data.tags.map(t => t.num)).toEqual([2, 3]);   // the malformed SECURITY tag survives
    expect(data.migrations?.cleanup_malformed_outdated_v1).toBe(true);
    expect(cleanupMalformedOutdatedTags(data)).toBe(0);
  });

  test("a clean store loses nothing but is still stamped", () => {
    const data = baseData([tag("security", "astro@5.12.0 — GHSA-real", { num: 1 })]);
    expect(cleanupMalformedSecurityTags(data)).toBe(0);
    expect(cleanupMalformedOutdatedTags(data)).toBe(0);
    expect(data.tags.length).toBe(1);
    expect(data.migrations?.cleanup_malformed_outdated_v2).toBe(true);
  });
});
