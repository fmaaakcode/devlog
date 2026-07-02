// Pins the softFail contract (report fable/index.html #4): a no-op by default
// so best-effort catch sites stay quiet, but one diagnostic line under
// DEVLOG_DEBUG=1 so a swallowed failure is observable when you ask for it.
import { test, expect, describe, afterEach } from "bun:test";
import { softFail } from "../src/soft-fail";

describe("softFail", () => {
  const prev = process.env.DEVLOG_DEBUG;
  let warns: string[] = [];
  const orig = console.warn;

  afterEach(() => {
    console.warn = orig;
    if (prev === undefined) delete process.env.DEVLOG_DEBUG;
    else process.env.DEVLOG_DEBUG = prev;
    warns = [];
  });

  test("silent when DEVLOG_DEBUG is unset", () => {
    delete process.env.DEVLOG_DEBUG;
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    softFail("scope.x", new Error("boom"));
    expect(warns.length).toBe(0);
  });

  test("silent when DEVLOG_DEBUG is not exactly '1'", () => {
    process.env.DEVLOG_DEBUG = "true";
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    softFail("scope.x", new Error("boom"));
    expect(warns.length).toBe(0);
  });

  test("logs scope + message under DEVLOG_DEBUG=1", () => {
    process.env.DEVLOG_DEBUG = "1";
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    softFail("tree.buildTree", new Error("EACCES: permission denied"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("soft-fail tree.buildTree");
    expect(warns[0]).toContain("EACCES");
  });

  test("stringifies non-Error values", () => {
    process.env.DEVLOG_DEBUG = "1";
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    softFail("scope.y", "plain string failure");
    expect(warns[0]).toContain("plain string failure");
  });
});
