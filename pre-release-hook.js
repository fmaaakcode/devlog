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

let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
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

const cwd = body.cwd || process.cwd();
const sessionId = body.session_id || "";
await log(`fire: tool=${tool} cmd=${cmd.slice(0, 120)} cwd=${cwd}`);

// Ack check: if this session already saw the briefing recently, let it pass.
const ackFile = join(ACK_DIR, `${encodeURIComponent(sessionId || "no-session")}-${encodeURIComponent(cwd)}.txt`);
if (existsSync(ackFile)) {
  try {
    const stat = await readFile(ackFile, "utf8");
    if (Date.now() - parseInt(stat, 10) < ACK_TTL_MS) {
      await log(`ack-pass: ${ackFile}`);
      process.exit(0);
    }
  } catch { /* unreadable ack file — treat as no ack */ }
}

// Strict policy: any open item blocks. Fetch open-items first.
let openItems = [];
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/open-items?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(3000) });
  if (r.ok) openItems = (await r.json()).items || [];
} catch (e) {
  await log(`open-items fetch error: ${e.message}`);
}

// Fetch changelog markdown.
let changelogMd = "";
let changelogCount = 0;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/changelog/since-last-release?cwd=${encodeURIComponent(cwd)}&format=md`, { signal: AbortSignal.timeout(3000) });
  if (r.ok) changelogMd = await r.text();
  const j = await fetch(`http://127.0.0.1:${PORT}/api/changelog/since-last-release?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(3000) });
  if (j.ok) changelogCount = (await j.json()).count || 0;
} catch (e) {
  await log(`changelog fetch error: ${e.message}`);
}

// Run doctor in JSON mode.
let doctorReport = null;
try {
  const scriptPath = join(import.meta.dir, "src", "doctor.ts");
  const r = spawnSync("bun", [scriptPath, "--json", cwd], { encoding: "utf8", timeout: 10000 });
  if (r.stdout) doctorReport = JSON.parse(r.stdout);
} catch (e) {
  await log(`doctor error: ${e.message}`);
}

// Compose feedback to Claude.
const out = [];
out.push("════════ DevLog Release Guard ════════");
out.push(`الأمر: ${cmd.slice(0, 200)}`);
out.push(`المشروع: ${cwd}`);
out.push("");

// Strict block: ANY open item refuses the release.
if (openItems.length > 0) {
  const byTag = {};
  for (const it of openItems) {
    byTag[it.tag] ||= [];
    byTag[it.tag].push(it);
  }
  out.push(`🛑 ${openItems.length} مهمة مفتوحة — لا يجوز إصدار release بوجود أي مهمة مفتوحة:`);
  for (const [tag, arr] of Object.entries(byTag)) {
    out.push(`  ${tag} (${arr.length}):`);
    for (const it of arr.slice(0, 20)) {
      const plan = it.planTitle ? ` [plan: ${it.planTitle}]` : "";
      out.push(`    · #${it.num} ${(it.content || "").slice(0, 80)}${plan}`);
    }
    if (arr.length > 20) out.push(`    ... +${arr.length - 20} أخرى`);
  }
  out.push("");
  out.push("الإصلاح: أَغلق كل #N أعلاه بـ -(done) / -(dropped) / -(bug fix) / -(security fix) أولاً.");
  out.push("");
}

if (doctorReport?.findings?.length) {
  const med = doctorReport.findings.filter(f => f.severity === "medium");
  if (med.length) {
    out.push(`⚠ ${med.length} تحذيرات متوسطة من doctor:`);
    for (const f of med) out.push(`  • [${f.code}] ${f.title}`);
    out.push("");
  }
}

if (changelogCount > 0) {
  out.push(`📋 changelog منذ آخر release (${changelogCount} عنصر):`);
  out.push("");
  out.push(changelogMd);
  out.push("");
  out.push("──────────────");
  out.push("استخدم القائمة أعلاه في الـcommit message أو release body. لا تختصرها إلى جملة واحدة مثل 'security hotfix'.");
} else if (changelogCount === 0) {
  out.push("⚠ لا توجد تاقات (built/done/fix) منذ آخر release. هل أنت متأكد من هذا الإصدار؟");
}

out.push("");
const hasHigh = doctorReport?.findings?.some(f => f.severity === "high");
const blocked = openItems.length > 0 || hasHigh;
if (blocked) {
  out.push("✗ مرفوض: لا يجوز إصدار release بوجود مهام مفتوحة أو مشاكل حرجة.");
} else {
  out.push("ℹ️ اقرأ الـchangelog أعلاه ثم أعد تنفيذ الأمر — سيمر هذه المرة (TTL 10 دقائق).");
  try { await writeFile(ackFile, String(Date.now()), "utf8"); } catch { /* ack is best-effort; worst case the briefing repeats */ }
}
out.push("══════════════════════════════════════");

process.stderr.write(`${out.join("\n")}\n`);
process.exit(2);
