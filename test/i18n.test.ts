import { expect, test, describe, afterEach } from "bun:test";
import { currentLang } from "../src/i18n";

const saved = process.env.DEVLOG_LANG;
afterEach(() => {
  if (saved === undefined) delete process.env.DEVLOG_LANG;
  else process.env.DEVLOG_LANG = saved;
});

describe("currentLang", () => {
  test("defaults to English when DEVLOG_LANG is unset", () => {
    delete process.env.DEVLOG_LANG;
    expect(currentLang()).toBe("en");
  });

  test("returns Arabic for DEVLOG_LANG=ar", () => {
    process.env.DEVLOG_LANG = "ar";
    expect(currentLang()).toBe("ar");
  });

  test("accepts locale-ish Arabic values", () => {
    for (const v of ["ar-SA", "ar_EG", "AR", " ar "]) {
      process.env.DEVLOG_LANG = v;
      expect(currentLang()).toBe("ar");
    }
  });

  test("falls back to English for any other/unknown value", () => {
    for (const v of ["", "en", "fr", "xyz"]) {
      process.env.DEVLOG_LANG = v;
      expect(currentLang()).toBe("en");
    }
  });
});
