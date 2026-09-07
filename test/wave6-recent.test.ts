// Wave 6 (#1138): `ask:recent` and the retention window. The hot store keeps
// ~200 events per project, so a session older than a handful used to read "no
// files, no commands" — as if it had touched nothing. Now: (1) the digest says
// UNKNOWN when a session's events fell outside the hot window and nothing was
// supplied for it, (2) cold-archive events the route loads are merged (deduped
// by id against the hot store), and (3) the month/window helpers the route
// uses to decide which archive months to open are pinned.

import { describe, expect, test } from "bun:test";
import { archiveMonthsFor, buildRecent, recentWindowStart } from "../src/recent";
import type { EventEntry, TagEntry } from "../src/types";

const ROOT = "D:/proj";
const NOW = Date.now();
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

let seq = 0;
const tag = (session_id: string, daysAgo: number, content = "did a thing"): TagEntry =>
  ({ id: `t${++seq}`, project: "p", tag: "built", content, timestamp: at(daysAgo), session_id });
const edit = (session_id: string, daysAgo: number, file: string, id = `e${++seq}`): EventEntry =>
  ({ id, project: "p", event: "PostToolUse", tool: "Edit", type: "change", file_path: `${ROOT}/${file}`,
     timestamp: at(daysAgo), session_id, lines_added: 3, lines_removed: 1 } as EventEntry);

const data = (tags: TagEntry[], events: EventEntry[]): any =>
  ({ projects: { p: { name: "p", path: ROOT } }, tags, events, plans: [], worklog: [], prompts: [] });

describe("buildRecent — retention honesty (#1138)", () => {
  test("a session older than the hot window with no events is UNKNOWN, a recent silent one is known-empty", () => {
    const d = data(
      [tag("old", 40), tag("recent-silent", 1), tag("recent-busy", 2)],
      [edit("recent-busy", 2, "src/a.ts")],   // the oldest hot event is 2 days old
    );
    const digest = buildRecent(d, "p", { sessions: 3 });
    const by = Object.fromEntries(digest.sessions.map(s => [s.sessionId, s]));
    expect(by.old.files).toEqual([]);
    expect(by.old.eventsKnown).toBe(false);          // retention, not idleness
    expect(by["recent-silent"].eventsKnown).toBe(true); // the store would still hold its events
    expect(by["recent-busy"].eventsKnown).toBe(true);
  });

  test("archived events fill an old session's files and commands; a hot∩archive twin counts once", () => {
    const hot = edit("recent", 1, "src/hot.ts", "shared-id");
    const d = data([tag("old", 40), tag("recent", 1)], [hot]);
    const archived: EventEntry[] = [
      edit("old", 40, "src/checkout.ts"),
      edit("old", 40, "src/checkout.ts"),
      { ...edit("old", 40, "x"), type: "command", file_path: undefined, command: "bun test", ok: false, description: "run tests" } as EventEntry,
      { ...hot },                                        // the same row, still in the hot store too
    ];
    const digest = buildRecent(d, "p", { sessions: 2, archivedEvents: archived });
    const by = Object.fromEntries(digest.sessions.map(s => [s.sessionId, s]));
    expect(by.old.eventsKnown).toBe(true);
    expect(by.old.files).toEqual([{ path: "src/checkout.ts", edits: 2, linesAdded: 6, linesRemoved: 2 }]);
    expect(by.old.commands).toEqual({ total: 1, failed: 1, failedSamples: ["run tests"] });
    expect(by.recent.files[0]?.edits).toBe(1);        // not doubled by the archived twin
  });

  test("a project with no hot events at all treats every session as known (nothing was ever retained to lose)", () => {
    const digest = buildRecent(data([tag("s1", 3)], []), "p", { sessions: 1 });
    expect(digest.sessions[0].eventsKnown).toBe(true);
  });
});

describe("archive window helpers (#1138)", () => {
  test("archiveMonthsFor lists every month from the window start through now, oldest first", () => {
    const now = +new Date("2026-09-06T10:00:00Z");
    expect(archiveMonthsFor(+new Date("2026-07-20T00:00:00Z"), now)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(archiveMonthsFor(+new Date("2026-09-01T00:00:00Z"), now)).toEqual(["2026-09"]);
  });

  test("recentWindowStart: a day window counts back from now; a session window starts at the oldest picked session", () => {
    const now = +new Date("2026-09-06T00:00:00Z");
    const days = { project: "p", window: { days: 7 }, sessions: [], olderSessions: 0 } as any;
    expect(recentWindowStart(days, now)).toBe(now - 7 * DAY);
    const sessions = { project: "p", window: { sessions: 2 }, olderSessions: 0, sessions: [
      { start: "2026-09-05T00:00:00Z" }, { start: "2026-08-30T12:00:00Z" },
    ] } as any;
    expect(recentWindowStart(sessions, now)).toBe(+new Date("2026-08-30T12:00:00Z"));
  });
});
