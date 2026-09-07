import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// STANDARDS_DIR is captured at module-eval from this env var, so it must be set
// before the dynamic import below.
const TMP = join(import.meta.dir, ".tmp-standards");
// Restored in afterAll (#1166): the suite shares one process, and leaving the
// var pointed at a directory this file DELETES made every later standards
// consumer (routes-standards-e2e, the rule commands) read an empty catalog.
const PREV_STD = process.env.DEVLOG_STANDARDS_DIR;
process.env.DEVLOG_STANDARDS_DIR = TMP;
// Messages went bilingual (#906) and currentLang() reads the env per call.
// The assertions here pin the ARABIC variants, so pin the language too —
// locally DEVLOG_LANG=ar happens to be set, but CI has no DEVLOG_LANG and
// would get the English variants. Restored in afterAll.
const PREV_LANG = process.env.DEVLOG_LANG;
process.env.DEVLOG_LANG = "ar";
const std = await import("../src/standards");

async function seed() {
  await mkdir(join(TMP, "languages"), { recursive: true });
  await mkdir(join(TMP, "app-types"), { recursive: true });
  await writeFile(join(TMP, "README.md"), "# index", "utf-8");
  await writeFile(join(TMP, "_TEMPLATE.md"), "# template", "utf-8");
  await writeFile(join(TMP, "languages", "README.md"), "# axis readme", "utf-8");
  // Both seeds carry a REAL "when it applies" line (#1174): the check now
  // demands the section with a sentence, not merely the absence of the
  // template placeholder — a seed without the section would itself warn.
  await writeFile(
    join(TMP, "languages", "rust.md"),
    "# rust — معايير\n\n## متى تنطبق\n\nأي مشروع Rust.\n\n## القواعد\n\n- استخدم Result بدل panic\n- لا unwrap في كود الإنتاج\n",
    "utf-8",
  );
  await writeFile(
    join(TMP, "app-types", "desktop-gui.md"),
    "# desktop-gui — معايير\n\n## متى تنطبق\n\nتطبيقات سطح المكتب.\n\n## القواعد\n",
    "utf-8",
  );
}

beforeEach(async () => {
  // Re-assert per test: bun shares the process across files, and standardsDir()
  // now reads the env live, so another standards test must not leak its dir here.
  process.env.DEVLOG_STANDARDS_DIR = TMP;
  process.env.DEVLOG_LANG = "ar";
  await rm(TMP, { recursive: true, force: true });
  await seed();
});
afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
  if (PREV_LANG === undefined) delete process.env.DEVLOG_LANG;
  else process.env.DEVLOG_LANG = PREV_LANG;
  if (PREV_STD === undefined) delete process.env.DEVLOG_STANDARDS_DIR;
  else process.env.DEVLOG_STANDARDS_DIR = PREV_STD;
});

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

  test("a body that GREW between reads keeps the same key (#760)", () => {
    // The block→continue re-read glues continuation prose onto the last body —
    // keying the full body minted a fresh key and re-executed the command.
    const first = std.parseRuleCommands("-(rule:add) rust\nقاعدة أصلية")[0];
    const grown = std.parseRuleCommands("-(rule:add) rust\nقاعدة أصلية\nنثر استكمال التصق لاحقاً")[0];
    expect(grown.key).toBe(first.key);
  });
});

describe("parseRuleCommands keeps inline code intact (rules were stored blanked)", () => {
  test("backtick spans survive in the body — rust #3 lost both command names", () => {
    const [c] = std.parseRuleCommands("-(rule:add) rust\nشغّل `cargo fmt` (أو `cargo fmt --all`) قبل التسليم");
    expect(c.body).toBe("شغّل `cargo fmt` (أو `cargo fmt --all`) قبل التسليم");
    expect(c.body).not.toMatch(/ {3,}/);
  });

  test("backtick spans survive on the arg line too", () => {
    const [c] = std.parseRuleCommands("-(rule:add) rust `cargo clippy` قبل الدمج");
    expect(c.argLine).toBe("rust `cargo clippy` قبل الدمج");
  });

  test("a command inside a fence is still NOT captured (stripping stays a detection aid)", () => {
    expect(std.parseRuleCommands("```\n-(rule:add) rust\nقاعدة داخل سياج\n```")).toEqual([]);
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

  test("#1128: sub-headings inside the rules section do not end it; a peer heading does; fenced bullets are not rules", () => {
    // The live design.md shape: 3 top bullets, then `### 1)…### 6)` groups.
    const md = [
      "# design — معايير", "", "## متى تنطبق", "أي واجهة.", "",
      "## القواعد",
      "- أ", "- ب", "",
      "### 1) اللوحة", "3 رماديات.", "",
      "```css", "- not a rule (inside a code fence)", "```", "",
      "- [فحص] ج", "",
      "### 2) الحدود", "- د", "",
      "## المصدر الكامل", "- ليست قاعدة (قسم آخر)",
    ].join("\n");
    const rules = std.parseRules(md);
    expect(rules.map(r => r.text)).toEqual(["أ", "ب", "ج", "د"]);
    expect(rules[2].kind).toBe("check");
    expect(std.checkRules(md).map(r => r.num)).toEqual([3]);
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

  test("a glued confirmation tail does not defeat dedup (design #2/#3, security #6/#7)", async () => {
    // The assistant's own "تمّت الإضافة…" prose landing in the body made the
    // full-text comparison miss the existing first line → second copy WITH tail.
    const r = await std.addRule("rust", "لا unwrap في كود الإنتاج\nتمّت الإضافة: القاعدة الآن ضمن تصنيف rust رقم #2.");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("موجودة مسبقاً");
    const file = await readFile(join(TMP, "languages", "rust.md"), "utf-8");
    expect((file.match(/لا unwrap في كود الإنتاج/g) || []).length).toBe(1);
    expect(file).not.toContain("تمّت الإضافة");
  });

  test("a rule added AFTER a multi-line rule lands below its whole block (#769)", async () => {
    // Pre-fix, insertAt sat right after the last bullet's FIRST line — the new
    // rule split the old multi-line rule and glued its body onto itself.
    await writeFile(
      join(TMP, "languages", "zig.md"),
      "# zig\n\n## القواعد\n- قاعدة متعددة الأسطر\n  سطر امتداد أول\n  سطر امتداد ثانٍ\n",
      "utf-8",
    );
    const r = await std.addRule("zig", "قاعدة جديدة");
    expect(r.ok).toBe(true);
    const file = await readFile(join(TMP, "languages", "zig.md"), "utf-8");
    // The old rule's block survives contiguous, and the new rule follows it.
    expect(file).toContain("- قاعدة متعددة الأسطر\n  سطر امتداد أول\n  سطر امتداد ثانٍ\n- قاعدة جديدة");
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

describe("listCatalog flags categories still carrying the template placeholder", () => {
  test("lists them under a ⚠ line; filled categories are not named", async () => {
    await std.createCategory("languages", "zig");   // template → placeholder present
    const out = await std.listCatalog();
    expect(out).toContain("⚠ بلا شرط تطبيق");
    expect(out).toMatch(/⚠[^\n]*zig/);
    expect(out).not.toMatch(/⚠[^\n]*rust/);
    expect(std.lacksWhenApplies("## متى تنطبق\n\n(اشرح بسطر متى يسحب كلود هذا التصنيف.)\n")).toBe(true);
    expect(std.lacksWhenApplies("## When it applies\n\n(One line: when should Claude pull this category.)\n")).toBe(true);
    expect(std.lacksWhenApplies("## متى تنطبق\n\nأي مشروع Rust.\n")).toBe(false);
  });

  test("no ⚠ line when every category has its line", async () => {
    expect(await std.listCatalog()).not.toContain("⚠");
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

// Issue #1 (public repo): inside a DevLog-tracked project, writes default to
// the project layer (<root>/.devlog/standards); `global:` promotes a rule to
// the shared library explicitly; outside any project everything is global as
// before. Global-by-default leaked 29 of the author's own 62 rules across
// unrelated projects, so the safe default is the one whose failure is cheap.
describe("write scope: project by default inside a project, global: to promote", () => {
  const PROJ = join(TMP, "proj");
  const P = (...s: string[]) => join(PROJ, ".devlog", "standards", ...s);
  const exists = (p: string) => readFile(p, "utf-8").then(() => true, () => false);
  beforeEach(async () => { await mkdir(join(PROJ, ".devlog"), { recursive: true }); });

  test("defaultWriteScope: project when a .devlog sits above cwd, global without a cwd", () => {
    expect(std.defaultWriteScope(join(PROJ, "src"))).toBe("project");
    expect(std.defaultWriteScope(undefined)).toBe("global");
  });

  test("splitScopePrefix reads global:/project: and leaves the rest untouched", () => {
    expect(std.splitScopePrefix("global: rust")).toEqual({ scope: "global", rest: "rust" });
    expect(std.splitScopePrefix("PROJECT:platforms/vercel")).toEqual({ scope: "project", rest: "platforms/vercel" });
    expect(std.splitScopePrefix("rust text")).toEqual({ rest: "rust text" });
  });

  test("rule:new inside a project lands in .devlog/standards and the catalog marks it project-local", async () => {
    const r = await std.createCategory("platforms", "vercel", join(PROJ, "src"));
    expect(r.ok).toBe(true);
    expect(r.message).toContain("خاص بالمشروع");
    expect(await exists(P("platforms", "vercel.md"))).toBe(true);
    expect(await exists(join(TMP, "platforms", "vercel.md"))).toBe(false);
    expect((await std.scanCatalog(PROJ)).find(e => e.category === "vercel")?.scope).toBe("project");
    const add = await std.addRule("vercel", "لا تستخدم edge runtime للمسارات الثقيلة", PROJ);
    expect(add.ok).toBe(true);
    expect(add.message).toContain("خاص بالمشروع");
    expect(await readFile(P("platforms", "vercel.md"), "utf-8")).toContain("- لا تستخدم edge runtime");
  });

  test("rule:add on a name that exists only globally starts a project file under the same axis; the global file is untouched", async () => {
    const before = await readFile(join(TMP, "languages", "rust.md"), "utf-8");
    const r = await std.addRule("rust", "هذا المشروع يستخدم tokio وحده", PROJ);
    expect(r.ok).toBe(true);
    expect(await readFile(P("languages", "rust.md"), "utf-8")).toContain("- هذا المشروع يستخدم tokio وحده");
    expect(await readFile(join(TMP, "languages", "rust.md"), "utf-8")).toBe(before);
    // A second add appends to the same project file, no second template.
    await std.addRule("rust", "قاعدة ثانية", PROJ);
    const file = await readFile(P("languages", "rust.md"), "utf-8");
    expect(file.split("# rust").length).toBe(2);
    expect(file).toContain("- قاعدة ثانية");
  });

  test("global: promotes: rule:add/rule:new write the library from inside a project; project layer untouched", async () => {
    const add = await std.addRule("rust", "قاعدة عامة لكل مشاريع رست", PROJ, "global");
    expect(add.ok).toBe(true);
    expect(add.message).toContain("عام");
    expect(await readFile(join(TMP, "languages", "rust.md"), "utf-8")).toContain("- قاعدة عامة لكل مشاريع رست");
    expect(await exists(P("languages", "rust.md"))).toBe(false);
    const mk = await std.createCategory("platforms", "netlify", PROJ, "global");
    expect(mk.ok).toBe(true);
    expect(await exists(join(TMP, "platforms", "netlify.md"))).toBe(true);
    expect(await exists(P("platforms", "netlify.md"))).toBe(false);
    // global: on a name with no global file does not silently fall back to the project layer.
    await std.createCategory("platforms", "vercel", PROJ);
    const miss = await std.addRule("vercel", "x", PROJ, "global");
    expect(miss.ok).toBe(false);
    expect(miss.message).toContain("global:");
  });

  test("rule:rm: project file first, global twin when no project file; global: never touches the project file", async () => {
    await std.addRule("rust", "قاعدة المشروع", PROJ);            // project rust.md, 1 rule
    const rmProj = await std.removeRule("rust", 1, PROJ);
    expect(rmProj.ok).toBe(true);
    expect(rmProj.message).toContain("خاص بالمشروع");
    expect(await readFile(join(TMP, "languages", "rust.md"), "utf-8")).toContain("- استخدم Result بدل panic");
    // No project desktop-gui → falls through to the global one.
    const rmGlobal = await std.removeRule("desktop-gui", 1, PROJ);
    expect(rmGlobal.ok).toBe(false); // seed has 0 rules there: out of range, but resolved
    expect(rmGlobal.message).toContain("desktop-gui");
    // Explicit global: removes from the library even though a project rust.md exists.
    await std.addRule("rust", "قاعدة المشروع", PROJ);
    const rmG = await std.removeRule("rust", 2, PROJ, "global");
    expect(rmG.ok).toBe(true);
    expect(rmG.message).toContain("عام");
    expect(await readFile(P("languages", "rust.md"), "utf-8")).toContain("- قاعدة المشروع");
  });

  test("same-scope twin refused, cross-scope twin allowed with a note", async () => {
    await std.createCategory("platforms", "vercel", PROJ);
    const dup = await std.createCategory("platforms", "vercel", PROJ);
    expect(dup.ok).toBe(false);
    expect(dup.message).toContain("خاص بالمشروع");
    const aug = await std.createCategory("languages", "rust", PROJ);
    expect(aug.ok).toBe(true);
    expect(aug.message).toContain("بجانب");
  });

  test("project: without a cwd refuses and writes nowhere", async () => {
    // (A cwd with no .devlog above it can't be staged from inside this repo —
    // projectStandardsDir walks up and would find D:/helper/.devlog.)
    const r = await std.createCategory("platforms", "vercel", undefined, "project");
    expect(r.ok).toBe(false);
    expect(r.message).toContain(".devlog");
    expect(await exists(join(TMP, "platforms", "vercel.md"))).toBe(false);
  });

  test("command forms: bare → project, global: → library, project: → project; rule:rm honours the prefix", async () => {
    const cmds = std.parseRuleCommands([
      "-(rule:new) platforms/vercel",
      "-(rule:new) global:platforms/netlify",
      "-(rule:new) project:platforms/fly",
      "-(rule:add) rust\nقاعدة مشروع عبر الأمر",
      "-(rule:add) global:rust\nقاعدة عامة عبر الأمر",
      "-(rule:rm) global:rust #3",
    ].join("\n"));
    const out = await std.runRuleCommands(cmds, PROJ);
    expect(out.output).not.toContain("✗");
    expect(await exists(P("platforms", "vercel.md"))).toBe(true);
    expect(await exists(join(TMP, "platforms", "netlify.md"))).toBe(true);
    expect(await exists(P("platforms", "netlify.md"))).toBe(false);
    expect(await exists(P("platforms", "fly.md"))).toBe(true);
    expect(await readFile(P("languages", "rust.md"), "utf-8")).toContain("- قاعدة مشروع عبر الأمر");
    const glob = await readFile(join(TMP, "languages", "rust.md"), "utf-8");
    expect(glob).not.toContain("قاعدة مشروع عبر الأمر");
    expect(glob).not.toContain("قاعدة عامة عبر الأمر"); // added as #3 then removed by global:rust #3
  });

  test("formatCatalogNames stars project-local entries with a legend; listCatalog's split view has no stars", async () => {
    await std.createCategory("platforms", "vercel", PROJ);
    const names = std.formatCatalogNames(await std.scanCatalog(PROJ));
    expect(names).toContain("vercel*");
    expect(names).toContain("* = خاص بالمشروع");
    expect(names).not.toContain("rust*");
    expect(std.formatCatalogNames(await std.scanCatalog())).not.toContain("*");
    const list = await std.listCatalog(PROJ);
    expect(list).toContain("vercel");
    expect(list).not.toContain("vercel*");
  });
});

// #1241: the global library follows CLAUDE_CONFIG_DIR like memory cards and
// sessions do (#135) — a relocated Claude folder must not split them.
describe("standardsDir honors CLAUDE_CONFIG_DIR", () => {
  test("DEVLOG_STANDARDS_DIR wins; otherwise <CLAUDE_CONFIG_DIR>/standards", () => {
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = join(TMP, "moved-claude");
      expect(std.standardsDir()).toBe(TMP);
      delete process.env.DEVLOG_STANDARDS_DIR;
      expect(std.standardsDir()).toBe(join(TMP, "moved-claude", "standards"));
    } finally {
      process.env.DEVLOG_STANDARDS_DIR = TMP;
      if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    }
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
  test("#1131: the rule:rm lifecycle event carries the removed rule's text, not just its sliding number", async () => {
    const add = std.parseRuleCommands("-(rule:add) desktop-gui\n[فحص] قاعدة مؤقتة للحذف");
    const events: Array<{ action: "ack" | "adopt" | "remove"; rule: string; detail?: string }> = [];
    await std.runRuleCommands(add, undefined, events);
    expect(events[0]).toMatchObject({ action: "adopt", rule: "desktop-gui", detail: "[فحص] قاعدة مؤقتة للحذف" });
    const n = std.parseRules(await readFile(join(TMP, "app-types", "desktop-gui.md"), "utf-8")).length;
    const rm = std.parseRuleCommands(`-(rule:rm) desktop-gui #${n}`);
    const rmEvents: Array<{ action: "ack" | "adopt" | "remove"; rule: string; detail?: string }> = [];
    await std.runRuleCommands(rm, undefined, rmEvents);
    expect(rmEvents[0]).toEqual({ action: "remove", rule: `desktop-gui #${n}`, detail: "قاعدة مؤقتة للحذف" });
  });

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
