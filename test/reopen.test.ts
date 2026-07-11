// Unit tests for reopen detection (#556): a new problem report matching a
// CLOSED one gets linked (relatedTo); open reports, dissimilar texts and
// non-problem tags never link. Thresholds favour silence — a false link
// accuses a healthy fix.

import { describe, test, expect } from "bun:test";
import type { DevLogData, ProjectProfile, TagEntry } from "../src/types";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import { detectReopen } from "../src/reopen";

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

// A closed bug: opener #5 + a `#5 cure` closer.
const closedBug = () => [
  t("bug found", "race in the scanner tree walk corrupts the vuln cache", { num: 5, files: ["D:/tmp/reopenproj/src/scanner.ts"] }),
  t("bug fix", "#5 serialized the writes behind the existing lock"),
];

describe("detectReopen", () => {
  test("a strong text echo of a CLOSED report links to it", () => {
    const data = makeData(closedBug());
    const m = detectReopen(data, P, "bug found", "race in the scanner tree walk corrupts the vuln cache again");
    expect(m).toMatchObject({ num: 5 });
    expect(m?.closedAt).toBeTruthy();
  });

  test("a medium echo anchored to the same file links; without the file it doesn't", () => {
    const data = makeData(closedBug());
    // Jaccard vs the closed report ≈ 0.4 — below the text-only 0.6 bar,
    // above the file-anchored 0.35 bar.
    const text = "scanner tree walk drops entries from the vuln cache intermittently during rescan sweeps";
    expect(detectReopen(data, P, "bug found", text, ["D:/tmp/reopenproj/src/scanner.ts"]))
      .toMatchObject({ num: 5 });
    expect(detectReopen(data, P, "bug found", text)).toBeNull();
  });

  test("an OPEN report is never a reopen candidate", () => {
    const data = makeData([
      t("bug found", "race in the scanner tree walk corrupts the vuln cache", { num: 5 }),
    ]);
    expect(detectReopen(data, P, "bug found", "race in the scanner tree walk corrupts the vuln cache again")).toBeNull();
  });

  test("dissimilar text and non-problem tags stay silent", () => {
    const data = makeData(closedBug());
    expect(detectReopen(data, P, "bug found", "dashboard tooltip renders behind the modal overlay")).toBeNull();
    expect(detectReopen(data, P, "todo", "race in the scanner tree walk corrupts the vuln cache")).toBeNull();
  });

  test("security family participates like bugs", () => {
    const data = makeData([
      t("security:dep", "openssl 1.1.1 vulnerable to CVE-2023-0286 X.400 address confusion", { num: 7 }),
      t("security fix", "#7 bumped openssl to 3.2"),
    ]);
    expect(detectReopen(data, P, "security:dep", "openssl vulnerable again to CVE-2023-0286 X.400 address confusion"))
      .toMatchObject({ num: 7 });
  });
});
