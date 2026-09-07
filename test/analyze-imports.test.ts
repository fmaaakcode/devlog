// Import edges resolve to EXACT project paths (import-resolve.ts) and
// computeImportedBy counts in-degree over that resolved graph.
//
// History: the substring match (`f.path.includes(normalized)`) let builtins like
// `path` mark `path-utils.ts` as imported (R4 code-quality F2); the basename
// match that replaced it credited `./util/helper` to EVERY helper.* in the tree
// and to `../../helper` outside the project, doubling entry-point counts for
// `api/index.ts` + `ui/index.ts` layouts (#1179). Python and Rust never had a
// working edge at all (#1080).

import { describe, test, expect } from "bun:test";
import { computeImportedBy } from "../src/analyze";
import { buildFileIndex, resolveImport, resolveImports } from "../src/import-resolve";

describe("resolveImport — JS/TS", () => {
  const idx = buildFileIndex(["src/app.ts", "src/path-utils.ts", "src/data.ts", "src/metadata.ts", "src/update-data.ts", "src/util/helper.ts", "src/helper.ts", "lib/helper.py", "src/api/index.ts", "src/ui/index.ts", "src/lib/db.ts"]);

  test("builtin/npm specifiers resolve to nothing", () => {
    expect(resolveImport("src/app.ts", "path", "ts", idx)).toEqual([]);
    expect(resolveImport("src/app.ts", "react", "ts", idx)).toEqual([]);
    expect(resolveImport("src/app.ts", "node:fs", "ts", idx)).toEqual([]);
  });

  test("`./data` hits data.ts only — not metadata.ts or update-data.ts", () => {
    expect(resolveImport("src/app.ts", "./data", "ts", idx)).toEqual(["src/data.ts"]);
  });

  test("`./util/helper` resolves to the file in THAT directory, not every helper.*", () => {
    expect(resolveImport("src/app.ts", "./util/helper", "ts", idx)).toEqual(["src/util/helper.ts"]);
    expect(resolveImport("src/app.ts", "./helper", "ts", idx)).toEqual(["src/helper.ts"]);
  });

  test("a path that escapes the project resolves to nothing", () => {
    expect(resolveImport("src/app.ts", "../../helper", "ts", idx)).toEqual([]);
  });

  test("directory imports pick their own index.ts (api vs ui)", () => {
    expect(resolveImport("src/app.ts", "./api", "ts", idx)).toEqual(["src/api/index.ts"]);
    expect(resolveImport("src/app.ts", "./ui", "ts", idx)).toEqual(["src/ui/index.ts"]);
  });

  test("`./x.js` in TS sources names x.ts; `$lib/` and `@/` aliases expand", () => {
    expect(resolveImport("src/app.ts", "./data.js", "ts", idx)).toEqual(["src/data.ts"]);
    expect(resolveImport("src/ui/index.ts", "$lib/db", "ts", idx)).toEqual(["src/lib/db.ts"]);
    expect(resolveImport("src/ui/index.ts", "@/data", "ts", idx)).toEqual(["src/data.ts"]);
  });

  test("the importer never resolves to itself", () => {
    expect(resolveImport("src/data.ts", "./data", "ts", idx)).toEqual([]);
  });
});

describe("resolveImport — Python (#1080)", () => {
  const idx = buildFileIndex(["app.py", "app/__init__.py", "app/models.py", "app/routes/user.py", "utils.py", "models.py"]);
  test("relative `.models` from a package resolves inside that package", () => {
    expect(resolveImport("app/routes/user.py", "..models", "py", idx)).toEqual(["app/models.py"]);
    expect(resolveImport("app/__init__.py", ".models", "py", idx)).toEqual(["app/models.py"]);
  });
  test("absolute `app.models` resolves to app/models.py, not app.py", () => {
    expect(resolveImport("utils.py", "app.models", "py", idx)).toEqual(["app/models.py"]);
  });
  test("`app.models.User` (symbol import) still lands on the module", () => {
    expect(resolveImport("utils.py", "app.models.User", "py", idx)).toEqual(["app/models.py"]);
  });
  test("stdlib names resolve to nothing", () => {
    expect(resolveImport("utils.py", "os.path", "py", idx)).toEqual([]);
  });
});

describe("resolveImport — Rust (#1080)", () => {
  const idx = buildFileIndex(["src/main.rs", "src/app/mod.rs", "src/app/state.rs", "src/ipc.rs", "src/handlers/usage.rs"]);
  test("`crate::app::state` reaches the leaf module, not `app`", () => {
    expect(resolveImport("src/ipc.rs", "crate::app::state", "rs", idx)).toEqual(["src/app/state.rs"]);
    expect(resolveImport("src/ipc.rs", "crate::app::state::AppState", "rs", idx)).toEqual(["src/app/state.rs"]);
  });
  test("`mod app;` in main.rs resolves the directory module's mod.rs", () => {
    expect(resolveImport("src/main.rs", "app", "rs", idx)).toEqual(["src/app/mod.rs"]);
  });
  test("`super::` and `self::` walk the module tree", () => {
    // state.rs is module app::state → super = app (src/app/), super::super = crate root
    expect(resolveImport("src/app/state.rs", "super::super::ipc", "rs", idx)).toEqual(["src/ipc.rs"]);
    expect(resolveImport("src/app/state.rs", "super::state", "rs", idx)).toEqual([]);   // itself, excluded
    expect(resolveImport("src/app/mod.rs", "self::state", "rs", idx)).toEqual(["src/app/state.rs"]);
  });
  test("std and external crates resolve to nothing", () => {
    expect(resolveImport("src/main.rs", "std::collections::HashMap", "rs", idx)).toEqual([]);
    expect(resolveImport("src/main.rs", "serde_json::Value", "rs", idx)).toEqual([]);
  });
});

describe("resolveImport — Go and C/C++", () => {
  test("Go: module path suffix maps to the package directory's files", () => {
    const idx = buildFileIndex(["cmd/main.go", "pkg/foo/a.go", "pkg/foo/b.go", "pkg/foo/a_test.go"]);
    expect(resolveImport("cmd/main.go", "github.com/x/y/pkg/foo", "go", idx).sort()).toEqual(["pkg/foo/a.go", "pkg/foo/b.go"]);
    expect(resolveImport("cmd/main.go", "fmt", "go", idx)).toEqual([]);
  });
  test("C++: #include resolves beside the importer, then include/, then a unique basename", () => {
    const idx = buildFileIndex(["src/net/udp.cpp", "src/net/udp.h", "include/common.h", "src/util/log.h"]);
    expect(resolveImport("src/net/udp.cpp", "udp.h", "cpp", idx)).toEqual(["src/net/udp.h"]);
    expect(resolveImport("src/net/udp.cpp", "common.h", "cpp", idx)).toEqual(["include/common.h"]);
    expect(resolveImport("src/net/udp.cpp", "log.h", "cpp", idx)).toEqual(["src/util/log.h"]);
  });
});

describe("computeImportedBy — in-degree over the resolved graph (#1179)", () => {
  const files = ["src/app.ts", "src/path-utils.ts", "src/data.ts", "src/api/index.ts", "src/ui/index.ts"];

  test("counts exact targets only; unknown targets and self-edges are ignored", () => {
    const out = computeImportedBy(files, {
      "src/app.ts": ["src/data.ts", "src/path-utils.ts", "src/app.ts", "node_modules/react/index.js"],
      "src/data.ts": ["src/path-utils.ts"],
    });
    expect(out["src/path-utils.ts"]).toBe(2);
    expect(out["src/data.ts"]).toBe(1);
    expect(out["src/app.ts"] ?? 0).toBe(0);
  });

  test("two index.ts files importing each other's directory are counted separately", () => {
    const idx = buildFileIndex(files);
    const graph: Record<string, string[]> = {
      "src/app.ts": resolveImports("src/app.ts", ["./api", "./ui"], "ts", idx),
      "src/ui/index.ts": resolveImports("src/ui/index.ts", ["../api"], "ts", idx),
    };
    const out = computeImportedBy(files, graph);
    expect(out["src/api/index.ts"]).toBe(2);
    expect(out["src/ui/index.ts"]).toBe(1);
  });
});
