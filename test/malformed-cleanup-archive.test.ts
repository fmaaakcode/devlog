// #1016 — two halves of one defect. (1) The malformed-descriptor classifier read
// every SCOPED npm package (`@types/node@18.0.0 — …`) as malformed: the split
// landed on the scope's `@`, the name came out "" and "" is a BAD_TOKEN. The live
// store holds 17 such security/outdated tags. (2) The one-time cleanup spliced
// them with no archive, guarded only by two flags in meta.json — the file whose
// loss re-arms the cleanup. Now: scoped names parse, and the rows are archived
// FIRST; a refused archive keeps every row and leaves the migration unstamped.

import { describe, expect, test } from "bun:test";
import { DEFAULT_INJECTION_CONFIG, cleanupMalformedOutdatedTags, cleanupMalformedSecurityTags, isMalformedPkgDescriptor } from "../src/data";
import type { DevLogData, TagEntry } from "../src/types";

function tag(kind: string, content: string, num: number): TagEntry {
  return { id: `t${num}`, project: "p", tag: kind, content, num, timestamp: "2026-09-01T00:00:00.000Z" };
}
function data(tags: TagEntry[]): DevLogData {
  return {
    projects: {}, events: [], tags, plans: [], worklog: [], injections: [],
    injectionConfig: { ...DEFAULT_INJECTION_CONFIG }, projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

describe("isMalformedPkgDescriptor — scoped npm packages (#1016)", () => {
  test("a scoped package with a real version is NOT malformed", () => {
    expect(isMalformedPkgDescriptor("@types/node@18.0.0 — CVE-2024-0001")).toBe(false);
    expect(isMalformedPkgDescriptor("@biomejs/biome@2.5.11 — احدث: 2.5.12")).toBe(false);
    expect(isMalformedPkgDescriptor("@scope/pkg@1.0.0-beta.1 — GHSA-x")).toBe(false);
  });

  test("a scoped package with a bad token version is still malformed", () => {
    expect(isMalformedPkgDescriptor("@types/node@undefined — GHSA-x")).toBe(true);
    expect(isMalformedPkgDescriptor("@types/node@vendored-unknown — GHSA-x")).toBe(true);
  });

  test("the empty-name shape the fix must not lose", () => {
    expect(isMalformedPkgDescriptor("@1.0.0 — GHSA-x")).toBe(true);
    expect(isMalformedPkgDescriptor("undefined@undefined — GHSA-x")).toBe(true);
  });
});

describe("cleanup archives before it splices (#1016)", () => {
  const rows = () => [
    tag("security", "undefined@undefined — GHSA-1", 1),
    tag("security", "@types/node@18.0.0 — GHSA-real", 2),
    tag("security", "astro@5.12.0 — GHSA-real", 3),
  ];

  test("the archiver receives exactly the doomed rows, then they are removed", async () => {
    const d = data(rows());
    const seen: TagEntry[][] = [];
    const removed = await cleanupMalformedSecurityTags(d, async (r) => { seen.push(r); return true; });
    expect(removed).toBe(1);
    expect(seen.length).toBe(1);
    expect(seen[0]?.map(t => t.num)).toEqual([1]);
    expect(d.tags.map(t => t.num)).toEqual([2, 3]);      // the scoped package survives
    expect(d.migrations?.cleanup_malformed_security_v2).toBe(true);
  });

  test("a refused archive keeps every row and does NOT stamp the migration", async () => {
    const d = data(rows());
    const removed = await cleanupMalformedSecurityTags(d, async () => false);
    expect(removed).toBe(0);
    expect(d.tags.length).toBe(3);
    expect(d.migrations?.cleanup_malformed_security_v2).toBeUndefined();
    // …so the next boot retries with a working archive.
    expect(await cleanupMalformedSecurityTags(d, async () => true)).toBe(1);
  });

  test("nothing to remove → the archiver is never called, the migration is stamped", async () => {
    const d = data([tag("outdated", "@biomejs/biome@2.5.11 — احدث: 2.5.12", 1)]);
    let calls = 0;
    expect(await cleanupMalformedOutdatedTags(d, async () => { calls++; return true; })).toBe(0);
    expect(calls).toBe(0);
    expect(d.tags.length).toBe(1);
    expect(d.migrations?.cleanup_malformed_outdated_v2).toBe(true);
  });
});
