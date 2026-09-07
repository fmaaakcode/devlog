// #1061 / #1062 — the process tree trusts a parent link only when the parent
// provably started before the child, and a stored row is "the same process"
// only when pid AND start time match. Both were pid-only before: a short-lived
// hook shell inherited a dead smss's pid (1072) and BFS swallowed csrss →
// wininit → services → lsass under a Claude session (153 live "orphans",
// kill buttons included). Pure functions, no WMI.

import { describe, expect, test } from "bun:test";
import { buildDescendantTree, isTrustedParent, pruneDescendantsAgainst, sameProcess, type WinProc } from "../src/sessions";
import type { DescendantProcess } from "../src/types";

const P = (pid: number, ppid: number, name: string, created: number): WinProc => ({ pid, ppid, name, command: "", created });
const SELF = 999_999;

describe("buildDescendantTree (#1061)", () => {
  test("a recycled parent pid does not adopt the system tree", () => {
    // claude(4768) started at t=100; its hook shell (1072) at t=500. csrss/wininit
    // were spawned at boot (t=10) by the ORIGINAL 1072 (smss, long dead).
    const procs = [
      P(4768, 1, "claude.exe", 100),
      P(1072, 4768, "bash.exe", 500),
      P(1244, 1072, "csrss.exe", 10),
      P(1340, 1072, "wininit.exe", 11),
      P(1424, 1340, "services.exe", 12),
      P(1444, 1340, "lsass.exe", 12),
      P(7000, 1072, "bun.exe", 600),          // the hook's real child
    ];
    const tree = buildDescendantTree([4768], procs, SELF);
    expect(tree.get(4768)).toEqual([1072, 7000]);
  });

  test("a parent with an unknown start time is not trusted (kill-path safe default)", () => {
    const procs = [P(1, 0, "claude.exe", 100), P(2, 1, "child.exe", 0), P(3, 2, "grandchild.exe", 300)];
    // 2's own start is unknown → 1→2 rejected; 2→3 rejected too (parent unknown).
    expect(buildDescendantTree([1], procs, SELF).get(1)).toEqual([]);
  });

  test("the server's own pid is never an ancestor and never a descendant", () => {
    const procs = [P(1, 0, "claude.exe", 100), P(SELF, 1, "bun.exe", 200), P(5, SELF, "powershell.exe", 300)];
    expect(buildDescendantTree([1], procs, SELF).get(1)).toEqual([]);
  });

  test("a genuine chain (each parent older than its child) is kept in full", () => {
    const procs = [P(1, 0, "claude.exe", 100), P(2, 1, "bash.exe", 200), P(3, 2, "node.exe", 300), P(4, 3, "esbuild.exe", 300)];
    expect(buildDescendantTree([1], procs, SELF).get(1)).toEqual([2, 3, 4]);
  });

  test("isTrustedParent: equal start times pass (same tick), reversed order fails", () => {
    const parent = P(1, 0, "a", 100);
    expect(isTrustedParent(parent, P(2, 1, "b", 100), SELF)).toBe(true);
    expect(isTrustedParent(parent, P(2, 1, "b", 99), SELF)).toBe(false);
    expect(isTrustedParent(undefined, P(2, 1, "b", 99), SELF)).toBe(false);
  });
});

describe("sameProcess / pruneDescendantsAgainst (#1062)", () => {
  const row = (pid: number, created?: number): DescendantProcess => ({
    pid, name: "x.exe", command: "", parentPid: 1, claudePid: 1, sessionId: "s", project: "p",
    firstSeen: "2026-09-06T00:00:00.000Z", lastSeen: "2026-09-06T00:00:00.000Z", orphaned: false,
    ...(created !== undefined ? { created } : {}),
  });

  test("same pid, different start time → a stranger, not the tracked process", () => {
    expect(sameProcess(row(10, 100), P(10, 1, "x.exe", 100))).toBe(true);
    expect(sameProcess(row(10, 100), P(10, 1, "x.exe", 777))).toBe(false);
    expect(sameProcess(row(10, 100), undefined)).toBe(false);
  });

  test("rows without a stored start time cannot be re-identified and are dropped", () => {
    expect(sameProcess(row(10), P(10, 1, "x.exe", 100))).toBe(false);
  });

  test("prune keeps only rows whose live process is the same one, marked orphaned", () => {
    const living = new Map<number, WinProc>([[10, P(10, 1, "x.exe", 100)], [11, P(11, 1, "y.exe", 555)], [1244, P(1244, 1072, "csrss.exe", 10)]]);
    const kept = pruneDescendantsAgainst([row(10, 100), row(11, 111), row(12, 100), row(1244)], living, "now");
    expect(kept.map(d => d.pid)).toEqual([10]);
    expect(kept[0]?.orphaned).toBe(true);
    expect(kept[0]?.lastSeen).toBe("now");
  });
});
