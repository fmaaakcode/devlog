#!/usr/bin/env bun
/**
 * DevLog PreToolUse hook — blocks `gh release create` / `git tag -a v*` /
 * `git push --tags` unless Claude has the changelog in context AND the
 * project passes a doctor check.
 *
 * Wired in settings.json under hooks.PreToolUse with matcher="Bash":
 *   { "type": "command", "command": "bun /abs/path/pre-release-hook.js" }
 *
 * Behavior:
 *   - Reads PreToolUse JSON from stdin.
 *   - If tool is not a shell (Bash/PowerShell), exit 0.
 *   - If command doesn't look like a release op, exit 0.
 *   - Otherwise: fetch /api/changelog/since-last-release?format=md and run
 *     doctor (--json). Print both to stderr and exit 2 so Claude must
 *     acknowledge them before retrying the command.
 *   - Honors DEVLOG_RELEASE_GUARD=0 to disable.
 *
 * Idempotency: the hook fires on EVERY release-ish command. To avoid blocking
 * forever after Claude has seen the changelog once, we mark the session_id +
 * project in a tiny file. A re-issue from the same session within 10 minutes
 * passes through.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PORT = parseInt(process.env.DEVLOG_PORT || "7777", 10);
// #893: guard messages follow DEVLOG_LANG (same inline resolution as
// pre-install-hook.js — hooks stay standalone, no src/i18n import).
const LANG = (process.env.DEVLOG_LANG || "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
const L = (en, ar) => (LANG === "ar" ? ar : en);
const LOG_DIR = join(import.meta.dir, ".devlog");
const ACK_DIR = join(LOG_DIR, "release-ack");
const ACK_TTL_MS = 10 * 60 * 1000;
await mkdir(LOG_DIR, { recursive: true });
await mkdir(ACK_DIR, { recursive: true });

// appendFileSync, not Bun.write: Bun.write has no append option and silently
// truncated the log to its last line (#604). LOG_DIR is mkdir'd above.
const log = (s) => {
  try {
    appendFileSync(join(LOG_DIR, "pre-release.debug.log"), `${new Date().toISOString()} ${s}\n`);
  } catch { /* logging is best-effort */ }
};

if (process.env.DEVLOG_RELEASE_GUARD === "0") process.exit(0);

// #767: stream-decode stdin in one shot — the old per-chunk `new TextDecoder()
// .decode(chunk)` corrupted a multi-byte (Arabic) char split across chunks into U+FFFD.
const raw = await new Response(Bun.stdin.stream()).text();
let body;
try { body = JSON.parse(raw); } catch { process.exit(0); }

const tool = body.tool_name || body.tool || "";
if (tool !== "Bash" && tool !== "PowerShell") process.exit(0);

const cmd = body.tool_input?.command || "";
// Release-ish commands. Conservative — we want to catch the moments a user-
// visible release artifact is created, NOT every git push.
const RELEASE_PATTERNS = [
  /\bgh\s+release\s+create\b/,
  /\bgit\s+tag\s+-a\s+v\d/,
  /\bgit\s+push\s+(?:--tags\b|.*\s--tags\b)/,
  /\bnpm\s+publish\b/,
  /\bcargo\s+publish\b/,
];
const isRelease = RELEASE_PATTERNS.some(re => re.test(cmd));
if (!isRelease) process.exit(0);

// Attribution anchor (see attributionCwd in src/hooks.ts): the session's
// project dir outranks the payload cwd, which follows the shell's `cd` drift.
const cwd = process.env.CLAUDE_PROJECT_DIR || body.cwd || process.cwd();
const sessionId = body.session_id || "";
log(`fire: tool=${tool} cmd=${cmd.slice(0, 120)} cwd=${cwd}`);

// Ack check: if this session already saw the briefing recently, let it pass.
const ackFile = join(ACK_DIR, `${encodeURIComponent(sessionId || "no-session")}-${encodeURIComponent(cwd)}.txt`);
if (existsSync(ackFile)) {
  try {
    const stat = await readFile(ackFile, "utf8");
    if (Date.now() - parseInt(stat, 10) < ACK_TTL_MS) {
      log(`ack-pass: ${ackFile}`);
      process.exit(0);
    }
  } catch { /* unreadable ack file — treat as no ack */ }
}

// Strict policy: any open item blocks.
// #771: the three fetches run in PARALLEL (each keeps its own 3s cap) and
// doctor is capped at 8s, so the internal worst case is ~11s — sequentially
// they summed to ~19s against the hook's 15s timeout in hooks.json, and a hung
// daemon meant the harness killed this guard and the release command passed
// completely UNGUARDED.
let openItems = [];
let changelogMd = "";
let changelogCount = 0;
{
  const base = `http://127.0.0.1:${PORT}`;
  const q = encodeURIComponent(cwd);
  const grab = (url) => fetch(url, { signal: AbortSignal.timeout(3000) });
  const [oi, md, cnt] = await Promise.allSettled([
    grab(`${base}/api/open-items?cwd=${q}`).then(r => (r.ok ? r.json() : null)),
    grab(`${base}/api/changelog/since-last-release?cwd=${q}&format=md`).then(r => (r.ok ? r.text() : "")),
    grab(`${base}/api/changelog/since-last-release?cwd=${q}`).then(r => (r.ok ? r.json() : null)),
  ]);
  if (oi.status === "fulfilled") openItems = oi.value?.items || [];
  else log(`open-items fetch error: ${oi.reason?.message}`);
  if (md.status === "fulfilled") changelogMd = md.value || "";
  else log(`changelog fetch error: ${md.reason?.message}`);
  if (cnt.status === "fulfilled") changelogCount = cnt.value?.count || 0;
  else log(`changelog count fetch error: ${cnt.reason?.message}`);
}

// Run doctor in JSON mode (8s cap — see the #771 budget above).
let doctorReport = null;
try {
  const scriptPath = join(import.meta.dir, "src", "doctor.ts");
  const r = spawnSync("bun", [scriptPath, "--json", cwd], { encoding: "utf8", timeout: 8000 });
  if (r.stdout) doctorReport = JSON.parse(r.stdout);
} catch (e) {
  log(`doctor error: ${e.message}`);
}

// Compose feedback to Claude.
const out = [];
out.push("════════ DevLog Release Guard ════════");
out.push(`${L("Command", "الأمر")}: ${cmd.slice(0, 200)}`);
out.push(`${L("Project", "المشروع")}: ${cwd}`);
out.push("");

// Strict block: ANY open item refuses the release.
if (openItems.length > 0) {
  const byTag = {};
  for (const it of openItems) {
    byTag[it.tag] ||= [];
    byTag[it.tag].push(it);
  }
  out.push(L(
    `🛑 ${openItems.length} open items — a release must not ship while any item is open:`,
    `🛑 ${openItems.length} مهمة مفتوحة — لا يجوز إصدار release بوجود أي مهمة مفتوحة:`,
  ));
  for (const [tag, arr] of Object.entries(byTag)) {
    out.push(`  ${tag} (${arr.length}):`);
    for (const it of arr.slice(0, 20)) {
      const plan = it.planTitle ? ` [plan: ${it.planTitle}]` : "";
      out.push(`    · #${it.num} ${(it.content || "").slice(0, 80)}${plan}`);
    }
    if (arr.length > 20) out.push(`    ... +${arr.length - 20} ${L("more", "أخرى")}`);
  }
  out.push("");
  out.push(L(
    "The fix: first close every #N above with -(done) / -(dropped) / -(bug fix) / -(security fix).",
    "الإصلاح: أَغلق كل #N أعلاه بـ -(done) / -(dropped) / -(bug fix) / -(security fix) أولاً.",
  ));
  out.push("");
}

if (doctorReport?.findings?.length) {
  const med = doctorReport.findings.filter(f => f.severity === "medium");
  if (med.length) {
    out.push(L(`⚠ ${med.length} medium doctor warnings:`, `⚠ ${med.length} تحذيرات متوسطة من doctor:`));
    for (const f of med) out.push(`  • [${f.code}] ${f.title}`);
    out.push("");
  }
}

if (changelogCount > 0) {
  out.push(L(`📋 changelog since the last release (${changelogCount} items):`, `📋 changelog منذ آخر release (${changelogCount} عنصر):`));
  out.push("");
  out.push(changelogMd);
  out.push("");
  out.push("──────────────");
  out.push(L(
    "Use the list above in the commit message or release body. Don't compress it into a single line like 'security hotfix'.",
    "استخدم القائمة أعلاه في الـcommit message أو release body. لا تختصرها إلى جملة واحدة مثل 'security hotfix'.",
  ));
} else if (changelogCount === 0) {
  out.push(L(
    "⚠ No tags (built/done/fix) since the last release. Are you sure about this release?",
    "⚠ لا توجد تاقات (built/done/fix) منذ آخر release. هل أنت متأكد من هذا الإصدار؟",
  ));
}

out.push("");
const hasHigh = doctorReport?.findings?.some(f => f.severity === "high");
const blocked = openItems.length > 0 || hasHigh;
if (blocked) {
  out.push(L(
    "✗ Refused: a release must not ship with open items or critical findings.",
    "✗ مرفوض: لا يجوز إصدار release بوجود مهام مفتوحة أو مشاكل حرجة.",
  ));
} else {
  out.push(L(
    "ℹ️ Read the changelog above, then re-issue the command — it will pass this time (10-minute TTL).",
    "ℹ️ اقرأ الـchangelog أعلاه ثم أعد تنفيذ الأمر — سيمر هذه المرة (TTL 10 دقائق).",
  ));
  try { await writeFile(ackFile, String(Date.now()), "utf8"); } catch { /* ack is best-effort; worst case the briefing repeats */ }
}
out.push("══════════════════════════════════════");

process.stderr.write(`${out.join("\n")}\n`);
process.exit(2);
