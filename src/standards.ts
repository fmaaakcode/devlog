// Standards library — a global, reusable store of the user's coding rules and
// project criteria, so they don't have to repeat the same instructions to
// Claude every session. Lives outside any single project (`~/.claude/standards`)
// because a rule like "Rust → always use Result, no unwrap" applies to *every*
// Rust project; storing it per-project would defeat the whole point.
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

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { normalizeSlashes } from "./path-utils";
import { homedir } from "node:os";
import { isUiFile } from "./design-check";

// Read dynamically (not a captured const) so a process that changes
// DEVLOG_STANDARDS_DIR after load — and the test suite, which points it at a
// temp dir — sees the current value on every call.
export function standardsDir(): string {
  return process.env.DEVLOG_STANDARDS_DIR || join(homedir(), ".claude", "standards");
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
  /** Stable key for loop-guard dedup across exit(2) continuations. */
  key: string;
}

const RULES_HEADING = "## القواعد";

// ── Catalog discovery ────────────────────────────────────────────────────────
function isHiddenFile(name: string): boolean {
  return name.startsWith("_") || /^readme\.md$/i.test(name);
}

/**
 * The project-local standards layer (#222): `<project-root>/.devlog/standards`.
 * Walks up from `cwd` to the nearest dir holding `.devlog` (so it resolves from a
 * subfolder too), like isEnforcementDisabled. Returns null if no project root.
 */
export function projectStandardsDir(cwd: string): string | null {
  const dl = findDevlogDir(cwd);
  return dl ? join(dl, "standards") : null;
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
export function formatCatalogNames(catalog: CatalogEntry[]): string {
  const byAxis = new Map<string, string[]>();
  for (const e of catalog) {
    const arr = byAxis.get(e.axis) || [];
    arr.push(e.category);
    byAxis.set(e.axis, arr);
  }
  return [...byAxis.entries()].map(([axis, cats]) => `${axis}: ${cats.join(", ")}`).join(" | ");
}

function findCategory(catalog: CatalogEntry[], cat: string): CatalogEntry | undefined {
  const norm = cat.trim().toLowerCase();
  const matches = catalog.filter(e => e.category.toLowerCase() === norm);
  // Write commands (rule:add / rule:rm / dup-check) target the GLOBAL file by
  // default — the project layer is augment-on-read, edited as plain files.
  return matches.find(e => e.scope === "global") ?? matches[0];
}

// ── Command parsing ──────────────────────────────────────────────────────────
/**
 * Extract rule commands from an assistant message. Mirrors tag-parser's shape
 * (strip code first so a command mentioned inside a fence isn't captured) but
 * uses its OWN verb set and terminator so it never collides with DevLog tags.
 * The body runs until the next `-(...)` at line start or end-of-message, which
 * lets `-(rule:add)` carry a multi-line rule.
 */
// Vanilla regex escaper — avoids the Stage-3 `RegExp.escape` (not yet standard JS)
// so a Bun change can't silently break rule-command parsing.
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseRuleCommands(msg: string): RuleCommand[] {
  if (!msg) return [];
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
    "g",
  );
  const out: RuleCommand[] = [];
  for (const m of stripped.matchAll(pattern)) {
    const cmd = m[1] as RuleCommandName;
    const argLine = (m[2] || "").trim();
    const body = (m[3] || "").trim();
    out.push({ cmd, argLine, body, key: `${cmd}|${argLine}|${body}` });
  }
  return out;
}

// ── Rule numbering / extraction within a file ────────────────────────────────
const BULLET_RE = /^[ \t]*-[ \t]+(?:\[[ xX]\][ \t]+)?(.*\S)\s*$/;

interface RuleBlock { headingIdx: number; bullets: Array<{ lineIdx: number; text: string }>; }

/** Locate the `## القواعد` block and its bullet lines in a file's lines. */
function locateRules(lines: string[]): RuleBlock {
  const headingIdx = lines.findIndex(l => l.trim() === RULES_HEADING);
  const bullets: Array<{ lineIdx: number; text: string }> = [];
  if (headingIdx < 0) return { headingIdx, bullets };
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}[ \t]/.test(lines[i])) break; // next heading ends the block
    const m = lines[i].match(BULLET_RE);
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
    const label = kind === "check" ? "[فحص]" : "[نصيحة]";
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
        const scopeLabel = entry.scope === "project" ? " — خاص بالمشروع" : "";
        blocks.push(`════════ معايير: ${entry.category} (${entry.axis}${scopeLabel}) ════════\n${numberForDisplay(raw).trim()}`);
        readAny = true;
      } catch { /* unreadable file in one scope — try the others */ }
    }
    if (readAny) found++; else missing.push(cat);
  }
  if (missing.length) {
    const avail = catalog.length ? formatCatalogNames(catalog) : "(الكتالوج فارغ — أضف ملفات في ~/.claude/standards)";
    blocks.push(`⚠ تصنيفات غير موجودة: ${missing.join(", ")}\nالمتاح: ${avail}`);
  }
  return { output: blocks.join("\n\n"), found, missing };
}

// ── Add a rule (append-only, dedup, never overwrites) ────────────────────────
export interface AddResult { ok: boolean; message: string; }

export async function addRule(cat: string, text: string): Promise<AddResult> {
  const ruleText = text.trim();
  if (!ruleText) return { ok: false, message: "نص القاعدة فارغ." };
  const catalog = await scanCatalog();
  const entry = findCategory(catalog, cat);
  if (!entry) {
    return { ok: false, message: `التصنيف "${cat}" غير موجود. أنشئه أولاً بـ -(rule:new) <محور>/${cat}` };
  }
  const raw = await readFile(entry.path, "utf-8");
  const lines = raw.split("\n");
  const { headingIdx, bullets } = locateRules(lines);

  // Dedup: identical (normalized) rule already present → no-op.
  const needle = normRule(ruleText);
  if (bullets.some(b => normRule(b.text) === needle)) {
    return { ok: true, message: `موجودة مسبقاً في "${entry.category}" — لم تُضف نسخة مكررة.` };
  }

  // Multi-line rules: keep the first line as the bullet, indent the rest.
  const ruleLines = ruleText.split("\n");
  const bulletBlock = [`- ${ruleLines[0].trim()}`, ...ruleLines.slice(1).map(l => `  ${l.trim()}`)];

  if (headingIdx < 0) {
    // No ## القواعد section yet — append one at the end.
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(RULES_HEADING, ...bulletBlock);
  } else {
    // Insert right after the last existing bullet (append-only, preserves order).
    const insertAt = bullets.length ? bullets[bullets.length - 1].lineIdx + 1 : headingIdx + 1;
    lines.splice(insertAt, 0, ...bulletBlock);
  }
  await writeFile(entry.path, lines.join("\n"), "utf-8");
  return { ok: true, message: `أُضيفت لـ "${entry.category}" (#${bullets.length + 1}).` };
}

// ── Create a new category ────────────────────────────────────────────────────
const KNOWN_AXES = ["languages", "runtimes", "frameworks", "platforms", "app-types", "cross-cutting"];

function categoryTemplate(cat: string): string {
  return `# ${cat} — معايير

## متى تنطبق

(اشرح بسطر متى يسحب كلود هذا التصنيف.)

${RULES_HEADING}
`;
}

export interface NewResult { ok: boolean; message: string; }

/** `-(rule:new) <axis>/<category>` (or "<axis> <category>"). Claude picks the
 *  axis from its understanding of the rule. Creates the folder if needed. */
export async function createCategory(axisRaw: string, cat: string): Promise<NewResult> {
  const axis = axisRaw.trim().toLowerCase();
  const category = cat.trim().toLowerCase();
  if (!axis || !category) return { ok: false, message: "الصيغة: -(rule:new) <محور>/<تصنيف>" };
  // Validate BOTH segments against a strict charset before building the path:
  // `axis` flows into join(standardsDir(), axis), so an unvalidated "../.." would
  // let -(rule:new) write a .md file outside the standards dir (path traversal).
  if (!/^[a-z0-9_-]+$/.test(category)) {
    return { ok: false, message: `اسم تصنيف غير صالح: "${category}" (حروف صغيرة وأرقام و - فقط).` };
  }
  if (!/^[a-z0-9_-]+$/.test(axis)) {
    return { ok: false, message: `اسم محور غير صالح: "${axis}" (حروف صغيرة وأرقام و - فقط).` };
  }
  const catalog = await scanCatalog();
  if (findCategory(catalog, category)) {
    return { ok: false, message: `التصنيف "${category}" موجود مسبقاً — استخدم -(rule:add) للإضافة إليه.` };
  }
  const axisHint = KNOWN_AXES.includes(axis) ? "" : ` (محور جديد خارج المعتاد: ${KNOWN_AXES.join("/")})`;
  const dir = join(standardsDir(), axis);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${category}.md`), categoryTemplate(category), "utf-8");
  return { ok: true, message: `أُنشئ تصنيف "${category}" في ${axis}/${axisHint}. أضِف قواعده بـ -(rule:add) ${category}` };
}

// ── Remove a rule by number ──────────────────────────────────────────────────
export interface RemoveResult { ok: boolean; message: string; }

export async function removeRule(cat: string, num: number): Promise<RemoveResult> {
  const catalog = await scanCatalog();
  const entry = findCategory(catalog, cat);
  if (!entry) return { ok: false, message: `التصنيف "${cat}" غير موجود.` };
  const raw = await readFile(entry.path, "utf-8");
  const lines = raw.split("\n");
  const { bullets } = locateRules(lines);
  if (num < 1 || num > bullets.length) {
    return { ok: false, message: `#${num} خارج النطاق — "${entry.category}" فيه ${bullets.length} قاعدة.` };
  }
  const target = bullets[num - 1];
  // Remove the bullet line plus any indented continuation lines that follow it.
  let end = target.lineIdx + 1;
  while (end < lines.length && /^[ \t]+\S/.test(lines[end]) && !lines[end].match(BULLET_RE)) end++;
  const removed = bullets[num - 1].text;
  lines.splice(target.lineIdx, end - target.lineIdx);
  await writeFile(entry.path, lines.join("\n"), "utf-8");
  return { ok: true, message: `حُذفت #${num} من "${entry.category}": ${removed.slice(0, 60)}` };
}

// ── List the catalog ─────────────────────────────────────────────────────────
export async function listCatalog(cwd?: string): Promise<string> {
  const catalog = await scanCatalog(cwd);
  if (!catalog.length) return "الكتالوج فارغ — أضف ملفات .md في ~/.claude/standards/<محور>/";
  const globalCats = catalog.filter(e => e.scope === "global");
  const projectCats = catalog.filter(e => e.scope === "project");
  let out = `الكتالوج (${catalog.length} تصنيف):\n${formatCatalogNames(globalCats)}`;
  if (projectCats.length) out += `\nخاص بالمشروع (.devlog/standards): ${formatCatalogNames(projectCats)}`;
  return out;
}

// ── Enforcement gate ─────────────────────────────────────────────────────────
// SessionStart only INJECTS the catalog NAMES (awareness). Nothing forces Claude
// to actually pull + apply the rules, so a session can write code while ignoring
// the standards entirely (observed in the wild). This gate, evaluated by the Stop
// hook, decides when to force a correction — the same enforcement pattern as the
// closure-check. Pure so it's unit-testable; the hook supplies the observed facts.
export interface GateInput {
  catalogCount: number;       // number of categories available
  relevantUncovered: number;  // available categories the written code NEEDS but weren't
                              // pulled/auto-served (inferred per written file, ∩ catalog,
                              // minus covered). The hook computes this.
  stopHookActive: boolean;    // are we already inside a forced continuation?
}

// Relevance-aware: nag ONLY when a standard that actually applies to the written
// code exists and wasn't engaged. The old gate fired on "wrote code + pulled
// nothing", which forced THEATER pulls — e.g. a C++-only session with no `cpp`
// category got nagged and pulled irrelevant categories just to silence it. Now a
// session whose files map to no available category (or whose relevant ones are all
// covered) ends cleanly.
export function shouldEnforceStandards(g: GateInput): boolean {
  if (g.stopHookActive) return false;     // never loop on our own continuation
  if (g.catalogCount === 0) return false; // nothing to enforce against
  return g.relevantUncovered > 0;         // a relevant standard exists but wasn't engaged
}

// ── Per-project enforcement exemption ───────────────────────────────────────
// Some existing projects already follow the standards — forcing a pull there is
// pure friction. The DevLog dashboard (injection window) writes a marker file at
// the project's `.devlog/standards-off` to exempt it. Both enforcement hooks read
// this marker LOCALLY (no server round-trip on the write hot-path). Manual
// -(ask:rules) still works in an exempt project — only the FORCING is lifted.
export const ENFORCE_MARKER = "standards-off";

export function enforceMarkerPath(projectDir: string): string {
  return join(projectDir, ".devlog", ENFORCE_MARKER);
}

/**
 * Walk up from `cwd` to the nearest project root (the dir holding `.devlog`) and
 * report whether enforcement is disabled there (marker present). Walking up makes
 * it work when Claude's cwd is a subfolder. Errors → not disabled (enforce).
 */
export function isEnforcementDisabled(cwd: string): boolean {
  const dl = findDevlogDir(cwd);
  if (!dl) return false;
  try { return existsSync(join(dl, ENFORCE_MARKER)); } catch { return false; }
}

// ── Intentional-acknowledgement ("I'm intentional, be quiet") (P5) ───────────
// A check that blocks a DELIBERATE choice is friction. An ack lets the developer
// (via Claude) record that a violation is on purpose, so the gate stops blocking
// it — the anti-annoyance core. Stored per-project in `.devlog/standards-ack`
// (one key per line), consistent with the standards-off marker. Two granularities
// in ONE mechanism:
//   `cargo-edition`        → the whole check is SOFT/off for this project (P5 step 2)
//   `cargo-edition:2021`   → only this specific value is acknowledged (P5 step 1)
export const ACK_MARKER = "standards-ack";

/** Nearest `.devlog` dir walking up from cwd (where the markers live). */
function findDevlogDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 40 && dir; i++) {
    try { if (existsSync(join(dir, ".devlog"))) return join(dir, ".devlog"); } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Acknowledged check keys for the project at `cwd` (empty when none). Sync so the
 *  PreToolUse hook can call it inline on the write hot-path. */
export function readAcks(cwd: string): string[] {
  const dl = findDevlogDir(cwd);
  if (!dl) return [];
  try {
    return readFileSync(join(dl, ACK_MARKER), "utf-8").split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

/** Is this check (optionally this specific value) acknowledged as intentional?
 *  A bare `checkKey` ack silences the whole check; `checkKey:value` silences one. */
export function isAcked(cwd: string, checkKey: string, value?: string | null): boolean {
  const acks = new Set(readAcks(cwd).map(a => a.toLowerCase()));
  if (acks.has(checkKey.toLowerCase())) return true;
  if (value != null && acks.has(`${checkKey}:${value}`.toLowerCase())) return true;
  return false;
}

export interface AckResult { ok: boolean; message: string; }

/** Record an intentional-violation ack for the project at `cwd` (append-only,
 *  dedup). Creates `.devlog` at cwd when no project root is found yet. */
export async function addAck(cwd: string, key: string): Promise<AckResult> {
  const k = (key || "").trim();
  if (!k) return { ok: false, message: "مفتاح ack فارغ." };
  const dl = findDevlogDir(cwd) ?? join(cwd, ".devlog");
  await mkdir(dl, { recursive: true });
  const file = join(dl, ACK_MARKER);
  let lines: string[] = [];
  try { lines = (await readFile(file, "utf-8")).split("\n").map(s => s.trim()).filter(Boolean); } catch { /* new file */ }
  if (lines.some(l => l.toLowerCase() === k.toLowerCase())) return { ok: true, message: `موجود مسبقاً: ${k}` };
  lines.push(k);
  await writeFile(file, `${lines.join("\n")}\n`, "utf-8");
  return { ok: true, message: `أُكّد كمتعمّد (لن يُحجب بعد الآن في هذا المشروع): ${k}` };
}

/** Human-readable list of the project's acks (for -(rule:acks)). */
export function listAcks(cwd: string): string {
  const acks = readAcks(cwd);
  return acks.length ? `مؤكَّدات هذا المشروع:\n${acks.map(a => `· ${a}`).join("\n")}` : "لا مؤكَّدات في هذا المشروع.";
}

// PROACTIVE gate (PreToolUse on Write/Edit): instead of blocking a code write and
// telling Claude to go pull standards (the old shouldGateWrite), the gate now
// INFERS the file's categories (P1) and TEACHES — injects their rules into the
// block message and records them as served, so the retry write is already
// informed. This is the "system teaches Claude" inversion: one block, rules in
// hand, no separate -(ask:rules) round-trip. Pure decision here; the hook does IO.

// Marker the gate writes into the per-session rules-state when it auto-injects a
// category's rules, so a later write of the same language doesn't re-teach it and
// the Stop-hook backstop sees standards as engaged.
export const AUTO_SERVED_PREFIX = "auto-served|";

/**
 * Categories already covered this session, parsed from the rules-state keys:
 * `ask:rules` command keys (their argLine lists the pulled categories) plus the
 * gate's own `auto-served|<cat>` markers. Lets the gate be per-category — writing
 * a second `.rs` file won't re-teach Rust, but the first `.go` file still gets Go
 * taught even though Rust was covered earlier.
 */
export function coveredCategories(servedKeys: string[]): string[] {
  const out = new Set<string>();
  for (const k of servedKeys) {
    const s = String(k);
    if (s.startsWith("ask:rules|")) {
      for (const c of (s.split("|")[1] || "").split(/\s+/).filter(Boolean)) out.add(c.toLowerCase());
    } else if (s.startsWith(AUTO_SERVED_PREFIX)) {
      const c = s.slice(AUTO_SERVED_PREFIX.length).trim().toLowerCase();
      if (c) out.add(c);
    }
  }
  return [...out];
}

export interface GateDecision { block: boolean; serve: string[]; }

/**
 * Decide the write gate for a file. `needed` = inferCategories(...) for it;
 * `covered` = coveredCategories(state). Serves (and blocks on) only the needed
 * categories not yet covered. Non-code, empty `needed` (unknown ext + nothing
 * cross-cutting), or fully-covered ⇒ allow.
 */
export function gateWriteDecision(g: { isCode: boolean; needed: string[]; covered: string[] }): GateDecision {
  if (!g.isCode) return { block: false, serve: [] };
  const cov = new Set(g.covered.map(c => c.toLowerCase()));
  const serve = g.needed.filter(c => !cov.has(c.toLowerCase()));
  return { block: serve.length > 0, serve };
}

// Is a written file "code" for enforcement? Excludes docs/manifests/assets and
// anything under .devlog, so doc-only or DevLog-internal edits don't trip the gate.
const NON_CODE_RE = /\.(md|txt|json|lock|toml|ya?ml|csv|svg|png|jpe?g|gif|ico|pdf)$/i;
export function isCodeWrite(filePath: string): boolean {
  const f = normalizeSlashes(filePath).toLowerCase();
  if (!f) return false;
  if (f.includes("/.devlog/")) return false;
  return !NON_CODE_RE.test(f);
}

// ── File → category inference (P1) ───────────────────────────────────────────
// Maps a file being written to the standards categories that apply to it, so the
// write-time gate can INJECT the right rules instead of asking Claude to guess
// which categories to pull. The system knows a `.rs` file is Rust — making Claude
// rediscover that is "Claude teaches the system"; this inverts it. Pure + data-
// driven so it's unit-testable: the gate supplies the path, the scanned catalog
// names, and optional project hints, then reads whatever categories come back.

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

/** The language category for a file path, by extension. null when unknown. */
export function langForFile(filePath: string): string | null {
  const f = normalizeSlashes(filePath).toLowerCase();
  const base = f.slice(f.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_LANG[base.slice(dot + 1)] ?? null;
}

// Dependency name → framework/tool category (P0). A project using astro/vite/react
// has no file extension that says so — the SIGNAL is its manifest deps. Mapping
// here is harmless when the category doesn't exist (inferCategories intersects with
// the catalog), so the table can list more than the user has authored.
const DEP_CATEGORY: Record<string, string> = {
  react: "react", "react-dom": "react",
  next: "next",
  astro: "astro",
  vue: "vue", "@vue/runtime-core": "vue",
  svelte: "svelte", "@sveltejs/kit": "svelte",
  "solid-js": "solid",
  vite: "vite",
  webpack: "webpack",
  tailwindcss: "tailwind",
  express: "express",
  fastify: "fastify",
  "@nestjs/core": "nestjs",
};

/** Framework/tool categories implied by a manifest's dependency names. */
export function frameworkCategoriesFromDeps(depNames: string[]): string[] {
  const out: string[] = [];
  for (const n of depNames) {
    const cat = DEP_CATEGORY[(n || "").trim().toLowerCase()];
    if (cat && !out.includes(cat)) out.push(cat);
  }
  return out;
}

export interface InferOpts {
  /** Project platform hint (e.g. "windows" | "web" | "linux"), if known. */
  platform?: string | null;
  /** Project app-type hint (e.g. "desktop-gui" | "cli" | "website"), if known. */
  appType?: string | null;
  /** Manifest dependency names → framework categories (astro, vite, react…). */
  deps?: string[];
  /** JS runtime ("bun" | "node" | "deno"), mapped to a runtimes/ category. */
  runtime?: string | null;
  /** cross-cutting categories to always include WHEN PRESENT in the catalog.
   *  Defaults to ["security"] — security applies regardless of language. */
  alwaysInclude?: string[];
}

/**
 * The standards categories that apply to a file write, intersected with what's
 * actually available so we never suggest a category with no file. Order: language
 * → design (UI) → framework (deps) → runtime → platform → app-type → cross-cutting.
 * Caller passes the scanned catalog names (keeps this pure — no FS).
 */
export function inferCategories(filePath: string, available: string[], opts: InferOpts = {}): string[] {
  const avail = new Set(available.map(c => c.toLowerCase()));
  const picked: string[] = [];
  const add = (c: string | null | undefined): void => {
    if (!c) return;
    const k = c.trim().toLowerCase();
    if (avail.has(k) && !picked.includes(k)) picked.push(k);
  };
  add(langForFile(filePath));
  if (isUiFile(filePath)) add("design"); // UI file → pull the visual standard
  for (const c of frameworkCategoriesFromDeps(opts.deps ?? [])) add(c);
  add(opts.runtime);
  add(opts.platform);
  add(opts.appType);
  for (const c of opts.alwaysInclude ?? ["security"]) add(c);
  return picked;
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
    return kind === "edition" ? `أحدث edition لـ${lang}` : `أحدث إصدار مستقر لـ${lang}`;
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

export async function runRuleCommands(cmds: RuleCommand[], cwd?: string): Promise<RunResult> {
  const parts: string[] = [];
  for (const c of cmds) {
    if (c.cmd === "ask:rules") {
      const cats = c.argLine.split(/\s+/).filter(Boolean);
      if (!cats.length) { parts.push("⚠ -(ask:rules) بلا تصنيف. مثال: -(ask:rules) rust windows"); continue; }
      const r = await readCategories(cats, cwd);
      parts.push(r.output);
    } else if (c.cmd === "rule:add") {
      const tokens = c.argLine.split(/\s+/);
      const cat = tokens[0] || "";
      const inlineRest = tokens.slice(1).join(" ");
      const ruleText = [inlineRest, c.body].filter(Boolean).join("\n").trim();
      if (!cat) { parts.push("⚠ -(rule:add) بلا تصنيف."); continue; }
      const r = await addRule(cat, ruleText);
      parts.push(`✓ rule:add ${cat}: ${r.message}`);
    } else if (c.cmd === "rule:new") {
      const m = c.argLine.match(/^([^/\s]+)\s*[/\s]\s*([^/\s]+)/);
      if (!m) { parts.push("⚠ الصيغة: -(rule:new) <محور>/<تصنيف>"); continue; }
      const r = await createCategory(m[1], m[2]);
      parts.push(`${r.ok ? "✓" : "✗"} rule:new: ${r.message}`);
    } else if (c.cmd === "rules:list") {
      parts.push(await listCatalog(cwd));
    } else if (c.cmd === "rule:ack") {
      if (!cwd) { parts.push("⚠ rule:ack يحتاج مشروعاً (cwd)."); continue; }
      const key = c.argLine.trim();
      if (!key) { parts.push("⚠ الصيغة: -(rule:ack) <مفتاح> — مثل cargo-edition أو cargo-edition:2021 أو dep:astro"); continue; }
      const r = await addAck(cwd, key);
      parts.push(`${r.ok ? "✓" : "✗"} rule:ack: ${r.message}`);
    } else if (c.cmd === "rule:acks") {
      parts.push(listAcks(cwd || ""));
    } else if (c.cmd === "rule:rm") {
      const m = c.argLine.match(/^(\S+)\s+#?(\d+)/);
      if (!m) { parts.push("⚠ الصيغة: -(rule:rm) <تصنيف> #N"); continue; }
      const r = await removeRule(m[1], parseInt(m[2], 10));
      parts.push(`${r.ok ? "✓" : "✗"} rule:rm: ${r.message}`);
    }
  }
  return { output: parts.filter(Boolean).join("\n\n") };
}
