// Unit tests for reopen linkage (#556, reshaped by #1118): a new problem
// report links to a CLOSED one only when the author marks it (`⟲ #N`,
// `reopen #N`) or re-reports the closed text word for word. Similar wording
// never links — the old Jaccard thresholds were unreachable by human reports
// (live maximum 0.28), so a fixture that reaches them proves nothing.

import { describe, test, expect } from "bun:test";
import type { DevLogData, ProjectProfile, TagEntry } from "../src/types";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import { detectReopen, REOPEN_MARK_RE } from "../src/reopen";

const P = "reopenproj";

function profile(): ProjectProfile {
  return {
    name: P, path: "D:/tmp/reopenproj", description: "", blueprint: [],
    language: "TypeScript", framework: "", libraries: [], files: {},
    directories: [], totalFiles: 0, lastScan: "",
  };
}

function makeData(tags: TagEntry[]): DevLogData {
  return {
    projects: { [P]: profile() }, tags, events: [], plans: [], worklog: [],
    injections: [], injectionConfig: { ...DEFAULT_INJECTION_CONFIG },
    projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {},
  };
}

let seq = 0;
function t(tag: string, content: string, opts: { num?: number; files?: string[] } = {}): TagEntry {
  return {
    id: `r${++seq}`, project: P, tag, content,
    timestamp: new Date(1700000000000 + seq * 60_000).toISOString(),
    ...(typeof opts.num === "number" ? { num: opts.num } : {}),
    ...(opts.files ? { files: opts.files } : {}),
  };
}

// A realistic closed report (150–200 chars, the shape humans actually write)
// + its `#5 cause` closer.
const CLOSED_TEXT = "watchTree في scanner.ts يعيد بناء كاش الثغرات عند كل حدث rename فتتصادم كتابتان متزامنتان على vuln-cache.json ويبقى الملف نصف مكتوب بعد إعادة الفحص من الداشبورد";
const closedBug = () => [
  t("bug found", CLOSED_TEXT, { num: 5, files: ["D:/tmp/reopenproj/src/scanner.ts"] }),
  t("bug fix", "#5 [توقيت] serialized the writes behind the existing lock"),
];

describe("detectReopen — explicit marker", () => {
  test("`⟲ #N` naming a CLOSED problem report links, via marker", () => {
    const data = makeData(closedBug());
    const m = detectReopen(data, P, "bug found", "⟲ #5 كاش الثغرات يعود نصف مكتوب بعد تحديث Bun 1.3 رغم القفل");
    expect(m).toMatchObject({ num: 5, via: "marker" });
    expect(m?.closedAt).toBeTruthy();
  });

  test("`reopen #N` / `⟲#N` / Arabic phrasing are accepted, anywhere in the text", () => {
    const data = makeData(closedBug());
    for (const text of [
      "vuln cache truncated again — reopen #5",
      "vuln cache truncated again (⟲#5)",
      "الكاش يعود مبتورًا، إعادة فتح #5",
    ]) expect(detectReopen(data, P, "bug found", text)?.num).toBe(5);
  });

  test("a marker at an OPEN, unknown, or non-problem #N is ignored — and does not fall through to text matching", () => {
    const openBug = t("bug found", "still open defect", { num: 9 });
    const closedTodo = [t("todo", "write the migration", { num: 6 }), t("done", "#6 wrote it")];
    const data = makeData([...closedBug(), openBug, ...closedTodo]);
    expect(detectReopen(data, P, "bug found", "⟲ #9 back again")).toBeNull();
    expect(detectReopen(data, P, "bug found", "⟲ #404 back again")).toBeNull();
    expect(detectReopen(data, P, "bug found", "⟲ #6 back again")).toBeNull();
    // A wrong marker on a word-for-word re-report is still ignored (marker wins the decision).
    expect(detectReopen(data, P, "bug found", `⟲ #404 ${CLOSED_TEXT}`)).toBeNull();
  });

  test("REOPEN_MARK_RE takes the first marker only", () => {
    expect(REOPEN_MARK_RE.exec("⟲ #5 then ⟲ #7")?.[1]).toBe("5");
    expect(REOPEN_MARK_RE.test("fix #5 reopened the dialog")).toBe(false); // `reopened` ≠ reopen(s) #N
  });
});

describe("detectReopen — identical text (#593)", () => {
  test("a word-for-word re-report of a CLOSED report links, via identical", () => {
    const data = makeData(closedBug());
    expect(detectReopen(data, P, "bug found", CLOSED_TEXT)).toMatchObject({ num: 5, via: "identical" });
    expect(detectReopen(data, P, "bug found", `  ${CLOSED_TEXT}  `)?.num).toBe(5); // normalised whitespace
  });

  test("similar wording never links — a realistic near-duplicate stays silent", () => {
    const data = makeData(closedBug());
    const near = "watchTree في scanner.ts يعيد بناء كاش الثغرات عند كل حدث rename فيبقى vuln-cache.json نصف مكتوب بعد إعادة الفحص";
    expect(detectReopen(data, P, "bug found", near)).toBeNull();
  });

  test("an OPEN report is never a reopen candidate", () => {
    const data = makeData([t("bug found", CLOSED_TEXT, { num: 5 })]);
    expect(detectReopen(data, P, "bug found", CLOSED_TEXT)).toBeNull();
    expect(detectReopen(data, P, "bug found", "⟲ #5 again")).toBeNull();
  });

  test("non-problem tags stay silent even with a marker or identical text", () => {
    const data = makeData(closedBug());
    expect(detectReopen(data, P, "todo", CLOSED_TEXT)).toBeNull();
    expect(detectReopen(data, P, "todo", "⟲ #5 redo it")).toBeNull();
  });

  test("security family participates like bugs", () => {
    const data = makeData([
      t("security:dep", "openssl 1.1.1 vulnerable to CVE-2023-0286 X.400 address confusion", { num: 7 }),
      t("security fix", "#7 bumped openssl to 3.2"),
    ]);
    expect(detectReopen(data, P, "security:dep", "⟲ #7 openssl pinned back to 1.1.1 by the base image"))
      .toMatchObject({ num: 7, via: "marker" });
  });
});
