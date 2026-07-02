import { expect, test, describe, afterEach } from "bun:test";
import { primerFor, PRIMERS } from "../src/primer";

const savedForce = process.env.DEVLOG_INJECT_PRIMER;
const savedLang = process.env.DEVLOG_LANG;
afterEach(() => {
  if (savedForce === undefined) delete process.env.DEVLOG_INJECT_PRIMER;
  else process.env.DEVLOG_INJECT_PRIMER = savedForce;
  if (savedLang === undefined) delete process.env.DEVLOG_LANG;
  else process.env.DEVLOG_LANG = savedLang;
});

describe("primerFor", () => {
  test("injects the English primer by default for a plugin request", () => {
    delete process.env.DEVLOG_LANG;
    expect(primerFor("SessionStart", { plugin: true })).toBe(PRIMERS.en);
  });

  test("injects the Arabic primer when DEVLOG_LANG=ar", () => {
    process.env.DEVLOG_LANG = "ar";
    expect(primerFor("SessionStart", { plugin: true })).toBe(PRIMERS.ar);
  });

  test("explicit lang opt overrides the environment", () => {
    process.env.DEVLOG_LANG = "ar";
    expect(primerFor("SessionStart", { plugin: true, lang: "en" })).toBe(PRIMERS.en);
  });

  test("stays empty for a non-plugin request (manual/dev has its own CLAUDE.md)", () => {
    delete process.env.DEVLOG_INJECT_PRIMER;
    expect(primerFor("SessionStart", { plugin: false })).toBe("");
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
    delete process.env.DEVLOG_LANG;
    expect(primerFor("SessionStart", { plugin: false })).toBe(PRIMERS.en);
  });

  test("both primers name the devlog-protocol skill and the closure rule", () => {
    for (const p of [PRIMERS.en, PRIMERS.ar]) {
      expect(p).toContain("devlog:devlog-protocol");
      expect(p).toContain("#N");
      expect(p).toContain("-(done) #N");
    }
  });
});
