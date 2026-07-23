#!/usr/bin/env bun
// DevLog PreToolUse gate (Write/Edit) — the PROACTIVE half of standards
// enforcement. It no longer just blocks and tells Claude to go pull standards;
// it INFERS the file's categories from its path and TEACHES — injects their
// rules into the block message and records them as served, so the retry write is
// already informed. One block, rules in hand, no separate -(ask:rules) round-trip
// (the "system teaches Claude" inversion). The Stop-hook check in parse-tags.js
// is the reactive backstop.
//
// exit 2 on PreToolUse blocks the tool call and feeds stderr to Claude. We exit
// 0 (allow) on any uncertainty so a hook problem never wedges the user's edits.
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const RULES_STATE_DIR = join(import.meta.dir, ".devlog", "rules-state");

// Teaching/pull gate DISABLED (user directive 2026-06-24): the system no longer
// stops Claude to infer categories, inject rules, and force a standards pull on
// write. Only the write-time checkers (rust edition/version, via WRITE_CHECKERS)
// block. The teaching code below stays INTACT — flip this to true to restore the
// "system teaches Claude on write" behaviour.
const TEACH_GATE_ENABLED = false;

// P0 — detect framework/runtime from the nearest package.json (walking up), so
// deps like astro/vite/react pull their standards even though no file extension
// says so. Light: one file read + a couple existsSync. Fail-safe to empty.
async function readProjectDeps(startDir) {
  let dir = startDir;
  for (let i = 0; i < 40 && dir; i++) {
    try {
      const j = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
      const deps = Object.keys({ ...(j.dependencies || {}), ...(j.devDependencies || {}) });
      let runtime = null;
      if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) runtime = "bun";
      else if (existsSync(join(dir, "deno.json")) || existsSync(join(dir, "deno.lock"))) runtime = "deno";
      else if (existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "node_modules"))) runtime = "node";
      return { deps, runtime };
    } catch { /* no package.json here — keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { deps: [], runtime: null };
}

let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
let data;
try { data = JSON.parse(raw); } catch { process.exit(0); }

const filePath = data.tool_input?.file_path || "";
const sessionId = data.session_id || "";
const cwd = data.cwd || "";
if (!sessionId || !filePath) process.exit(0);

// ── Tracking-file gate ────────────────────────────────────────────────────────
// Layer 1 of the tag-enforcement pair (layer 2 = the Stop-time untagged guard).
// Writing a manual tracking file (tasks.md / TODO.md / decisions.md /
// CHANGELOG.md / plans/*.md) duplicates a DevLog tag — the Superpowers
// coexistence shape: a competing CLAUDE.md steers the model into files instead
// of tags. Advisory, install-gate pattern: ack is written BEFORE the block, so
// re-issuing the same write passes for the rest of the session — a deliberate
// manual file stays possible; only the autopilot is interrupted. Independent of
// the standards machinery below (own switch, no catalog needed, fail-open).
if (process.env.DEVLOG_TRACKING_GATE !== "0") {
  try {
    const { isTrackingFile, trackingTagFor } = await import("./src/tracking-files.ts");
    if (isTrackingFile(filePath)) {
      const ackDir = join(import.meta.dir, ".devlog", "tracking-ack");
      const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const ackFile = join(ackDir, `${safeSid}-${Bun.hash(filePath.toLowerCase()).toString(36)}.txt`);
      if (!existsSync(ackFile)) {
        await mkdir(ackDir, { recursive: true });
        await Bun.write(ackFile, String(Date.now())); // ack BEFORE block — a crash can only lose the nudge, never loop it
        const LANG = (process.env.DEVLOG_LANG || "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
        const L = (en, ar) => (LANG === "ar" ? ar : en);
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        const tag = trackingTagFor(filePath);
        process.stderr.write(`${[
          "════════ DevLog Tracking Gate ════════",
          `📋 ${L(
            `\`${fileName}\` is a manual tracking file — in a DevLog project this content is recorded as TAGS, not files: end your response with ${tag} lines instead.`,
            `\`${fileName}\` ملف تتبع يدوي — في مشروع DevLog هذا المحتوى يُسجَّل تاقات لا ملفات: أنهِ ردّك بأسطر ${tag} بدلًا منه.`)}`,
          L("Deliberate manual file? re-issue the SAME write — it passes for the rest of the session.",
            "ملف يدوي مقصود؟ أعد الكتابة نفسها — ستمرّ لبقية الجلسة."),
          L("(disable this gate: DEVLOG_TRACKING_GATE=0)", "(تعطيل البوابة: DEVLOG_TRACKING_GATE=0)"),
          "══════════════════════════════════════",
        ].join("\n")}\n`);
        process.exit(2);
      }
    }
  } catch { /* fail-open — the Stop-time guard is the backstop */ }
}

// Same off-switch as the Stop-hook check.
if (process.env.DEVLOG_STANDARDS_CHECK === "0") process.exit(0);

try {
  const { scanCatalog, isCodeWrite, inferCategories, gateWriteDecision, coveredCategories, readCategories, resolveContentTemplates, isEnforcementDisabled, AUTO_SERVED_PREFIX } =
    await import("./src/standards.ts");
  const { latestToolchain, latestKnownEdition } = await import("./src/registry.ts");
  const { runWriteCheckers } = await import("./src/write-checks.ts");
  // Per-project opt-out (dashboard injection window writes .devlog/standards-off).
  if (isEnforcementDisabled(cwd)) process.exit(0);
  const catalog = await scanCatalog(cwd);
  if (!catalog.length) process.exit(0); // dormant until standards exist

  // Verifiable checks (registry in src/write-checks.ts): toolchain edition/version,
  // raw-hex, … Each is ack-aware; the first that fires hard-blocks the write. Clean
  // checks fall through to the teaching gate below (a non-code manifest just exits 0
  // there). Add a new check by extending WRITE_CHECKERS — no edits here.
  const outcome = await runWriteCheckers({
    filePath,
    content: data.tool_input?.content ?? data.tool_input?.new_string ?? "",
    cwd,
    catalog: catalog.map(c => c.category),
    latestEdition: (lang) => latestKnownEdition(lang),
    latestVersion: (lang) => latestToolchain(lang).then(t => t.version),
  });
  if (outcome) {
    process.stderr.write(`${[
      "════════ DevLog Standards Gate ════════",
      outcome.title,
      ...outcome.lines,
      "(تعطيل لمرة واحدة: DEVLOG_STANDARDS_CHECK=0)",
      "═══════════════════════════════════════",
    ].join("\n")}\n`);
    process.exit(2);
  }

  // Teaching/pull half is disabled — only the checkers above enforce. Allow the
  // write; Claude is never stopped to pull a standard.
  if (!TEACH_GATE_ENABLED) process.exit(0);

  // Which categories does THIS file need? Language (extension) + framework/runtime
  // (manifest deps) + always-on cross-cutting, intersected with the catalog. Only
  // pay the manifest read when the catalog actually has framework/runtime axes.
  const names = catalog.map(c => c.category);
  const hasFwAxis = catalog.some(c => c.axis === "frameworks" || c.axis === "runtimes");
  const { deps, runtime } = hasFwAxis ? await readProjectDeps(cwd) : { deps: [], runtime: null };
  const needed = inferCategories(filePath, names, { deps, runtime });

  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const stateFile = join(RULES_STATE_DIR, `${safeSid}.json`);
  let served = [];
  try { served = JSON.parse(await readFile(stateFile, "utf-8")); } catch { /* first write of this session — no state yet */ }
  const covered = coveredCategories(served);

  const decision = gateWriteDecision({ isCode: isCodeWrite(filePath), needed, covered });
  if (!decision.block) process.exit(0); // allow: non-code, nothing applies, or already covered

  // TEACH: read the rules for the uncovered categories, resolve any
  // {{latest:lang}}/{{edition:lang}} to live values, and inject them — then record
  // them as auto-served so the retry write (and later same-category writes) pass
  // without re-teaching.
  const { output: raw } = await readCategories(decision.serve, cwd);
  const output = await resolveContentTemplates(raw, latestToolchain);
  const set = new Set(served);
  for (const c of decision.serve) set.add(AUTO_SERVED_PREFIX + c);
  await mkdir(RULES_STATE_DIR, { recursive: true });
  await Bun.write(stateFile, JSON.stringify([...set]));

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const out = [
    "════════ DevLog Standards Gate ════════",
    `🛑 قبل كتابة \`${fileName}\` — هذي معايير المشروع المنطبقة عليه. التزم بها ثم أعد الكتابة:`,
    "",
    output,
    "",
    `(أُحضرت تلقائياً للتصنيفات: ${decision.serve.join("، ")} — لا حاجة لـ-(ask:rules))`,
    "(تعطيل لمرة واحدة: DEVLOG_STANDARDS_CHECK=0)",
    "═══════════════════════════════════════",
  ].join("\n");
  process.stderr.write(`${out}\n`);
  process.exit(2); // block this write; the next one is informed + allowed
} catch {
  process.exit(0); // never wedge edits on internal error
}
