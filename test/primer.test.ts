import { expect, test, describe, afterEach } from "bun:test";
import { primerFor, PROTOCOL_PRIMER } from "../src/primer";

const savedForce = process.env.DEVLOG_INJECT_PRIMER;
afterEach(() => {
  if (savedForce === undefined) delete process.env.DEVLOG_INJECT_PRIMER;
  else process.env.DEVLOG_INJECT_PRIMER = savedForce;
});

describe("primerFor", () => {
  test("injects on SessionStart for a plugin request", () => {
    expect(primerFor("SessionStart", { plugin: true })).toBe(PROTOCOL_PRIMER);
  });

  test("stays empty for a non-plugin request (manual/dev has its own CLAUDE.md)", () => {
    delete process.env.DEVLOG_INJECT_PRIMER;
    expect(primerFor("SessionStart", { plugin: false })).toBe("");
    // Absent flag is treated as non-plugin — no primer.
    expect(primerFor("SessionStart", {})).toBe("");
  });

  test("only fires on SessionStart, not UserPromptSubmit", () => {
    expect(primerFor("UserPromptSubmit", { plugin: true })).toBe("");
    expect(primerFor("PreToolUse", { plugin: true })).toBe("");
  });

  test("DEVLOG_INJECT_PRIMER=0 forces off even for a plugin request", () => {
    process.env.DEVLOG_INJECT_PRIMER = "0";
    expect(primerFor("SessionStart", { plugin: true })).toBe("");
  });

  test("DEVLOG_INJECT_PRIMER=1 forces on even for a non-plugin request", () => {
    process.env.DEVLOG_INJECT_PRIMER = "1";
    expect(primerFor("SessionStart", { plugin: false })).toBe(PROTOCOL_PRIMER);
  });

  test("primer names the devlog-protocol skill and the closure rule", () => {
    expect(PROTOCOL_PRIMER).toContain("devlog:devlog-protocol");
    expect(PROTOCOL_PRIMER).toContain("#N");
    expect(PROTOCOL_PRIMER).toContain("-(done) #N");
  });
});
