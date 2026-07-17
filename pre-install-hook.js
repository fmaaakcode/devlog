#!/usr/bin/env bun
/**
 * DevLog PreToolUse hook — the install gate: intercepts package-add commands
 * (`bun add` / `npm i` / `pnpm|yarn add` / `cargo add` / `pip|uv install`)
 * and npm-family scaffolds (`bun|npm|pnpm|yarn create` / `npm init` /
 * `npx|bunx|dlx create-*` — they install a framework version without saying
 * `add`, #606) BEFORE they run and holds them to the `-(ask:lib)` advisor's
 * standard.
 *
 * Wired next to pre-release-hook under hooks.PreToolUse matcher="Bash|PowerShell".
 *
 * Behavior:
 *   - Blind install (no pinned version, or a floating @latest-style tag):
 *     BLOCK (stderr + exit 2) with the advisor's exact pick in the message, so
 *     Claude re-issues the command pinned — enforcement, not discipline.
 *   - Pinned install that disagrees with the advisor: advisory block ONCE
 *     (same ack mechanism as pre-release-hook) — re-issuing the identical
 *     command passes, because a pin is a deliberate choice (possibly the
 *     user's explicit order) and must stay possible.
 *   - Server down / network failure / unknown names: exit 0 (fail-open) — the
 *     backstops (vuln scan + next-prompt security alert) catch what slips.
 *   - DEVLOG_INSTALL_GATE=strict flips that last rule: verification failure
 *     (daemon down, network error, HTTP error, unknown name, OSV silent) BLOCKS
 *     instead, with the same verbatim-re-issue conscious-override path.
 *   - DEVLOG_INSTALL_GATE=0 disables the gate entirely.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseInstallCommands, decideGate } from "./src/install-gate.ts";

const PORT = parseInt(process.env.DEVLOG_PORT || "7777", 10);
const LANG = (process.env.DEVLOG_LANG || "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
const L = (en, ar) => (LANG === "ar" ? ar : en);
const LOG_DIR = join(import.meta.dir, ".devlog");
const ACK_DIR = join(LOG_DIR, "install-ack");
const ACK_TTL_MS = 10 * 60 * 1000;

// appendFileSync, not Bun.write: Bun.write has no append option and silently
// truncated the log to its last line (#604).
const log = (s) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "pre-install.debug.log"), `${new Date().toISOString()} ${s}\n`);
  } catch { /* logging is best-effort */ }
};

if (process.env.DEVLOG_INSTALL_GATE === "0") process.exit(0);
const STRICT = (process.env.DEVLOG_INSTALL_GATE || "").trim().toLowerCase() === "strict";

let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
let body;
try { body = JSON.parse(raw); } catch { process.exit(0); }

const tool = body.tool_name || body.tool || "";
if (tool !== "Bash" && tool !== "PowerShell") process.exit(0);

const cmd = body.tool_input?.command || "";
const pkgs = parseInstallCommands(cmd);
if (!pkgs.length) process.exit(0);

const cwd = body.cwd || process.cwd();
const sessionId = body.session_id || "";
await mkdir(ACK_DIR, { recursive: true });
await log(`fire: cmd=${cmd.slice(0, 120)} pkgs=${pkgs.map(p => p.name).join(",")}`);

// Ack: this exact command was already gated for this session recently — a
// re-issue is the sanctioned conscious-override path, let it through. If the
// gated command carried KNOWN-vulnerable pins (#630), passing it is the moment
// the risk becomes real: open the security item(s) NOW (fire-and-forget,
// fail-open) instead of waiting for the next scan sweep to notice.
const ackFile = join(ACK_DIR, `${encodeURIComponent(sessionId || "no-session")}-${Bun.hash(cmd).toString(36)}.txt`);
if (existsSync(ackFile)) {
  try {
    const rawAck = await readFile(ackFile, "utf8");
    let ack;
    try { ack = JSON.parse(rawAck); } catch { ack = { ts: parseInt(rawAck, 10) }; } // pre-#630 acks were a bare timestamp
    if (Date.now() - ack.ts < ACK_TTL_MS) {
      if (Array.isArray(ack.vulnPins) && ack.vulnPins.length) {
        try {
          await fetch(`http://127.0.0.1:${PORT}/api/install-override`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd, pins: ack.vulnPins }),
            signal: AbortSignal.timeout(5000),
          });
          await log(`ack-pass + override recorded (${ack.vulnPins.length} vulnerable pin(s))`);
        } catch (e) { await log(`ack-pass, override record failed: ${e.message}`); }
      } else {
        await log("ack-pass");
      }
      process.exit(0);
    }
  } catch { /* unreadable ack — treat as no ack */ }
}

// Strict fail-closed exit (#strict): verification is unreachable, so block —
// but write the ack first, so the sanctioned verbatim re-issue still overrides.
async function strictBlock(reason) {
  await writeFile(ackFile, JSON.stringify({ ts: Date.now(), vulnPins: [] })).catch(() => { /* ack is best-effort */ });
  const out = [
    "════════ DevLog Install Gate ════════",
    `⛔ ${L(
      `strict mode — verification unavailable (${reason}): the daemon/network did not answer, so nothing was checked.`,
      `الوضع الصارم — تعذّر التحقق (${reason}): الخادم/الشبكة لم يُجب فلم يُفحص شيء.`)}`,
    "",
    L("Retry when the check is reachable — or re-issue the SAME command verbatim for a conscious override (passes for 10 min).",
      "أعد المحاولة حين يتاح الفحص — أو أعد الأمر نفسه حرفياً لتجاوز واعٍ (يمرّ لمدة 10 دقائق)."),
    L("Back to fail-open: unset DEVLOG_INSTALL_GATE · disable the gate: DEVLOG_INSTALL_GATE=0",
      "العودة للوضع المتسامح: احذف DEVLOG_INSTALL_GATE · تعطيل البوابة: DEVLOG_INSTALL_GATE=0"),
    "══════════════════════════════════════",
  ];
  await log(`strict block: ${reason}`);
  console.error(out.join("\n"));
  process.exit(2);
}

// Ask the advisor (explicit eco prefix per package — no project guessing).
// Cached server-side (6h), so only the first ask per package pays the network.
let items = [];
try {
  // A pinned package travels as `eco:name@version` so the advisor also
  // OSV-checks that exact version (#630) — the block message can then name
  // the pin's own vulnerabilities, not just the advisor's preference.
  const names = pkgs.map(p => `${p.eco}:${p.name}${p.version && /^[0-9]/.test(p.version) ? `@${p.version}` : ""}`).join(",");
  const r = await fetch(
    `http://127.0.0.1:${PORT}/api/lib-advice?cwd=${encodeURIComponent(cwd)}&names=${encodeURIComponent(names)}`,
    { signal: AbortSignal.timeout(20000) },
  );
  if (!r.ok) {
    if (STRICT) await strictBlock(`HTTP ${r.status}`);
    await log(`advice ${r.status} — fail open`);
    process.exit(0);
  }
  items = (await r.json()).items || [];
} catch (e) {
  if (STRICT) await strictBlock(e.name === "TimeoutError" ? "timeout" : e.message);
  await log(`advice fetch error: ${e.message} — fail open`);
  process.exit(0);
}

const { blocks, warns, vulnPins } = decideGate(pkgs, items, LANG, STRICT);
if (!blocks.length && !warns.length) { await log("clean — pass"); process.exit(0); }

// Write the ack BEFORE blocking so the very next identical issue passes. It
// carries the vulnerable pins so the pass-through above can record them.
await writeFile(ackFile, JSON.stringify({ ts: Date.now(), vulnPins })).catch(() => { /* ack is best-effort */ });

const out = [];
out.push("════════ DevLog Install Gate ════════");
out.push(...blocks, ...warns);
out.push("");
if (blocks.length) {
  out.push(L(
    "Re-run with the advised pin — or re-issue the SAME command verbatim for a conscious override (passes for 10 min).",
    "أعد التنفيذ بالنسخة الموصى بها — أو أعد الأمر نفسه حرفياً لتجاوز واعٍ (يمرّ لمدة 10 دقائق)."));
} else {
  out.push(L(
    "One-time advisory — the same command passes on re-issue.",
    "تنبيه لمرة واحدة — الأمر نفسه يمرّ عند إعادته."));
}
out.push(L(
  STRICT ? "Strict mode is on (fail-closed) — back to fail-open: unset DEVLOG_INSTALL_GATE · disable: =0" : "Disable the gate: DEVLOG_INSTALL_GATE=0 · fail-closed verification: =strict",
  STRICT ? "الوضع الصارم مفعّل — العودة للمتسامح: احذف DEVLOG_INSTALL_GATE · التعطيل: =0" : "تعطيل البوابة: DEVLOG_INSTALL_GATE=0 · فشل الفحص = حجب: =strict"));
out.push("══════════════════════════════════════");

await log(`gate: ${blocks.length} block(s), ${warns.length} warn(s)`);
console.error(out.join("\n"));
process.exit(2);
