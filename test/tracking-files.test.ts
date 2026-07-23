// Unit tests for the tracking-file signature list (#676 + the PreToolUse
// tracking gate). The list must catch exactly the manual-tracking shapes
// (tasks/TODO/decisions/CHANGELOG/MEMORY/plans .md) and NOTHING else — ordinary
// docs, code, and harness-internal trees (.claude auto-memory!) stay silent.

import { describe, test, expect } from "bun:test";
import { isTrackingFile, trackingTagFor } from "../src/tracking-files";

describe("isTrackingFile", () => {
  test("catches the Superpowers incident's exact files", () => {
    expect(isTrackingFile("doc/tasks.md")).toBe(true);
    expect(isTrackingFile("doc/decisions.md")).toBe(true);
    expect(isTrackingFile("plans/phase-1.md")).toBe(true);
    expect(isTrackingFile("MEMORY.md")).toBe(true);
  });

  test("basenames match case-insensitively and at any depth, both slash styles", () => {
    expect(isTrackingFile("TODO.md")).toBe(true);
    expect(isTrackingFile("src/deep/Todos.MD")).toBe(true);
    expect(isTrackingFile("D:\\proj\\CHANGELOG.md")).toBe(true);
    expect(isTrackingFile("a/b/plans/x/y.md")).toBe(true);
  });

  test("ordinary markdown never trips it", () => {
    expect(isTrackingFile("README.md")).toBe(false);
    expect(isTrackingFile("docs/architecture.md")).toBe(false);
    expect(isTrackingFile("CONTRIBUTING.md")).toBe(false);
  });

  test("only .md counts — a tasks.json or plans/*.ts is not a tracking doc", () => {
    expect(isTrackingFile("tasks.json")).toBe(false);
    expect(isTrackingFile("plans/build.ts")).toBe(false);
  });

  test("name fragments do not match — narrow list, not substrings", () => {
    expect(isTrackingFile("my-tasks-notes.md")).toBe(false);
    expect(isTrackingFile("decision-record-001.md")).toBe(false);
  });

  test("harness/tool-internal trees are exempt — .claude auto-memory above all", () => {
    expect(isTrackingFile("C:/Users/x/.claude/projects/p/memory/MEMORY.md")).toBe(false);
    expect(isTrackingFile(".devlog/plans/cache.md")).toBe(false);
    expect(isTrackingFile("node_modules/pkg/CHANGELOG.md")).toBe(false);
  });

  test("empty / garbage input stays false", () => {
    expect(isTrackingFile("")).toBe(false);
    expect(isTrackingFile("/")).toBe(false);
  });
});

describe("trackingTagFor", () => {
  test("maps each family to its replacing tag", () => {
    expect(trackingTagFor("doc/tasks.md")).toBe("-(todo)");
    expect(trackingTagFor("TODO.md")).toBe("-(todo)");
    expect(trackingTagFor("decisions.md")).toBe("-(decision)");
    expect(trackingTagFor("CHANGELOG.md")).toBe("-(release)");
    expect(trackingTagFor("MEMORY.md")).toBe("-(note)/-(decision)");
    expect(trackingTagFor("plans/phase-1.md")).toBe("-(doc:plan)");
  });
});
