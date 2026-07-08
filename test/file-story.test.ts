// Position memory (#486) unit tests: session→files windowing, file matching,
// story assembly, and the compact PreToolUse context.

import { describe, it, expect } from "bun:test";
import { sessionTouchedFiles, fileMatches, isNoisePath, buildFileStory, formatFileStoryContext } from "../src/file-story";
import type { DevLogData, EventEntry, TagEntry } from "../src/types";

const T0 = Date.parse("2026-07-01T10:00:00Z");
const iso = (offsetMin: number) => new Date(T0 + offsetMin * 60000).toISOString();

function ev(overrides: Partial<EventEntry>): EventEntry {
  return {
    id: crypto.randomUUID(), project: "p", event: "PostToolUse", type: "change",
    session_id: "s1", timestamp: iso(0), file_path: "D:/proj/src/a.ts", ...overrides,
  };
}
function tg(overrides: Partial<TagEntry>): TagEntry {
  return {
    id: crypto.randomUUID(), project: "p", tag: "built", content: "x",
    session_id: "s1", timestamp: iso(0), ...overrides,
  };
}
function dd(events: EventEntry[], tags: TagEntry[], projPath = "D:/proj"): DevLogData {
  return { events, tags, plans: [], worklog: [], projects: { p: { path: projPath } } } as unknown as DevLogData;
}

describe("sessionTouchedFiles", () => {
  it("collects this session's change files, deduped and normalized", () => {
    const data = dd([
      ev({ file_path: "D:\\proj\\src\\a.ts", timestamp: iso(1) }),
      ev({ file_path: "D:/proj/src/a.ts", timestamp: iso(2) }),
      ev({ file_path: "D:/proj/src/b.ts", timestamp: iso(3) }),
      ev({ file_path: "D:/proj/src/other.ts", session_id: "s2", timestamp: iso(4) }),
      ev({ file_path: "D:/proj/readonly.ts", type: "read", timestamp: iso(5) }),
    ], []);
    expect(sessionTouchedFiles(data, "s1", "p")).toEqual(["D:/proj/src/a.ts", "D:/proj/src/b.ts"]);
  });

  it("only sees files touched AFTER the session's previous tag batch", () => {
    const data = dd([
      ev({ file_path: "D:/proj/old.ts", timestamp: iso(1) }),
      ev({ file_path: "D:/proj/new.ts", timestamp: iso(10) }),
    ], [tg({ timestamp: iso(5) })]);
    expect(sessionTouchedFiles(data, "s1", "p")).toEqual(["D:/proj/new.ts"]);
  });

  it("skips noise paths and returns [] without a session id", () => {
    const data = dd([ev({ file_path: "D:/proj/node_modules/x/i.js", timestamp: iso(1) })], []);
    expect(sessionTouchedFiles(data, "s1", "p")).toEqual([]);
    expect(sessionTouchedFiles(data, undefined, "p")).toEqual([]);
  });
});

describe("fileMatches / isNoisePath", () => {
  it("matches exact, backslash, case-insensitive, and relative-suffix queries", () => {
    expect(fileMatches("D:/proj/src/a.ts", "D:\\proj\\src\\A.TS")).toBe(true);
    expect(fileMatches("D:/proj/src/a.ts", "src/a.ts")).toBe(true);
    expect(fileMatches("D:/proj/src/a.ts", "a.ts")).toBe(true);
    expect(fileMatches("D:/proj/src/xa.ts", "a.ts")).toBe(false);
    expect(fileMatches("D:/proj/src/a.ts", "b.ts")).toBe(false);
  });
  it("flags .devlog/node_modules/.git segments", () => {
    expect(isNoisePath("D:/proj/.devlog/status.md")).toBe(true);
    expect(isNoisePath("D:/proj/src/devlog.ts")).toBe(false);
  });
});

describe("buildFileStory", () => {
  it("returns matching tags and events, newest first", () => {
    const data = dd([
      ev({ file_path: "D:/proj/src/a.ts", timestamp: iso(1) }),
      ev({ file_path: "D:/proj/src/b.ts", timestamp: iso(2) }),
      ev({ file_path: "D:/proj/src/a.ts", timestamp: iso(3) }),
    ], [
      tg({ content: "first", files: ["D:/proj/src/a.ts"], timestamp: iso(2) }),
      tg({ content: "unrelated", files: ["D:/proj/src/b.ts"], timestamp: iso(3) }),
      tg({ content: "second", files: ["D:/proj/src/a.ts", "D:/proj/src/b.ts"], timestamp: iso(4) }),
    ]);
    const story = buildFileStory(data, "p", "src/a.ts");
    expect(story.tags.map(t => t.content)).toEqual(["second", "first"]);
    expect(story.events).toHaveLength(2);
    expect(story.events[0].timestamp).toBe(iso(3));
  });
});

describe("formatFileStoryContext", () => {
  it("emits a compact story with project-relative path when tags exist", () => {
    const data = dd(
      [ev({ file_path: "D:/proj/src/a.ts", timestamp: iso(1) })],
      [tg({ tag: "bug fix", content: "fixed the thing", files: ["D:/proj/src/a.ts"], timestamp: iso(2) })],
    );
    const out = formatFileStoryContext(data, "p", "D:/proj/src/a.ts");
    expect(out).toContain("📍");
    expect(out).toContain("src/a.ts");
    expect(out).not.toContain("D:/proj/src/a.ts"); // relative, not absolute
    expect(out).toContain("bug fix");
    expect(out).toContain("fixed the thing");
  });

  it("stays silent for a file with no tag history or a noise path", () => {
    const data = dd([ev({ file_path: "D:/proj/src/a.ts" })], []);
    expect(formatFileStoryContext(data, "p", "D:/proj/src/a.ts")).toBe("");
    expect(formatFileStoryContext(data, "p", "D:/proj/.devlog/status.md")).toBe("");
  });
});
