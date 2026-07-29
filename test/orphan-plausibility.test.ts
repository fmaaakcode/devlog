// orphanCounts plausibility gate (#716 pattern): an EMPTY project registry
// beside non-empty stores means the registry itself is wounded (projects.json
// quarantined at load, or stores restored before it) — NOT a world where every
// project was deleted. Judging that state reported every live project as an
// orphan and offered the user a full-store sweep of healthy data.

import { describe, test, expect } from "bun:test";
import { orphanCounts } from "../src/maintenance";
import type { DevLogData, TagEntry } from "../src/types";

function mkData(over: Partial<DevLogData> = {}): DevLogData {
  return {
    projects: {}, events: [], tags: [], plans: [], worklog: [], injections: [],
    injectionConfig: {} as never, projectInjectionConfigs: {}, descendants: [],
    rejections: [], migrations: {}, ...over,
  } as DevLogData;
}
const tag = (project: string): TagEntry =>
  ({ id: `t${Math.random()}`, project, tag: "built", content: "x", timestamp: "2026-07-01T00:00:00Z" });

describe("orphanCounts — registry plausibility gate", () => {
  test("empty registry + populated stores → nothing reported (wounded registry, not orphans)", () => {
    const data = mkData({ tags: [tag("alive-project")] });
    expect(orphanCounts(data).size).toBe(0);
  });

  test("empty registry + empty stores → nothing reported (fresh install)", () => {
    expect(orphanCounts(mkData()).size).toBe(0);
  });

  test("a real orphan beside a registered project is still reported", () => {
    const data = mkData({
      projects: { alive: { name: "alive", path: "/x" } as never },
      tags: [tag("alive"), tag("deleted-leftover")],
    });
    const counts = orphanCounts(data);
    expect(counts.size).toBe(1);
    expect(counts.get("deleted-leftover")?.tags).toBe(1);
  });
});
