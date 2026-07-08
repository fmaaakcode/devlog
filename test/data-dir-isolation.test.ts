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
