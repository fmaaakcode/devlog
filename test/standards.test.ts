import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// STANDARDS_DIR is captured at module-eval from this env var, so it must be set
// before the dynamic import below.
const TMP = join(import.meta.dir, ".tmp-standards");
process.env.DEVLOG_STANDARDS_DIR = TMP;
const std = await import("../src/standards");

async function seed() {
  await mkdir(join(TMP, "languages"), { recursive: true });
  await mkdir(join(TMP, "app-types"), { recursive: true });
  await writeFile(join(TMP, "README.md"), "# index", "utf-8");
  await writeFile(join(TMP, "_TEMPLATE.md"), "# template", "utf-8");
  await writeFile(join(TMP, "languages", "README.md"), "# axis readme", "utf-8");
  await writeFile(
    join(TMP, "languages", "rust.md"),
    "# rust — معايير\n\n## القواعد\n\n- استخدم Result بدل panic\n- لا unwrap في كود الإنتاج\n",
    "utf-8",
  );
  await writeFile(
    join(TMP, "app-types", "desktop-gui.md"),
    "# desktop-gui — معايير\n\n## القواعد\n",
    "utf-8",
  );
}

beforeEach(async () => {
  // Re-assert per test: bun shares the process across files, and standardsDir()
  // now reads the env live, so another standards test must not leak its dir here.
  process.env.DEVLOG_STANDARDS_DIR = TMP;
  await rm(TMP, { recursive: true, force: true });
  await seed();
});
afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

describe("parseRuleCommands", () => {
  test("returns empty for a message with no commands", () => {
    expect(std.parseRuleCommands("just some text")).toEqual([]);
  });

  test("parses a single ask:rules with multiple categories", () => {
    const cmds = std.parseRuleCommands("سأبني التطبيق.\n-(ask:rules) rust windows desktop-gui");
    expect(cmds.length).toBe(1);
    expect(cmds[0].cmd).toBe("ask:rules");
    expect(cmds[0].argLine).toBe("rust windows desktop-gui");
  });

  test("captures a multi-line rule:add body", () => {
    const cmds = std.parseRuleCommands("-(rule:add) desktop-gui\nالبرامج تشتغل في System Tray دائماً");
    expect(cmds[0].cmd).toBe("rule:add");
    expect(cmds[0].argLine).toBe("desktop-gui");
    expect(cmds[0].body).toBe("البرامج تشتغل في System Tray دائماً");
  });

  test("rule:add body stops at a blank line (does not swallow trailing prose)", () => {
    const cmds = std.parseRuleCommands(
      "-(rule:add) deps\nاستخدم الأحدث بشرط 7 أيام\n\nهذي فقرة شرح بعد القاعدة لا يجب التقاطها.",
    );
    expect(cmds.length).toBe(1);
    expect(cmds[0].body).toBe("استخدم الأحدث بشرط 7 أيام");
  });

  test("rule:add keeps a genuine multi-line body (no blank line between)", () => {
    const cmds = std.parseRuleCommands("-(rule:add) deps\nسطر أول\nسطر ثانٍ");
    expect(cmds[0].body).toBe("سطر أول\nسطر ثانٍ");
  });

  test("parses several commands and stops each at the next one", () => {
    const cmds = std.parseRuleCommands("-(rules:list)\n-(ask:rules) rust");
    expect(cmds.map(c => c.cmd)).toEqual(["rules:list", "ask:rules"]);
  });

  test("ignores commands inside code fences", () => {
    const cmds = std.parseRuleCommands("مثال:\n```\n-(ask:rules) rust\n```\nانتهى");
    expect(cmds).toEqual([]);
  });

  test("keys are unique per command instance", () => {
    const cmds = std.parseRuleCommands("-(ask:rules) rust\n-(ask:rules) c");
    expect(cmds[0].key).not.toBe(cmds[1].key);
  });
});

describe("scanCatalog", () => {
  test("finds category files and excludes README / _TEMPLATE", async () => {
    const cats = (await std.scanCatalog()).map(c => c.category).sort();
    expect(cats).toEqual(["desktop-gui", "rust"]);
  });

  test("records the axis (parent folder)", async () => {
    const rust = (await std.scanCatalog()).find(c => c.category === "rust");
    expect(rust?.axis).toBe("languages");
  });

  test("missing dir → empty catalog (dormant feature)", async () => {
    await rm(TMP, { recursive: true, force: true });
    expect(await std.scanCatalog()).toEqual([]);
  });
});

describe("readCategories", () => {
  test("returns numbered rules for a known category", async () => {
    const r = await std.readCategories(["rust"]);
    expect(r.found).toBe(1);
    // Unmarked rules render as [نصيحة] (the safe default kind).
    expect(r.output).toContain("#1 [نصيحة] استخدم Result");
    expect(r.output).toContain("#2 [نصيحة] لا unwrap");
  });

  test("reports unknown categories with available names", async () => {
    const r = await std.readCategories(["rust", "haskell"]);
    expect(r.found).toBe(1);
    expect(r.missing).toEqual(["haskell"]);
    expect(r.output).toContain("غير موجودة: haskell");
  });
});

describe("intentional acknowledgement (ack)", () => {
  const PROJ = join(import.meta.dir, ".tmp-ack-proj");
  beforeEach(async () => {
    await rm(PROJ, { recursive: true, force: true });
    await mkdir(join(PROJ, ".devlog"), { recursive: true });
  });
  afterAll(async () => { await rm(PROJ, { recursive: true, force: true }); });

  test("no acks → nothing is acknowledged", () => {
    expect(std.isAcked(PROJ, "cargo-edition", "2021")).toBe(false);
    expect(std.readAcks(PROJ)).toEqual([]);
  });

  test("addAck records a key and isAcked sees the specific value", async () => {
    const r = await std.addAck(PROJ, "cargo-edition:2021");
    expect(r.ok).toBe(true);
    expect(std.isAcked(PROJ, "cargo-edition", "2021")).toBe(true);
    expect(std.isAcked(PROJ, "cargo-edition", "2018")).toBe(false); // other value still blocks
  });

  test("a bare check key silences the whole check (soft) for any value", async () => {
    await std.addAck(PROJ, "design-hex");
    expect(std.isAcked(PROJ, "design-hex", "#ff6719")).toBe(true);
    expect(std.isAcked(PROJ, "design-hex")).toBe(true);
  });

  test("addAck dedups (append-only)", async () => {
    await std.addAck(PROJ, "dep:astro");
    const r = await std.addAck(PROJ, "dep:astro");
    expect(r.message).toContain("موجود مسبقاً");
    expect(std.readAcks(PROJ)).toEqual(["dep:astro"]);
  });

  test("ack resolves from a subfolder (walks up to .devlog)", async () => {
    await std.addAck(PROJ, "dep:vite");
    const sub = join(PROJ, "src", "ui");
    await mkdir(sub, { recursive: true });
    expect(std.isAcked(sub, "dep", "vite")).toBe(true);
  });

  test("listAcks renders the project's acks", async () => {
    await std.addAck(PROJ, "cargo-version:1.84");
    expect(std.listAcks(PROJ)).toContain("cargo-version:1.84");
  });
});

describe("rule kind (check/guide)", () => {
  test("unmarked rule defaults to guide", () => {
    expect(std.classifyRule("لا unwrap في الإنتاج")).toEqual({ kind: "guide", text: "لا unwrap في الإنتاج" });
  });

  test("[فحص] / [check] mark a verifiable rule and the marker is stripped", () => {
    expect(std.classifyRule("[فحص] edition لازم الأحدث")).toEqual({ kind: "check", text: "edition لازم الأحدث" });
    expect(std.classifyRule("[check]  no raw hex")).toEqual({ kind: "check", text: "no raw hex" });
  });

  test("[نصيحة] / [guide] mark an advisory rule", () => {
    expect(std.classifyRule("[نصيحة] فضّل Result").kind).toBe("guide");
    expect(std.classifyRule("[guide] prefer composition").kind).toBe("guide");
  });

  test("parseRules numbers rules and resolves kinds", () => {
    const rules = std.parseRules("## القواعد\n- [فحص] أ\n- ب\n- [guide] ج\n");
    expect(rules).toEqual([
      { num: 1, kind: "check", text: "أ" },
      { num: 2, kind: "guide", text: "ب" },
      { num: 3, kind: "guide", text: "ج" },
    ]);
  });

  test("checkRules returns only the verifiable rules", () => {
    const rules = std.checkRules("## القواعد\n- [فحص] أ\n- ب\n- [check] ج\n");
    expect(rules.map(r => r.text)).toEqual(["أ", "ج"]);
  });

  test("readCategories shows [فحص] for marked rules", async () => {
    await writeFile(
      join(TMP, "languages", "rust.md"),
      "# rust\n\n## القواعد\n- [فحص] استخدم أحدث edition\n- اكتب كوداً اصطلاحياً\n",
      "utf-8",
    );
    const r = await std.readCategories(["rust"]);
    expect(r.output).toContain("#1 [فحص] استخدم أحدث edition");
    expect(r.output).toContain("#2 [نصيحة] اكتب كوداً اصطلاحياً");
  });

  test("addRule dedups regardless of kind marker (text is the identity)", async () => {
    // Seed rust has "لا unwrap في كود الإنتاج" unmarked; adding it as [فحص] must dedup.
    const r = await std.addRule("rust", "[فحص] لا unwrap في كود الإنتاج");
    expect(r.message).toContain("موجودة مسبقاً");
  });
});

describe("addRule", () => {
  test("appends a new rule (append-only) and keeps old ones", async () => {
    const r = await std.addRule("rust", "وثّق كل دالة عامة");
    expect(r.ok).toBe(true);
    const file = await readFile(join(TMP, "languages", "rust.md"), "utf-8");
    expect(file).toContain("استخدم Result بدل panic"); // old preserved
    expect(file).toContain("- وثّق كل دالة عامة");      // new appended
  });

  test("dedups an identical rule", async () => {
    await std.addRule("rust", "لا unwrap في كود الإنتاج");
    const file = await readFile(join(TMP, "languages", "rust.md"), "utf-8");
    const count = (file.match(/لا unwrap في كود الإنتاج/g) || []).length;
    expect(count).toBe(1);
  });

  test("creates a ## القواعد section if missing", async () => {
    await writeFile(join(TMP, "languages", "go.md"), "# go — معايير\n", "utf-8");
    const r = await std.addRule("go", "استخدم gofmt");
    expect(r.ok).toBe(true);
    const file = await readFile(join(TMP, "languages", "go.md"), "utf-8");
    expect(file).toContain("## القواعد");
    expect(file).toContain("- استخدم gofmt");
  });

  test("errors when the category does not exist", async () => {
    const r = await std.addRule("nonexistent", "x");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("rule:new");
  });
});

describe("createCategory", () => {
  test("creates a new category file from template", async () => {
    const r = await std.createCategory("platforms", "windows");
    expect(r.ok).toBe(true);
    const file = await readFile(join(TMP, "platforms", "windows.md"), "utf-8");
    expect(file).toContain("# windows — معايير");
    expect(file).toContain("## القواعد");
  });

  test("rejects a duplicate category", async () => {
    const r = await std.createCategory("languages", "rust");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("موجود مسبقاً");
  });

  test("rejects an invalid category name", async () => {
    const r = await std.createCategory("languages", "C++ Stuff");
    expect(r.ok).toBe(false);
  });

  test("rejects a path-traversal axis and writes nothing outside the dir", async () => {
    const r = await std.createCategory("../../../escape", "pwned");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("محور غير صالح");
    // No file leaked outside STANDARDS_DIR.
    const escaped = join(TMP, "..", "..", "..", "escape", "pwned.md");
    expect(await readFile(escaped, "utf-8").then(() => true, () => false)).toBe(false);
  });
});

describe("removeRule", () => {
  test("removes a rule by number", async () => {
    const r = await std.removeRule("rust", 1);
    expect(r.ok).toBe(true);
    const file = await readFile(join(TMP, "languages", "rust.md"), "utf-8");
    expect(file).not.toContain("استخدم Result بدل panic");
    expect(file).toContain("لا unwrap في كود الإنتاج"); // #2 survives
  });

  test("rejects an out-of-range number", async () => {
    const r = await std.removeRule("rust", 99);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("خارج النطاق");
  });
});

describe("shouldEnforceStandards (relevance-aware gate)", () => {
  const base = { catalogCount: 3, relevantUncovered: 2, stopHookActive: false };
  test("blocks when a relevant category is uncovered", () => {
    expect(std.shouldEnforceStandards(base)).toBe(true);
  });
  test("does not block when nothing relevant is uncovered (covered or C++-with-no-cpp)", () => {
    expect(std.shouldEnforceStandards({ ...base, relevantUncovered: 0 })).toBe(false);
  });
  test("does not block when the catalog is empty", () => {
    expect(std.shouldEnforceStandards({ ...base, catalogCount: 0 })).toBe(false);
  });
  test("never loops on its own forced continuation", () => {
    expect(std.shouldEnforceStandards({ ...base, stopHookActive: true })).toBe(false);
  });
});

describe("coveredCategories", () => {
  test("extracts categories from ask:rules command keys", () => {
    expect(std.coveredCategories(["ask:rules|rust windows desktop-gui|"]).sort())
      .toEqual(["desktop-gui", "rust", "windows"]);
  });
  test("extracts categories from auto-served markers", () => {
    expect(std.coveredCategories(["auto-served|rust", "auto-served|security"]).sort())
      .toEqual(["rust", "security"]);
  });
  test("merges both sources and dedups, ignoring unrelated keys", () => {
    expect(std.coveredCategories(["ask:rules|rust|", "auto-served|rust", "dep-fresh|x", "rule:add|c|نص"]).sort())
      .toEqual(["rust"]);
  });
  test("empty state → no categories", () => {
    expect(std.coveredCategories([])).toEqual([]);
  });
});

describe("gateWriteDecision (category-aware PreToolUse gate)", () => {
  test("blocks and serves the needed categories when nothing is covered", () => {
    expect(std.gateWriteDecision({ isCode: true, needed: ["rust", "security"], covered: [] }))
      .toEqual({ block: true, serve: ["rust", "security"] });
  });
  test("serves only the uncovered subset (per-category)", () => {
    expect(std.gateWriteDecision({ isCode: true, needed: ["go", "security"], covered: ["rust", "security"] }))
      .toEqual({ block: true, serve: ["go"] });
  });
  test("allows when every needed category is already covered", () => {
    expect(std.gateWriteDecision({ isCode: true, needed: ["rust", "security"], covered: ["rust", "security"] }))
      .toEqual({ block: false, serve: [] });
  });
  test("allows non-code writes regardless of categories", () => {
    expect(std.gateWriteDecision({ isCode: false, needed: ["rust"], covered: [] }))
      .toEqual({ block: false, serve: [] });
  });
  test("allows when nothing applies (empty needed, e.g. unknown ext + empty catalog)", () => {
    expect(std.gateWriteDecision({ isCode: true, needed: [], covered: [] }))
      .toEqual({ block: false, serve: [] });
  });
});

describe("isCodeWrite", () => {
  test("counts source files", () => {
    expect(std.isCodeWrite("D:/test/src/main.rs")).toBe(true);
    expect(std.isCodeWrite("src/app.tsx")).toBe(true);
  });
  test("excludes docs, manifests, and .devlog internals", () => {
    expect(std.isCodeWrite("README.md")).toBe(false);
    expect(std.isCodeWrite("Cargo.toml")).toBe(false);
    expect(std.isCodeWrite("D:/test/.devlog/status.md")).toBe(false);
    expect(std.isCodeWrite("")).toBe(false);
  });
});

describe("isEnforcementDisabled (per-project opt-out)", () => {
  const PROJ = join(TMP, "proj");
  beforeEach(async () => {
    await mkdir(join(PROJ, ".devlog"), { recursive: true });
    await mkdir(join(PROJ, "src"), { recursive: true });
  });
  test("false by default (no marker ⇒ enforce)", () => {
    expect(std.isEnforcementDisabled(PROJ)).toBe(false);
  });
  test("true when the marker is present", async () => {
    await writeFile(std.enforceMarkerPath(PROJ), "disabled", "utf-8");
    expect(std.isEnforcementDisabled(PROJ)).toBe(true);
  });
  test("finds the marker from a subfolder (walks up to project root)", async () => {
    await writeFile(std.enforceMarkerPath(PROJ), "disabled", "utf-8");
    expect(std.isEnforcementDisabled(join(PROJ, "src"))).toBe(true);
  });
});

describe("langForFile", () => {
  test("maps known extensions to language categories", () => {
    expect(std.langForFile("src/main.rs")).toBe("rust");
    expect(std.langForFile("D:/p/app.tsx")).toBe("typescript");
    expect(std.langForFile("server.ts")).toBe("typescript");
    expect(std.langForFile("pkg\\mod.go")).toBe("go");
    expect(std.langForFile("util.py")).toBe("python");
    expect(std.langForFile("lib.cpp")).toBe("cpp");
  });
  test("unknown or extensionless files → null", () => {
    expect(std.langForFile("notes.md")).toBe(null);
    expect(std.langForFile("Makefile")).toBe(null);
    expect(std.langForFile("")).toBe(null);
  });
  test("a dot in a folder name does not fool the extension parse", () => {
    expect(std.langForFile("my.app/src/README")).toBe(null);
  });
});

describe("inferCategories", () => {
  const avail = ["rust", "typescript", "windows", "desktop-gui", "security", "dependencies"];
  test("picks the language for a code file, intersected with the catalog", () => {
    expect(std.inferCategories("src/main.rs", avail)).toEqual(["rust", "security"]);
  });
  test("adds platform and app-type hints when present in the catalog", () => {
    expect(std.inferCategories("src/main.rs", avail, { platform: "windows", appType: "desktop-gui" }))
      .toEqual(["rust", "windows", "desktop-gui", "security"]);
  });
  test("never suggests a category that is not in the catalog", () => {
    expect(std.inferCategories("a.go", avail)).toEqual(["security"]); // no go.md available
    expect(std.inferCategories("src/main.rs", avail, { platform: "linux" }))
      .toEqual(["rust", "security"]); // linux not in catalog → dropped
  });
  test("unknown extension still yields the always-include cross-cutting", () => {
    expect(std.inferCategories("data.bin", avail)).toEqual(["security"]);
  });
  test("respects a custom alwaysInclude set and dedups", () => {
    expect(std.inferCategories("app.ts", avail, { alwaysInclude: ["dependencies", "security"] }))
      .toEqual(["typescript", "dependencies", "security"]);
  });
  test("empty catalog → no categories", () => {
    expect(std.inferCategories("src/main.rs", [])).toEqual([]);
  });

  test("pulls framework categories from manifest deps (intersected with catalog)", () => {
    const a = ["typescript", "design", "astro", "vite", "react", "security"];
    expect(std.inferCategories("src/pages/index.astro", a, { deps: ["astro", "vite"] }))
      .toEqual(["design", "astro", "vite", "security"]); // .astro → design + deps
    expect(std.inferCategories("src/app.ts", a, { deps: ["react", "react-dom"] }))
      .toEqual(["typescript", "react", "security"]); // react-dom dedups to react
  });

  test("adds the runtime category when present", () => {
    expect(std.inferCategories("src/app.ts", ["typescript", "bun", "security"], { runtime: "bun" }))
      .toEqual(["typescript", "bun", "security"]);
  });

  test("framework deps not in the catalog are dropped", () => {
    expect(std.inferCategories("src/app.ts", ["typescript", "security"], { deps: ["astro", "vite"] }))
      .toEqual(["typescript", "security"]); // no astro/vite category → nothing added
  });
});

describe("frameworkCategoriesFromDeps", () => {
  test("maps known deps and dedups aliases", () => {
    expect(std.frameworkCategoriesFromDeps(["react", "react-dom", "vite", "tailwindcss"]))
      .toEqual(["react", "vite", "tailwind"]);
  });
  test("ignores unknown deps", () => {
    expect(std.frameworkCategoriesFromDeps(["lodash", "zod"])).toEqual([]);
  });
});

describe("templateLangs", () => {
  test("extracts distinct latest/edition placeholders", () => {
    const ls = std.templateLangs("استخدم رست {{latest:rust}} و edition {{edition:rust}} وtsc {{latest:typescript}}");
    expect(ls).toEqual([
      { kind: "latest", lang: "rust" },
      { kind: "edition", lang: "rust" },
      { kind: "latest", lang: "typescript" },
    ]);
  });
  test("dedups repeated placeholders and ignores plain text", () => {
    expect(std.templateLangs("{{latest:rust}} ثم {{latest:rust}}")).toEqual([{ kind: "latest", lang: "rust" }]);
    expect(std.templateLangs("لا قوالب هنا")).toEqual([]);
  });
});

describe("resolveTemplate", () => {
  test("substitutes known latest + edition values", () => {
    const out = std.resolveTemplate("رست {{latest:rust}} / {{edition:rust}}", {
      "latest:rust": "1.96.0",
      "edition:rust": "2024",
    });
    expect(out).toBe("رست 1.96.0 / 2024");
  });
  test("missing value → textual pointer, never an empty literal", () => {
    const out = std.resolveTemplate("رست {{latest:rust}} / {{edition:rust}}", {});
    expect(out).toBe("رست أحدث إصدار مستقر لـrust / أحدث edition لـrust");
    expect(out).not.toContain("{{");
  });
  test("null/empty resolved value also falls back to the pointer", () => {
    const out = std.resolveTemplate("{{latest:go}}", { "latest:go": null });
    expect(out).toBe("أحدث إصدار مستقر لـgo");
  });
  test("content without placeholders is returned unchanged", () => {
    expect(std.resolveTemplate("نص عادي بلا قوالب", { "latest:rust": "1.96.0" })).toBe("نص عادي بلا قوالب");
  });
});

describe("resolveContentTemplates (P4 — injectable toolchain resolver)", () => {
  test("fetches each referenced lang once and substitutes live values", async () => {
    const calls: string[] = [];
    const fake = async (lang: string) => {
      calls.push(lang);
      if (lang === "rust") return { version: "1.96.0", edition: "2024" };
      return { version: null, edition: null };
    };
    const out = await std.resolveContentTemplates(
      "رست {{latest:rust}} / {{edition:rust}} ثم rust مجدداً {{latest:rust}}",
      fake,
    );
    expect(out).toBe("رست 1.96.0 / 2024 ثم rust مجدداً 1.96.0");
    expect(calls).toEqual(["rust"]); // fetched once despite three placeholders
  });

  test("a resolver failure falls back to the pointer (never wedges)", async () => {
    const boom = async () => { throw new Error("network down"); };
    const out = await std.resolveContentTemplates("رست {{latest:rust}}", boom);
    expect(out).toBe("رست أحدث إصدار مستقر لـrust");
  });

  test("content with no placeholders skips the resolver entirely", async () => {
    let called = false;
    const spy = async () => { called = true; return { version: "x", edition: null }; };
    const out = await std.resolveContentTemplates("لا قوالب هنا", spy);
    expect(out).toBe("لا قوالب هنا");
    expect(called).toBe(false);
  });

  test("null version from the resolver → pointer fallback, not empty", async () => {
    const fake = async () => ({ version: null, edition: null });
    const out = await std.resolveContentTemplates("go {{latest:go}}", fake);
    expect(out).toBe("go أحدث إصدار مستقر لـgo");
  });
});

describe("runRuleCommands (batch orchestration)", () => {
  test("serves a read and an add in one batch", async () => {
    const cmds = std.parseRuleCommands(
      "-(ask:rules) rust\n-(rule:add) desktop-gui\nالبرامج تشتغل في System Tray",
    );
    const { output } = await std.runRuleCommands(cmds);
    expect(output).toContain("معايير: rust");
    expect(output).toContain("rule:add desktop-gui");
    const file = await readFile(join(TMP, "app-types", "desktop-gui.md"), "utf-8");
    expect(file).toContain("- البرامج تشتغل في System Tray");
  });
});
