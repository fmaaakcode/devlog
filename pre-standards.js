#!/usr/bin/env bun
// DevLog PreToolUse gate (Write/Edit): the tracking-file gate, the
// load-bearing-wall (demolition) gate, and the verifiable write-checkers
// (WRITE_CHECKERS: toolchain edition/version, raw-hex, …). The old teaching/pull
// half — infer the file's categories and inject their rules on write — was
// disabled by user directive 2026-06-24 and DELETED in the 2026-08-13 audit: it
// depended on the per-session rules-state dir that the turn ledger replaced.
// Git history keeps it.
//
// exit 2 on PreToolUse blocks the tool call and feeds stderr to Claude. We exit
// 0 (allow) on any uncertainty so a hook problem never wedges the user's edits.
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// #767: stream-decode stdin in one shot — the old per-chunk `new TextDecoder()
// .decode(chunk)` corrupted a multi-byte (Arabic) char split across chunks into
// U+FFFD; worst here, where mangled content feeds the write-checkers.
const raw = await new Response(Bun.stdin.stream()).text();
let data;
try { data = JSON.parse(raw); } catch { process.exit(0); }

const filePath = data.tool_input?.file_path || "";
const sessionId = data.session_id || "";
// Attribution anchor (see attributionCwd in src/hooks.ts): the session's
// project dir outranks the payload cwd, which follows the shell's `cd` drift.
const cwd = process.env.CLAUDE_PROJECT_DIR || data.cwd || "";
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

// ── Load-bearing-wall gate ────────────────────────────────────────────────────
// The second half of the solution-altitude pair (first half = the Stop-time
// root-cause guard). Rewriting a file the rest of the code leans on, without
// knowing what it already went through, is how a rejected approach gets
// re-proposed and a fixed bug re-introduced. One advisory notice per file per
// session, ack written BEFORE the block (install-gate pattern), and fail-open
// at every step: no server, no analysis, or an unknown file all pass silently.
if (process.env.DEVLOG_DEMOLITION_GATE !== "0") {
  try {
    const { GATED_TOOLS, decideDemolition } = await import("./src/demolition-gate.ts");
    if (GATED_TOOLS.has(data.tool_name || "")) {
      const ackDir = join(import.meta.dir, ".devlog", "demolition-ack");
      const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const ackFile = join(ackDir, `${safeSid}-${Bun.hash(filePath.toLowerCase()).toString(36)}.txt`);
      if (!existsSync(ackFile)) {
        const port = process.env.DEVLOG_PORT || "7777";
        const url = `http://127.0.0.1:${port}/api/file-weight?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(filePath)}`;
        let weight = null;
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
          if (r.ok) weight = await r.json();
        } catch { /* daemon down — fail open, as decideDemolition also would */ }
        const LANG = (process.env.DEVLOG_LANG || "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
        const decision = decideDemolition({ weight, acked: false }, LANG);
        if (decision.block) {
          await mkdir(ackDir, { recursive: true });
          // The path rides IN the ack (narrative layer P4): the Stop hook reads
          // these to ask "you overrode the gate on X — where is the why?", and
          // the filename only carries a hash. Sweeps key on mtime, unaffected.
          await Bun.write(ackFile, JSON.stringify({ t: Date.now(), file: filePath }));   // ack BEFORE block
          process.stderr.write(`${decision.message}\n`);
          process.exit(2);
        }
      }
    }
  } catch { /* fail-open — never wedge an edit on this gate's account */ }
}

// Same off-switch as the Stop-hook check.
if (process.env.DEVLOG_STANDARDS_CHECK === "0") process.exit(0);

try {
  const { scanCatalog, isEnforcementDisabled } = await import("./src/standards.ts");
  const { latestToolchain, latestKnownEdition } = await import("./src/registry.ts");
  const { runWriteCheckers } = await import("./src/write-checks.ts");
  // Per-project opt-out (dashboard injection window writes .devlog/standards-off).
  if (isEnforcementDisabled(cwd)) process.exit(0);
  const catalog = await scanCatalog(cwd);
  if (!catalog.length) process.exit(0); // dormant until standards exist

  // Verifiable checks (registry in src/write-checks.ts): toolchain edition/version,
  // raw-hex, … Each is ack-aware; the first that fires hard-blocks the write.
  // Add a new check by extending WRITE_CHECKERS — no edits here.
  const outcome = await runWriteCheckers({
    filePath,
    content: data.tool_input?.content ?? data.tool_input?.new_string ?? "",
    cwd,
    catalog: catalog.map(c => c.category),
    latestEdition: (lang) => latestKnownEdition(lang),
    latestVersion: (lang) => latestToolchain(lang).then(t => t.version),
  });
  if (outcome) {
    // Rule telemetry (#787): report the fire — the block happens regardless.
    try {
      const { postRuleTelemetry } = await import("./src/telemetry-client.ts");
      await postRuleTelemetry(`http://127.0.0.1:${parseInt(process.env.DEVLOG_PORT || "7777", 10)}`, cwd,
        [{ gate: "write", action: "fire", rule: outcome.key, file: filePath }]);
    } catch { /* telemetry never delays or breaks the gate */ }
    // Own L(): the tracking-gate's copy above is scoped to its block (#906).
    const LANG = (process.env.DEVLOG_LANG || "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
    const L = (en, ar) => (LANG === "ar" ? ar : en);
    process.stderr.write(`${[
      "════════ DevLog Standards Gate ════════",
      outcome.title,
      ...outcome.lines,
      L("(one-time disable: DEVLOG_STANDARDS_CHECK=0)", "(تعطيل لمرة واحدة: DEVLOG_STANDARDS_CHECK=0)"),
      "═══════════════════════════════════════",
    ].join("\n")}\n`);
    process.exit(2);
  }

  // Clean checks allow the write — Claude is never stopped to pull a standard.
  process.exit(0);
} catch {
  process.exit(0); // never wedge edits on internal error
}
