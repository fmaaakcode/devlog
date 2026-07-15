// Unit tests for the feature inventory (src/features.ts): list resolution
// (update text override, removal, release attribution incl. the same-ms batch
// case), the since-last-release counters behind the release nudge, and the
// reference diagnosis that keeps junk `#N` feature tags out of the store.

import { describe, test, expect, beforeAll } from "bun:test";
import type { DevLogData, ProjectProfile, TagEntry } from "../src/types";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import {
  featureList, featuresSinceLastRelease, diagnoseFeatureRef, stripFeatureRef, featureRefNum,
  backfillCorpus,
} from "../src/features";

beforeAll(() => { process.env.DEVLOG_LANG = "en"; });

const P = "featproj";

function profile(): ProjectProfile {
  return {
    name: P, path: "D:/tmp/featproj", description: "", blueprint: [],
    language: "TypeScript", framework: "", libraries: [], files: {},
    directories: [], totalFiles: 0, lastScan: "",
  };
}

function makeData(tags: TagEntry[]): DevLogData {
  return {
    projects: { [P]: profile() }, tags, events: [], plans: [], worklog: [],
    injections: [], injectionConfig: { ...DEFAULT_INJECTION_CONFIG },
    projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {},
  };
}

let seq = 0;
function t(tag: string, content: string, opts: { num?: number; ts?: string } = {}): TagEntry {
  return {
    id: `t${++seq}`, project: P, tag, content,
    timestamp: opts.ts ?? new Date(1700000000000 + seq * 60_000).toISOString(),
    ...(typeof opts.num === "number" ? { num: opts.num } : {}),
  };
}

describe("featureList", () => {
  test("lists features; the latest -(feature update) overrides the text", () => {
    const data = makeData([
      t("feature", "supports Apple Pay", { num: 1 }),
      t("feature", "exports PDF reports", { num: 2 }),
      t("feature update", "#2 exports PDF and Excel reports"),
    ]);
    const list = featureList(data, P);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ num: 1, text: "supports Apple Pay" });
    expect(list[1]).toMatchObject({ num: 2, text: "exports PDF and Excel reports" });
    expect(list[1].updatedAt).toBeTruthy();
  });

  test("-(feature removed) #N drops the feature from the current list", () => {
    const data = makeData([
      t("feature", "legacy import wizard", { num: 3 }),
      t("feature", "kept capability", { num: 4 }),
      t("feature removed", "#3 replaced by the new importer"),
    ]);
    const list = featureList(data, P);
    expect(list).toHaveLength(1);
    expect(list[0].num).toBe(4);
  });

  test("attributes each feature to the first release cut after it landed", () => {
    const data = makeData([
      t("feature", "shipped in v1", { num: 5, ts: "2026-01-01T00:00:00.000Z" }),
      t("release", "v1.0.0 — first", { ts: "2026-01-02T00:00:00.000Z" }),
      t("feature", "unreleased yet", { num: 6, ts: "2026-01-03T00:00:00.000Z" }),
    ]);
    const list = featureList(data, P);
    expect(list[0].sinceVersion).toBe("v1.0.0");
    expect(list[1].sinceVersion).toBeUndefined();
  });

  test("a feature sharing its release's millisecond (same batch) still ships in it", () => {
    const ms = "2026-02-01T00:00:00.000Z";
    const data = makeData([
      t("feature", "same-batch capability", { num: 7, ts: ms }),
      t("release", "v2.0.0 — batch", { ts: ms }),
    ]);
    expect(featureList(data, P)[0].sinceVersion).toBe("v2.0.0");
  });

  test("ignores placeholder release versions when attributing", () => {
    const data = makeData([
      t("feature", "cap", { num: 8, ts: "2026-01-01T00:00:00.000Z" }),
      t("release", "vX.Y.Z — placeholder", { ts: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(featureList(data, P)[0].sinceVersion).toBeUndefined();
  });

  test("an explicit [vX.Y.Z] marker pins the capability to that past release", () => {
    const data = makeData([
      t("release", "v1.0.0 — first", { ts: "2026-01-01T00:00:00.000Z" }),
      t("release", "v2.0.0 — second", { ts: "2026-02-01T00:00:00.000Z" }),
      // declared AFTER v2.0.0, marker written without the v prefix on purpose
      t("feature", "[1.0.0] users can export data", { num: 10, ts: "2026-03-01T00:00:00.000Z" }),
    ]);
    const list = featureList(data, P);
    expect(list[0].text).toBe("users can export data");
    expect(list[0].sinceVersion).toBe("v1.0.0");   // resolved to the recorded spelling
  });

  test("a marker naming no recorded release is kept as written", () => {
    const data = makeData([
      t("feature", "[v9.9.9] imported from elsewhere", { num: 11 }),
    ]);
    expect(featureList(data, P)[0].sinceVersion).toBe("v9.9.9");
  });
});

describe("featuresSinceLastRelease", () => {
  test("counts built/update after the last release; features separately", () => {
    const data = makeData([
      t("built", "old work", { ts: "2026-01-01T00:00:00.000Z" }),
      t("release", "v1.0.0 — r", { ts: "2026-01-02T00:00:00.000Z" }),
      t("built", "new work", { ts: "2026-01-03T00:00:00.000Z" }),
      t("update", "dep bump", { ts: "2026-01-04T00:00:00.000Z" }),
      t("refactor", "not counted", { ts: "2026-01-05T00:00:00.000Z" }),
    ]);
    expect(featuresSinceLastRelease(data, P)).toEqual({ built: 2, features: 0 });
  });

  test("no release yet → everything counts", () => {
    const data = makeData([
      t("built", "work"),
      t("feature", "declared capability", { num: 1 }),
    ]);
    expect(featuresSinceLastRelease(data, P)).toEqual({ built: 1, features: 1 });
  });

  test("a [vX.Y.Z] backfill declaration never satisfies the nudge", () => {
    const data = makeData([
      t("release", "v1.0.0 — r", { ts: "2026-01-02T00:00:00.000Z" }),
      t("built", "new work", { ts: "2026-01-03T00:00:00.000Z" }),
      t("feature", "[v1.0.0] old capability", { num: 2, ts: "2026-01-04T00:00:00.000Z" }),
    ]);
    expect(featuresSinceLastRelease(data, P)).toEqual({ built: 1, features: 0 });
  });
});

describe("backfillCorpus", () => {
  test("lists releases no capability is attributed to, with their material", () => {
    const data = makeData([
      t("built", "wired the export pipeline", { ts: "2026-01-01T00:00:00.000Z" }),
      t("release", "v1.0.0 — export", { ts: "2026-01-02T00:00:00.000Z" }),
      t("feature", "covered capability", { num: 1, ts: "2026-02-01T00:00:00.000Z" }),
      t("release", "v2.0.0 — covered", { ts: "2026-02-02T00:00:00.000Z" }),
    ]);
    const c = backfillCorpus(data, P);
    expect(c.totalReleases).toBe(2);
    expect(c.uncovered).toHaveLength(1);
    expect(c.uncovered[0]).toMatchObject({ version: "v1.0.0", summary: "export" });
    expect(c.uncovered[0].material).toEqual(["wired the export pipeline"]);
  });

  test("a later-removed feature still covers its release", () => {
    const data = makeData([
      t("feature", "retired capability", { num: 2, ts: "2026-01-01T00:00:00.000Z" }),
      t("release", "v1.0.0 — r", { ts: "2026-01-02T00:00:00.000Z" }),
      t("feature removed", "#2", { ts: "2026-01-03T00:00:00.000Z" }),
    ]);
    expect(backfillCorpus(data, P).uncovered).toHaveLength(0);
  });

  test("a [vX.Y.Z] backfill declaration covers the named release", () => {
    const data = makeData([
      t("release", "v1.0.0 — r", { ts: "2026-01-02T00:00:00.000Z" }),
      t("feature", "[v1.0.0] backfilled", { num: 3, ts: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(backfillCorpus(data, P).uncovered).toHaveLength(0);
  });

  // #617: declared then removed BEFORE the cut — featureList had already
  // dropped it, so that release shipped with no capability line and must
  // stay in the backfill list.
  test("a feature removed before its release was cut does NOT cover it", () => {
    const data = makeData([
      t("feature", "never shipped", { num: 4, ts: "2026-01-01T00:00:00.000Z" }),
      t("feature removed", "#4", { ts: "2026-01-01T12:00:00.000Z" }),
      t("built", "technical work", { ts: "2026-01-01T13:00:00.000Z" }),
      t("release", "v1.0.0 — r", { ts: "2026-01-02T00:00:00.000Z" }),
    ]);
    const c = backfillCorpus(data, P);
    expect(c.uncovered).toHaveLength(1);
    expect(c.uncovered[0].version).toBe("v1.0.0");
  });

  test("a removed [vX.Y.Z] backfill declaration keeps covering (deliberate retirement)", () => {
    const data = makeData([
      t("release", "v1.0.0 — r", { ts: "2026-01-02T00:00:00.000Z" }),
      t("feature", "[v1.0.0] backfilled", { num: 5, ts: "2026-03-01T00:00:00.000Z" }),
      t("feature removed", "#5", { ts: "2026-03-02T00:00:00.000Z" }),
    ]);
    expect(backfillCorpus(data, P).uncovered).toHaveLength(0);
  });

  test("material is capped with a remainder count", () => {
    const tags = [...Array(8)].map((_, i) =>
      t("built", `work ${i}`, { ts: `2026-01-01T0${i}:00:00.000Z` }));
    tags.push(t("release", "v1.0.0 — big", { ts: "2026-01-02T00:00:00.000Z" }));
    const c = backfillCorpus(makeData(tags), P);
    expect(c.uncovered[0].material).toHaveLength(6);
    expect(c.uncovered[0].materialMore).toBe(2);
  });
});

describe("diagnoseFeatureRef", () => {
  const base = () => makeData([
    t("feature", "cap A", { num: 1 }),
    t("feature", "cap B", { num: 2 }),
    t("feature removed", "#2"),
  ]);

  test("valid update passes", () => {
    expect(diagnoseFeatureRef("feature update", "#1 cap A refined", base(), P)).toBeNull();
  });
  test("non-feature tags pass through", () => {
    expect(diagnoseFeatureRef("built", "#999 whatever", base(), P)).toBeNull();
  });
  test("missing #N → no-ref", () => {
    expect(diagnoseFeatureRef("feature removed", "cap A", base(), P)).toMatchObject({ kind: "no-ref" });
  });
  test("update without new text → no-text", () => {
    expect(diagnoseFeatureRef("feature update", "#1", base(), P)).toMatchObject({ kind: "no-text", num: 1 });
  });
  test("unknown number → no-match", () => {
    expect(diagnoseFeatureRef("feature removed", "#99", base(), P)).toMatchObject({ kind: "no-match", num: 99 });
  });
  test("referencing a removed feature → already-removed", () => {
    expect(diagnoseFeatureRef("feature update", "#2 revived text", base(), P)).toMatchObject({ kind: "already-removed", num: 2 });
  });
});

describe("ref parsing helpers", () => {
  test("stripFeatureRef removes the leading #N and separators", () => {
    expect(stripFeatureRef("#5 — new wording")).toBe("new wording");
    expect(stripFeatureRef("#5: new wording")).toBe("new wording");
    expect(stripFeatureRef("#5")).toBe("");
  });
  test("featureRefNum reads exactly one leading number", () => {
    expect(featureRefNum("#5 tail")).toBe(5);
    expect(featureRefNum("#5 #6 tail")).toBeNull();
    expect(featureRefNum("no ref")).toBeNull();
  });
});
