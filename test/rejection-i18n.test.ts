// Guards the English-first policy for tags-service rejection messages (plan
// fable/round2 task 1.3). The `undo-ambiguous` rejection used to be hard-coded
// Arabic, so an English user who typed an ambiguous `-(undo)` got an Arabic
// error. It now flows through L(en, ar); this pins both branches so a future
// hard-coding regresses a test instead of shipping.

import { test, expect, describe, afterEach } from "bun:test";
import { applyUndo } from "../src/undo";
import type { DevLogData, TagEntry } from "../src/types";

const PROJ = "i18n-fixture";

// Minimal dataset with two tags that both *contain* the needle but neither
// *equals* it → applyUndo takes the ambiguous-substring branch (pushes the
// undo-ambiguous rejection, mutates nothing else).
function fixture(): DevLogData {
  const tag = (id: string, content: string): TagEntry =>
    ({ id, project: PROJ, tag: "note", content, timestamp: "2026-01-01T00:00:00Z" });
  return {
    projects: {}, events: [], tags: [tag("a", "alpha one"), tag("b", "alpha two")],
    plans: [], worklog: [], injections: [], injectionConfig: {} as never,
    projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {},
  } as unknown as DevLogData;
}

const lastRejectionDetail = async (): Promise<string> => {
  const data = fixture();
  const out = await applyUndo("alpha", data, PROJ);
  expect(out).toBeNull();                                 // ambiguous → no removal
  const last = data.rejections?.at(-1);
  expect(last?.reason).toBe("undo-ambiguous");
  return last?.detail ?? "";
};

afterEach(() => { delete process.env.DEVLOG_LANG; });

describe("undo-ambiguous rejection honors DEVLOG_LANG", () => {
  test("default (no DEVLOG_LANG) → English, not Arabic", async () => {
    delete process.env.DEVLOG_LANG;
    const detail = await lastRejectionDetail();
    expect(detail).toContain("matches 2 tags");
    expect(detail).toContain("to avoid ambiguity");
    expect(/[؀-ۿ]/.test(detail)).toBe(false);   // zero Arabic for the global default
  });

  test("DEVLOG_LANG=ar → Arabic", async () => {
    process.env.DEVLOG_LANG = "ar";
    const detail = await lastRejectionDetail();
    expect(detail).toContain("يطابق 2 تاقات");
    expect(detail).not.toContain("avoid ambiguity");
  });

  test("locale form (ar-SA) still resolves to Arabic", async () => {
    process.env.DEVLOG_LANG = "ar-SA";
    expect(/[؀-ۿ]/.test(await lastRejectionDetail())).toBe(true);
  });
});
