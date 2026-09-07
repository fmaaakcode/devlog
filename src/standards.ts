// Standards library — the user's coding rules and project criteria, so they
// don't have to repeat the same instructions to Claude every session. Two
// layers: a GLOBAL library (`<claude config>/standards`) for rules like "Rust →
// always use Result, no unwrap" that apply to *every* Rust project, and a
// PROJECT layer (`<root>/.devlog/standards`, #222) for rules that only make
// sense in one project. Writes land in the project layer by default when the
// hook runs inside a tracked project (see defaultWriteScope): the old
// global-by-default leaked project rules into every other project (issue #1).
//
// Layout (axes): each `.md` file is one CATEGORY. Folders are orthogonal axes:
//   languages/   rust.md, c.md, cpp.md
//   platforms/   windows.md, linux.md, web.md
//   app-types/   desktop-gui.md, cli.md, website.md
//   cross-cutting/ security.md, performance.md, testing.md
// A single task pulls several categories across axes (e.g. a Windows desktop
// app in Rust → rust + windows + desktop-gui).
//
// This module is intentionally self-contained and FS-only: the Stop hook
// imports it directly and serves/writes rules even when the server is down.
// The server only reads the catalog NAMES for SessionStart awareness injection.

import { readdir, readFile, mkdir } from "node:fs/promises";
import { atomicWriteText } from "./atomic-write";
import { addAck, listAcks } from "./standards-ack";
import { join } from "node:path";
import { claudeConfigDir, normalizeSlashes } from "./path-utils";
import { categoryMatches, defaultWriteScope, findCategory, projectStandardsDir, splitScopePrefix } from "./standards-scope";
import type { StandardsScope } from "./standards-scope";
// Re-exported so existing importers (hooks, tests) keep one entry point.
export { projectStandardsDir, defaultWriteScope, splitScopePrefix } from "./standards-scope";
export type { StandardsScope } from "./standards-scope";
import { currentLang } from "./i18n";
import { escapeRegex } from "./regex-escape";

// i18n policy (#906): this was the widest all-Arabic surface left — every
// -(ask:rules) answer and rule-command error. i18n.ts is env-only, so the
// module stays importable by the standalone Stop hook.
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

// Read dynamically (not a captured const) so a process that changes
// DEVLOG_STANDARDS_DIR after load — and the test suite, which points it at a
// temp dir — sees the current value on every call. Rooted at claudeConfigDir()
// (#1241): a hardcoded homedir()/.claude ignored CLAUDE_CONFIG_DIR, so on a
// machine whose Claude folder was relocated the memory cards and sessions
// followed the move (#135) while the standards library kept reading the old
// place.
export function standardsDir(): string {
  return process.env.DEVLOG_STANDARDS_DIR || join(claudeConfigDir(), "standards");
}

// The command verbs Claude can emit. Parsed by a dedicated regex here — kept
// OUT of src/tag-parser.ts's ALLOWED_TAGS on purpose so the existing tag
// pipeline (dedup / closure / release) is untouched and these never get
// persisted as project-history tags.
export const RULE_COMMANDS = [
  "ask:rules", "rule:add", "rule:new", "rules:list", "rule:rm", "rule:ack", "rule:acks",
] as const;
export type RuleCommandName = (typeof RULE_COMMANDS)[number];

export interface CatalogEntry {
  category: string; // file name without .md — the slug Claude requests
  axis: string;     // parent folder (languages / platforms / ...) or "(root)"
  path: string;
  scope: "global" | "project"; // global library vs <project>/.devlog/standards
}

export interface RuleCommand {
  cmd: RuleCommandName;
  argLine: string; // trimmed remainder of the command line
  body: string;    // trimmed lines after the command line (rule:add text)
  /** Stable key for loop-guard dedup across block continuations. */
  key: string;
}

// STORAGE FORMAT, not a display string: existing standards files carry the
// Arabic heading, files created under an English env get the English one — so
// reads must accept BOTH forever, while writes follow the current language.
const RULES_HEADINGS = new Set(["## القواعد", "## Rules"]);
const rulesHeading = () => L("## Rules", "## القواعد");

// ── Catalog discovery ────────────────────────────────────────────────────────
function isHiddenFile(name: string): boolean {
  return name.startsWith("_") || /^readme\.md$/i.test(name);
}

/** Walk one base dir one level deep (axis folders) plus root-level .md files. */
async function scanDir(baseDir: string, scope: "global" | "project"): Promise<CatalogEntry[]> {
  const out: CatalogEntry[] = [];
  let top: Array<{ name: string; isDir: boolean }>;
  try {
    top = (await readdir(baseDir, { withFileTypes: true })).map(d => ({
      name: d.name, isDir: d.isDirectory(),
    }));
  } catch {
    return out;
  }
  for (const ent of top) {
    if (ent.isDir) {
      let files: string[];
      try { files = await readdir(join(baseDir, ent.name)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".md") || isHiddenFile(f)) continue;
        out.push({ category: f.slice(0, -3), axis: ent.name, path: join(baseDir, ent.name, f), scope });
      }
    } else if (ent.name.endsWith(".md") && !isHiddenFile(ent.name)) {
      out.push({ category: ent.name.slice(0, -3), axis: "(root)", path: join(baseDir, ent.name), scope });
    }
  }
  return out;
}

/**
 * Catalog = the global library (~/.claude/standards) merged with the project's
 * own layer (<project>/.devlog/standards) when `cwd` is given (#222). The same
 * category may appear in both scopes; readCategories surfaces both so a project
 * rule augments — never silently replaces — the global one. Missing dirs → just
 * fewer entries (the feature stays dormant until files exist).
 */
export async function scanCatalog(cwd?: string): Promise<CatalogEntry[]> {
  const out = await scanDir(standardsDir(), "global");
  if (cwd) {
    const projDir = projectStandardsDir(cwd);
    if (projDir) out.push(...await scanDir(projDir, "project"));
  }
  out.sort((a, b) => a.axis.localeCompare(b.axis) || a.category.localeCompare(b.category));
  return out;
}

/** Compact "axis: a, b | axis2: c" line for SessionStart awareness injection. */
/** `markScope`: star project-local entries (`vercel*`) with a trailing legend
 *  so the SessionStart line never presents another layer's category as this
 *  project's (issue #1). A star, not a word: Claude copies these names into
 *  `-(ask:rules)`, and a space-separated tag would parse as a second category.
 *  listCatalog already splits the layers and passes false. */
export function formatCatalogNames(catalog: CatalogEntry[], markScope = true): string {
  const byAxis = new Map<string, string[]>();
  let starred = false;
  for (const e of catalog) {
    const arr = byAxis.get(e.axis) || [];
    const star = markScope && e.scope === "project";
    starred ||= star;
    arr.push(star ? `${e.category}*` : e.category);
    byAxis.set(e.axis, arr);
  }
  const line = [...byAxis.entries()].map(([axis, cats]) => `${axis}: ${cats.join(", ")}`).join(" | ");
  return starred ? `${line} | ${L("* = project-local", "* = خاص بالمشروع")}` : line;
}

// ── Command parsing ──────────────────────────────────────────────────────────
/**
 * Extract rule commands from an assistant message. Mirrors tag-parser's shape
 * (strip code first so a command mentioned inside a fence isn't captured) but
 * uses its OWN verb set and terminator so it never collides with DevLog tags.
 * The body runs until the next `-(...)` at line start or end-of-message, which
 * lets `-(rule:add)` carry a multi-line rule.
 */
// escapeRegex (shared, src/regex-escape.ts): not `RegExp.escape` — the spec
// hex-encodes a leading alphanumeric (`\x61…`), which would break the string
// comparisons/alternations built on the escaped text.

export function parseRuleCommands(msg: string): RuleCommand[] {
  if (!msg) return [];
  // Code stripping is a DETECTION aid only (a command mentioned inside a fence
  // must not fire). The replacement preserves length, so every offset in
  // `stripped` maps 1:1 onto `msg`: match against `stripped`, slice the arg
  // line + body from `msg`. Extracting from the stripped copy blanked every
  // inline-code span out of stored rules (rust #3 lost both command names,
  // security #7 / design #3 lost the category name) — the same defect
  // tag-parser fixed for 288 tags, left unpatched on this parallel copy.
  const stripped = msg
    .replace(/```[\s\S]*?```/g, m => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, m => " ".repeat(m.length));
  const alt = RULE_COMMANDS.map(escapeRegex).join("|");
  // Body = the following NON-BLANK lines, up to the next `-(...)` line, a blank
  // line, or end-of-message. Requiring each body line to contain a non-space
  // char (`[ \t]*\S`) means a blank line terminates the body — so trailing prose
  // after a `-(rule:add)` (e.g. the rest of the assistant's reply) is NOT
  // swallowed into the rule. It also keeps back-to-back commands separate.
  const pattern = new RegExp(
    `(?:^|\\n)[ \\t]*-\\s*\\((${alt})\\)[ \\t]*([^\\n]*)((?:\\n(?![ \\t]*-\\s*\\()[ \\t]*\\S[^\\n]*)*)`,
    "gd",
  );
  const out: RuleCommand[] = [];
  for (const m of stripped.matchAll(pattern)) {
    const cmd = m[1] as RuleCommandName;
    const idx = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices;
    const sliceOf = (g: number) => { const r = idx?.[g]; return r ? msg.slice(r[0], r[1]) : ""; };
    const argLine = sliceOf(2).trim();
    const body = sliceOf(3).trim();
    // Ledger key from the FIRST body line only (#760): keying the full body let
    // a body that GREW between two reads of the same turn (a continuation's
    // prose gluing onto it) mint a fresh key and re-execute the command — the
    // duplicated-rule incident. The command line + first body line identify the
    // instance; growth beyond them must not create a new identity.
    out.push({ cmd, argLine, body, key: `${cmd}|${argLine}|${body.split("\n")[0] || ""}` });
  }
  return out;
}

// ── Rule numbering / extraction within a file ────────────────────────────────
const BULLET_RE = /^[ \t]*-[ \t]+(?:\[[ xX]\][ \t]+)?(.*\S)\s*$/;

interface RuleBlock { headingIdx: number; bullets: Array<{ lineIdx: number; text: string }>; }

/** Locate the rules block (`## القواعد` / `## Rules`) and its bullet lines.
 *  The block runs until the next heading of the SAME or a higher level (#1128):
 *  authors group rules under `### 1) …` sub-headings inside the section, and
 *  ending at the first `###` hid 12 of design.md's 15 rules from every command
 *  (unnumbered in ask:rules, unreachable by rule:rm, invisible to rule:add's
 *  dedup and to checkRules). Bullets inside fenced code are examples, never
 *  rules. */
function locateRules(lines: string[]): RuleBlock {
  const headingIdx = lines.findIndex(l => RULES_HEADINGS.has(l.trim()));
  const bullets: Array<{ lineIdx: number; text: string }> = [];
  if (headingIdx < 0) return { headingIdx, bullets };
  const level = (lines[headingIdx].match(/^(#{1,6})[ \t]/)?.[1].length) ?? 2;
  let inFence = false;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})[ \t]/);
    if (h && h[1].length <= level) break;   // a peer/parent heading ends the block; a sub-heading does not
    const m = line.match(BULLET_RE);
    if (m) bullets.push({ lineIdx: i, text: m[1].trim() });
  }
  return { headingIdx, bullets };
}

// ── Rule kind: check (verifiable, may block) vs guide (advisory) ─────────────
// A rule bullet may declare its enforcement class with a leading marker:
//   [فحص] / [check]  → verifiable: the gate may BLOCK on a real violation.
//   [نصيحة] / [guide] → advisory: injected as context, NEVER blocks.
// Unmarked rules default to "guide" — the safe, non-annoying default. A rule
// only gains blocking power when its author explicitly opts in with [فحص]. This
// is the P1 foundation the P2–P4 checkers key off (verify-output vs teach-only).
export type RuleKind = "check" | "guide";

const RULE_KIND_RE = /^\[\s*(check|فحص|guide|نصيحة)\s*\]\s*/i;

/** Split a rule bullet into its kind and clean text (marker stripped). */
export function classifyRule(text: string): { kind: RuleKind; text: string } {
  const raw = text || "";
  const m = raw.match(RULE_KIND_RE);
  if (!m) return { kind: "guide", text: raw.trim() };
  const marker = m[1].toLowerCase();
  const kind: RuleKind = marker === "check" || marker === "فحص" ? "check" : "guide";
  return { kind, text: raw.slice(m[0].length).trim() };
}

export interface ParsedRule { num: number; kind: RuleKind; text: string; }

/** All rules in a category's content, numbered, with their kind resolved. */
export function parseRules(content: string): ParsedRule[] {
  const { bullets } = locateRules(content.split("\n"));
  return bullets.map((b, i) => {
    const { kind, text } = classifyRule(b.text);
    return { num: i + 1, kind, text };
  });
}

/** Only the verifiable (`check`) rules — what an enforcement gate may block on. */
export function checkRules(content: string): ParsedRule[] {
  return parseRules(content).filter(r => r.kind === "check");
}

// A rule's identity is its TEXT, not its enforcement class — so dedup strips the
// kind marker (adding "[فحص] X" when "X" already exists is the same rule).
function normRule(s: string): string {
  return classifyRule(s).text.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Render a category's content with its rules numbered (#1, #2, …) for display,
 *  each annotated with a canonical kind label so Claude sees what is ENFORCED
 *  ([فحص]) vs merely ADVISED ([نصيحة]) — regardless of how the author wrote it. */
function numberForDisplay(content: string): string {
  const lines = content.split("\n");
  const { bullets } = locateRules(lines);
  bullets.forEach((b, i) => {
    const { kind, text } = classifyRule(b.text);
    const label = kind === "check" ? L("[check]", "[فحص]") : L("[guide]", "[نصيحة]");
    const indentMatch = lines[b.lineIdx].match(/^[ \t]*-[ \t]+/);
    const prefix = indentMatch ? indentMatch[0] : "- ";
    lines[b.lineIdx] = `${prefix}#${i + 1} ${label} ${text}`;
  });
  return lines.join("\n");
}

// ── Read ─────────────────────────────────────────────────────────────────────
export interface ReadResult { output: string; found: number; missing: string[]; }

/** Read one or more categories for `-(ask:rules)`. Unknown categories get an
 *  explicit "not found" notice listing the nearest available names. */
export async function readCategories(cats: string[], cwd?: string): Promise<ReadResult> {
  const catalog = await scanCatalog(cwd);
  const blocks: string[] = [];
  const missing: string[] = [];
  let found = 0;
  for (const cat of cats) {
    const norm = cat.trim().toLowerCase();
    // ALL entries for this name across scopes — global first (catalog is sorted
    // by axis/category, but we order global-before-project here for display).
    const entries = catalog
      .filter(e => e.category.toLowerCase() === norm)
      .sort((a, b) => (a.scope === "project" ? 1 : 0) - (b.scope === "project" ? 1 : 0));
    if (!entries.length) { missing.push(cat); continue; }
    let readAny = false;
    for (const entry of entries) {
      try {
        const raw = await readFile(entry.path, "utf-8");
        const scopeLabel = entry.scope === "project" ? L(" — project-local", " — خاص بالمشروع") : "";
        blocks.push(`════════ ${L("standards", "معايير")}: ${entry.category} (${entry.axis}${scopeLabel}) ════════\n${numberForDisplay(raw).trim()}`);
        readAny = true;
      } catch { /* unreadable file in one scope — try the others */ }
    }
    if (readAny) found++; else missing.push(cat);
  }
  if (missing.length) {
    const avail = catalog.length ? formatCatalogNames(catalog) : L(
      "(the catalog is empty — add files under ~/.claude/standards)",
      "(الكتالوج فارغ — أضف ملفات في ~/.claude/standards)");
    blocks.push(L(
      `⚠ unknown categories: ${missing.join(", ")}\navailable: ${avail}`,
      `⚠ تصنيفات غير موجودة: ${missing.join(", ")}\nالمتاح: ${avail}`));
  }
  return { output: blocks.join("\n\n"), found, missing };
}

// ── Add a rule (append-only, dedup, never overwrites) ────────────────────────
export interface AddResult { ok: boolean; message: string; }

export async function addRule(cat: string, text: string, cwd?: string, scopeArg?: StandardsScope): Promise<AddResult> {
  const ruleText = text.trim();
  if (!ruleText) return { ok: false, message: L("empty rule text.", "نص القاعدة فارغ.") };
  const scope = scopeArg ?? defaultWriteScope(cwd);
  const catalog = await scanCatalog(cwd);
  let entry = findCategory(catalog, cat, scope);
  if (!entry && scope === "project") {
    // The name exists only globally: start a project-local file under the same
    // axis instead of appending to the shared one (issue #1). The rule was
    // written from inside THIS project, so this is where it belongs until
    // someone promotes it with `global:`.
    const twin = findCategory(catalog, cat, "global");
    const projDir = cwd ? projectStandardsDir(cwd) : null;
    if (twin && projDir) {
      const axisDir = twin.axis === "(root)" ? projDir : join(projDir, twin.axis);
      const path = join(axisDir, `${twin.category}.md`);
      await mkdir(axisDir, { recursive: true });
      if (!(await Bun.file(path).exists())) await atomicWriteText(path, categoryTemplate(twin.category));
      entry = { category: twin.category, axis: twin.axis, path, scope: "project" };
    }
  }
  if (!entry) {
    const hint = scope === "global" ? "global:" : "";
    return { ok: false, message: L(
      `category "${cat}" does not exist${scope === "global" ? " in the global library" : ""}. Create it first with -(rule:new) ${hint}<axis>/${cat}`,
      `التصنيف "${cat}" غير موجود${scope === "global" ? " في المكتبة العامة" : ""}. أنشئه أولاً بـ -(rule:new) ${hint}<محور>/${cat}`) };
  }
  const raw = await readFile(entry.path, "utf-8");
  const lines = raw.split("\n");
  const { headingIdx, bullets } = locateRules(lines);

  // Dedup on the FIRST line only, both sides: `bullets[].text` is each stored
  // rule's bullet line, so comparing the whole incoming text against it let any
  // glued tail (the assistant's own "تمّت الإضافة…" confirmation prose landing
  // in the body) defeat the check and append a second copy WITH its tail —
  // design #2/#3, security #6/#7. Same family as #760 (body growth minting a
  // new identity); the first line is the rule's identity here as it is there.
  const needle = normRule(ruleText.split("\n")[0]);
  if (bullets.some(b => normRule(b.text) === needle)) {
    return { ok: true, message: L(
      `already present in "${entry.category}" — no duplicate added.`,
      `موجودة مسبقاً في "${entry.category}" — لم تُضف نسخة مكررة.`) };
  }

  // Multi-line rules: keep the first line as the bullet, indent the rest.
  const ruleLines = ruleText.split("\n");
  const bulletBlock = [`- ${ruleLines[0].trim()}`, ...ruleLines.slice(1).map(l => `  ${l.trim()}`)];

  if (headingIdx < 0) {
    // No rules section yet — append one at the end.
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(rulesHeading(), ...bulletBlock);
  } else {
    // Insert after the last existing bullet's WHOLE block (append-only,
    // preserves order). #769: a multi-line rule's continuation lines sit under
    // its bullet without matching BULLET_RE, so inserting right after the
    // bullet LINE split the old rule and glued its body onto the new one —
    // skip past the continuation lines (stop at blank / heading / EOF; a
    // bullet can't follow, the anchor is the LAST one).
    let insertAt = headingIdx + 1;
    if (bullets.length) {
      insertAt = bullets[bullets.length - 1].lineIdx + 1;
      while (insertAt < lines.length
        && lines[insertAt].trim() !== ""
        && !/^#{1,6}[ \t]/.test(lines[insertAt])) insertAt++;
    }
    lines.splice(insertAt, 0, ...bulletBlock);
  }
  await atomicWriteText(entry.path, lines.join("\n"));
  return { ok: true, message: L(
    `added to "${entry.category}" (#${bullets.length + 1}, ${entry.scope === "project" ? "project-local" : "global"}).`,
    `أُضيفت لـ "${entry.category}" (#${bullets.length + 1}، ${entry.scope === "project" ? "خاص بالمشروع" : "عام"}).`) };
}

// ── Create a new category ────────────────────────────────────────────────────
const KNOWN_AXES = ["languages", "runtimes", "frameworks", "platforms", "app-types", "cross-cutting"];

function categoryTemplate(cat: string): string {
  return L(`# ${cat} — standards

## When it applies

(One line: when should Claude pull this category.)

${rulesHeading()}
`, `# ${cat} — معايير

## متى تنطبق

(اشرح بسطر متى يسحب كلود هذا التصنيف.)

${rulesHeading()}
`);
}

export interface NewResult { ok: boolean; message: string; }

/** `-(rule:new) [global:|project:]<axis>/<category>` (or "<axis> <category>").
 *  Claude picks the axis from its understanding of the rule. Creates the
 *  folder if needed. Scope defaults per defaultWriteScope (project layer
 *  inside a tracked project, global outside); the prefix overrides it. */
export async function createCategory(axisRaw: string, cat: string, cwd?: string, scopeArg?: StandardsScope): Promise<NewResult> {
  const scope = scopeArg ?? defaultWriteScope(cwd);
  const axis = axisRaw.trim().toLowerCase();
  const category = cat.trim().toLowerCase();
  if (!axis || !category) return { ok: false, message: L("syntax: -(rule:new) <axis>/<category>", "الصيغة: -(rule:new) <محور>/<تصنيف>") };
  // Validate BOTH segments against a strict charset before building the path:
  // `axis` flows into join(standardsDir(), axis), so an unvalidated "../.." would
  // let -(rule:new) write a .md file outside the standards dir (path traversal).
  if (!/^[a-z0-9_-]+$/.test(category)) {
    return { ok: false, message: L(
      `invalid category name: "${category}" (lowercase letters, digits and - only).`,
      `اسم تصنيف غير صالح: "${category}" (حروف صغيرة وأرقام و - فقط).`) };
  }
  if (!/^[a-z0-9_-]+$/.test(axis)) {
    return { ok: false, message: L(
      `invalid axis name: "${axis}" (lowercase letters, digits and - only).`,
      `اسم محور غير صالح: "${axis}" (حروف صغيرة وأرقام و - فقط).`) };
  }
  // With cwd the scan sees the project layer too (#1130): a category that
  // lives only in .devlog/standards is "already exists", not an invitation to
  // mint a global twin with the same name.
  // Project scope needs a project: the layer lives under the nearest `.devlog`
  // above cwd, and a cwd outside any tracked project has nowhere to write.
  let baseDir = standardsDir();
  if (scope === "project") {
    const projDir = cwd ? projectStandardsDir(cwd) : null;
    if (!projDir) {
      return { ok: false, message: L(
        "project-local category needs a DevLog-tracked project (no .devlog folder above the working directory).",
        "التصنيف الخاص بالمشروع يحتاج مشروعًا يتتبعه DevLog (لا مجلد .devlog فوق مجلد العمل).") };
    }
    baseDir = projDir;
  }
  const catalog = await scanCatalog(cwd);
  const matches = categoryMatches(catalog, category);
  // Only a same-scope twin blocks. A twin in the other scope is what two
  // layers are FOR (augment-on-read, #222; promote or shadow deliberately) —
  // say so instead of refusing.
  const existing = findCategory(catalog, category, scope);
  if (existing) {
    const where = existing.scope === "project" ? L(" (project-local, .devlog/standards)", " (خاص بالمشروع، .devlog/standards)") : "";
    return { ok: false, message: L(
      `category "${category}" already exists${where} — use -(rule:add) to extend it.`,
      `التصنيف "${category}" موجود مسبقاً${where} — استخدم -(rule:add) للإضافة إليه.`) };
  }
  const other = matches.find(e => e.scope !== scope);
  const augments = other ? L(
    ` — alongside the ${other.scope === "global" ? "global" : "project-local"} "${category}" (ask:rules shows both)`,
    ` — بجانب "${category}" ${other.scope === "global" ? "العام" : "الخاص بالمشروع"} (ask:rules يعرض الاثنين)`) : "";
  const axisHint = KNOWN_AXES.includes(axis) ? "" : L(
    ` (new axis outside the usual: ${KNOWN_AXES.join("/")})`,
    ` (محور جديد خارج المعتاد: ${KNOWN_AXES.join("/")})`);
  const dir = join(baseDir, axis);
  const target = join(dir, `${category}.md`);
  // #1129: the catalog scan above swallows a readdir failure as "no entries",
  // so on a transient read error `-(rule:new) languages/rust` sailed past the
  // duplicate check and REPLACED rust.md with the empty template. The disk is
  // the authority for "already exists" — ask it directly before writing.
  if (await Bun.file(target).exists()) {
    return { ok: false, message: L(
      `category file already exists at ${target} — the catalog scan could not list it; nothing was overwritten. Use -(rule:add) to extend it.`,
      `ملف التصنيف موجود فعلًا في ${target} — تعذّر على مسح الكتالوج إدراجه، ولم يُستبدل شيء. استخدم -(rule:add) للإضافة إليه.`) };
  }
  await mkdir(dir, { recursive: true });
  await atomicWriteText(target, categoryTemplate(category));
  const place = scope === "project" ? L("project-local category", "تصنيف خاص بالمشروع") : L("global category", "تصنيف عام");
  const under = scope === "project" ? `.devlog/standards/${axis}/` : `${axis}/`;
  return { ok: true, message: L(
    `created ${place} "${category}" under ${under}${axisHint}${augments}. Add its rules with -(rule:add) ${category}`,
    `أُنشئ ${place} "${category}" في ${under}${axisHint}${augments}. أضِف قواعده بـ -(rule:add) ${category}`) };
}

// ── Remove a rule by number ──────────────────────────────────────────────────
export interface RemoveResult {
  ok: boolean;
  message: string;
  /** The removed rule's bullet text (kind marker included) — the lifecycle
   *  `remove` record carries its first line so rule-effect can pair it with
   *  the adopt record and end that rule's after-window (#1131). */
  removed?: string;
}

export async function removeRule(cat: string, num: number, cwd?: string, scopeArg?: StandardsScope): Promise<RemoveResult> {
  const scope = scopeArg ?? defaultWriteScope(cwd);
  const catalog = await scanCatalog(cwd);
  // Project scope falls through to the global twin (nothing to create here);
  // an explicit `global:` never touches the project file.
  const entry = findCategory(catalog, cat, scope, scope === "project");
  if (!entry) return { ok: false, message: L(`category "${cat}" does not exist.`, `التصنيف "${cat}" غير موجود.`) };
  const raw = await readFile(entry.path, "utf-8");
  const lines = raw.split("\n");
  const { bullets } = locateRules(lines);
  if (num < 1 || num > bullets.length) {
    return { ok: false, message: L(
      `#${num} out of range — "${entry.category}" has ${bullets.length} rule(s).`,
      `#${num} خارج النطاق — "${entry.category}" فيه ${bullets.length} قاعدة.`) };
  }
  const target = bullets[num - 1];
  // Remove the bullet line plus any indented continuation lines that follow it.
  let end = target.lineIdx + 1;
  while (end < lines.length && /^[ \t]+\S/.test(lines[end]) && !lines[end].match(BULLET_RE)) end++;
  const removed = bullets[num - 1].text;
  lines.splice(target.lineIdx, end - target.lineIdx);
  await atomicWriteText(entry.path, lines.join("\n"));
  return { ok: true, removed, message: L(
    `removed #${num} from "${entry.category}" (${entry.scope === "project" ? "project-local" : "global"}): ${removed.slice(0, 60)}`,
    `حُذفت #${num} من "${entry.category}" (${entry.scope === "project" ? "خاص بالمشروع" : "عام"}): ${removed.slice(0, 60)}`) };
}

// ── List the catalog ─────────────────────────────────────────────────────────
export async function listCatalog(cwd?: string): Promise<string> {
  const catalog = await scanCatalog(cwd);
  if (!catalog.length) return L(
    "the catalog is empty — add .md files under ~/.claude/standards/<axis>/",
    "الكتالوج فارغ — أضف ملفات .md في ~/.claude/standards/<محور>/");
  const globalCats = catalog.filter(e => e.scope === "global");
  const projectCats = catalog.filter(e => e.scope === "project");
  let out = `${L("catalog", "الكتالوج")} (${catalog.length} ${L("categories", "تصنيف")}):\n${formatCatalogNames(globalCats)}`;
  if (projectCats.length) out += `\n${L("project-local", "خاص بالمشروع")} (.devlog/standards): ${formatCatalogNames(projectCats, false)}`;
  const unfilled: string[] = [];
  for (const e of catalog) {
    let raw = "";
    try { raw = await readFile(e.path, "utf-8"); } catch { continue; }
    if (lacksWhenApplies(raw)) unfilled.push(e.category);
  }
  if (unfilled.length) out += `\n${L(
    `⚠ no "when it applies" line yet (section missing, empty, or still the template text): ${unfilled.join(", ")} — fill the line under "## When it applies" in the file, one sentence.`,
    `⚠ بلا شرط تطبيق بعد (القسم غائب أو فارغ أو ما زال نص القالب): ${unfilled.join(", ")} — عبّئ السطر تحت «## متى تنطبق» في الملف بجملة واحدة.`)}`;
  return out;
}

// A category gives Claude a pull criterion only when its "when it applies"
// section holds a real sentence. #1174 / F-9.32: the check used to match the
// template placeholder rule:new writes and nothing else, so an author who
// DELETED the section instead of filling it, or edited the placeholder by one
// character, read as "has a condition" and rules:list never warned. Now the
// section must exist (either language) and carry a line that is neither blank
// nor a parenthesised placeholder — the template text is just one such line.
const WHEN_HEADING_RE = /^#{1,6}[ \t]+(?:When it applies|متى تنطبق)[ \t]*$/im;
export function lacksWhenApplies(content: string): boolean {
  const lines = content.split("\n");
  const start = lines.findIndex(l => WHEN_HEADING_RE.test(l));
  if (start < 0) return true;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#{1,6}[ \t]/.test(t)) break;               // next section — nothing found
    if (!t) continue;
    if (/^\(.*\)$/.test(t)) continue;                // a parenthesised placeholder, template or edited
    return false;
  }
  return true;
}

// ── Per-project markers (exemption + acks) — extracted to standards-ack.ts ───
// Re-exported so the many existing importers (write-checks, hooks, routes,
// tests) keep their single `./standards` entry point.
export {
  ENFORCE_MARKER, enforceMarkerPath, isEnforcementDisabled,
  ACK_MARKER, readAcks, isAcked, type AckResult, addAck, listAcks,
} from "./standards-ack";

// Is a written file "code" for enforcement? Excludes docs/manifests/assets and
// anything under .devlog, so doc-only or DevLog-internal edits don't trip the gate.
const NON_CODE_RE = /\.(md|txt|json|lock|toml|ya?ml|csv|svg|png|jpe?g|gif|ico|pdf)$/i;
export function isCodeWrite(filePath: string): boolean {
  const f = normalizeSlashes(filePath).toLowerCase();
  if (!f) return false;
  if (f.includes("/.devlog/")) return false;
  return !NON_CODE_RE.test(f);
}

// ── File → language mapping ──────────────────────────────────────────────────
// Extension (lowercased, no dot) → language category slug. Header ambiguity
// (.h could be C or C++) resolves to C by convention; a C++ project that wants
// otherwise can pull cpp explicitly.
const EXT_LANG: Record<string, string> = {
  rs: "rust",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  go: "go",
  py: "python", pyi: "python",
  rb: "ruby",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp", "c++": "cpp",
  cs: "csharp",
  php: "php",
  zig: "zig",
};

// The set of category slugs EXT_LANG can produce — "is this catalog category a
// LANGUAGE?" for consumers that scope analysis by file extension (rule-effect).
const LANG_CATEGORIES = new Set(Object.values(EXT_LANG));
export function isLanguageCategory(cat: string): boolean {
  return LANG_CATEGORIES.has(cat.toLowerCase());
}

/** The language category for a file path, by extension. null when unknown. */
export function langForFile(filePath: string): string | null {
  const f = normalizeSlashes(filePath).toLowerCase();
  const base = f.slice(f.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_LANG[base.slice(dot + 1)] ?? null;
}

// ── Template resolution (P3) ─────────────────────────────────────────────────
// Standards files keep the STABLE intent and mark the VOLATILE value with
// {{latest:lang}} / {{edition:lang}} placeholders. The caller fetches live values
// (registry.ts latestToolchain) and passes them here. A missing value becomes a
// textual pointer ("أحدث إصدار…") rather than a broken/empty literal, so a
// transient network failure never injects a wrong number. Pure (no network/FS) so
// standards.ts stays importable by the hook standalone and is fully unit-testable.

const TEMPLATE_RE = /\{\{(latest|edition):([a-z0-9_+-]+)\}\}/gi;

/** Map keyed "latest:rust" / "edition:rust" → resolved value (null/undefined = unknown). */
export type TemplateValues = Record<string, string | null | undefined>;

/** The distinct placeholders a content references, so the caller knows which
 *  toolchains to fetch before resolving. */
export function templateLangs(content: string): Array<{ kind: string; lang: string }> {
  const out: Array<{ kind: string; lang: string }> = [];
  const seen = new Set<string>();
  for (const m of (content || "").matchAll(TEMPLATE_RE)) {
    const kind = m[1].toLowerCase();
    const lang = m[2].toLowerCase();
    const key = `${kind}:${lang}`;
    if (!seen.has(key)) { seen.add(key); out.push({ kind, lang }); }
  }
  return out;
}

/** Replace {{latest:lang}} / {{edition:lang}} with resolved values; unknowns
 *  become a pointer, never an empty/stale literal. */
export function resolveTemplate(content: string, values: TemplateValues): string {
  if (!content) return content;
  return content.replace(TEMPLATE_RE, (_m, kindRaw: string, langRaw: string) => {
    const kind = kindRaw.toLowerCase();
    const lang = langRaw.toLowerCase();
    const v = values[`${kind}:${lang}`];
    if (v) return v;
    return kind === "edition"
      ? L(`the latest ${lang} edition`, `أحدث edition لـ${lang}`)
      : L(`the latest stable ${lang} release`, `أحدث إصدار مستقر لـ${lang}`);
  });
}

/** A toolchain lookup (registry.ts `latestToolchain`), injected so this module
 *  itself stays network-free + the call is fakeable in tests. */
export type ToolchainResolver = (lang: string) => Promise<{ version: string | null; edition: string | null }>;

/**
 * Resolve every {{latest:lang}}/{{edition:lang}} in `content` by fetching each
 * referenced language's toolchain through the injected resolver. Network lives in
 * the resolver (the hook passes registry.ts's latestToolchain); standards.ts stays
 * FS-only as designed. Each language is fetched once; a resolver failure leaves
 * the value unset so resolveTemplate substitutes the pointer fallback.
 */
export async function resolveContentTemplates(content: string, resolve: ToolchainResolver): Promise<string> {
  const langs = templateLangs(content);
  if (!langs.length) return content;
  const values: TemplateValues = {};
  await Promise.all([...new Set(langs.map(l => l.lang))].map(async lang => {
    try {
      const info = await resolve(lang);
      values[`latest:${lang}`] = info.version;
      values[`edition:${lang}`] = info.edition;
    } catch { /* leave unset → pointer fallback */ }
  }));
  return resolveTemplate(content, values);
}

// ── Orchestrator: run a batch of commands, return text for the Stop hook ──────
export interface RunResult { output: string; }

/** Lifecycle event for rule telemetry (#787): pushed into the caller-supplied
 *  collector only when the command SUCCEEDED — the Stop hook forwards them to
 *  /api/rule-telemetry. Optional so existing callers/tests are untouched. */
export interface RuleLifecycleEvent { action: "ack" | "adopt" | "remove"; rule: string; detail?: string }

export async function runRuleCommands(cmds: RuleCommand[], cwd?: string, events?: RuleLifecycleEvent[]): Promise<RunResult> {
  const parts: string[] = [];
  for (const c of cmds) {
    if (c.cmd === "ask:rules") {
      const cats = c.argLine.split(/\s+/).filter(Boolean);
      if (!cats.length) { parts.push(L("⚠ -(ask:rules) without a category. Example: -(ask:rules) rust windows", "⚠ -(ask:rules) بلا تصنيف. مثال: -(ask:rules) rust windows")); continue; }
      const r = await readCategories(cats, cwd);
      parts.push(r.output);
    } else if (c.cmd === "rule:add") {
      const { scope, rest } = splitScopePrefix(c.argLine);
      const tokens = rest.split(/\s+/);
      const cat = tokens[0] || "";
      const inlineRest = tokens.slice(1).join(" ");
      const ruleText = [inlineRest, c.body].filter(Boolean).join("\n").trim();
      if (!cat) { parts.push(L("⚠ -(rule:add) without a category.", "⚠ -(rule:add) بلا تصنيف.")); continue; }
      const r = await addRule(cat, ruleText, cwd, scope);
      if (r.ok) events?.push({ action: "adopt", rule: cat, detail: ruleText.split("\n")[0].slice(0, 200) });
      parts.push(`${r.ok ? "✓" : "✗"} rule:add ${cat}: ${r.message}`);
    } else if (c.cmd === "rule:new") {
      const { scope, rest } = splitScopePrefix(c.argLine);
      const m = rest.match(/^([^/\s]+)\s*[/\s]\s*([^/\s]+)/);
      if (!m) { parts.push(L("⚠ syntax: -(rule:new) [global:|project:]<axis>/<category>", "⚠ الصيغة: -(rule:new) [global:|project:]<محور>/<تصنيف>")); continue; }
      const r = await createCategory(m[1], m[2], cwd, scope);
      parts.push(`${r.ok ? "✓" : "✗"} rule:new: ${r.message}`);
    } else if (c.cmd === "rules:list") {
      parts.push(await listCatalog(cwd));
    } else if (c.cmd === "rule:ack") {
      if (!cwd) { parts.push(L("⚠ rule:ack needs a project (cwd).", "⚠ rule:ack يحتاج مشروعاً (cwd).")); continue; }
      const key = c.argLine.trim();
      if (!key) { parts.push(L("⚠ syntax: -(rule:ack) <key> — e.g. cargo-edition, cargo-edition:2021, or dep:astro", "⚠ الصيغة: -(rule:ack) <مفتاح> — مثل cargo-edition أو cargo-edition:2021 أو dep:astro")); continue; }
      const r = await addAck(cwd, key);
      if (r.ok) events?.push({ action: "ack", rule: key });
      parts.push(`${r.ok ? "✓" : "✗"} rule:ack: ${r.message}`);
    } else if (c.cmd === "rule:acks") {
      parts.push(listAcks(cwd || ""));
    } else if (c.cmd === "rule:rm") {
      const { scope, rest } = splitScopePrefix(c.argLine);
      const m = rest.match(/^(\S+)\s+#?(\d+)/);
      if (!m) { parts.push(L("⚠ syntax: -(rule:rm) [global:]<category> #N", "⚠ الصيغة: -(rule:rm) [global:]<تصنيف> #N")); continue; }
      const r = await removeRule(m[1], parseInt(m[2], 10), cwd, scope);
      // `detail` = the removed rule's text: `#N` slides after every removal,
      // so the number alone can never be paired with the adopt record (#1131).
      if (r.ok) events?.push({ action: "remove", rule: `${m[1]} #${m[2]}`, ...(r.removed ? { detail: classifyRule(r.removed).text.slice(0, 200) } : {}) });
      parts.push(`${r.ok ? "✓" : "✗"} rule:rm: ${r.message}`);
    }
  }
  return { output: parts.filter(Boolean).join("\n\n") };
}
