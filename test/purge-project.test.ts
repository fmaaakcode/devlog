// Regression for the delete-remnants bug: purgeProjectData originally swept
// only the four bulk arrays (tags/plans/events/worklog), so a deleted project
// left its injections, rejections, and meta.json injection-config key behind
// forever. The purge must clear every per-project store in DevLogData.

import { describe, it, expect } from "bun:test";
import { purgeProjectData } from "../src/maintenance";
import type { DevLogData } from "../src/types";

const NOW = new Date().toISOString();

function row(project: string) {
  return { id: crypto.randomUUID(), project, timestamp: NOW };
}

function makeData(): DevLogData {
  const both = (make: (p: string) => unknown) => [make("doomed"), make("survivor")];
  return {
    projects: {},
    tags: both(p => ({ ...row(p), tag: "note", content: "x" })),
    plans: both(p => ({ ...row(p), title: "t", file: "t.md", steps: [], updatedAt: NOW })),
    events: both(p => ({ ...row(p), event: "PostToolUse", type: "change" })),
    worklog: both(p => ({ ...row(p), summary: "s" })),
    injections: both(p => ({ ...row(p), type: "SessionStart", content: "c", chars: 1 })),
    injectionConfig: {} as DevLogData["injectionConfig"],
    projectInjectionConfigs: { doomed: { primer: false }, survivor: { primer: true } },
    descendants: [],
    rejections: both(p => ({ ...row(p), reason: "r", detail: "d" })),
  } as unknown as DevLogData;
}

describe("purgeProjectData sweeps every per-project store", () => {
  it("clears injections, rejections, and the injection-config key — not just the bulk arrays", () => {
    const data = makeData();

    const removed = purgeProjectData(data, new Set(["doomed"]));

    for (const store of ["tags", "plans", "events", "worklog", "injections", "rejections"] as const) {
      const rows = data[store] as Array<{ project: string }>;
      expect(rows.map(r => r.project)).toEqual(["survivor"]);
    }
    expect(Object.keys(data.projectInjectionConfigs)).toEqual(["survivor"]);
    expect(removed).toBe(7); // 6 rows + 1 config key
  });

  it("tolerates a store snapshot with no rejections field", () => {
    const data = makeData();
    delete (data as { rejections?: unknown }).rejections;

    expect(() => purgeProjectData(data, new Set(["doomed"]))).not.toThrow();
    expect(data.tags.map(t => t.project)).toEqual(["survivor"]);
  });

  it("returns 0 and touches nothing for an empty gone-set", () => {
    const data = makeData();
    expect(purgeProjectData(data, new Set())).toBe(0);
    expect(data.tags.length).toBe(2);
  });
});
