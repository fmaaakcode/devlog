// Unit coverage for computeImportedBy — the import-graph counter that feeds
// entry-point detection. The old substring match (`f.path.includes(normalized)`)
// produced phantom imports: builtins like `path` matched `path-utils.ts`, and
// `./data` matched `metadata.ts`/`update-data.ts` (R4 code-quality F2).

import { describe, test, expect } from "bun:test";
import { computeImportedBy } from "../src/analyze";

describe("computeImportedBy (exact basename, relative-only) — R4 cq F2", () => {
  const files = ["src/app.ts", "src/path-utils.ts", "src/data.ts", "src/metadata.ts", "src/update-data.ts"];

  test("builtin/npm imports never inflate the count", () => {
    // `path` is a node builtin — must NOT mark path-utils.ts as imported.
    const out = computeImportedBy(files, { "src/app.ts": ["path", "react", "node:fs"] });
    expect(out["src/path-utils.ts"]).toBeUndefined();
  });

  test("a relative import counts only the exact basename match", () => {
    // `./data` must hit data.ts only — not metadata.ts or update-data.ts.
    const out = computeImportedBy(files, { "src/app.ts": ["./data"] });
    expect(out["src/data.ts"]).toBe(1);
    expect(out["src/metadata.ts"]).toBeUndefined();
    expect(out["src/update-data.ts"]).toBeUndefined();
  });

  test("path-utils is counted only when explicitly imported", () => {
    const out = computeImportedBy(files, { "src/app.ts": ["./path-utils"], "src/data.ts": ["./path-utils"] });
    expect(out["src/path-utils.ts"]).toBe(2);
  });

  test("a true entry point (imports others, imported by none) stays at 0", () => {
    const out = computeImportedBy(files, { "src/app.ts": ["./data", "./path-utils", "react"] });
    expect(out["src/app.ts"] ?? 0).toBe(0);
  });

  test("deeper relative paths resolve by basename", () => {
    const out = computeImportedBy(["src/a.ts", "src/util/helper.ts"], { "src/a.ts": ["./util/helper", "../../helper"] });
    expect(out["src/util/helper.ts"]).toBe(2);
  });
});
