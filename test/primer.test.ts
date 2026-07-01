import { expect, test, describe, afterEach } from "bun:test";
import { primerFor, PROTOCOL_PRIMER } from "../src/primer";

const savedForce = process.env.DEVLOG_INJECT_PRIMER;
afterEach(() => {
  if (savedForce === undefined) delete process.env.DEVLOG_INJECT_PRIMER;
  else process.env.DEVLOG_INJECT_PRIMER = savedForce;
});

describe("primerFor", () => {
  test("injects on SessionStart in plugin mode", () => {
    expect(primerFor("SessionStart", { pluginMode: true })).toBe(PROTOCOL_PRIMER);
  });

  test("stays empty outside plugin mode (dev has global CLAUDE.md)", () => {
    delete process.env.DEVLOG_INJECT_PRIMER;
    expect(primerFor("SessionStart", { pluginMode: false })).toBe("");
  });

  test("only fires on SessionStart, not UserPromptSubmit", () => {
    expect(primerFor("UserPromptSubmit", { pluginMode: true })).toBe("");
    expect(primerFor("PreToolUse", { pluginMode: true })).toBe("");
  });

  test("DEVLOG_INJECT_PRIMER=0 forces off even in plugin mode", () => {
    process.env.DEVLOG_INJECT_PRIMER = "0";
    expect(primerFor("SessionStart", { pluginMode: true })).toBe("");
  });

  test("DEVLOG_INJECT_PRIMER=1 forces on outside plugin mode", () => {
    process.env.DEVLOG_INJECT_PRIMER = "1";
    expect(primerFor("SessionStart", { pluginMode: false })).toBe(PROTOCOL_PRIMER);
  });

  test("primer names the devlog-protocol skill and the closure rule", () => {
    expect(PROTOCOL_PRIMER).toContain("devlog:devlog-protocol");
    expect(PROTOCOL_PRIMER).toContain("#N");
    expect(PROTOCOL_PRIMER).toContain("-(done) #N");
  });
});
