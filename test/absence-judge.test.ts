// The absence judge and its two consumers (#858 — family of #856 and #576: a
// generated record outliving the reality it describes).
//
// What is pinned here is the pair of rules that keep the record honest, tested by
// fault injection rather than on a happy path (verification #2):
//   · absence is CLAIMED, presence is never claimed (true | undefined, no false)
//   · an absent project ROOT disables every claim — one unplugged drive must not
//     stamp a whole history as deleted
//   · a deleted file is LABELLED, never dropped: its recorded history is real
//
// Runs standalone: the probe is injected, so no disk is needed except in the one
// test that deliberately uses a real temp tree.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAbsenceJudge } from "../src/path-utils";
import { diskExists } from "../src/disk-probe";
import { fragileFiles } from "../src/retro";
import { buildFileWhy } from "../src/file-why";

const ROOT = "D:/proj";
/** A probe over a fixed set of "existing" paths. */
const probeOf = (present: string[]) => (p: string) => present.includes(p);

describe("makeAbsenceJudge", () => {
  test("a missing file is claimed gone", () => {
    const judge = makeAbsenceJudge(ROOT, probeOf([ROOT, `${ROOT}/src/kept.ts`]));
    expect(judge(`${ROOT}/src/ghost.ts`)).toBe(true);
  });

  test("an existing file is UNJUDGED, not confirmed present", () => {
    const judge = makeAbsenceJudge(ROOT, probeOf([ROOT, `${ROOT}/src/kept.ts`]));
    // Deliberately not `false`: today's presence says nothing about whether this
    // release deleted the file and a later one restored it.
    expect(judge(`${ROOT}/src/kept.ts`)).toBeUndefined();
  });

  test("an absent project root disables ALL claims", () => {
    const judge = makeAbsenceJudge(ROOT, probeOf([]));   // even the root is gone
    expect(judge(`${ROOT}/src/ghost.ts`)).toBeUndefined();
  });

  test("no root at all claims nothing", () => {
    expect(makeAbsenceJudge("", probeOf([]))(`${ROOT}/x.ts`)).toBeUndefined();
  });

  test("a relative path (older stores) is unjudged — it cannot be probed", () => {
    const judge = makeAbsenceJudge(ROOT, probeOf([ROOT]));
    expect(judge("src/ghost.ts")).toBeUndefined();
  });

  test("backslash spelling is judged like its forward-slash twin", () => {
    const judge = makeAbsenceJudge("D:\\proj", probeOf([ROOT]));
    expect(judge("D:\\proj\\src\\ghost.ts")).toBe(true);
  });

  test("diskExists fails OPEN on anything that is not a plain ENOENT", () => {
    // A null byte is not a path at all: the syscall fails with an argument error,
    // not ENOENT. Anything but "not there" must read as "exists" — this is why
    // the probe uses statSync and not existsSync, which swallows every error into
    // `false` and would publish a permission denial as a deletion.
    expect(diskExists("D:/proj/\u0000bad")).toBe(true);
  });

  test("diskExists answers false only for a genuinely absent path", () => {
    expect(diskExists(join(tmpdir(), "absence-definitely-not-here-8Qz"))).toBe(false);
  });
});

describe("«الأكثر كسرًا» labels a deleted file (#858)", () => {
  // Tags store ABSOLUTE paths (the corpus converts them to project-relative);
  // the fixture mirrors that instead of inventing a shape.
  const data = (): any => ({
    projects: { p: { path: ROOT } },
    tags: [
      { tag: "bug found", project: "p", num: 1, content: "one", files: [`${ROOT}/src/ghost.ts`, `${ROOT}/src/kept.ts`], timestamp: "2026-08-01T00:00:00Z" },
      { tag: "bug found", project: "p", num: 2, content: "two", files: [`${ROOT}/src/ghost.ts`, `${ROOT}/src/kept.ts`], timestamp: "2026-08-03T00:00:00Z" },
    ],
    events: [], plans: [],
  });

  test("the gone file keeps its counts and gains the label; the survivor has none", () => {
    const judge = makeAbsenceJudge(ROOT, probeOf([ROOT, `${ROOT}/src/kept.ts`]));
    const rows = fragileFiles(data(), "p", 5, judge);
    const byFile = Object.fromEntries(rows.map(r => [r.file, r]));
    expect(byFile["src/ghost.ts"]?.missing).toBe(true);
    expect(byFile["src/ghost.ts"]?.count).toBe(2);        // history intact
    expect(byFile["src/kept.ts"]?.missing).toBeUndefined();
  });

  test("without a judge nothing is labelled — the old callers keep their shape", () => {
    expect(fragileFiles(data(), "p").every(r => r.missing === undefined)).toBe(true);
  });
});

describe("ask:why says the path is gone (#858)", () => {
  const data = (): any => ({
    projects: { p: { path: ROOT } },
    tags: [{ tag: "decision", project: "p", content: "chose X over Y", files: [`${ROOT}/src/ghost.ts`], timestamp: "2026-08-01T00:00:00Z" }],
    events: [], plans: [],
  });

  test("the flag reaches the dossier without touching its history", () => {
    const why = buildFileWhy(data(), "p", `${ROOT}/src/ghost.ts`, undefined, true);
    expect(why.missing).toBe(true);
    expect(why.empty).toBe(false);
    expect(why.decisions.length).toBe(1);      // the record still answers
  });

  test("unflagged dossiers claim nothing", () => {
    expect(buildFileWhy(data(), "p", `${ROOT}/src/ghost.ts`).missing).toBeUndefined();
  });
});

describe("the real probe on a real tree", () => {
  test("present vs absent, judged through diskExists", () => {
    const dir = mkdtempSync(join(tmpdir(), "absence-"));
    try {
      writeFileSync(join(dir, "kept.ts"), "export const a = 1;\n");
      const judge = makeAbsenceJudge(dir, diskExists);
      expect(judge(join(dir, "ghost.ts").replace(/\\/g, "/"))).toBe(true);
      expect(judge(join(dir, "kept.ts").replace(/\\/g, "/"))).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
