#!/usr/bin/env bun
/**
 * DevLog PreToolUse hook — the install gate: intercepts package-add commands
 * (`bun add` / `npm i` / `pnpm|yarn add` / `cargo add` / `pip|uv install`)
 * BEFORE they run and holds them to the `-(ask:lib)` advisor's standard.
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
 *   - DEVLOG_INSTALL_GATE=0 disables the gate entirely.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseInstallCommands, decideGate } from "./src/install-gate.ts";

const PORT = parseInt(process.env.DEVLOG_PORT || "7777", 10);
const LANG = (process.env.DEVLOG_LANG || "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
const L = (en, ar) => (LANG === "ar" ? ar : en);
const LOG_DIR = join(import.meta.dir, ".devlog");
const ACK_DIR = join(LOG_DIR, "install-ack");
const ACK_TTL_MS = 10 * 60 * 1000;

const log = (s) => Bun.write(join(LOG_DIR, "pre-install.debug.log"), `${new Date().toISOString()} ${s}\n`, { append: true }).catch(() => { /* logging is best-effort */ });

if (process.env.DEVLOG_INSTALL_GATE === "0") process.exit(0);

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
// re-issue is the sanctioned conscious-override path, let it through.
const ackFile = join(ACK_DIR, `${encodeURIComponent(sessionId || "no-session")}-${Bun.hash(cmd).toString(36)}.txt`);
if (existsSync(ackFile)) {
  try {
    if (Date.now() - parseInt(await readFile(ackFile, "utf8"), 10) < ACK_TTL_MS) {
      await log("ack-pass");
      process.exit(0);
    }
  } catch { /* unreadable ack — treat as no ack */ }
}

// Ask the advisor (explicit eco prefix per package — no project guessing).
// Cached server-side (6h), so only the first ask per package pays the network.
let items = [];
try {
  const names = pkgs.map(p => `${p.eco}:${p.name}`).join(",");
  const r = await fetch(
    `http://127.0.0.1:${PORT}/api/lib-advice?cwd=${encodeURIComponent(cwd)}&names=${encodeURIComponent(names)}`,
    { signal: AbortSignal.timeout(20000) },
  );
  if (!r.ok) { await log(`advice ${r.status} — fail open`); process.exit(0); }
  items = (await r.json()).items || [];
} catch (e) {
  await log(`advice fetch error: ${e.message} — fail open`);
  process.exit(0);
}

const { blocks, warns } = decideGate(pkgs, items, LANG);
if (!blocks.length && !warns.length) { await log("clean — pass"); process.exit(0); }

// Write the ack BEFORE blocking so the very next identical issue passes.
await writeFile(ackFile, String(Date.now())).catch(() => { /* ack is best-effort */ });

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
out.push(L("Disable the gate: DEVLOG_INSTALL_GATE=0", "تعطيل البوابة: DEVLOG_INSTALL_GATE=0"));
out.push("══════════════════════════════════════");

await log(`gate: ${blocks.length} block(s), ${warns.length} warn(s)`);
console.error(out.join("\n"));
process.exit(2);
