// #596: the five-file write group has no transaction, so ORDER is the
// consistency bound — the row streams (tags/events/plans) must be durable
// before the files that count or summarize them (projects' nextItemNum,
// meta's migration flags / batch fingerprints). A crash between the phases
// then only ever leaves counters BEHIND rows, the direction assignNum and
// idempotent migrations already self-heal. This pins the phase table so a
// refactor can't quietly flatten it back into one Promise.all.

import { test, expect, describe } from "bun:test";
import { WRITE_PHASES } from "../src/data";

describe("writeAllSplit phase order (#596)", () => {
  test("rows land in an earlier phase than the counter/meta files", () => {
    const phaseOf = (k: string) => WRITE_PHASES.findIndex(p => p.includes(k as never));
    for (const rows of ["tags", "events", "plans"]) {
      for (const refs of ["projects", "meta"]) {
        expect(phaseOf(rows)).toBeGreaterThanOrEqual(0);
        expect(phaseOf(refs)).toBeGreaterThan(phaseOf(rows));
      }
    }
  });

  test("every section file is written exactly once", () => {
    const flat = WRITE_PHASES.flat();
    expect([...flat].sort()).toEqual(["events", "meta", "plans", "projects", "tags"]);
    expect(new Set(flat).size).toBe(flat.length);
  });
});
