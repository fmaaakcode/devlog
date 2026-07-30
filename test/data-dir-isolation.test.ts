// Guards the [test].preload data isolation: if someone removes the preload
// from bunfig.toml (or data.ts stops honoring DEVLOG_DATA_DIR), DATA_DIR
// falls back to a real location — the user-wide DEVLOG_DATA_DIR (the live
// production data) or the in-repo .devlog-data — and every e2e suite starts
// clobbering it again. This asserts the dir the whole process captured is
// the preload's throwaway temp dir and nothing else.
import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../src/data";
import { assertTestDataDirIsolated } from "../src/data-guard";

describe("test data-dir isolation", () => {
  test("DATA_DIR is the preload's throwaway temp dir", () => {
    expect(DATA_DIR.startsWith(tmpdir())).toBe(true);
    expect(DATA_DIR).toContain("devlog-test-data-");
  });

  test("DATA_DIR is neither the live user dir nor the in-repo default", () => {
    expect(DATA_DIR).not.toBe(join(homedir(), ".devlog", "data"));
    expect(DATA_DIR).not.toContain(".devlog-data");
  });
});

// The module-load guard in data.ts — the layer that acts BEFORE damage, unlike
// the assertions above which only detect it after the alphabetically-earlier
// suites already wrote. Live incident 2026-07-30: `bun test` from test/ loads
// no bunfig preload, inherits the user-wide LIVE dir, and clobbered tags.json.
describe("assertTestDataDirIsolated (module-load guard)", () => {
  test("test env + non-temp data dir → refuses", () => {
    expect(() => assertTestDataDirIsolated("test", join(homedir(), ".devlog", "data"), tmpdir()))
      .toThrow(/non-temporary data dir/);
  });

  test("test env + temp data dir → allowed (slash/case tolerant)", () => {
    const tmp = join(tmpdir(), "devlog-test-data-xyz");
    expect(() => assertTestDataDirIsolated("test", tmp.replace(/\\/g, "/").toUpperCase(), tmpdir())).not.toThrow();
  });

  test("non-test env never interferes, whatever the dir", () => {
    expect(() => assertTestDataDirIsolated(undefined, join(homedir(), ".devlog", "data"), tmpdir())).not.toThrow();
    expect(() => assertTestDataDirIsolated("production", "D:/x/.devlog-data", tmpdir())).not.toThrow();
  });
});
