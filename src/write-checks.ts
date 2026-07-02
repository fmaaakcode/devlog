// Write-time check registry (P6) — the extension point. Each verifiable standard
// is one WriteChecker in WRITE_CHECKERS; the PreToolUse gate runs them in order
// and blocks on the first that fires. Adding a new check is now a SMALL, local
// change: write a pure decision (like manifest-check.ts / design-check.ts), wrap
// it in a checker here, and push it to the array — no edits to the hook's control
// flow. That's the "قابل للتوسّع" requirement made concrete.
//
// Network/FS stays OUT of the pure deciders: the toolchain target is injected via
// ctx (latestVersion async, latestEdition sync) so this module is unit-testable
// without hitting the network, and ack lookups read the project marker (sync).

import { manifestKind, parseCargoManifest, parseCppManifest, checkToolchain } from "./manifest-check";
import { isUiFile, extractCssRegions, findRawHex } from "./design-check";
import { isAcked } from "./standards";

export interface WriteCtx {
  filePath: string;
  content: string;
  cwd: string;
  /** Available catalog category names (case-insensitive match). */
  catalog: string[];
  /** Newest edition for a language (network-free, from registry's table). */
  latestEdition: (lang: string) => string | null;
  /** Latest stable toolchain version (network; may reject → checker fails open). */
  latestVersion: (lang: string) => Promise<string | null>;
}

/** A fired check: the title line + body lines (already ack-filtered). The gate
 *  wraps these in the standard banner + disable footer. null = did not fire. */
export interface CheckOutcome { key: string; title: string; lines: string[]; }

export type WriteChecker = (ctx: WriteCtx) => Promise<CheckOutcome | null>;

const hasCat = (ctx: WriteCtx, name: string): boolean =>
  ctx.catalog.some(c => c.toLowerCase() === name);
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

// ── Checker: language toolchain (edition/version) on a manifest (P2) ──────────
const toolchainChecker: WriteChecker = async (ctx) => {
  if (manifestKind(ctx.filePath) !== "cargo" || !hasCat(ctx, "rust")) return null;
  const state = parseCargoManifest(ctx.content);
  let latestVersion: string | null = null;
  try { latestVersion = await ctx.latestVersion("rust"); } catch { /* fail open */ }
  const violations = checkToolchain(state, { latestVersion, latestEdition: ctx.latestEdition("rust") })
    .filter(v => !isAcked(ctx.cwd, `cargo-${v.field}`, v.found));
  if (!violations.length) return null;
  const line = (v: { field: string; found: string; target: string }) =>
    v.field === "edition"
      ? `• edition = "${v.found}" ← الهدف ${v.target} (لا تثبّت edition أقدم)`
      : `• rust-version = "${v.found}" ← الأحدث المستقر ${v.target}`;
  const ackHint = `(متعمّد؟ أكّد بـ ${violations.map(v => `-(rule:ack) cargo-${v.field}:${v.found}`).join(" أو ")})`;
  return {
    key: "toolchain",
    title: `🛑 ${baseName(ctx.filePath)} خالف معايير اللغة — صحّح قبل الكتابة:`,
    lines: [...violations.map(line), ackHint],
  };
};

// ── Checker: C++ standard on a build file (CMake/Makefile) ───────────────────
// Parity with the rust toolchain check: C++ takes the latest ratified standard.
// editionBehind already compares "C++20" vs "C++23", so this reuses checkToolchain.
// DISABLED from the active registry (user directive 2026-06-24, rust-only phase);
// kept defined + exported so it stays unit-tested and re-enables with one line.
export const cppStandardChecker: WriteChecker = async (ctx) => {
  const kind = manifestKind(ctx.filePath);
  if ((kind !== "cmake" && kind !== "makefile") || !hasCat(ctx, "cpp")) return null;
  const state = parseCppManifest(ctx.content);
  const violations = checkToolchain(state, { latestVersion: null, latestEdition: ctx.latestEdition("cpp") })
    .filter(v => !isAcked(ctx.cwd, "cpp-standard", v.found));
  if (!violations.length) return null;
  return {
    key: "cpp-standard",
    title: `🛑 ${baseName(ctx.filePath)} يستخدم معيار C++ أقدم — صحّح قبل الكتابة:`,
    lines: [
      ...violations.map(v => `• ${v.found} ← الهدف ${v.target} (استخدم أحدث معيار C++)`),
      `(متعمّد؟ أكّد بـ ${violations.map(v => `-(rule:ack) cpp-standard:${v.found}`).join(" أو ")})`,
    ],
  };
};

// ── Checker: no raw hex in product CSS (P4) ──────────────────────────────────
// DISABLED from the active registry (user directive 2026-06-24, rust-only phase);
// kept defined + exported so it stays unit-tested and re-enables with one line.
export const designHexChecker: WriteChecker = async (ctx) => {
  if (!isUiFile(ctx.filePath) || !hasCat(ctx, "design") || isAcked(ctx.cwd, "design-hex")) return null;
  const hits = findRawHex(extractCssRegions(ctx.content, ctx.filePath))
    .filter(h => !isAcked(ctx.cwd, "design-hex", h.hex));
  if (!hits.length) return null;
  const shown = hits.slice(0, 8).map(h => `• سطر ${h.line}: ${h.hex}`);
  const more = hits.length > 8 ? [`• (+${hits.length - 8} أخرى)`] : [];
  return {
    key: "design-hex",
    title: `🛑 ${baseName(ctx.filePath)}: hex خام في كود المنتج — استخدم CSS token (var(--…)) بدلاً منه:`,
    lines: [
      ...shown, ...more,
      "(الاستثناء الوحيد: تعريف التوكنز نفسها --x: #...)",
      "(متعمّد؟ أكّد بـ -(rule:ack) design-hex لكامل المشروع أو design-hex:#xxxxxx للون واحد)",
    ],
  };
};

/** The ACTIVE registry. Per the user directive (2026-06-24) only the rust toolchain
 *  check enforces at write time while we settle the rust-only experience; cpp + design
 *  stay defined + exported (still unit-tested) but OUT of this array. To re-enable a
 *  check, move it here from DISABLED_CHECKERS. To add a new one: implement a
 *  WriteChecker above and push it here. */
export const WRITE_CHECKERS: WriteChecker[] = [toolchainChecker];

/** Defined-but-disabled checkers, parked here for an easy one-line re-enable
 *  (move into WRITE_CHECKERS). Kept referenced so nothing is lost to dead-code prune. */
export const DISABLED_CHECKERS: WriteChecker[] = [cppStandardChecker, designHexChecker];

// Which catalog category each ACTIVE checker enforces — the source of truth for
// "does this category actually BLOCK" (vs advisory-only). Used by the dashboard
// standards viewer to badge enforced categories. `dep` is the stop-time freshness
// check (parse-tags.js); `toolchain` is write-time (above). cpp/design are omitted
// while their checkers sit in DISABLED_CHECKERS — re-add them here when re-enabled.
export const ENFORCED_CATEGORIES: Record<string, string> = {
  rust: "toolchain",
  dependencies: "dep",
};

/** Run the registry; return the first checker that fires (block), else null. */
export async function runWriteCheckers(ctx: WriteCtx): Promise<CheckOutcome | null> {
  for (const checker of WRITE_CHECKERS) {
    const outcome = await checker(ctx);
    if (outcome) return outcome;
  }
  return null;
}
